/** Independent reproductions converted to regression contracts. Original patch
 * is retained privately; native incoming fixtures now prove the source envelope. */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { savMailboxes, savThreads, savMessages, staffUsers, savIntakeExecutions, savIntakeEffects, savIntakeRuns, savSyncState, savIntakeHumanEvents, savIntakeEffectJournal } from "@/db/schema";
const state = vi.hoisted(() => ({
    db: null as unknown, user: null as unknown
}));
vi.mock("@/db", () => ({
    requireDb: () => {
        if (!state.db)
            throw Error("NO_DB_ALLOWED");
        return state.db;
    }
}));
vi.mock("@clerk/nextjs/server", () => ({
    currentUser: async () => state.user
}));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { planSavIntake } from "./engine";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { savIntakeRuntimeConfig, savIntakeRuntimePins, intakeRuntimeHash, intakeRuntimeConfigurationHash, SAV_INTAKE_RUNTIME_REVISION } from "./runtime-contract";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { SAV_INTAKE_READERS_REVISION } from "./hubspot-readers";
import { SAV_MESSAGE_CONTEXT_REVISION } from "../message-context";
import { intakeExecutionConfig, approveIntakeExecutionPolicy, revokeIntakeExecutionPolicy, type ExecutionPolicy } from "./execution-policy";
import { enqueueSavIntakeMessage, claimSavIntakeRun, saveSavIntakeResult } from "./runtime-store";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import { admitIntakeExecution, getExecutionEffects } from "./execution-store";
import { executeIntakePass, reconcileIntakeExecutor } from "./executor";
import { previewIntakeExecutionContinuity, approveIntakeExecutionContinuity } from "./execution-continuity";
import type { ExecutionOptions } from "./execution-types";
let f: Awaited<ReturnType<typeof createSavTestDb>>, p: ReturnType<typeof executionProvider>, options: ExecutionOptions, environment: Record<string, string | undefined>, messageId: string, threadId: string, mailboxId: string, runId: string, adminId: string;
const mutations: ExecutionPolicy["mutations"] = ["create_ticket", "link_ticket", "set_ticket_new", "append_ticket_note", "associate_email", "send_identity_template"];
const WARNING = "SYNTHETIC multi-ticket warning.";
const template = "SYNTHETIC exact template.\nSignature kept exactly.";
async function storedMessage(thread = threadId, at = new Date()) {
    return (await f.db.insert(savMessages).values({
        threadId: thread, mailboxId, direction: "inbound", gmailMessageId: randomUUID(), fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic connection failure", bodyCiphertext: encryptSavPayload({
            text: "The synthetic connection fails.", headers: {
                "message-id": "<incoming@example.invalid>"
            }, attachments: []
        }), receivedAt: at
    }).returning())[0];
}
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
afterAll(async () => {
    if (f) {
        await f.client.exec("TRUNCATE sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies CASCADE; UPDATE sav.intake_execution_budget SET admitted=0; DELETE FROM sav.sync_state WHERE key='sav-intake-execution-scan-v1'");
        await f.client.close();
    }
});
beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => { });
    vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters");
    await f.client.exec("TRUNCATE sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies,sav.intake_model_calls,sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; UPDATE sav.intake_execution_budget SET admitted=0; DELETE FROM sav.sync_state WHERE key='sav-intake-execution-scan-v1'");
    await f.db.insert(savSyncState).values({
        key: "sav-intake-execution-schema-v1", status: "installed"
    }).onConflictDoNothing();
    const [admin] = await f.db.insert(staffUsers).values({
        clerkId: "synthetic-admin", email: "ugo@limova.ai", name: "Synthetic Admin", role: "admin", active: true
    }).returning();
    adminId = admin.id;
    state.user = {
        id: admin.clerkId, primaryEmailAddress: {
            emailAddress: admin.email, verification: {
                status: "verified"
            }
        }
    };
    mailboxId = (await f.db.insert(savMailboxes).values({
        email: "support@example.invalid"
    }).returning())[0].id;
    threadId = (await f.db.insert(savThreads).values({
        mailboxId, gmailThreadId: "gmail-thread", customerEmail: "customer@example.invalid"
    }).returning())[0].id;
    messageId = (await storedMessage()).id;
    const ref = {
        resourceId: "synthetic-template", revisionId: "v1", sha256: createHash("sha256").update(template).digest("hex")
    };
    const catalogue = [{
            resource: ref, text: template, approvalId: "synthetic-approval", approvedBy: "synthetic-admin", approvedAt: new Date(Date.now() - 1000).toISOString(), status: "approved"
        }, { resource: { resourceId: "synthetic-warning", revisionId: "v1", sha256: createHash("sha256").update(WARNING).digest("hex") }, text: WARNING, approvalId: "synthetic-approval-2", approvedBy: "synthetic-admin", approvedAt: new Date(Date.now() - 1000).toISOString(), status: "approved" }];
    const enginePolicy = {
        relationRevision: "synthetic-relations", admittedRelations: [{
                category: "HUBSPOT_DEFINED", typeId: 449
            }], resources: {
            identification: ref, registrationNotFound: ref,
            multiTicketWarning: { resourceId: "synthetic-warning", revisionId: "v1", text: WARNING, sha256: createHash("sha256").update(WARNING).digest("hex") }
        }
    };
    environment = {
        SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake", HUBSPOT_ACCESS_TOKEN: "fake", SAV_ENCRYPTION_KEY_V1: process.env.SAV_ENCRYPTION_KEY_V1, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(enginePolicy), SAV_INTAKE_RUNTIME_RESOURCES: JSON.stringify(catalogue), SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({
            mailboxId, createdAfter: new Date(Date.now() - 10000).toISOString(), receivedAfter: new Date(Date.now() - 3600000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(enginePolicy), resourcesHash: intakeRuntimeHash(catalogue), maxCalls: 30, maxNanoUsd: 3000000000
        })
    };
    const runtime = savIntakeRuntimeConfig(environment)!;
    const policy: ExecutionPolicy = {
        revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: runtime.codeRevision, enginePolicyHash: runtime.policyHash, resourcesHash: runtime.resourcesHash, createdAfter: runtime.createdAfter, receivedAfter: runtime.receivedAfter, expiresAt: runtime.expiresAt, maxDossiers: 10, mutations, admission: {
            kind: "automatic"
        }
    };
    const grant = await approveIntakeExecutionPolicy(policy);
    environment = {
        ...environment, SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash
    };
    p = executionProvider();
    p.setGmail((await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].gmailMessageId!, "gmail-thread");
    options = {
        runtime, policy, config: intakeExecutionConfig(environment)!, env: () => environment, signal: AbortSignal.timeout(30000), adapters: createIntakeExecutorAdapters({
            network: p.network, gmailRequest: p.gmail, gmailPermissions: async () => { }, env: () => environment
        })
    };
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ── Audit: native CRM email logging outside the PR168 tolerance windows ──
function nativeEmail(ticketId: string, id: string) {
    // A native copy of the exact incoming message, not an arbitrary new email.
    p.objects.emails[id] = { id, properties: { hs_timestamp: new Date().toISOString(), hs_email_direction: "INCOMING_EMAIL", hs_email_subject: "Synthetic connection failure", hs_email_text: "The synthetic connection fails.", hs_email_from_email: "customer@example.invalid", hs_email_to_email: "support@example.invalid", hs_email_headers: JSON.stringify({messageId:"<incoming@example.invalid>"}) } };
    const key = `tickets:${ticketId}:emails`;
    p.links.set(key, [...(p.links.get(key) ?? []), id]);
}
async function observedWith(relation: "same" | "different") {
    const runtime = options.runtime, id = (await enqueueSavIntakeMessage(messageId, runtime))!, lease = (await claimSavIntakeRun(id, runtime))!;
    const plan = await planSavIntake(lease.input, { ...createSavIntakeHubspotReaders({ network: p.network }),
        analyseMessage: async () => ({ messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId }],
            ticketSummary: { title: "Synthetic connection failure", description: "The synthetic connection fails.", requestIds: ["r1"] } }),
        assessIssues: async ({ tickets, requests }) => ({ investigationComplete: true, tickets: tickets.map(({ ticket: t }) => ({
            ticketId: t.id, relation, requestIds: relation === "same" ? requests.map(r => r.id) : [], evidenceIds: ["current", `ticket-${t.id}`, `history-${t.id}`] })) }),
    }, runtime.policy, {}, () => new Date());
    await saveSavIntakeResult(lease, runtime, { revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected", plan, input: lease.input }, "observed");
    runId = id;
    const row = await admitIntakeExecution(id, options); expect(row).not.toBeNull();
    return { row: row!, plan };
}
const kinds = async (id: string) => (await getExecutionEffects(id)).map(e => `${e.kind}:${e.state}`);
const posts = (suffix: string) => p.calls.filter(c => c.method === "POST" && c.path.endsWith(suffix)).length;
it("AUDIT-1 create (no note): native email logged right after ticket creation, before Studio's email_create", async () => {
    const { row } = await observedWith("same");
    const verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "ticket_create" && proof.confirmed) nativeEmail(proof.ack!.id!, "8801");
        return proof;
    };
    const result = await executeIntakePass(row.id, options);
    console.warn("AUDIT-1", JSON.stringify(result), JSON.stringify(await kinds(row.id)));
    expect(posts("/tickets")).toBe(1);
    expect(result).toMatchObject({ state: "confirmed" });
});
it("AUDIT-2 create with multi-ticket warning note: native email after ticket creation", async () => {
    p.seedTicket({ stage: "open", subject: "Unrelated billing question" });
    const { row, plan } = await observedWith("different");
    expect(plan.decision.disposition).toMatchObject({ kind: "ticket", target: { operation: "create" } });
    expect(plan.noteText).toBeTruthy();
    const verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "ticket_create" && proof.confirmed) nativeEmail(proof.ack!.id!, "8801");
        return proof;
    };
    const result = await executeIntakePass(row.id, options);
    console.warn("AUDIT-2", JSON.stringify(result), JSON.stringify(await kinds(row.id)));
    // Resume attempts (cron) cannot make progress either:
    for (let n = 0; n < 3; n++) { await f.db.update(savIntakeExecutions).set({ updatedAt: new Date(Date.now() - 120000) }); await executeIntakePass(row.id, options); }
    console.warn("AUDIT-2 after resumes", JSON.stringify(await kinds(row.id)), "ticketPosts", posts("/tickets"));
    expect(posts("/tickets")).toBe(1);
    expect(result).toMatchObject({ state: "confirmed" });
});
it("AUDIT-3 reopen: native incoming copy logged on the existing ticket between note and email steps", async () => {
    p.seedTicket({ stage: "closed", closedAt: new Date(Date.now() - 1000).toISOString() });
    const { row } = await observedWith("same");
    const verify = options.adapters.verify;
    options.adapters.verify = async (...args) => {
        const proof = await verify(...args);
        if (args[0].kind === "note_associate" && proof.confirmed) nativeEmail("201", "8801");
        return proof;
    };
    const result = await executeIntakePass(row.id, options);
    console.warn("AUDIT-3", JSON.stringify(result), JSON.stringify(await kinds(row.id)));
    for (let n = 0; n < 3; n++) { await f.db.update(savIntakeExecutions).set({ updatedAt: new Date(Date.now() - 120000) }); await executeIntakePass(row.id, options); }
    console.warn("AUDIT-3 after resumes", JSON.stringify(await kinds(row.id)), "patch", p.calls.filter(c => c.method === "PATCH").length);
    expect(result).toMatchObject({ state: "confirmed" });
});
it("AUDIT-4 deploy between two effects: explicitly approved continuity resumes the same execution", async () => {
    const { row } = await observedWith("same");
    await executeIntakePass(row.id, options, { beforeMarker: async e => { if (e.kind === "email_create") throw Error("SYNTHETIC_DEPLOY_CUT"); } });
    console.warn("AUDIT-4 before deploy", JSON.stringify(await kinds(row.id)));
    // New deployment: new SHA pinned in runtime config and a newly approved execution policy.
    const rev = "b".repeat(40), cfg = JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!);
    environment = { ...environment, SAV_CODE_REVISION: rev, SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...cfg, codeRevision: rev }) };
    const runtime = savIntakeRuntimeConfig(environment)!;
    const policy = { ...options.policy, codeRevision: rev };
    const grant = await approveIntakeExecutionPolicy(policy);
    environment = { ...environment, SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash };
    const next: ExecutionOptions = { ...options, runtime, policy, config: intakeExecutionConfig(environment)! };
    const beforeEffects = await getExecutionEffects(row.id);
    const preview = await previewIntakeExecutionContinuity(options.config.policyId, next);
    await approveIntakeExecutionContinuity(options.config.policyId, preview.hash, next);
    expect((await getExecutionEffects(row.id)).map(e => ({id:e.id,intent:e.intentHash,ack:e.ackCiphertext}))).toEqual(beforeEffects.map(e => ({id:e.id,intent:e.intentHash,ack:e.ackCiphertext})));
    console.warn("AUDIT-4 enqueue new config", JSON.stringify(await enqueueSavIntakeMessage(messageId, runtime)));
    for (let n = 0; n < 3; n++) {
        await f.db.update(savIntakeExecutions).set({ updatedAt: new Date(Date.now() - 120000), leaseUntil: null });
        console.warn("AUDIT-4 cron", JSON.stringify(await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters })));
    }
    console.warn("AUDIT-4 direct pass", JSON.stringify(await executeIntakePass(row.id, next)));
    console.warn("AUDIT-4 after deploy", JSON.stringify(await kinds(row.id)), "ticketPosts", posts("/tickets"), "emailPosts", posts("/emails"));
    expect(posts("/tickets")).toBe(1);
    expect(await kinds(row.id)).toContain("email_associate:confirmed");
});

async function rotateAfterCut() {
    const { row } = await observedWith("same");
    await executeIntakePass(row.id, options, { beforeMarker: async e => { if (e.kind === "email_create") throw Error("SYNTHETIC_DEPLOY_CUT"); } });
    return { row, next: await newAuthorityOptions() };
}
it("preserves the pre-extraction runtime hash, including canonical pin order",()=>{
    const pins=savIntakeRuntimePins.parse(JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!));
    const expected=intakeRuntimeHash({...pins,revision:SAV_INTAKE_RUNTIME_REVISION,prompts:SAV_INTAKE_MODEL_REVISION,
        readers:SAV_INTAKE_READERS_REVISION,context:SAV_MESSAGE_CONTEXT_REVISION,
        otherRulesHash:intakeRuntimeHash(environment.SAV_OTHER_OBSERVATION_RULES_JSON??null),
        otherRoutingHash:intakeRuntimeHash(environment.SAV_INTAKE_OTHER_RULES_JSON??null),
        accessBinding:intakeRuntimeHash({model:environment.SAV_GEMINI_API_KEY,crm:environment.HUBSPOT_ACCESS_TOKEN})});
    expect(options.runtime.configHash).toBe(expected);
    expect(intakeRuntimeConfigurationHash(Object.fromEntries(Object.entries(pins).reverse()) as typeof pins,environment)).toBe(expected);
});
it("SAV-43: switching PDF reading on between deployments refuses continuity explicitly, never by a schema crash", async () => {
    const { row } = await observedWith("same");
    await executeIntakePass(row.id, options, { beforeMarker: async e => { if (e.kind === "email_create") throw Error("SYNTHETIC_DEPLOY_CUT"); } });
    environment = { ...environment, SAV_INTAKE_PDF_READING: "on" };
    const next = await newAuthorityOptions();
    expect(next.runtime.pdfReading).toBe(true);
    // The observation was made with PDFs unread: a different launch configuration, refused as such.
    await expect(previewIntakeExecutionContinuity(options.config.policyId, next)).rejects.toThrow("SAV_INTAKE_EXECUTION_CONTINUITY_REFUSED");
    expect(posts("/tickets")).toBe(1); expect(posts("/emails")).toBe(0);
});
async function newAuthorityOptions() {
    const cfg = JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!), rev = "b".repeat(40);
    environment = { ...environment, SAV_CODE_REVISION: rev, SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...cfg, codeRevision: rev }) };
    const runtime = savIntakeRuntimeConfig(environment)!, policy = { ...options.policy, codeRevision: rev };
    const grant = await approveIntakeExecutionPolicy(policy);
    environment = { ...environment, SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash };
    return { ...options, runtime, policy, config: intakeExecutionConfig(environment)! } as ExecutionOptions;
}

it.each(["revoked", "paused", "new_message", "active_lease", "changed_intent", "stale_preview", "human_refusal", "human_command", "budget_changed"])("refuses continuity when %s", async reason => {
    const { row, next } = await rotateAfterCut();
    const preview = await previewIntakeExecutionContinuity(options.config.policyId, next);
    if(reason==="revoked") await revokeIntakeExecutionPolicy(options.config.policyId,"Synthetic business revocation");
    if(reason==="paused") await f.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));
    if(reason==="new_message") await storedMessage(threadId,new Date(Date.now()+1000));
    if(reason==="active_lease") await f.db.update(savIntakeExecutions).set({leaseUntil:new Date(Date.now()+60000)}).where(eq(savIntakeExecutions.id,row.id));
    if(reason==="changed_intent") {const effects=await getExecutionEffects(row.id);await f.db.update(savIntakeEffects).set({intentHash:"c".repeat(64)}).where(eq(savIntakeEffects.id,effects[0].id));}
    if(reason==="human_refusal") await f.db.update(savThreads).set({humanRequestedAt:new Date()}).where(eq(savThreads.id,threadId));
    if(reason==="human_command")await f.db.insert(savIntakeHumanEvents).values({threadId,messageId,parentRunId:runId,parentVersion:1,baseConfigHash:options.runtime.configHash,sourceHash:"synthetic",kind:"refuse",state:"consumed",commandKey:randomUUID(),payloadCiphertext:encryptSavPayload({})});
    if(reason==="budget_changed") next.runtime={...next.runtime,maxCalls:29};
    await expect(approveIntakeExecutionContinuity(options.config.policyId,reason==="stale_preview"?"0".repeat(64):preview.hash,next)).rejects.toThrow();
    expect(posts("/tickets")).toBe(1);expect(posts("/emails")).toBe(0);
});

it.each(["sav-intake-semantic-2026-10-23.v5","sav-intake-semantic-2026-10-24.v6"])("recognizes historical %s without rewriting the run or charging AI",async revision=>{
    const {row,next}=await rotateAfterCut();
    const pins=JSON.parse(environment.SAV_INTAKE_RUNTIME_CONFIG!);pins.codeRevision=options.policy.codeRevision;
    const oldHash=intakeRuntimeConfigurationHash(pins,environment,revision);
    const [run]=await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,runId));
    const [execution]=await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id,row.id));
    await f.db.update(savIntakeRuns).set({configHash:oldHash}).where(eq(savIntakeRuns.id,runId));
    await f.db.update(savIntakeExecutions).set({payloadCiphertext:encryptSavPayload({...decryptSavPayload<object>(execution.payloadCiphertext),runtimeConfigHash:oldHash})}).where(eq(savIntakeExecutions.id,row.id));
    const preview=await previewIntakeExecutionContinuity(options.config.policyId,next,[row.id]);
    await approveIntakeExecutionContinuity(options.config.policyId,preview.hash,next,[row.id]);
    expect(await executeIntakePass(row.id,next)).toMatchObject({state:"confirmed"});
    const [after]=await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,runId));
    expect(after.configHash).toBe(oldHash);expect(after.payloadCiphertext).toBe(run.payloadCiphertext);expect(after.attempts).toBe(run.attempts);
    expect(posts("/tickets")).toBe(1);
});

it("finalizes already confirmed effects after delivery without any new provider write",async()=>{
    const {row}=await observedWith("same"),gmail=options.adapters.gmailCurrent;
    options.adapters.gmailCurrent=async(...args)=>{const effects=await getExecutionEffects(row.id);if(["ticket_create","email_create","email_associate"].every(kind=>effects.some(e=>e.kind===kind&&e.state==="confirmed")))throw Error("SYNTHETIC_FINALIZATION_CUT");return gmail(...args);};
    expect(await executeIntakePass(row.id,options)).toMatchObject({state:"waiting"});
    expect((await getExecutionEffects(row.id)).every(e=>e.state==="confirmed")).toBe(true);
    const next=await newAuthorityOptions();next.adapters={...next.adapters,gmailCurrent:gmail};
    const preview=await previewIntakeExecutionContinuity(options.config.policyId,next,[row.id]);await approveIntakeExecutionContinuity(options.config.policyId,preview.hash,next,[row.id]);
    const before=p.calls.filter(c=>["POST","PUT","PATCH"].includes(c.method)&&!/(search|batch\/read)$/.test(c.path)).length;
    expect(await executeIntakePass(row.id,next)).toMatchObject({state:"confirmed"});
    expect(p.calls.filter(c=>["POST","PUT","PATCH"].includes(c.method)&&!/(search|batch\/read)$/.test(c.path))).toHaveLength(before);
});

it("two concurrent approvals transfer once and never duplicate a provider action",async()=>{
    const {row,next}=await rotateAfterCut();const preview=await previewIntakeExecutionContinuity(options.config.policyId,next,[row.id]);
    const results=await Promise.allSettled([approveIntakeExecutionContinuity(options.config.policyId,preview.hash,next,[row.id]),approveIntakeExecutionContinuity(options.config.policyId,preview.hash,next,[row.id])]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const journals=await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId,row.id));
    expect(journals.filter(j=>j.kind==="authority_rotated")).toHaveLength(1);
    expect(await executeIntakePass(row.id,next)).toMatchObject({state:"confirmed"});expect(posts("/tickets")).toBe(1);
});

it("verifies an uncertain email after delivery without dispatching that email again",async()=>{
    const {row}=await observedWith("same");
    await executeIntakePass(row.id,options,{afterAck:async effect=>{if(effect.kind==="email_create")throw Error("SYNTHETIC_ACK_CUT");}});
    const effects=await getExecutionEffects(row.id),email=effects.find(e=>e.kind==="email_create")!;
    expect(email.state).not.toBe("confirmed");expect(email.dispatchedAt).not.toBeNull();expect(posts("/emails")).toBe(1);
    const next=await newAuthorityOptions(),preview=await previewIntakeExecutionContinuity(options.config.policyId,next,[row.id]);
    await approveIntakeExecutionContinuity(options.config.policyId,preview.hash,next,[row.id]);
    // Backoff is part of the existing effect; let it expire, never reset its counters.
    await f.db.update(savIntakeEffects).set({nextReconcileAt:new Date(Date.now()-1000)}).where(eq(savIntakeEffects.id,email.id));
    expect(await executeIntakePass(row.id,next)).toMatchObject({state:"confirmed"});
    expect(posts("/emails")).toBe(1);expect(posts("/tickets")).toBe(1);
    expect((await getExecutionEffects(row.id)).find(e=>e.id===email.id)?.state).toBe("confirmed");
});

it("selection leaves another held dossier and its authority intact",async()=>{
    const {row,next}=await rotateAfterCut();
    const otherThread=(await f.db.insert(savThreads).values({mailboxId,gmailThreadId:"held-thread",customerEmail:"held@example.invalid",aiPaused:true}).returning())[0];
    const otherMessage=await storedMessage(otherThread.id);
    const other=(await f.db.insert(savIntakeExecutions).values({messageId:otherMessage.id,threadId:otherThread.id,runVersion:1,policyId:options.config.policyId,policyHash:options.config.policyHash,payloadCiphertext:encryptSavPayload({}),state:"waiting"}).returning())[0];
    const preview=await previewIntakeExecutionContinuity(options.config.policyId,next,[row.id]);await approveIntakeExecutionContinuity(options.config.policyId,preview.hash,next,[row.id]);
    const [kept]=await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id,other.id));
    expect(kept.policyId).toBe(options.config.policyId);expect(kept.state).toBe("waiting");
    expect(await executeIntakePass(row.id,next)).toMatchObject({state:"confirmed"});
});

it.each(["source_revoked","target_revoked","actor_disabled","receipt_changed","source_changed"])("stops an approved continuation after %s", async reason => {
    const {row,next}=await rotateAfterCut();
    const preview=await previewIntakeExecutionContinuity(options.config.policyId,next);
    await approveIntakeExecutionContinuity(options.config.policyId,preview.hash,next);
    if(reason==="source_revoked")await revokeIntakeExecutionPolicy(options.config.policyId,"Synthetic later business revocation");
    if(reason==="target_revoked")await revokeIntakeExecutionPolicy(next.config.policyId,"Synthetic target business revocation");
    if(reason==="actor_disabled")await f.db.update(staffUsers).set({active:false}).where(eq(staffUsers.id,adminId));
    if(reason==="receipt_changed"){const [effect]=await getExecutionEffects(row.id);await f.db.update(savIntakeEffects).set({ackCiphertext:encryptSavPayload({id:"999"})}).where(eq(savIntakeEffects.id,effect.id));}
    if(reason==="source_changed")await f.db.update(savMessages).set({subject:"Edited source"}).where(eq(savMessages.id,messageId));
    expect(await executeIntakePass(row.id,next)).not.toMatchObject({state:"confirmed"});
    expect(posts("/tickets")).toBe(1);expect(posts("/emails")).toBe(0);
});

it.each(["unknown_incoming","human_outgoing","malformed"])("does not reopen after %s correspondence",async kind=>{
    p.seedTicket({stage:"closed",closedAt:new Date(Date.now()-1000).toISOString()});
    const {row}=await observedWith("same"),verify=options.adapters.verify;
    options.adapters.verify=async(...args)=>{const proof=await verify(...args);if(args[0].kind==="note_associate"&&proof.confirmed){nativeEmail("201","8801");
        if(kind==="unknown_incoming")p.objects.emails["8801"].properties.hs_email_text="A different incoming request from another thread.";
        if(kind==="human_outgoing"){p.objects.emails["8801"].properties.hs_email_direction="EMAIL";p.objects.emails["8801"].properties.hs_email_text="Resolved by the operator; do not reopen.";}
        if(kind==="malformed")delete p.objects.emails["8801"].properties.hs_email_from_email;
    }return proof;};
    expect(await executeIntakePass(row.id,options)).toMatchObject({state:"waiting"});
    expect(p.calls.filter(c=>c.method==="PATCH")).toHaveLength(0);
});
it.each(["create", "reopen"] as const)("AUDIT-5 CRM read volume of one nominal %s execution", async op => {
    if (op === "reopen") p.seedTicket({ stage: "closed", closedAt: new Date(Date.now() - 1000).toISOString() });
    const before = p.calls.length;
    const { row } = await observedWith("same");
    const planning = p.calls.length - before, start = p.calls.length;
    expect(await executeIntakePass(row.id, options)).toMatchObject({ state: "confirmed" });
    const exec = p.calls.slice(start), hub = exec.filter(c => !c.path.startsWith("gmail/"));
    const reads = hub.filter(c => c.method === "GET" || c.method === "POST" && /\/(search|batch\/read)$/.test(c.path));
    const writes = hub.filter(c => !reads.includes(c));
    console.info(`AUDIT-5 ${op}`, JSON.stringify({ planningReads: planning, effects: (await getExecutionEffects(row.id)).length, executionReads: reads.length, writes: writes.length, gmailReads: exec.filter(c => c.path.startsWith("gmail/")).length,
        byPath: Object.entries(reads.reduce((m: Record<string, number>, c) => { const k = `${c.method} ${c.path.replace(/\d+/g, "N")}`; m[k] = (m[k] ?? 0) + 1; return m; }, {})) }));
});
