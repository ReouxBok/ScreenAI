import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { auditLogs, savMailboxes, savThreads, savMessages, staffUsers, savIntakeExecutions, savIntakeExecutionBudget, savIntakeModelCalls, savIntakeRuns, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown, start: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
vi.mock("workflow/api", () => ({ start: state.start }));
vi.mock("@/workflows/sav-intake", () => ({ processSavIntakeWakeWorkflow: vi.fn() }));
import { encryptSavPayload } from "../crypto";
import { SAV_EXTERNAL_COMPLETION } from "../external-completion";
import { savIntakeRuntimeConfig, intakeRuntimeHash, type IntakeRuntimeConfig } from "./runtime-contract";
import { SAV_INTAKE_OPERATIONAL_PROFILE } from "./budget-profile";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, readIntakeExecutionAuthority, revokeIntakeExecutionPolicy, type ExecutionPolicy } from "./execution-policy";
import { enqueueSavIntakeMessage, pendingSavIntakeRuns, readSavIntakeBudget } from "./runtime-store";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import { admitIntakeExecution, getExecutionEffects } from "./execution-store";
import { enqueueConfiguredSavIntake } from "./runtime";
import { dispatchPendingSavIntakeWakes, readSavIntakeWake, requestSavIntakeWake, savIntakeWakeStage, SAV_INTAKE_WAKE_MAX_DISPATCHES } from "./event-dispatch";
import { analyseSavIntakeWake, executeSavIntakeWake, processSavIntakeWake, type SavIntakeWakeDeps } from "./event-pipeline";
import type { ExecutorAdapters } from "./execution-types";

let f: Awaited<ReturnType<typeof createSavTestDb>>, p: ReturnType<typeof executionProvider>, environment: Record<string, string | undefined>;
let runtime: IntakeRuntimeConfig, adapters: ExecutorAdapters, mailboxId: string, threadId: string, messageId: string, policyId: string;
let profile: "qualification" | "operational" = "qualification", modelHits = 0;
const known = new Set<string>();
const mutations: ExecutionPolicy["mutations"] = ["create_ticket", "link_ticket", "set_ticket_new", "append_ticket_note", "associate_email", "send_identity_template"];
const template = "SYNTHETIC exact template.\nSignature kept exactly.";
const customer = "customer@example.invalid", subject = "Synthetic connection failure", body = "The synthetic connection fails.";
const ticketPosts = () => p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets")).length;
const later = (ms: number) => new Date(Date.now() + ms);
const ledger = () => f.db.select().from(savIntakeModelCalls);

/** Synthetic Gemini behind the real transport, ledger reservation and settlement.
 * Every other request goes to the in-memory HubSpot provider (reads only here). */
const network: typeof fetch = async (url, init) => {
  if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
    modelHits++;
    const text = JSON.parse(String(init?.body)).contents[0].parts[0].text as string, data = JSON.parse(text);
    const mid = [...known].find(id => text.includes(id))!, catalogue = data.citationCatalogue as { id: string; sourceId: string }[];
    const answer = { messageId: mid, requests: [{ id: "r1", kind: "support", currentMessageId: mid, quoteId: catalogue.find(x => x.sourceId === "current")!.id }],
      ticketSummary: { title: "Panne de connexion fictive", description: "La connexion fictive ne marche plus.", requestIds: ["r1"] } };
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
  }
  return p.network(url, init);
};
const deps = (over: Partial<SavIntakeWakeDeps> = {}): SavIntakeWakeDeps => ({ env: () => environment, network, adapters, ...over });
const stubEnvironment = () => { for (const [k, v] of Object.entries(environment)) vi.stubEnv(k, v ?? ""); };
const run = async (id: string) => (await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id)))[0];
const logged = () => JSON.stringify([...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls]);
async function storedMessage(thread = threadId, options: { at?: Date; mailbox?: string; createdAt?: Date } = {}) {
  const [m] = await f.db.insert(savMessages).values({ threadId: thread, mailboxId: options.mailbox ?? mailboxId, direction: "inbound", gmailMessageId: randomUUID(), fromEmail: customer,
    toEmails: ["support@example.invalid"], subject, bodyCiphertext: encryptSavPayload({ text: body, headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }),
    receivedAt: options.at ?? new Date(), ...(options.createdAt ? { createdAt: options.createdAt } : {}) }).returning();
  known.add(m.id); return m;
}
const woken = (id: string) => requestSavIntakeWake(id, { env: environment, start: state.start });
const lossy = (kind: string): ExecutorAdapters => { let lose = true; return { ...adapters, dispatch: async (intent, signal) => {
  const result = await adapters.dispatch(intent, signal);
  if (lose && intent.kind === kind) { lose = false; throw Error("SAV_SYNTHETIC_RESPONSE_LOST"); }
  return result;
} }; };

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
afterAll(async () => { await f?.client.close(); });
async function setup() {
  await f.client.exec("TRUNCATE sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies,sav.intake_model_calls,sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; UPDATE sav.intake_execution_budget SET admitted=0; DELETE FROM sav.sync_state WHERE key='sav-intake-execution-scan-v1'");
  await f.db.insert(savSyncState).values({ key: "sav-intake-execution-schema-v1", status: "installed" }).onConflictDoNothing();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "ugo@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
  state.user = { id: admin.clerkId, primaryEmailAddress: { emailAddress: admin.email, verification: { status: "verified" } } };
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: "gmail-thread", customerEmail: customer }).returning())[0].id;
  known.clear(); messageId = (await storedMessage()).id;
  const ref = { resourceId: "synthetic-template", revisionId: "v1", sha256: createHash("sha256").update(template).digest("hex") };
  const catalogue = [{ resource: ref, text: template, approvalId: "synthetic-approval", approvedBy: "synthetic-admin", approvedAt: new Date(Date.now() - 1000).toISOString(), status: "approved" }];
  const enginePolicy = { relationRevision: "synthetic-relations", admittedRelations: [{ category: "HUBSPOT_DEFINED", typeId: 449 }], resources: { identification: ref, registrationNotFound: ref } };
  const operational = profile === "operational" ? { budgetProfile: SAV_INTAKE_OPERATIONAL_PROFILE, maxRollingNanoUsd: 90_000_000_000 } : {};
  environment = { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake", HUBSPOT_ACCESS_TOKEN: "fake",
    SAV_ENCRYPTION_KEY_V1: process.env.SAV_ENCRYPTION_KEY_V1, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(enginePolicy), SAV_INTAKE_RUNTIME_RESOURCES: JSON.stringify(catalogue),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId, createdAfter: new Date(Date.now() - 10000).toISOString(), receivedAfter: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(enginePolicy), resourcesHash: intakeRuntimeHash(catalogue), maxCalls: 30, maxNanoUsd: 3000000000, ...operational }) };
  runtime = savIntakeRuntimeConfig(environment)!;
  const policy: ExecutionPolicy = { revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: runtime.codeRevision, enginePolicyHash: runtime.policyHash, resourcesHash: runtime.resourcesHash,
    createdAfter: runtime.createdAfter, receivedAfter: runtime.receivedAfter, expiresAt: runtime.expiresAt, maxDossiers: 10, mutations, admission: { kind: "automatic" },
    ...(profile === "operational" ? { budgetProfile: SAV_INTAKE_OPERATIONAL_PROFILE } : {}) };
  const grant = await approveIntakeExecutionPolicy(policy); policyId = grant.id;
  environment = { ...environment, SAV_INTAKE_EVENT_DISPATCH: "on", SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash };
  p = executionProvider();
  p.setGmail((await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].gmailMessageId!, "gmail-thread");
  adapters = createIntakeExecutorAdapters({ network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment });
}
beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters");
  state.start.mockReset(); state.start.mockResolvedValue({ runId: "wrun_synthetic" }); modelHits = 0; profile = "qualification";
  await setup();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("is OFF unless SAV_INTAKE_EVENT_DISPATCH=on; once on it starts after the run commit", async () => {
  stubEnvironment(); vi.stubEnv("SAV_INTAKE_EVENT_DISPATCH", "");
  const off = await enqueueConfiguredSavIntake(messageId) as { runId: string };
  expect(state.start).not.toHaveBeenCalled(); expect(await readSavIntakeWake(off.runId)).toBeNull();
  for (const value of ["true", "1", "ON"]) expect(await requestSavIntakeWake(off.runId, { env: { ...environment, SAV_INTAKE_EVENT_DISPATCH: value } })).toMatchObject({ reason: "event_dispatch_off" });
  vi.stubEnv("SAV_INTAKE_EVENT_DISPATCH", "on");
  const seen: (string | undefined)[] = [];
  state.start.mockImplementation(async (_workflow: unknown, [id]: [string]) => { seen.push((await run(id))?.state); });
  expect(await requestSavIntakeWake(off.runId)).toMatchObject({ dispatched: true, stage: "analysis" });
  expect(state.start.mock.calls[0][1]).toEqual([off.runId]); expect(seen).toEqual(["pending"]);
});

it("runs the real runtime with simulated providers: one model call settled, full confirmation, id-only logs", async () => {
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!; await woken(id);
  const result = await processSavIntakeWake(id, deps());
  expect(result.analysis.state).toBe("observed"); expect(result.execution).toMatchObject({ state: "confirmed" });
  expect(modelHits).toBe(1);
  expect((await ledger()).map(r => r.state)).toEqual(["settled"]);
  expect((await readSavIntakeBudget(runtime)).callCount).toBe(1);
  expect(ticketPosts()).toBe(1);
  expect(result.timings).toMatchObject({ startToAnalysedMs: expect.any(Number), analysedToConfirmedMs: expect.any(Number) });
  expect(logged()).toContain("\"fullyConfirmed\":true");
  expect(logged()).not.toMatch(/customer@example\.invalid|Synthetic connection|synthetic connection fails|connexion fictive/i);
});

it("duplicating the same event during processing: one analysis, one effect", async () => {
  stubEnvironment();
  const a = await enqueueConfiguredSavIntake(messageId) as { runId: string }, b = await enqueueConfiguredSavIntake(messageId) as { runId: string };
  expect(b.runId).toBe(a.runId); expect(state.start).toHaveBeenCalledTimes(1);
  await Promise.all([processSavIntakeWake(a.runId, deps()), processSavIntakeWake(a.runId, deps()), processSavIntakeWake(a.runId, deps())]);
  expect(modelHits).toBe(1); expect(await ledger()).toHaveLength(1);
  expect(ticketPosts()).toBe(1); expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(1);
  expect((await run(a.runId)).attempts).toBe(1);
});

it("interruption after an observed analysis resumes admission without any model call", async () => {
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!;
  expect((await analyseSavIntakeWake(id, deps())).state).toBe("observed"); // process dies here
  expect(await savIntakeWakeStage(id)).toBe("admission");
  expect(await dispatchPendingSavIntakeWakes({ env: environment, start: state.start })).toEqual({ dispatched: 1 });
  expect(state.start.mock.calls[0][0]).toBe(id);
  const resumed = await processSavIntakeWake(id, deps());
  expect(resumed.analysis).toMatchObject({ state: "done", reason: "admission" });
  expect(resumed.execution).toMatchObject({ state: "confirmed" });
  expect(modelHits).toBe(1); expect(await ledger()).toHaveLength(1); expect(ticketPosts()).toBe(1);
});

it("interruption after admission resumes that same execution, without a new admission", async () => {
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!;
  await analyseSavIntakeWake(id, deps());
  const config = intakeExecutionConfig(environment)!, { policy } = await readIntakeExecutionAuthority(config);
  const admitted = (await admitIntakeExecution(id, { runtime, policy, config, env: () => environment, adapters, signal: AbortSignal.timeout(30000) }))!; // process dies here
  expect(await savIntakeWakeStage(id)).toBe("execution");
  expect(await dispatchPendingSavIntakeWakes({ env: environment, start: state.start })).toEqual({ dispatched: 1 });
  const resumed = await processSavIntakeWake(id, deps());
  expect(resumed.execution).toMatchObject({ state: "confirmed" });
  const executions = await f.db.select().from(savIntakeExecutions);
  expect(executions.map(e => e.id)).toEqual([admitted.id]);
  expect((await f.db.select().from(savIntakeExecutionBudget))[0].admitted).toBe(1);
  expect(modelHits).toBe(1); expect(ticketPosts()).toBe(1);
  // Confirmed: no durable work, no wake, no model call.
  expect(await savIntakeWakeStage(id)).toBeNull();
  expect(await requestSavIntakeWake(id, { env: environment, start: state.start, now: later(600_000) })).toMatchObject({ dispatched: false, reason: "no_durable_work" });
  expect((await processSavIntakeWake(id, deps())).execution).toBeNull();
  expect(modelHits).toBe(1); expect(ticketPosts()).toBe(1);
});

it("an uncertain effect is reconciled on resume, never re-sent", async () => {
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!;
  const first = await processSavIntakeWake(id, deps({ adapters: lossy("ticket_create") }));
  expect(first.execution?.state).toBe("uncertain"); expect(ticketPosts()).toBe(1);
  expect(first.timings?.analysedToConfirmedMs).toBeNull();
  expect(await savIntakeWakeStage(id)).toBe("execution");
  const again = await executeSavIntakeWake(id, deps());
  expect(["uncertain", "waiting", "confirmed"]).toContain(again.state);
  expect(ticketPosts()).toBe(1); expect(modelHits).toBe(1);
  const execution = (await f.db.select().from(savIntakeExecutions))[0];
  expect((await getExecutionEffects(execution.id)).filter(e => e.kind === "ticket_create")).toHaveLength(1);
});

it("a partial confirmation never reports a full confirmation metric", async () => {
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!;
  await woken(id);
  const result = await processSavIntakeWake(id, deps({ adapters: lossy("email_associate") }));
  const effects = await getExecutionEffects((await f.db.select().from(savIntakeExecutions))[0].id);
  expect(effects.find(e => e.kind === "ticket_create")?.state).toBe("confirmed");
  expect(effects.find(e => e.kind === "email_associate")?.state).not.toBe("confirmed");
  expect(result.execution?.state).not.toBe("confirmed");
  expect(result.timings?.analysedToConfirmedMs).toBeNull();
  expect(logged()).toContain("\"fullyConfirmed\":false");
});

it("pause, revocation, newer message and external handling are refused", async () => {
  // Pause: claim refuses, no model call, attempts untouched.
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!;
  await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
  expect((await processSavIntakeWake(id, deps())).analysis.state).not.toBe("observed");
  expect(modelHits).toBe(0); expect((await run(id)).attempts).toBe(0);
  await f.db.update(savThreads).set({ aiPaused: false }).where(eq(savThreads.id, threadId));
  // External handling: the directly imported canonical reader fences the wake.
  await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: SAV_EXTERNAL_COMPLETION, entityType: "sav_message", entityId: messageId,
    technicalMetadata: { version: 1, threadId, batchId: randomUUID(), receivedBefore: later(60_000).toISOString(), reason: "processed_outside_studio" } });
  expect(await analyseSavIntakeWake(id, deps())).toMatchObject({ state: "skipped", reason: "external_completion" });
  expect(await analyseSavIntakeWake(id, deps({ readExternalCompletion: undefined }))).toMatchObject({ state: "skipped", reason: "external_completion" });
  await f.db.delete(auditLogs).where(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION));
  expect(modelHits).toBe(0);
  // Revocation after analysis: no admission, no effect.
  expect((await analyseSavIntakeWake(id, deps())).state).toBe("observed");
  await revokeIntakeExecutionPolicy(policyId, "synthetic revocation for the event test");
  expect(await executeSavIntakeWake(id, deps())).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_EXECUTION_PERMISSION_REVOKED" });
  expect(ticketPosts()).toBe(0);
  // Newer inbound: the old run is fenced, then superseded and never woken.
  await setup();
  const old = (await enqueueSavIntakeMessage(messageId, runtime))!;
  expect((await analyseSavIntakeWake(old, deps())).state).toBe("observed");
  const newer = await storedMessage(threadId, { at: later(1000), createdAt: later(1000) });
  expect((await executeSavIntakeWake(old, deps())).state).not.toBe("confirmed");
  await enqueueSavIntakeMessage(newer.id, runtime);
  expect(await requestSavIntakeWake(old, { env: environment, start: state.start })).toMatchObject({ reason: "no_durable_work" });
  expect(ticketPosts()).toBe(0);
});

it("historical and other-mailbox messages are never woken", async () => {
  stubEnvironment();
  const historical = await storedMessage(threadId, { createdAt: new Date(Date.parse(runtime.createdAfter) - 1000), at: later(1000) });
  expect(await enqueueConfiguredSavIntake(historical.id)).not.toMatchObject({ runId: expect.any(String) });
  const otherMailbox = (await f.db.insert(savMailboxes).values({ email: "other@example.invalid" }).returning())[0].id;
  const otherThread = (await f.db.insert(savThreads).values({ mailboxId: otherMailbox, gmailThreadId: "other", customerEmail: customer }).returning())[0].id;
  expect(await enqueueConfiguredSavIntake((await storedMessage(otherThread, { mailbox: otherMailbox })).id)).not.toMatchObject({ runId: expect.any(String) });
  expect(state.start).not.toHaveBeenCalled();
});

it("wake bound is separate from business retries and never blocks the cron fallback", async () => {
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!;
  let at = Date.now(), dispatched = 0;
  for (let i = 0; i < SAV_INTAKE_WAKE_MAX_DISPATCHES + 2; i++) { at += 150_000; if ((await requestSavIntakeWake(id, { env: environment, start: state.start, now: new Date(at) })).dispatched) dispatched++; }
  expect(dispatched).toBe(SAV_INTAKE_WAKE_MAX_DISPATCHES);
  expect((await readSavIntakeWake(id))?.technicalMetadata.state).toBe("abandoned");
  expect((await run(id)).attempts).toBe(0);
  expect((await pendingSavIntakeRuns(runtime)).map(r => r.id)).toContain(id); // cron still owns it
  // A run already analysed once is never re-analysed by a wake: retries stay with cron.
  await setup();
  // A settled but unusable model answer: the attempt is consumed and accounted for.
  const failing: typeof fetch = async (url, init) => String(url).startsWith("https://generativelanguage.googleapis.com/")
    ? Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{invalid-json" }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } })
    : p.network(url, init);
  const second = (await enqueueSavIntakeMessage(messageId, runtime))!;
  const failed = await analyseSavIntakeWake(second, deps({ network: failing }));
  expect(failed.state).toBe("waiting");
  expect((await run(second)).attempts).toBe(1);
  expect(await savIntakeWakeStage(second)).toBeNull();
  expect(await analyseSavIntakeWake(second, deps())).toMatchObject({ state: "skipped", reason: "no_durable_work" });
  expect(modelHits).toBe(0);
  expect((await pendingSavIntakeRuns(runtime)).map(r => r.id)).toContain(second);
});

it("operational_utc_v1: distinct messages processed concurrently keep budget and admission accounting", async () => {
  profile = "operational"; await setup();
  expect(runtime.budgetProfile).toBe(SAV_INTAKE_OPERATIONAL_PROFILE);
  const otherThread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: "gmail-thread-b", customerEmail: customer }).returning())[0].id;
  const other = await storedMessage(otherThread);
  const ids = [(await enqueueSavIntakeMessage(messageId, runtime))!, (await enqueueSavIntakeMessage(other.id, runtime))!];
  const results = await Promise.all(ids.map(id => processSavIntakeWake(id, deps())));
  expect(results.map(r => r.analysis.state)).toEqual(["observed", "observed"]);
  expect(modelHits).toBe(2);
  const rows = await ledger();
  expect(rows.map(r => r.state)).toEqual(["settled", "settled"]);
  const budget = await readSavIntakeBudget(runtime);
  expect(budget.callCount).toBe(2); expect(budget.chargedNanoUsd).toBe(rows.reduce((sum, r) => sum + r.chargedNanoUsd, 0));
  const executions = await f.db.select().from(savIntakeExecutions);
  expect((await f.db.select().from(savIntakeExecutionBudget))[0].admitted).toBe(executions.length);
  // Same contact: the occupation lets at most one write at a time, never a doubled ticket per message.
  expect(ticketPosts()).toBeLessThanOrEqual(executions.length);
});


it("keeps the external-completion test seam while defaulting to the canonical reader", async () => {
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!;
  const read = vi.fn(async () => ({ synthetic: true }));
  expect(await analyseSavIntakeWake(id, deps({ readExternalCompletion: read }))).toMatchObject({ state: "skipped", reason: "external_completion" });
  expect(read).toHaveBeenCalledWith({ id: messageId, threadId, receivedAt: (await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].receivedAt });
  expect(modelHits).toBe(0); expect((await run(id)).attempts).toBe(0);
});

it.each(["pending", "observed", "admitted"] as const)("recovery skips more than LIMIT blocked %s dossiers before pagination, across passes", async stage => {
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!;
  if (stage !== "pending") await analyseSavIntakeWake(id, deps());
  const source = await run(id);
  let execution: typeof savIntakeExecutions.$inferSelect | undefined;
  if (stage === "admitted") {
    const config = intakeExecutionConfig(environment)!, { policy } = await readIntakeExecutionAuthority(config);
    execution = (await admitIntakeExecution(id, { runtime, policy, config, env: () => environment, adapters, signal: AbortSignal.timeout(30000) }))!;
  }
  const blocked: string[] = [];
  const now = new Date(), old = new Date(now.getTime() - 600_000);
  // Each family alone exceeds LIMIT=4. No cursor, attempts or business state
  // is rewritten to get past paused, handled, leased or exhausted older rows.
  for (const kind of ["paused", "external", "lease", "exhausted", "stale", "config", "recent"] as const) {
    for (let n = 0; n < 5; n++) {
      const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: customer, aiPaused: kind === "paused" }).returning())[0];
      const message = await storedMessage(thread.id);
      const copy = (await f.db.insert(savIntakeRuns).values({ ...source, id: randomUUID(), threadId: thread.id, messageId: message.id,
        configHash: kind === "config" ? "stale-config" : source.configHash, createdAt: old, updatedAt: old,
        ...(kind === "lease" && stage !== "admitted" ? { leaseToken: randomUUID(), leaseUntil: later(600_000) } : {}) }).returning())[0];
      blocked.push(copy.id);
      if (execution) await f.db.insert(savIntakeExecutions).values({ ...execution, id: randomUUID(), runId: copy.id, threadId: thread.id, messageId: message.id, createdAt: old, updatedAt: old,
        ...(kind === "lease" ? { leaseToken: randomUUID(), leaseUntil: later(600_000) } : {}) });
      if (kind === "external") await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: SAV_EXTERNAL_COMPLETION, entityType: "sav_message", entityId: message.id,
        technicalMetadata: { version: 1, threadId: thread.id, batchId: randomUUID(), receivedBefore: later(60_000).toISOString(), reason: "processed_outside_studio" } });
      // A genuinely newer mail: received AND stored later. A provider date alone in the future is
      // bounded by storage time (étape 1), which made this fixture tie with the older mail.
      if (kind === "stale") await storedMessage(thread.id, { at: later(1000), createdAt: later(1000) });
      if (kind === "exhausted" || kind === "recent") await f.db.insert(auditLogs).values({ actorEmail: "system", action: "sav_intake_wake_requested", entityType: "sav_intake_wake", entityId: copy.id,
        technicalMetadata: { state: kind === "exhausted" ? "abandoned" : "running", dispatches: kind === "exhausted" ? SAV_INTAKE_WAKE_MAX_DISPATCHES : 1,
          lastDispatchedAt: kind === "exhausted" ? old.toISOString() : now.toISOString() } });
    }
  }
  const eligible = [id];
  for (let n = 0; n < 5; n++) {
    const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: customer }).returning())[0];
    const message = await storedMessage(thread.id);
    const at = new Date(now.getTime() + n + 1);
    const copy = (await f.db.insert(savIntakeRuns).values({ ...source, id: randomUUID(), threadId: thread.id, messageId: message.id, createdAt: at, updatedAt: at }).returning())[0];
    eligible.push(copy.id);
    if (execution) await f.db.insert(savIntakeExecutions).values({ ...execution, id: randomUUID(), runId: copy.id, threadId: thread.id, messageId: message.id, createdAt: at, updatedAt: at });
  }
  const attempts = (await f.db.select().from(savIntakeRuns)).map(r => [r.id, r.attempts]);
  const budget = await readSavIntakeBudget(runtime), admitted = (await f.db.select().from(savIntakeExecutionBudget))[0]?.admitted;
  for (let pass = 0; pass < 3; pass++) {
    state.start.mockReset();
    const page = eligible.slice(pass * 4, (pass + 1) * 4);
    expect(await dispatchPendingSavIntakeWakes({ env: environment, start: state.start, limit: 4 })).toEqual({ dispatched: page.length });
    expect(state.start.mock.calls.map(call => call[0])).toEqual(page);
  }
  expect((await f.db.select().from(savIntakeRuns)).map(r => [r.id, r.attempts])).toEqual(attempts);
  expect(await readSavIntakeBudget(runtime)).toEqual(budget);
  expect((await f.db.select().from(savIntakeExecutionBudget))[0]?.admitted).toBe(admitted);
  expect(modelHits).toBe(stage === "pending" ? 0 : 1); expect(ticketPosts()).toBe(0);
  expect(await f.db.select().from(savThreads).then(rows => rows.filter(t => t.aiPaused))).toHaveLength(5);
  expect(blocked).not.toContain(id);
});

it.each(["observed", "admitted"] as const)("a terminal wake hint cannot hide durable %s work after a transient skip or lost step", async stage => {
  const id = (await enqueueSavIntakeMessage(messageId, runtime))!;
  await woken(id);
  await analyseSavIntakeWake(id, deps());
  if (stage === "admitted") {
    const config = intakeExecutionConfig(environment)!, { policy } = await readIntakeExecutionAuthority(config);
    await admitIntakeExecution(id, { runtime, policy, config, env: () => environment, adapters, signal: AbortSignal.timeout(30000) });
  } else {
    // Temporary execution OFF leaves admission durable and must stay waiting.
    expect(await executeSavIntakeWake(id, deps({ env: () => ({ ...environment, SAV_INTAKE_EXECUTION_MODE: "off" }) }))).toMatchObject({ state: "skipped", reason: "execution_off" });
    expect((await readSavIntakeWake(id))?.technicalMetadata.state).toBe("waiting");
  }
  // Legacy terminal marker / workflow dies between steps: neither is business truth.
  const marker = (await readSavIntakeWake(id))!;
  await f.db.update(auditLogs).set({ technicalMetadata: { ...marker.technicalMetadata, state: "completed", lastDispatchedAt: new Date(Date.now() - 150_000).toISOString() } }).where(eq(auditLogs.id, marker.id));
  state.start.mockReset();
  expect(await dispatchPendingSavIntakeWakes({ env: environment, start: state.start })).toEqual({ dispatched: 1 });
  expect(state.start.mock.calls.map(call => call[0])).toEqual([id]);
  expect((await readSavIntakeWake(id))?.technicalMetadata.dispatches).toBe(2);
  expect((await processSavIntakeWake(id, deps())).execution).toMatchObject({ state: "confirmed" });
  expect((await processSavIntakeWake(id, deps())).execution).toBeNull();
  expect(await dispatchPendingSavIntakeWakes({ env: environment, start: state.start })).toEqual({ dispatched: 0 });
  expect(modelHits).toBe(1); expect(ticketPosts()).toBe(1);
  expect((await run(id)).attempts).toBe(1);
});
