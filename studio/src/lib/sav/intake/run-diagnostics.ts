import "server-only";
import { intakeAttemptExhaustion, intakeRunAnalysed, SAV_INTAKE_ATTEMPT_POLICY, SAV_INTAKE_BLOCKING_JOURNAL_KINDS } from "./attempt-policy";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeEffectJournal, savIntakeEffects, savIntakeExecutions, savIntakeJournal, savIntakeModelCalls, savIntakeObservationBindings, savIntakeRuns, savMessages, savResolutionObservations } from "@/db/schema";
import { publicIntakeBudgetLimit } from "./budget-limit";
import { intakeRuntimeHash } from "./runtime-contract";
import { intakeObservationBlocker } from "./observation-binding";
import { publicIntakeCrmDelta } from "./execution-context";
import { intakeExecutionNextStep, publicCrmRecheck, publicExecutionEffects } from "./execution-diagnostic";
import { decryptSavPayload } from "../crypto";
import { savAttachmentReasonSchema, savAttachmentStatusSchema } from "../attachment-contract";
import { intakeContextReasonLabels } from "./console-presentation";
import { publicIntakeSchemaIssues } from "./schema-diagnostics";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const publicCodes = new Set<string>([...Object.keys(intakeContextReasonLabels), ...savAttachmentReasonSchema.options, ...savAttachmentStatusSchema.options,
  "queued", "claimed", "waiting", "observed", "superseded", "interrupted", "obsolete_partial_result", "budget_deferred_before_attempt",
  "attempts_exhausted", "paused", "usage_uncertain", "unknown_anchor", "wrong_anchor_source", "ambiguous_quote_format", "unknown_source",
  "excerpt_not_in_source", "required_source_missing", "message_id_mismatch", "registration_source_invalid", "output_schema_invalid", "visual_structure_invalid",
  "request_limit", "operation_forbidden", "partial_response", "total_mismatch", "pagination_cycle", "page_limit", "archived_contact",
  "aliases_unavailable", "batch_limit", "partial_batch", "conflicting_contact", "contact_limit", "cancelled", "read_unavailable",
  "ticket_limit", "ticket_membership_conflict", "ticket_content_unavailable", "history_limit", "history_date_unknown", "read_retry_scheduled", "read_retry_stopped", "read_retry_claimed"]);
const outputStages = new Set(["sanitize_wire", "visual_normalize", "decode", "final_schema", "evidence"]);
const normalizationCounts = ["nullOptionalKeys", "partialImages", "truncatedImageTexts", "truncatedUncertainties", "droppedUncertainties", "droppedRegions", "truncatedRegionTexts", "invalidBoxes", "omittedChars", "discardedRegistrations"];
/** Allow-listed integer counters only; values and texts are never projected. */
function outputNormalization(raw: unknown) {
  const n = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!n) return null;
  return Object.fromEntries(normalizationCounts.map(k => [k, typeof n[k] === "number" && Number.isSafeInteger(n[k]) && (n[k] as number) >= 0 ? n[k] : null]));
}
const code = (v: unknown) => typeof v === "string" && (/^(?:SAV_[A-Z0-9_]{1,90}|HUBSPOT_HTTP_\d{3})$/.test(v) || publicCodes.has(v)) ? v : null;
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const methods = new Set(["analyseMessage", "assessIdentity", "assessIssues"]);
const operations = new Set(["email_lookup", "contact", "direct_associations", "contact_tickets", "ticket_history"]);

const contextSections = ["message", "conversation", "provenance", "requests", "requestContext", "tickets", "candidates", "address", "evidence", "catalogue", "contextView", "contextBlocks", "imageInputs"];
const contextSources = ["current", "initial-request", "ticket", "history", "identity-ticket", "identity-history", "contact", "message", "image", "other"];
const historyCounts = ["tickets", "events", "notes", "emails", "htmlEmails", "duplicateEvents", "duplicateBytes", "nestedEvents", "nestedBytes", "nestedComparisons", "nestedComparisonsSkipped", "nestedScanComplete", "quotedBytes", "maxTicketHistoryBytes"];
/** Allow-listed keys with numeric values only; anything else is dropped. */
function contextBreakdown(raw: unknown) {
  const b = object(raw), sections = object(b.sections), catalogue = object(b.catalogue), bySource = object(catalogue.bySource), history = object(b.history);
  if (!Object.keys(b).length) return null;
  const pick = (from: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => Object.hasOwn(from, k)).map(k => [k, count(from[k])]));
  return { sections: pick(sections, contextSections), catalogue: { entries: count(catalogue.entries), bySource: pick(bySource, contextSources) },
    history: Object.keys(history).length ? pick(history, historyCounts) : null };
}

/** Project only diagnostic facts. Never return input bodies, quotes, model
 * results, arbitrary exception messages, recipients or provider credentials. */
export function intakeDiagnosticPayload(ciphertext: string) {
  try {
    if (Buffer.byteLength(ciphertext, "utf8") > 262_144) throw Error("DIAGNOSTIC_LIMIT");
    const payload = object(decryptSavPayload<unknown>(ciphertext));
    const plan = object(payload.plan), decision = object(plan.decision), disposition = object(decision.disposition);
    const input = object(payload.input), message = object(input.message), attachments = object(payload.attachments);
    const read = object(attachments.read), configuration = object(payload.configuration);
    const traces = (Array.isArray(payload.traces) ? payload.traces : []).slice(-40).map(raw => {
      const t = object(raw), limit = object(t.contextLimit), validation = object(t.validationFailure),transport=object(t.transport);
      return { method: methods.has(String(t.method)) ? String(t.method) : null,
        phase: ["understanding", "ticket_matching", "accepted_semantics"].includes(String(t.phase)) ? String(t.phase) : null,
        operation: operations.has(String(t.operation)) ? String(t.operation) : null,
        status: ["complete", "partial", "failed"].includes(String(t.status)) ? String(t.status) : null,
        accepted: typeof t.accepted === "boolean" ? t.accepted : null,
        errorCode: code(t.errorCode), reason: code(t.reason), validationReason: code(validation.reason),
        schemaIssues: publicIntakeSchemaIssues(validation.issues),
        validationStage: outputStages.has(String(validation.stage)) ? String(validation.stage) : null,
        normalization: outputNormalization(t.normalization), budgetLimit: publicIntakeBudgetLimit(t.budgetLimit),
        callPlan: t.callPlan && typeof t.callPlan === "object" ? { groups: count(object(t.callPlan).groups), available: count(object(t.callPlan).available), tickets: count(object(t.callPlan).tickets) } : null,
        transport:["local_guard","transport","http","response","deadline"].includes(String(transport.origin))?{origin:String(transport.origin),code:code(transport.code),attempts:count(transport.attempts),status:count(transport.status),durationMs:count(transport.durationMs)}:null,
        contextLimit: ["catalogue", "data", "wire"].includes(String(limit.stage)) ? { stage: String(limit.stage), bytes: count(limit.bytes), limitBytes: count(limit.limitBytes), breakdown: contextBreakdown(limit.breakdown) } : null };
    });
    const recovery=object(payload.readRecovery),records=object(payload.semantics).records;
    const analysis=object(Array.isArray(records)?object(records.find(r=>object(r).method==="analyseMessage")).result:null);
    const contextReasons = disposition.kind === "collect_context" && Array.isArray(disposition.reasons)
      ? disposition.reasons.filter((r): r is string => typeof r === "string" && Object.hasOwn(intakeContextReasonLabels, r)).slice(0, 15) : [];
    // A wait without technical code still has a cause: the engine's missing proofs, a human choice,
    // or an explicitly unknown one. Never an invented code (SAV-45 C).
    const waitingCause = code(payload.reason) ? null : contextReasons.length ? "context_required" : object(plan.progress).kind === "human_choice" ? "human_choice" : plan.decision ? "plan_without_code" : "unknown";
    return { readable: true, reason: code(payload.reason), waitingCause, budgetLimit: publicIntakeBudgetLimit(payload.budgetLimit),
      qualification:{nature:["request","newsletter","information","indeterminate"].includes(String(analysis.nature))?String(analysis.nature):null,requestCount:Array.isArray(analysis.requests)?count(analysis.requests.length):null},
      readRecovery:Object.keys(recovery).length?{state:["scheduled","claimed","exhausted","invalidated","complete"].includes(String(recovery.state))?String(recovery.state):null,technicalAttempts:count(recovery.attempts),operation:operations.has(String(recovery.operation))?String(recovery.operation):null,code:code(recovery.code),expired:typeof recovery.expiresAt==="string"&&Number.isFinite(Date.parse(recovery.expiresAt))?Date.parse(recovery.expiresAt)<=Date.now():null}:null,
      codeRevision: typeof configuration.codeRevision === "string" && /^[a-f0-9]{40}$/.test(configuration.codeRevision) ? configuration.codeRevision : null,
      contextReasons,
      input: { contentComplete: typeof message.contentComplete === "boolean" ? message.contentComplete : null,
        currentTextLength: typeof message.currentText === "string" ? message.currentText.length : null },
      attachments: { textComplete: typeof attachments.textComplete === "boolean" ? attachments.textComplete : null,
        inventoryComplete: typeof object(attachments.inventory).complete === "boolean" ? object(attachments.inventory).complete : null,
        observations: (Array.isArray(read.observations) ? read.observations : []).slice(0, 100).map(raw => {
          const o = object(raw); return { status: code(o.status), reason: code(o.reason) };
        }) }, traces, tracesTruncated: Array.isArray(payload.traces) && payload.traces.length > 40 };
  } catch {
    return { readable: false, reason: null, waitingCause: "unknown" as const, budgetLimit: null, codeRevision: null, contextReasons: [], input: null, attachments: null, traces: [], tracesTruncated: false };
  }
}

/** Execution of the message (SAV-45): state, precise reason, CRM delta, effects and
 * counted waiting passes. Read only, bounded, no payload value beyond allow-lists. */
type ReadTx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
const EXECUTION_PAYLOAD_BYTES = 1024 * 1024;
async function readExecutionDiagnostic(tx: ReadTx, messageId: string) {
  const [row] = await tx.select({ id: savIntakeExecutions.id, state: savIntakeExecutions.state, runVersion: savIntakeExecutions.runVersion, updatedAt: savIntakeExecutions.updatedAt,
    payloadCiphertext: sql<string>`case when octet_length(${savIntakeExecutions.payloadCiphertext}) <= ${EXECUTION_PAYLOAD_BYTES} then ${savIntakeExecutions.payloadCiphertext} else '' end` })
    .from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId)).limit(1);
  if (!row) return null;
  let payload: Record<string, unknown> = {}, readable = true;
  try { payload = object(decryptSavPayload<unknown>(row.payloadCiphertext)); } catch { readable = false; }
  const effects = await tx.select({ kind: savIntakeEffects.kind, state: savIntakeEffects.state, reconcileAttempts: savIntakeEffects.reconcileAttempts,
    nextReconcileAt: savIntakeEffects.nextReconcileAt, confirmedAt: savIntakeEffects.confirmedAt }).from(savIntakeEffects).where(eq(savIntakeEffects.executionId, row.id))
    .orderBy(savIntakeEffects.createdAt, savIntakeEffects.id).limit(21);
  const [passes] = await tx.select({ count: sql<number>`count(*)::int`, last: sql<Date | null>`max(${savIntakeEffectJournal.createdAt})` }).from(savIntakeEffectJournal)
    .where(and(eq(savIntakeEffectJournal.executionId, row.id), eq(savIntakeEffectJournal.kind, "pass_waiting")));
  // Follow-up of a confirmed execution: bound, or the named condition that holds it (SAV-45 C).
  const [binding] = row.state === "confirmed" ? await tx.select({ observationId: savIntakeObservationBindings.observationId }).from(savIntakeObservationBindings).where(eq(savIntakeObservationBindings.executionId, row.id)).limit(1) : [];
  const [observation] = binding ? await tx.select({ state: savResolutionObservations.state, sourceErrors: savResolutionObservations.sourceErrors }).from(savResolutionObservations).where(eq(savResolutionObservations.id, binding.observationId)) : [];
  const followup = row.state !== "confirmed" ? null : binding ? { bound: true, blocker: null, observationState: observation?.state ?? null, sourceErrors: Array.isArray(observation?.sourceErrors) ? observation.sourceErrors.length : null }
    : { bound: false, blocker: readable ? (await intakeObservationBlocker(tx, row.id).catch(() => ({ blocker: "unknown" as const }))).blocker ?? "scan_pending" : "unknown", observationState: null, sourceErrors: null };
  const reason = readable ? code(payload.reason) : null, crmDelta = readable ? publicIntakeCrmDelta(payload.crmDelta) : null, crmRecheck = readable ? publicCrmRecheck(payload.crmRecheck) : null;
  return { readable, state: ["pending", "running", "waiting", "uncertain", "confirmed", "refused"].includes(row.state) ? row.state : null, runVersion: row.runVersion, updatedAt: row.updatedAt,
    reason, crmDelta, crmRecheck, followup, originalCrmRecorded: readable ? Boolean(object(payload.originalCrm).entries) : null, effects: publicExecutionEffects(effects), effectsTruncated: effects.length > 20,
    waitingPasses: count(Number(passes?.count ?? 0)), lastPassAt: passes?.last ?? null,
    nextStep: readable ? intakeExecutionNextStep({ state: row.state, reason, crmDelta, crmRecheck, effectStates: effects.map(e => e.state) }) : "unknown" as const };
}

/** Model calls of the message in the ledger, read only: what is known of each usage. An
 * uncertain call stays uncertain here; it is never settled, retried or zeroed (SAV-45 C). */
async function readModelCallDiagnostic(tx: ReadTx, messageId: string) {
  const rows = await tx.select({ state: savIntakeModelCalls.state, createdAt: savIntakeModelCalls.createdAt, settledAt: savIntakeModelCalls.settledAt,
    reservedNanoUsd: savIntakeModelCalls.reservedNanoUsd, chargedNanoUsd: savIntakeModelCalls.chargedNanoUsd,
    payloadCiphertext: sql<string>`case when octet_length(${savIntakeModelCalls.payloadCiphertext}) <= 65536 then ${savIntakeModelCalls.payloadCiphertext} else '' end` })
    .from(savIntakeModelCalls).where(eq(savIntakeModelCalls.messageKey, intakeRuntimeHash(messageId))).orderBy(desc(savIntakeModelCalls.createdAt), desc(savIntakeModelCalls.id)).limit(21);
  return rows.map(row => {
    let p: Record<string, unknown> = {};
    try { p = object(decryptSavPayload<unknown>(row.payloadCiphertext)); } catch { /* unreadable stays unknown */ }
    const metadata = object(p.metadata), counters = ["inputTokens", "outputTokens", "thoughtTokens", "totalTokens"].filter(k => Number.isSafeInteger(metadata[k])).length;
    const usage = !Object.keys(p).length ? "unknown" : p.usageReconciliation === "provider_http_error_unbilled.v1" ? "provider_http_unbilled"
      : row.state === "settled" ? "complete" : row.state === "dispatched" ? "in_flight_or_lost" : counters === 0 ? "no_usage_received" : "counters_incomplete";
    return { state: ["dispatched", "uncertain", "settled"].includes(row.state) ? row.state : null, usage, providerStatus: count(p.providerStatus),
      createdAt: row.createdAt, settledAt: row.settledAt, reservedNanoUsd: count(row.reservedNanoUsd), chargedNanoUsd: count(row.chargedNanoUsd) };
  });
}

/** Latest inbound message only, all attempts counted across versions. No lease,
 * source refresh, model/CRM call, projection update or operational write. */
const DIAGNOSTIC_BUDGET_PAYLOAD_BYTES = 4 * 1024 * 1024, DIAGNOSTIC_BUDGET_TOTAL_BYTES = 32 * 1024 * 1024, DIAGNOSTIC_BUDGET_ROWS = 200;
export async function readIntakeRunDiagnostics(threadId: string) {
  return requireDb().transaction(async tx => {
    const [message] = await tx.select({ id: savMessages.id }).from(savMessages)
      .where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
      .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    if (!message) return null;
    const [total] = await tx.select({ attempts: sql<number>`coalesce(sum(${savIntakeRuns.attempts}),0)::int` }).from(savIntakeRuns).where(eq(savIntakeRuns.messageId, message.id));
    const rows = await tx.select({ id: savIntakeRuns.id, version: savIntakeRuns.version, isCurrent: savIntakeRuns.isCurrent, state: savIntakeRuns.state,
      attempts: savIntakeRuns.attempts, createdAt: savIntakeRuns.createdAt, updatedAt: savIntakeRuns.updatedAt,
      payloadCiphertext: sql<string>`case when octet_length(${savIntakeRuns.payloadCiphertext}) <= 262144 then ${savIntakeRuns.payloadCiphertext} else '' end` }).from(savIntakeRuns).where(eq(savIntakeRuns.messageId, message.id))
      .orderBy(desc(savIntakeRuns.version), desc(savIntakeRuns.id)).limit(21);
    const displayed = rows.slice(0, 20), ids = displayed.map(r => r.id);
    const events = ids.length ? await tx.select({ id: savIntakeJournal.id, runId: savIntakeJournal.runId, kind: savIntakeJournal.kind, createdAt: savIntakeJournal.createdAt,
      payloadCiphertext: sql<string>`case when octet_length(${savIntakeJournal.payloadCiphertext}) <= 262144 then ${savIntakeJournal.payloadCiphertext} else '' end` }).from(savIntakeJournal).where(inArray(savIntakeJournal.runId, ids))
      .orderBy(desc(savIntakeJournal.createdAt), desc(savIntakeJournal.id)).limit(121) : [];
    // The attempt budget is computed apart from the displayed page: exact SQL total,
    // the current run read directly, and the analysis flag of each attempted version
    // derived one payload at a time; only counters are kept, never payloads or text.
    // Beyond the row or aggregate read bound, attempts are unknown, never "not failed".
    const [current] = await tx.select({ id: savIntakeRuns.id, attempts: savIntakeRuns.attempts }).from(savIntakeRuns)
      .where(and(eq(savIntakeRuns.messageId, message.id), eq(savIntakeRuns.isCurrent, true))).limit(1);
    const attempted = await tx.select({ id: savIntakeRuns.id, attempts: savIntakeRuns.attempts, bytes: sql<number>`octet_length(${savIntakeRuns.payloadCiphertext})::int` })
      .from(savIntakeRuns).where(and(eq(savIntakeRuns.messageId, message.id), gt(savIntakeRuns.attempts, 0)))
      .orderBy(desc(savIntakeRuns.version), desc(savIntakeRuns.id)).limit(DIAGNOSTIC_BUDGET_ROWS);
    const exactTotal = Number(total.attempts);
    let failed = 0, counted = 0, readBytes = 0;
    for (const r of attempted) {
      if (r.bytes > DIAGNOSTIC_BUDGET_PAYLOAD_BYTES || readBytes + r.bytes > DIAGNOSTIC_BUDGET_TOTAL_BYTES) continue;
      readBytes += r.bytes;
      const [row] = await tx.select({ payloadCiphertext: savIntakeRuns.payloadCiphertext }).from(savIntakeRuns).where(eq(savIntakeRuns.id, r.id));
      const analysed = intakeRunAnalysed(row?.payloadCiphertext ?? null);
      if (analysed === null) continue;
      counted += r.attempts;
      if (!analysed) failed += r.attempts;
    }
    const unknown = Math.max(0, exactTotal - counted);
    const known = current ? intakeAttemptExhaustion({ runAttempts: current.attempts, failed, total: exactTotal }) : false;
    // Unknown attempts that could reach the failed cap leave the verdict undetermined.
    const undetermined = current && !known && failed + unknown >= SAV_INTAKE_ATTEMPT_POLICY.failedPerMessage;
    const budget = current ? { runAttempts: current.attempts, failed, unknown, total: exactTotal, exhausted: undetermined ? "undetermined" as const : known || null,
      policy: SAV_INTAKE_ATTEMPT_POLICY } : null;
    const blocked = current ? (await tx.select({ id: savIntakeJournal.id }).from(savIntakeJournal)
      .where(and(eq(savIntakeJournal.runId, current.id), inArray(savIntakeJournal.kind, [...SAV_INTAKE_BLOCKING_JOURNAL_KINDS]))).limit(1)).length > 0 : false;
    const execution = await readExecutionDiagnostic(tx, message.id);
    const modelCalls = await readModelCallDiagnostic(tx, message.id);
    return { messageId: message.id, totalAttempts: exactTotal, execution, modelCalls: modelCalls.slice(0, 20), modelCallsTruncated: modelCalls.length > 20,
      // null: the bounded reader cannot tell; callers must not read it as "attempts remain".
      attemptsExhausted: blocked || Boolean(known) ? true : undetermined ? null : false,
      attemptBudget: budget,
      versionsTruncated: rows.length > 20, eventsTruncated: events.length > 120,
      runs: displayed.map(r => ({ runId: r.id, version: r.version, isCurrent: r.isCurrent, state: r.state,
        attempts: r.attempts, createdAt: r.createdAt, updatedAt: r.updatedAt, diagnostic: intakeDiagnosticPayload(r.payloadCiphertext),
        events: events.slice(0, 120).filter(e => e.runId === r.id).map(e => ({ id: e.id, kind: code(e.kind), createdAt: e.createdAt,
          diagnostic: intakeDiagnosticPayload(e.payloadCiphertext) })) })) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
