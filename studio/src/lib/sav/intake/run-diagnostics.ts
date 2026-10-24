import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeJournal, savIntakeRuns, savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { savAttachmentReasonSchema, savAttachmentStatusSchema } from "../attachment-contract";
import { intakeContextReasonLabels } from "./console-presentation";

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const publicCodes = new Set<string>([...Object.keys(intakeContextReasonLabels), ...savAttachmentReasonSchema.options, ...savAttachmentStatusSchema.options,
  "queued", "claimed", "waiting", "observed", "superseded", "interrupted", "obsolete_partial_result", "budget_deferred_before_attempt",
  "attempts_exhausted", "paused", "usage_uncertain", "unknown_anchor", "wrong_anchor_source", "ambiguous_quote_format", "unknown_source",
  "excerpt_not_in_source", "required_source_missing", "message_id_mismatch", "registration_source_invalid", "output_schema_invalid",
  "request_limit", "operation_forbidden", "partial_response", "total_mismatch", "pagination_cycle", "page_limit", "archived_contact",
  "aliases_unavailable", "batch_limit", "partial_batch", "conflicting_contact", "contact_limit", "cancelled", "read_unavailable",
  "ticket_limit", "ticket_membership_conflict", "ticket_content_unavailable", "history_limit", "history_date_unknown"]);
const code = (v: unknown) => typeof v === "string" && (/^(?:SAV_[A-Z0-9_]{1,90}|HUBSPOT_HTTP_\d{3})$/.test(v) || publicCodes.has(v)) ? v : null;
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const methods = new Set(["analyseMessage", "assessIdentity", "assessIssues"]);
const operations = new Set(["email_lookup", "contact", "direct_associations", "contact_tickets", "ticket_history"]);

const contextSections = ["message", "conversation", "provenance", "requests", "requestContext", "tickets", "candidates", "address", "evidence", "catalogue", "imageInputs"];
const contextSources = ["current", "initial-request", "ticket", "history", "identity-ticket", "identity-history", "contact", "message", "image", "other"];
const historyCounts = ["tickets", "events", "notes", "emails", "htmlEmails", "duplicateEvents", "duplicateBytes", "nestedEvents", "nestedBytes", "quotedBytes", "maxTicketHistoryBytes"];
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
      const t = object(raw), limit = object(t.contextLimit), validation = object(t.validationFailure);
      return { method: methods.has(String(t.method)) ? String(t.method) : null,
        phase: ["understanding", "ticket_matching", "accepted_semantics"].includes(String(t.phase)) ? String(t.phase) : null,
        operation: operations.has(String(t.operation)) ? String(t.operation) : null,
        status: ["complete", "partial", "failed"].includes(String(t.status)) ? String(t.status) : null,
        accepted: typeof t.accepted === "boolean" ? t.accepted : null,
        errorCode: code(t.errorCode), reason: code(t.reason), validationReason: code(validation.reason),
        contextLimit: ["catalogue", "data"].includes(String(limit.stage)) ? { stage: String(limit.stage), bytes: count(limit.bytes), limitBytes: count(limit.limitBytes), breakdown: contextBreakdown(limit.breakdown) } : null };
    });
    return { readable: true, reason: code(payload.reason),
      codeRevision: typeof configuration.codeRevision === "string" && /^[a-f0-9]{40}$/.test(configuration.codeRevision) ? configuration.codeRevision : null,
      contextReasons: disposition.kind === "collect_context" && Array.isArray(disposition.reasons)
        ? disposition.reasons.filter((r): r is string => typeof r === "string" && Object.hasOwn(intakeContextReasonLabels, r)).slice(0, 15) : [],
      input: { contentComplete: typeof message.contentComplete === "boolean" ? message.contentComplete : null,
        currentTextLength: typeof message.currentText === "string" ? message.currentText.length : null },
      attachments: { textComplete: typeof attachments.textComplete === "boolean" ? attachments.textComplete : null,
        inventoryComplete: typeof object(attachments.inventory).complete === "boolean" ? object(attachments.inventory).complete : null,
        observations: (Array.isArray(read.observations) ? read.observations : []).slice(0, 100).map(raw => {
          const o = object(raw); return { status: code(o.status), reason: code(o.reason) };
        }) }, traces, tracesTruncated: Array.isArray(payload.traces) && payload.traces.length > 40 };
  } catch {
    return { readable: false, reason: null, codeRevision: null, contextReasons: [], input: null, attachments: null, traces: [], tracesTruncated: false };
  }
}

/** Latest inbound message only, all attempts counted across versions. No lease,
 * source refresh, model/CRM call, projection update or operational write. */
export async function readIntakeRunDiagnostics(threadId: string) {
  return requireDb().transaction(async tx => {
    const [message] = await tx.select({ id: savMessages.id }).from(savMessages)
      .where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
      .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
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
    return { messageId: message.id, totalAttempts: Number(total.attempts), attemptsExhausted: Number(total.attempts) >= 2,
      versionsTruncated: rows.length > 20, eventsTruncated: events.length > 120,
      runs: displayed.map(r => ({ runId: r.id, version: r.version, isCurrent: r.isCurrent, state: r.state,
        attempts: r.attempts, createdAt: r.createdAt, updatedAt: r.updatedAt, diagnostic: intakeDiagnosticPayload(r.payloadCiphertext),
        events: events.slice(0, 120).filter(e => e.runId === r.id).map(e => ({ id: e.id, kind: code(e.kind), createdAt: e.createdAt,
          diagnostic: intakeDiagnosticPayload(e.payloadCiphertext) })) })) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
