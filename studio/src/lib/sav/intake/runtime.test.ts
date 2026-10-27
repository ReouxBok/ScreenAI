import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState, savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savIntakeJournal, savActions, savDecisions, savIntakeExecutions, savIntakeEffects, savIntakeExecutionPolicies, staffUsers, auditLogs } from "@/db/schema";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { readReadRecoveryWake, requestReadRecoveryWake } from "./read-recovery-wake";
import { expireIntakeReadRecoveries } from "./read-recovery-store";
import { newReadRecovery } from "./read-recovery";
import { checkpointSavIntakeRun } from "./runtime-store";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, SAV_INTAKE_RUNTIME_REVISION, type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { assertSavIntakeCallPlan, assertSavIntakeLease, catchupSavIntake, claimSavIntakeRun, enqueueSavIntakeMessage, failSavIntakeRun, pendingSavIntakeRuns, readSavIntakeBudget, readSavIntakeCurrent, reconcileConfinedIntakeUsage, reserveSavIntakeCall, saveSavIntakeResult, settleSavIntakeCall } from "./runtime-store";
import { analyseSavIntakeRuntime, enqueueConfiguredSavIntake, reconcileSavIntakeRuntime } from "./runtime";
import { SAV_INTAKE_CALL_POLICY } from "./attempt-policy";

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, messageId: string;
let config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
const now = () => new Date(), usage = { inputTokens: 100, outputTokens: 50, thoughtTokens: 0, totalTokens: 150 };
function env(mailbox: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function message(options: { receivedAt?: Date; createdAt?: Date; analysisStatus?: string; body?: string; attachments?: unknown[] } = {}) {
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "synthetic@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Connexion fictive", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: options.body ?? "La connexion ne marche plus.", attachments: options.attachments ?? [], headers: {} }),
    receivedAt: options.receivedAt ?? now(), createdAt: options.createdAt ?? now(), analysisStatus: options.analysisStatus ?? "pending" }).returning(); return m;
}
async function lease() { const id = await enqueueSavIntakeMessage(messageId, config); return (await claimSavIntakeRun(id!, config))!; }
const payload = (): IntakeRuntimePayload => ({ revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected" as const, reason: "synthetic" });
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-runtime-encryption-key");
  // Native suites share one isolated database: mailbox deletion does not own
  // the durable execution ledger, so remove those synthetic fixtures explicitly.
  await f.client.exec("TRUNCATE sav.intake_effect_journal, sav.intake_effects, sav.intake_occupations, sav.intake_executions, sav.intake_execution_policies, sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning(); mailboxId = mailbox.id;
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning(); threadId = thread.id;
  messageId = (await message()).id; environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
});
afterEach(() => vi.unstubAllEnvs());
it("OFF reads only the historical capability marker and returns before new tables with malformed optional pins", async () => {
  const db = state.db; state.db = {select:()=>({from:(table:unknown)=>{if(table!==savSyncState)throw Error("NEW_TABLE_FORBIDDEN");return {where:async()=>[]};}})};
  try { expect(savIntakeRuntimeConfig({ SAV_INTAKE_RUNTIME_CONFIG: "broken" })).toBeNull(); expect(await enqueueConfiguredSavIntake(messageId)).toEqual({ skipped: "off" }); expect(await reconcileSavIntakeRuntime()).toEqual({ skipped: "off" }); }
  finally { state.db = db; }
});
it("requires explicit bounded budget, actual code/model, expiry, activation frontier and private catalogue", () => {
  for (const key of ["SAV_GEMINI_API_KEY", "HUBSPOT_ACCESS_TOKEN", "SAV_INTAKE_RUNTIME_CONFIG", "SAV_INTAKE_RUNTIME_POLICY", "SAV_INTAKE_RUNTIME_RESOURCES"]) {
    expect(() => savIntakeRuntimeConfig({ ...environment, [key]: undefined })).toThrow();
  }
  expect(() => savIntakeRuntimeConfig({ ...environment, VERCEL_GIT_COMMIT_SHA: "b".repeat(40) })).toThrow();
  expect(() => savIntakeRuntimeConfig({ ...environment, SAV_AI_MODEL: "other" })).toThrow();
  for (const change of [{ maxNanoUsd: 0 }, { maxNanoUsd: 3_000_000_001 }, { maxCalls: 31 }, { expiresAt: new Date(Date.now() - 1).toISOString() }, { createdAfter: "2020-01-01T00:00:00.000Z" }]) {
    expect(() => savIntakeRuntimeConfig({ ...environment, SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!), ...change }) })).toThrow();
  }
});
it("never accepts global qualifiedOther from server JSON", () => {
  const policy = { ...config.policy, qualifiedOther: { resource: { resourceId: "x", revisionId: "x", sha256: "a".repeat(64) }, evidenceSource: "private_rule" } };
  expect(() => savIntakeRuntimeConfig({ ...environment, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy) })).toThrow();
});
it("claims a message once, versions its thread and encrypts plans/journal without actions", async () => {
  const first = await enqueueSavIntakeMessage(messageId, config);
  expect(await enqueueSavIntakeMessage(messageId, config)).toBe(first);
  const [m] = await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)); expect(m.analysisStatus).toBe("intake_pending"); expect(m.processedAt).toBeNull();
  const l = (await claimSavIntakeRun(first!, config))!;
  expect(await claimSavIntakeRun(first!, config)).toBeNull();
  await saveSavIntakeResult(l, config, { ...payload(), input: "private synthetic text" }, "observed");
  const current = await readSavIntakeCurrent(threadId, config); expect(current?.version).toBe(1); expect(current?.fresh).toBe(true); expect(current?.payload.input).toBe("private synthetic text");
  expect(JSON.stringify(await f.db.select().from(savIntakeRuns))).not.toContain("private synthetic text"); expect(JSON.stringify(await f.db.select().from(savIntakeJournal))).not.toContain("private synthetic text");
  expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savDecisions)).toHaveLength(0); expect(await f.db.select().from(auditLogs)).toHaveLength(0);
});
it.each(["processing", "done", "failed"])("does not steal a legacy %s message", async status => {
  await f.db.update(savMessages).set({ analysisStatus: status }).where(eq(savMessages.id, messageId));
  expect(await enqueueSavIntakeMessage(messageId, config)).toBeNull();
});
it("requires both received and creation boundaries and skips superseded mail", async () => {
  await f.db.update(savMessages).set({ createdAt: new Date(Date.parse(config.createdAfter) - 1) }).where(eq(savMessages.id, messageId));
  expect(await enqueueSavIntakeMessage(messageId, config)).toBeNull();
  const next = await message({ receivedAt: new Date(Date.parse(config.receivedAfter) - 1) }); expect(await enqueueSavIntakeMessage(next.id, config)).toBeNull();
  const newer = await message({ receivedAt: new Date(Date.now() + 100) });
  expect(await enqueueSavIntakeMessage(messageId, config)).toBeNull(); expect(await enqueueSavIntakeMessage(newer.id, config)).toBeTruthy();
});
it("rattrapage uses the latest admissible messages and is bounded", async () => {
  expect(await catchupSavIntake(config)).toBe(1); expect(await catchupSavIntake(config)).toBe(0);
});
it("new incoming mail fences old analysis before model and persistence", async () => {
  const old = await lease(), newer = await message({ receivedAt: new Date(Date.now() + 1) }); await enqueueSavIntakeMessage(newer.id, config);
  await expect(assertSavIntakeLease(old, config)).rejects.toThrow(); await expect(saveSavIntakeResult(old, config, payload(), "observed")).rejects.toThrow();
  await failSavIntakeRun(old, payload()); expect((await readSavIntakeCurrent(threadId, config))?.messageId).toBe(newer.id);
});
it("pause and source or human-choice changes fence publication", async () => {
  const l = await lease(); await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
  await expect(assertSavIntakeLease(l, config)).rejects.toThrow();
  await f.db.update(savThreads).set({ aiPaused: false }).where(eq(savThreads.id, threadId));
  await f.db.update(savIntakeRuns).set({ humanChoiceCiphertext: encryptSavPayload({ version: 1 }) }).where(eq(savIntakeRuns.id, l.run.id));
  await expect(assertSavIntakeLease(l, config)).rejects.toThrow();
});
it("a changed body cannot be published from an old snapshot", async () => {
  const l = await lease(); await f.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: "Changed synthetic" }) }).where(eq(savMessages.id, messageId));
  await expect(assertSavIntakeLease(l, config)).rejects.toThrow();
});
it("lease takeover rejects old token and allows only two total attempts", async () => {
  const a = await lease(); await f.db.update(savIntakeRuns).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(savIntakeRuns.id, a.run.id));
  const b = (await claimSavIntakeRun(a.run.id, config))!; expect(b.token).not.toBe(a.token); expect(b.run.attempts).toBe(2);
  await expect(assertSavIntakeLease(a, config)).rejects.toThrow(); await failSavIntakeRun(b, payload()); expect(await claimSavIntakeRun(b.run.id, config)).toBeNull();
});
it("a dispatched call after crash becomes uncertain instead of blind replay", async () => {
  const l = await lease(); await reserveSavIntakeCall(l, config, "a".repeat(64));
  await f.db.update(savIntakeRuns).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(savIntakeRuns.id, l.run.id));
  expect(await claimSavIntakeRun(l.run.id, config)).toBeNull(); expect((await readSavIntakeCurrent(threadId, config))?.state).toBe("uncertain");
});
it("same model request is durably cached and does not reserve twice after a resume", async () => {
  const l = await lease(), r = await reserveSavIntakeCall(l, config, "a".repeat(64));
  await settleSavIntakeCall(r.id, usage, { json: { synthetic: true }, metadata: usage });
  expect((await reserveSavIntakeCall(l, config, "a".repeat(64))).cached?.json).toEqual({ synthetic: true }); expect((await readSavIntakeBudget(config)).callCount).toBe(1);
});
/** Settled, cached ledger rows of this message, as if dispatched by earlier versions (run deleted). */
async function priorCalls(count: number, prefix = "prior") {
  if (count > 0) await f.db.insert(savIntakeModelCalls).values(Array.from({ length: count }, (_, i) => ({ messageKey: intakeRuntimeHash(messageId), requestHash: `${prefix}-${i}`,
    state: "settled" as const, reservedNanoUsd: 817152000, chargedNanoUsd: 262500, payloadCiphertext: encryptSavPayload({ metadata: usage }), resultCiphertext: encryptSavPayload({ json: { cached: true }, metadata: usage }) })));
}
it("preflights complete grouped requests read-only, allowing valid cache and rejecting an over-cap plan", async () => {
  const l = await lease(), first = await reserveSavIntakeCall(l, config, "a".repeat(64));
  await settleSavIntakeCall(first.id, usage, { json: { cached: true }, metadata: usage });
  const before = await f.db.select().from(savIntakeModelCalls);
  await expect(assertSavIntakeCallPlan(messageId, config, ["a".repeat(64), "b".repeat(64), "c".repeat(64)])).resolves.toBeUndefined();
  expect(await f.db.select().from(savIntakeModelCalls)).toEqual(before);
  await expect(assertSavIntakeCallPlan(messageId, config, ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)])).rejects.toThrow("DISPATCH_REJECTED");
  const second = await reserveSavIntakeCall(l, config, "b".repeat(64)); await settleSavIntakeCall(second.id, usage, { json: { cached: true }, metadata: usage });
  const third = await reserveSavIntakeCall(l, config, "c".repeat(64)); await settleSavIntakeCall(third.id, usage, { json: { cached: true }, metadata: usage });
  await priorCalls(SAV_INTAKE_CALL_POLICY.perMessage - 3);
  const snapshot = await f.db.select().from(savIntakeModelCalls);
  await expect(assertSavIntakeCallPlan(messageId, config, ["a".repeat(64), "b".repeat(64), "c".repeat(64)])).resolves.toBeUndefined();
  await expect(assertSavIntakeCallPlan(messageId, config, ["d".repeat(64)])).rejects.toThrow("BUDGET_EXHAUSTED");
  expect(await f.db.select().from(savIntakeModelCalls)).toEqual(snapshot);
});
it("preflights complete grouped requests read-only, allowing valid cache and refusing over-cap batches", async () => {
  const l = await lease(), first = await reserveSavIntakeCall(l, config, "a".repeat(64));
  await settleSavIntakeCall(first.id, usage, { json: { cached: true }, metadata: usage });
  const before = await f.db.select().from(savIntakeModelCalls);
  await expect(assertSavIntakeCallPlan(messageId, config, ["a".repeat(64), "b".repeat(64), "c".repeat(64)])).resolves.toBeUndefined();
  expect(await f.db.select().from(savIntakeModelCalls)).toEqual(before);
  await expect(assertSavIntakeCallPlan(messageId, config, ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)])).rejects.toThrow("DISPATCH_REJECTED");
  const second = await reserveSavIntakeCall(l, config, "b".repeat(64)); await settleSavIntakeCall(second.id, usage, { json: { cached: true }, metadata: usage });
  const third = await reserveSavIntakeCall(l, config, "c".repeat(64)); await settleSavIntakeCall(third.id, usage, { json: { cached: true }, metadata: usage });
  await priorCalls(SAV_INTAKE_CALL_POLICY.perMessage - 3);
  const snapshot = await f.db.select().from(savIntakeModelCalls);
  await expect(assertSavIntakeCallPlan(messageId, config, ["a".repeat(64), "b".repeat(64), "c".repeat(64)])).resolves.toBeUndefined();
  await expect(assertSavIntakeCallPlan(messageId, config, ["d".repeat(64)])).rejects.toThrow("BUDGET_EXHAUSTED");
  expect(await f.db.select().from(savIntakeModelCalls)).toEqual(snapshot);
});
it("retains unknown usage, refuses refunds/replay and settles a late response without publishing", async () => {
  const l = await lease(), r = await reserveSavIntakeCall(l, config, "a".repeat(64));
  await failSavIntakeRun(l, payload()); expect(await settleSavIntakeCall(r.id, usage)).toBe(true); expect((await readSavIntakeCurrent(threadId, config))?.state).toBe("waiting");
  const second = (await claimSavIntakeRun(l.run.id, config))!; const u = await reserveSavIntakeCall(second, config, "b".repeat(64));
  expect(await settleSavIntakeCall(u.id, { ...usage, thoughtTokens: undefined })).toBe(false); expect(await settleSavIntakeCall(u.id, usage)).toBe(false);
  await expect(reserveSavIntakeCall(second, config, "c".repeat(64))).rejects.toThrow("USAGE_UNCERTAIN"); expect((await readSavIntakeBudget(config)).chargedNanoUsd).toBe(817_414_500);
});
it("per-version and lifetime per-message bounds survive config changes and run deletion", async () => {
  const l = await lease();
  for (let n = 0; n < SAV_INTAKE_CALL_POLICY.perVersion; n++) { const r = await reserveSavIntakeCall(l, config, String(n % 10).repeat(63) + "a"); await settleSavIntakeCall(r.id, usage, { json: { syntheticPrivate: true }, metadata: usage }); }
  // The version bound stops this run.
  await expect(reserveSavIntakeCall(l, config, "f".repeat(64))).rejects.toThrow("BUDGET_EXHAUSTED");
  await f.db.delete(savIntakeRuns).where(eq(savIntakeRuns.id, l.run.id));
  expect((await readSavIntakeBudget(config)).callCount).toBe(SAV_INTAKE_CALL_POLICY.perVersion); expect((await f.db.select().from(savIntakeModelCalls)).every(r => r.runId === null && r.resultCiphertext === null)).toBe(true);
  // A new version only gets what remains of the lifetime bound, never a reset.
  const id = await enqueueSavIntakeMessage(messageId, config), next = (await claimSavIntakeRun(id!, config))!;
  for (let n = 0; n < SAV_INTAKE_CALL_POLICY.perMessage - SAV_INTAKE_CALL_POLICY.perVersion; n++) { const r = await reserveSavIntakeCall(next, config, String(n).repeat(63) + "e"); await settleSavIntakeCall(r.id, usage, { json: { syntheticPrivate: true }, metadata: usage }); }
  await expect(reserveSavIntakeCall(next, config, "e".repeat(64))).rejects.toThrow("BUDGET_EXHAUSTED");
});
it("monetary exhaustion is explicit technical waiting and never uses other ledgers", async () => {
  const constrained = { ...config, maxNanoUsd: 1 }, id = await enqueueSavIntakeMessage(messageId, constrained);
  const network = vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); });
  const response = await analyseSavIntakeRuntime(id!, constrained, { env: () => environment, network });
  expect(response.state).toBe("waiting"); expect(network).not.toHaveBeenCalled();
  expect((await readSavIntakeCurrent(threadId, constrained))?.payload.reason).toBe("SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED"); expect(await f.db.select().from(auditLogs)).toHaveLength(0);
});
it("persists catalogue failures as a technical reason before any model reservation or network", async () => {
  const m = await message({ receivedAt: new Date(Date.now() + 1), body: "private".repeat(300) });
  const id = await enqueueSavIntakeMessage(m.id, config);
  const network = vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); });
  expect((await analyseSavIntakeRuntime(id!, config, { env: () => environment, network })).state).toBe("waiting");
  expect(network).not.toHaveBeenCalled(); expect((await readSavIntakeBudget(config)).callCount).toBe(0);
  const current = await readSavIntakeCurrent(threadId, config);
  expect(current?.payload.reason).toBe("SAV_INTAKE_MODEL_CONTEXT_LIMIT");
  expect(current?.payload.traces).toEqual(expect.arrayContaining([expect.objectContaining({ accepted: false,
    errorCode: "SAV_INTAKE_MODEL_CONTEXT_LIMIT", contextLimit: expect.objectContaining({ stage: "catalogue" }) })]));
  expect(JSON.stringify(current?.payload.traces)).not.toContain("private");
  expect(await f.db.select().from(savActions)).toHaveLength(0);
});
it("connects the real stored mail to semantic readers/CRM and keeps effect steps undispatched", async () => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.contents[0].parts[0].text);
      const answer = { messageId, requests: [{ id: "support-1", kind: "support", currentMessageId: messageId, quoteId: data.citationCatalogue.find((x: {sourceId:string}) => x.sourceId === "current").id }], ticketSummary: { title: "Connexion fictive en panne", description: "La connexion fictive ne marche plus.", requestIds: ["support-1"] } };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
    }
    expect(String(url)).toBe("https://api.hubapi.com/crm/v3/objects/contacts/search"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-crm");
    return Response.json({ total: 0, results: [] });
  });
  expect((await analyseSavIntakeRuntime(id!, config, { env: () => environment, network })).state).toBe("waiting");
  const current = await readSavIntakeCurrent(threadId, config); expect(current?.payload.plan?.decision.classification).toBe("support");
  expect(current?.payload.plan?.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["private_resource_unavailable"] });
  expect(network).toHaveBeenCalledTimes(3); expect((await readSavIntakeBudget(config)).callCount).toBe(1); expect(await f.db.select().from(savActions)).toHaveLength(0);
  const m = (await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0]; expect(m.processedAt).toBeNull(); expect(m.analysisStatus).toBe("intake_waiting");
  expect(decryptSavPayload((await f.db.select().from(savIntakeModelCalls))[0].payloadCiphertext)).toHaveProperty("metadata");
});
it("attachments keep analysis incomplete without starting the model", async () => {
  const m = await message({ receivedAt: new Date(Date.now() + 1), attachments: [{ filename: "synthetic.png" }] });
  const id = await enqueueSavIntakeMessage(m.id, config), network = vi.fn(async () => { throw Error("NO_NETWORK"); });
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network }); expect(network).not.toHaveBeenCalled();
});
it("concurrent enqueue/claims have one current version and one lease", async () => {
  const ids = await Promise.all([enqueueSavIntakeMessage(messageId, config), enqueueSavIntakeMessage(messageId, config)]);
  expect(ids[0]).toBe(ids[1]);
  const claims = await Promise.all([claimSavIntakeRun(ids[0]!, config), claimSavIntakeRun(ids[0]!, config)]);
  expect(claims.filter(Boolean)).toHaveLength(1); expect(await f.db.select().from(savIntakeRuns)).toHaveLength(1);
});
it("keeps the freshness deadline bound to original sources, including after model latency", async () => {
  const l = await lease(), finish = new Date(Date.parse(l.input.now) + 30_000);
  await saveSavIntakeResult(l, config, payload(), "observed", finish);
  expect((await readSavIntakeCurrent(threadId, config, finish))?.freshUntil?.getTime()).toBe(Date.parse(l.input.now) + 300_000);
  expect((await readSavIntakeCurrent(threadId, null, finish))?.fresh).toBe(false);
});
it("pause followed by resume permanently fences the old token", async () => {
  const l = await lease(); await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
  await f.db.update(savThreads).set({ aiPaused: false }).where(eq(savThreads.id, threadId));
  await expect(assertSavIntakeLease(l, config)).rejects.toThrow();
});
it("a source edit after observation invalidates its freshness without any write", async () => {
  const l = await lease(); await saveSavIntakeResult(l, config, payload(), "observed");
  await f.db.update(savMessages).set({ subject: "Changed synthetic" }).where(eq(savMessages.id, messageId));
  expect((await readSavIntakeCurrent(threadId, config))?.fresh).toBe(false);
});
it("rejects corrupt budget history rather than silently refunding it", async () => {
  const l = await lease(), r = await reserveSavIntakeCall(l, config, "a".repeat(64)); await settleSavIntakeCall(r.id, usage);
  await f.db.update(savIntakeModelCalls).set({ chargedNanoUsd: 0 }).where(eq(savIntakeModelCalls.id, r.id));
  await expect(readSavIntakeBudget(config)).rejects.toThrow("LEDGER_REJECTED");
});
it.each(["create", "link", "reopen", "incomplete_evidence"])("persists the %s outcome from stored mail with no writer", async operation => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const edge = (id: string) => ({ toObjectId: id, associationTypes: [{ typeId: 1, category: "HUBSPOT_DEFINED" }] });
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.contents[0].parts[0].text), catalogue = data.citationCatalogue as {id:string;sourceId:string}[];
      const answer = !data.tickets ? { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId: catalogue.find(x => x.sourceId === "current")!.id }],
        ticketSummary: { title: "Connexion fictive en panne", description: "La connexion fictive ne marche plus.", requestIds: ["r1"] } }
        : { investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r1"], evidenceIds: operation === "incomplete_evidence" ? ["current"] : ["current", "ticket-201", "history-201"],
          rationale: "Même panne fictive", grounding: ["current", "ticket-201", "history-201"].map(sourceId => ({ quoteId: catalogue.find(x => x.sourceId === sourceId)!.id })) }] };
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
    }
    if (path.endsWith("/contacts/search")) return Response.json({ results: [{ id: "101", properties: { email: "synthetic@example.invalid", hs_additional_emails: null } }], total: 1 });
    if (path.endsWith("/pipelines/tickets/0")) return Response.json({ id: "0", stages: ["1", "2", "3", "4"].map(id => ({ id, metadata: { isClosed: id === "4" } })) });
    if (path.endsWith("contacts/101/associations/tickets")) return Response.json({ results: operation === "create" ? [] : [edge("201")] });
    if (path.endsWith("tickets/201/associations/contacts")) return Response.json({ results: [edge("101")] });
    if (path.endsWith("/tickets/batch/read")) return Response.json({ status: "COMPLETE", results: [{ id: "201", properties: { subject: "Connexion fictive", content: "Panne de connexion fictive", createdate: new Date(Date.now() - 30 * 86_400_000).toISOString(), hs_pipeline: "0", hs_pipeline_stage: operation === "reopen" ? "4" : "2", hubspot_owner_id: "301", hs_last_closed_date: new Date(Date.now() - 5 * 86_400_000).toISOString() } }] });
    if (path.endsWith("tickets/201/associations/notes")) return Response.json({ results: [edge("401")] });
    if (path.endsWith("/notes/batch/read")) return Response.json({ status: "COMPLETE", results: [{ id: "401", properties: { hs_note_body: "Panne de connexion déjà investiguée", hs_timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString() } }] });
    return Response.json({ results: [] });
  });
  const result = await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  const current = await readSavIntakeCurrent(threadId, config);
  if (operation === "incomplete_evidence") {
    expect(result).toMatchObject({ state: "waiting" });
    expect(current?.payload.reason).toBe("SAV_INTAKE_SEMANTIC_COVERAGE_REJECTED");
    expect(current?.payload.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "ticket_matching", accepted: true }),
      expect.objectContaining({ phase: "accepted_semantics", method: "assessIssues", accepted: false, errorCode: "SAV_INTAKE_SEMANTIC_COVERAGE_REJECTED" }),
    ]));
    expect(current?.payload.semantics?.records.map(r => r.method)).toEqual(["analyseMessage"]);
    expect(current?.payload.plan?.decision.disposition.kind).toBe("collect_context");
  } else {
    expect({result, payload:current?.payload}).toMatchObject({ result: { state: "observed" }});
    expect(current?.payload.plan?.decision.disposition).toMatchObject({ kind: "ticket", target: { operation } });
  }
  expect(current?.payload.plan?.effects).toBe("not_connected"); expect(current?.payload.plan?.steps.every(step => step.status === "not_dispatched")).toBe(true);
  expect((await readSavIntakeBudget(config)).callCount).toBe(operation === "create" ? 1 : 2);
  expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savDecisions)).toHaveLength(0);
});
it("accepts only catalogue-backed private resource revisions and exact content", () => {
  const text = "Synthetic approved resource", reference = { resourceId: "synthetic-id", revisionId: "synthetic-v1", sha256: "a".repeat(64) };
  // Resource hashes are UTF-8 text hashes, not JSON hashes.
  reference.sha256 = createHash("sha256").update(text).digest("hex");
  const policy = { ...config.policy, resources: { identification: reference } };
  const catalogue = [{ resource: reference, text, approvalId: "synthetic-approval", approvedBy: "synthetic-reviewer", approvedAt: new Date(Date.now() - 1000).toISOString(), status: "approved" }];
  const pins = { ...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash(catalogue) };
  const configured = { ...environment, SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify(pins), SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: JSON.stringify(catalogue) };
  expect(savIntakeRuntimeConfig(configured)?.policy.resources.identification).toEqual(reference);
  expect(() => savIntakeRuntimeConfig({ ...configured, SAV_INTAKE_RUNTIME_RESOURCES: JSON.stringify([{ ...catalogue[0], status: "pending" }]) })).toThrow();
  expect(() => savIntakeRuntimeConfig({ ...configured, SAV_INTAKE_RUNTIME_RESOURCES: "[]" })).toThrow();
});
it("OFF keeps intake ownership out of legacy processing", async () => {
  await enqueueSavIntakeMessage(messageId, config); vi.stubEnv("SAV_INTAKE_RUNTIME_MODE", "off");
  const { processStoredSavMessage } = await import("../service");
  const network = vi.fn(async () => { throw Error("NO_NETWORK_ALLOWED"); }); vi.stubGlobal("fetch", network);
  try { expect(await processStoredSavMessage(messageId)).toBeNull(); expect(network).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); }
  expect((await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].analysisStatus).toBe("intake_pending");
});
it("a pause during provider completion settles usage and preserves a partial plan without republishing", async () => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const network = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
    const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
    const answer = { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId: data.citationCatalogue[0].id }] };
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
  });
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  const current = await readSavIntakeCurrent(threadId, config); expect(current?.state).toBe("waiting"); expect(current?.fresh).toBe(false);
  expect(current?.journal.some(event => event.kind === "obsolete_partial_result")).toBe(true);
  expect((await readSavIntakeBudget(config)).chargedNanoUsd).toBe(262_500); expect(network).toHaveBeenCalledTimes(1); expect(await f.db.select().from(savActions)).toHaveLength(0);
});
it.each(["promptTokenCount", "candidatesTokenCount", "totalTokenCount"].flatMap(counter => ["valid_json", "invalid_json"].map(output => ({ counter, output }))))("keeps missing $counter uncertain through provider $output", async ({ counter, output }) => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const providerUsage: Record<string, number> = { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 };
  delete providerUsage[counter];
  const network = vi.fn(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: output === "valid_json" ? JSON.stringify({ messageId, requests: [] }) : "{invalid-json" }] } }], usageMetadata: providerUsage }));
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  const budget = await readSavIntakeBudget(config), current = await readSavIntakeCurrent(threadId, config);
  expect(budget).toMatchObject({ callCount: 1, chargedNanoUsd: 817_152_000, uncertain: true });
  expect(current?.state).toBe("uncertain"); expect(current?.fresh).toBe(false);
  const [call] = await f.db.select().from(savIntakeModelCalls); expect(call.state).toBe("uncertain"); expect(call.resultCiphertext).toBeNull();
  const tokenField = { promptTokenCount: "inputTokens", candidatesTokenCount: "outputTokens", thoughtsTokenCount: "thoughtTokens", totalTokenCount: "totalTokens" }[counter]!;
  expect(decryptSavPayload<{metadata: unknown}>(call.payloadCiphertext).metadata).not.toHaveProperty(tokenField);
  expect(await claimSavIntakeRun(id!, config)).toBeNull(); expect(network).toHaveBeenCalledTimes(1); expect(await f.db.select().from(savActions)).toHaveLength(0);
});
it.each(["valid_json", "invalid_json"])("settles four explicit provider counters after %s without altering the generic transport", async output => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const network = vi.fn(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: output === "valid_json" ? JSON.stringify({ messageId, requests: [] }) : "{invalid-json" }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } }));
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  expect(await readSavIntakeBudget(config)).toMatchObject({ callCount: 1, chargedNanoUsd: 262_500, uncertain: false }); expect(network).toHaveBeenCalledTimes(1);
});
it("never marks a current plan fresh with a retained configuration after its expiry", async () => {
  const shortEnvironment = { ...environment, SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!), expiresAt: new Date(Date.now() + 10_000).toISOString() }) };
  const shortConfig = savIntakeRuntimeConfig(shortEnvironment)!, id = await enqueueSavIntakeMessage(messageId, shortConfig);
  const l = (await claimSavIntakeRun(id!, shortConfig))!;
  await saveSavIntakeResult(l, shortConfig, payload(), "observed");
  expect((await readSavIntakeCurrent(threadId, shortConfig, new Date(Date.parse(shortConfig.expiresAt) - 1)))?.fresh).toBe(true);
  expect((await readSavIntakeCurrent(threadId, shortConfig, new Date(shortConfig.expiresAt)))?.fresh).toBe(false);
  expect((await readSavIntakeCurrent(threadId, shortConfig, new Date(Date.parse(shortConfig.expiresAt) + 1)))?.fresh).toBe(false);
});

it("rejects a lease after expiry expressed without fractional seconds", async () => {
  const expiry = new Date(Date.now() + 10_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const shortEnvironment = { ...environment, SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!), expiresAt: expiry }) };
  const shortConfig = savIntakeRuntimeConfig(shortEnvironment)!, id = await enqueueSavIntakeMessage(messageId, shortConfig);
  const l = (await claimSavIntakeRun(id!, shortConfig))!;
  await expect(assertSavIntakeLease(l, shortConfig, new Date(Date.parse(expiry) - 1))).resolves.toBeUndefined();
  await expect(assertSavIntakeLease(l, shortConfig, new Date(expiry))).rejects.toThrow("CONTEXT_CHANGED");
  await expect(assertSavIntakeLease(l, shortConfig, new Date(Date.parse(expiry) + 100))).rejects.toThrow("CONTEXT_CHANGED");
});

function operational() {
  const pins={...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),budgetProfile:"operational_utc_v1",maxRollingNanoUsd:90000000000,maxCalls:300,expiresAt:new Date(Date.now()+29*86400000).toISOString()};
  environment={...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify(pins)};config=savIntakeRuntimeConfig(environment)!;
}
it("operational profile separates an old initial frontier from bounded30day authority and requires explicit rolling cap",()=>{
  const pins={...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),budgetProfile:"operational_utc_v1",maxRollingNanoUsd:90000000000,maxCalls:300,createdAfter:"2020-01-01T00:00:00.000Z",expiresAt:new Date(Date.now()+29*86400000).toISOString()};
  expect(savIntakeRuntimeConfig({...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify(pins)})).toHaveProperty("budgetProfile","operational_utc_v1");
  for(const change of [{maxRollingNanoUsd:undefined},{maxCalls:301},{maxRollingNanoUsd:90000000001},{expiresAt:new Date(Date.now()+31*86400000).toISOString()}]) expect(()=>savIntakeRuntimeConfig({...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...pins,...change})})).toThrow();
});
it("operational profile accepts the approved5 USD daily cap while every other bound stays strict",()=>{
  const pins={...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),budgetProfile:"operational_utc_v1",maxRollingNanoUsd:90000000000,maxCalls:300,maxNanoUsd:5000000000,expiresAt:new Date(Date.now()+29*86400000).toISOString()};
  const parse=(change:Record<string,unknown>)=>savIntakeRuntimeConfig({...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...pins,...change})});
  expect(parse({})).toMatchObject({budgetProfile:"operational_utc_v1",maxNanoUsd:5000000000,maxRollingNanoUsd:90000000000,maxCalls:300});
  expect(parse({maxNanoUsd:3000000000})).toHaveProperty("maxNanoUsd",3000000000);
  expect(parse({})!.configHash).not.toBe(parse({maxNanoUsd:3000000000})!.configHash);
  for(const maxNanoUsd of [5000000001,0,-1,1.5,Number.NaN,Number.POSITIVE_INFINITY,"5000000000",null]) expect(()=>parse({maxNanoUsd})).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  for(const change of [{maxRollingNanoUsd:90000000001},{maxCalls:301}]) expect(()=>parse(change)).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  // Qualification (no profile) keeps its historical lifetime cap and30 calls.
  const legacy=JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!);
  expect(()=>savIntakeRuntimeConfig({...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...legacy,maxNanoUsd:5000000000})})).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  expect(()=>savIntakeRuntimeConfig({...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...legacy,maxNanoUsd:3000000001})})).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  expect(savIntakeRuntimeConfig({...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...legacy,maxNanoUsd:3000000000})})).toHaveProperty("maxNanoUsd",3000000000);
});
it("5 USD deducts settled and uncertain usage, never resets the ledger, and the30day cap still defers with daily margin",async()=>{
  operational();
  const atThree={...config};environment={...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),maxNanoUsd:5000000000})};
  const raised=savIntakeRuntimeConfig(environment)!;expect(raised.maxNanoUsd).toBe(5000000000);expect(atThree.maxNanoUsd).toBe(3000000000);
  const id=(await enqueueSavIntakeMessage(messageId,raised))!;
  // Each row costs one full reservation (0.817152 USD): the maximum a single settled call can charge.
  const fill=(n:number,state:string,createdAt=new Date())=>Array.from({length:n},(_,i)=>({messageKey:intakeRuntimeHash(`fill-${state}-${createdAt.getTime()}-${i}`),requestHash:intakeRuntimeHash(`req-${state}-${createdAt.getTime()}-${i}`),state,reservedNanoUsd:817152000,chargedNanoUsd:817152000,
    payloadCiphertext:encryptSavPayload({metadata:{inputTokens:1048576,outputTokens:8192,thoughtTokens:0,totalTokens:1056768}}),createdAt}));
  // 4.09 USD settled today + one old uncertain reservation of another message: above 3 USD, within 5 USD.
  await f.db.insert(savIntakeModelCalls).values([...fill(5,"settled"),...fill(1,"uncertain",new Date(Date.now()-40*86400000))]);
  expect(await readSavIntakeBudget(atThree)).toMatchObject({chargedNanoUsd:4902912000,remainingNanoUsd:0,uncertain:true});
  expect(await readSavIntakeBudget(raised)).toMatchObject({chargedNanoUsd:4902912000,remainingNanoUsd:97088000,lifetimeCallCount:6});
  // Remaining 0.097 USD < one 0.817 USD reservation: deferred, no attempt consumed, no reset of history.
  expect(await claimSavIntakeRun(id,raised)).toBeNull();
  expect((await readSavIntakeCurrent(threadId,raised))?.attempts).toBe(0);
  expect((await readSavIntakeCurrent(threadId,raised))?.payload.reason).toBe("SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED");
  expect(await readSavIntakeBudget(raised)).toHaveProperty("lifetimeCallCount",6);
  // A rolling cap exhausted by earlier days defers even with the whole daily 5 USD free.
  await f.db.delete(savIntakeModelCalls);
  await f.db.insert(savIntakeModelCalls).values(fill(111,"settled",new Date(Date.now()-2*86400000)));
  expect(await readSavIntakeBudget(raised)).toMatchObject({remainingNanoUsd:5000000000,remainingRollingNanoUsd:0});
  expect(await claimSavIntakeRun(id,raised)).toBeNull();
  expect((await readSavIntakeCurrent(threadId,raised))?.payload.reason).toBe("SAV_INTAKE_RUNTIME_ROLLING_BUDGET_DEFERRED");
  expect((await readSavIntakeCurrent(threadId,raised))?.attempts).toBe(0);
  // 3.27 USD settled today: no margin at the old 3 USD cap, claimable at 5 USD.
  await f.db.delete(savIntakeModelCalls);
  await f.db.insert(savIntakeModelCalls).values(fill(4,"settled"));
  expect(await readSavIntakeBudget(atThree)).toHaveProperty("remainingNanoUsd",0);
  expect((await claimSavIntakeRun(id,raised))?.run.attempts).toBe(1);
});
it("Studio daily cap overrides the pinned operational cap under the budget lock, outside configHash, without resetting the ledger",async()=>{
  operational();const hash=config.configHash,id=(await enqueueSavIntakeMessage(messageId,config))!;
  const fill=(n:number)=>Array.from({length:n},(_,i)=>({messageKey:intakeRuntimeHash(`studio-${i}`),requestHash:intakeRuntimeHash(`studio-req-${i}`),state:"settled",reservedNanoUsd:817152000,chargedNanoUsd:817152000,
    payloadCiphertext:encryptSavPayload({metadata:{inputTokens:1048576,outputTokens:8192,thoughtTokens:0,totalTokens:1056768}}),createdAt:new Date()}));
  const setOverride=async(maxNanoUsd:number|null,cursor?:string)=>{const values={key:"sav-intake-daily-budget-override.v1",status:"active",updatedAt:new Date(),
    cursor:cursor??encryptSavPayload({revision:"sav-intake-daily-budget-override.v1",maxNanoUsd,setBy:"ugo@limova.ai",setAt:new Date().toISOString(),reason:"synthetic"})};
    await f.db.insert(savSyncState).values(values).onConflictDoUpdate({target:savSyncState.key,set:values});};
  await f.db.insert(savIntakeModelCalls).values(fill(4)); // 3.27 USD counted today: no margin at the pinned 3 USD.
  expect(await readSavIntakeBudget(config)).toMatchObject({maxNanoUsd:3000000000,remainingNanoUsd:0});
  expect(await claimSavIntakeRun(id,config)).toBeNull();
  expect((await readSavIntakeCurrent(threadId,config))?.payload.reason).toBe("SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED");
  await setOverride(10000000000);
  expect(await readSavIntakeBudget(config)).toMatchObject({maxNanoUsd:10000000000,chargedNanoUsd:3268608000,remainingNanoUsd:6731392000,lifetimeCallCount:4,maxRollingNanoUsd:90000000000,maxCalls:300});
  expect(config.configHash).toBe(hash);expect(config.maxNanoUsd).toBe(3000000000);
  const lease=(await claimSavIntakeRun(id,config))!;expect(lease.run.attempts).toBe(1);
  await expect(assertSavIntakeCallPlan(lease.run.messageId,config,[intakeRuntimeHash("studio-plan")])).resolves.toBeUndefined();
  const call=await reserveSavIntakeCall(lease,config,"studio-call");expect(call.cached).toBeNull();
  expect(await settleSavIntakeCall(call.id,{inputTokens:100,outputTokens:50,thoughtTokens:0,totalTokens:150})).toBe(true);
  // Back to the configuration: the same ledger is again over the pinned cap.
  await setOverride(null);
  expect(await readSavIntakeBudget(config)).toMatchObject({maxNanoUsd:3000000000,remainingNanoUsd:0,lifetimeCallCount:5});
  await expect(reserveSavIntakeCall(lease,config,"studio-call-2")).rejects.toThrow("BUDGET_EXHAUSTED");
  // Qualification profile ignores the Studio cap.
  await setOverride(10000000000);
  const qualification={...config,budgetProfile:undefined,maxRollingNanoUsd:undefined,maxCalls:30};
  expect(await readSavIntakeBudget(qualification)).toHaveProperty("maxNanoUsd",3000000000);
  // A tampered or unreadable stored cap fails closed instead of falling back.
  await setOverride(null,"not-a-valid-ciphertext");
  await expect(readSavIntakeBudget(config)).rejects.toThrow("SAV_INTAKE_BUDGET_OVERRIDE_INVALID");
  await expect(reserveSavIntakeCall(lease,config,"studio-call-3")).rejects.toThrow("SAV_INTAKE_BUDGET_OVERRIDE_INVALID");
  await setOverride(null,encryptSavPayload({revision:"sav-intake-daily-budget-override.v1",maxNanoUsd:20000000001,setBy:"ugo@limova.ai",setAt:new Date().toISOString(),reason:"synthetic"}));
  await expect(readSavIntakeBudget(config)).rejects.toThrow("SAV_INTAKE_BUDGET_OVERRIDE_INVALID");
  await f.db.delete(savSyncState).where(eq(savSyncState.key,"sav-intake-daily-budget-override.v1"));
});
it("one provider timeout reserves its full cost beyond30days, blocks its message, and permits a second dossier within both margins",async()=>{
  operational();const first=await lease();
  const a=await reserveSavIntakeCall(first,config,"timeout-a");
  await f.db.update(savIntakeModelCalls).set({state:"uncertain",createdAt:new Date(Date.now()-31*86400000)}).where(eq(savIntakeModelCalls.id,a.id));
  threadId=(await f.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"other@example.invalid"}).returning())[0].id;messageId=(await message()).id;
  const second=await lease(),b=await reserveSavIntakeCall(second,config,"second-b");
  expect(b.cached).toBeNull();expect((await readSavIntakeBudget(config))).toMatchObject({chargedNanoUsd:1634304000,rollingChargedNanoUsd:1634304000,lifetimeCallCount:2,uncertain:true});
  await expect(reserveSavIntakeCall(first,config,"retry-a")).rejects.toThrow("USAGE_UNCERTAIN");
  expect((await readSavIntakeBudget({...config,maxCalls:299}))).toHaveProperty("lifetimeCallCount",2);
});
it("operational profile still enforces the durable per-version call bound and rejects a future ledger timestamp",async()=>{
  operational();const l=await lease();
  for(let n=0;n<SAV_INTAKE_CALL_POLICY.perVersion;n++) {const call=await reserveSavIntakeCall(l,config,`call-${n}`);expect(await settleSavIntakeCall(call.id,{inputTokens:100,outputTokens:50,thoughtTokens:0,totalTokens:150})).toBe(true);}
  await expect(reserveSavIntakeCall(l,config,"over-bound")).rejects.toThrow("BUDGET_EXHAUSTED");
  await f.db.update(savIntakeModelCalls).set({createdAt:new Date(Date.now()+60000)});
  await expect(readSavIntakeBudget(config)).rejects.toThrow("CLOCK_REJECTED");
});

it("daily quota deferral consumes no attempt and a fresh UTC day can claim the same waiting run",async()=>{
  operational();const id=(await enqueueSavIntakeMessage(messageId,config))!;
  await f.db.insert(savIntakeModelCalls).values(Array.from({length:300},(_,i)=>({messageKey:intakeRuntimeHash(`prior-${i}`),requestHash:intakeRuntimeHash(`request-${i}`),state:"settled",reservedNanoUsd:817152000,chargedNanoUsd:262500,payloadCiphertext:encryptSavPayload({metadata:{inputTokens:100,outputTokens:50,thoughtTokens:0,totalTokens:150}}),createdAt:new Date()})));
  expect(await claimSavIntakeRun(id,config)).toBeNull();expect(await claimSavIntakeRun(id,config)).toBeNull();
  expect((await readSavIntakeCurrent(threadId,config))?.attempts).toBe(0);
  // The shared daily margin is a deferral with its own reason, never this dossier's call budget.
  expect((await readSavIntakeCurrent(threadId,config))?.payload.reason).toBe("SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED");
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.parse(new Date().toISOString().slice(0,10)+"T00:00:00Z")+86400000));
  try {expect((await claimSavIntakeRun(id,config))?.run.attempts).toBe(1);}finally{vi.useRealTimers();}
});

it("does not analyze a truncated attachment inventory even when zero references were collected", async()=>{
  await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"Synthetic complete customer request",headers:{},attachments:[],attachmentInventory:{complete:false,limits:["node_limit"]}})}).where(eq(savMessages.id,messageId));
  const id=await enqueueSavIntakeMessage(messageId,config),network=vi.fn(async()=>{throw Error("NETWORK_FORBIDDEN");});
  expect((await analyseSavIntakeRuntime(id!,config,{env:()=>environment,network})).state).toBe("waiting");
  expect(network).not.toHaveBeenCalled();expect((await readSavIntakeCurrent(threadId,config))?.payload.plan?.decision.disposition.kind).toBe("collect_context");
});
it.each([false,true])("groups vision into understanding, masks before cache and preserves source (expansion=%s)",async(expansion)=>{
  const {syntheticImage,attachmentMetadata}=await import("../../../../test/sav-attachments");
  const bytes=await syntheticImage(),[source]=await f.db.select().from(savMessages).where(eq(savMessages.id,messageId)),[thread]=await f.db.select().from(savThreads).where(eq(savThreads.id,threadId));
  const metadata=attachmentMetadata(bytes.length);metadata.reference={...metadata.reference!,mailboxEmail:"support@example.invalid",gmailMessageId:source.gmailMessageId!,gmailThreadId:thread.gmailThreadId};
  const ciphertext=encryptSavPayload({text:"My configured application fails; the screenshot shows the error.",headers:{},attachments:[metadata],attachmentInventory:{complete:true,limits:[]}});
  await f.db.update(savMessages).set({bodyCiphertext:ciphertext}).where(eq(savMessages.id,messageId));
  const id=await enqueueSavIntakeMessage(messageId,config),canary="FAKE_VISUAL_SECRET_1234567890",wireBodies:unknown[]=[];
  const network=vi.fn(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    if(String(url).startsWith("https://generativelanguage.googleapis.com/")){
      const body=JSON.parse(String(init?.body)),data=JSON.parse(body.contents[0].parts[0].text);wireBodies.push(body);
      expect(body.contents[0].parts).toHaveLength(2);expect(body.contents[0].parts[1].inlineData.data).toBe(bytes.toString("base64"));
      expect(body.generationConfig.responseSchema.properties.images.items.properties.regions.items.properties.box).toMatchObject({type:"ARRAY",items:{type:"NUMBER"},nullable:true});
      const answer={messageId,requests:[{id:"r1",kind:"support",currentMessageId:messageId,quoteId:data.citationCatalogue.find((x:{sourceId:string})=>x.sourceId==="current").id}],ticketSummary:{title:"Application connection error",description:`Error E42 token: ${canary}`,requestIds:["r1"]},images:[{index:0,readability:"readable",text:expansion?"a@b.co ".repeat(570):`Error E42 token: ${canary}`,uncertainties:[expansion?"a@b.co ".repeat(40):`token: ${canary}`],regions:[{text:expansion?"a@b.co ".repeat(140):`Error E42 token: ${canary}`,box:null}]}]};
      return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(answer)}]}}],usageMetadata:{promptTokenCount:1220,candidatesTokenCount:200,thoughtsTokenCount:0,totalTokenCount:1420}});
    }
    return Response.json({total:0,results:[]});
  });
  await analyseSavIntakeRuntime(id!,config,{env:()=>environment,network,downloadAttachments:async()=>bytes});
  const current=await readSavIntakeCurrent(threadId,config);
  expect(wireBodies).toHaveLength(1);expect(current?.payload.attachments?.read.observations[0]).toMatchObject({status:expansion?"partial":"analyzed",reason:expansion?"partial_content":"observed"});
  expect(current?.payload.plan?.decision.evidence.some(e=>e.source==="current_attachment")).toBe(!expansion);
  if(expansion){expect(current?.payload.plan?.decision.disposition.kind).toBe("collect_context");expect(JSON.stringify(current?.payload)).not.toContain("a@b.co");}
  expect(JSON.stringify(current?.payload)).not.toContain(canary);
  const calls=await f.db.select().from(savIntakeModelCalls);expect(calls).toHaveLength(1);expect(calls[0].state).toBe("settled");
  expect(JSON.stringify(decryptSavPayload(calls[0].resultCiphertext!))).not.toContain(canary);
  expect((await f.db.select().from(savMessages).where(eq(savMessages.id,messageId)))[0].bodyCiphertext).toBe(ciphertext);
  expect(await f.db.select().from(savActions)).toHaveLength(0);
});
it("fences a human pause during image download before any model dispatch",async()=>{
  const {syntheticImage,attachmentMetadata}=await import("../../../../test/sav-attachments");const bytes=await syntheticImage();
  const [m]=await f.db.select().from(savMessages).where(eq(savMessages.id,messageId)),[t]=await f.db.select().from(savThreads).where(eq(savThreads.id,threadId));
  const meta=attachmentMetadata(bytes.length);meta.reference={...meta.reference!,mailboxEmail:"support@example.invalid",gmailMessageId:m.gmailMessageId!,gmailThreadId:t.gmailThreadId};
  await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"Synthetic application failure",attachments:[meta],attachmentInventory:{complete:true,limits:[]}})}).where(eq(savMessages.id,messageId));
  const id=await enqueueSavIntakeMessage(messageId,config),network=vi.fn(async()=>{throw Error("NETWORK_FORBIDDEN");});
  await analyseSavIntakeRuntime(id!,config,{env:()=>environment,network,downloadAttachments:async()=>{await f.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));return bytes;}});
  expect(network).not.toHaveBeenCalled();expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(0);
});
it("a readable attachment cannot promote an ambiguous HTML quotation to a complete current request",async()=>{
  const {syntheticImage,attachmentMetadata}=await import("../../../../test/sav-attachments");const bytes=await syntheticImage();
  const [m]=await f.db.select().from(savMessages).where(eq(savMessages.id,messageId)),[t]=await f.db.select().from(savThreads).where(eq(savThreads.id,threadId));
  const meta=attachmentMetadata(bytes.length);meta.reference={...meta.reference!,mailboxEmail:"support@example.invalid",gmailMessageId:m.gmailMessageId!,gmailThreadId:t.gmailThreadId};
  await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:'<html><body>Merci, réglé.<div class=gmail_quote>Je veux résilier mon compte.</div></body></html>',attachments:[meta],attachmentInventory:{complete:true,limits:[]}})}).where(eq(savMessages.id,messageId));
  const id=await enqueueSavIntakeMessage(messageId,config),network=vi.fn(async()=>{throw Error("NETWORK_FORBIDDEN");});
  expect((await analyseSavIntakeRuntime(id!,config,{env:()=>environment,network,downloadAttachments:async()=>bytes})).state).toBe("waiting");
  expect(network).not.toHaveBeenCalled();expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(0);
  expect((await readSavIntakeCurrent(threadId,config))?.payload.attachments?.textComplete).toBe(false);
});

it.each([false,true])("publishes only a still-fresh authenticated Other qualification (expire=%s)",async(expire)=>{
  const {readSavOtherAuthentication}=await import("../other-auth"),sender="noreply.notifications@trustpilot.com",subject="Synthetic review 5 stars",text="Synthetic complete notification";
  const hash=(s:string)=>createHash("sha256").update(s).digest("hex"),rules=[{id:"synthetic-rule",family:"trustpilot_positive",mailboxId,subjectSha256:hash(subject),bodySha256:hash(text)}];
  environment={...environment,SAV_OTHER_OBSERVATION_RULES_JSON:JSON.stringify({version:1,rules:[{family:"trustpilot_positive",mailboxId,subjectSha256:[hash(subject)]}]}),
    SAV_INTAKE_OTHER_RULES_JSON:JSON.stringify({version:1,resource:{resourceId:"synthetic-rule-resource",revisionId:"v1",sha256:hash(JSON.stringify(rules))},approvedBy:"synthetic-operator",approvedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),rules})};
  config=savIntakeRuntimeConfig(environment)!;
  await f.db.update(savMessages).set({fromEmail:sender,subject,bodyCiphertext:encryptSavPayload({text,headers:{"in-reply-to":"",references:"","message-id":"synthetic-id","content-type":"text/plain"},attachments:[],attachmentInventory:{complete:true,limits:[]}})}).where(eq(savMessages.id,messageId));
  const id=(await enqueueSavIntakeMessage(messageId,config))!,metadata=vi.fn(async(input:Parameters<typeof readSavOtherAuthentication>[0])=>readSavOtherAuthentication(input,async()=>Response.json({id:input.messageId,threadId:input.threadId,payload:{headers:[{name:"From",value:sender},{name:"Authentication-Results",value:"mx.google.com; dkim=pass header.i=@trustpilot.com; dmarc=pass header.from=trustpilot.com"}]}})));
  const network=vi.fn(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const data=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
    if(expire) {vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()+61000));}
    return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({messageId,requests:[{id:"noise",kind:"other",currentMessageId:messageId,quoteId:data.citationCatalogue.find((c:{sourceId:string})=>c.sourceId==="current").id}]})}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,thoughtsTokenCount:0,totalTokenCount:150}});
  });
  try {
    await analyseSavIntakeRuntime(id,config,{env:()=>environment,network,authenticateOther:metadata});
    const current=(await readSavIntakeCurrent(threadId,config))!;
    expect(metadata).toHaveBeenCalledTimes(1);expect(network).toHaveBeenCalledTimes(1);
    if(expire){expect(current.state).toBe("waiting");expect(current.payload.plan).toBeUndefined();expect(current.payload.other).toBeUndefined();}
    else {expect(current.state).toBe("observed");expect(current.payload.plan?.progress.kind).toBe("qualified_other");expect(current.payload.other?.ruleId).toBe("synthetic-rule");}
    expect(await f.db.select().from(savActions)).toHaveLength(0);
  }finally{vi.useRealTimers();}
});
it.each(["pdf","image_limit","budget"]) ("finishes a non-dispatched image attempt with its precise reason (%s)",async(kind)=>{
  const {syntheticImage,attachmentMetadata}=await import("../../../../test/sav-attachments"),{savAttachmentDisplayRead}=await import("../attachment-contract");
  const bytes=await syntheticImage(),[m]=await f.db.select().from(savMessages).where(eq(savMessages.id,messageId)),[t]=await f.db.select().from(savThreads).where(eq(savThreads.id,threadId));
  const attachments=Array.from({length:kind==="image_limit"?4:1},(_,index)=>{
    const meta=attachmentMetadata(bytes.length);return {...meta,filename:kind==="pdf"?"synthetic.pdf":`synthetic-${index}.png`,mimeType:kind==="pdf"?"application/pdf":meta.mimeType,
      reference:{...meta.reference!,mailboxEmail:"support@example.invalid",gmailMessageId:m.gmailMessageId!,gmailThreadId:t.gmailThreadId,partId:String(index+1)}};
  });
  await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"My application fails with an error.",headers:{},attachments,attachmentInventory:{complete:true,limits:[]}})}).where(eq(savMessages.id,messageId));
  const id=(await enqueueSavIntakeMessage(messageId,config))!;
  if(kind==="budget")await f.db.insert(savIntakeModelCalls).values(Array.from({length:SAV_INTAKE_CALL_POLICY.perMessage},(_,i)=>({runId:id,messageKey:intakeRuntimeHash(messageId),requestHash:`previous-${i}`,state:"settled",reservedNanoUsd:817152000,chargedNanoUsd:262500,payloadCiphertext:encryptSavPayload({metadata:usage})})));
  const bodies:string[]=[],network=vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(String(init?.body));throw Error("NETWORK_FORBIDDEN");});
  await analyseSavIntakeRuntime(id,config,{env:()=>environment,network,downloadAttachments:async()=>bytes});
  const current=(await readSavIntakeCurrent(threadId,config))!,read=current.payload.attachments!.read,display=savAttachmentDisplayRead(read)!;
  expect(read.state).toBe("complete");expect(read.completedAt).toBeTruthy();
  // The PDF case now dispatches the reader call; the fixture network fails after dispatch, so its usage stays uncertain.
  expect(current.state).toBe(kind==="pdf"?"uncertain":"waiting");
  expect(display.observations.at(-1)?.reason).toBe(kind==="pdf"?"unsupported_type":kind==="image_limit"?"image_limit":"budget_exhausted");
  expect(display.observations.every(o=>!["in_progress","outcome_uncertain"].includes(o.reason))).toBe(true);
  if(kind==="image_limit")expect(display.observations.slice(0,3).every(o=>o.reason==="context_incomplete")).toBe(true);
  // SAV-42: a PDF of a complete text no longer blocks before the reader; it is sent as an
  // explicit unread file (never content) and the run still produces no action here.
  if(kind==="pdf"){expect(network).toHaveBeenCalled();expect(bodies.join()).toContain("unreadAttachments");expect((current.payload.input as {message?:{unreadAttachments?:unknown}}|undefined)?.message?.unreadAttachments).toEqual([{sourceId:display.observations[0].sourceId,reason:"unsupported_type"}]);}
  else expect(network).not.toHaveBeenCalled();
  expect(await f.db.select().from(savActions)).toHaveLength(0);
});

it("SAV-42: a mixed image + PDF message sends only the image to the visual read and lists the PDF as unread",async()=>{
  const {syntheticImage,attachmentMetadata}=await import("../../../../test/sav-attachments");
  const bytes=await syntheticImage(),[m]=await f.db.select().from(savMessages).where(eq(savMessages.id,messageId)),[t]=await f.db.select().from(savThreads).where(eq(savThreads.id,threadId));
  const attachments=["png","pdf"].map((kind,index)=>{const meta=attachmentMetadata(bytes.length);return {...meta,filename:kind==="pdf"?"synthetic.pdf":"synthetic.png",mimeType:kind==="pdf"?"application/pdf":meta.mimeType,
    reference:{...meta.reference!,mailboxEmail:"support@example.invalid",gmailMessageId:m.gmailMessageId!,gmailThreadId:t.gmailThreadId,partId:String(index+1)}};});
  await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"My application fails with an error.",headers:{},attachments,attachmentInventory:{complete:true,limits:[]}})}).where(eq(savMessages.id,messageId));
  const id=(await enqueueSavIntakeMessage(messageId,config))!;
  const bodies:string[]=[],network=vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(String(init?.body));throw Error("NETWORK_FORBIDDEN");});
  const download=vi.fn(async()=>bytes);
  await analyseSavIntakeRuntime(id,config,{env:()=>environment,network,downloadAttachments:download});
  const current=(await readSavIntakeCurrent(threadId,config))!;
  const message=(current.payload.input as {message?:{attachmentInputs?:unknown[];unreadAttachments?:{reason:string}[]}}|undefined)?.message;
  expect(download).toHaveBeenCalledTimes(1);
  expect(message?.attachmentInputs).toHaveLength(1);expect(message?.unreadAttachments?.map(u=>u.reason)).toEqual(["unsupported_type"]);
  expect(network).toHaveBeenCalled();
  const sent=JSON.parse(JSON.parse(bodies[0]).contents[0].parts[0].text);
  expect(sent.imageSources).toHaveLength(1);expect(sent.unreadAttachments).toHaveLength(1);
  expect(await f.db.select().from(savActions)).toHaveLength(0);
});

it.each(["valid_json", "invalid_json"])("reconciles only proven omitted zero thoughts through %s", async output => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const network = vi.fn(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: output === "valid_json" ? JSON.stringify({ messageId, requests: [] }) : "{invalid-json" }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 } }));
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  expect(await readSavIntakeBudget(config)).toMatchObject({ callCount: 1, chargedNanoUsd: 262_500, uncertain: false });
  const [call] = await f.db.select().from(savIntakeModelCalls);
  expect(call.state).toBe("settled");
  expect(decryptSavPayload(call.payloadCiphertext)).toMatchObject({ metadata: { thoughtTokens: 0, usageReconciliation: "gemini_omitted_zero_thoughts.v1" } });
  if (output === "invalid_json") expect((await readSavIntakeCurrent(threadId, config))?.state).toBe("waiting");
  expect(network).toHaveBeenCalledTimes(1); expect(await f.db.select().from(savActions)).toHaveLength(0);
});
it.each([149, 151])("does not infer omitted thoughts from an unbalanced total %s", async totalTokenCount => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const network = vi.fn(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ messageId, requests: [] }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount } }));
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  expect(await readSavIntakeBudget(config)).toMatchObject({ callCount: 1, chargedNanoUsd: 817_152_000, uncertain: true });
  expect((await readSavIntakeCurrent(threadId, config))?.state).toBe("uncertain");
  const [call] = await f.db.select().from(savIntakeModelCalls);
  expect(decryptSavPayload<{metadata: unknown}>(call.payloadCiphertext).metadata).not.toHaveProperty("usageReconciliation");
  expect(network).toHaveBeenCalledTimes(1); expect(await f.db.select().from(savActions)).toHaveLength(0);
});
it("preserves explicit positive thought counters without a reconciliation marker", async () => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const network = vi.fn(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ messageId, requests: [] }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 10, totalTokenCount: 160 } }));
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  expect(await readSavIntakeBudget(config)).toMatchObject({ callCount: 1, chargedNanoUsd: 300_000, uncertain: false });
  const [call] = await f.db.select().from(savIntakeModelCalls);
  expect(decryptSavPayload(call.payloadCiphertext)).toMatchObject({metadata:{thoughtTokens:10}});
  expect(decryptSavPayload<{metadata: unknown}>(call.payloadCiphertext).metadata).not.toHaveProperty("usageReconciliation");
  expect(network).toHaveBeenCalledTimes(1);
});


const previousUsageCode = "2483091f858fd3e4c31490c8446278f493f663ba";
async function confinedUsageFixture() {
  operational();
  const l=await lease(), call=await reserveSavIntakeCall(l,config,"confined-original-request");
  const metadata={inputTokens:100,outputTokens:50,totalTokens:150,finishReason:"STOP" as const,
    transport:{model:config.model,attempts:1,retries:0,errorCode:null}};
  await f.db.update(savIntakeModelCalls).set({state:"uncertain",payloadCiphertext:encryptSavPayload({metadata}),settledAt:new Date()}).where(eq(savIntakeModelCalls.id,call.id));
  await f.db.update(savIntakeRuns).set({state:"uncertain",leaseToken:null,leaseUntil:null,freshUntil:null,payloadCiphertext:encryptSavPayload({...payload(),configuration:{configHash:config.configHash,policyHash:config.policyHash,resourcesHash:config.resourcesHash,codeRevision:previousUsageCode,model:config.model}})}).where(eq(savIntakeRuns.id,l.run.id));
  await f.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));
  return {l,call,metadata,original:(await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id,call.id)))[0]};
}
it("confined usage repairs accounting once, retains original encrypted evidence and never revives output",async()=>{
  const {call,original}=await confinedUsageFixture();
  const beforeRun=(await f.db.select().from(savIntakeRuns))[0],beforeMessage=(await f.db.select().from(savMessages))[0];
  expect(await reconcileConfinedIntakeUsage(config)).toEqual({reconciled:1});
  expect(await reconcileConfinedIntakeUsage(config)).toEqual({reconciled:0});
  const current=(await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id,call.id)))[0];
  expect(current).toMatchObject({state:"settled",chargedNanoUsd:262500,resultCiphertext:null,runId:original.runId,messageKey:original.messageKey,requestHash:original.requestHash,reservedNanoUsd:original.reservedNanoUsd,createdAt:original.createdAt});
  expect(decryptSavPayload(current.payloadCiphertext)).toMatchObject({metadata:{thoughtTokens:0,usageReconciliation:"gemini_omitted_zero_thoughts.v1"}});
  const events=await f.db.select().from(savIntakeJournal);
  const repair=events.filter(e=>e.kind==="verified_zero_thought_usage_reconciled");expect(repair).toHaveLength(1);
  expect(decryptSavPayload(repair[0].payloadCiphertext)).toMatchObject({callId:call.id,originalPayloadCiphertext:original.payloadCiphertext,originalChargedNanoUsd:817152000});
  expect((await f.db.select().from(savIntakeRuns))[0]).toEqual(beforeRun);
  expect((await f.db.select().from(savMessages))[0]).toEqual(beforeMessage);
  expect((await readSavIntakeBudget(config))).toMatchObject({chargedNanoUsd:262500,lifetimeCallCount:1,uncertain:false});
  expect(await f.db.select().from(savActions)).toHaveLength(0);expect(await f.db.select().from(savDecisions)).toHaveLength(0);expect(await f.db.select().from(auditLogs)).toHaveLength(0);
  expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);expect(await f.db.select().from(savIntakeEffects)).toHaveLength(0);
});
it("confined usage concurrent reconciliation records one accounting transition",async()=>{
  await confinedUsageFixture();
  const results=await Promise.all([reconcileConfinedIntakeUsage(config),reconcileConfinedIntakeUsage(config)]);
  expect(results.reduce((n,r)=>n+r.reconciled,0)).toBe(1);
  expect((await f.db.select().from(savIntakeJournal)).filter(e=>e.kind==="verified_zero_thought_usage_reconciled")).toHaveLength(1);
});
it.each(["input_missing","output_missing","total_missing","positive_residual","negative_residual","thoughts_explicit","input_negative","input_too_large","output_too_large","fractional","finish","block","attempts","retries","error","model","forged_marker_residual","forged_marker_thoughts"])("confined usage refuses unproven provider metadata: %s",async(kind)=>{
  const fixture=await confinedUsageFixture(),metadata:Record<string,unknown>={...fixture.metadata,transport:{...fixture.metadata.transport}};
  if(kind==="input_missing")delete metadata.inputTokens;
  if(kind==="output_missing")delete metadata.outputTokens;
  if(kind==="total_missing")delete metadata.totalTokens;
  if(kind==="positive_residual")metadata.totalTokens=151;
  if(kind==="negative_residual")metadata.totalTokens=149;
  if(kind==="thoughts_explicit")metadata.thoughtTokens=0;
  if(kind==="input_negative")Object.assign(metadata,{inputTokens:-1,totalTokens:49});
  if(kind==="input_too_large")Object.assign(metadata,{inputTokens:1048577,totalTokens:1048627});
  if(kind==="output_too_large")Object.assign(metadata,{outputTokens:8193,totalTokens:8293});
  if(kind==="fractional")Object.assign(metadata,{inputTokens:100.5,totalTokens:150.5});
  if(kind==="forged_marker_residual")Object.assign(metadata,{totalTokens:151,usageReconciliation:"gemini_omitted_zero_thoughts.v1"});
  if(kind==="forged_marker_thoughts")Object.assign(metadata,{thoughtTokens:1,totalTokens:151,usageReconciliation:"gemini_omitted_zero_thoughts.v1"});
  if(kind==="finish")metadata.finishReason="MAX_TOKENS";
  if(kind==="block")metadata.blockReason="SAFETY";
  const transport=metadata.transport as Record<string,unknown>;
  if(kind==="attempts")transport.attempts=2;
  if(kind==="retries")transport.retries=1;
  if(kind==="error")transport.errorCode="SAV_AI_PROVIDER_TIMEOUT";
  if(kind==="model")transport.model="other";
  await f.db.update(savIntakeModelCalls).set({payloadCiphertext:encryptSavPayload({metadata})}).where(eq(savIntakeModelCalls.id,fixture.call.id));
  const before=(await f.db.select().from(savIntakeModelCalls))[0];
  expect(await reconcileConfinedIntakeUsage(config)).toEqual({reconciled:0});
  expect((await f.db.select().from(savIntakeModelCalls))[0]).toEqual(before);
});
it.each(["not_paused","executable_run","wrong_code","wrong_config","wrong_policy","wrong_resources","wrong_message_key","partial_charge","cached_result","no_run","source_model","before_frontier","outbound","source_absent"])("confined usage refuses ineligible provenance or authority: %s",async(kind)=>{
  const {l,call}=await confinedUsageFixture();
  const run=(await f.db.select().from(savIntakeRuns))[0],body=decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext);
  if(kind==="not_paused")await f.db.update(savThreads).set({aiPaused:false}).where(eq(savThreads.id,threadId));
  if(kind==="executable_run")await f.db.update(savIntakeRuns).set({state:"observed",freshUntil:new Date(Date.now()+60000)}).where(eq(savIntakeRuns.id,l.run.id));
  if(kind==="wrong_code")body.configuration!.codeRevision="b".repeat(40);
  if(kind==="wrong_config")body.configuration!.configHash="b".repeat(64);
  if(kind==="wrong_policy")body.configuration!.policyHash="b".repeat(64);
  if(kind==="wrong_resources")body.configuration!.resourcesHash="b".repeat(64);
  if(kind==="source_model")body.configuration!.model="other";
  if(kind==="source_absent")delete body.configuration;
  if(kind==="before_frontier")await f.db.update(savMessages).set({receivedAt:new Date(Date.parse(config.receivedAfter)-1)}).where(eq(savMessages.id,messageId));
  if(kind==="outbound")await f.db.update(savMessages).set({direction:"outbound"}).where(eq(savMessages.id,messageId));
  await f.db.update(savIntakeRuns).set({payloadCiphertext:encryptSavPayload(body)}).where(eq(savIntakeRuns.id,l.run.id));
  if(kind==="wrong_message_key")await f.db.update(savIntakeModelCalls).set({messageKey:"b".repeat(64)}).where(eq(savIntakeModelCalls.id,call.id));
  if(kind==="partial_charge")await f.db.update(savIntakeModelCalls).set({chargedNanoUsd:1}).where(eq(savIntakeModelCalls.id,call.id));
  if(kind==="cached_result")await f.db.update(savIntakeModelCalls).set({resultCiphertext:encryptSavPayload({json:{synthetic:true}})}).where(eq(savIntakeModelCalls.id,call.id));
  if(kind==="no_run")await f.db.update(savIntakeModelCalls).set({runId:null}).where(eq(savIntakeModelCalls.id,call.id));
  expect(await reconcileConfinedIntakeUsage(config)).toEqual({reconciled:0});
  expect((await f.db.select().from(savIntakeModelCalls))[0].state).toBe("uncertain");
});
it("confined usage preserves spent-request replay barrier and frees only verified budget for another message",async()=>{
  const {call}=await confinedUsageFixture();await reconcileConfinedIntakeUsage(config);
  await f.db.update(savThreads).set({aiPaused:false}).where(eq(savThreads.id,threadId));
  await f.db.update(savIntakeRuns).set({state:"waiting"});
  const next=(await claimSavIntakeRun((await f.db.select().from(savIntakeRuns))[0].id,config))!;
  await expect(reserveSavIntakeCall(next,config,"confined-original-request")).rejects.toThrow("CALL_ALREADY_CONSUMED");
  expect((await f.db.select().from(savIntakeModelCalls)).filter(r=>r.id===call.id)).toHaveLength(1);
  threadId=(await f.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"other@example.invalid"}).returning())[0].id;messageId=(await message()).id;
  config={...config,maxNanoUsd:817500000};
  const fresh=await lease();expect((await reserveSavIntakeCall(fresh,config,"other-request")).cached).toBeNull();
  expect((await readSavIntakeBudget(config))).toMatchObject({chargedNanoUsd:817414500,lifetimeCallCount:2});
  expect(await f.db.select().from(savActions)).toHaveLength(0);
});

it("confined usage permits superseded non-executable evidence but never qualification budgets",async()=>{
  const {l}=await confinedUsageFixture();
  await f.db.update(savIntakeRuns).set({state:"superseded",isCurrent:false}).where(eq(savIntakeRuns.id,l.run.id));
  const qualification={...config,budgetProfile:undefined,maxRollingNanoUsd:undefined,maxCalls:30};
  expect(await reconcileConfinedIntakeUsage(qualification)).toEqual({reconciled:0});
  expect(await reconcileConfinedIntakeUsage(config)).toEqual({reconciled:1});
  expect((await f.db.select().from(savIntakeRuns))[0]).toMatchObject({state:"superseded",isCurrent:false,leaseToken:null,freshUntil:null});
});

async function commonGuardExecution(runId: string, kind: string) {
  const [staff] = await f.db.insert(staffUsers).values({ clerkId: randomUUID(), email: `runtime-guard-${randomUUID()}@example.invalid`, name: "Synthetic Runtime Guard", role: "admin", active: true }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "synthetic-guard", state: "approved", administratorId: staff.id, policyHash: config.policyHash, payloadCiphertext: encryptSavPayload({}) }).returning();
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runId, runVersion: 1, policyId: policy.id, policyHash: config.policyHash,
    state: kind === "confirmed" ? "confirmed" : "waiting", payloadCiphertext: encryptSavPayload({}) }).returning();
  if (kind !== "confirmed") await f.db.insert(savIntakeEffects).values({ executionId: execution.id, businessKey: `synthetic-runtime-${execution.id}`, kind: "ticket_create", permission: "create_ticket",
    state: kind === "partial-confirmed" ? "confirmed" : kind === "dispatched" ? "dispatched" : "planned", intentHash: config.policyHash, intentCiphertext: encryptSavPayload({}),
    ...(kind === "dispatched" ? { dispatchedAt: new Date() } : {}), ...(kind === "verification" ? { verificationCiphertext: encryptSavPayload({ confirmed: true }) } : {}) });
  return async () => {
    await f.db.delete(savIntakeEffects).where(eq(savIntakeEffects.executionId, execution.id));
    await f.db.delete(savIntakeExecutions).where(eq(savIntakeExecutions.id, execution.id));
    await f.db.delete(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, policy.id));
    await f.db.delete(staffUsers).where(eq(staffUsers.id, staff.id));
  };
}
it.each(["confirmed", "partial-confirmed", "dispatched", "planned", "verification"])("common guard runtime revalidates %s execution after run selection", async kind => {
  const id = (await enqueueSavIntakeMessage(messageId, config))!;
  expect((await pendingSavIntakeRuns(config)).map(run => run.id)).toContain(id);
  const remove = await commonGuardExecution(id, kind);
  try {
    const allowed = kind === "planned";
    expect((await pendingSavIntakeRuns(config)).some(run => run.id === id)).toBe(allowed);
    const claimed = await claimSavIntakeRun(id, config);
    expect(Boolean(claimed)).toBe(allowed);
    expect((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id)))[0].attempts).toBe(allowed ? 1 : 0);
    expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
  } finally { await remove(); }
});
it("common guard runtime fences a leased analysis before model reservation when an effect commits", async () => {
  const current = await lease(), remove = await commonGuardExecution(current.run.id, "dispatched");
  try {
    await expect(assertSavIntakeLease(current, config)).rejects.toThrow("CONTEXT_CHANGED");
    await expect(reserveSavIntakeCall(current, config, "a".repeat(64))).rejects.toThrow("CONTEXT_CHANGED");
    await expect(saveSavIntakeResult(current, config, payload(), "observed")).rejects.toThrow("CONTEXT_CHANGED");
    expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
    expect((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, current.run.id)))[0].attempts).toBe(1);
  } finally { await remove(); }
});
it("common guard runtime still accepts a genuinely new message after the old execution completed", async () => {
  const id = (await enqueueSavIntakeMessage(messageId, config))!, remove = await commonGuardExecution(id, "confirmed");
  try {
    const next = await message({ receivedAt: new Date(Date.now() + 1) });
    const nextRun = (await enqueueSavIntakeMessage(next.id, config))!;
    expect(nextRun).toBeTruthy();
    expect((await pendingSavIntakeRuns(config)).map(run => run.id)).toContain(nextRun);
    expect((await claimSavIntakeRun(nextRun, config))?.run.messageId).toBe(next.id);
  } finally { await remove(); }
});

it.each(["sender", "recipients"])("isolates invalid address metadata (%s) before a provider claim without blocking the next dossier", async variant => {
  await f.db.update(savMessages).set(variant === "sender" ? {fromEmail:"invalid-address"} : {toEmails:Array.from({length:31},(_,i)=>`recipient${i}@example.invalid`)}).where(eq(savMessages.id,messageId));
  const invalid = (await enqueueSavIntakeMessage(messageId, config))!;
  const [thread] = await f.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"second@example.invalid"}).returning();
  const [next] = await f.db.insert(savMessages).values({mailboxId,threadId:thread.id,direction:"inbound",fromEmail:"second@example.invalid",toEmails:["support@example.invalid"],subject:"Second synthetic request",gmailMessageId:randomUUID(),receivedAt:now(),bodyCiphertext:encryptSavPayload({text:"Help with a synthetic setting",headers:{},attachments:[]})}).returning();
  const valid = (await enqueueSavIntakeMessage(next.id, config))!;
  expect(await claimSavIntakeRun(invalid,config)).toBeNull();
  const [blocked] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,invalid));
  expect(blocked).toMatchObject({state:"waiting",attempts:0,leaseToken:null,leaseUntil:null});
  expect(decryptSavPayload<IntakeRuntimePayload>(blocked.payloadCiphertext).reason).toBe("SAV_INTAKE_MESSAGE_METADATA_INVALID");
  expect(await pendingSavIntakeRuns(config)).toEqual([{id:valid}]);
  expect((await claimSavIntakeRun(valid,config))?.run.id).toBe(valid);
  expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(0);
  expect(await f.db.select().from(savIntakeEffects)).toHaveLength(0);
});

it("finishes an accepted Other investigation as an explicit rule choice instead of consuming a second automatic analysis", async () => {
  const id = (await enqueueSavIntakeMessage(messageId, config))!;
  const network = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ messageId,
      requests: [{ id: "noise", kind: "other", currentMessageId: messageId, quoteId: data.citationCatalogue[0].id }] }) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 20 } });
  });
  expect(await analyseSavIntakeRuntime(id, config, { env: () => environment, network })).toMatchObject({ state: "observed" });
  expect((await readSavIntakeCurrent(threadId, config))?.payload.plan?.progress).toMatchObject({ kind: "human_choice", view: "to_validate" });
  expect(await pendingSavIntakeRuns(config)).toHaveLength(0);
  expect(network).toHaveBeenCalledTimes(1);
  expect(await f.db.select().from(savActions)).toHaveLength(0);
});

it.each(["valid_repair", "invalid_repair", "invalid_box", "unknown_usage", "short_deadline"])("resumes malformed vision with a new fenced attempt while preserving visual and ledger guards (%s)", async scenario => {
  const { syntheticImage, attachmentMetadata } = await import("../../../../test/sav-attachments");
  const bytes = await syntheticImage(), [source] = await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)), [thread] = await f.db.select().from(savThreads).where(eq(savThreads.id, threadId));
  const metadata = attachmentMetadata(bytes.length);
  metadata.reference = { ...metadata.reference!, mailboxEmail: "support@example.invalid", gmailMessageId: source.gmailMessageId!, gmailThreadId: thread.gmailThreadId };
  const ciphertext = encryptSavPayload({ text: "Thank you; the screenshot is for reference.", headers: {}, attachments: [metadata], attachmentInventory: { complete: true, limits: [] } });
  await f.db.update(savMessages).set({ bodyCiphertext: ciphertext }).where(eq(savMessages.id, messageId));
  const id = (await enqueueSavIntakeMessage(messageId, config))!, wireBodies: string[] = [];
  const network = vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return Response.json({ total: 0, results: [] });
    const wire = String(init?.body), body = JSON.parse(wire), data = JSON.parse(body.contents[0].parts[0].text);
    wireBodies.push(wire);
    const answer = wireBodies.length === 2 && ["valid_repair", "short_deadline"].includes(scenario)
      ? { messageId, requests: [{ id: "r1", kind: "acknowledgement", currentMessageId: messageId, quoteId: data.citationCatalogue[0].id }], images: [{ index: 0, readability: "readable", text: "Error E42", uncertainties: [], regions: [] }] }
      : scenario === "invalid_box" ? {messageId,requests:[{id:"r1",kind:"acknowledgement",currentMessageId:messageId,quoteId:data.citationCatalogue[0].id}],images:[{index:0,readability:"readable",text:"Synthetic",uncertainties:[],regions:[{text:"Synthetic",box:["0","0","0","0"]}]}]} : { privateRejectedValue: "SYNTHETIC_REJECTED_CANARY", requests: null };
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: scenario === "unknown_usage" ? { promptTokenCount: 1220 } : { promptTokenCount: 1220, candidatesTokenCount: 200, thoughtsTokenCount: 0, totalTokenCount: 1420 } });
  });
  const deps = { env: () => environment, network, downloadAttachments: async () => bytes, ...(scenario === "short_deadline" ? { deadlineMs: Date.now() + 65_000 } : {}) };
  const result = await analyseSavIntakeRuntime(id, config, deps);
  expect(result.state).toBe(scenario === "valid_repair" ? "observed" : scenario === "unknown_usage" ? "uncertain" : "waiting");
  expect(wireBodies).toHaveLength(["unknown_usage", "short_deadline"].includes(scenario) ? 1 : 2);
  if (!["unknown_usage", "short_deadline"].includes(scenario)) {
    expect(wireBodies[0]).not.toBe(wireBodies[1]);
    expect(JSON.parse(wireBodies[1]).systemInstruction.parts[0].text).toContain("FORMAT REPAIR v1");
  }
  const current = await readSavIntakeCurrent(threadId, config);
  expect(current?.attempts).toBe(["unknown_usage", "short_deadline"].includes(scenario) ? 1 : 2);
  // A non-numeric box stays structurally invalid; a numeric box of the wrong shape is normalized (output-contract-runtime.test).
  if(scenario==="invalid_box"){
    expect(current?.payload.attachments?.read.observations[0]).toMatchObject({status:"not_read",reason:"validation_failed"});
    expect(JSON.stringify(current?.payload.traces)).toContain("images.0.regions.0.box");
    expect(JSON.parse(wireBodies[1]).systemInstruction.parts[0].text).toContain("images.0.regions.0.box");
  }
  expect(JSON.stringify(current?.payload)).not.toContain("SYNTHETIC_REJECTED_CANARY");
  const calls = await f.db.select().from(savIntakeModelCalls);
  expect(calls).toHaveLength(wireBodies.length); expect(calls[0].resultCiphertext).toBeNull();
  expect(calls.every(c => c.state === (scenario === "unknown_usage" ? "uncertain" : "settled"))).toBe(true);
  if (scenario === "short_deadline") {
    expect((await analyseSavIntakeRuntime(id, config, { ...deps, deadlineMs: Date.now() + 120_000 })).state).toBe("observed");
    expect(wireBodies).toHaveLength(2);
    expect((await readSavIntakeCurrent(threadId, config))?.attempts).toBe(2);
  }
  const count = network.mock.calls.length;
  await analyseSavIntakeRuntime(id, config, deps);
  expect(network).toHaveBeenCalledTimes(count);
  expect(await f.db.select().from(savActions)).toHaveLength(0);
  expect((await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].bodyCiphertext).toBe(ciphertext);
});

it("preflights the whole matching plan against durable per-message capacity without reserving",async()=>{
  const l=await lease();
  for(const key of ["a","b"]){const r=await reserveSavIntakeCall(l,config,key.repeat(64));await settleSavIntakeCall(r.id,usage,{json:{fixture:true},metadata:usage});}
  // Earlier versions already used all but three of the message's lifetime dispatches.
  await priorCalls(SAV_INTAKE_CALL_POLICY.perMessage-3);
  const before=await readSavIntakeBudget(config);
  await expect(assertSavIntakeCallPlan(messageId,config,["c".repeat(64),"d".repeat(64)])).rejects.toThrow("BUDGET_EXHAUSTED");
  await expect(assertSavIntakeCallPlan(messageId,config,["a".repeat(64),"c".repeat(64)])).resolves.toBeUndefined();
  expect(await readSavIntakeBudget(config)).toEqual(before);
  const r=await reserveSavIntakeCall(l,config,"c".repeat(64));await settleSavIntakeCall(r.id,usage,{json:{fixture:true},metadata:usage});
  await expect(assertSavIntakeCallPlan(messageId,config,["a".repeat(64),"b".repeat(64),"c".repeat(64)])).resolves.toBeUndefined();
  await expect(assertSavIntakeCallPlan(messageId,config,["d".repeat(64)])).rejects.toThrow("BUDGET_EXHAUSTED");
  expect((await readSavIntakeBudget(config)).callCount).toBe(SAV_INTAKE_CALL_POLICY.perMessage);
});
it("preflight never treats a consumed result or uncertain usage as a reusable cached comparison",async()=>{
  const l=await lease(),r=await reserveSavIntakeCall(l,config,"a".repeat(64));
  await expect(assertSavIntakeCallPlan(messageId,config,["a".repeat(64)])).rejects.toThrow("USAGE_UNCERTAIN");
  await settleSavIntakeCall(r.id,usage);
  await expect(assertSavIntakeCallPlan(messageId,config,["a".repeat(64)])).rejects.toThrow("CALL_ALREADY_CONSUMED");
  expect((await readSavIntakeBudget(config)).callCount).toBe(1);
});
it("preflights daily money/call limits and rejects duplicate or malformed plans",async()=>{
  await expect(assertSavIntakeCallPlan(messageId,{...config,maxNanoUsd:1_000_000_000},["a".repeat(64),"b".repeat(64)])).rejects.toThrow("BUDGET_EXHAUSTED");
  await expect(assertSavIntakeCallPlan(messageId,{...config,maxCalls:1},["a".repeat(64),"b".repeat(64)])).rejects.toThrow("BUDGET_EXHAUSTED");
  for(const hashes of [[],["a".repeat(64),"a".repeat(64)],["not-a-hash"],["a","b","c","d"].map(c=>c.repeat(64))])await expect(assertSavIntakeCallPlan(messageId,config,hashes)).rejects.toThrow("DISPATCH_REJECTED");
  expect((await readSavIntakeBudget(config)).callCount).toBe(0);
});

function recoveryProvider(){
 const provider=executionProvider("synthetic@example.invalid");provider.seedTicket({ownerId:"301"});
 provider.objects.notes["401"]={id:"401",properties:{hs_note_body:"Synthetic complete investigation",hs_timestamp:new Date(Date.now()-86400000).toISOString()}};
 provider.links.set("tickets:201:notes",["401"]);
 let failures=true,understandings=0,matching=0,historyAttempts=0;
 const network:typeof fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(String(url).startsWith("https://generativelanguage.googleapis.com/")){
   const data=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text),catalogue=data.citationCatalogue as {id:string;sourceId:string}[];
   let answer:unknown;
   if(!data.tickets){understandings++;answer={messageId,requests:[{id:"r1",kind:"support",currentMessageId:messageId,quoteId:catalogue.find(c=>c.sourceId==="current")!.id}],ticketSummary:{title:"Connexion synthétique",description:"La connexion ne marche plus.",requestIds:["r1"]}};}
   else{matching++;answer={investigationComplete:true,tickets:[{ticketId:"201",relation:"same",requestIds:["r1"],evidenceIds:["current","ticket-201","history-201"],rationale:"Synthetic matching evidence",grounding:["current","ticket-201","history-201"].map(sourceId=>({quoteId:catalogue.find(c=>c.sourceId===sourceId)!.id}))}]};}
   return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(answer)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,thoughtsTokenCount:0,totalTokenCount:150}});
  }
  if(path.endsWith("/notes/batch/read")){historyAttempts++;if(failures)throw TypeError("Synthetic transient connection failure");}
  return provider.network(url,init);
 };
 return {provider,network,enable:()=>{failures=false;},get understandings(){return understandings;},get matching(){return matching;},get historyAttempts(){return historyAttempts;}};
}
async function scheduledReadFailure(){
 await f.db.insert(savSyncState).values({key:"sav-intake-console-schema-v1",status:"installed"}).onConflictDoUpdate({target:savSyncState.key,set:{status:"installed"}});
 environment.SAV_INTAKE_EVENT_DISPATCH="on";
 const p=recoveryProvider(),start=vi.fn(async()=>({runId:"synthetic-workflow"})),id=(await enqueueSavIntakeMessage(messageId,config))!;
 expect(await analyseSavIntakeRuntime(id,config,{env:()=>environment,network:p.network,startReadRecovery:start})).toHaveProperty("state","waiting");
 const [run]=await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,id));
 const saved=decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext);
 expect(saved.readRecovery).toMatchObject({state:"scheduled",attempts:0,operation:"ticket_history",code:"SAV_HUBSPOT_READ_UNAVAILABLE"});
 expect(saved.readRecovery?.cache.map(c=>c.method)).toContain("findContactsByEmail");expect(run.attempts).toBe(1);expect(p.historyAttempts).toBe(2);expect(start).toHaveBeenCalledTimes(1);
 return {p,start,id,run,saved};
}
it("durably resumes only the missing read after restart, retaining one understanding and the same run",async()=>{
 const {p,start,id}=await scheduledReadFailure();expect(await pendingSavIntakeRuns(config)).toEqual([]);expect(await claimSavIntakeRun(id,config)).toBeNull();
 const status=await readReadRecoveryWake(id,environment);expect(status.state).toBe("scheduled");
 vi.useFakeTimers({toFake:["Date"]});try{
  vi.setSystemTime(Date.now()+31000);p.enable();
  const [a,b]=await Promise.all([analyseSavIntakeRuntime(id,config,{env:()=>environment,network:p.network,startReadRecovery:start}),analyseSavIntakeRuntime(id,config,{env:()=>environment,network:p.network,startReadRecovery:start})]);
  expect([a,b].some(r=>"state" in r&&r.state==="observed")).toBe(true);expect([a,b].some(r=>"skipped" in r&&r.skipped==="not_claimed")).toBe(true);
  const [run]=await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,id));expect(run.attempts).toBe(1);expect(run.version).toBe(1);
  expect(decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext).readRecovery).toMatchObject({state:"complete",attempts:1});
  expect(p.understandings).toBe(1);expect(p.matching).toBe(1);expect((await f.db.select().from(savIntakeModelCalls))).toHaveLength(2);
  expect(p.provider.calls.filter(c=>c.path.endsWith("/contacts/search"))).toHaveLength(2);expect(await f.db.select().from(savActions)).toHaveLength(0);
 }finally{vi.useRealTimers();}
});
it.each(["pause","source","new_message","human"])("a %s during the durable delay cannot resume or consume another understanding",async change=>{
 const {id,p}=await scheduledReadFailure();
 if(change==="pause")await f.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));
 if(change==="human")await f.db.update(savThreads).set({humanRequestedAt:new Date()}).where(eq(savThreads.id,threadId));
 if(change==="source")await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"Changed synthetic source",headers:{},attachments:[]})}).where(eq(savMessages.id,messageId));
 if(change==="new_message")await message({receivedAt:new Date(Date.now()+1)});
 vi.useFakeTimers({toFake:["Date"]});try{
  vi.setSystemTime(Date.now()+31000);
  if(change==="human")expect(await claimSavIntakeRun(id,config)).toBeNull();else expect((await readReadRecoveryWake(id,environment)).state).toBe("stopped");
  expect(p.understandings).toBe(1);const [r]=await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,id));expect(r.attempts).toBe(1);
 }finally{vi.useRealTimers();}
});
it("does not reset exhausted technical counters or create another semantic version",async()=>{
 const {id,p,start}=await scheduledReadFailure();vi.useFakeTimers({toFake:["Date"]});try{
  for(const delay of [31000,61000,121000]){vi.setSystemTime(Date.now()+delay);await analyseSavIntakeRuntime(id,config,{env:()=>environment,network:p.network,startReadRecovery:start});}
  const [run]=await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,id));expect(run.attempts).toBe(1);expect(run.version).toBe(1);
  expect(decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext).readRecovery).toMatchObject({state:"exhausted",attempts:3});
  expect(await claimSavIntakeRun(id,config)).toBeNull();expect(await pendingSavIntakeRuns(config)).toEqual([]);expect(p.understandings).toBe(1);
 }finally{vi.useRealTimers();}
});
it("twenty-one expired recoveries cannot occupy the SQL page of a new message",async()=>{
 const {saved}=await scheduledReadFailure();
 for(let n=0;n<21;n++){
  const [t]=await f.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"synthetic@example.invalid"}).returning();
  const [m]=await f.db.insert(savMessages).values({mailboxId,threadId:t.id,direction:"inbound",fromEmail:"synthetic@example.invalid",toEmails:["support@example.invalid"],gmailMessageId:randomUUID(),subject:"Synthetic",bodyCiphertext:encryptSavPayload({text:"Synthetic old fixture",attachments:[]}),receivedAt:new Date()}).returning();
  const recovery={...saved.readRecovery!,expiresAt:new Date(Date.now()-1).toISOString()};
  const [r]=await f.db.insert(savIntakeRuns).values({threadId:t.id,messageId:m.id,configHash:config.configHash,policyHash:config.policyHash,sourceHash:"synthetic",version:1,isCurrent:true,state:"waiting",attempts:2,payloadCiphertext:encryptSavPayload({...saved,readRecovery:recovery})}).returning();
  await f.db.insert(auditLogs).values({actorEmail:"system",action:"sav_intake_read_recovery",entityType:"sav_intake_read_recovery",entityId:r.id,technicalMetadata:{state:"scheduled",retryAt:new Date(0).toISOString(),expiresAt:recovery.expiresAt,configHash:config.configHash,technicalAttempts:0}});
 }
 const [t]=await f.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"synthetic@example.invalid"}).returning();
 const [m]=await f.db.insert(savMessages).values({mailboxId,threadId:t.id,direction:"inbound",fromEmail:"synthetic@example.invalid",toEmails:["support@example.invalid"],gmailMessageId:randomUUID(),subject:"Synthetic new",bodyCiphertext:encryptSavPayload({text:"New synthetic failure",attachments:[]}),receivedAt:new Date()}).returning();
 const fresh=(await enqueueSavIntakeMessage(m.id,config))!;expect(await pendingSavIntakeRuns(config)).toContainEqual({id:fresh});
 expect(await expireIntakeReadRecoveries(config)).toBe(20);expect(await pendingSavIntakeRuns(config)).toContainEqual({id:fresh});
});
it("does not persist an unqualified technical recovery at the initial checkpoint",async()=>{
 const l=await lease(),p={...payload(),readRecovery:newReadRecovery(config,l.sourceHash)};
 await checkpointSavIntakeRun(l,p);const [stored]=await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,l.run.id));
 expect(decryptSavPayload<IntakeRuntimePayload>(stored.payloadCiphertext).readRecovery).toBeUndefined();
 vi.useFakeTimers({toFake:["Date"]});try{vi.setSystemTime(Date.now()+301000);expect(await pendingSavIntakeRuns(config)).toContainEqual({id:l.run.id});const resumed=await claimSavIntakeRun(l.run.id,config);expect(resumed?.run.attempts).toBe(2);await failSavIntakeRun(resumed!,payload());expect(await pendingSavIntakeRuns(config)).toEqual([]);}finally{vi.useRealTimers();}
});
it("bounds duplicate workflow starts and leaves a failed start durable",async()=>{
 const {id}=await scheduledReadFailure();
 vi.useFakeTimers({toFake:["Date"]});try{
  vi.setSystemTime(Date.now()+121000);const fail=vi.fn(async()=>{throw Error("Synthetic start failure");});
  const result=await requestReadRecoveryWake(id,{env:environment,start:fail});expect(result.reason).toBe("start_deferred");
  expect((await readSavIntakeCurrent(threadId,config))?.payload.readRecovery?.state).toBe("scheduled");
  const duplicate=vi.fn(async()=>({}));await Promise.all([requestReadRecoveryWake(id,{env:environment,start:duplicate}),requestReadRecoveryWake(id,{env:environment,start:duplicate})]);expect(duplicate).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});

it.each([false,true])("permits read-only recovery at the daily cap but refuses any new model dispatch (matching=%s)",async matching=>{
 operational();const {id,p,start}=await scheduledReadFailure();
 await f.db.insert(savIntakeModelCalls).values(Array.from({length:299},(_,i)=>({messageKey:intakeRuntimeHash(`other-cap-${i}`),requestHash:intakeRuntimeHash(`other-request-${i}`),state:"settled",reservedNanoUsd:817152000,chargedNanoUsd:262500,payloadCiphertext:encryptSavPayload({metadata:{inputTokens:100,outputTokens:50,thoughtTokens:0,totalTokens:150}}),createdAt:new Date()})));
 if(!matching)p.provider.setContacts([]);p.enable();vi.useFakeTimers({toFake:["Date"]});try{
  vi.setSystemTime(Date.now()+61000);await analyseSavIntakeRuntime(id,config,{env:()=>environment,network:p.network,startReadRecovery:start});
  const [r]=await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,id));expect(r.attempts).toBe(1);
  const saved=decryptSavPayload<IntakeRuntimePayload>(r.payloadCiphertext);expect(saved.readRecovery?.attempts).toBe(1);
  expect(p.understandings).toBe(1);expect(p.matching).toBe(0);expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(300);
  if(matching)expect(saved.reason).toBe("SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED");else expect(saved.plan?.decision.evidence.some(e=>e.id==="email-lookup")).toBe(true);
 }finally{vi.useRealTimers();}
});
it("simple pipeline: a resumed read reuses the accepted analysis and gives the focused call the accepted requests (review P2)",async()=>{
 await f.db.insert(savSyncState).values({key:"sav-intake-console-schema-v1",status:"installed"}).onConflictDoUpdate({target:savSyncState.key,set:{status:"installed"}});
 environment={...environment,SAV_INTAKE_EVENT_DISPATCH:"on",SAV_INTAKE_PIPELINE:"simple"};config=savIntakeRuntimeConfig(environment)!;
 const provider=executionProvider("synthetic@example.invalid");provider.seedTicket({ownerId:"301"});
 provider.objects.notes["401"]={id:"401",properties:{hs_note_body:"Synthetic complete investigation",hs_timestamp:new Date(Date.now()-86400000).toISOString()}};
 provider.links.set("tickets:201:notes",["401"]);
 let failures=true;const bodies:{phase:string;decided?:unknown[]}[]=[];
 const network:typeof fetch=async(url,init)=>{
  if(String(url).startsWith("https://generativelanguage.googleapis.com/")){
   const data=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
   bodies.push({phase:data.decidedRequests?"focused":"understanding",decided:data.decidedRequests});
   const tickets=(data.tickets as {ticketId:string}[]).map(t=>({ticketId:t.ticketId,relation:"same",why:"Même connexion.",sourceIds:["current",`ticket-${t.ticketId}`]}));
   const contacts=data.contacts as {contactId:string}[];
   const answer={messageId,nature:"request",requests:data.decidedRequests?[]:[{id:"r1",kind:"support",summary:"La connexion ne marche plus.",sourceIds:["current"]}],
    ticketTitle:"Connexion synthétique interrompue",ticketDescription:"La connexion ne marche plus.",
    identity:contacts.length===1?{kind:"unique",contactIds:[contacts[0].contactId],why:"Expéditeur."}:{kind:"unknown",contactIds:[],why:"Aucune."},tickets,missing:[],rationale:"Même problème."};
   return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(answer)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,thoughtsTokenCount:0,totalTokenCount:150}});
  }
  if(new URL(String(url)).pathname.endsWith("/notes/batch/read")&&failures)throw TypeError("Synthetic transient connection failure");
  return provider.network(url,init);
 };
 const start=vi.fn(async()=>({runId:"synthetic-workflow"})),id=(await enqueueSavIntakeMessage(messageId,config))!;
 expect(await analyseSavIntakeRuntime(id,config,{env:()=>environment,network,startReadRecovery:start})).toHaveProperty("state","waiting");
 const saved=decryptSavPayload<IntakeRuntimePayload>((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,id)))[0].payloadCiphertext);
 expect(saved.pipeline).toBe("simple");expect(saved.readRecovery).toMatchObject({state:"scheduled"});
 vi.useFakeTimers({toFake:["Date"]});try{
  vi.setSystemTime(Date.now()+31000);failures=false;
  const resumed=await analyseSavIntakeRuntime(id,config,{env:()=>environment,network,startReadRecovery:start});
  expect(resumed).toHaveProperty("state","observed");
  // One understanding only; the resumed reader's focused call carries the accepted requests.
  expect(bodies.filter(b=>b.phase==="understanding")).toHaveLength(1);
  expect(bodies.at(-1)).toMatchObject({phase:"focused",decided:[{id:"r1",kind:"support"}]});
  const plan=(await readSavIntakeCurrent(threadId,config))?.payload.plan;
  expect(plan?.decision.disposition).toMatchObject({kind:"ticket",target:{operation:"link",ticketId:"201"}});
  expect((await f.db.select().from(savIntakeModelCalls)).every(r=>r.state==="settled")).toBe(true);
  expect(await f.db.select().from(savActions)).toHaveLength(0);
 }finally{vi.useRealTimers();}
});

// Independent review: a batch preflight must admit the exact scheduled retry envelope.
import { createIntakeModelDispatcher } from "./model-dispatch";
import { savGeminiWireBody } from "../gemini-transport";
it("REVIEW scheduled grouped matching retry is admitted by the same preflight", async () => {
  const l = await lease();
  const input: Parameters<import("./model-readers").IntakeGeminiCall>[0] = { model: config.model, phase: "ticket_matching" as const, promptRevision: "synthetic", signal: AbortSignal.timeout(10000), allowRetry: false as const,
    body: { systemInstruction: {parts:[{text:"Synthetic review only"}]}, contents: [{ role: "user", parts: [{ text: "synthetic matching group" }] }], generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" } } };
  const first = await reserveSavIntakeCall(l, config, intakeRuntimeHash(savGeminiWireBody(input).body));
  expect(await settleSavIntakeCall(first.id, undefined, undefined, 503)).toBe(true);
  const d = createIntakeModelDispatcher({ config, retryOrdinal: 1, live: async () => {}, signal: input.signal,
    reserve: h => reserveSavIntakeCall(l, config, h), preflight: hashes => assertSavIntakeCallPlan(messageId,config,hashes),
    env: () => environment, network: async () => { throw Error("NETWORK_FORBIDDEN"); } });
  await expect(d.plan([input, { ...input, body: { ...input.body, contents: [{ role: "user", parts: [{ text: "second matching group" }] }] } }])).resolves.toBeUndefined();
});

it("REVIEW grouped preflight rejects two new calls when the current version has only one left", async () => {
  const l = await lease();
  for(let n=0;n<SAV_INTAKE_CALL_POLICY.perVersion-1;n++) {
    const r=await reserveSavIntakeCall(l,config,intakeRuntimeHash(`used-${n}`));
    await settleSavIntakeCall(r.id,usage,{json:{cached:true},metadata:usage});
  }
  await expect(assertSavIntakeCallPlan(messageId,config,[intakeRuntimeHash("next-1"),intakeRuntimeHash("next-2")])).rejects.toThrow("BUDGET_EXHAUSTED");
});

// Current reader, grouped ticket comparison: one group succeeds, the other gets a received 503.
// The retry reuses the successful group from cache and dispatches only the refused one.
import { createSavIntakeSemanticReaders } from "./model-readers";
function uniqueText(seed: number, size: number) { return Array.from({ length: size }, (_, i) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return i % 12 === 11 ? " " : String.fromCharCode(97 + (seed >>> 8) % 26); }).join("") + " FIN"; }
it.each([["without", false], ["with", true]] as const)("current reader: a grouped comparison retried after one group's 503 (%s deployment) keeps the cached group and redispatches only the refused one", async (_, redeploy) => {
  const at = new Date(Date.now() - 3600_000).toISOString(), mid = messageId;
  const message = { id: mid, threadId, receivedAt: at, fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"], direction: "inbound" as const, currentText: "La synchronisation échoue encore.", contentComplete: true };
  // Two tickets whose citation catalogues together exceed one call: the reader plans two groups.
  const tickets = ["201", "202"].map((id, i) => ({ ticket: { id, contactIds: ["101"], stage: "open" as const, createdAt: at, ownerId: null, subject: `Ticket ${id}`, content: "Synchronisation" },
    history: [{ id: `note-${id}`, kind: "note" as const, at, text: uniqueText(500 + i, 270_000) }] }));
  const input = { message, requests: [{ id: "r1", kind: "support" as const, currentMessageId: mid }], tickets,
    evidence: ["current", ...tickets.flatMap(t => [`ticket-${t.ticket.id}`, `history-${t.ticket.id}`])].map(id => ({ id, sourceId: id, observedAt: at, contentHash: "a".repeat(43), source: "crm_ticket" as const })) } as never;
  let gemini = 0; const refuse = new Set<number>([2]);
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    gemini++;
    if (refuse.has(gemini)) return new Response("{}", { status: 503 });
    const d = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text) as { tickets: { ticket: { id: string } }[]; citationCatalogue: { id: string; sourceId: string }[] };
    const answer = { investigationComplete: true, tickets: d.tickets.map(({ ticket }) => ({ ticketId: ticket.id, relation: "same", requestIds: ["r1"], evidenceIds: ["current", `ticket-${ticket.id}`, `history-${ticket.id}`], rationale: "Même problème.",
      grounding: ["current", `ticket-${ticket.id}`, `history-${ticket.id}`].map(source => ({ quoteId: d.citationCatalogue.find(e => e.sourceId === source)!.id })) })) };
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 1050 } });
  });
  const pass = async (cfg: IntakeRuntimeConfig, env: Record<string, string | undefined>) => {
    const id = (await enqueueSavIntakeMessage(mid, cfg))!, l = (await claimSavIntakeRun(id, cfg))!;
    const d = createIntakeModelDispatcher({ config: cfg, live: async () => {}, signal: AbortSignal.timeout(30_000), reserve: h => reserveSavIntakeCall(l, cfg, h),
      preflight: hashes => assertSavIntakeCallPlan(mid, cfg, hashes), env: () => env, network });
    const reader = createSavIntakeSemanticReaders({ model: cfg.model, call: d.call, planCalls: d.plan });
    try { return await reader.assessIssues(input, AbortSignal.timeout(30_000)); }
    catch (error) { await Promise.allSettled(d.pending); return error as Error; }
    finally { await f.db.update(savIntakeRuns).set({ leaseToken: null, leaseUntil: null, state: "waiting" }).where(eq(savIntakeRuns.id, l.run.id)); }
  };
  const first = await pass(config, environment);
  expect(first).toBeInstanceOf(Error);
  expect(gemini).toBe(2);
  let ledger = await f.db.select().from(savIntakeModelCalls);
  expect(ledger.map(r => [r.state, r.chargedNanoUsd > 0, Boolean(r.resultCiphertext)]).sort()).toEqual([["settled", false, false], ["settled", true, true]].sort());
  const nextEnv = redeploy ? { ...environment, SAV_CODE_REVISION: "b".repeat(40), SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!), codeRevision: "b".repeat(40) }) } : environment;
  const second = await pass(savIntakeRuntimeConfig(nextEnv)!, nextEnv);
  expect(second).toMatchObject({ investigationComplete: true, tickets: [{ ticketId: "201", relation: "same" }, { ticketId: "202", relation: "same" }] });
  // Only the refused group is dispatched again, under a new, separately reserved row.
  expect(gemini).toBe(3);
  ledger = await f.db.select().from(savIntakeModelCalls);
  expect(ledger).toHaveLength(3); expect(new Set(ledger.map(r => r.requestHash)).size).toBe(3);
  expect(ledger.filter(r => r.resultCiphertext)).toHaveLength(2); expect(ledger.filter(r => r.chargedNanoUsd === 0)).toHaveLength(1);
}, 60_000);

it("REVIEW a rolling budget deferral must not promise tomorrow's daily reset",async()=>{
 operational();
 environment={...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),maxRollingNanoUsd:1000000000})};
 config=savIntakeRuntimeConfig(environment)!;
 const u={inputTokens:400000,outputTokens:50,thoughtTokens:0,totalTokens:400050};
 await f.db.insert(savIntakeModelCalls).values({messageKey:intakeRuntimeHash("older"),requestHash:intakeRuntimeHash("older-body"),state:"settled",reservedNanoUsd:817152000,chargedNanoUsd:300187500,payloadCiphertext:encryptSavPayload({metadata:u}),createdAt:new Date(Date.now()-86400000)});
 const id=(await enqueueSavIntakeMessage(messageId,config))!;
 expect(await claimSavIntakeRun(id,config)).toBeNull();
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.parse(new Date().toISOString().slice(0,10)+"T00:00:00Z")+86400000));
 try{expect(await claimSavIntakeRun(id,config)).toBeNull();expect((await readSavIntakeCurrent(threadId,config))?.payload.reason).not.toBe("SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED");}finally{vi.useRealTimers();}
});
