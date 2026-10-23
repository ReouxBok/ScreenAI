import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savMailboxes, savThreads, savMessages, savIntakeRuns, savIntakeExecutions, savIntakeEffects, savIntakeExecutionPolicies, savIntakeOccupations, savSyncState, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, admissions: [] as string[], claims: [] as string[], policy: {} as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Only the admission/claim boundaries are probes. Selection SQL and canonical
// external-completion validation are real, including pagination and recovery.
vi.mock("./execution-store", async importOriginal => ({ ...await importOriginal<typeof import("./execution-store")>(),
    admitIntakeExecution: async (id: string) => { state.admissions.push(id); return null; },
    claimExecution: async (id: string) => { state.claims.push(id); return null; } }));
vi.mock("./human-binding", async importOriginal => ({ ...await importOriginal<typeof import("./human-binding")>(), intakeRunConfigurationBound: async () => true }));
vi.mock("./execution-policy", async importOriginal => ({ ...await importOriginal<typeof import("./execution-policy")>(), readIntakeExecutionAuthority: async () => ({ policy: state.policy }) }));
import { encryptSavPayload } from "../crypto";
import { SAV_EXTERNAL_COMPLETION, SAV_EXTERNAL_COMPLETION_REVERTED, listSavExternalCompletionMessageIds, hasUnsettledSavIntakeWork, getSavExternalCompletion, markSavDossiersHandledExternally } from "../external-completion";
import { scanIntakeExecutionCandidates, reconcileIntakeExecutor, pendingIntakeEffectRecoveries } from "./executor";
import { savIntakeRuntimeConfig, intakeRuntimeHash } from "./runtime-contract";
import { intakeExecutionConfig, type ExecutionPolicy } from "./execution-policy";
import type { ExecutionOptions, EffectIntent } from "./execution-types";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, options: ExecutionOptions, environment: Record<string, string>;
async function seed(index = 0, marked = false) {
    const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning();
    const [message] = await f.db.insert(savMessages).values({ threadId: thread.id, mailboxId, direction: "inbound", fromEmail: "synthetic@example.invalid", toEmails: ["support@example.invalid"],
        subject: "Synthetic request", bodyCiphertext: encryptSavPayload({ text: "Synthetic current request", attachments: [] }), receivedAt: new Date(Date.now() - 120000) }).returning();
    const [run] = await f.db.insert(savIntakeRuns).values({ threadId: thread.id, messageId: message.id, version: 1, state: "observed", configHash: options.runtime.configHash, policyHash: options.runtime.policyHash,
        payloadCiphertext: encryptSavPayload({}), createdAt: new Date(Date.now() - 60000 + index * 1000) }).returning();
    const [audit] = marked ? await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: SAV_EXTERNAL_COMPLETION, entityType: "sav_message", entityId: message.id,
        technicalMetadata: { version: 1, threadId: thread.id, batchId: randomUUID(), receivedBefore: new Date().toISOString(), reason: "processed_outside_studio" } }).returning() : [];
    return { thread, message, run, audit };
}
async function execution(row: Awaited<ReturnType<typeof seed>>, index: number, stateValue = "pending") {
    return (await f.db.insert(savIntakeExecutions).values({ messageId: row.message.id, threadId: row.thread.id, runId: row.run.id, runVersion: 1, policyId: options.config.policyId,
        policyHash: options.config.policyHash, state: stateValue, payloadCiphertext: encryptSavPayload({ keys: [] }), updatedAt: new Date(Date.now() - 60000 + index * 1000) }).returning())[0];
}
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-selection-encryption-key-32-characters");
    vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
    await f.client.exec("TRUNCATE sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies,sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; DELETE FROM sav.sync_state WHERE key in ('sav-intake-execution-scan-v1','sav-v0-cutover')");
    state.admissions = []; state.claims = [];
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
    const policy = { relationRevision: "synthetic", admittedRelations: [], resources: {} };
    environment = { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_INTAKE_EXECUTION_MODE: "execute", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "synthetic", HUBSPOT_ACCESS_TOKEN: "synthetic",
        SAV_ENCRYPTION_KEY_V1: process.env.SAV_ENCRYPTION_KEY_V1!, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
        SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId, createdAfter: new Date(Date.now() - 3600000).toISOString(), receivedAfter: new Date(Date.now() - 3600000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxCalls: 30, maxNanoUsd: 3000000000 }) };
    const runtime = savIntakeRuntimeConfig(environment)!;
    const authority: ExecutionPolicy = { revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: runtime.codeRevision, enginePolicyHash: runtime.policyHash, resourcesHash: runtime.resourcesHash,
        createdAfter: runtime.createdAfter, receivedAfter: runtime.receivedAfter, expiresAt: runtime.expiresAt, maxDossiers: 100, admission: { kind: "automatic" }, mutations: ["create_ticket"] };
    const [staff] = await f.db.insert(staffUsers).values({ clerkId: "synthetic", email: "ugo@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
    const [grant] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: authority.revision, state: "approved", administratorId: staff.id, policyHash: intakeRuntimeHash(authority), payloadCiphertext: encryptSavPayload(authority) }).returning();
    environment.SAV_INTAKE_EXECUTION_POLICY_ID = grant.id; environment.SAV_INTAKE_EXECUTION_POLICY_SHA256 = grant.policyHash;
    state.policy = authority;
    await f.db.insert(savSyncState).values({ key: "sav-intake-execution-schema-v1", status: "installed" }).onConflictDoNothing();
    // Native suites share a database; preceding migration scenarios may remove
    // the console marker. This fixture exercises installed-console semantics.
    await f.db.insert(savSyncState).values({ key: "sav-intake-console-schema-v1", status: "installed" }).onConflictDoUpdate({ target: savSyncState.key, set: { status: "installed" } });
    options = { runtime, policy: authority, config: intakeExecutionConfig(environment)!, env: () => environment, signal: AbortSignal.timeout(30000), adapters: {
        readCrm: async () => { throw Error("READ_CRM_FORBIDDEN"); }, scope: () => [], dispatch: vi.fn(async () => { throw Error("DISPATCH_FORBIDDEN"); }),
        verify: vi.fn(async () => ({ confirmed: false, attributed: false })), gmailCurrent: async () => {}, gmailPermissions: async () => {} } };
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("filters six handled candidates before LIMIT 4 so a live run is admitted immediately", async () => {
    for (let index = 0; index < 6; index++) await seed(index, true);
    const live = await seed(6);
    expect(await scanIntakeExecutionCandidates(options)).toBe(1);
    expect(state.admissions).toEqual([live.run.id]);
});
it("filters handled executions before LIMIT 1 so an older administrative row cannot starve a live execution", async () => {
    const old = await seed(0, true), live = await seed(1);
    await execution(old, 0); const next = await execution(live, 1);
    await reconcileIntakeExecutor({ env: () => environment, adapters: options.adapters });
    expect(state.claims).toEqual([next.id]);
});
it.each(["actor", "thread", "invalid-date", "revoked", "new-inbound"])("uses canonical audit proof instead of excluding an invalid %s marker", async change => {
    const row = await seed(0, true), audit = row.audit!;
    if (change === "actor") await f.db.update(auditLogs).set({ actorEmail: "other@example.invalid" }).where(eq(auditLogs.id, audit.id));
    if (change === "thread") await f.db.update(auditLogs).set({ technicalMetadata: { ...audit.technicalMetadata, threadId: randomUUID() } }).where(eq(auditLogs.id, audit.id));
    if (change === "invalid-date") await f.db.update(auditLogs).set({ technicalMetadata: { ...audit.technicalMetadata, receivedBefore: "invalid" } }).where(eq(auditLogs.id, audit.id));
    if (change === "revoked") await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: SAV_EXTERNAL_COMPLETION_REVERTED, entityType: "sav_message", entityId: row.message.id,
        technicalMetadata: { version: 1, batchId: audit.technicalMetadata.batchId, completionId: audit.id }, createdAt: new Date(audit.createdAt.getTime() + 1) });
    if (change === "new-inbound") await f.db.insert(savMessages).values({ threadId: row.thread.id, mailboxId, direction: "inbound", fromEmail: row.message.fromEmail, toEmails: row.message.toEmails,
        subject: "New synthetic inbound", bodyCiphertext: encryptSavPayload({ text: "New request" }), receivedAt: new Date() });
    expect(await listSavExternalCompletionMessageIds(f.db, false, mailboxId)).toEqual([]);
    expect(await scanIntakeExecutionCandidates(options)).toBe(1);
    expect(state.admissions).toEqual([row.run.id]);
});
it("reconciles a marked uncertain effect first in read-only mode, never dispatching it", async () => {
    const row = await seed(0, true), owner = await execution(row, 0, "uncertain");
    const intent: EffectIntent = { kind: "note_create", permission: "append_ticket_note", key: "synthetic-recovery", sourceMessageId: row.message.id };
    const [effect] = await f.db.insert(savIntakeEffects).values({ executionId: owner.id, businessKey: intent.key, kind: intent.kind, permission: intent.permission, state: "uncertain",
        intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), ackCiphertext: encryptSavPayload({ id: "901" }), dispatchedAt: new Date() }).returning();
    expect((await pendingIntakeEffectRecoveries()).map(e => e.id)).toEqual([owner.id]);
    expect(await reconcileIntakeExecutor({ env: () => ({ SAV_INTAKE_EXECUTION_RECOVERY: "read_only" }), adapters: options.adapters })).toMatchObject({ skipped: "off", recovered: 1 });
    expect(options.adapters.verify).toHaveBeenCalledOnce(); expect(options.adapters.dispatch).not.toHaveBeenCalled();
    const [saved] = await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, effect.id));
    expect(saved.ackCiphertext).toBe(effect.ackCiphertext); expect(saved.state).toBe("uncertain");
});

async function partialCreation() {
    const row = await seed(), owner = await execution(row, 0, "waiting");
    const intent: EffectIntent = { kind: "ticket_create", permission: "create_ticket", key: `synthetic-partial-${owner.id}`, sourceMessageId: row.message.id };
    await f.db.insert(savIntakeEffects).values({ executionId: owner.id, businessKey: intent.key, kind: intent.kind, permission: intent.permission, state: "confirmed", intentHash: intakeRuntimeHash(intent),
        intentCiphertext: encryptSavPayload(intent), ackCiphertext: encryptSavPayload({ id: "901" }), verificationCiphertext: encryptSavPayload({ confirmed: true }), dispatchedAt: new Date(), confirmedAt: new Date() });
    await f.db.insert(savIntakeEffects).values({ executionId: owner.id, businessKey: `${intent.key}-remaining`, kind: "email_create", permission: "associate_email", state: "planned", intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent) });
    await f.db.insert(savIntakeOccupations).values({ ownerId: owner.id, ownerKind: "intake", key: "contact:101" });
    await f.db.insert(savSyncState).values({ key: "sav-v0-cutover", status: "active", cursor: JSON.stringify({ mailboxEmail: "support@example.invalid", receivedAfter: new Date(Date.now() - 3600000).toISOString() }) });
    vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
    return { row, owner, command: { batchId: randomUUID(), receivedBefore: new Date().toISOString(), messages: [{ messageId: row.message.id, threadId: row.thread.id }] } };
}
it("blocks administrative completion and keeps an existing marker pending while a confirmed partial effect owns intake scope", async () => {
    const { row, owner, command } = await partialCreation();
    expect(await hasUnsettledSavIntakeWork(row.thread.id, f.db)).toBe(true);
    expect(await markSavDossiersHandledExternally(command, "ugo@limova.ai")).toMatchObject({ marked: 0, skipped: { unsettled_action: 1 } });
    await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: SAV_EXTERNAL_COMPLETION, entityType: "sav_message", entityId: row.message.id,
        technicalMetadata: { version: 1, threadId: row.thread.id, batchId: command.batchId, receivedBefore: command.receivedBefore, reason: "processed_outside_studio" } });
    expect(await getSavExternalCompletion(row.message, f.db)).toBeNull();
    expect(await listSavExternalCompletionMessageIds(f.db, true, mailboxId)).toEqual([]);
    expect(await listSavExternalCompletionMessageIds(f.db, false, mailboxId)).toEqual([row.message.id]);
    expect((await f.db.select().from(savIntakeOccupations))[0].ownerId).toBe(owner.id);
});
it("allows administrative completion after the execution is terminal and its scope is released", async () => {
    const { row, owner, command } = await partialCreation();
    await f.db.update(savIntakeExecutions).set({ state: "confirmed" }).where(eq(savIntakeExecutions.id, owner.id));
    await f.db.update(savIntakeEffects).set({ state: "confirmed" }).where(eq(savIntakeEffects.executionId, owner.id));
    await f.db.delete(savIntakeOccupations).where(eq(savIntakeOccupations.ownerId, owner.id));
    expect(await hasUnsettledSavIntakeWork(row.thread.id, f.db)).toBe(false);
    expect(await markSavDossiersHandledExternally(command, "ugo@limova.ai")).toMatchObject({ marked: 1, skipped: {} });
    expect(await getSavExternalCompletion(row.message, f.db)).not.toBeNull();
    expect(await listSavExternalCompletionMessageIds(f.db, true, mailboxId)).toEqual([row.message.id]);
});
