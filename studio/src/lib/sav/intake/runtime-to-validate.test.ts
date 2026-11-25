/** SAV-139: the safe-archive facts through the real runtime and routing store (shadow): the sender's HubSpot answer is kept in the plan, the mail's
 * subject reaches the product veto, and the live re-read finds the same facts. Fictional data only. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig } from "./runtime-contract";
import { enqueueSavIntakeMessage, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { readIntakeRoutingFacts } from "./routing-store";

const KEY = "synthetic-intake-runtime-encryption-key";
const TEXT = "Black Friday : -40 % sur nos formations. Pour ne plus recevoir nos offres, cliquez ici.";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string;
function env(mailbox: string, extra: Record<string, string> = {}) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]", ...extra,
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function stored(subject: string) {
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "offres@exemple.invalid", toEmails: ["support@exemple.invalid"],
    subject, gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: TEXT, attachments: [], headers: {} }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning();
  return m;
}
/** Synthetic Gemini (current pipeline: no request, a demarchage class without customer signal) and a HubSpot without any contact. */
function provider(messageId: string) {
  const crm = vi.fn();
  const network = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const answer = { messageId, nature: "newsletter", requests: [],
        routing: { class: "demarchage", confidence: "high", justification: "Offre promotionnelle.", customerSignal: false, customerSignalQuote: "Pour ne plus recevoir nos offres" } };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, thoughtsTokenCount: 0, totalTokenCount: 360 } });
    }
    if (String(url).startsWith("https://api.hubapi.com/")) { crm(String(url)); return Response.json({ total: 0, results: [] }); }
    throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  });
  return { network, crm };
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@exemple.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "offres@exemple.invalid" }).returning())[0].id;
});
afterEach(() => vi.unstubAllEnvs());

describe("SAV-139 safe archive through the runtime (shadow)", () => {
  const on = { SAV_INTAKE_ROUTING_MODE: "shadow", SAV_INTAKE_SAFE_ARCHIVE: "on" };
  it("records the sender's HubSpot answer and archives (shadow) a first newsletter without any customer signal; the live re-read agrees", async () => {
    vi.stubEnv("SAV_INTAKE_SAFE_ARCHIVE", "on");
    const environment = env(mailboxId, on), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored("Black Friday : nos formations"), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    const payload = (await readSavIntakeCurrent(threadId, config))!.payload;
    expect(payload.plan?.senderContact).toBe("none");
    expect(payload.routing).toMatchObject({ action: "archive", class: "demarchage", mode: "shadow", performed: false });
    expect((await readIntakeRoutingFacts(m.id))?.facts.safeArchive).toEqual({ noRequest: true, sender: "none", productMention: false, customerSignalAbsenceVerified: true });
  });
  it("an inherited reply subject (not in the authored text) reaches the product veto, in the analysis and in the live re-read", async () => {
    vi.stubEnv("SAV_INTAKE_SAFE_ARCHIVE", "on");
    const environment = env(mailboxId, on), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored("Re: Offre spéciale clients Limova"), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    const payload = (await readSavIntakeCurrent(threadId, config))!.payload;
    expect(payload.routing).toMatchObject({ action: "keep", reason: "safe_archive_product_mention" });
    expect((await readIntakeRoutingFacts(m.id))?.facts.safeArchive?.productMention).toBe(true);
  });
  it("switch off: no sender lookup, no senderContact, today's routing reason", async () => {
    const environment = env(mailboxId, { SAV_INTAKE_ROUTING_MODE: "shadow" }), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored("Black Friday : nos formations"), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    const payload = (await readSavIntakeCurrent(threadId, config))!.payload;
    expect(payload.plan?.senderContact).toBeUndefined();
    expect(payload.routing).toMatchObject({ action: "keep", reason: "v1_collect_context" });
    expect((await readIntakeRoutingFacts(m.id))?.facts.safeArchive).toBeUndefined();
  });
});
