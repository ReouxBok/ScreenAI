import "server-only";
import { intakeRunConfigurationBound } from "./human-binding";
import { createHash } from "node:crypto";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeExecutions, savIntakeEffects, savIntakeRuns, savMessages, savThreads, savMailboxes, savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { savSupportTicketProperties } from "../hubspot-mapping";
import { assertSavOutboundRecipientAllowed } from "../policy";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "./execution-policy";
import { savIntakeRuntimeConfig, intakeRuntimeHash, type IntakeRuntimeConfig } from "./runtime-contract";
import { createIntakeExecutorAdapters, renderIntakeNote } from "./execution-adapters";
import { assertOriginalExecutionCrm, assertExecutionCrmUnchanged } from "./execution-context";
import { admitIntakeExecution, claimExecution, adoptCurrentExecutionVersion, assertExecutionLocal, saveExecutionPayload, expandExecutionScope, getExecutionEffects, ensureExecutionEffect, markEffectDispatched, recordEffectAck, confirmExecutionEffect, deferExecutionEffect, endExecutionPass, identityEpisodeEffect, finishExecution, executionJournal, releaseRecoveredExecutionScope, occupationSchemaInstalled, type ExecutionLease } from "./execution-store";
import type { Effect, EffectIntent, EffectAck, ExecutorAdapters, ExecutionOptions, ExecutionPayload, EffectKind } from "./execution-types";
const fault = (code: string): never => { throw Error(`SAV_INTAKE_EXECUTION_${code}`); };
const code = (e: unknown) => e instanceof Error && /^SAV_[A-Z_]+$/.test(e.message) ? e.message : "SAV_INTAKE_EXECUTION_INTERRUPTED";
const ack = (e: Effect) => e.ackCiphertext ? decryptSavPayload<EffectAck>(e.ackCiphertext) : null;
const effectIntent = (e: Effect) => decryptSavPayload<EffectIntent>(e.intentCiphertext);
export function requiredExecutionKinds(payload: ExecutionPayload): EffectKind[] {
    const d = payload.plan.decision.disposition;
    if (d.kind === "request_identification")
        return ["identity_send"];
    if (d.kind !== "ticket")
        return [];
    return [...(d.target.operation === "create" ? ["ticket_create" as const] : []), ...(payload.plan.noteText ? ["note_create" as const, "note_associate" as const] : []), "email_create", "email_associate", ...(d.target.operation === "reopen" || d.target.operation === "link" && !d.target.alreadyNew ? ["stage_new" as const] : [])];
}
function finalTicket(lease: ExecutionLease, effects: Effect[]) {
    const d = lease.payload.plan.decision.disposition;
    if (d.kind !== "ticket")
        return null;
    if (d.target.operation !== "create")
        return d.target.ticketId;
    const create = effects.find(e => e.kind === "ticket_create" && e.state === "confirmed");
    return create ? ack(create)?.id ?? null : null;
}
async function source(lease: ExecutionLease) {
    const db = requireDb();
    const [m] = await db.select().from(savMessages).where(eq(savMessages.id, lease.row.messageId));
    const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, lease.row.threadId));
    const [mailbox] = thread ? await db.select().from(savMailboxes).where(eq(savMailboxes.id, thread.mailboxId)) : [];
    if (!m || !thread || !mailbox || !m.gmailMessageId)
        return fault("GMAIL_SOURCE_MISSING");
    return {
        message: m, thread, mailbox, body: decryptSavPayload<{
            text: string;
            headers?: Record<string, string>;
        }>(m.bodyCiphertext)
    };
}
function privateTemplate(runtime: IntakeRuntimeConfig, reference: {
    resourceId: string;
    revisionId: string;
    sha256: string;
}, env: Record<string, string | undefined>) {
    const list = JSON.parse(env.SAV_INTAKE_RUNTIME_RESOURCES ?? "[]") as {
        resource: typeof reference;
        text: string;
        status: string;
    }[];
    if (intakeRuntimeHash(list) !== runtime.resourcesHash)
        return fault("PRIVATE_RESOURCE_CHANGED");
    const found = list.filter(r => r.resource.resourceId === reference.resourceId && r.resource.revisionId === reference.revisionId && r.resource.sha256 === reference.sha256 && r.status === "approved");
    if (found.length !== 1 || createHash("sha256").update(found[0].text).digest("hex") !== reference.sha256)
        return fault("PRIVATE_RESOURCE_MISSING");
    return found[0].text;
}
function safeHeader(s: string) {
    if (/[\r\n]/.test(s))
        return fault("GMAIL_HEADERS_INVALID");
    return s;
}
async function nextIntent(lease: ExecutionLease, effects: Effect[], options: ExecutionOptions): Promise<EffectIntent | null> {
    const plan = lease.payload.plan, d = plan.decision.disposition, messageId = lease.row.messageId;
    const confirmed = (kind: string) => effects.find(e => e.kind === kind && e.state === "confirmed");
    const existing = effects.find(e => e.state !== "confirmed");
    if (existing)
        return effectIntent(existing);
    if (d.kind === "request_identification") {
        if ((lease.payload.input as {humanResolution?:{suppressOutbound?:boolean}} | undefined)?.humanResolution?.suppressOutbound)
            return fault("OUTBOUND_SUPERVISED");
        if (confirmed("identity_send"))
            return null;
        const s = await source(lease), recipient = plan.originalRecipientEmails[0];
        assertSavOutboundRecipientAllowed(recipient);
        if (plan.originalRecipientEmails.length !== 1 || recipient !== s.message.fromEmail)
            return fault("IDENTIFICATION_RECIPIENT_CHANGED");
        const reference = {
            resourceId: d.template.resourceId, revisionId: d.template.revisionId, sha256: d.template.sha256
        }, text = privateTemplate(options.runtime, reference, options.env());
        const key = `identity:${lease.row.threadId}:${d.reason === "declared_registration_address_absent" ? "not_found" : "initial"}`, rfcMessageId = `<sav-intake-${intakeRuntimeHash(key)}@studio.limova.ai>`;
        const prior = s.body.headers?.["message-id"];
        if (!prior || !s.thread.gmailThreadId)
            return fault("GMAIL_HEADERS_MISSING");
        const raw = [`From: ${safeHeader(s.mailbox.email)}`, `To: ${safeHeader(recipient)}`, `Subject: =?UTF-8?B?${Buffer.from(/^re\s*:/i.test(s.message.subject) ? s.message.subject : `Re: ${s.message.subject}`).toString("base64")}?=`, `Message-ID: ${rfcMessageId}`, `In-Reply-To: ${safeHeader(prior)}`, `References: ${safeHeader([s.body.headers?.references, prior].filter(Boolean).join(" "))}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", Buffer.from(text).toString("base64")].join("\r\n");
        return {
            kind: "identity_send", permission: "send_identity_template", key, sourceMessageId: messageId, mailbox: s.mailbox.email, threadId: s.thread.gmailThreadId, recipient, text, resource: reference, rfcMessageId, raw
        };
    }
    if (d.kind !== "ticket")
        return null;
    if (d.target.operation === "create" && !confirmed("ticket_create")) {
        if (!plan.newTicket)
            return fault("CREATION_INTENT_MISSING");
        const key = `create:${messageId}`, marker = intakeRuntimeHash(key);
        return {
            kind: "ticket_create", permission: "create_ticket", key, sourceMessageId: messageId, contactId: d.target.contactId, marker, properties: savSupportTicketProperties({
                title: plan.newTicket.title, description: `${plan.newTicket.description}\n\n[Studio intake: ${marker}]`, reviewedTitle: true, categories: plan.decision.classification === "finance" ? ["billing"] : plan.decision.classification === "cancellation" ? ["cancellation"] : undefined
            })
        };
    }
    const ticketId = finalTicket(lease, effects);
    if (!ticketId)
        return fault("FINAL_TICKET_MISSING");
    if (plan.noteText && !confirmed("note_create")) {
        const key = `note:${messageId}:${ticketId}`, marker = intakeRuntimeHash(key);
        return {
            kind: "note_create", permission: "append_ticket_note", key, ticketId, sourceMessageId: messageId, text: plan.noteText, marker, properties: {
                hs_note_body: renderIntakeNote(plan.noteText, marker), hs_timestamp: plan.decision.receivedAt
            }
        };
    }
    if (plan.noteText && !confirmed("note_associate")) {
        const creation = confirmed("note_create")!, id = ack(creation)?.id;
        if (!id)
            return fault("NOTE_ACK_MISSING");
        return {
            kind: "note_associate", permission: "append_ticket_note", key: `note-association:${messageId}:${ticketId}`, ticketId, objectId: id, sourceMessageId: messageId, expectedProperties: effectIntent(creation).properties, confirmedNoteCreate: { effectId: creation.id, objectId: id }
        };
    }
    if (!confirmed("email_create")) {
        const s = await source(lease), key = `email:${messageId}`, marker = intakeRuntimeHash(key);
        return {
            kind: "email_create", permission: "associate_email", key, sourceMessageId: messageId, marker, ticketId, ...(s.message.hubspotEmailId ? {
                objectId: s.message.hubspotEmailId
            } : {}), properties: {
                hs_timestamp: s.message.receivedAt.toISOString(), hs_email_direction: "INCOMING_EMAIL", hs_email_subject: s.message.subject, hs_email_text: s.message.hubspotEmailId ? s.body.text : `${s.body.text}\n\n[Studio intake email: ${marker}]`, hs_email_headers: JSON.stringify({
                    from: {
                        email: s.message.fromEmail
                    }, to: s.message.toEmails.map(email => ({
                        email
                    })), cc: [], bcc: []
                })
            }
        };
    }
    if (!confirmed("email_associate")) {
        const id = ack(confirmed("email_create")!)?.id;
        if (!id)
            return fault("EMAIL_ACK_MISSING");
        return {
            kind: "email_associate", permission: "associate_email", key: `email-association:${messageId}:${ticketId}`, ticketId, objectId: id, sourceMessageId: messageId, expectedProperties: effectIntent(confirmed("email_create")!).properties
        };
    }
    if ((d.target.operation === "reopen" || d.target.operation === "link" && !d.target.alreadyNew) && !confirmed("stage_new")) {
        const t = Object.values(lease.payload.baseline?.tickets ?? {}).flat().find(t => t.id === ticketId);
        if (!t || t.ownerId === undefined)
            return fault("OWNER_UNKNOWN");
        if (d.target.operation === "reopen" && t.ownerId !== d.target.preserveOwnerId)
            return fault("OWNER_CHANGED");
        return {
            kind: "stage_new", permission: "set_ticket_new", key: `stage-new:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: t.ownerId
        };
    }
    return null;
}
async function live(lease: ExecutionLease, options: ExecutionOptions, permission?: string) {
    const config = intakeExecutionConfig(options.env()), runtime = savIntakeRuntimeConfig(options.env());
    if (!config || !runtime || lease.row.policyId !== options.config.policyId || lease.row.policyHash !== options.config.policyHash || lease.payload.runtimeConfigHash !== options.runtime.configHash || options.signal.aborted || config.policyId !== options.config.policyId || config.policyHash !== options.config.policyHash || runtime.configHash !== options.runtime.configHash)
        return fault("DISABLED");
    const [boundRun] = await requireDb().select().from(savIntakeRuns).where(eq(savIntakeRuns.id, lease.payload.lastRunId));
    if (!boundRun || !await intakeRunConfigurationBound(boundRun, runtime)) return fault("VERSION_INCOMPATIBLE");
    const { policy } = await readIntakeExecutionAuthority(config);
    if (permission && !policy.mutations.includes(permission as typeof policy.mutations[number]))
        return fault("MUTATION_NOT_GRANTED");
    const operation = lease.payload.plan.decision.disposition;
    if (operation.kind === "ticket" && !policy.mutations.includes(operation.target.operation === "create" ? "create_ticket" : "link_ticket"))
        return fault("MUTATION_NOT_GRANTED");
    await requireDb().transaction(tx => assertExecutionLocal(tx, lease));
    return policy;
}
async function preflight(lease: ExecutionLease, options: ExecutionOptions, intent?: EffectIntent) {
    const d = lease.payload.plan.decision.disposition;
    const authority = await live(lease, options, intent?.permission);
    if (d.kind === "ticket" && !authority.mutations.includes(d.target.operation === "create" ? "create_ticket" : "link_ticket"))
        return fault("MUTATION_NOT_GRANTED");
    const snapshot = await options.adapters.readCrm(lease.payload.plan, lease.payload.input, options.runtime, options.signal);
    await expandExecutionScope(lease, options.adapters.scope(snapshot, lease.row.threadId, finalTicket(lease, await getExecutionEffects(lease.row.id))));
    if (!lease.payload.baseline) {
        assertOriginalExecutionCrm(lease.payload.plan, snapshot);
        lease.payload.baseline = snapshot;
        await saveExecutionPayload(lease);
    }
    else
        assertExecutionCrmUnchanged(lease.payload.baseline, snapshot, await getExecutionEffects(lease.row.id));
    const s = await source(lease);
    if (typeof options.adapters.gmailCurrent !== "function")
        return fault("GMAIL_CONTROL_REQUIRED");
    await options.adapters.gmailCurrent(s.mailbox.email, s.thread.gmailThreadId, s.message.gmailMessageId!, options.signal);
    if (intent?.kind === "identity_send") {
        if (typeof options.adapters.gmailPermissions !== "function")
            return fault("GMAIL_PERMISSION_REQUIRED");
        await options.adapters.gmailPermissions(s.mailbox.email, options.signal);
        privateTemplate(options.runtime, intent.resource!, options.env());
    }
    const finalAuthority = await live(lease, options, intent?.permission);
    if (d.kind === "ticket" && !finalAuthority.mutations.includes(d.target.operation === "create" ? "create_ticket" : "link_ticket"))
        return fault("MUTATION_NOT_GRANTED");
}
export async function executeIntakePass(executionId: string, options: ExecutionOptions, hooks: {
    beforeMarker?: (effect: Effect) => Promise<void>;
    afterMarker?: (effect: Effect) => Promise<void>;
    afterAck?: (effect: Effect) => Promise<void>;
} = {}) {
    const lease = await claimExecution(executionId);
    if (!lease)
        return {
            skipped: "occupied"
        };
    let current: Effect | undefined;
    try {
        await adoptCurrentExecutionVersion(lease, options);
        for (let n = 0; n < 8; n++) {
            const effects = await getExecutionEffects(executionId), intent = await nextIntent(lease, effects, options);
            if (!intent) {
                await preflight(lease, options);
                await finishExecution(lease, finalTicket(lease, effects));
                return {
                    state: "confirmed", executionId
                };
            }
            current = effects.find(e => e.businessKey === intent.key);
            if (!current) {
                await preflight(lease, options, intent);
                current = intent.kind === "identity_send" ? await identityEpisodeEffect(lease, intent) : await ensureExecutionEffect(lease, intent);
            }
            if (current.state === "planned") {
                await hooks.beforeMarker?.(current);
                await preflight(lease, options, intent);
                current = await markEffectDispatched(lease, current);
                await hooks.afterMarker?.(current);
                await live(lease, options, intent.permission);
                const result = await options.adapters.dispatch(effectIntent(current), options.signal);
                await recordEffectAck(current, result);
                await hooks.afterAck?.(current);
                current = (await getExecutionEffects(executionId)).find(e => e.id === current!.id)!;
            }
            // No dispatch from acked/dispatched/uncertain. Verification remains read only
            // even if authority/pause/version changed while a provider response arrived.
            if (current.reconcileAttempts >= 5 || current.nextReconcileAt && current.nextReconcileAt > new Date()) {
                await endExecutionPass(lease, "uncertain", "SAV_INTAKE_EXECUTION_RECONCILIATION_WAITING");
                return {
                    state: "uncertain", executionId
                };
            }
            const proof = await options.adapters.verify(effectIntent(current), ack(current), current.dispatchedAt!, AbortSignal.timeout(15000));
            if (!proof.confirmed || !proof.attributed) {
                await deferExecutionEffect(current, "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED");
                await endExecutionPass(lease, "uncertain", "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED");
                return {
                    state: "uncertain", executionId
                };
            }
            await confirmExecutionEffect(current, proof, proof.ack);
            current = undefined;
            await live(lease, options);
        }
        await endExecutionPass(lease, "waiting", "SAV_INTAKE_EXECUTION_PASS_LIMIT");
        return {
            state: "waiting", executionId
        };
    }
    catch (error) {
        const reason = code(error);
        if (current && current.state !== "planned") {
            const [row] = (await getExecutionEffects(executionId)).filter(e => e.id === current!.id);
            if (row?.state !== "confirmed")
                await deferExecutionEffect(row ?? current, reason);
        }
        const uncertain = (await getExecutionEffects(executionId)).some(e => ["dispatched", "acked", "uncertain"].includes(e.state));
        await endExecutionPass(lease, uncertain ? "uncertain" : "waiting", reason);
        return {
            state: uncertain ? "uncertain" : "waiting", reason, executionId
        };
    }
}
/** Recovery has no dispatch capability and never consults a grant to accept ACKs. */
export async function reconcileIntakeEffectsReadOnly(executionId: string, adapters: Pick<ExecutorAdapters, "verify">, deadlineMs = Date.now() + 30000) {
    const effects = await getExecutionEffects(executionId);
    let checked = 0;
    for (const effect of effects) {
        if (!["dispatched", "acked", "uncertain"].includes(effect.state) || effect.reconcileAttempts >= 5 || effect.nextReconcileAt && effect.nextReconcileAt > new Date())
            continue;
        if (checked++ >= 2 || Date.now() >= deadlineMs)
            break;
        try {
            const proof = await adapters.verify(effectIntent(effect), ack(effect), effect.dispatchedAt!, AbortSignal.timeout(Math.max(1, Math.min(15000, deadlineMs - Date.now()))));
            if (proof.confirmed && proof.attributed)
                await confirmExecutionEffect(effect, proof, proof.ack);
            else
                await deferExecutionEffect(effect, "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED");
        }
        catch {
            await deferExecutionEffect(effect, "SAV_INTAKE_EXECUTION_RECONCILIATION_UNAVAILABLE");
        }
    }
    await releaseRecoveredExecutionScope(executionId);
    return {
        checked, effects: await getExecutionEffects(executionId)
    };
}
export async function pendingIntakeEffectRecoveries(now = new Date()) {
    return requireDb().selectDistinct({
        id: savIntakeExecutions.id, updatedAt: savIntakeExecutions.updatedAt
    }).from(savIntakeExecutions).innerJoin(savIntakeEffects, eq(savIntakeEffects.executionId, savIntakeExecutions.id)).where(and(inArray(savIntakeEffects.state, ["dispatched", "acked", "uncertain"]), sql `${savIntakeEffects.reconcileAttempts}<5`, or(sql `${savIntakeEffects.nextReconcileAt} is null`, lte(savIntakeEffects.nextReconcileAt, now)))).orderBy(savIntakeExecutions.updatedAt, savIntakeExecutions.id).limit(2);
}
export async function scanIntakeExecutionCandidates(options: ExecutionOptions) {
    const key = "sav-intake-execution-scan-v1", db = requireDb(), [cursor] = await db.select().from(savSyncState).where(eq(savSyncState.key, key));
    const base = and(eq(savIntakeRuns.isCurrent, true), eq(savIntakeRuns.state, "observed"), sql `(not exists(select 1 from sav.intake_executions e where e.message_id=${savIntakeRuns.messageId})
        or exists(select 1 from sav.intake_executions e join sav.intake_execution_policies p on p.id=e.policy_id
          where e.message_id=${savIntakeRuns.messageId} and e.run_id=${savIntakeRuns.id} and e.run_version=${savIntakeRuns.version}
          and ${savIntakeRuns.humanChoiceCiphertext} is not null and e.state in ('pending','waiting')
          and (e.lease_until is null or e.lease_until<=now()) and e.policy_id<>${options.config.policyId} and p.state='revoked'
          and not exists(select 1 from sav.intake_effects f where f.execution_id=e.id and
            (f.state<>'planned' or f.dispatched_at is not null or f.dispatch_token is not null or f.ack_ciphertext is not null or f.confirmed_at is not null))))`, sql `exists(select 1 from sav.threads t where t.id=${savIntakeRuns.threadId} and not t.ai_paused)`);
    const scanCursor = cursor?.cursor ? JSON.parse(cursor.cursor) as {
        at: string;
        id: string;
    } : null;
    let candidates = await db.select({
        id: savIntakeRuns.id, createdAt: savIntakeRuns.createdAt
    }).from(savIntakeRuns).where(and(base, scanCursor ? sql `(${savIntakeRuns.createdAt},${savIntakeRuns.id}) > (${scanCursor.at}::timestamptz,${scanCursor.id}::uuid)` : undefined)).orderBy(savIntakeRuns.createdAt, savIntakeRuns.id).limit(4);
    if (!candidates.length && cursor?.cursor)
        candidates = await db.select({
            id: savIntakeRuns.id, createdAt: savIntakeRuns.createdAt
        }).from(savIntakeRuns).where(base).orderBy(savIntakeRuns.createdAt, savIntakeRuns.id).limit(4);
    for (const run of candidates) {
        try {
            const [candidate] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, run.id));
            if (candidate && await intakeRunConfigurationBound(candidate, options.runtime)) await admitIntakeExecution(run.id, options);
        }
        catch (error) {
            if (!["SAV_INTAKE_EXECUTION_SCOPE_OCCUPIED", "SAV_INTAKE_EXECUTION_LEGACY_SCOPE_OCCUPIED", "SAV_INTAKE_EXECUTION_LEGACY_SCOPE_UNKNOWN"].includes(code(error)))
                throw error;
        }
        // Cursor progress does not change evidence dates, freshness, model attempts,
        // admission counters or the immutable observation payload.
        await db.insert(savSyncState).values({
            key, cursor: JSON.stringify({
                at: run.createdAt.toISOString(), id: run.id
            }), status: "scanning"
        }).onConflictDoUpdate({
            target: savSyncState.key, set: {
                cursor: JSON.stringify({
                    at: run.createdAt.toISOString(), id: run.id
                }), updatedAt: new Date()
            }
        });
    }
    return candidates.length;
}
export async function reconcileIntakeExecutor(overrides: {
    env?: () => Record<string, string | undefined>;
    adapters?: ExecutorAdapters;
    deadlineMs?: number;
} = {}) {
    const environment = overrides.env ?? (() => process.env), env = environment(), deadlineMs = Math.min(overrides.deadlineMs ?? Infinity, Date.now() + 55000);
    if (env.SAV_INTAKE_EXECUTION_MODE !== "execute" && env.SAV_INTAKE_EXECUTION_RECOVERY !== "read_only")
        return {
            skipped: "off"
        };
    if (!await occupationSchemaInstalled())
        return {
            skipped: "schema_absent"
        };
    const adapters = overrides.adapters ?? createIntakeExecutorAdapters({
        env: environment
    });
    const recoveries = await pendingIntakeEffectRecoveries();
    for (const row of recoveries.slice(0, 1))
        await reconcileIntakeEffectsReadOnly(row.id, adapters, deadlineMs);
    let config: ReturnType<typeof intakeExecutionConfig>;
    try {
        config = intakeExecutionConfig(env);
    }
    catch (error) {
        return {
            skipped: code(error), recovered: recoveries.length
        };
    }
    if (!config)
        return {
            skipped: "off", recovered: recoveries.length
        };
    const runtime = savIntakeRuntimeConfig(env);
    if (!runtime)
        return fault("OBSERVATION_REQUIRED");
    const { policy } = await readIntakeExecutionAuthority(config);
    const signal = AbortSignal.timeout(Math.max(1, deadlineMs - Date.now())), options: ExecutionOptions = {
        config, runtime, policy, adapters, signal, env: environment
    };
    await scanIntakeExecutionCandidates(options);
    const [execution] = await requireDb().select().from(savIntakeExecutions).where(and(eq(savIntakeExecutions.policyId, config.policyId), or(eq(savIntakeExecutions.state, "pending"), and(eq(savIntakeExecutions.state, "waiting"), lte(savIntakeExecutions.updatedAt, new Date(Date.now() - 60000))), and(eq(savIntakeExecutions.state, "running"), lte(savIntakeExecutions.leaseUntil, new Date())), and(eq(savIntakeExecutions.state, "uncertain"), sql `(exists(select 1 from sav.intake_effects f where f.execution_id=${savIntakeExecutions.id} and f.state in ('dispatched','acked','uncertain') and f.reconcile_attempts<5 and (f.next_reconcile_at is null or f.next_reconcile_at<=now())) or not exists(select 1 from sav.intake_effects f where f.execution_id=${savIntakeExecutions.id} and f.state in ('dispatched','acked','uncertain')))`)), sql `exists(select 1 from sav.threads t where t.id=${savIntakeExecutions.threadId} and not t.ai_paused)`, sql `not exists(select 1 from sav.messages m where m.thread_id=${savIntakeExecutions.threadId} and m.direction='inbound' and m.id<>${savIntakeExecutions.messageId} and (m.received_at,m.created_at,m.id)>(select s.received_at,s.created_at,s.id from sav.messages s where s.id=${savIntakeExecutions.messageId}))`)).orderBy(savIntakeExecutions.updatedAt, savIntakeExecutions.id).limit(1);
    return execution ? executeIntakePass(execution.id, options) : {
        skipped: "no_execution"
    };
}
export async function readIntakeExecutionProgress(messageId: string) {
    const [row] = await requireDb().select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId));
    if (!row)
        return null;
    const payload = decryptSavPayload<ExecutionPayload>(row.payloadCiphertext), effects = await getExecutionEffects(row.id), required = requiredExecutionKinds(payload);
    const confirmed = row.state === "confirmed" && required.length > 0 && required.every(k => effects.some(e => e.kind === k && e.state === "confirmed"));
    return {
        executionId: row.id, runId: row.runId, version: row.runVersion, actorType: "ai", completionSourceHash: payload.completion?.sourceHash ?? null, state: row.state, ticketId: row.ticketId, confirmed, reason: payload.reason ?? null, effects: effects.map(e => ({
            id: e.id, kind: e.kind, state: e.state, attemptId: e.attemptId, ack: ack(e), dispatchedAt: e.dispatchedAt, confirmedAt: e.confirmedAt
        })), learning: payload.plan.decision.classification === "finance" || payload.plan.decision.classification === "cancellation" ? "excluded" : "not_started", followupStarted: false
    };
}
/** Operator selection is an explicit, audited RO reconciliation, never a reset
 * or permission to POST. The exact same adapter verifies the chosen candidate. */
export async function reconcileIntakeEffectCandidate(effectId: string, candidateId: string, reason: string, adapters: Pick<ExecutorAdapters, "verify">) {
    const administrator = await (await import("./execution-policy")).executionAdministrator();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(candidateId) || reason.trim().length < 10 || reason.length > 2000)
        throw Error("SAV_INTAKE_EXECUTION_RECONCILIATION_INPUT_INVALID");
    const [effect] = await requireDb().select().from(savIntakeEffects).where(eq(savIntakeEffects.id, effectId));
    if (!effect || !["dispatched", "acked", "uncertain"].includes(effect.state) || !effect.dispatchedAt)
        throw Error("SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED");
    const original = ack(effect);
    if (original?.id && original.id !== candidateId)
        throw Error("SAV_INTAKE_EXECUTION_ACK_CONFLICT");
    const intent = effectIntent(effect);
    if (intent.objectId && intent.objectId !== candidateId || intent.kind === "stage_new" && intent.ticketId !== candidateId)
        throw Error("SAV_INTAKE_EXECUTION_ACK_CONFLICT");
    const proof = await adapters.verify(intent, {
        ...original, id: candidateId, ...(!original?.id ? { operatorCandidate: true } : {})
    }, effect.dispatchedAt, AbortSignal.timeout(15000));
    await requireDb().transaction(tx => executionJournal(tx, effect.executionId, "operator_candidate_checked", {
        administratorId: administrator.id, candidateId, reason: reason.trim(), confirmed: proof.confirmed, attributed: proof.attributed
    }, effect.id));
    if (!proof.confirmed || !proof.attributed)
        throw Error("SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED");
    await confirmExecutionEffect(effect, proof, proof.ack);
    return {
        confirmed: true, effectId: effect.id
    };
}
