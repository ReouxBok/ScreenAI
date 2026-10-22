import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState, savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savIntakeJournal, savActions, savDecisions, auditLogs } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, SAV_INTAKE_RUNTIME_REVISION, type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { assertSavIntakeLease, catchupSavIntake, claimSavIntakeRun, enqueueSavIntakeMessage, failSavIntakeRun, readSavIntakeBudget, readSavIntakeCurrent, reserveSavIntakeCall, saveSavIntakeResult, settleSavIntakeCall } from "./runtime-store";
import { analyseSavIntakeRuntime, enqueueConfiguredSavIntake, reconcileSavIntakeRuntime } from "./runtime";

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
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
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
it("retains unknown usage, refuses refunds/replay and settles a late response without publishing", async () => {
  const l = await lease(), r = await reserveSavIntakeCall(l, config, "a".repeat(64));
  await failSavIntakeRun(l, payload()); expect(await settleSavIntakeCall(r.id, usage)).toBe(true); expect((await readSavIntakeCurrent(threadId, config))?.state).toBe("waiting");
  const second = (await claimSavIntakeRun(l.run.id, config))!; const u = await reserveSavIntakeCall(second, config, "b".repeat(64));
  expect(await settleSavIntakeCall(u.id, { ...usage, thoughtTokens: undefined })).toBe(false); expect(await settleSavIntakeCall(u.id, usage)).toBe(false);
  await expect(reserveSavIntakeCall(second, config, "c".repeat(64))).rejects.toThrow("USAGE_UNCERTAIN"); expect((await readSavIntakeBudget(config)).chargedNanoUsd).toBe(817_414_500);
});
it("global cap and three-per-message bound survive config changes and run deletion", async () => {
  const l = await lease();
  for (let n = 0; n < 3; n++) { const r = await reserveSavIntakeCall(l, config, String(n).repeat(64)); await settleSavIntakeCall(r.id, usage, { json: { syntheticPrivate: true }, metadata: usage }); }
  await expect(reserveSavIntakeCall(l, config, "f".repeat(64))).rejects.toThrow("BUDGET_EXHAUSTED");
  await f.db.delete(savIntakeRuns).where(eq(savIntakeRuns.id, l.run.id));
  expect((await readSavIntakeBudget(config)).callCount).toBe(3); expect((await f.db.select().from(savIntakeModelCalls)).every(r => r.runId === null && r.resultCiphertext === null)).toBe(true);
  const id = await enqueueSavIntakeMessage(messageId, config), next = (await claimSavIntakeRun(id!, config))!;
  await expect(reserveSavIntakeCall(next, config, "e".repeat(64))).rejects.toThrow("BUDGET_EXHAUSTED");
});
it("monetary exhaustion is explicit technical waiting and never uses other ledgers", async () => {
  const constrained = { ...config, maxNanoUsd: 1 }, id = await enqueueSavIntakeMessage(messageId, constrained);
  const network = vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); });
  const response = await analyseSavIntakeRuntime(id!, constrained, { env: () => environment, network });
  expect(response.state).toBe("waiting"); expect(network).not.toHaveBeenCalled();
  expect((await readSavIntakeCurrent(threadId, constrained))?.payload.reason).toBe("SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED"); expect(await f.db.select().from(auditLogs)).toHaveLength(0);
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
it.each(["create", "link", "reopen"])("persists a grounded %s plan from stored mail with no writer", async operation => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const edge = (id: string) => ({ toObjectId: id, associationTypes: [{ typeId: 1, category: "HUBSPOT_DEFINED" }] });
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.contents[0].parts[0].text), catalogue = data.citationCatalogue as {id:string;sourceId:string}[];
      const answer = !data.tickets ? { messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId: catalogue.find(x => x.sourceId === "current")!.id }],
        ticketSummary: { title: "Connexion fictive en panne", description: "La connexion fictive ne marche plus.", requestIds: ["r1"] } }
        : { investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r1"], evidenceIds: ["current", "ticket-201", "history-201"],
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
  const current = await readSavIntakeCurrent(threadId, config); expect({result, payload:current?.payload}).toMatchObject({ result: { state: "observed" }});
  expect(current?.payload.plan?.decision.disposition).toMatchObject({ kind: "ticket", target: { operation } });
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
it.each(["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount"].flatMap(counter => ["valid_json", "invalid_json"].map(output => ({ counter, output }))))("keeps missing $counter uncertain through provider $output", async ({ counter, output }) => {
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
it("operational profile still enforces three durable calls per message and rejects a future ledger timestamp",async()=>{
  operational();const l=await lease();
  for(let n=0;n<3;n++) {const call=await reserveSavIntakeCall(l,config,`call-${n}`);expect(await settleSavIntakeCall(call.id,{inputTokens:100,outputTokens:50,thoughtTokens:0,totalTokens:150})).toBe(true);}
  await expect(reserveSavIntakeCall(l,config,"fourth")).rejects.toThrow("BUDGET_EXHAUSTED");
  await f.db.update(savIntakeModelCalls).set({createdAt:new Date(Date.now()+60000)});
  await expect(readSavIntakeBudget(config)).rejects.toThrow("CLOCK_REJECTED");
});

it("daily quota deferral consumes no attempt and a fresh UTC day can claim the same waiting run",async()=>{
  operational();const id=(await enqueueSavIntakeMessage(messageId,config))!;
  await f.db.insert(savIntakeModelCalls).values(Array.from({length:300},(_,i)=>({messageKey:intakeRuntimeHash(`prior-${i}`),requestHash:intakeRuntimeHash(`request-${i}`),state:"settled",reservedNanoUsd:817152000,chargedNanoUsd:262500,payloadCiphertext:encryptSavPayload({metadata:{inputTokens:100,outputTokens:50,thoughtTokens:0,totalTokens:150}}),createdAt:new Date()})));
  expect(await claimSavIntakeRun(id,config)).toBeNull();expect(await claimSavIntakeRun(id,config)).toBeNull();
  expect((await readSavIntakeCurrent(threadId,config))?.attempts).toBe(0);
  expect((await readSavIntakeCurrent(threadId,config))?.payload.reason).toBe("SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED");
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
  if(kind==="budget")await f.db.insert(savIntakeModelCalls).values(Array.from({length:3},(_,i)=>({runId:id,messageKey:intakeRuntimeHash(messageId),requestHash:`previous-${i}`,state:"settled",reservedNanoUsd:817152000,chargedNanoUsd:262500,payloadCiphertext:encryptSavPayload({metadata:usage})})));
  const network=vi.fn(async()=>{throw Error("NETWORK_FORBIDDEN");});
  await analyseSavIntakeRuntime(id,config,{env:()=>environment,network,downloadAttachments:async()=>bytes});
  const current=(await readSavIntakeCurrent(threadId,config))!,read=current.payload.attachments!.read,display=savAttachmentDisplayRead(read)!;
  expect(read.state).toBe("complete");expect(read.completedAt).toBeTruthy();expect(current.state).toBe("waiting");
  expect(display.observations.at(-1)?.reason).toBe(kind==="pdf"?"unsupported_type":kind==="image_limit"?"image_limit":"budget_exhausted");
  expect(display.observations.every(o=>!["in_progress","outcome_uncertain"].includes(o.reason))).toBe(true);
  if(kind==="image_limit")expect(display.observations.slice(0,3).every(o=>o.reason==="context_incomplete")).toBe(true);
  expect(network).not.toHaveBeenCalled();expect(await f.db.select().from(savActions)).toHaveLength(0);
});
