import { createHash, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { auditLogs, savMailboxes, savThreads, savMessages, staffUsers, savSyncState, savIntakeRuns, savIntakeModelCalls,
  savIntakeHumanEvents, savIntakeJournal, savIntakeConsole, savIntakeExecutions, savIntakeEffects, savIntakeExecutionBudget,
  savIntakeExecutionPolicies, savIntakeObservationBindings, savResolutionObservations, savAgentRuns, savDecisions, savActions, savFollowups, savLearningCandidates, savKnowledgeActivations, categories } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
// Scheduling is covered by hubspot-transport.test.ts; keep business scenarios
// independent of real rate-limit waits without replacing readers or guards.
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("DB_FORBIDDEN"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { savIntakeRuntimeConfig, intakeRuntimeHash, SAV_INTAKE_RUNTIME_REVISION, type IntakeRuntimePayload } from "./runtime-contract";
import { planSavIntake } from "./engine";
import { recordAcceptedIntakeSemantics, SAV_INTAKE_SEMANTIC_RECORD_REVISION, type AcceptedIntakeSemantics } from "./semantic-records";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { enqueueSavIntakeMessage, claimSavIntakeRun, saveSavIntakeResult, readSavIntakeCurrent, catchupSavIntake, pendingSavIntakeRuns, assertSavIntakeLease } from "./runtime-store";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "./execution-policy";
import * as executionPolicyModule from "./execution-policy";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import { admitIntakeExecution, assertNoLegacyConflict, claimExecution, ensureExecutionEffect, markEffectDispatched, getExecutionEffects, recordEffectAck } from "./execution-store";
import { executeIntakePass, reconcileIntakeExecutor, readIntakeExecutionProgress, reconcileIntakeEffectsReadOnly } from "./executor";
import { recordIntakeHumanCommand, type IntakeHumanCommand } from "./human-commands";
import { consumeIntakeHumanEvent, reconcileIntakeHumanChoices } from "./human-worker";
import { intakeRunConfigurationBound, intakeRunCandidateContactIds, humanRevisionConfigHash, type HumanEventPayload } from "./human-binding";
import { releaseIntakeHumanHold } from "./human-hold-release";
import { releaseLegacyAiPauses } from "./legacy-pause";
import { SAV_EXTERNAL_COMPLETION, SAV_EXTERNAL_COMPLETION_REVERTED, getSavExternalCompletion, revertSavExternalCompletionBatch, markSavDossiersHandledExternally, completeSavDossierManually } from "../external-completion";
import { listIntakeConsole, projectIntakeThread, refreshIntakeConsole } from "./console-store";
import { classifyInvalidSourceAsOther } from "./invalid-source-classification";
import { syncHandledIntakeGmailRead, reconcileHandledIntakeGmailRead, SAV_INTAKE_GMAIL_READ } from "./gmail-read";
import type { GmailRequest } from "./execution-adapters";
import { readIntakeConsoleDetail } from "./console-detail";
import { ensureIntakeObservations, readIntakeObservationBinding, readIntakeLearningQualification, attributeIntakeObservationEvents } from "./observation-binding";
import { isSavMessageEligible } from "../cutover";
import { enqueueSavTranslation, reconcileSavTranslations } from "../translations";
import { activateSavV0Cutover } from "../cutover";
import { activateSavLearningCutover } from "../learning-admission";
import { processPendingHubspotActions } from "../hubspot";
import { processPendingGmailSendActions } from "../gmail";
import { processDueFollowups } from "../followups";
import { approveLearningCandidate } from "../learning";
import { syncSavObservation, prepareSavObservationLearning } from "../observations";
import { recordIntakeLaunch, readIntakeLaunch } from "./launch-boundary";
import { v0Proposal } from "../../../../test/sav-v0-review-fixture";
import { ensureSavCaseObservationTx } from "../case-learning";
import { readSavCaseLearningQualification } from "../case-qualification";
import { reviewSavProposal } from "../review";
import { previewIntakeLaunch, commitIntakeLaunch } from "./launch-admin";
import { previewLaunchAction, commitLaunchAction, revokeLaunchAction } from "@/app/studio/sav/intake/launch/actions";
import { POST as adminPost } from "@/app/api/sav/intake-admin/route";
import { getSavThreadDetail, processStoredSavMessage, processPendingSavMessages, requestHumanIntervention } from "../service";
import { enqueueConfiguredSavIntake, reconcileSavIntakeRuntime } from "./runtime";
import { saveIntakeChoice } from "@/app/studio/sav/intake/actions";
import {requestIntakeReinvestigation} from "./operator-recovery";
import type { ExecutionOptions } from "./execution-types";
let db: Awaited<ReturnType<typeof createSavTestDb>>, p: ReturnType<typeof executionProvider>, mailboxId: string, threadId: string, messageId: string,
  options: ExecutionOptions, environment: Record<string, string | undefined>, runId: string;
const mutations: ExecutionPolicy["mutations"] = ["create_ticket", "link_ticket", "associate_email", "append_ticket_note", "set_ticket_new", "send_identity_template"];
async function message(thread = threadId, receivedAt = new Date(), subject = "Synthetic connection failure") {
  return (await db.db.insert(savMessages).values({ mailboxId, threadId: thread, direction: "inbound", gmailMessageId: randomUUID(),
    fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject, receivedAt,
    bodyCiphertext: encryptSavPayload({ text: "The synthetic connection fails.", headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }) }).returning())[0];
}
async function observed(multiple = false, sensitive = false, same = true, equivalentContactIds?: string[], kind?: "acknowledgement") {
  if (multiple) p.setContacts([{ id: "101", emails: ["customer@example.invalid"] }, { id: "102", emails: ["customer@example.invalid"] }]);
  const id = (await enqueueSavIntakeMessage(messageId, options.runtime))!, lease = (await claimSavIntakeRun(id, options.runtime))!;
  const semantics: AcceptedIntakeSemantics = { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION, records: [] };
  const semantic = recordAcceptedIntakeSemantics({
    analyseMessage: async () => ({ messageId, requests: [{ id: "r1", kind: kind ?? (sensitive ? "finance" as const : "support" as const), currentMessageId: messageId }],
      ticketSummary: { title: "Synthetic connection failure", description: "The synthetic connection fails.", requestIds: ["r1"] } }),
    assessIdentity: async ({ candidates, evidence }) => ({ kind: "equivalent", investigationComplete: true,
      contactIds: equivalentContactIds ?? candidates.map(c => c.contact.id), evidenceIds: evidence.map(e => e.id) }),
    assessIssues: async ({ tickets, requests }) => ({ investigationComplete: true, tickets: tickets.map(({ ticket }) => ({ ticketId: ticket.id,
      relation: same ? "same" as const : "different" as const, requestIds: requests.map(r => r.id), evidenceIds: ["current", `ticket-${ticket.id}`, `history-${ticket.id}`] })) }),
  }, semantics, () => {});
  const plan = await planSavIntake(lease.input, { ...createSavIntakeHubspotReaders({ network: p.network }), ...semantic }, options.runtime.policy, {}, () => new Date());
  const payload: IntakeRuntimePayload = { revision: SAV_INTAKE_RUNTIME_REVISION, input: lease.input, plan, semantics, effects: "not_connected",
    configuration: { configHash: options.runtime.configHash, resourcesHash: options.runtime.resourcesHash, policyHash: options.runtime.policyHash,
      codeRevision: options.runtime.codeRevision, model: options.runtime.model } };
  await saveSavIntakeResult(lease, options.runtime, payload, plan.decision.disposition.kind === "collect_context" ? "waiting" : "observed");
  runId = id;
  return plan;
}
async function command(kind: "select" | "classify" | "refuse" = "select"): Promise<IntakeHumanCommand> {
  const current = (await readSavIntakeCurrent(threadId))!;
  return { commandKey: randomUUID(), threadId, messageId, runId: current.id, version: current.version, sourceHash: current.sourceHash!,
    candidatesHash: intakeRuntimeHash([...(current.candidateContactIds ?? [])].sort()), kind,
    ...(kind === "select" ? { contactId: "102" } : kind === "classify" ? { classification: "other" as const } : {}), reason: "Synthetic verified operator evidence." };
}
const mutationsSent = () => p.calls.filter(c => ["PUT", "PATCH"].includes(c.method) || c.method === "POST" && (/^\/crm\/v3\/objects\/(tickets|notes|emails)$/.test(c.path) || c.path === "gmail/messages/send"));
beforeAll(async () => { db = await createSavTestDb(); state.db = db.db; }, 30000);
afterAll(async () => { if (db) { await db.client.exec("TRUNCATE sav.intake_human_events,sav.intake_effect_revisions,sav.intake_observation_bindings,sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies CASCADE; UPDATE sav.intake_execution_budget SET admitted=0"); await db.client.close(); } });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-console-encryption-key-32-characters");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  await db.client.exec("TRUNCATE sav.intake_human_events,sav.intake_effect_revisions,sav.intake_observation_bindings,sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies,sav.intake_model_calls,sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; UPDATE sav.intake_execution_budget SET admitted=0");
  await db.client.exec("DELETE FROM sav.sync_state WHERE key like 'sav-intake-launch:%' OR key IN ('sav-v0-cutover','sav-learning-admission-cutover'); TRUNCATE sav.learning_candidates CASCADE; TRUNCATE sav.learning_admission_attempts CASCADE; TRUNCATE sav.learning_admission_reservations CASCADE");
  await db.db.insert(savSyncState).values({ key: "sav-intake-console-schema-v1", status: "installed" }).onConflictDoNothing();
  const [admin] = await db.db.insert(staffUsers).values({ clerkId: "synthetic-console-admin", email: "ugo@limova.ai", name: "Synthetic", role: "admin", active: true }).returning();
  state.user = { id: admin.clerkId, primaryEmailAddress: { emailAddress: admin.email, verification: { status: "verified" } } };
  mailboxId = (await db.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await db.db.insert(savThreads).values({ mailboxId, gmailThreadId: "gmail-thread", customerEmail: "customer@example.invalid" }).returning())[0].id;
  messageId = (await message()).id;
  const policy = { relationRevision: "synthetic", admittedRelations: [], resources: {} };
  environment = { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake", HUBSPOT_ACCESS_TOKEN: "fake",
    SAV_ENCRYPTION_KEY_V1: process.env.SAV_ENCRYPTION_KEY_V1, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId, createdAfter: new Date(Date.now() - 10000).toISOString(), receivedAfter: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxCalls: 30, maxNanoUsd: 3000000000 }) };
  const runtime = savIntakeRuntimeConfig(environment)!, executionPolicy: ExecutionPolicy = { revision: "sav-intake-execution-2026-10-21.v1", mailboxId,
    codeRevision: runtime.codeRevision, enginePolicyHash: runtime.policyHash, resourcesHash: runtime.resourcesHash, createdAfter: runtime.createdAfter,
    receivedAfter: runtime.receivedAfter, expiresAt: runtime.expiresAt, maxDossiers: 100, mutations, admission: { kind: "automatic" } };
  const grant = await approveIntakeExecutionPolicy(executionPolicy);
  environment = { ...environment, SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash };
  p = executionProvider();
  p.setGmail((await db.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].gmailMessageId!, "gmail-thread");
  options = { runtime, policy: executionPolicy, config: intakeExecutionConfig(environment)!, env: () => environment, signal: AbortSignal.timeout(30000),
    adapters: createIntakeExecutorAdapters({ network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => {}, env: () => environment }) };
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function prepareManualCompletion(multiple = true) {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
  await activateSavV0Cutover({receivedAfter:new Date(Date.now()-3600000).toISOString(),mailboxEmail:"support@example.invalid",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
  await observed(multiple);
  return {requestKey:randomUUID(),threadId,messageId,confirmed:true as const};
}
it("manual completion moves only the displayed message into completed, is idempotent and fences automation without provider calls", async () => {
  const input = await prepareManualCompletion();
  const before = (await db.db.select().from(savIntakeRuns))[0];
  expect(await completeSavDossierManually(input)).toMatchObject({marked:1,alreadyCompleted:0});
  expect(await completeSavDossierManually(input)).toMatchObject({marked:0,alreadyCompleted:1});
  expect((await listIntakeConsole({view:"completed"})).rows.map(row=>row.threadId)).toEqual([threadId]);
  expect((await listIntakeConsole({view:"to_validate"})).total).toBe(0);
  expect(await admitIntakeExecution(runId,options)).toBeNull();
  expect((await db.db.select().from(savIntakeRuns))[0]).toMatchObject({attempts:before.attempts,payloadCiphertext:before.payloadCiphertext});
  expect((await db.db.select().from(auditLogs)).filter(row=>row.action===SAV_EXTERNAL_COMPLETION)).toHaveLength(1);
  expect(await db.db.select().from(savLearningCandidates)).toHaveLength(0);
  expect(await db.db.select().from(savActions)).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();expect(mutationsSent()).toHaveLength(0);
});
it("manual completion rejects a stale page and leaves a new inbound eligible after an earlier completion", async () => {
  const input=await prepareManualCompletion();await completeSavDossierManually(input);
  const inbound=await message(threadId,new Date(Date.now()+1000));
  expect(await completeSavDossierManually({...input,requestKey:randomUUID()})).toMatchObject({marked:0,skipped:{new_inbound:1}});
  expect(await getSavExternalCompletion(inbound)).toBeNull();
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect((await db.db.select().from(auditLogs)).filter(row=>row.action===SAV_EXTERNAL_COMPLETION)).toHaveLength(1);
});
it.each(["unverified","inactive","member","different_operator"])("manual completion refuses %s without an administrative marker",async scenario=>{
  const input=await prepareManualCompletion();
  if(scenario==="unverified")state.user=null;
  else if(scenario==="different_operator") {
    await db.db.update(staffUsers).set({email:"reouven@limova.ai"});
    state.user={id:"synthetic-console-admin",primaryEmailAddress:{emailAddress:"reouven@limova.ai",verification:{status:"verified"}}};
  } else await db.db.update(staffUsers).set(scenario==="inactive"?{active:false}:{role:"member"});
  await expect(completeSavDossierManually(input)).rejects.toThrow();
  expect((await db.db.select().from(auditLogs)).filter(row=>row.action===SAV_EXTERNAL_COMPLETION)).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["confirmation","message","server_boundary"])("manual completion refuses a forged %s",async scenario=>{
  const input=await prepareManualCompletion();
  const forged=scenario==="confirmation"?{...input,confirmed:false}:scenario==="message"?{...input,messageId:"invalid"}:{...input,receivedBefore:new Date(Date.now()+86400000).toISOString()};
  await expect(completeSavDossierManually(forged)).rejects.toThrow();
  expect((await db.db.select().from(auditLogs)).filter(row=>row.action===SAV_EXTERNAL_COMPLETION)).toHaveLength(0);
});
it.each(["analysis","execution"])("manual completion keeps an active %s worker visible",async kind=>{
  const input=await prepareManualCompletion(false);
  if(kind==="analysis")await db.db.update(savIntakeRuns).set({leaseUntil:new Date(Date.now()+60000)}).where(eq(savIntakeRuns.id,runId));
  else {
    const execution=(await admitIntakeExecution(runId,options))!;expect(execution).not.toBeNull();
    await db.db.update(savIntakeExecutions).set({leaseUntil:new Date(Date.now()+60000)}).where(eq(savIntakeExecutions.id,execution.id));
  }
  expect(await completeSavDossierManually(input)).toMatchObject({marked:0,skipped:{active_worker:1}});
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
});
it("manual completion rechecks a staff revocation between authentication and transaction",async()=>{
  const input=await prepareManualCompletion();
  const original=executionPolicyModule.executionAdministrator;
  vi.spyOn(executionPolicyModule,"executionAdministrator").mockImplementationOnce(async()=>{
    const actor=await original();await db.db.update(staffUsers).set({active:false});return actor;
  });
  await expect(completeSavDossierManually(input)).rejects.toThrow("FORBIDDEN");
  expect((await db.db.select().from(auditLogs)).filter(row=>row.action===SAV_EXTERNAL_COMPLETION)).toHaveLength(0);
});
it("manual completion preserves a pending human choice and an uncertain legacy send",async()=>{
  const input=await prepareManualCompletion();await recordIntakeHumanCommand(await command());
  expect(await completeSavDossierManually(input)).toMatchObject({marked:0,skipped:{unsettled_action:1}});
  await db.db.update(savIntakeHumanEvents).set({state:"refused"});
  await db.db.insert(savActions).values({threadId,messageId,kind:"send_reply",actorType:"human",status:"failed",idempotencyKey:randomUUID(),payload:{replySendDispatchedAt:new Date().toISOString()}});
  expect(await completeSavDossierManually(input)).toMatchObject({marked:0,skipped:{unsettled_action:1}});
  expect(fetch).not.toHaveBeenCalled();expect(mutationsSent()).toHaveLength(0);
});
it("form -> authenticated CAS -> accepted semantics -> derived run -> real HTTP fake execution; exhausted quotas stay exhausted", async () => {
  await observed(true);
  await db.db.update(savIntakeRuns).set({ attempts: 2 }).where(eq(savIntakeRuns.id, runId));
  for (let i = 0; i < 3; i++) await db.db.insert(savIntakeModelCalls).values({ runId, messageKey: intakeRuntimeHash(messageId), requestHash: `synthetic-${i}`,
    state: "uncertain", reservedNanoUsd: 817152000, chargedNanoUsd: 817152000, payloadCiphertext: encryptSavPayload({}) });
  const raw = await command(), form = new FormData();
  for (const [key, value] of Object.entries(raw)) form.set(key, String(value));
  expect((await saveIntakeChoice({ok:false,message:""},form)).ok).toBe(true);
  expect(mutationsSent()).toHaveLength(0);
  const [event] = await db.db.select().from(savIntakeHumanEvents);
  const result = await consumeIntakeHumanEvent(event.id, options.runtime, createSavIntakeHubspotReaders({ network: p.network }));
  expect(result).toHaveProperty("state", "observed");
  const current = (await readSavIntakeCurrent(threadId, options.runtime))!;
  expect(current.configHash).toBe(humanRevisionConfigHash(options.runtime.configHash, event.id));
  expect(await intakeRunConfigurationBound(current, options.runtime)).toBe(true);
  expect(current.payload.plan?.decision.disposition).toMatchObject({ kind: "ticket", target: { operation: "create", contactId: "102", selection: { kind: "human_equivalent_contacts" } }, identity: { kind: "human_equivalent_contacts" } });
  expect(current.payload.plan?.decision.evidence.find(e => e.id === "email-lookup")).toBeTruthy();
  expect(current.payload.plan?.decision.evidence.filter(e => e.source === "crm_contact" && /^\d+$/.test(e.sourceId))).toHaveLength(2);
  const execution = (await admitIntakeExecution(current.id, options))!;
  expect((await executeIntakePass(execution.id, options)).state).toBe("confirmed");
  expect((await readIntakeExecutionProgress(messageId))?.confirmed).toBe(true);
  expect(p.calls.filter(c => c.path === "/crm/v3/objects/tickets" && c.method === "POST")).toHaveLength(1);
  expect((await db.db.select().from(savIntakeModelCalls))).toHaveLength(3);
  expect((await db.db.select().from(savIntakeRuns)).reduce((n,r)=>n+r.attempts,0)).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});
it("two operators and replay: one event wins, changed command is rejected", async () => {
  await observed(true); const raw = await command();
  const first = await recordIntakeHumanCommand(raw);
  expect(await recordIntakeHumanCommand(raw)).toEqual(first);
  await expect(recordIntakeHumanCommand({ ...raw, commandKey: randomUUID(), contactId: "101" })).rejects.toThrow("CONFLICT");
  await expect(recordIntakeHumanCommand({ ...raw, contactId: "101" })).rejects.toThrow("CONFLICT");
  expect(await db.db.select().from(savIntakeHumanEvents)).toHaveLength(1);
});
it("a new inbound or changed stored history rejects the old form without writers", async () => {
  await observed(true); const raw = await command();
  await message(threadId, new Date(Date.now()+1000));
  await expect(recordIntakeHumanCommand(raw)).rejects.toThrow("CONFLICT");
  expect(mutationsSent()).toHaveLength(0);
});
it("CRM candidate change after CAS cannot reuse the accepted equivalence", async () => {
  await observed(true); const saved = await recordIntakeHumanCommand(await command());
  p.setContacts([{id:"101",emails:["customer@example.invalid"]},{id:"102",emails:["customer@example.invalid"]},{id:"103",emails:["customer@example.invalid"]}]);
  const result = await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}));
  expect(result).toHaveProperty("state","waiting");
  expect((await readSavIntakeCurrent(threadId))?.payload.reason).toBe("SAV_INTAKE_SEMANTIC_CONTEXT_CHANGED");
  expect(mutationsSent()).toHaveLength(0);
});
it("identity accepted but issue semantics absent never invents a ticket relation", async () => {
  p.seedTicket({contactIds:["102"]}); await observed(true);
  const saved = await recordIntakeHumanCommand(await command());
  await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}));
  const current = (await readSavIntakeCurrent(threadId))!;
  expect(current.state).toBe("waiting"); expect(current.payload.plan?.decision.disposition.kind).toBe("collect_context");
  expect(current.payload.reason).toBe("SAV_INTAKE_SEMANTIC_CONTEXT_CHANGED"); expect(mutationsSent()).toHaveLength(0);
});
it("a missing semantic envelope is honest waiting, never reconstructed from a raw settled cache", async () => {
  await observed(true); const [run]=await db.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,runId));
  const payload=decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext);delete payload.semantics;
  await db.db.update(savIntakeRuns).set({payloadCiphertext:encryptSavPayload(payload)}).where(eq(savIntakeRuns.id,runId));
  const saved=await recordIntakeHumanCommand(await command());await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}));
  expect((await readSavIntakeCurrent(threadId))?.payload.reason).toBe("SAV_INTAKE_SEMANTIC_PROVENANCE_MISSING"); expect(mutationsSent()).toHaveLength(0);
});
it("human refusal is durable through config/catchup/choice and consumes no writer or model", async () => {
  await observed(true); await recordIntakeHumanCommand(await command("refuse"));
  expect(await claimSavIntakeRun(runId,options.runtime)).toBeNull();
  await catchupSavIntake({...options.runtime,configHash:"b".repeat(64)});
  expect(await db.db.select().from(savIntakeRuns)).toHaveLength(1);
  await expect(recordIntakeHumanCommand(await command())).rejects.toThrow("CONFLICT");
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"to_validate"})).rows[0].status).toBe("human_refused");
  expect(mutationsSent()).toHaveLength(0);
});
it("forged derived configuration/event/source/mailbox is never an authority", async () => {
  await observed(true);const saved=await recordIntakeHumanCommand(await command());await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}));
  const current=(await readSavIntakeCurrent(threadId))!;
  expect(await intakeRunConfigurationBound({...current,configHash:"c".repeat(64)},options.runtime)).toBe(false);
  expect(await intakeRunConfigurationBound({...current,messageId:randomUUID()},options.runtime)).toBe(false);
  expect(await intakeRunConfigurationBound({...current,sourceHash:"d".repeat(64)},options.runtime)).toBe(false);
  expect(await intakeRunConfigurationBound(current,{...options.runtime,mailboxId:randomUUID()})).toBe(false);
  expect(await intakeRunConfigurationBound(current,{...options.runtime,policyHash:"e".repeat(64)})).toBe(false);
  await expect(db.db.update(savIntakeHumanEvents).set({sourceHash:"f".repeat(64)}).where(eq(savIntakeHumanEvents.id,saved.eventId))).rejects.toThrow();
});
it("projection CAS cannot clear dirty or retain a previous success across a new entrant", async () => {
  await observed();
  expect(await projectIntakeThread(threadId,async()=>{await message(threadId,new Date(Date.now()+1000),"Newest synthetic request");})).toBe(false);
  const list=await listIntakeConsole({view:"processing",search:"Newest"});expect(list.total).toBe(1);expect(list.rows[0].status).toBe("processing");
});
it("more than 250 dossiers share list/count/search predicate, stable equal-date pagination and mailbox isolation", async () => {
  const threads=await db.db.insert(savThreads).values(Array.from({length:276},(_,i)=>({mailboxId,gmailThreadId:`synthetic-thread-${i}`,customerEmail:`synthetic-${i}@example.invalid`}))).returning();
  const at=new Date("2026-10-21T09:00:00Z");
  await db.db.insert(savMessages).values(threads.map((t,i)=>({threadId:t.id,mailboxId,direction:"inbound" as const,fromEmail:`synthetic-${i}@example.invalid`,toEmails:["support@example.invalid"],subject:i===275?"Needle beyond250":"Synthetic request",bodyCiphertext:encryptSavPayload({text:"Synthetic"}),receivedAt:at,analysisStatus:"intake_waiting"})));
  await db.db.update(savIntakeConsole).set({updatedAt:at});
  const a=await listIntakeConsole({view:"processing",page:1}), b=await listIntakeConsole({view:"processing",page:2});
  expect(a.total).toBe(276);expect(a.counts.processing).toBe(276);expect(a.rows).toHaveLength(25);
  expect(a.rows.some(x=>b.rows.some(y=>y.threadId===x.threadId))).toBe(false);
  expect((await listIntakeConsole({view:"processing",search:"Needle"})).total).toBe(1);
  expect((await listIntakeConsole({view:"processing",mailboxId:randomUUID()})).total).toBe(0);
  expect((await listIntakeConsole({view:"processing",search:"absent",page:999}))).toMatchObject({total:0,rows:[],page:1,pages:1});
});
it("lists dossiers chronologically by latest email, newest first, regardless of projection refreshes", async () => {
  const threads=await db.db.insert(savThreads).values(["old","middle","new"].map(name=>({mailboxId,gmailThreadId:`chrono-${name}`,customerEmail:`${name}@example.invalid`}))).returning();
  const day=(d:number)=>new Date(`2026-10-${d}T09:00:00Z`);
  await db.db.insert(savMessages).values(threads.map((t,i)=>({threadId:t.id,mailboxId,direction:"inbound" as const,fromEmail:`chrono-${i}@example.invalid`,toEmails:["support@example.invalid"],subject:`Chrono ${i}`,bodyCiphertext:encryptSavPayload({text:"Synthetic"}),receivedAt:day(20+i),analysisStatus:"intake_waiting"})));
  // The oldest dossier was refreshed last: it must still stay at the bottom.
  for(const [i,t] of threads.entries()) await db.db.update(savIntakeConsole).set({updatedAt:day(23-i)}).where(eq(savIntakeConsole.threadId,t.id));
  // A newer reply on the old thread moves it to the top, by its latest email.
  const list=await listIntakeConsole({view:"processing",search:"Chrono"});
  expect(list.rows.map(row=>row.subject)).toEqual(["Chrono 2","Chrono 1","Chrono 0"]);
  await db.db.insert(savMessages).values({threadId:threads[0].id,mailboxId,direction:"inbound",fromEmail:"chrono-0@example.invalid",toEmails:["support@example.invalid"],subject:"Chrono 0 reply",bodyCiphertext:encryptSavPayload({text:"Synthetic"}),receivedAt:day(25),analysisStatus:"intake_waiting"});
  expect((await listIntakeConsole({view:"processing",search:"Chrono"})).rows.map(row=>row.subject)).toEqual(["Chrono 0 reply","Chrono 2","Chrono 1"]);
});
it("a provider date in the future is displayed and sorted at its storage time, the raw date kept", async () => {
  const threads=await db.db.insert(savThreads).values(["future","today"].map(name=>({mailboxId,gmailThreadId:`skew-${name}`,customerEmail:`${name}@example.invalid`}))).returning();
  const stored=new Date(Date.now()-3600_000), raw=new Date(Date.now()+21*3600_000);
  await db.db.insert(savMessages).values([{threadId:threads[0].id,mailboxId,direction:"inbound" as const,fromEmail:"skew-0@example.invalid",toEmails:["support@example.invalid"],subject:"Skew future",bodyCiphertext:encryptSavPayload({text:"Synthetic"}),receivedAt:raw,createdAt:stored,analysisStatus:"intake_waiting"},
    {threadId:threads[1].id,mailboxId,direction:"inbound" as const,fromEmail:"skew-1@example.invalid",toEmails:["support@example.invalid"],subject:"Skew today",bodyCiphertext:encryptSavPayload({text:"Synthetic"}),receivedAt:new Date(),analysisStatus:"intake_waiting"}]);
  const list=await listIntakeConsole({view:"processing",search:"Skew"});
  expect(list.rows.map(row=>row.subject)).toEqual(["Skew today","Skew future"]);
  expect(new Date(list.rows[1].receivedAt!).getTime()).toBe(stored.getTime());
  expect((await db.db.select().from(savMessages).where(eq(savMessages.subject,"Skew future")))[0].receivedAt.getTime()).toBe(raw.getTime());
});
it("an older message with a future provider date never hides the newer reply in the console", async () => {
  const [t]=await db.db.insert(savThreads).values({mailboxId,gmailThreadId:"skew-reply",customerEmail:"skew@example.invalid"}).returning();
  await db.db.insert(savMessages).values({threadId:t.id,mailboxId,direction:"inbound",fromEmail:"skew@example.invalid",toEmails:["support@example.invalid"],subject:"SkewReply first",bodyCiphertext:encryptSavPayload({text:"Synthetic"}),receivedAt:new Date(Date.now()+21*3600_000),createdAt:new Date(Date.now()-3600_000),analysisStatus:"intake_waiting"});
  await db.db.insert(savMessages).values({threadId:t.id,mailboxId,direction:"inbound",fromEmail:"skew@example.invalid",toEmails:["support@example.invalid"],subject:"SkewReply second",bodyCiphertext:encryptSavPayload({text:"Synthetic"}),receivedAt:new Date(),analysisStatus:"intake_waiting"});
  expect((await listIntakeConsole({view:"processing",search:"SkewReply"})).rows.map(row=>row.subject)).toEqual(["SkewReply second"]);
});
it("blocked dossiers stay in processing, are counted and carry their cause", async () => {
  const old=new Date(Date.now()-1200000);
  const dossier=async(name:string,marker?:string,updatedAt=new Date())=>{
    const [t]=await db.db.insert(savThreads).values({mailboxId,gmailThreadId:`blocked-${name}`,customerEmail:`${name}@example.invalid`}).returning();
    const [m]=await db.db.insert(savMessages).values({threadId:t.id,mailboxId,direction:"inbound",fromEmail:`${name}@example.invalid`,toEmails:["support@example.invalid"],subject:`Blocked ${name}`,bodyCiphertext:encryptSavPayload({text:"Synthetic"}),receivedAt:new Date(),analysisStatus:"intake_waiting"}).returning();
    const [r]=await db.db.insert(savIntakeRuns).values({threadId:t.id,messageId:m.id,version:1,state:"waiting",attempts:0,configHash:"a".repeat(64),policyHash:"b".repeat(64),payloadCiphertext:encryptSavPayload({}),createdAt:updatedAt,updatedAt}).returning();
    if(marker)await db.db.insert(savIntakeJournal).values({runId:r.id,kind:marker,payloadCiphertext:encryptSavPayload({})});
  };
  await dossier("exhausted","attempts_exhausted"); await dossier("input","deterministic_block"); await dossier("stale",undefined,old); await dossier("fresh");
  const list=await listIntakeConsole({view:"processing",search:"Blocked"});
  expect(list.total).toBe(4);
  expect(list.counts.blocked).toBe(3);
  expect(Object.fromEntries(list.rows.map(row=>[row.subject,row.blockedCause]))).toEqual({"Blocked exhausted":"attempts_exhausted","Blocked input":"input_invalid","Blocked stale":"technical_wait","Blocked fresh":null});
});
it("OFF consultation makes no provider calls; projection absent never queries 0040/41 tables", async () => {
  await observed(); await projectIntakeThread(threadId); p.calls.length=0;
  vi.stubEnv("SAV_INTAKE_RUNTIME_MODE","off");vi.stubEnv("SAV_INTAKE_EXECUTION_MODE","off");
  expect((await readIntakeConsoleDetail(threadId))?.current?.id).toBe(runId);expect(p.calls).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
  await db.db.delete(savSyncState).where(eq(savSyncState.key,"sav-intake-console-schema-v1"));
  expect(await refreshIntakeConsole()).toEqual({skipped:"migration_absent"});expect((await listIntakeConsole()).installed).toBe(false);
});
it("confirmed effects are not Treated until the first successful operational observation", async () => {
  await observed(); const execution=(await admitIntakeExecution(runId,options))!;await executeIntakePass(execution.id,options);
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"processing"})).rows[0].status).toBe("followup_pending");
  expect(await ensureIntakeObservations()).toEqual({created:1});await projectIntakeThread(threadId);
  expect((await listIntakeConsole({view:"learning"})).total).toBe(0);
  const [binding]=await db.db.select().from(savIntakeObservationBindings);
  const [observation]=await db.db.select().from(savResolutionObservations);
  expect(observation.trackingOrigin).toBe("intake");expect(observation.snapshotId).toBeNull();expect(observation.verdictId).toBeNull();
  const baseline=(await readIntakeObservationBinding(binding.observationId))!;expect(baseline.baseline.resolutionDraft).toBeNull();
  await syncSavObservation(observation.id,async ticketId=>({ticketId,subject:"Synthetic",status:"open",updatedAt:new Date().toISOString(),events:[],errors:[]}));
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"learning"})).total).toBe(1);
  expect((await readIntakeLearningQualification(threadId))?.allowed).toBe(true);
});
it("sensitive operational closure becomes Completed without comparator, and reopening removes Completed", async () => {
  await observed(false,true);const execution=(await admitIntakeExecution(runId,options))!;await executeIntakePass(execution.id,options);await ensureIntakeObservations();
  const [observation]=await db.db.select().from(savResolutionObservations);
  await syncSavObservation(observation.id,async ticketId=>({ticketId,subject:"Synthetic billing",status:"closed",updatedAt:new Date().toISOString(),events:[],errors:[]}));
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"completed"})).rows[0].status).toBe("not_applicable_sensitive");
  expect((await readIntakeLearningQualification(threadId))?.allowed).toBe(false);expect(await prepareSavObservationLearning(observation.id)).toEqual({disposition:"not_evaluable"});
  await syncSavObservation(observation.id,async ticketId=>({ticketId,subject:"Synthetic billing",status:"open",updatedAt:new Date().toISOString(),events:[],errors:[]}));
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"completed"})).total).toBe(0);expect((await listIntakeConsole({view:"sensitive"})).total).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
it("zero-departure create -> human link retires old planned intent, preserves one execution/admission and never POSTs a second ticket", async () => {
  const text="SYNTHETIC MULTIPLE OPEN TICKETS WARNING", resource={resourceId:"synthetic-warning",revisionId:"v1",sha256:createHash("sha256").update(text).digest("hex")};
  const catalogue=[{resource,text,approvalId:"synthetic",approvedBy:"synthetic-admin",approvedAt:new Date(Date.now()-1000).toISOString(),status:"approved"}];
  const policy={...options.runtime.policy,resources:{multiTicketWarning:{...resource,text}}};
  environment={...environment,SAV_INTAKE_RUNTIME_POLICY:JSON.stringify(policy),SAV_INTAKE_RUNTIME_RESOURCES:JSON.stringify(catalogue),SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),policyHash:intakeRuntimeHash(policy),resourcesHash:intakeRuntimeHash(catalogue)})};
  options.runtime=savIntakeRuntimeConfig(environment)!;options.policy={...options.policy,enginePolicyHash:options.runtime.policyHash,resourcesHash:options.runtime.resourcesHash};
  const grant=await approveIntakeExecutionPolicy(options.policy);environment={...environment,SAV_INTAKE_EXECUTION_POLICY_ID:grant.id,SAV_INTAKE_EXECUTION_POLICY_SHA256:grant.policyHash};options.config=intakeExecutionConfig(environment)!;
  p.seedTicket({stage:"new"}); await observed(false,false,false);
  const execution=(await admitIntakeExecution(runId,options))!, lease=(await claimExecution(execution.id))!;
  const old=await ensureExecutionEffect(lease,{kind:"ticket_create",permission:"create_ticket",key:`create:${messageId}`,sourceMessageId:messageId,
    contactId:"101",properties:{subject:"Old synthetic creation intent"}});
  const raw=await command();delete raw.contactId;
  const saved=await recordIntakeHumanCommand({...raw,ticketId:"201"});
  await expect(markEffectDispatched(lease,old)).rejects.toThrow("CONTEXT_CHANGED");
  expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
  const current=(await readSavIntakeCurrent(threadId))!;
  expect(current.payload.plan?.decision.disposition).toMatchObject({kind:"ticket",target:{operation:"link",ticketId:"201"}});
  expect(await getExecutionEffects(execution.id)).toHaveLength(0);
  expect((await executeIntakePass(execution.id,options)).state).toBe("confirmed");
  expect(p.calls.filter(c=>c.method==="POST"&&c.path==="/crm/v3/objects/tickets")).toHaveLength(0);
  expect(await db.db.select().from(savIntakeExecutions)).toHaveLength(1);
  expect((await db.db.select().from(savIntakeExecutionBudget))[0].admitted).toBe(1);
  expect((await db.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id,old.id)))[0].state).toBe("planned");
  expect((await readIntakeExecutionProgress(messageId))?.confirmed).toBe(true);
});
it("correction of a never-departed intent reuses the stable effect row and keeps its original business key", async () => {
  await observed();const execution=(await admitIntakeExecution(runId,options))!,lease=(await claimExecution(execution.id))!;
  const old=await ensureExecutionEffect(lease,{kind:"ticket_create",permission:"create_ticket",key:`create:${messageId}`,sourceMessageId:messageId,contactId:"101",properties:{subject:"Old synthetic"}});
  const raw=await command("classify"),saved=await recordIntakeHumanCommand({...raw,classification:"finance"});
  expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
  expect((await executeIntakePass(execution.id,options)).state).toBe("confirmed");
  const [updated]=await db.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id,old.id));
  expect(updated.attemptId).toBe(old.attemptId);expect(updated.businessKey).toBe(old.businessKey);expect(updated.intentHash).not.toBe(old.intentHash);expect(updated.state).toBe("confirmed");
});
it("refusal after dispatch accepts the late ACK and RO proof but no continuation", async () => {
  await observed();const execution=(await admitIntakeExecution(runId,options))!,lease=(await claimExecution(execution.id))!;
  const key=`create:${messageId}`, marker=intakeRuntimeHash(key), intent={kind:"ticket_create" as const,permission:"create_ticket" as const,key,sourceMessageId:messageId,
    contactId:"101",marker,properties:{subject:"Synthetic",content:`Synthetic\n\n[Studio intake: ${marker}]`,hs_pipeline:"0",hs_pipeline_stage:"1",source_type:"EMAIL"}};
  const effect=await markEffectDispatched(lease,await ensureExecutionEffect(lease,intent));
  const ack=await options.adapters.dispatch(intent,options.signal);
  await recordIntakeHumanCommand(await command("refuse"));
  await recordEffectAck(effect,ack);
  await reconcileIntakeEffectsReadOnly(execution.id,options.adapters);
  expect((await getExecutionEffects(execution.id))[0].state).toBe("confirmed");
  await executeIntakePass(execution.id,options);
  expect(mutationsSent().filter(c=>c.method==="POST")).toHaveLength(1);
  expect((await readIntakeExecutionProgress(messageId))?.confirmed).toBe(false);
});
it("strict existing staff, verification and pause cannot be bypassed by form fields", async () => {
  await observed(true);const raw=await command();
  state.user={id:"synthetic-console-admin",primaryEmailAddress:{emailAddress:"ugo@limova.ai",verification:{status:"unverified"}}};
  await expect(recordIntakeHumanCommand(raw)).rejects.toThrow("UNAUTHORIZED");
  state.user={id:"synthetic-console-admin",primaryEmailAddress:{emailAddress:"ugo@limova.ai",verification:{status:"verified"}}};
  await db.db.update(staffUsers).set({active:false});await expect(recordIntakeHumanCommand(raw)).rejects.toThrow("UNAUTHORIZED");
  await db.db.update(staffUsers).set({active:true});await db.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));
  await expect(recordIntakeHumanCommand(raw)).rejects.toThrow("CONFLICT");expect(mutationsSent()).toHaveLength(0);
});
it("a source change after CAS parks that event and cannot block another pending dossier indefinitely", async () => {
  await observed(true);const saved=await recordIntakeHumanCommand(await command());
  await db.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"Changed synthetic historical source"})}).where(eq(savMessages.id,messageId));
  expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toEqual({skipped:"not_claimed"});
  expect((await db.db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id,saved.eventId)))[0].state).toBe("waiting");
  expect(await claimSavIntakeRun(runId,options.runtime)).toBeNull();expect(mutationsSent()).toHaveLength(0);
});
it("explicit human Other is consumed with human evidence and is the sixth category, not a global observation candidate", async () => {
  await observed();const raw=await command("classify"),saved=await recordIntakeHumanCommand(raw);
  expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"other"})).total).toBe(1);
  expect((await readSavIntakeCurrent(threadId))?.payload.plan?.decision.evidence.some(e=>e.source==="human_override")).toBe(true);
  expect(mutationsSent()).toHaveLength(0);
});
it("own intake notes and exact copies cannot become independent human resolution evidence", async () => {
  await observed();const execution=(await admitIntakeExecution(runId,options))!;await executeIntakePass(execution.id,options);await ensureIntakeObservations();
  const [binding]=await db.db.select().from(savIntakeObservationBindings),baseline=(await readIntakeObservationBinding(binding.observationId))!.baseline;
  baseline.effects.push({id:randomUUID(),kind:"note_create",intent:{kind:"note_create",permission:"append_ticket_note",sourceMessageId:messageId,key:"synthetic-own-note",text:"Synthetic return context only, no human solution."},ack:{id:"777"},proof:{}});
  const base={kind:"note",occurredAt:new Date().toISOString(),text:"Synthetic return context only, no human solution.",author:"human-owner",provenance:"HubSpot notes",associationTicketId:baseline.ticketId,remoteUpdatedAt:null};
  const attributed=attributeIntakeObservationEvents([{...base,sourceRef:"hubspot:notes:777"},{...base,sourceRef:"hubspot:notes:888"}],baseline);
  expect(attributed.map(e=>e.kind)).toEqual(["ai_intake_effect","ai_intake_effect"]);
});
it("the missing-contact view requires a sent-and-verified exact private template", async () => {
  const text="Synthetic exact identification request.\nSynthetic signature.",ref={resourceId:"synthetic-template",revisionId:"v1",sha256:createHash("sha256").update(text).digest("hex")};
  const resources=[{resource:ref,text,approvalId:"synthetic-approval",approvedBy:"synthetic-admin",approvedAt:new Date(Date.now()-1000).toISOString(),status:"approved"}];
  const policy={...options.runtime.policy,resources:{identification:ref}};
  environment={...environment,SAV_INTAKE_RUNTIME_POLICY:JSON.stringify(policy),SAV_INTAKE_RUNTIME_RESOURCES:JSON.stringify(resources),
    SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),policyHash:intakeRuntimeHash(policy),resourcesHash:intakeRuntimeHash(resources)})};
  options.runtime=savIntakeRuntimeConfig(environment)!;options.policy={...options.policy,enginePolicyHash:options.runtime.policyHash,resourcesHash:options.runtime.resourcesHash};
  const grant=await approveIntakeExecutionPolicy(options.policy);
  environment={...environment,SAV_INTAKE_EXECUTION_POLICY_ID:grant.id,SAV_INTAKE_EXECUTION_POLICY_SHA256:grant.policyHash};options.config=intakeExecutionConfig(environment)!;
  p.setContacts([]);await observed();await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"missing_contact"})).total).toBe(0);
  const execution=(await admitIntakeExecution(runId,options))!;expect((await executeIntakePass(execution.id,options)).state).toBe("confirmed");
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"missing_contact"})).total).toBe(1);
  expect(await ensureIntakeObservations()).toEqual({created:0});expect(Object.keys(p.sent)).toHaveLength(1);
});
async function supportClosedWithHumanEvidence(priorFinance=false) {
  vi.stubEnv("SAV_RELEASE_STAGE","v0");
  await activateSavV0Cutover({receivedAfter:new Date(Date.now()-3600000).toISOString(),mailboxEmail:"support@example.invalid",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
  await activateSavLearningCutover({activatedAt:new Date(Date.now()-3600000).toISOString(),activatedBy:"ugo@limova.ai",deploymentSha:"a".repeat(40)},"ugo@limova.ai");
  await db.db.insert(categories).values({slug:"depannage",label:"Dépannage"}).onConflictDoNothing();
  if (priorFinance) {
    await observed(false,true);
    environment={...environment,SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify({...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),maxCalls:29})};
    options.runtime=savIntakeRuntimeConfig(environment)!;
  }
  await observed();const execution=(await admitIntakeExecution(runId,options))!;await executeIntakePass(execution.id,options);await ensureIntakeObservations();
  const [observation]=await db.db.select().from(savResolutionObservations);
  const text="Ouvrir les réglages puis rétablir la configuration et vérifier la connexion : le fonctionnement est confirmé.";
  await syncSavObservation(observation.id,async ticketId=>({ticketId,status:"closed",subject:"Configuration synthétique",updatedAt:new Date().toISOString(),errors:[],events:[{sourceRef:"hubspot:notes:human-1",kind:"note",text,author:"owner:12",occurredAt:new Date().toISOString(),provenance:"Synthetic human procedure",associationTicketId:ticketId,remoteUpdatedAt:null}]}));
  const comparator:typeof fetch=async(_url,init)=>{
    const input=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
    return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({outcome:"new",matchedRef:null,groupSignature:"synthetic-complete-configuration",subject:"Rétablir une configuration",resolution:text,conditions:["Compte synthétique"],expectedResult:"Connexion vérifiée",limitations:["Qualification synthétique"],evidenceRef:input.evidence.ref,evidenceExcerpt:input.evidence.excerpt,rationale:"Procédure synthétique observée à examiner humainement.",suggestionKind:"knowledge",caseAxes:["understanding","diagnosis","questions","solution","sources","writing"].map(axis=>({axis,state:"not_evaluable",classification:"not_evaluable",explanation:"Absence de réponse de résolution comparable pour ce parcours.",evidence:[]}))})}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,thoughtsTokenCount:0,totalTokenCount:150}});
  };
  return {observation,comparator};
}
it("intake baseline reaches the existing human knowledge queue and Completed without approving or activating knowledge", async () => {
  const {observation,comparator}=await supportClosedWithHumanEvidence();
  expect(await prepareSavObservationLearning(observation.id,new Date(),{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:comparator})).toMatchObject({disposition:"admitted"});
  const [candidate]=await db.db.select().from(savLearningCandidates);expect(candidate.status).toBe("pending");expect(candidate.createdBy).not.toBe("human");
  expect(decryptSavPayload<{intakeOrigin?:unknown}>(String(candidate.proposedPatch.ciphertext)).intakeOrigin).toBeTruthy();
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"completed"})).total).toBe(1);
  expect(await db.db.select().from(savKnowledgeActivations)).toHaveLength(0);
  await message(threadId,new Date(Date.now()+1000));
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  await expect(approveLearningCandidate(candidate.id,"ugo@limova.ai")).rejects.toThrow("SAV_OBSERVATION_STALE");
});
it("sensitive history excludes an otherwise support intake before any comparator reservation or knowledge promotion", async () => {
  const {observation,comparator}=await supportClosedWithHumanEvidence(true);
  expect((await readSavIntakeCurrent(threadId))?.payload.plan?.decision.classification).toBe("support");
  expect((await readIntakeLearningQualification(threadId))?.allowed).toBe(false);
  const network=vi.fn(comparator);
  expect(await prepareSavObservationLearning(observation.id,new Date(),{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:network})).toMatchObject({disposition:"not_evaluable"});
  expect(network).not.toHaveBeenCalled();expect(await db.db.select().from(savLearningCandidates)).toHaveLength(0);
});
async function partiallyConfirmedCreate() {
  await observed();const execution=(await admitIntakeExecution(runId,options))!;
  let created=false;const base=options.adapters;
  const interrupted={...options,adapters:{...base,verify:async(...args:Parameters<typeof base.verify>)=>{const proof=await base.verify(...args);if(args[0].kind==="ticket_create"&&proof.confirmed)created=true;return proof;},gmailCurrent:async(...args:Parameters<typeof base.gmailCurrent>)=>{if(created)throw Error("SAV_INTAKE_EXECUTION_CONTEXT_CHANGED");return base.gmailCurrent(...args);}}};
  expect((await executeIntakePass(execution.id,interrupted)).state).toBe("waiting");
  const effect=(await getExecutionEffects(execution.id)).find(e=>e.kind==="ticket_create")!;expect(effect.state).toBe("confirmed");
  return {execution,ticketId:decryptSavPayload<{id:string}>(effect.ackCiphertext!).id};
}
it("confirmed partial creation -> human selects the same verified ticket -> continuation preserves receipts and performs no second ticket POST",async()=>{
  const {execution,ticketId}=await partiallyConfirmedCreate();const raw=await command();delete raw.contactId;
  const saved=await recordIntakeHumanCommand({...raw,ticketId});
  expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
  expect((await readSavIntakeCurrent(threadId))?.payload.plan?.decision.disposition).toMatchObject({kind:"ticket",target:{operation:"link",ticketId}});
  expect((await executeIntakePass(execution.id,options)).state).toBe("confirmed");
  expect(p.calls.filter(c=>c.path==="/crm/v3/objects/tickets"&&c.method==="POST")).toHaveLength(1);
  expect((await readIntakeExecutionProgress(messageId))?.confirmed).toBe(true);expect(await db.db.select().from(savIntakeExecutions)).toHaveLength(1);
});
it("a human modification after confirmed creation is not subtracted as an own delta during revision",async()=>{
  const {execution,ticketId}=await partiallyConfirmedCreate();const raw=await command();delete raw.contactId;
  const saved=await recordIntakeHumanCommand({...raw,ticketId});p.objects.tickets[ticketId].properties.content+=" Human intervened.";
  expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("waiting","SAV_INTAKE_EXECUTION_CRM_CHANGED");
  expect((await getExecutionEffects(execution.id))).toHaveLength(1);expect((await readIntakeExecutionProgress(messageId))?.confirmed).toBe(false);
  expect(p.calls.filter(c=>c.path==="/crm/v3/objects/tickets"&&c.method==="POST")).toHaveLength(1);
});
it("two simultaneous human commands CAS the same version exactly once",async()=>{
  await observed(true);const a=await command(),b={...a,commandKey:randomUUID(),contactId:"101"};
  const results=await Promise.allSettled([recordIntakeHumanCommand(a),recordIntakeHumanCommand(b)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  expect(await db.db.select().from(savIntakeHumanEvents)).toHaveLength(1);expect(mutationsSent()).toHaveLength(0);
});
it("OFF before 0040/41/42 preserves actual V0 DB consultation and refuses new console work without absent-table access",async()=>{
  const original=state.db;vi.stubEnv("SAV_INTAKE_RUNTIME_MODE","off");vi.stubEnv("SAV_INTAKE_EXECUTION_MODE","off");
  const rollback=Error("SYNTHETIC_ROLLBACK");
  await expect(db.db.transaction(async tx=>{
    for (const statement of ["drop function sav.dirty_intake_console_row() cascade", "drop function sav.dirty_intake_console(uuid) cascade", "drop function sav.invalidate_intake_thread_context() cascade", "drop function sav.invalidate_intake_human_choice() cascade", "drop function sav.purge_intake_orphan_result() cascade"]) await tx.execute(sql.raw(statement));
    await tx.execute(sql`drop table sav.intake_effect_revisions,sav.intake_observation_bindings,sav.intake_human_events,sav.intake_console,sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies,sav.intake_execution_budget,sav.intake_journal,sav.intake_model_calls,sav.intake_runs cascade`);
    await tx.delete(savSyncState).where(sql`${savSyncState.key} in ('sav-intake-console-schema-v1','sav-intake-execution-schema-v1')`);
    state.db=tx;
    expect((await getSavThreadDetail(threadId))?.messages[0].id).toBe(messageId);
    expect(await enqueueConfiguredSavIntake(messageId)).toEqual({skipped:"off"});expect(await reconcileSavIntakeRuntime()).toEqual({skipped:"off"});
    expect((await listIntakeConsole()).installed).toBe(false);expect(await readIntakeConsoleDetail(threadId)).toBeNull();expect(await ensureIntakeObservations()).toEqual({skipped:"migration_absent"});
    throw rollback;
  })).rejects.toBe(rollback);
  state.db=original;
  expect(fetch).not.toHaveBeenCalled();
});

it("initial launch archives historical threads consistently after OFF without altering messages and resumes on a fresh inbound", async () => {
  const launch = {mailboxId, receivedAfter:new Date(Date.now()-1000).toISOString(), createdAfter:new Date(Date.now()-1000).toISOString()};
  const before=(await db.db.select().from(savMessages).where(eq(savMessages.id,messageId)))[0];
  await db.db.update(savMessages).set({receivedAt:new Date(Date.now()-3600000)}).where(eq(savMessages.id,messageId));
  await activateSavV0Cutover({receivedAfter:new Date(Date.now()-7200000).toISOString(),mailboxEmail:"support@example.invalid",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
  await enqueueSavTranslation(messageId);
  await recordIntakeLaunch(launch);
  vi.stubEnv("SAV_RELEASE_STAGE","v0");
  expect(await isSavMessageEligible(messageId)).toBe(true); // Existing knowledge provenance is not invalidated by automation archival.
  expect(await reconcileSavTranslations()).toHaveProperty("processed",[]);
  vi.stubEnv("SAV_INTAKE_RUNTIME_MODE","off");
  expect((await listIntakeConsole({view:"completed",search:"Synthetic"})).total).toBe(1);
  expect((await listIntakeConsole({view:"processing"})).total).toBe(0);
  expect((await readIntakeConsoleDetail(threadId))?.projection.status).toBe("historical_outside_automation");
  expect(await processStoredSavMessage(messageId)).toBeNull();
  expect(await processPendingSavMessages()).toHaveProperty("processed",[]);
  const after=(await db.db.select().from(savMessages).where(eq(savMessages.id,messageId)))[0];
  expect(after).toMatchObject({analysisStatus:before.analysisStatus,processedAt:before.processedAt,analysisAttempts:before.analysisAttempts,bodyCiphertext:before.bodyCiphertext});
  expect(await readIntakeLaunch(mailboxId)).toMatchObject(launch);
  await expect(recordIntakeLaunch({...launch,receivedAfter:new Date(Date.now()-500).toISOString()})).rejects.toThrow("LAUNCH_IMMUTABLE");
  await message(threadId,new Date());
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect((await listIntakeConsole({view:"processing"})).total).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
it("late ingestion of an old email and pre-launch creation both remain historical while new threads enter processing", async () => {
  const launch={mailboxId,receivedAfter:new Date(Date.now()-1000).toISOString(),createdAfter:new Date(Date.now()-1000).toISOString()};
  await recordIntakeLaunch(launch);
  const lateThread=(await db.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"customer@example.invalid"}).returning())[0];
  await message(lateThread.id,new Date(Date.now()-3600000),"Old ingested late");
  await db.db.update(savMessages).set({createdAt:new Date(Date.now()-3600000)}).where(eq(savMessages.id,messageId));
  const freshThread=(await db.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"customer@example.invalid"}).returning())[0];
  const fresh=await message(freshThread.id,new Date(),"Fresh incoming");
  expect((await listIntakeConsole({view:"completed"})).total).toBe(2);
  expect((await listIntakeConsole({view:"completed",search:"late"})).total).toBe(1);
  expect((await listIntakeConsole({view:"processing"})).total).toBe(1);
  expect((await listIntakeConsole({view:"processing"})).rows[0].messageId).toBe(fresh.id);
  expect(await enqueueSavIntakeMessage(fresh.id,options.runtime)).toBeNull(); // A different launch cannot silently become a new runtime boundary.
  expect(mutationsSent()).toHaveLength(0);expect(await db.db.select().from(savIntakeModelCalls)).toHaveLength(0);
});
async function revise(kind:"select"|"classify",fields:Partial<IntakeHumanCommand>) {
  const raw=await command(kind);
  const saved=await recordIntakeHumanCommand({...raw,...fields});
  return consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}));
}
it("human select102 -> finance -> select102 keeps all authenticated overrides and quotas",async()=>{
  await observed(true);
  expect(await revise("select",{contactId:"102"})).toHaveProperty("state","observed");
  expect(await revise("classify",{classification:"finance"})).toHaveProperty("state","observed");
  expect(await revise("select",{contactId:"102"})).toHaveProperty("state","observed");
  const current=(await readSavIntakeCurrent(threadId))!;
  expect(current.payload.plan?.decision).toMatchObject({classification:"finance",disposition:{kind:"ticket",target:{contactId:"102"}}});
  expect((current.payload.input as {humanResolution:{inheritedChoiceIds:string[]}}).humanResolution.inheritedChoiceIds).toHaveLength(2);
  expect((await db.db.select().from(savIntakeRuns)).reduce((s,r)=>s+r.attempts,0)).toBe(1);
  expect(await db.db.select().from(savIntakeModelCalls)).toHaveLength(0);expect(mutationsSent()).toHaveLength(0);
});
it("human finance -> select102 preserves the earlier sensitive classification",async()=>{
  await observed(true);
  expect(await revise("classify",{classification:"finance"})).toHaveProperty("state","waiting");
  expect(await revise("select",{contactId:"102"})).toHaveProperty("state","observed");
  expect((await readSavIntakeCurrent(threadId))?.payload.plan?.decision).toMatchObject({classification:"finance",disposition:{kind:"ticket",target:{contactId:"102"}}});
});
it("classification incompatible with a confirmed partial effect is held without changing receipts",async()=>{
  const {execution}=await partiallyConfirmedCreate();
  expect(await revise("classify",{classification:"finance"})).toHaveProperty("waiting","SAV_INTAKE_HUMAN_REVALIDATION_REQUIRED");
  expect((await getExecutionEffects(execution.id)).filter(e=>e.kind==="ticket_create"&&e.state==="confirmed")).toHaveLength(1);expect(mutationsSent().filter(c=>c.path==="/crm/v3/objects/tickets")).toHaveLength(1);
});
it("new sensitive history on another ticket-linked thread dirties the support projection and follows sensitive closure/reopening",async()=>{
  const {observation}=await supportClosedWithHumanEvidence();
  const originalBinding=(await readIntakeObservationBinding(observation.id))!;expect(originalBinding.sensitive).toBe(false);
  await projectIntakeThread(threadId);
  const other=(await db.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"other@example.invalid",hubspotTicketId:observation.hubspotTicketId}).returning())[0];
  const m=await message(other.id);
  const current=(await readSavIntakeCurrent(threadId))!;
  const plan=current.payload.plan!;
  await db.db.insert(savIntakeRuns).values({threadId:other.id,messageId:m.id,version:1,configHash:"f".repeat(64),policyHash:current.policyHash,isCurrent:false,state:"observed",payloadCiphertext:encryptSavPayload({...current.payload,plan:{...plan,decision:{...plan.decision,classification:"finance"}}})});
  expect((await listIntakeConsole({view:"learning"})).total).toBe(0);
  await syncSavObservation(observation.id,async ticketId=>({ticketId,status:"closed",subject:"Synthetic sensitive closure",updatedAt:new Date().toISOString(),events:[],errors:[]}));
  await projectIntakeThread(threadId);
  expect((await listIntakeConsole({view:"completed"})).rows.find(r=>r.threadId===threadId)?.status).toBe("not_applicable_sensitive");
  await syncSavObservation(observation.id,async ticketId=>({ticketId,status:"open",subject:"Synthetic reopened",updatedAt:new Date().toISOString(),events:[],errors:[]}));
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"sensitive"})).rows.some(r=>r.threadId===threadId)).toBe(true);
  expect((await readIntakeObservationBinding(observation.id))?.baselineHash).toBe(originalBinding.baselineHash);
});
it("launch while OFF holds fresh arrivals for catchup instead of legacy analysis",async()=>{
  await recordIntakeLaunch({mailboxId,receivedAfter:options.runtime.receivedAfter,createdAfter:options.runtime.createdAfter});
  vi.stubEnv("SAV_INTAKE_RUNTIME_MODE","off");
  expect(await enqueueConfiguredSavIntake(messageId)).toEqual({held:true});
  expect(await processStoredSavMessage(messageId)).toBeNull();
  expect((await db.db.select().from(savMessages).where(eq(savMessages.id,messageId)))[0]).toMatchObject({analysisStatus:"intake_pending",analysisAttempts:0,processedAt:null});
  expect(await db.db.select().from(savIntakeRuns)).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
  expect(await catchupSavIntake(options.runtime)).toBe(1);
});

it("new approved V0 message after intake keeps a separate baseline and can qualify; pending intake never falls back to old V0",async()=>{
  const {observation}=await supportClosedWithHumanEvidence();
  const baseline=(await readIntakeObservationBinding(observation.id))!.baselineHash;
  const m=await message(threadId,new Date());
  await db.db.update(savMessages).set({analysisStatus:"done"}).where(eq(savMessages.id,m.id));
  const proposal=v0Proposal();
  const [run]=await db.db.insert(savAgentRuns).values({messageId:m.id,runtime:"synthetic",mode:"off",status:"succeeded",model:"gemini-3.6-flash",promptRevision:"synthetic",inputHash:"synthetic",proposalCiphertext:encryptSavPayload(proposal)}).returning();
  const [decision]=await db.db.insert(savDecisions).values({messageId:m.id,agentRunId:run.id,kind:"ticket_pending",reasonCode:"fixture",explanation:"Synthetic current approved V0",confidence:800}).returning();
  await reviewSavProposal({reviewScope:"dossier",messageId:m.id,decisionId:decision.id,agentRunId:run.id,expectedReviewId:null,status:"approved",verdict:"correct",dimensions:{classification:"correct",routing:"correct",grounding:"correct",tone:"correct",escalation:"correct"},comment:"Synthetic current V0 validated manually.",reusability:"none",correction:{category:proposal.category,urgency:proposal.urgency,decisionKind:proposal.decision.kind,reasonCode:"fixture",explanation:"Synthetic current V0 review approved.",title:proposal.ticket.title,description:proposal.ticket.description,process:proposal.process,internalNote:"",replyDraft:proposal.replyDraft??""}},"ugo@limova.ai");
  expect(await readSavCaseLearningQualification(threadId)).toHaveProperty("allowed",true);
  const id=await db.db.transaction(tx=>ensureSavCaseObservationTx(tx,m.id,"ticket_confirmed"));
  expect(id).not.toBe(observation.id);expect((await readIntakeObservationBinding(observation.id))?.baselineHash).toBe(baseline);
  await db.db.update(savMessages).set({analysisStatus:"intake_pending"}).where(eq(savMessages.id,m.id));
  expect(await readSavCaseLearningQualification(threadId)).toHaveProperty("allowed",false);
});
it("administrator preview accepts the approved operational 5 USD pins and still refuses one nanoUSD more",async()=>{
  const runtime={...JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),budgetProfile:"operational_utc_v1",maxRollingNanoUsd:90000000000,maxCalls:300,maxNanoUsd:5000000000,expiresAt:new Date(Date.now()+29*86400000).toISOString()};
  for(const [key,value] of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);
  vi.stubEnv("SAV_INTAKE_RUNTIME_MODE","off");vi.stubEnv("SAV_INTAKE_RUNTIME_CONFIG",JSON.stringify(runtime));
  const policy={...options.policy,budgetProfile:"operational_utc_v1" as const,expiresAt:runtime.expiresAt},commandId=randomUUID();
  const preview=await previewIntakeLaunch(commandId,{runtime,policy});
  expect(preview.input.runtime).toMatchObject({maxNanoUsd:5000000000,maxRollingNanoUsd:90000000000,maxCalls:300});
  expect(await readIntakeLaunch(mailboxId)).toBeNull();
  const over={...runtime,maxNanoUsd:5000000001};vi.stubEnv("SAV_INTAKE_RUNTIME_CONFIG",JSON.stringify(over));
  await expect(previewIntakeLaunch(randomUUID(),{runtime:over,policy})).rejects.toThrow();
});
it("administrator preview is inert, immutable and commit is exact/idempotent while OFF",async()=>{
  for(const [key,value] of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);
  vi.stubEnv("SAV_INTAKE_RUNTIME_MODE","off");
  const input={runtime:JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),policy:options.policy},commandId=randomUUID();
  const previewResponse=await adminPost(new Request("https://studio.example.invalid/api/sav/intake-admin",{method:"POST",headers:{origin:"https://studio.example.invalid","content-type":"application/json"},body:JSON.stringify({operation:"preview",commandId,input})}));
  expect(previewResponse.status).toBe(200);
  const preview=await previewResponse.json();
  expect(await readIntakeLaunch(mailboxId)).toBeNull();
  expect(await previewIntakeLaunch(commandId,input)).toEqual(preview);
  await expect(previewIntakeLaunch(commandId,{...input,policy:{...options.policy,maxDossiers:99}})).rejects.toThrow("PREVIEW_CONFLICT");
  await expect(commitIntakeLaunch(commandId,"b".repeat(64))).rejects.toThrow("PREVIEW_CONFLICT");
  const commitResponse=await adminPost(new Request("https://studio.example.invalid/api/sav/intake-admin",{method:"POST",headers:{origin:"https://studio.example.invalid","content-type":"application/json"},body:JSON.stringify({operation:"commit",commandId,hash:preview.hash})}));
  expect(commitResponse.status).toBe(200);
  const receipt=await commitResponse.json();
  expect(await commitIntakeLaunch(commandId,preview.hash)).toEqual(receipt);
  expect(await enqueueConfiguredSavIntake(messageId)).toEqual({held:true});
  expect(fetch).not.toHaveBeenCalled();expect(mutationsSent()).toHaveLength(0);
});
it("admin HTTP requires same origin/JSON/strict active admin and bounds input",async()=>{
  const url="https://studio.example.invalid/api/sav/intake-admin";
  expect((await adminPost(new Request(url,{method:"POST",headers:{origin:"https://attacker.invalid","content-type":"application/json"},body:"{}"}))).status).toBe(403);
  expect((await adminPost(new Request(url,{method:"POST",headers:{origin:"https://studio.example.invalid","content-type":"text/plain"},body:"{}"}))).status).toBe(415);
  expect((await adminPost(new Request(url,{method:"POST",headers:{origin:"https://studio.example.invalid","content-type":"application/json"},body:"x".repeat(20001)}))).status).toBe(413);
  state.user=null;
  expect((await adminPost(new Request(url,{method:"POST",headers:{origin:"https://studio.example.invalid","content-type":"application/json"},body:JSON.stringify({operation:"revoke",policyId:options.config.policyId,reason:"Synthetic explicit revoke"})}))).status).toBe(403);
});

it("historical pending HubSpot/Gmail actions and followups cannot monopolize the worker LIMIT",async()=>{
  vi.stubEnv("SAV_RELEASE_STAGE","v0");vi.stubEnv("SAV_AUTOMATION_MODE","assist");vi.stubEnv("SAV_WRITES_DISABLED","false");
  await db.db.update(savMessages).set({receivedAt:new Date(Date.now()-3600000)}).where(eq(savMessages.id,messageId));
  await recordIntakeLaunch({mailboxId,receivedAfter:new Date(Date.now()-1000).toISOString(),createdAfter:new Date(Date.now()-1000).toISOString()});
  for(const kind of ["log_email","send_reply"] as const)await db.db.insert(savActions).values(Array.from({length:120},(_,i)=>({threadId,messageId:i%3?messageId:null,kind,actorType:"human" as const,idempotencyKey:randomUUID(),createdAt:new Date(Date.now()-3600000),payload:{manualReplyConfirmed:true}})));
  await db.db.insert(savFollowups).values(Array.from({length:51},(_,i)=>({threadId,sequence:i+1,dueAt:new Date(Date.now()-3600000)})));
  const freshThread=(await db.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"fresh@example.invalid",status:"awaiting_customer"}).returning())[0];
  const fresh=await message(freshThread.id);
  const [hs]=await db.db.insert(savActions).values({threadId:freshThread.id,messageId:fresh.id,kind:"log_email",actorType:"human",idempotencyKey:randomUUID(),payload:{}}).returning();
  const [gm]=await db.db.insert(savActions).values({threadId:freshThread.id,messageId:fresh.id,kind:"send_reply",actorType:"human",idempotencyKey:randomUUID(),payload:{manualReplyConfirmed:true}}).returning();
  const [followup]=await db.db.insert(savFollowups).values({threadId:freshThread.id,sequence:1,dueAt:new Date()}).returning();
  await processPendingHubspotActions(1);await processPendingGmailSendActions(1);await processDueFollowups(1);
  expect((await db.db.select().from(savActions).where(eq(savActions.id,hs.id)))[0].attemptCount).toBe(1);
  expect((await db.db.select().from(savActions).where(eq(savActions.id,gm.id)))[0].attemptCount).toBe(1);
  expect((await db.db.select().from(savActions).where(eq(savActions.threadId,threadId))).every(a=>a.attemptCount===0&&a.status==="pending")).toBe(true);
  expect((await db.db.select().from(savFollowups).where(eq(savFollowups.id,followup.id)))[0].status).toBe("queued");
  expect((await db.db.select().from(savFollowups).where(eq(savFollowups.threadId,threadId))).every(f=>f.status==="scheduled")).toBe(true);
});

it("select102 -> Other -> Support/Finance preserves the separately authenticated candidate group",async()=>{
  await observed(true);expect(await revise("select",{contactId:"102"})).toHaveProperty("state","observed");
  expect(await revise("classify",{classification:"other"})).toHaveProperty("state","observed");
  const other=(await readSavIntakeCurrent(threadId))!;expect(other.payload.plan?.candidateContactIds).toBeUndefined();expect(other.candidateContactIds).toEqual(["101","102"]);
  expect(await revise("classify",{classification:"support"})).toHaveProperty("state","observed");
  expect((await readSavIntakeCurrent(threadId))?.payload.plan?.decision).toMatchObject({classification:"support",disposition:{kind:"ticket",target:{contactId:"102"}}});
  expect(await revise("classify",{classification:"other"})).toHaveProperty("state","observed");
  expect(await revise("classify",{classification:"finance"})).toHaveProperty("state","observed");
  expect((await readSavIntakeCurrent(threadId))?.payload.plan?.decision).toMatchObject({classification:"finance",disposition:{kind:"ticket",target:{contactId:"102"}}});
  expect((await db.db.select().from(savIntakeRuns)).reduce((sum,r)=>sum+r.attempts,0)).toBe(1);expect(await db.db.select().from(savIntakeModelCalls)).toHaveLength(0);expect(mutationsSent()).toHaveLength(0);
});
it("returning from Other still revalidates real CRM candidates rather than trusting the inherited group",async()=>{
  await observed(true);await revise("select",{contactId:"102"});await revise("classify",{classification:"other"});
  p.setContacts([{id:"101",emails:["customer@example.invalid"]}]);
  const result=await revise("classify",{classification:"support"});
  expect("waiting" in result||"state" in result&&result.state==="waiting").toBe(true);expect(mutationsSent()).toHaveLength(0);
});
it("confirmed own local deltas show a current completion result without enabling another human execution",async()=>{
  await observed();const execution=(await admitIntakeExecution(runId,options))!;await executeIntakePass(execution.id,options);
  const detail=(await readIntakeConsoleDetail(threadId))!;
  expect(detail.current?.sourceMatches).toBe(false);expect(detail.confirmedCurrent).toBe(true);expect(detail.progress?.confirmed).toBe(true);
  await expect(recordIntakeHumanCommand(await command("classify"))).rejects.toThrow("HUMAN_CONFLICT");
  await db.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"Actual later source edit",headers:{},attachments:[]})}).where(eq(savMessages.id,messageId));
  expect((await readIntakeConsoleDetail(threadId))?.confirmedCurrent).toBe(false);
});
it("administrator server actions preserve the same exact preview/commit/revoke primitives with no provider effects",async()=>{
  for(const [key,value] of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);vi.stubEnv("SAV_INTAKE_RUNTIME_MODE","off");
  const form=new FormData();form.set("commandId",randomUUID());form.set("configuration",JSON.stringify({runtime:JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!),policy:options.policy}));
  const preview=await previewLaunchAction({ok:false,message:""},form);expect(preview.ok).toBe(true);expect(await readIntakeLaunch(mailboxId)).toBeNull();
  const confirmation=new FormData();confirmation.set("previewId",preview.preview!.id);confirmation.set("hash",preview.preview!.hash);
  const committed=await commitLaunchAction({ok:false,message:""},confirmation);expect(committed.ok).toBe(true);expect(await commitLaunchAction(committed,confirmation)).toEqual(committed);
  const revoked=new FormData();revoked.set("policyId",committed.receipt!.policyId);revoked.set("reason","Synthetic explicit authority revocation.");
  expect(await revokeLaunchAction({ok:false,message:""},revoked)).toHaveProperty("ok",true);expect(await revokeLaunchAction({ok:false,message:""},revoked)).toHaveProperty("ok",true);
  expect(fetch).not.toHaveBeenCalled();expect(mutationsSent()).toHaveLength(0);
});

it("an accepted equivalent subset101/102 within lookup101/102/103 remains selectable after Other",async()=>{
  p.setContacts(["101","102","103"].map(id=>({id,emails:["customer@example.invalid"]})));
  await observed(false,false,true,["101","102"]);
  expect((await readSavIntakeCurrent(threadId))?.candidateContactIds).toEqual(["101","102"]);
  expect(await revise("select",{contactId:"102"})).toHaveProperty("state","observed");
  await revise("classify",{classification:"other"});
  expect(await revise("classify",{classification:"support"})).toHaveProperty("state","observed");
  expect((await readSavIntakeCurrent(threadId))?.payload.plan?.decision.disposition).toMatchObject({kind:"ticket",target:{contactId:"102"}});
  expect((await db.db.select().from(savIntakeRuns)).reduce((sum,run)=>sum+run.attempts,0)).toBe(1);
  expect(await db.db.select().from(savIntakeModelCalls)).toHaveLength(0);expect(mutationsSent()).toHaveLength(0);
});
it("a formerly authenticated equivalent group disappearing entirely cannot become an identification template",async()=>{
  await observed(true);await revise("select",{contactId:"102"});await revise("classify",{classification:"other"});
  p.setContacts([]);await revise("classify",{classification:"support"});
  const current=(await readSavIntakeCurrent(threadId))!;
  expect(current.state).toBe("waiting");
  expect(current.payload.plan?.decision.disposition).toMatchObject({kind:"collect_context",reasons:expect.arrayContaining(["contact_ambiguous"])});
  expect(current.payload.plan?.steps).toEqual([]);expect(mutationsSent()).toHaveLength(0);
  expect(await db.db.select().from(savIntakeModelCalls)).toHaveLength(0);
});

it.each(["single","equivalent","other"]) ("Other -> support reanalysis preserves ledger and fresh candidate selection (%s)",async(mode)=>{
  const multiple=mode!=="single";
  if(multiple)p.setContacts(["101","102"].map(id=>({id,emails:["customer@example.invalid"]})));
  for(const [key,value] of Object.entries(environment)) if(value!==undefined)vi.stubEnv(key,value);
  const id=(await enqueueSavIntakeMessage(messageId,options.runtime))!,lease=(await claimSavIntakeRun(id,options.runtime))!;
  const semantics:AcceptedIntakeSemantics={revision:SAV_INTAKE_SEMANTIC_RECORD_REVISION,validatorRevision:SAV_INTAKE_MODEL_REVISION,records:[]};
  const semantic=recordAcceptedIntakeSemantics({analyseMessage:async()=>({messageId,requests:[{id:"noise",kind:"other",currentMessageId:messageId}]}),
    assessIssues:async()=>({investigationComplete:true,tickets:[]})},semantics,()=>{});
  const plan=await planSavIntake(lease.input,{...createSavIntakeHubspotReaders({network:p.network}),...semantic},
    {...options.runtime.policy,qualifiedOther:{evidenceSource:"private_rule",resource:{resourceId:"synthetic-rule",revisionId:"v1",sha256:"a".repeat(64)}}},{},()=>new Date());
  expect(plan.progress.kind).toBe("qualified_other");
  const original:IntakeRuntimePayload={revision:SAV_INTAKE_RUNTIME_REVISION,input:lease.input,plan,semantics,effects:"not_connected",configuration:{configHash:options.runtime.configHash,policyHash:options.runtime.policyHash,resourcesHash:options.runtime.resourcesHash,codeRevision:options.runtime.codeRevision,model:options.runtime.model}};
  await saveSavIntakeResult(lease,options.runtime,original,"observed");runId=id;
  const usage={inputTokens:100,outputTokens:50,thoughtTokens:0,totalTokens:150};
  await db.db.insert(savIntakeModelCalls).values({runId:id,messageKey:intakeRuntimeHash(messageId),requestHash:"b".repeat(64),state:"settled",reservedNanoUsd:817152000,chargedNanoUsd:262500,payloadCiphertext:encryptSavPayload({metadata:usage})});
  const network=vi.fn(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
    const body=JSON.parse(String(init?.body)),data=JSON.parse(body.contents[0].parts[0].text);let answer:unknown;
    if(data.candidates){
      answer={kind:"equivalent",investigationComplete:true,contactIds:data.candidates.map((c:{contactId:string})=>c.contactId),evidenceIds:data.evidence.map((e:{id:string})=>e.id),grounding:data.citationCatalogue.map((c:{id:string})=>({quoteId:c.id})),rationale:"Synthetic equivalent candidates"};
    }else if(!data.tickets){
      expect(data.operatorCorrection).toBe("support");
      answer={messageId,requests:[{id:"r1",kind:mode==="other"?"other":"support",currentMessageId:messageId,quoteId:data.citationCatalogue.find((c:{sourceId:string})=>c.sourceId==="current").id}],ticketSummary:{title:"Synthetic connection failure",description:"The synthetic connection fails.",requestIds:["r1"]}};
    }else answer={investigationComplete:true,tickets:data.tickets.map((t:{ticket:{id:string}})=>({ticketId:t.ticket.id,relation:"same",requestIds:["r1"],evidenceIds:["current",`ticket-${t.ticket.id}`,`history-${t.ticket.id}`],grounding:data.citationCatalogue.map((c:{id:string})=>({quoteId:c.id})),rationale:"Synthetic matching sources"}))};
    return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(answer)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,thoughtsTokenCount:0,totalTokenCount:150}});
  });vi.stubGlobal("fetch",network);
  const raw={...await command("classify"),classification:"support" as const},recorded=await recordIntakeHumanCommand(raw);
  expect((await consumeIntakeHumanEvent(recorded.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network})))).toHaveProperty("state",multiple?"waiting":"observed");
  const current=(await readSavIntakeCurrent(threadId,options.runtime))!;
  expect(current.payload.plan?.decision.classification).toBe("support");expect(current.payload.plan?.decision.disposition.kind).toBe(multiple?"collect_context":"ticket");
  if(multiple){
    expect(current.candidateContactIds).toEqual(["101","102"]);
    const changed=structuredClone(current.payload);changed.plan!.candidateContactIds=["999"];
    expect(await intakeRunCandidateContactIds(current,changed)).toBeNull();
    expect(await intakeRunCandidateContactIds({...current,sourceHash:"f".repeat(64)},current.payload)).toBeNull();
    const journals=await db.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId,current.id));
    const reanalysis=journals.find(row=>row.kind==="human_reanalysis")!;expect(reanalysis).toBeTruthy();
    const [duplicate]=await db.db.insert(savIntakeJournal).values({runId:current.id,kind:"human_reanalysis",payloadCiphertext:reanalysis.payloadCiphertext}).returning();
    expect(await intakeRunCandidateContactIds(current,current.payload)).toBeNull();
    await db.db.delete(savIntakeJournal).where(eq(savIntakeJournal.id,duplicate.id));
    await db.db.delete(savIntakeJournal).where(eq(savIntakeJournal.id,reanalysis.id));
    expect(await intakeRunCandidateContactIds(current,current.payload)).toEqual([]);
    await db.db.insert(savIntakeJournal).values(reanalysis);
    expect(await revise("select",{contactId:"102"})).toHaveProperty("state","observed");
    const selected=(await readSavIntakeCurrent(threadId,options.runtime))!;
    expect(selected.payload.plan?.decision.classification).toBe("support");
    expect(selected.payload.plan?.decision.disposition).toMatchObject({kind:"ticket",target:{contactId:"102"}});
  }
  expect(current.id).not.toBe(id);expect(current.humanChoice).toMatchObject({eventId:recorded.eventId});
  expect((await db.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,id)))[0].state).toBe("superseded");
  const calls=await db.db.select().from(savIntakeModelCalls);expect(calls).toHaveLength(multiple?3:2);expect(network).toHaveBeenCalledTimes(multiple?2:1);expect(calls.every(c=>c.state==="settled")).toBe(true);
  expect(mutationsSent()).toHaveLength(0);await projectIntakeThread(threadId);
  expect((await listIntakeConsole({view:"other"})).total).toBe(0);
});

it("excludes more than a batch of historical console rows before LIMIT and admits new mail in an old thread", async () => {
  const launch = {mailboxId, receivedAfter:new Date(Date.now()-1000).toISOString(), createdAfter:new Date(Date.now()-1000).toISOString()};
  await db.db.update(savMessages).set({receivedAt:new Date(Date.now()-3600000)}).where(eq(savMessages.id,messageId));
  for (let i=0;i<25;i++) {
    const [thread]=await db.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"customer@example.invalid"}).returning();
    await message(thread.id,new Date(Date.now()-3600000),"Synthetic old mail");
  }
  await recordIntakeLaunch(launch);
  const [freshThread]=await db.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"customer@example.invalid"}).returning();
  const fresh=await message(freshThread.id);
  expect(await refreshIntakeConsole(1)).toEqual({refreshed:1});
  const [projected]=await db.db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId,freshThread.id));
  expect(projected.messageId).toBe(fresh.id); expect(projected.projectedEpoch).toBe(projected.epoch);
  expect(await refreshIntakeConsole(1)).toEqual({refreshed:0});
  const newInOld=await message(threadId,new Date(Date.now()+1));
  expect(await refreshIntakeConsole(1)).toEqual({refreshed:1});
  const [reopened]=await db.db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId,threadId));
  expect(reopened.messageId).toBe(newInOld.id);expect(reopened.projectedEpoch).toBe(reopened.epoch);
  expect((await listIntakeConsole({view:"completed"})).total).toBe(25);
  expect(fetch).not.toHaveBeenCalled();expect(mutationsSent()).toHaveLength(0);
});

it("administrator recovery preserves automatic attempts and is once per current message without external writes",async()=>{
 await observed();for(const [key,value]of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);
 await db.db.update(savIntakeRuns).set({attempts:2,state:"waiting"}).where(eq(savIntakeRuns.id,runId));
 const before=(await db.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,runId)))[0];
 const request={threadId,messageId,reason:"Synthetic explicit re-investigation after a verified software correction."};
 const result=await requestIntakeReinvestigation(request);
 expect(result.eventId).toBeTruthy();expect(mutationsSent()).toHaveLength(0);
 const old=(await db.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,runId)))[0];
 expect(old.attempts).toBe(2);expect(old.payloadCiphertext).toBe(before.payloadCiphertext);expect(old.isCurrent).toBe(false);
 const current=(await readSavIntakeCurrent(threadId,options.runtime))!;
 expect(current.id).toBe(result.runId);expect(current.attempts).toBe(0);
 expect(current.payload.plan?.decision.disposition.kind).toBe("collect_context");
 expect(current.payload.semantics).toBeUndefined();
 const [event]=await db.db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id,result.eventId));
 expect(decryptSavPayload<HumanEventPayload>(event.payloadCiphertext)).toMatchObject({reinvestigate:true});
 expect((await db.db.select().from(savIntakeModelCalls))).toHaveLength(0);
 await expect(requestIntakeReinvestigation(request)).rejects.toThrow("RECOVERY_CONFLICT");
});
it.each(["paused","newer","refused","nonadmin","historical"])("administrator recovery refuses %s without resetting anything",async kind=>{
 await observed();for(const [key,value]of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);
 if(kind==="paused")await db.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));
 if(kind==="newer")await message();
 if(kind==="refused")await recordIntakeHumanCommand(await command("refuse"));
 if(kind==="nonadmin")await db.db.update(staffUsers).set({role:"member"});
 if(kind==="historical")await db.db.update(savMessages).set({receivedAt:new Date(0)}).where(eq(savMessages.id,messageId));
 await expect(requestIntakeReinvestigation({threadId,messageId,reason:"Synthetic bounded operator recovery request."})).rejects.toThrow();
 expect((await db.db.select().from(savIntakeRuns))).toHaveLength(1);expect(mutationsSent()).toHaveLength(0);
});

it("recovery runs a fresh budgeted analysis and retains no-send across the next operator choice",async()=>{
 await observed();for(const [key,value]of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);
 await db.db.update(savIntakeRuns).set({attempts:2,state:"waiting"}).where(eq(savIntakeRuns.id,runId));
 stubRecoveryModel();
 const requested=await requestIntakeReinvestigation({threadId,messageId,reason:"Synthetic post-correction explicit operator investigation."});
 expect(await consumeIntakeHumanEvent(requested.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
 let current=(await readSavIntakeCurrent(threadId,options.runtime))!;
 expect((current.payload.input as {humanResolution:{suppressOutbound:boolean}}).humanResolution.suppressOutbound).toBe(true);
 expect(await intakeRunConfigurationBound(current,options.runtime)).toBe(true);
 const calls=await db.db.select().from(savIntakeModelCalls);expect(calls.length).toBeGreaterThan(0);expect(calls.every(c=>c.state==="settled")).toBe(true);
 const followup=await recordIntakeHumanCommand({...await command("classify"),classification:"support"});
 expect(await consumeIntakeHumanEvent(followup.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
 current=(await readSavIntakeCurrent(threadId,options.runtime))!;
 expect((current.payload.input as {humanResolution:{suppressOutbound:boolean}}).humanResolution.suppressOutbound).toBe(true);
 expect(await intakeRunConfigurationBound(current,options.runtime)).toBe(true);
 expect((await db.db.select().from(savIntakeModelCalls))).toHaveLength(calls.length);
 expect((await db.db.select().from(savIntakeRuns)).reduce((n,r)=>n+r.attempts,0)).toBe(2);expect(mutationsSent()).toHaveLength(0);
});

function stubRecoveryModel(){
 vi.stubGlobal("fetch",vi.fn(async(url,init)=>{
  expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
  const data=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
  const answer=data.tickets?{investigationComplete:true,tickets:data.tickets.map((t:{ticket:{id:string}})=>({ticketId:t.ticket.id,relation:"same",requestIds:["r1"],evidenceIds:["current",`ticket-${t.ticket.id}`,`history-${t.ticket.id}`],grounding:data.citationCatalogue.map((c:{id:string})=>({quoteId:c.id})),rationale:"Synthetic exact coverage"}))}
   :{messageId,requests:[{id:"r1",kind:"support",currentMessageId:messageId,quoteId:data.citationCatalogue.find((c:{sourceId:string})=>c.sourceId==="current").id}],ticketSummary:{title:"Synthetic connection failure",description:"The synthetic connection fails.",requestIds:["r1"]}};
  return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(answer)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,thoughtsTokenCount:0,totalTokenCount:150}});
 }));
}

it.each(["valid","old_authority_active","departed","leased","new_admin_inactive"])("recovered unsent execution authority rebinding: %s",async mode=>{
 await observed();const execution=(await admitIntakeExecution(runId,options))!;
 const oldPayload=decryptSavPayload<Record<string,unknown>>(execution.payloadCiphertext);
 await db.db.update(savIntakeExecutions).set({payloadCiphertext:encryptSavPayload({...oldPayload,runtimeConfigHash:"f".repeat(64)})}).where(eq(savIntakeExecutions.id,execution.id));
 for(const [key,value]of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);
 stubRecoveryModel();const requested=await requestIntakeReinvestigation({threadId,messageId,reason:"Synthetic explicit post-release recovery without outbound permission."});
 expect(await consumeIntakeHumanEvent(requested.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
 const current=(await readSavIntakeCurrent(threadId,options.runtime))!;
 const beforeBudget=await db.db.select().from(savIntakeExecutionBudget),calls=await db.db.select().from(savIntakeModelCalls);
 const next=await approveIntakeExecutionPolicy(options.policy);
 if(mode!=="old_authority_active")await db.db.update(savIntakeExecutionPolicies).set({state:"revoked"}).where(eq(savIntakeExecutionPolicies.id,execution.policyId));
 environment={...environment,SAV_INTAKE_EXECUTION_POLICY_ID:next.id,SAV_INTAKE_EXECUTION_POLICY_SHA256:next.policyHash};
 options={...options,config:intakeExecutionConfig(environment)!};
 if(mode==="departed")await db.db.insert(savIntakeEffects).values({id:randomUUID(),executionId:execution.id,businessKey:"synthetic-departure",kind:"ticket_create",permission:"create_ticket",state:"uncertain",intentHash:"a".repeat(64),intentCiphertext:encryptSavPayload({}),dispatchedAt:new Date()});
 if(mode==="leased")await db.db.update(savIntakeExecutions).set({leaseUntil:new Date(Date.now()+60000)}).where(eq(savIntakeExecutions.id,execution.id));
 if(mode==="new_admin_inactive")await db.db.update(staffUsers).set({active:false});
 if(mode!=="valid"){
  await expect(admitIntakeExecution(current.id,options)).rejects.toThrow("RECOVERY_AUTHORITY_REBIND_REFUSED");
  expect((await db.db.select().from(savIntakeExecutions))[0].policyId).toBe(execution.policyId);expect(mutationsSent()).toHaveLength(0);
 }else{
  expect((await reconcileIntakeExecutor({env:()=>environment,adapters:options.adapters}))).toHaveProperty("state","confirmed");
  const rebound=(await db.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id,execution.id)))[0];expect(rebound.id).toBe(execution.id);expect(rebound.policyId).toBe(next.id);
  expect(decryptSavPayload<{runtimeConfigHash:string}>(rebound.payloadCiphertext).runtimeConfigHash).toBe(options.runtime.configHash);
  expect(rebound.state).toBe("confirmed");
  expect(p.calls.filter(c=>c.path==="/crm/v3/objects/tickets"&&c.method==="POST")).toHaveLength(1);expect(p.calls.filter(c=>c.path==="gmail/messages/send")).toHaveLength(0);
 }
 expect(await db.db.select().from(savIntakeExecutionBudget)).toEqual(beforeBudget);expect(await db.db.select().from(savIntakeModelCalls)).toEqual(calls);
});

// Human dispositions are local administrative evidence, never an AI outcome.
async function externalMarker(overrides: Record<string, unknown> = {}, actorEmail = "ugo@limova.ai") {
  const [m] = await db.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  return (await db.db.insert(auditLogs).values({ actorEmail, action: SAV_EXTERNAL_COMPLETION, entityType: "sav_message", entityId: m.id,
    technicalMetadata: { version: 1, threadId, batchId: randomUUID(), receivedBefore: new Date().toISOString(), reason: "processed_outside_studio", ...overrides } }).returning())[0];
}
it.each(["other", "to_validate"] as const)("administrative %s routing is immediate without model provenance and never shown as completed", async disposition => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
  await activateSavV0Cutover({receivedAfter:new Date(Date.now()-3600000).toISOString(),mailboxEmail:"support@example.invalid",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
  const beforeCalls = await db.db.select().from(savIntakeModelCalls);
  await db.db.insert(savIntakeConsole).values({threadId,mailboxId}).onConflictDoNothing();
  const result = await markSavDossiersHandledExternally({batchId:randomUUID(),receivedBefore:new Date().toISOString(),disposition,messages:[{threadId,messageId}]},"ugo@limova.ai");
  expect(result.marked).toBe(1);
  const list=await listIntakeConsole({view:disposition}),detail=await readIntakeConsoleDetail(threadId);
  expect(list.total).toBe(1);expect(list.rows[0].view).toBe(disposition);expect(list.rows[0].status).toBe(disposition==="other"?"human_other":"human_review");
  expect(detail?.projection.view).toBe(disposition);expect(detail?.confirmedCurrent).toBe(false);
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);expect((await listIntakeConsole()).total).toBe(0);
  expect(await pendingSavIntakeRuns(options.runtime)).toHaveLength(0);expect(await catchupSavIntake(options.runtime)).toBe(0);
  expect(await db.db.select().from(savIntakeModelCalls)).toEqual(beforeCalls);expect(mutationsSent()).toHaveLength(0);
});
it("administrative review can later be completed; an older routing does not capture a new inbound",async()=>{
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
  await activateSavV0Cutover({receivedAfter:new Date(Date.now()-3600000).toISOString(),mailboxEmail:"support@example.invalid",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
  await db.db.insert(savIntakeConsole).values({threadId,mailboxId}).onConflictDoNothing();
  await markSavDossiersHandledExternally({batchId:randomUUID(),receivedBefore:new Date().toISOString(),disposition:"to_validate",messages:[{threadId,messageId}]},"ugo@limova.ai");
  const result=await completeSavDossierManually({requestKey:randomUUID(),threadId,messageId,confirmed:true});expect(result.marked).toBe(1);
  expect((await listIntakeConsole({view:"completed"})).total).toBe(1);expect((await listIntakeConsole({view:"to_validate"})).total).toBe(0);
  await message();expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect((await listIntakeConsole()).total).toBe(1);
});
it("invalid manual dispositions are refused rather than silently treated as completed",async()=>{
  await expect(markSavDossiersHandledExternally({batchId:randomUUID(),receivedBefore:new Date().toISOString(),disposition:"resolved_by_ai",messages:[{threadId,messageId}]},"ugo@limova.ai")).rejects.toThrow();
  await externalMarker({disposition:"resolved_by_ai"});expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
});
it("read receipt is durable and independently retried without any CRM action",async()=>{
  const command=await prepareManualCompletion(false);
  expect((await completeSavDossierManually(command)).marked).toBe(1);
  await db.db.update(savMailboxes).set({email:"contact@limova.ai"}).where(eq(savMailboxes.id,mailboxId));
  await db.db.update(savMessages).set({gmailMessageId:"1a123"}).where(eq(savMessages.id,messageId));
  await db.db.update(savThreads).set({gmailThreadId:"1a000"}).where(eq(savThreads.id,threadId));
  let unread=true,writes=0,fail=true;
  const gmail: GmailRequest=async<T>(_mailbox:string,path:string,init?:RequestInit)=>{
    if(path==="profile")return {emailAddress:"contact@limova.ai"} as T;
    if(init?.method==="POST"){writes++;unread=false;if(fail)throw Error("TIMEOUT");return {} as T;}
    return {id:"1a123",threadId:"1a000",labelIds:["INBOX",...unread?["UNREAD"]:[]]} as T;
  };
  const deps={env:()=>({...environment,SAV_INTAKE_GMAIL_MARK_READ:"on"}),gmail};
  expect(await syncHandledIntakeGmailRead(messageId,deps)).toMatchObject({confirmed:false});
  fail=false;expect(await syncHandledIntakeGmailRead(messageId,deps)).toEqual({confirmed:true});
  expect(await syncHandledIntakeGmailRead(messageId,deps)).toEqual({skipped:"already_confirmed"});expect(writes).toBe(1);
  expect((await db.db.select().from(auditLogs).where(eq(auditLogs.action,SAV_INTAKE_GMAIL_READ)))).toHaveLength(1);
  expect(mutationsSent()).toHaveLength(0);
});
it("a merely analysed dossier is never marked read",async()=>{
  await observed();const gmail=vi.fn();
  expect(await syncHandledIntakeGmailRead(messageId,{env:()=>({...environment,SAV_INTAKE_GMAIL_MARK_READ:"on"}),gmail})).toEqual({skipped:"not_handled"});
  expect(gmail).not.toHaveBeenCalled();expect(mutationsSent()).toHaveLength(0);
});
it("a formerly confirmed execution with changed local context stays unread",async()=>{
  await observed();const execution=(await admitIntakeExecution(runId,options))!;expect((await executeIntakePass(execution.id,options))).toMatchObject({state:"confirmed"});
  await db.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:"Updated customer evidence changes the understood request.",attachments:[],headers:{}})}).where(eq(savMessages.id,messageId));
  const gmail=vi.fn();expect(await syncHandledIntakeGmailRead(messageId,{env:()=>({...environment,SAV_INTAKE_GMAIL_MARK_READ:"on"}),gmail})).toEqual({skipped:"not_handled"});expect(gmail).not.toHaveBeenCalled();
});
it("a fully confirmed current execution is marked read using its completion source, including its own new ticket",async()=>{
  await observed();const execution=(await admitIntakeExecution(runId,options))!;expect(await executeIntakePass(execution.id,options)).toMatchObject({state:"confirmed"});
  await db.db.update(savMailboxes).set({email:"contact@limova.ai"}).where(eq(savMailboxes.id,mailboxId));
  await db.db.update(savMessages).set({gmailMessageId:"1a123"}).where(eq(savMessages.id,messageId));
  await db.db.update(savThreads).set({gmailThreadId:"1a000"}).where(eq(savThreads.id,threadId));
  let unread=true;const gmail:GmailRequest=async<T>(_mailbox:string,path:string,init?:RequestInit)=>{
    if(path==="profile")return {emailAddress:"contact@limova.ai"} as T;
    if(init?.method==="POST"){unread=false;return {} as T;}
    return {id:"1a123",threadId:"1a000",labelIds:["INBOX",...unread?["UNREAD"]:[]]} as T;
  };
  expect(await syncHandledIntakeGmailRead(messageId,{env:()=>({...environment,SAV_INTAKE_GMAIL_MARK_READ:"on"}),gmail})).toEqual({confirmed:true});
  expect(unread).toBe(false);
});
it("SAV-33 an agent pause keeps a confirmed dossier unread until resume, without a Gmail call or failure marker",async()=>{
  await observed();const execution=(await admitIntakeExecution(runId,options))!;expect(await executeIntakePass(execution.id,options)).toMatchObject({state:"confirmed"});
  await db.db.update(savMailboxes).set({email:"contact@limova.ai"}).where(eq(savMailboxes.id,mailboxId));
  await db.db.update(savMessages).set({gmailMessageId:"1a123"}).where(eq(savMessages.id,messageId));
  await db.db.update(savThreads).set({gmailThreadId:"1a000"}).where(eq(savThreads.id,threadId));
  const pause=async(level:string)=>{const values={key:"sav-agent-pause.v1:intake",status:"active",updatedAt:new Date(),cursor:encryptSavPayload({revision:"sav-agent-pause.v1",agent:"intake",level,setBy:"ugo@limova.ai",setAt:new Date().toISOString(),reason:"synthetic"})};
    await db.db.insert(savSyncState).values(values).onConflictDoUpdate({target:savSyncState.key,set:values});};
  let unread=true,calls=0;const gmail:GmailRequest=async<T>(_mailbox:string,path:string,init?:RequestInit)=>{
    calls++;if(path==="profile")return {emailAddress:"contact@limova.ai"} as T;
    if(init?.method==="POST"){unread=false;return {} as T;}
    return {id:"1a123",threadId:"1a000",labelIds:["INBOX",...unread?["UNREAD"]:[]]} as T;
  };
  const deps={env:()=>({...environment,SAV_INTAKE_GMAIL_MARK_READ:"on"}),gmail};
  try{
    await pause("actions_paused");
    expect(await syncHandledIntakeGmailRead(messageId,deps)).toEqual({skipped:"SAV_INTAKE_AGENT_ACTIONS_PAUSED"});
    expect(calls).toBe(0);expect(await db.db.select().from(auditLogs).where(eq(auditLogs.action,"sav_intake_gmail_read_failed"))).toHaveLength(0);
    await pause("running");
    expect(await syncHandledIntakeGmailRead(messageId,deps)).toEqual({confirmed:true});expect(unread).toBe(false);
  }finally{await db.db.delete(savSyncState).where(eq(savSyncState.key,"sav-agent-pause.v1:intake"));}
});
it("revoked administrative markers cannot starve the next valid Gmail receipt",async()=>{
  vi.stubEnv("SAV_RELEASE_STAGE","v0");vi.stubEnv("SAV_PILOT_MODE","false");
  await activateSavV0Cutover({receivedAfter:new Date(Date.now()-3600000).toISOString(),mailboxEmail:"support@example.invalid",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
  await db.db.update(savMailboxes).set({email:"contact@limova.ai"}).where(eq(savMailboxes.id,mailboxId));
  for(let n=0;n<3;n++){
    const t=(await db.db.insert(savThreads).values({mailboxId,gmailThreadId:`poison-${n}`,customerEmail:"customer@example.invalid"}).returning())[0];
    const m=await message(t.id,new Date(Date.now()-60000+n));
    const b=randomUUID();const a=(await db.db.insert(auditLogs).values({actorEmail:"ugo@limova.ai",action:SAV_EXTERNAL_COMPLETION,entityType:"sav_message",entityId:m.id,technicalMetadata:{version:1,threadId:t.id,batchId:b,receivedBefore:new Date().toISOString(),reason:"processed_outside_studio"}}).returning())[0];
    await db.db.insert(auditLogs).values({actorEmail:"ugo@limova.ai",action:SAV_EXTERNAL_COMPLETION_REVERTED,entityType:"sav_message",entityId:m.id,technicalMetadata:{version:1,batchId:b,completionId:a.id}});
  }
  await externalMarker();
  for(const [key,value] of Object.entries({...environment,SAV_INTAKE_GMAIL_MARK_READ:"on"}))vi.stubEnv(key,value);
  // A nonexistent/invalid Gmail id produces no provider call but must be the
  // candidate reached after the three revoked poisons, not hidden by LIMIT.
  expect(await reconcileHandledIntakeGmailRead(1)).toMatchObject({checked:1});
  const failures=await db.db.select().from(auditLogs).where(eq(auditLogs.action,"sav_intake_gmail_read_failed"));
  expect(failures).toHaveLength(1);expect(failures[0].entityId).toBe(messageId);
});
it("a launched human hold is effective locally and never occupies another dossier through legacy work", async () => {
  await recordIntakeLaunch({ mailboxId, receivedAfter: options.runtime.receivedAfter, createdAfter: options.runtime.createdAfter });
  await observed();
  await requestHumanIntervention(threadId, "ugo@limova.ai", "Synthetic local human hold");
  const [hold] = await db.db.select().from(savActions);
  expect(hold).toMatchObject({kind:"request_human",actorType:"human",status:"succeeded",payload:{localHold:true}});
  expect((await db.db.select().from(savThreads).where(eq(savThreads.id,threadId)))[0].aiPaused).toBe(true);
  expect(await releaseLegacyAiPauses(options.runtime)).toEqual({released:0});
  await projectIntakeThread(threadId);
  expect((await listIntakeConsole({view:"to_validate"})).rows[0]).toMatchObject({status:"human_hold",view:"to_validate"});
  const detail=await readIntakeConsoleDetail(threadId);expect(detail?.projection).toMatchObject({status:"human_hold",view:"to_validate"});expect(detail?.thread.paused).toBe(true);expect(detail?.humanHeld).toBe(true);
  expect((await listIntakeConsole()).total).toBe(0);expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  await db.db.transaction(tx => assertNoLegacyConflict(tx,["thread:another-synthetic-dossier"]));
  expect(mutationsSent()).toHaveLength(0);
});
it("an unlaunched mailbox keeps the legacy pending human intervention", async () => {
  await requestHumanIntervention(threadId,"ugo@limova.ai","Synthetic legacy human request");
  expect((await db.db.select().from(savActions))[0]).toMatchObject({kind:"request_human",status:"pending"});
});
it("an exact administrative marker gives one completed list/detail row without AI approval or CRM closure", async () => {
  await observed(); await externalMarker(); await externalMarker();
  expect(await getSavExternalCompletion((await db.db.select().from(savMessages))[0])).not.toBeNull();
  const listed=await listIntakeConsole({view:"completed"}),detail=await readIntakeConsoleDetail(threadId);
  expect(listed.counts).toMatchObject({completed:1});expect(listed.rows).toHaveLength(1);
  expect(listed.rows[0]).toMatchObject({messageId,status:"handled_externally",view:"completed"});
  expect(detail?.projection).toMatchObject({status:"handled_externally",view:"completed"});
  expect(detail?.confirmedCurrent).toBe(false);
  expect(await listIntakeConsole()).toMatchObject({total:0});
  expect(await admitIntakeExecution(runId,options)).toBeNull();
  expect(await enqueueSavIntakeMessage(messageId,options.runtime)).toBeNull();
  expect(await catchupSavIntake(options.runtime)).toBe(0);
  expect(await claimSavIntakeRun(runId,options.runtime)).toBeNull();
  expect(await pendingSavIntakeRuns(options.runtime)).toHaveLength(0);
  expect(mutationsSent()).toHaveLength(0);
});
it.each(["wrong_actor","wrong_thread","malformed","boundary","revoked"])("rejects %s administrative evidence in both list and detail",async scenario=>{
  await observed();
  const overrides=scenario==="wrong_thread"?{threadId:randomUUID()}:scenario==="malformed"?{receivedBefore:"not-a-date"}:scenario==="boundary"?{receivedBefore:"2000-01-01T00:00:00Z"}:{};
  const event=await externalMarker(overrides,scenario==="wrong_actor"?"other@example.invalid":"ugo@limova.ai");
  if(scenario==="revoked")await db.db.insert(auditLogs).values({actorEmail:"ugo@limova.ai",action:SAV_EXTERNAL_COMPLETION_REVERTED,entityType:"sav_message",entityId:messageId,technicalMetadata:{version:1,batchId:event.technicalMetadata.batchId,completionId:event.id}});
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect((await readIntakeConsoleDetail(threadId))?.handledExternally).toBe(false);
  expect(await admitIntakeExecution(runId,options)).not.toBeNull();
});
it("the next real inbound drops the old marker, keeps the human hold, and can resume after a separate release",async()=>{
  await recordIntakeLaunch({mailboxId,receivedAfter:options.runtime.receivedAfter,createdAfter:options.runtime.createdAfter});
  await observed();await requestHumanIntervention(threadId,"ugo@limova.ai","Synthetic retained team hold");await externalMarker();
  expect((await listIntakeConsole({view:"completed"})).total).toBe(1);
  const incoming=await message(threadId,new Date(Date.now()+10));
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect((await listIntakeConsole({view:"to_validate"})).rows[0]).toMatchObject({messageId:incoming.id,status:"human_hold"});
  expect((await readIntakeConsoleDetail(threadId))?.thread.paused).toBe(true);
  const queued=await enqueueSavIntakeMessage(incoming.id,options.runtime);expect(queued).not.toBeNull();
  expect(await claimSavIntakeRun(queued!,options.runtime)).toBeNull();
  // Simulate the separately authorised administrative release; production code never does this.
  await db.db.update(savThreads).set({aiPaused:false}).where(eq(savThreads.id,threadId));
  expect(await claimSavIntakeRun(queued!,options.runtime)).not.toBeNull();
  expect((await db.db.select().from(savActions))[0].payload.localHold).toBe(true);
});
it("a marker arriving before the final dispatch fences every provider mutation",async()=>{
  await observed();const execution=(await admitIntakeExecution(runId,options))!;
  const result=await executeIntakePass(execution.id,options,{beforeMarker:async()=>{await externalMarker();}});
  expect(result.state).not.toBe("confirmed");expect(mutationsSent()).toHaveLength(0);
  expect((await db.db.select().from(savIntakeEffects)).every(effect=>effect.state==="planned"&&!effect.dispatchedAt)).toBe(true);
  expect((await listIntakeConsole({view:"completed"})).total).toBe(1);
});
it("a marker after dispatch intent keeps uncertainty visible and never dispatches after the last live check",async()=>{
  await observed();const execution=(await admitIntakeExecution(runId,options))!;
  await executeIntakePass(execution.id,options,{afterMarker:async()=>{await externalMarker();}});
  expect(mutationsSent()).toHaveLength(0);
  expect((await db.db.select().from(savIntakeEffects))[0].dispatchedAt).not.toBeNull();
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  const detail=await readIntakeConsoleDetail(threadId);
  expect(detail?.projection.status).toBe("external_completion_pending");expect(detail?.progress?.confirmed).toBe(false);
});
it("a genuine pending human command is never hidden by an administrative marker",async()=>{
  await observed(true);await recordIntakeHumanCommand(await command());await externalMarker();
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect((await readIntakeConsoleDetail(threadId))?.projection.status).toBe("external_completion_pending");
  expect(await consumeIntakeHumanEvent((await db.db.select().from(savIntakeHumanEvents))[0].id,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toMatchObject({skipped:"not_claimed"});
  expect(mutationsSent()).toHaveLength(0);
});
it("a new inbound during administrative projection cannot clear its source epoch",async()=>{
  await observed();await externalMarker();
  expect(await projectIntakeThread(threadId,async()=>{await message(threadId,new Date(Date.now()+10));})).toBe(false);
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect((await listIntakeConsole()).total).toBe(1);
});

it("a marker fences a queued analysis and one arriving after claim fences its lease",async()=>{
  const queued=(await enqueueSavIntakeMessage(messageId,options.runtime))!;
  const marker=await externalMarker();
  expect(await pendingSavIntakeRuns(options.runtime)).toHaveLength(0);
  expect(await claimSavIntakeRun(queued,options.runtime)).toBeNull();
  expect((await db.db.select().from(savIntakeRuns))[0].attempts).toBe(0);
  await db.db.insert(auditLogs).values({actorEmail:"ugo@limova.ai",action:SAV_EXTERNAL_COMPLETION_REVERTED,entityType:"sav_message",entityId:messageId,technicalMetadata:{version:1,batchId:marker.technicalMetadata.batchId,completionId:marker.id}});
  const lease=(await claimSavIntakeRun(queued,options.runtime))!;expect(lease).not.toBeNull();
  await externalMarker();
  await expect(assertSavIntakeLease(lease,options.runtime)).rejects.toThrow("CONTEXT_CHANGED");
  expect(mutationsSent()).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
});

it.each(["wrong_batch","wrong_actor","malformed"])("an invalid %s revocation cannot resume the marked message",async scenario=>{
  await observed();const marker=await externalMarker();
  await db.db.insert(auditLogs).values({actorEmail:scenario==="wrong_actor"?"other@example.invalid":"ugo@limova.ai",action:SAV_EXTERNAL_COMPLETION_REVERTED,entityType:"sav_message",entityId:messageId,
    technicalMetadata:{version:scenario==="malformed"?9:1,batchId:scenario==="wrong_batch"?randomUUID():marker.technicalMetadata.batchId,completionId:marker.id}});
  expect((await listIntakeConsole({view:"completed"})).total).toBe(1);
  expect(await admitIntakeExecution(runId,options)).toBeNull();
});

it("an unresolved legacy human dispatch stays visible after marking",async()=>{
  await observed();await externalMarker();
  await db.db.insert(savActions).values({threadId,messageId,kind:"create_note",actorType:"human",status:"failed",idempotencyKey:randomUUID(),payload:{intakeOccupationDispatchedAt:new Date().toISOString()}});
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect((await readIntakeConsoleDetail(threadId))?.projection.status).toBe("external_completion_pending");
});

it("an initial zero-attempt pending or waiting run has no obsolete source; a real changed source stays fenced",async()=>{
  const queued=(await enqueueSavIntakeMessage(messageId,options.runtime))!;
  await projectIntakeThread(threadId);
  expect((await listIntakeConsole()).rows[0].status).toBe("pending");
  await db.db.update(savIntakeRuns).set({state:"waiting"}).where(eq(savIntakeRuns.id,queued));
  await projectIntakeThread(threadId);
  expect((await listIntakeConsole()).rows[0].status).toBe("waiting");
  await observed();
  const [m]=await db.db.select().from(savMessages).where(eq(savMessages.id,messageId));
  await db.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({...decryptSavPayload<{text:string}>(m.bodyCiphertext),text:"A genuinely different synthetic request."})}).where(eq(savMessages.id,messageId));
  await projectIntakeThread(threadId);
  expect((await listIntakeConsole()).rows[0].status).toBe("context_changed");
});

it.each(["other_message","earlier_audit"])("a %s fake reversal cannot suppress the actual administrative rollback",async scenario=>{
  vi.stubEnv("SAV_RELEASE_STAGE","v0");vi.stubEnv("SAV_PILOT_MODE","false");
  await observed();const marker=await externalMarker(),batchId=String(marker.technicalMetadata.batchId);
  await db.db.insert(auditLogs).values({actorEmail:"ugo@limova.ai",action:SAV_EXTERNAL_COMPLETION_REVERTED,entityType:"sav_message",entityId:scenario==="other_message"?randomUUID():messageId,
    createdAt:scenario==="earlier_audit"?new Date(marker.createdAt.getTime()-1000):new Date(),technicalMetadata:{version:1,batchId,completionId:marker.id}});
  expect((await listIntakeConsole({view:"completed"})).total).toBe(1);
  expect(await revertSavExternalCompletionBatch(batchId,"ugo@limova.ai")).toEqual({reverted:1});
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect(await revertSavExternalCompletionBatch(batchId,"ugo@limova.ai")).toEqual({reverted:0});
});

it("mark and rollback dirty the cached projection and restore the actual human choice",async()=>{
  vi.stubEnv("SAV_RELEASE_STAGE","v0");vi.stubEnv("SAV_PILOT_MODE","false");
  await activateSavV0Cutover({receivedAfter:new Date(Date.now()-3600000).toISOString(),mailboxEmail:"support@example.invalid",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
  await observed(true);await projectIntakeThread(threadId);
  expect((await listIntakeConsole({view:"to_validate"})).total).toBe(1);
  const before=(await db.db.select().from(savIntakeConsole))[0],batchId=randomUUID();
  expect(await markSavDossiersHandledExternally({batchId,receivedBefore:new Date().toISOString(),messages:[{threadId,messageId}]},"ugo@limova.ai")).toMatchObject({marked:1});
  const marked=(await db.db.select().from(savIntakeConsole))[0];expect(marked.epoch).toBeGreaterThan(before.epoch);
  await projectIntakeThread(threadId);expect((await listIntakeConsole({view:"completed"})).total).toBe(1);
  const projected=(await db.db.select().from(savIntakeConsole))[0];expect(projected.projectedEpoch).toBe(projected.epoch);
  expect(await revertSavExternalCompletionBatch(batchId,"ugo@limova.ai")).toEqual({reverted:1});
  const reverted=(await db.db.select().from(savIntakeConsole))[0];expect(reverted.epoch).toBeGreaterThan(projected.epoch);
  expect(await refreshIntakeConsole()).toMatchObject({refreshed:1});
  expect((await listIntakeConsole({view:"to_validate"})).rows[0].status).toBe("human_choice");
  expect((await readIntakeConsoleDetail(threadId))?.projection).toMatchObject({view:"to_validate",status:"human_choice"});
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
});
it("a cancelled earlier human hold stays in validation across inbound and rejects action choices while paused",async()=>{
  await observed(true);const raw=await command();
  await db.db.insert(savActions).values({threadId,kind:"request_human",actorType:"human",status:"cancelled",idempotencyKey:randomUUID(),payload:{reason:"Synthetic explicit team hold"}});
  await db.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));
  expect((await listIntakeConsole({view:"to_validate"})).counts).toMatchObject({to_validate:1});
  const detail=await readIntakeConsoleDetail(threadId);expect(detail?.humanHeld).toBe(true);expect(detail?.thread.paused).toBe(true);
  await expect(recordIntakeHumanCommand(raw)).rejects.toThrow("CONFLICT");
  const next=await message(threadId,new Date(Date.now()+10));
  expect((await listIntakeConsole({view:"to_validate"})).rows[0]).toMatchObject({messageId:next.id,status:"human_hold"});
  expect((await listIntakeConsole({view:"completed"})).total).toBe(0);
  expect(await releaseLegacyAiPauses(options.runtime)).toEqual({released:0});expect(mutationsSent()).toHaveLength(0);
});

async function heldReleaseCommand(beforeHold?:()=>Promise<void>,ambiguous=false) {
  await recordIntakeLaunch({mailboxId,receivedAfter:options.runtime.receivedAfter,createdAfter:options.runtime.createdAfter});
  await observed(ambiguous);await beforeHold?.();
  await requestHumanIntervention(threadId,"ugo@limova.ai","Synthetic explicit team hold");
  const [projection]=await db.db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId,threadId));
  return {requestKey:randomUUID(),threadId,messageId,expectedEpoch:projection.epoch,reason:"Synthetic administrator reviewed this dossier."};
}
it("explicit hold release is local, audited and idempotent without analysis, effects or reset",async()=>{
  const raw=await heldReleaseCommand(),before=(await db.db.select().from(savIntakeRuns))[0];
  expect(await releaseIntakeHumanHold(raw)).toEqual({released:true,replayed:false});
  expect(await releaseIntakeHumanHold(raw)).toEqual({released:false,replayed:true});
  const [thread]=await db.db.select().from(savThreads).where(eq(savThreads.id,threadId));expect(thread.aiPaused).toBe(false);
  const after=(await db.db.select().from(savIntakeRuns))[0];expect(after.attempts).toBe(before.attempts);expect(after.payloadCiphertext).toBe(before.payloadCiphertext);
  expect(await db.db.select().from(savIntakeExecutions)).toHaveLength(0);expect(await db.db.select().from(savIntakeModelCalls)).toHaveLength(0);
  expect(await db.db.select().from(auditLogs).where(eq(auditLogs.action,"sav_intake_human_hold_released"))).toHaveLength(1);
  expect(mutationsSent()).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
  await expect(releaseIntakeHumanHold({...raw,reason:"Changed replay reason is not the same command."})).rejects.toThrow("CONFLICT");
  await requestHumanIntervention(threadId,"ugo@limova.ai","A fresh synthetic team hold");
  await expect(releaseIntakeHumanHold(raw)).rejects.toThrow("CONFLICT");
  expect((await db.db.select().from(savThreads).where(eq(savThreads.id,threadId)))[0].aiPaused).toBe(true);
});
it.each(["new_inbound","marker","stale_epoch","short_reason","no_launch","no_human_hold"])("hold release refuses %s and preserves the pause",async scenario=>{
  const raw=await heldReleaseCommand();
  if(scenario==="new_inbound")await message(threadId,new Date(Date.now()+10));
  if(scenario==="marker")await externalMarker();
  if(scenario==="stale_epoch")raw.expectedEpoch++;
  if(scenario==="short_reason")raw.reason="no";
  if(scenario==="no_launch")await db.client.exec("DELETE FROM sav.sync_state WHERE key LIKE 'sav-intake-launch:%'");
  if(scenario==="no_human_hold")await db.db.delete(savActions).where(eq(savActions.threadId,threadId));
  await expect(releaseIntakeHumanHold(raw)).rejects.toThrow();
  expect((await db.db.select().from(savThreads).where(eq(savThreads.id,threadId)))[0].aiPaused).toBe(true);
  expect(await db.db.select().from(auditLogs).where(eq(auditLogs.action,"sav_intake_human_hold_released"))).toHaveLength(0);
  expect(mutationsSent()).toHaveLength(0);
});
it.each(["member","inactive","unverified"])("hold release refuses an %s administrator identity",async scenario=>{
  const raw=await heldReleaseCommand();
  if(scenario==="unverified") { const [admin]=await db.db.select().from(staffUsers);state.user={id:admin.clerkId,primaryEmailAddress:{emailAddress:admin.email,verification:{status:"unverified"}}}; }
  else await db.db.update(staffUsers).set(scenario==="member"?{role:"member"}:{active:false});
  await expect(releaseIntakeHumanHold(raw)).rejects.toThrow("UNAUTHORIZED");
  expect((await db.db.select().from(savThreads).where(eq(savThreads.id,threadId)))[0].aiPaused).toBe(true);
});
it.each(["run_lease","execution_lease","pending_human","uncertain_effect","legacy_intent"])("hold release refuses %s without clearing or replaying it",async scenario=>{
  const raw=await heldReleaseCommand(async()=>{
    if(scenario==="pending_human")await recordIntakeHumanCommand(await command());
    if(scenario==="execution_lease"||scenario==="uncertain_effect") {
      const execution=(await admitIntakeExecution(runId,options))!;
      if(scenario==="uncertain_effect")await executeIntakePass(execution.id,options,{afterMarker:async()=>{throw Error("synthetic dispatch result still uncertain");}});
    }
    if(scenario==="legacy_intent")await db.db.insert(savActions).values({threadId,messageId,kind:"create_note",actorType:"human",status:"pending",idempotencyKey:randomUUID(),payload:{}});
  },scenario==="pending_human");
  if(scenario==="run_lease")await db.db.update(savIntakeRuns).set({leaseToken:randomUUID(),leaseUntil:new Date(Date.now()+60000)}).where(eq(savIntakeRuns.id,runId));
  if(scenario==="execution_lease")await db.db.update(savIntakeExecutions).set({leaseToken:randomUUID(),leaseUntil:new Date(Date.now()+60000)}).where(eq(savIntakeExecutions.threadId,threadId));
  raw.expectedEpoch=(await db.db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId,threadId)))[0].epoch;
  await expect(releaseIntakeHumanHold(raw)).rejects.toThrow("CONFLICT");
  expect((await db.db.select().from(savThreads).where(eq(savThreads.id,threadId)))[0].aiPaused).toBe(true);
  expect(mutationsSent()).toHaveLength(0);
});

it.each(["sender", "recipients"])("refreshes other projections when one dossier has invalid address metadata (%s)", async variant => {
  await observed();
  await db.db.update(savMessages).set(variant === "sender" ? {fromEmail:"invalid-address"} : {toEmails:Array.from({length:31},(_,i)=>`recipient${i}@example.invalid`)}).where(eq(savMessages.id,messageId));
  const [thread] = await db.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"other@example.invalid"}).returning();
  const next = await message(thread.id);
  await enqueueSavIntakeMessage(next.id,options.runtime);
  const result=await refreshIntakeConsole(20);
  expect(result.refreshed).toBeGreaterThanOrEqual(2);
  const [blocked]=await db.db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId,threadId));
  expect(blocked).toMatchObject({status:"waiting",reason:"SAV_INTAKE_MESSAGE_METADATA_INVALID"});
  expect(blocked.epoch).toBe(blocked.projectedEpoch);
  const [following]=await db.db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId,thread.id));
  expect(following.epoch).toBe(following.projectedEpoch);
  expect(mutationsSent()).toHaveLength(0);
});

it("oldest and newest pagination retain chronological order and the exact filtered cohort",async()=>{
 const threads=await db.db.insert(savThreads).values(Array.from({length:27},(_,i)=>({mailboxId,gmailThreadId:`ux-sort-${i}`,customerEmail:`sort${i}@example.invalid`}))).returning();
 await db.db.insert(savMessages).values(threads.map((t,i)=>({mailboxId,threadId:t.id,direction:"inbound" as const,fromEmail:`sort${i}@example.invalid`,toEmails:["support@example.invalid"],subject:`UXSort ${i}`,receivedAt:new Date(Date.now()-86400000+i*1000),bodyCiphertext:encryptSavPayload({text:"Synthetic sort fixture"}),analysisStatus:"intake_waiting"})));
 const oldest=await listIntakeConsole({view:"processing",search:"UXSort",sort:"oldest",page:2});
 expect(oldest).toMatchObject({total:27,page:2,pages:2});expect(oldest.rows.map(r=>r.subject)).toEqual(["UXSort 25","UXSort 26"]);
 const newest=await listIntakeConsole({view:"processing",search:"UXSort",sort:"newest",page:2});expect(newest.rows.map(r=>r.subject)).toEqual(["UXSort 1","UXSort 0"]);
});

afterEach(async()=>{await db.db.delete(savSyncState).where(eq(savSyncState.key,"sav-agent-pause.v1:intake"));});
async function reviewSetFullPause() {
 const value={key:"sav-agent-pause.v1:intake",status:"active",cursor:encryptSavPayload({revision:"sav-agent-pause.v1",agent:"intake",level:"fully_paused",setBy:"ugo@limova.ai",setAt:new Date().toISOString(),reason:"Synthetic independent review"})};
 await db.db.insert(savSyncState).values(value).onConflictDoUpdate({target:savSyncState.key,set:value});
}
it("REVIEW full pause preserves human reanalysis attempts",async()=>{
 await observed();for(const [key,value]of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);
 await db.db.update(savIntakeRuns).set({attempts:2,state:"waiting"}).where(eq(savIntakeRuns.id,runId));
 stubRecoveryModel();
 const requested=await requestIntakeReinvestigation({threadId,messageId,reason:"Synthetic bounded independent review."});
 await reviewSetFullPause();
 await consumeIntakeHumanEvent(requested.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}));
 const [event]=await db.db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id,requested.eventId));
 expect(event.readAttempts).toBe(0);
});
it("REVIEW full pause blocks cached human continuation",async()=>{
 await observed(true);
 const saved=await recordIntakeHumanCommand(await command());
 await reviewSetFullPause();
 const result=await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}));
 expect(result).not.toHaveProperty("state","observed");
});
async function setAgentPause(level:"running"|"actions_paused"|"fully_paused") {
 const value={key:"sav-agent-pause.v1:intake",status:"active",cursor:encryptSavPayload({revision:"sav-agent-pause.v1",agent:"intake",level,setBy:"ugo@limova.ai",setAt:new Date().toISOString(),reason:"Synthetic pause"})};
 await db.db.insert(savSyncState).values(value).onConflictDoUpdate({target:savSyncState.key,set:value});
}
const humanEvent=async(id:string)=>(await db.db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id,id)))[0];
it("full pause: two reconciler passes claim nothing, then the cached human choice is published once after the resume",async()=>{
 await observed(true);for(const [key,value]of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);
 const saved=await recordIntakeHumanCommand(await command()),runs=(await db.db.select().from(savIntakeRuns)).length;
 await setAgentPause("fully_paused");
 for(let i=0;i<2;i++)expect(await reconcileIntakeHumanChoices()).toEqual({skipped:"SAV_INTAKE_AGENT_FULLY_PAUSED"});
 expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toEqual({skipped:"SAV_INTAKE_AGENT_FULLY_PAUSED"});
 expect(await humanEvent(saved.eventId)).toMatchObject({state:"pending",readAttempts:0,leaseToken:null});
 expect((await db.db.select().from(savIntakeRuns)).length).toBe(runs);
 await setAgentPause("running");
 expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
 expect(await humanEvent(saved.eventId)).toMatchObject({state:"consumed",readAttempts:1});
 expect(mutationsSent()).toHaveLength(0);
});
it("a full pause landing during the CRM read publishes nothing and gives the human read back",async()=>{
 await observed(true);const saved=await recordIntakeHumanCommand(await command()),runs=(await db.db.select().from(savIntakeRuns)).length;
 let paused=false;
 const pausing:typeof p.network=async(url,init)=>{if(!paused){paused=true;await setAgentPause("fully_paused");}return p.network(url,init);};
 expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:pausing}))).toEqual({waiting:"SAV_INTAKE_AGENT_FULLY_PAUSED"});
 expect(paused).toBe(true);
 expect(await humanEvent(saved.eventId)).toMatchObject({state:"pending",readAttempts:0,leaseToken:null});
 expect((await db.db.select().from(savIntakeRuns)).length).toBe(runs);
 await setAgentPause("running");
 expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
});
it("a reinvestigation requested before a full pause keeps both reads and runs its analysis after the resume",async()=>{
 await observed();for(const [key,value]of Object.entries(environment))if(value!==undefined)vi.stubEnv(key,value);
 await db.db.update(savIntakeRuns).set({attempts:2,state:"waiting"}).where(eq(savIntakeRuns.id,runId));
 stubRecoveryModel();
 const requested=await requestIntakeReinvestigation({threadId,messageId,reason:"Synthetic bounded reinvestigation across a pause."});
 await setAgentPause("fully_paused");
 for(let i=0;i<2;i++)expect(await consumeIntakeHumanEvent(requested.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toEqual({skipped:"SAV_INTAKE_AGENT_FULLY_PAUSED"});
 expect(await db.db.select().from(savIntakeModelCalls)).toHaveLength(0);
 await setAgentPause("running");
 expect(await consumeIntakeHumanEvent(requested.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
 expect(await humanEvent(requested.eventId)).toMatchObject({state:"consumed",readAttempts:1});
 expect((await db.db.select().from(savIntakeModelCalls)).length).toBeGreaterThan(0);
});
it("actions_paused keeps human analysis: the choice is published, nothing is sent",async()=>{
 await observed(true);const saved=await recordIntakeHumanCommand(await command());
 await setAgentPause("actions_paused");
 expect(await consumeIntakeHumanEvent(saved.eventId,options.runtime,createSavIntakeHubspotReaders({network:p.network}))).toHaveProperty("state","observed");
 expect(mutationsSent()).toHaveLength(0);
});

describe("SAV-42 C: a confirmed current acknowledgement is marked read once", () => {
  const readable = async () => {
    await db.db.update(savMailboxes).set({email:"contact@limova.ai"}).where(eq(savMailboxes.id,mailboxId));
    await db.db.update(savMessages).set({gmailMessageId:"1a123"}).where(eq(savMessages.id,messageId));
    await db.db.update(savThreads).set({gmailThreadId:"1a000"}).where(eq(savThreads.id,threadId));
  };
  const provider = () => {
    const state = { unread: true, writes: 0, fail: false };
    const gmail: GmailRequest = async<T>(_mailbox: string, path: string, init?: RequestInit) => {
      if (path === "profile") return { emailAddress: "contact@limova.ai" } as T;
      if (init?.method === "POST") { state.writes++; state.unread = false; if (state.fail) throw Error("TIMEOUT"); return {} as T; }
      return { id: "1a123", threadId: "1a000", labelIds: ["INBOX", ...state.unread ? ["UNREAD"] : []] } as T;
    };
    return { state, gmail };
  };
  const deps = (gmail: GmailRequest) => ({ env: () => ({ ...environment, SAV_INTAKE_GMAIL_MARK_READ: "on" }), gmail });
  const acknowledged = async () => {
    const plan = await observed(false, false, true, undefined, "acknowledgement");
    expect(plan.decision.disposition).toMatchObject({ kind: "no_ticket", reason: "acknowledgement_only" });
    await projectIntakeThread(threadId);
    expect((await listIntakeConsole({ view: "completed" })).rows.map(r => r.threadId)).toEqual([threadId]);
  };
  it("is marked read with a durable receipt, no ticket or email effect, and recovered after a Gmail failure", async () => {
    await readable(); await acknowledged();
    const g = provider(); g.state.fail = true;
    expect(await syncHandledIntakeGmailRead(messageId, deps(g.gmail))).toMatchObject({ confirmed: false });
    g.state.fail = false;
    expect(await syncHandledIntakeGmailRead(messageId, deps(g.gmail))).toEqual({ confirmed: true });
    expect(await syncHandledIntakeGmailRead(messageId, deps(g.gmail))).toEqual({ skipped: "already_confirmed" });
    expect(g.state.writes).toBe(1); expect(g.state.unread).toBe(false);
    const receipts = await db.db.select().from(auditLogs).where(eq(auditLogs.action, SAV_INTAKE_GMAIL_READ));
    expect(receipts).toHaveLength(1); expect(receipts[0].technicalMetadata).toMatchObject({ acknowledgementRunId: runId });
    expect(mutationsSent()).toHaveLength(0);
  });
  it("is selected by the read-receipt recovery", async () => {
    await acknowledged();
    for (const [key, value] of Object.entries({ ...environment, SAV_INTAKE_GMAIL_MARK_READ: "on" })) vi.stubEnv(key, value);
    await db.db.update(savMailboxes).set({ email: "contact@limova.ai" }).where(eq(savMailboxes.id, mailboxId));
    // Invalid synthetic Gmail id: selected and attempted, refused before any provider call.
    expect(await reconcileHandledIntakeGmailRead(5)).toMatchObject({ checked: 1 });
    const failures = await db.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_intake_gmail_read_failed"));
    expect(failures.map(f => f.entityId)).toEqual([messageId]);
  });
  it("is not marked read once a newer inbound message supersedes it", async () => {
    await readable(); await acknowledged();
    await message(threadId, new Date(Date.now() + 1000));
    await projectIntakeThread(threadId); // fresh projection: refusal must not depend on staleness
    const g = provider();
    expect(await syncHandledIntakeGmailRead(messageId, deps(g.gmail))).toEqual({ skipped: "not_handled" });
    expect(g.state.writes).toBe(0);
  });
  it("is not marked read when its local sources changed", async () => {
    await readable(); await acknowledged();
    await db.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: "Finalement le problème revient.", attachments: [], headers: {} }) }).where(eq(savMessages.id, messageId));
    await projectIntakeThread(threadId);
    const g = provider();
    expect(await syncHandledIntakeGmailRead(messageId, deps(g.gmail))).toEqual({ skipped: "not_handled" });
    expect(g.state.writes).toBe(0);
  });
  it("is not marked read under a human hold", async () => {
    await readable(); await acknowledged();
    await requestHumanIntervention(threadId, "ugo@limova.ai", "Synthetic hold on an acknowledgement");
    await projectIntakeThread(threadId);
    const g = provider();
    expect(await syncHandledIntakeGmailRead(messageId, deps(g.gmail))).toEqual({ skipped: "not_handled" });
    expect(g.state.writes).toBe(0);
  });
});

describe("SAV-42 D: an invalid-source dossier stays readable and can be classified Other by the operator", () => {
  const invalidSource = async () => {
    vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
    await activateSavV0Cutover({receivedAfter:new Date(Date.now()-3600000).toISOString(),mailboxEmail:"support@example.invalid",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
    // Over the 30-recipient transport limit: the analysis source is refused, never truncated.
    await db.db.update(savMessages).set({ toEmails: Array.from({ length: 31 }, (_, n) => `r${n}@example.invalid`) }).where(eq(savMessages.id, messageId));
    const id = (await enqueueSavIntakeMessage(messageId, options.runtime))!;
    expect(await claimSavIntakeRun(id, options.runtime)).toBeNull();
    await projectIntakeThread(threadId);
    return { requestKey: randomUUID(), threadId, messageId, confirmed: true as const };
  };
  it("the dossier detail loads and exposes the invalid source instead of failing", async () => {
    await invalidSource();
    const detail = await readIntakeConsoleDetail(threadId);
    expect(detail?.current?.sourceInvalid).toBe(true);
    expect(detail?.current?.sourceMatches).toBe(false);
  });
  it("is classified Other once, audited, idempotent, without model, email or CRM effect", async () => {
    const input = await invalidSource();
    expect(await classifyInvalidSourceAsOther(input)).toMatchObject({ marked: 1, alreadyCompleted: 0 });
    expect(await classifyInvalidSourceAsOther(input)).toMatchObject({ marked: 0, alreadyCompleted: 1 });
    expect((await listIntakeConsole({ view: "other" })).rows.map(r => r.threadId)).toEqual([threadId]);
    const markers = await db.db.select().from(auditLogs).where(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION));
    expect(markers).toHaveLength(1); expect(markers[0].technicalMetadata).toMatchObject({ disposition: "other" });
    expect(mutationsSent()).toHaveLength(0);
    expect(await db.db.select().from(savIntakeModelCalls)).toHaveLength(0);
  });
  it("refuses a dossier whose source is valid", async () => {
    vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
    await observed();
    await expect(classifyInvalidSourceAsOther({ requestKey: randomUUID(), threadId, messageId, confirmed: true })).rejects.toThrow("SAV_INTAKE_SOURCE_NOT_INVALID");
  });
  it("refuses a stale message once a newer inbound exists", async () => {
    const input = await invalidSource();
    await message(threadId, new Date(Date.now() + 1000));
    await expect(classifyInvalidSourceAsOther(input)).rejects.toThrow();
    expect(await db.db.select().from(auditLogs).where(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION))).toHaveLength(0);
  });
  it("refuses an operator who is not the authorised owner", async () => {
    const input = await invalidSource();
    const [other] = await db.db.insert(staffUsers).values({ clerkId: "synthetic-other-admin", email: "other@limova.ai", name: "Other", role: "admin", active: true }).returning();
    state.user = { id: other.clerkId, primaryEmailAddress: { emailAddress: other.email, verification: { status: "verified" } } };
    await expect(classifyInvalidSourceAsOther(input)).rejects.toThrow();
    expect(await db.db.select().from(auditLogs).where(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION))).toHaveLength(0);
  });
});

import * as reviewRuntimeStore from "./runtime-store";
it("REVIEW invalid-source classification is refused when the same message becomes a valid support source before the guarded transaction", async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
  await activateSavV0Cutover({ receivedAfter: new Date(Date.now()-3600000).toISOString(), mailboxEmail: "support@example.invalid", intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  await db.db.update(savMessages).set({ toEmails: Array.from({ length: 31 }, (_, n) => `r${n}@example.invalid`) }).where(eq(savMessages.id, messageId));
  const id = (await enqueueSavIntakeMessage(messageId, options.runtime))!;
  expect(await claimSavIntakeRun(id, options.runtime)).toBeNull();
  const original = reviewRuntimeStore.readSavIntakeCurrent;
  const spy = vi.spyOn(reviewRuntimeStore, "readSavIntakeCurrent").mockImplementationOnce(async (...args) => {
    const snapshot = await original(...args);
    expect(snapshot?.sourceInvalid).toBe(true);
    // Simulate source repair/reingestion after the initial check, before thread-row locks.
    await db.db.update(savMessages).set({ toEmails: ["support@example.invalid"], bodyCiphertext: encryptSavPayload({ text: "Ma connexion échoue et nécessite une prise en charge SAV.", headers: {}, attachments: [] }) }).where(eq(savMessages.id, messageId));
    return snapshot;
  });
  try {
    await classifyInvalidSourceAsOther({ requestKey: randomUUID(), threadId, messageId, confirmed: true }).catch(() => null);
    expect(await db.db.select().from(auditLogs).where(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION))).toHaveLength(0);
    expect(mutationsSent()).toHaveLength(0);
  } finally { spy.mockRestore(); }
});
