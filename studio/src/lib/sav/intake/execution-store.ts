import { readSavExternalCompletion, listSavExternalCompletionMessageIds } from "../external-completion";
import "server-only";
import { SAV_INTAKE_OPERATIONAL_PROFILE, intakeAdmissionUsage } from "./budget-profile";
import { intakeConsoleInstalled } from "./console-capability";
import { intakeRunConfigurationBound, intakeHumanRefused } from "./human-binding";
import { createHash, randomUUID } from "node:crypto";
import {canAccessSav} from "../access";
import {executionPolicySchema} from "./execution-policy";
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { staffUsers,savMailboxes,savIntakeHumanEvents,savIntakeExecutionPolicies,savActions, savThreads, savMessages, savIntakeRuns, savSyncState, savIntakeExecutions, savIntakeEffects, savIntakeEffectJournal, savIntakeOccupations, savIntakeExecutionBudget, savIntakeIdentityEpisodes, savIntakeEffectRevisions } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, assertSavIntakeObservation } from "./runtime-contract";
import { readSavIntakeCurrent, savIntakeSourceSnapshot, intakeSourceMatches, intakeRecordedSourceHash } from "./runtime-store";
import { savIntakeDecisionSchema } from "./contract";
import { savIntakePlanFingerprint } from "./engine";
import type { ExecutionPayload, Effect, EffectIntent, EffectAck, ExecutionOptions } from "./execution-types";
export type ExecutionTx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
export const admissionLock = async (tx: ExecutionTx) => { await tx.execute(sql `select pg_advisory_xact_lock(hashtext('sav-intake-common-admission-v1'))`); };
export const executionJournal = async (tx: ExecutionTx, id: string, kind: string, payload: unknown, effectId?: string) => {
    await tx.insert(savIntakeEffectJournal).values({
        executionId: id, effectId, kind, payloadCiphertext: encryptSavPayload(payload)
    });
};
const fault = (code = "CONTEXT_CHANGED"): never => { throw Error(`SAV_INTAKE_EXECUTION_${code}`); };
export function executionMessageHash(m: typeof savMessages.$inferSelect) {
    return intakeRuntimeHash({
        id: m.id, threadId: m.threadId, mailboxId: m.mailboxId, fromEmail: m.fromEmail, toEmails: m.toEmails, subject: m.subject, body: m.bodyCiphertext, receivedAt: m.receivedAt, direction: m.direction, gmailMessageId: m.gmailMessageId, hubspotEmailId: m.hubspotEmailId
    });
}
export async function occupationSchemaInstalled() {
    const [row] = await requireDb().select({
        key: savSyncState.key
    }).from(savSyncState).where(eq(savSyncState.key, "sav-intake-execution-schema-v1"));
    if (!row) {
        const proof = await requireDb().select({
            id: savMessages.id
        }).from(savMessages).where(sql `${savMessages.analysisStatus} like 'intake_execution_%'`).limit(1);
        if (proof.length)
            return fault("MIGRATION_REQUIRED");
    }
    return Boolean(row);
}
/** Global lock is held only for this atomic transfer to sorted durable keys. */
export async function occupyKeys(tx: ExecutionTx, ownerId: string, ownerKind: "intake" | "legacy", keys: string[]) {
    await admissionLock(tx);
    const sorted = [...new Set(keys)].sort();
    if (!sorted.length || sorted.length > 100)
        return fault("SCOPE_INVALID");
    const rows = await tx.select().from(savIntakeOccupations).where(inArray(savIntakeOccupations.key, sorted));
    if (rows.some(r => r.ownerId !== ownerId || r.ownerKind !== ownerKind))
        return fault("SCOPE_OCCUPIED");
    for (const key of sorted)
        await tx.insert(savIntakeOccupations).values({
            key, ownerId, ownerKind
        }).onConflictDoNothing();
}
export async function releaseKeys(tx: ExecutionTx, ownerId: string) { await admissionLock(tx); await tx.delete(savIntakeOccupations).where(eq(savIntakeOccupations.ownerId, ownerId)); }
/** A local hold can arrive after admission but before a worker ever dispatches.
 * Fence that abandoned lease and release only provably unused intake scope.
 * Provider receipts, including confirmed partial effects, are never handled here. */
export async function releaseNeverDispatchedIntakeScopes(mailboxId: string, now = new Date()) {
    const db = requireDb(), handledIds = await listSavExternalCompletionMessageIds(db, false, mailboxId);
    const consoleInstalled = await intakeConsoleInstalled(db);
    const unsafeEffect = sql`(f.state <> 'planned' or f.dispatched_at is not null or f.dispatch_token is not null or f.ack_ciphertext is not null or f.verification_ciphertext is not null or f.confirmed_at is not null)`;
    const candidates = await db.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions)
        .innerJoin(savThreads, eq(savThreads.id, savIntakeExecutions.threadId)).where(and(
            eq(savThreads.mailboxId, mailboxId), inArray(savIntakeExecutions.state, ["pending", "waiting", "running", "uncertain"]),
            or(sql`${savIntakeExecutions.leaseUntil} is null`, lte(savIntakeExecutions.leaseUntil, now)),
            sql`not exists(select 1 from sav.intake_runs r where r.thread_id=${savIntakeExecutions.threadId} and r.lease_until>${now.toISOString()}::timestamptz)`,
            consoleInstalled ? sql`not exists(select 1 from sav.intake_human_events h where h.thread_id=${savIntakeExecutions.threadId} and h.lease_until>${now.toISOString()}::timestamptz)` : undefined,
            sql`exists(select 1 from sav.intake_occupations o where o.owner_kind='intake' and o.owner_id=${savIntakeExecutions.id})`,
            sql`not exists(select 1 from sav.intake_effects f where f.execution_id=${savIntakeExecutions.id} and ${unsafeEffect})`,
            or(eq(savThreads.aiPaused, true), handledIds.length ? inArray(savIntakeExecutions.messageId, handledIds) : undefined,
                consoleInstalled ? sql`exists(select 1 from sav.intake_human_events h where h.message_id=${savIntakeExecutions.messageId} and h.kind='refuse')` : undefined)
        )).orderBy(savIntakeExecutions.updatedAt, savIntakeExecutions.id).limit(10);
    let released = 0;
    for (const candidate of candidates) {
        const done = await db.transaction(async tx => {
            await admissionLock(tx);
            const [row] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, candidate.id)).for("update");
            if (!row || ["confirmed", "refused"].includes(row.state) || row.leaseUntil && row.leaseUntil > now) return false;
            const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, row.threadId)).for("update");
            const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, row.messageId));
            if (!thread || thread.mailboxId !== mailboxId || !message || message.threadId !== row.threadId || message.mailboxId !== mailboxId) return false;
            const [activeRun] = await tx.select({ id: savIntakeRuns.id }).from(savIntakeRuns)
                .where(and(eq(savIntakeRuns.threadId, row.threadId), sql`${savIntakeRuns.leaseUntil}>${now.toISOString()}::timestamptz`)).limit(1);
            const [activeCommand] = consoleInstalled ? await tx.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents)
                .where(and(eq(savIntakeHumanEvents.threadId, row.threadId), sql`${savIntakeHumanEvents.leaseUntil}>${now.toISOString()}::timestamptz`)).limit(1) : [];
            if (activeRun || activeCommand) return false;
            const external = Boolean(await readSavExternalCompletion(message, tx));
            const refused = await intakeHumanRefused(message.id, tx);
            if (!thread.aiPaused && !external && !refused) return false;
            const effects = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, row.id)).for("update");
            if (effects.some(effect => effect.state !== "planned" || effect.dispatchedAt !== null || effect.dispatchToken !== null || effect.ackCiphertext !== null || effect.verificationCiphertext !== null || effect.confirmedAt !== null)) return false;
            const payload = decryptSavPayload<ExecutionPayload>(row.payloadCiphertext);
            const owned = await tx.select().from(savIntakeOccupations).where(and(eq(savIntakeOccupations.ownerId, row.id), eq(savIntakeOccupations.ownerKind, "intake"))).for("update");
            if (!owned.length || !Array.isArray(payload.keys) || owned.some(key => !payload.keys.includes(key.key))) return false;
            await tx.update(savIntakeExecutions).set({ state: "waiting", leaseToken: null, leaseUntil: null,
                payloadCiphertext: encryptSavPayload({ ...payload, reason: "SAV_INTAKE_EXECUTION_LOCAL_FENCE_BEFORE_DISPATCH" }), updatedAt: now
            }).where(eq(savIntakeExecutions.id, row.id));
            // owner kind is checked explicitly: a malformed legacy owner is not ours.
            const deleted = await tx.delete(savIntakeOccupations).where(and(eq(savIntakeOccupations.ownerId, row.id), eq(savIntakeOccupations.ownerKind, "intake"), inArray(savIntakeOccupations.key, owned.map(key => key.key)))).returning({ key: savIntakeOccupations.key });
            if (deleted.length !== owned.length) return fault("OCCUPATION_LOST");
            await executionJournal(tx, row.id, "never_dispatched_scope_released", { messageId: message.id, paused: thread.aiPaused, external, refused, effectIds: effects.map(effect => effect.id), dispatch: false });
            return true;
        });
        if (done) released++;
    }
    return { released };
}
export async function assertNoLegacyConflict(tx: ExecutionTx, keys: string[]) {
    const actions = await tx.select().from(savActions).where(and(inArray(savActions.kind, ["create_ticket", "link_ticket", "create_note", "log_email", "update_ticket_status", "send_reply", "request_human"]), sql `${savActions.status} <> 'succeeded' and (${savActions.status} in ('pending','running') or ${savActions.payload}->>'ticketCreateDispatchedAt' is not null or ${savActions.payload}->>'ticketReturnDispatchedAt' is not null or ${savActions.payload}->>'replySendDispatchedAt' is not null or ${savActions.payload}->>'forwardDispatchedAt' is not null or ${savActions.payload}->>'intakeOccupationDispatchedAt' is not null)`)).limit(201);
    if (actions.length > 200)
        return fault("LEGACY_SCOPE_UNKNOWN");
    const active = actions.filter(a => a.status !== "succeeded" && (["pending", "running"].includes(a.status) || ["ticketCreateDispatchedAt", "ticketReturnDispatchedAt", "replySendDispatchedAt", "forwardDispatchedAt", "intakeOccupationDispatchedAt"].some(k => a.payload[k])));
    const occupations = await tx.select().from(savIntakeOccupations).where(eq(savIntakeOccupations.ownerKind, "legacy"));
    for (const action of active) {
        const scope = occupations.filter(o => o.ownerId === action.id);
        if (!scope.length || scope.some(o => keys.includes(o.key)))
            return fault("LEGACY_SCOPE_OCCUPIED");
    }
}
async function handoffObsoleteExecutions(tx: ExecutionTx, threadId: string, messageId: string) {
    const old = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.threadId, threadId)).for("update");
    for (const execution of old) {
        // A new message cannot rewrite the historical outcome of a terminal
        // execution. Its receipts remain available for review and lot3.
        if (execution.state === "confirmed" || execution.state === "refused" || execution.messageId === messageId)
            continue;
        const effects = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, execution.id));
        if (effects.some(e => !["planned", "confirmed"].includes(e.state)))
            continue;
        // Fence the older worker before transferring scopes. No uncertain result is
        // ever inferred absent, and no effect receipt is copied into the new plan.
        await tx.update(savIntakeExecutions).set({
            state: "refused", leaseToken: null, leaseUntil: null, updatedAt: new Date()
        }).where(eq(savIntakeExecutions.id, execution.id));
        await releaseKeys(tx, execution.id);
        await executionJournal(tx, execution.id, "new_message_handoff", {
            nextMessageId: messageId, confirmedEffects: effects.filter(e => e.state === "confirmed").map(e => e.id)
        });
    }
}
export async function admitIntakeExecution(runId: string, options: ExecutionOptions) {
    const currentRun = await requireDb().select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
    const run = currentRun[0];
    if (!run)
        return null;
    const current = await readSavIntakeCurrent(run.threadId, options.runtime);
    if (!current || current.id !== runId || !current.sourceMatches || run.state !== "observed" || !await intakeRunConfigurationBound(run, options.runtime) || Date.parse(options.runtime.expiresAt) <= Date.now())
        return null;
    // Expired observations keep their dates. Before any mutation the writer makes
    // a full authoritative CRM/Gmail/source revalidation of the unchanged facts.
    const plan = current.payload.plan;
    if (!plan || !["ticket", "request_identification"].includes(plan.decision.disposition.kind))
        return null;
    if (plan.decision.disposition.kind === "request_identification"
        && (current.payload.input as {humanResolution?:{suppressOutbound?:boolean}} | undefined)?.humanResolution?.suppressOutbound) return null;
    assertSavIntakeObservation(plan);
    savIntakeDecisionSchema.parse(plan.decision);
    if (plan.fingerprint !== savIntakePlanFingerprint(plan) || plan.decision.messageId !== run.messageId)
        return fault("PLAN_INVALID");
    const p = options.policy;
    if (p.budgetProfile !== options.runtime.budgetProfile || p.mailboxId !== options.runtime.mailboxId || p.enginePolicyHash !== options.runtime.policyHash || p.resourcesHash !== options.runtime.resourcesHash || p.admission.kind === "qualification" && !p.admission.runIds.includes(runId))
        return fault("NOT_ADMITTED");
    return requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, run.threadId)).for("update");
        const [m] = await tx.select().from(savMessages).where(eq(savMessages.id, run.messageId));
        if (m && await readSavExternalCompletion(m, tx)) return null;
        const [existing] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, run.messageId)).for("update");
        if (existing) {
            if(existing.policyId===options.config.policyId&&existing.policyHash===options.config.policyHash)return existing;
            const input=current.payload.input as {humanResolution?:{suppressOutbound?:boolean}}|undefined;
            if(!input?.humanResolution?.suppressOutbound||!run.humanChoiceCiphertext||["confirmed","refused"].includes(existing.state))return existing;
            const reject=()=>fault("RECOVERY_AUTHORITY_REBIND_REFUSED"),payload=decryptSavPayload<ExecutionPayload>(existing.payloadCiphertext);
            const [actual]=await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,run.id)).for("update");
            if(!thread||!m||thread.aiPaused||m.mailboxId!==p.mailboxId||m.createdAt<=new Date(p.createdAfter)||m.receivedAt<=new Date(p.receivedAfter)
                ||existing.leaseUntil&&existing.leaseUntil>new Date()||!["waiting","pending"].includes(existing.state)
                ||!actual?.isCurrent||actual.state!=="observed"||actual.payloadCiphertext!==run.payloadCiphertext||actual.sourceHash!==run.sourceHash
                ||actual.configHash!==run.configHash||actual.humanChoiceCiphertext!==run.humanChoiceCiphertext
                ||existing.runId!==run.id||existing.runVersion!==run.version||payload.lastRunId!==run.id||payload.acceptedFingerprint!==plan.fingerprint
                ||payload.local.sourceHash!==run.sourceHash||intakeRuntimeHash(payload.plan)!==intakeRuntimeHash(plan)
                ||payload.local.humanChoice!==run.humanChoiceCiphertext||intakeRuntimeHash(payload.input)!==intakeRuntimeHash(current.payload.input))return reject();
            const effects=await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId,existing.id)).for("update");
            if(effects.some(e=>e.state!=="planned"||e.dispatchedAt||e.dispatchToken||e.ackCiphertext||e.confirmedAt))return reject();
            const authorities=await tx.select().from(savIntakeExecutionPolicies).where(inArray(savIntakeExecutionPolicies.id,[existing.policyId,options.config.policyId])).for("update");
            const old=authorities.find(a=>a.id===existing.policyId),next=authorities.find(a=>a.id===options.config.policyId);
            if(old?.state!=="revoked"||old.policyHash!==existing.policyHash||next?.state!=="approved"||next.policyHash!==options.config.policyHash
                ||intakeRuntimeHash(decryptSavPayload(next.payloadCiphertext))!==options.config.policyHash
                ||intakeRuntimeHash(executionPolicySchema.parse(p))!==options.config.policyHash
                ||p.codeRevision!==options.config.codeRevision||p.codeRevision!==options.runtime.codeRevision||Date.parse(p.expiresAt)<=Date.now())return reject();
            const [administrator]=await tx.select().from(staffUsers).where(eq(staffUsers.id,next.administratorId)).for("update");
            if(!administrator?.active||!["admin","owner"].includes(administrator.role)||!canAccessSav(administrator.email,administrator.role))return reject();
            payload.runtimeConfigHash=options.runtime.configHash;
            const [updated]=await tx.update(savIntakeExecutions).set({policyId:next.id,policyHash:next.policyHash,payloadCiphertext:encryptSavPayload(payload),updatedAt:new Date()}).where(eq(savIntakeExecutions.id,existing.id)).returning();
            await executionJournal(tx,existing.id,"operator_recovery_authority_rebound",{previousPolicyId:existing.policyId,policyId:next.id,runId:run.id,neverDispatched:true,admissionCountUnchanged:true,outboundSuppressed:true});
            return updated;
        }
        if (!m || m.mailboxId !== p.mailboxId || m.createdAt <= new Date(p.createdAfter) || m.receivedAt <= new Date(p.receivedAfter) || thread.aiPaused)
            return fault("NOT_ADMITTED");
        const [budget] = await tx.select().from(savIntakeExecutionBudget).where(eq(savIntakeExecutionBudget.id, "global")).for("update");
        const old = await tx.select({
            id: savIntakeExecutions.id, createdAt:savIntakeExecutions.createdAt
        }).from(savIntakeExecutions);
        if (!budget || budget.admitted !== old.length || intakeAdmissionUsage(old,p.budgetProfile===SAV_INTAKE_OPERATIONAL_PROFILE) >= p.maxDossiers)
            return fault("ADMISSION_LIMIT");
        const keys = [`thread:${thread.id}`, ...(plan.decision.disposition.kind === "ticket" ? plan.decision.disposition.contactScope.contacts.map(c => `contact:${c.contactId}`) : []), ...(plan.candidateContactIds ?? []).map(id => `contact:${id}`)];
        if (plan.decision.disposition.kind === "ticket" && plan.decision.disposition.target.operation !== "create")
            keys.push(`ticket:${plan.decision.disposition.target.ticketId}`);
        await handoffObsoleteExecutions(tx, thread.id, m.id);
        const id = randomUUID();
        await assertNoLegacyConflict(tx, keys);
        await occupyKeys(tx, id, "intake", keys);
        const payload: ExecutionPayload = {
            runtimeConfigHash: options.runtime.configHash,
            plan, input: current.payload.input, keys, lastRunId: runId, acceptedFingerprint: plan.fingerprint, local: {
                threadIdentityHash: intakeRuntimeHash({
                    mailbox: thread.mailboxId, gmail: thread.gmailThreadId, customer: thread.customerEmail
                }), messageHash: executionMessageHash(m), sourceHash: run.sourceHash, humanChoice: run.humanChoiceCiphertext, humanRequestedAt: thread.humanRequestedAt?.toISOString() ?? null, status: thread.status, ticketId: thread.hubspotTicketId
            }
        };
        const [execution] = await tx.insert(savIntakeExecutions).values({
            id, messageId: m.id, threadId: m.threadId, runId, runVersion: run.version, policyId: options.config.policyId, policyHash: options.config.policyHash, payloadCiphertext: encryptSavPayload(payload), ticketId: plan.decision.disposition.kind === "ticket" && plan.decision.disposition.target.operation !== "create" ? plan.decision.disposition.target.ticketId : null
        }).returning();
        await tx.update(savMessages).set({
            analysisStatus: "intake_execution_pending"
        }).where(eq(savMessages.id, m.id));
        await tx.update(savIntakeExecutionBudget).set({
            admitted: budget.admitted + 1
        }).where(eq(savIntakeExecutionBudget.id, "global"));
        await executionJournal(tx, id, "admitted", {
            observationFresh: current.fresh, authoritativeRevalidationRequired: true, runId, version: run.version, policyId: execution.policyId, actorType: "ai", keys
        });
        return execution;
    });
}
export async function claimExecution(id: string, now = new Date()) {
    return requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        const [row] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, id)).for("update");
        if (!row || row.state === "confirmed" || row.state === "refused" || row.leaseUntil && row.leaseUntil > now)
            return null;
        const payload = decryptSavPayload<ExecutionPayload>(row.payloadCiphertext);
        await assertNoLegacyConflict(tx, payload.keys);
        await occupyKeys(tx, row.id, "intake", payload.keys);
        const token = randomUUID();
        const [claimed] = await tx.update(savIntakeExecutions).set({
            leaseToken: token, leaseUntil: new Date(now.getTime() + 80000), state: "running", updatedAt: now
        }).where(eq(savIntakeExecutions.id, id)).returning();
        return {
            row: claimed, token, payload: decryptSavPayload<ExecutionPayload>(claimed.payloadCiphertext)
        };
    });
}
export type ExecutionLease = NonNullable<Awaited<ReturnType<typeof claimExecution>>>;
export async function assertExecutionLocal(tx: ExecutionTx, lease: ExecutionLease, now = new Date()) {
    await admissionLock(tx);
    const [row] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, lease.row.id)).for("update");
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, lease.row.threadId)).for("update");
    const [run] = row?.runId ? await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, row.runId)) : [];
    const [m] = await tx.select().from(savMessages).where(eq(savMessages.id, lease.row.messageId));
    const [last] = await tx.select({
        id: savMessages.id
    }).from(savMessages).where(and(eq(savMessages.threadId, lease.row.threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    if (!row || row.leaseToken !== lease.token || !row.leaseUntil || row.leaseUntil <= now || row.state !== "running" || !thread || thread.aiPaused || !run?.isCurrent || run.id !== lease.payload.lastRunId || (decryptSavPayload<{
        plan?: {
            fingerprint?: string;
        };
    }>(run.payloadCiphertext).plan?.fingerprint !== lease.payload.acceptedFingerprint) || run.humanChoiceCiphertext !== lease.payload.local.humanChoice || last?.id !== row.messageId || !m || executionMessageHash(m) !== lease.payload.local.messageHash || !intakeSourceMatches(await savIntakeSourceSnapshot(tx, m, now), lease.payload.local.sourceHash) || thread.humanRequestedAt?.toISOString() !== (lease.payload.local.humanRequestedAt ?? undefined) || thread.status !== lease.payload.local.status || thread.hubspotTicketId !== lease.payload.local.ticketId || intakeRuntimeHash({
        mailbox: thread.mailboxId, gmail: thread.gmailThreadId, customer: thread.customerEmail
    }) !== lease.payload.local.threadIdentityHash)
        return fault();
    if (await readSavExternalCompletion(m, tx)) return fault("HANDLED_EXTERNALLY");
    const keys = await tx.select().from(savIntakeOccupations).where(eq(savIntakeOccupations.ownerId, row.id));
    if (lease.payload.keys.some(k => !keys.some(o => o.key === k)))
        return fault("OCCUPATION_LOST");
    return row;
}
export async function saveExecutionPayload(lease: ExecutionLease) {
    await requireDb().transaction(async (tx) => {
        await assertExecutionLocal(tx, lease);
        await tx.update(savIntakeExecutions).set({
            payloadCiphertext: encryptSavPayload(lease.payload), updatedAt: new Date()
        }).where(eq(savIntakeExecutions.id, lease.row.id));
    });
}
export async function expandExecutionScope(lease: ExecutionLease, keys: string[]) {
    await requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        await assertExecutionLocal(tx, lease);
        await assertNoLegacyConflict(tx, keys);
        await occupyKeys(tx, lease.row.id, "intake", keys);
        lease.payload.keys = [...new Set([...lease.payload.keys, ...keys])].sort();
        await tx.update(savIntakeExecutions).set({
            payloadCiphertext: encryptSavPayload(lease.payload)
        }).where(eq(savIntakeExecutions.id, lease.row.id));
    });
}
export async function activeExecutionEffects(id: string, tx: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) {
    const installed = await intakeConsoleInstalled(tx);
    if (!installed) {
      const proof = await tx.select({ id: savIntakeRuns.id }).from(savIntakeRuns).innerJoin(savIntakeExecutions, eq(savIntakeExecutions.runId, savIntakeRuns.id))
        .where(and(eq(savIntakeExecutions.id, id), sql`${savIntakeRuns.humanChoiceCiphertext} is not null`)).limit(1);
      if (proof.length) return fault("CONSOLE_MIGRATION_REQUIRED");
    }
    const active = installed ? sql`not exists (select 1 from sav.intake_effect_revisions r where r.effect_id=${savIntakeEffects.id} and not r.active)` : undefined;
    return tx.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, id), active)).orderBy(savIntakeEffects.createdAt, savIntakeEffects.id);
}
export async function getExecutionEffects(id: string) { return activeExecutionEffects(id); }
export async function ensureExecutionEffect(lease: ExecutionLease, intent: EffectIntent) {
    return requireDb().transaction(async (tx) => {
        await assertExecutionLocal(tx, lease);
        const [old] = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.businessKey, intent.key));
        const hash = intakeRuntimeHash(intent);
        if (old) {
            const [revision] = await intakeConsoleInstalled(tx) ? await tx.select().from(savIntakeEffectRevisions).where(eq(savIntakeEffectRevisions.effectId, old.id)) : [];
            if (revision && !revision.active && revision.revisionRunId === lease.payload.lastRunId
                && old.executionId === lease.row.id && old.state === "planned" && !old.dispatchedAt && !old.dispatchToken && !old.ackCiphertext && !old.confirmedAt) {
                await executionJournal(tx, lease.row.id, "human_intent_replaced", { previous: decryptSavPayload(old.intentCiphertext), next: intent, eventId: revision.eventId }, old.id);
                const [updated] = await tx.update(savIntakeEffects).set({ intentHash: hash, intentCiphertext: encryptSavPayload(intent), kind: intent.kind, permission: intent.permission }).where(eq(savIntakeEffects.id, old.id)).returning();
                await tx.update(savIntakeEffectRevisions).set({ active: true }).where(eq(savIntakeEffectRevisions.effectId, old.id));
                return updated;
            }
            if (old.executionId !== lease.row.id || old.intentHash !== hash || revision && !revision.active)
                return fault("EFFECT_INTENT_CHANGED");
            return old;
        }
        const [row] = await tx.insert(savIntakeEffects).values({
            executionId: lease.row.id, businessKey: intent.key, kind: intent.kind, permission: intent.permission, intentHash: hash, intentCiphertext: encryptSavPayload(intent)
        }).returning();
        await executionJournal(tx, lease.row.id, "effect_planned", {
            intentHash: hash, kind: intent.kind, businessKey: intent.key
        }, row.id);
        return row;
    });
}
export async function markEffectDispatched(lease: ExecutionLease, effect: Effect) {
    return requireDb().transaction(async (tx) => {
        await assertExecutionLocal(tx, lease);
        const [row] = await tx.update(savIntakeEffects).set({
            state: "dispatched", dispatchToken: lease.token, dispatchedAt: new Date()
        }).where(and(eq(savIntakeEffects.id, effect.id), eq(savIntakeEffects.state, "planned"))).returning();
        if (!row)
            return fault("RECONCILIATION_REQUIRED");
        await executionJournal(tx, lease.row.id, "dispatched", {
            attemptId: row.attemptId, token: lease.token
        }, row.id);
        return row;
    });
}
/** These receipt functions deliberately do not depend on live authority/lease. */
export async function recordEffectAck(effect: Effect, ack: EffectAck) {
    await requireDb().transaction(async (tx) => {
        const [old] = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, effect.id)).for("update");
        if (!old || old.attemptId !== effect.attemptId || old.state === "planned")
            return fault("ACK_REJECTED");
        if (old.ackCiphertext && intakeRuntimeHash(decryptSavPayload(old.ackCiphertext)) !== intakeRuntimeHash(ack))
            return fault("ACK_CONFLICT");
        if (old.state !== "confirmed")
            await tx.update(savIntakeEffects).set({
                state: "acked", ackCiphertext: encryptSavPayload(ack)
            }).where(eq(savIntakeEffects.id, old.id));
        await executionJournal(tx, old.executionId, "ack", {
            attemptId: old.attemptId, ack
        }, old.id);
    });
}
export async function confirmExecutionEffect(effect: Effect, proof: unknown, ack?: EffectAck) {
    await requireDb().transaction(async (tx) => {
        const [row] = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, effect.id)).for("update");
        if (!row || row.state === "planned")
            return fault("CONFIRMATION_REJECTED");
        await tx.update(savIntakeEffects).set({
            state: "confirmed", verificationCiphertext: encryptSavPayload(proof), confirmedAt: new Date(), ...(ack ? {
                ackCiphertext: encryptSavPayload(ack)
            } : {})
        }).where(eq(savIntakeEffects.id, effect.id));
        await executionJournal(tx, row.executionId, "confirmed", proof, row.id);
    });
}
/** Complete only the local record of an already verified identification send.
 * No authority is resurrected and this operation has no dispatch capability. */
export async function finishVerifiedIdentityRecovery(executionId: string) {
    return requireDb().transaction(async tx => {
        await admissionLock(tx);
        const [row] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, executionId)).for("no key update");
        if (!row || !row.runId || ["confirmed", "refused"].includes(row.state) || row.leaseUntil && row.leaseUntil > new Date()) return false;
        const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, row.threadId)).for("update");
        const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, row.messageId));
        const [latest] = await tx.select({id:savMessages.id}).from(savMessages).where(and(eq(savMessages.threadId,row.threadId),eq(savMessages.direction,"inbound")))
            .orderBy(desc(savMessages.receivedAt),desc(savMessages.createdAt),desc(savMessages.id)).limit(1);
        const [run] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,row.runId)).for("update");
        const [pending] = await tx.select({id:savIntakeHumanEvents.id}).from(savIntakeHumanEvents)
            .where(and(eq(savIntakeHumanEvents.messageId,row.messageId),inArray(savIntakeHumanEvents.state,["pending","reading"]))).limit(1);
        const effects = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId,row.id)).for("update");
        const effect = effects[0], payload = decryptSavPayload<ExecutionPayload>(row.payloadCiphertext), d = payload.plan.decision.disposition;
        if (!thread || thread.aiPaused || !message || message.direction!=="inbound" || message.mailboxId!==thread.mailboxId || latest?.id!==message.id
            || !run?.isCurrent || run.messageId!==message.id || run.threadId!==thread.id || run.version!==row.runVersion || payload.lastRunId!==run.id
            || run.leaseUntil && run.leaseUntil>new Date() || run.humanChoiceCiphertext!==payload.local.humanChoice
            || pending || await intakeHumanRefused(message.id,tx) || row.ticketId!==null || d.kind!=="request_identification" || payload.plan.decision.messageId!==message.id
            || intakeRuntimeHash({mailbox:thread.mailboxId,gmail:thread.gmailThreadId,customer:thread.customerEmail})!==payload.local.threadIdentityHash
            || effects.length!==1 || effect.kind!=="identity_send" || effect.state!=="confirmed" || !effect.dispatchedAt || !effect.confirmedAt
            || !effect.ackCiphertext || !effect.verificationCiphertext || payload.acceptedFingerprint!==savIntakePlanFingerprint(payload.plan)
            || run.sourceHash!==payload.local.sourceHash || executionMessageHash(message)!==payload.local.messageHash) return false;
        const plan = decryptSavPayload<{plan?:unknown}>(run.payloadCiphertext).plan;
        const intent = decryptSavPayload<EffectIntent>(effect.intentCiphertext), ack = decryptSavPayload<EffectAck>(effect.ackCiphertext);
        const proof = decryptSavPayload<{confirmed?:boolean;attributed?:boolean;ack?:EffectAck}>(effect.verificationCiphertext);
        const [mailbox] = await tx.select().from(savMailboxes).where(eq(savMailboxes.id,thread.mailboxId));
        if (intakeRuntimeHash(plan)!==intakeRuntimeHash(payload.plan) || intent.kind!=="identity_send" || intent.permission!=="send_identity_template"
            || effect.intentHash!==intakeRuntimeHash(intent) || intent.sourceMessageId!==message.id || intent.mailbox!==mailbox?.email || intent.threadId!==thread.gmailThreadId
            || intent.recipient!==message.fromEmail || payload.plan.originalRecipientEmails.length!==1 || payload.plan.originalRecipientEmails[0]!==intent.recipient
            || !ack.id || proof.confirmed!==true || proof.attributed!==true || proof.ack?.id!==ack.id || !intent.text || !intent.resource
            || createHash("sha256").update(intent.text).digest("hex")!==intent.resource.sha256
            || intakeRuntimeHash(intent.resource)!==intakeRuntimeHash({resourceId:d.template.resourceId,revisionId:d.template.revisionId,sha256:d.template.sha256})) return false;
        const snapshot = await savIntakeSourceSnapshot(tx,message,new Date());
        if (!intakeSourceMatches(snapshot,payload.local.sourceHash)) return false;
        const completion = {sourceHash:payload.local.sourceHash!,messageHash:executionMessageHash(message)};
        await tx.update(savIntakeExecutions).set({state:"confirmed",leaseToken:null,leaseUntil:null,payloadCiphertext:encryptSavPayload({...payload,reason:undefined,effectsConfirmed:true,completion}),updatedAt:new Date()})
            .where(eq(savIntakeExecutions.id,row.id));
        await tx.update(savMessages).set({analysisStatus:"intake_execution_identity_wait"}).where(eq(savMessages.id,message.id));
        await releaseKeys(tx,row.id);
        await executionJournal(tx,row.id,"verified_identity_recovery_finished",{messageId:message.id,effectId:effect.id,dispatch:false});
        return true;
    });
}
export async function deferExecutionEffect(effect: Effect, reason: string) {
    await requireDb().transaction(async (tx) => {
        const [row] = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, effect.id)).for("update");
        if (row?.state !== "confirmed") {
            await tx.update(savIntakeEffects).set({
                state: "uncertain", reconcileAttempts: (row?.reconcileAttempts ?? 0) + 1, nextReconcileAt: new Date(Date.now() + 60000)
            }).where(eq(savIntakeEffects.id, effect.id));
            await executionJournal(tx, effect.executionId, "uncertain", {
                reason
            }, effect.id);
        }
    });
}
export async function endExecutionPass(lease: ExecutionLease, state: "waiting" | "uncertain", reason: string) {
    await requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        const rows = await tx.update(savIntakeExecutions).set({
            state, leaseToken: null, leaseUntil: null, payloadCiphertext: encryptSavPayload({
                ...lease.payload, reason
            }), updatedAt: new Date()
        }).where(and(eq(savIntakeExecutions.id, lease.row.id), eq(savIntakeExecutions.leaseToken, lease.token))).returning();
        if (rows.length) {
            await tx.update(savMessages).set({
                analysisStatus: state === "uncertain" ? "intake_execution_uncertain" : "intake_execution_waiting"
            }).where(eq(savMessages.id, lease.row.messageId));
            const effects = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, lease.row.id));
            if (effects.every(e => e.state === "planned" || e.state === "confirmed")) {
                await releaseKeys(tx, lease.row.id);
                await executionJournal(tx, lease.row.id, "safe_occupation_release", {
                    reason, confirmedEffects: effects.filter(e => e.state === "confirmed").map(e => e.id)
                });
            }
        }
        await executionJournal(tx, lease.row.id, rows.length ? "pass_waiting" : "obsolete_pass", {
            state, reason
        });
    });
}
export async function identityEpisodeEffect(lease: ExecutionLease, intent: EffectIntent) {
    return requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        await assertExecutionLocal(tx, lease);
        const [episode] = await tx.select().from(savIntakeIdentityEpisodes).where(eq(savIntakeIdentityEpisodes.threadId, lease.row.threadId)).for("update");
        const retry = lease.payload.plan.decision.disposition.kind === "request_identification" && lease.payload.plan.decision.disposition.reason === "declared_registration_address_absent";
        if (episode) {
            const id = retry ? episode.retryEffectId : episode.initialEffectId;
            if (id) {
                const [prior] = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, id)).for("update");
                const [owner] = prior ? await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, prior.executionId)) : [];
                const binding = decryptSavPayload<{
                    email: string;
                    mailbox?: string;
                    gmailThread?: string;
                }>(episode.recipientCiphertext);
                // Only a fenced, provably never-dispatched intent can transfer.
                // The same episode/effect/RFC key survives; no send quota reset.
                const [revision] = prior && await intakeConsoleInstalled(tx) ? await tx.select().from(savIntakeEffectRevisions).where(eq(savIntakeEffectRevisions.effectId, prior.id)) : [];
                if (prior?.executionId === lease.row.id && revision && !revision.active && revision.revisionRunId === lease.payload.lastRunId
                    && prior.state === "planned" && !prior.dispatchedAt && !prior.dispatchToken && !prior.ackCiphertext && !prior.confirmedAt
                    && binding.email === intent.recipient && binding.mailbox === intent.mailbox && binding.gmailThread === intent.threadId) {
                    await executionJournal(tx, lease.row.id, "human_identity_intent_replaced", { eventId: revision.eventId, previous: decryptSavPayload(prior.intentCiphertext), next: intent }, prior.id);
                    const [updated] = await tx.update(savIntakeEffects).set({ intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent) }).where(eq(savIntakeEffects.id, prior.id)).returning();
                    await tx.update(savIntakeEffectRevisions).set({ active: true }).where(eq(savIntakeEffectRevisions.effectId, prior.id));
                    return updated;
                }
                if (prior?.state === "planned" && prior.dispatchedAt === null && prior.dispatchToken === null && prior.ackCiphertext === null && owner?.state === "refused" && binding.email === intent.recipient && binding.mailbox === intent.mailbox && binding.gmailThread === intent.threadId) {
                    const [moved] = await tx.update(savIntakeEffects).set({
                        executionId: lease.row.id, intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent)
                    }).where(eq(savIntakeEffects.id, prior.id)).returning();
                    await executionJournal(tx, owner.id, "never_dispatched_identity_transferred", {
                        effectId: prior.id, nextExecutionId: lease.row.id, oldIntentHash: prior.intentHash, newIntentHash: moved.intentHash
                    }, prior.id);
                    await executionJournal(tx, lease.row.id, "identity_episode_adopted", {
                        effectId: prior.id, priorExecutionId: owner.id
                    }, prior.id);
                    return moved;
                }
                return fault("IDENTIFICATION_ALREADY_REQUESTED");
            }
            if (!retry || !episode.initialEffectId)
                return fault("IDENTIFICATION_EPISODE_INVALID");
            const [initial] = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, episode.initialEffectId));
            if (initial?.state !== "confirmed")
                return fault("IDENTIFICATION_RECONCILIATION_REQUIRED");
        }
        const recipient = episode ? decryptSavPayload<{
            email: string;
        }>(episode.recipientCiphertext).email : intent.recipient;
        if (recipient !== intent.recipient)
            return fault("IDENTIFICATION_RECIPIENT_CHANGED");
        const id = randomUUID(), businessKey = `identity:${lease.row.threadId}:${retry ? "not_found" : "initial"}`;
        intent = {
            ...intent, key: businessKey
        };
        const [effect] = await tx.insert(savIntakeEffects).values({
            id, executionId: lease.row.id, businessKey, kind: intent.kind, permission: intent.permission, intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent)
        }).returning();
        if (episode)
            await tx.update(savIntakeIdentityEpisodes).set(retry ? {
                retryEffectId: id
            } : {
                initialEffectId: id
            }).where(eq(savIntakeIdentityEpisodes.id, episode.id));
        else
            await tx.insert(savIntakeIdentityEpisodes).values({
                threadId: lease.row.threadId, initialMessageId: lease.row.messageId, recipientCiphertext: encryptSavPayload({
                    email: recipient, mailbox: intent.mailbox, gmailThread: intent.threadId
                }), ...(retry ? {
                    retryEffectId: id
                } : {
                    initialEffectId: id
                })
            });
        return effect;
    });
}
export async function finishExecution(lease: ExecutionLease, ticketId: string | null) {
    await requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        await assertExecutionLocal(tx, lease);
        const effects = await activeExecutionEffects(lease.row.id, tx);
        if (!effects.length || effects.some(e => e.state !== "confirmed"))
            return fault("EFFECTS_INCOMPLETE");
        if (ticketId)
            await tx.update(savThreads).set({
                hubspotTicketId: ticketId, updatedAt: new Date()
            }).where(eq(savThreads.id, lease.row.threadId));
        await tx.update(savIntakeExecutions).set({
            state: "confirmed", ticketId, leaseToken: null, leaseUntil: null, payloadCiphertext: encryptSavPayload({
                ...lease.payload, effectsConfirmed: true
            }), updatedAt: new Date()
        }).where(eq(savIntakeExecutions.id, lease.row.id));
        const email = effects.find(e => e.kind === "email_create" && e.state === "confirmed");
        const emailId = email?.ackCiphertext ? decryptSavPayload<EffectAck>(email.ackCiphertext).id : undefined;
        await tx.update(savMessages).set({
            analysisStatus: ticketId ? "intake_execution_confirmed" : "intake_execution_identity_wait", ...(emailId ? {
                hubspotEmailId: emailId
            } : {})
        }).where(eq(savMessages.id, lease.row.messageId));
        const [completedMessage] = await tx.select().from(savMessages).where(eq(savMessages.id, lease.row.messageId));
        const completion = { sourceHash: intakeRecordedSourceHash(await savIntakeSourceSnapshot(tx, completedMessage, new Date()), lease.payload.local.sourceHash),
            messageHash: executionMessageHash(completedMessage) };
        await tx.update(savIntakeExecutions).set({ payloadCiphertext: encryptSavPayload({ ...lease.payload, effectsConfirmed: true, completion }) })
            .where(eq(savIntakeExecutions.id, lease.row.id));
        await releaseKeys(tx, lease.row.id);
        await executionJournal(tx, lease.row.id, "execution_confirmed", {
            ticketId, actorType: "ai", learning: "not_started"
        });
    });
}
/** A new decision version can inherit durable receipts only after explicit
 * compatibility checks. Business effect keys stay independent of the run ID. */
export async function adoptCurrentExecutionVersion(lease: ExecutionLease, options: ExecutionOptions) {
    const current = await readSavIntakeCurrent(lease.row.threadId, options.runtime);
    if (!current || current.id === lease.payload.lastRunId)
        return;
    if (!current.sourceMatches || current.messageId !== lease.row.messageId || current.state !== "observed" || !await intakeRunConfigurationBound(current, options.runtime) || !current.payload.plan)
        return fault("VERSION_INCOMPATIBLE");
    const next = current.payload.plan, old = lease.payload.plan, effects = await getExecutionEffects(lease.row.id);
    if (effects.some(e => !["planned", "confirmed"].includes(e.state)) || current.humanChoiceCiphertext !== lease.payload.local.humanChoice)
        return fault("VERSION_INCOMPATIBLE");
    const facts = (input: unknown) => {
        const i = input as {
            message: unknown;
            conversation: {
                data: unknown;
            };
        };
        return intakeRuntimeHash({
            message: i.message, conversation: i.conversation.data
        });
    };
    if (facts(current.payload.input) !== facts(lease.payload.input))
        return fault("VERSION_INCOMPATIBLE");
    const dispatched = effects.filter(e => e.state === "confirmed");
    if (dispatched.length) {
        const a = old.decision.disposition, b = next.decision.disposition;
        const create = dispatched.find(e => e.kind === "ticket_create"), createdId = create?.ackCiphertext ? decryptSavPayload<EffectAck>(create.ackCiphertext).id : null;
        const target = a.kind === "ticket" ? (a.target.operation === "create" ? createdId : a.target.ticketId) : null;
        if (a.kind !== "ticket" || b.kind !== "ticket" || old.decision.classification !== next.decision.classification || b.target.operation === "create" || b.target.ticketId !== target || intakeRuntimeHash(a.contactScope) !== intakeRuntimeHash(b.contactScope) || old.noteText !== next.noteText)
            return fault("VERSION_INCOMPATIBLE");
        // Keep the admitted operation and exact intents; the new interpretation is
        // a compatibility witness, never an instruction to create the ticket again.
    }
    else {
        lease.payload.plan = next;
        lease.payload.input = current.payload.input;
        delete lease.payload.baseline;
    }
    await requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        const [row] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, lease.row.id)).for("update");
        const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, lease.row.threadId)).for("update");
        const [m] = await tx.select().from(savMessages).where(eq(savMessages.id, lease.row.messageId));
        const [run] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, current.id));
        if (row?.leaseToken !== lease.token || thread?.aiPaused || !m || executionMessageHash(m) !== lease.payload.local.messageHash || !run?.isCurrent || !intakeSourceMatches(await savIntakeSourceSnapshot(tx, m, new Date()), run.sourceHash) || run.humanChoiceCiphertext !== lease.payload.local.humanChoice)
            return fault("VERSION_INCOMPATIBLE");
        const prior = lease.payload.lastRunId;
        lease.payload.lastRunId = run.id;
        lease.payload.acceptedFingerprint = next.fingerprint;
        lease.payload.local.sourceHash = run.sourceHash;
        await tx.update(savIntakeExecutions).set({
            runId: run.id, runVersion: run.version, payloadCiphertext: encryptSavPayload(lease.payload)
        }).where(eq(savIntakeExecutions.id, row.id));
        await executionJournal(tx, row.id, "compatible_version_adopted", {
            priorRunId: prior, runId: run.id, fingerprint: next.fingerprint, receipts: dispatched.map(e => e.id)
        });
    });
}
/** A read-only recovery may finish after takeover. Once every departed effect
 * is known, fence the abandoned continuation and hand back only that scope. */
export async function releaseRecoveredExecutionScope(executionId: string) {
    await requireDb().transaction(async (tx) => {
        await admissionLock(tx);
        const [row] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, executionId)).for("update");
        if (!row || row.state === "confirmed" || row.state === "refused")
            return;
        const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, row.threadId)).for("update");
        const [latest] = await tx.select({
            id: savMessages.id
        }).from(savMessages).where(and(eq(savMessages.threadId, row.threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
        if (thread && !thread.aiPaused && latest?.id === row.messageId && !await intakeHumanRefused(row.messageId, tx))
            return;
        const effects = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, row.id));
        if (effects.some(e => !["planned", "confirmed"].includes(e.state)))
            return;
        const payload = decryptSavPayload<ExecutionPayload>(row.payloadCiphertext);
        await tx.update(savIntakeExecutions).set({
            state: "waiting", leaseToken: null, leaseUntil: null, payloadCiphertext: encryptSavPayload({
                ...payload, reason: "SAV_INTAKE_EXECUTION_RECOVERED_AFTER_TAKEOVER"
            }), updatedAt: new Date()
        }).where(eq(savIntakeExecutions.id, row.id));
        await releaseKeys(tx, row.id);
        await executionJournal(tx, row.id, "recovered_scope_released", {
            latestMessageId: latest?.id ?? null, paused: thread?.aiPaused ?? null, confirmedEffects: effects.filter(e => e.state === "confirmed").map(e => e.id)
        });
    });
}
