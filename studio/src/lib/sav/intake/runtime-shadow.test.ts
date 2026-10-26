/** Lot 4: the single-call reader compared beside the active path, through the real runtime,
 * dispatcher and ledgers. Same snapshot, own budget, no write, never changes the live result. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savIntakeJournal, savActions, savIntakeExecutions, auditLogs } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { enqueueSavIntakeMessage, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { readSavIntakeShadowReport, compareIntakePlans, intakePlanSummary } from "./shadow";

const KEY = "synthetic-intake-runtime-encryption-key";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string;
const shadowJson = (over: Record<string, unknown> = {}) => JSON.stringify({ maxMails: 50, maxNanoUsd: 5_000_000_000, until: new Date(Date.now() + 86_400_000).toISOString(), ...over });
function env(mailbox: string, shadow?: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]", ...(shadow ? { SAV_INTAKE_SHADOW_JSON: shadow } : {}),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function stored(text = "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.") {
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text, attachments: [], headers: {} }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning();
  return m;
}
/** Synthetic Gemini for both readers (current: citation catalogue; simple: current text), empty CRM. */
function provider(messageId: string, options: { simpleStatus?: number; simpleKind?: string } = {}) {
  const seen: string[] = [], crm: { method: string; url: string }[] = [];
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      const simple = typeof data.current === "string"; seen.push(simple ? "simple" : "current");
      if (simple && options.simpleStatus) return new Response("{}", { status: options.simpleStatus });
      const answer = simple
        ? { messageId, nature: "request", requests: [{ id: "r1", kind: options.simpleKind ?? "support", summary: "Synchronisation en échec.", sourceIds: ["current"] }],
          ticketTitle: "Échec de synchronisation de l'agenda", ticketDescription: "Erreur 500.", identity: { kind: "unknown", contactIds: [], why: "Aucune fiche." }, tickets: [], missing: [], rationale: "Support." }
        : { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
          ticketSummary: { title: "Échec de synchronisation de l'agenda", description: "Erreur 500.", requestIds: ["r1"] } };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, thoughtsTokenCount: 0, totalTokenCount: 360 } });
    }
    if (String(url).startsWith("https://api.hubapi.com/")) { crm.push({ method: init?.method ?? "GET", url: String(url) }); return Response.json({ total: 0, results: [] }); }
    throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  });
  return { network, seen, crm };
}
const shadowRecords = async () => (await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.kind, "shadow_plan"))).map(r => decryptSavPayload<{ verdict: string; differences: string[]; error?: string; sourceHash: string }>(r.payloadCiphertext));
const shadowLedger = () => f.db.select().from(auditLogs).where(and(eq(auditLogs.action, "sav_intake_shadow_call"), eq(auditLogs.entityType, "sav_intake_shadow")));
/** The live outcome of one analysis, comparable with and without the comparison. */
async function liveOutcome(runId: string) {
  const [run] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
  const payload = decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext);
  return { state: run.state, attempts: run.attempts, plan: intakePlanSummary(payload.plan), pipeline: payload.pipeline, reason: payload.reason ?? null,
    ledger: (await f.db.select().from(savIntakeModelCalls)).map(r => [r.messageKey, r.state]) };
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
});
afterEach(() => vi.unstubAllEnvs());

describe("separate comparison (lot 4)", () => {
  it("is off by default: no comparison call, record or ledger event", async () => {
    const environment = env(mailboxId), config = savIntakeRuntimeConfig(environment)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    await analyseSavIntakeRuntime(id, config, { env: () => environment, network: p.network });
    expect(p.seen).not.toContain("simple");
    expect(await shadowRecords()).toEqual([]); expect(await shadowLedger()).toEqual([]);
  });
  it("compares on the same snapshot, on its own ledger, and leaves the live outcome exactly unchanged", async () => {
    // Baseline without comparison.
    const plainEnv = env(mailboxId), plainConfig = savIntakeRuntimeConfig(plainEnv)!;
    const a = await stored(), aid = (await enqueueSavIntakeMessage(a.id, plainConfig))!;
    await analyseSavIntakeRuntime(aid, plainConfig, { env: () => plainEnv, network: provider(a.id).network });
    const baseline = await liveOutcome(aid);
    await f.client.exec("TRUNCATE sav.intake_model_calls, sav.intake_runs CASCADE; TRUNCATE public.audit_logs");
    // Same mail with the comparison on.
    const shadowEnv = env(mailboxId, shadowJson()), config = savIntakeRuntimeConfig(shadowEnv)!;
    expect(config.configHash).toBe(savIntakeRuntimeConfig({ ...shadowEnv, SAV_INTAKE_SHADOW_JSON: undefined })!.configHash);
    const id = (await enqueueSavIntakeMessage(a.id, config))!, p = provider(a.id);
    await analyseSavIntakeRuntime(id, config, { env: () => shadowEnv, network: p.network });
    const live = await liveOutcome(id);
    expect(live).toEqual(baseline);
    expect(p.seen).toEqual([...p.seen.filter(s => s === "current"), "simple"]);
    // The live ledger holds only live calls; the comparison has its own reserved/settled events.
    expect(live.ledger.every(([key]) => key === intakeRuntimeHash(a.id))).toBe(true);
    const events = (await shadowLedger()).map(e => e.technicalMetadata.event);
    expect(events.sort()).toEqual(["reserved", "settled"]);
    // Same CRM snapshot: the comparison added no CRM read of its own for these records.
    expect(p.crm.every(c => c.method === "GET" || c.url.endsWith("/search"))).toBe(true);
    const [record] = await shadowRecords();
    expect(record).toMatchObject({ verdict: "identical", sourceHash: expect.any(String) });
    expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
    // Never a decision in the console: the run's payload is untouched by the comparison.
    expect(JSON.stringify(decryptSavPayload((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id)))[0].payloadCiphertext))).not.toContain("shadow");
    const report = await readSavIntakeShadowReport();
    expect(report.totals).toMatchObject({ compared: 1, identical: 1, divergent: 0 });
    expect(report.spend.mails).toBe(1);
    expect(JSON.stringify(report)).not.toContain("synchronisation de mon agenda");
  });
  it("reports a divergence of judgement field by field", async () => {
    const shadowEnv = env(mailboxId, shadowJson()), config = savIntakeRuntimeConfig(shadowEnv)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!;
    await analyseSavIntakeRuntime(id, config, { env: () => shadowEnv, network: provider(m.id, { simpleKind: "finance" }).network });
    const [record] = await shadowRecords();
    expect(record.verdict).toBe("divergent"); expect(record.differences).toContain("classification");
    expect((await readSavIntakeShadowReport()).totals).toMatchObject({ compared: 1, divergent: 1 });
  });
  it("a comparison failure is recorded locally and never touches the live result or ledger", async () => {
    const shadowEnv = env(mailboxId, shadowJson()), config = savIntakeRuntimeConfig(shadowEnv)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!;
    await analyseSavIntakeRuntime(id, config, { env: () => shadowEnv, network: provider(m.id, { simpleStatus: 500 }).network });
    const current = await readSavIntakeCurrent(threadId, config);
    expect(current?.payload.plan?.decision.classification).toBe("support");
    expect(current?.payload.reason).toBeUndefined();
    const [record] = await shadowRecords();
    expect(record.verdict).toBe("incomplete");
    expect((await f.db.select().from(savIntakeModelCalls)).every(r => r.messageKey === intakeRuntimeHash(m.id) && r.state === "settled")).toBe(true);
  });
  it("its own caps stop the comparison, never the live analysis", async () => {
    const shadowEnv = env(mailboxId, shadowJson({ maxMails: 1 })), config = savIntakeRuntimeConfig(shadowEnv)!;
    const first = await stored(), firstId = (await enqueueSavIntakeMessage(first.id, config))!;
    await analyseSavIntakeRuntime(firstId, config, { env: () => shadowEnv, network: provider(first.id).network });
    threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
    const second = await stored("Bonjour, ma facture est fausse."), secondId = (await enqueueSavIntakeMessage(second.id, config))!, p = provider(second.id);
    await analyseSavIntakeRuntime(secondId, config, { env: () => shadowEnv, network: p.network });
    expect((await readSavIntakeCurrent(threadId, config))?.payload.plan).toBeTruthy();
    const records = await shadowRecords();
    expect(records).toHaveLength(2);
    expect(records.find(r => r.error)?.error).toBe("SAV_INTAKE_SHADOW_BUDGET_EXHAUSTED");
    expect((await readSavIntakeShadowReport()).spend.mails).toBe(1);
  });
  it("one comparison per message and source: a deployment re-analysis does not compare again", async () => {
    const base = env(mailboxId, shadowJson()), config = savIntakeRuntimeConfig(base)!;
    const m = await stored(), id = (await enqueueSavIntakeMessage(m.id, config))!, p = provider(m.id);
    await analyseSavIntakeRuntime(id, config, { env: () => base, network: p.network });
    const deployed = { ...base, SAV_CODE_REVISION: "b".repeat(40), SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...JSON.parse(base.SAV_INTAKE_RUNTIME_CONFIG), codeRevision: "b".repeat(40) }) };
    const next = savIntakeRuntimeConfig(deployed)!, version = (await enqueueSavIntakeMessage(m.id, next))!;
    await analyseSavIntakeRuntime(version, next, { env: () => deployed, network: p.network });
    expect(await shadowRecords()).toHaveLength(1);
    expect(p.seen.filter(s => s === "simple")).toHaveLength(1);
  });
  it("compares decision fields only, a title difference alone is not a divergence", () => {
    const base = { classification: "support", disposition: "ticket", operation: "create", ticketId: null, contactId: "101", reasons: [], mutations: ["create_ticket"], progress: "processing", newTicketTitle: "A b c d" } as never;
    expect(compareIntakePlans(base, { ...(base as object), newTicketTitle: "Autre titre de ticket" } as never)).toEqual({ verdict: "identical", differences: ["newTicketTitle"] });
    expect(compareIntakePlans(base, { ...(base as object), operation: "link", ticketId: "201" } as never).differences).toEqual(["operation", "ticketId"]);
    expect(compareIntakePlans(base, null).verdict).toBe("incomplete");
  });
});
