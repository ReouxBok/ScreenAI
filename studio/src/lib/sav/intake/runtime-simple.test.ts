/** The pipeline switch through the real runtime, dispatcher and ledger: fixed when a
 * run is created, outside configHash, and never changing an analysis in flight. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savActions, savIntakeExecutions } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { catchupSavIntake, enqueueSavIntakeMessage, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { SAV_INTAKE_SIMPLE_REVISION } from "./simple-readers";

const KEY = "synthetic-intake-runtime-encryption-key";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string;
function env(mailbox: string, pipeline?: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]", ...(pipeline ? { SAV_INTAKE_PIPELINE: pipeline } : {}),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function stored() {
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.", attachments: [], headers: {} }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning();
  return m;
}
/** Synthetic Gemini answering both reader formats, and an empty CRM. */
function provider(messageId: string) {
  const revisions: string[] = [];
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.contents[0].parts[0].text);
      const simple = typeof data.current === "string";
      revisions.push(simple ? SAV_INTAKE_SIMPLE_REVISION : SAV_INTAKE_MODEL_REVISION);
      const answer = simple
        ? { messageId, nature: "request", requests: [{ id: "r1", kind: "support", summary: "Synchronisation en échec.", sourceIds: ["current"] }],
          ticketTitle: "Échec de synchronisation de l'agenda", ticketDescription: "Erreur 500 à la synchronisation.",
          identity: { kind: "unknown", contactIds: [], why: "Aucune fiche." }, tickets: [], missing: [], rationale: "Demande support." }
        : { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
          ticketSummary: { title: "Échec de synchronisation de l'agenda", description: "Erreur 500 à la synchronisation.", requestIds: ["r1"] } };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, thoughtsTokenCount: 0, totalTokenCount: 360 } });
    }
    if (String(url).startsWith("https://api.hubapi.com/")) return Response.json({ total: 0, results: [] });
    throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  });
  return { network, revisions };
}
const payloadOf = async (runId: string) => decryptSavPayload<IntakeRuntimePayload>((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId)))[0].payloadCiphertext);

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
});
afterEach(() => vi.unstubAllEnvs());

describe("pipeline switch", () => {
  it("is outside configHash: flipping it never re-enqueues an open dossier", () => {
    const base = env("00000000-0000-4000-8000-000000000001");
    const current = savIntakeRuntimeConfig(base)!, simple = savIntakeRuntimeConfig({ ...base, SAV_INTAKE_PIPELINE: "simple" })!;
    expect(simple.configHash).toBe(current.configHash);
    expect(current.pipeline).toBe("current"); expect(simple.pipeline).toBe("simple");
    expect(() => savIntakeRuntimeConfig({ ...base, SAV_INTAKE_PIPELINE: "fast" })).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  });
  it("a run created under simple is analysed by one simple call through the real dispatcher and ledger", async () => {
    const environment = env(mailboxId, "simple"), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    expect((await payloadOf(id)).pipeline).toBe("simple");
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    expect(p.revisions).toEqual([SAV_INTAKE_SIMPLE_REVISION]);
    expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(1);
    const current = await readSavIntakeCurrent(threadId, config);
    expect(current?.payload.pipeline).toBe("simple");
    expect(current?.payload.semantics?.validatorRevision).toBe(SAV_INTAKE_SIMPLE_REVISION);
    expect(current?.payload.plan?.decision.classification).toBe("support");
    // Observe mode: a plan, never an effect.
    expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
  });
  it("a run keeps the pipeline it was created with when the switch flips before its analysis, both ways", async () => {
    for (const [created, flipped, revision] of [["simple", undefined, SAV_INTAKE_SIMPLE_REVISION], [undefined, "simple", SAV_INTAKE_MODEL_REVISION]] as const) {
      await f.client.exec("TRUNCATE sav.intake_model_calls, sav.intake_runs CASCADE");
      const base = env(mailboxId), withPipeline = (value?: string) => { const e: Record<string, string | undefined> = { ...base }; if (value) e.SAV_INTAKE_PIPELINE = value; else delete e.SAV_INTAKE_PIPELINE; return e; };
      const before = withPipeline(created), after = withPipeline(flipped);
      const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, savIntakeRuntimeConfig(before)!))!, p = provider(m.id);
      const config = savIntakeRuntimeConfig(after)!;
      // The same run is still the current one: no new version for the flip.
      expect(await enqueueSavIntakeMessage(m.id, config)).toBe(id);
      await catchupSavIntake(config);
      expect(await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, m.id))).toHaveLength(1);
      await analyseSavIntakeRuntime(id, config, { env: () => after, network: p.network });
      expect(p.revisions[0]).toBe(revision);
    }
  });
});
