import { createHash, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, afterEach, it, expect, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { savMailboxes, savThreads, savMessages, staffUsers, savSyncState, savIntakeRuns, savIntakeModelCalls,
  savIntakeHumanEvents, savIntakeConsole, savIntakeExecutions, savIntakeEffects, savIntakeExecutionBudget,
  savIntakeObservationBindings, savResolutionObservations, savAgentRuns, savDecisions, savActions, savFollowups, savLearningCandidates, savKnowledgeActivations, categories } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("DB_FORBIDDEN"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { savIntakeRuntimeConfig, intakeRuntimeHash, SAV_INTAKE_RUNTIME_REVISION, type IntakeRuntimePayload } from "./runtime-contract";
import { planSavIntake } from "./engine";
import { recordAcceptedIntakeSemantics, SAV_INTAKE_SEMANTIC_RECORD_REVISION, type AcceptedIntakeSemantics } from "./semantic-records";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { enqueueSavIntakeMessage, claimSavIntakeRun, saveSavIntakeResult, readSavIntakeCurrent, catchupSavIntake } from "./runtime-store";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "./execution-policy";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import { admitIntakeExecution, claimExecution, ensureExecutionEffect, markEffectDispatched, getExecutionEffects, recordEffectAck } from "./execution-store";
import { executeIntakePass, readIntakeExecutionProgress, reconcileIntakeEffectsReadOnly } from "./executor";
import { recordIntakeHumanCommand, type IntakeHumanCommand } from "./human-commands";
import { consumeIntakeHumanEvent } from "./human-worker";
import { intakeRunConfigurationBound, humanRevisionConfigHash } from "./human-binding";
import { listIntakeConsole, projectIntakeThread, refreshIntakeConsole } from "./console-store";
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
import { getSavThreadDetail, processStoredSavMessage, processPendingSavMessages } from "../service";
import { enqueueConfiguredSavIntake, reconcileSavIntakeRuntime } from "./runtime";
import { saveIntakeChoice } from "@/app/studio/sav/intake/actions";
import type { ExecutionOptions } from "./execution-types";
let db: Awaited<ReturnType<typeof createSavTestDb>>, p: ReturnType<typeof executionProvider>, mailboxId: string, threadId: string, messageId: string,
  options: ExecutionOptions, environment: Record<string, string | undefined>, runId: string;
const mutations: ExecutionPolicy["mutations"] = ["create_ticket", "link_ticket", "associate_email", "append_ticket_note", "set_ticket_new", "send_identity_template"];
async function message(thread = threadId, receivedAt = new Date(), subject = "Synthetic connection failure") {
  return (await db.db.insert(savMessages).values({ mailboxId, threadId: thread, direction: "inbound", gmailMessageId: randomUUID(),
    fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject, receivedAt,
    bodyCiphertext: encryptSavPayload({ text: "The synthetic connection fails.", headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }) }).returning())[0];
}
async function observed(multiple = false, sensitive = false, same = true, equivalentContactIds?: string[]) {
  if (multiple) p.setContacts([{ id: "101", emails: ["customer@example.invalid"] }, { id: "102", emails: ["customer@example.invalid"] }]);
  const id = (await enqueueSavIntakeMessage(messageId, options.runtime))!, lease = (await claimSavIntakeRun(id, options.runtime))!;
  const semantics: AcceptedIntakeSemantics = { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION, records: [] };
  const semantic = recordAcceptedIntakeSemantics({
    analyseMessage: async () => ({ messageId, requests: [{ id: "r1", kind: sensitive ? "finance" as const : "support" as const, currentMessageId: messageId }],
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
