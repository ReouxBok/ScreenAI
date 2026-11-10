import { caseModelTransportDiagnosticSchema } from "./investigation-transport-diagnostic";
import { z } from "zod";
import type { CaseDecisionContextProblem } from "./decision-context";
import { CASE_RESOLUTION_VERDICTS } from "./investigation-closure";
import type { CaseInvestigationProgress, CaseInvestigationRecord } from "./investigation-runner";

/*
 * Durable form of an investigation in the pole A case store, with no table or ledger of its own. A claim ends with
 * exactly one `observation_recorded` event (pole A `recordCaseObservation`), whose opaque `record` belongs to B:
 * this module writes and reads that record. Progress and decision of one run travel together in it, so a wait,
 * a refusal or a resumption is read back from the case journal, not from memory.
 * Calls are not counted here: the shared model ledger caps them per input subject (see the runner), so a run that
 * crashed before its observation still cannot pay a call twice. Pure, no I/O.
 */

export const SAV_CASE_INVESTIGATION_RECORD_KIND = "sav-case-investigation.v1";
/** Pole A refuses an observation record above 64 KiB; ours stays under it with margin, or is refused here. */
export const SAV_CASE_INVESTIGATION_RECORD_MAX_BYTES = 60 * 1024;

const count = z.number().int().nonnegative();
// The closed reason codes of a context that cannot be built: never a raw message, never customer text.
const contextProblems: readonly [CaseDecisionContextProblem, ...CaseDecisionContextProblem[]] =
  ["contract_revision", "body_invalid", "event_other_case", "event_after_snapshot", "event_duplicate", "event_direction_invalid", "source_duplicate"];
const contextProblem = z.enum(contextProblems);
const knowledgeChangedProblem = z.enum(["revision_moved", "revision_unreadable"]);
const at = z.string().refine(value => Number.isFinite(Date.parse(value)), "date");
const attemptSchema = z.union([
  z.object({ call: count, result: z.literal("validated"), outcome: z.enum(["accepted", "needs_review"]), kinds: z.array(z.string()), codes: z.array(z.string()) }).strict(),
  z.object({ call: count, result: z.literal("checked"), plan: z.enum(["soft_close", "no_close_transfer_thanks", "no_close_not_resolved", "ask_confirmation"]) }).strict(),
  z.object({ call: count, result: z.literal("failed"), purpose: z.enum(["decision", "resolution_check"]), uncertain: z.boolean(), diagnostic: caseModelTransportDiagnosticSchema.optional() }).strict(),
]);
const closureSchema = z.object({
  plan: z.enum(["soft_close", "no_close_transfer_thanks", "no_close_not_resolved", "ask_confirmation"]),
  verdicts: z.array(z.object({ requestId: z.string(), verdict: z.enum(CASE_RESOLUTION_VERDICTS) }).strict()),
  reason: z.enum(["checked", "no_call_left", "check_unreadable"]),
}).strict();
// The validation and the proposal are re-computed on every run from today's read; they are kept as written.
const progressSchema = z.object({
  modelCalls: count.max(3), attempts: z.array(attemptSchema).max(12),
  waiting: z.object({
    reason: z.enum(["deferred_budget", "case_budget", "technical_wait", "usage_uncertain", "technical_exhausted", "paused", "decision_refused", "context_invalid", "knowledge_request_invalid", "knowledge_changed"]),
    since: at, caseVersion: count, problem: z.union([contextProblem, knowledgeChangedProblem]).optional(), embeddingCalls: count.max(1000).optional(), diagnostic: caseModelTransportDiagnosticSchema.optional(),
  }).strict()
    // Each closed code belongs to its own reason: a context code only on context_invalid, a revision code only on knowledge_changed.
    .refine(wait => wait.problem === undefined || (wait.reason === "knowledge_changed" ? knowledgeChangedProblem.safeParse(wait.problem).success : wait.reason === "context_invalid" && contextProblem.safeParse(wait.problem).success), "problem")
    .refine(wait => wait.diagnostic === undefined || ["technical_wait", "usage_uncertain", "technical_exhausted"].includes(wait.reason), "diagnostic")
    .nullable(),
  proposal: z.object({ output: z.unknown(), proposedOn: count }).strict().nullable(),
  last: z.unknown(),
  closure: closureSchema.nullable(),
  recordedOn: count.nullable(),
}).strict();
const storedSchema = z.object({
  kind: z.literal(SAV_CASE_INVESTIGATION_RECORD_KIND), inputKey: z.string().regex(/^(in|back):[A-Za-z0-9._@<>=+-]{1,200}$/),
  progress: progressSchema, decision: z.record(z.string(), z.unknown()).nullable(),
}).strict();

export type CaseInvestigationStoredRecord = { kind: typeof SAV_CASE_INVESTIGATION_RECORD_KIND; inputKey: string; progress: CaseInvestigationProgress; decision: CaseInvestigationRecord | null };

/** The `record` given to `recordCaseObservation` at the end of a claim. Refused, never truncated, when too large. */
export function caseInvestigationObservationRecord(inputKey: string, progress: CaseInvestigationProgress, decision: CaseInvestigationRecord | null): Record<string, unknown> {
  const record = { kind: SAV_CASE_INVESTIGATION_RECORD_KIND, inputKey, progress, decision };
  if (!storedSchema.safeParse(record).success) throw Error("SAV_CASE_INVESTIGATION_RECORD_INVALID");
  if (Buffer.byteLength(JSON.stringify(record)) > SAV_CASE_INVESTIGATION_RECORD_MAX_BYTES) throw Error("SAV_CASE_INVESTIGATION_RECORD_TOO_LARGE");
  return record;
}

/** Structural view of a pole A case event: only what this reader needs. */
export const investigationHandoffCommand = (version: number) => `investigation-handoff-v${version}`;
export type CaseInvestigationJournalEvent = { dedupeKey?: string; kind: string; caseVersion: number; detail: Record<string, unknown> | null };

export type CaseInvestigationProgressRead =
  | { state: "none" }
  | { state: "found"; caseVersion: number; record: CaseInvestigationStoredRecord }
  /** The latest investigation record of this input cannot be read: shown as a technical problem, never as a fresh start. */
  | { state: "unreadable"; caseVersion: number };

/** Latest stored progress of one input. An unreadable latest record is never skipped in favour of an older one. */
export function readCaseInvestigationProgress(events: readonly CaseInvestigationJournalEvent[], inputKey: string): CaseInvestigationProgressRead {
  const ours = events.filter(event => event.kind === "observation_recorded").map(event => {
    const record = event.detail?.record as { kind?: unknown; inputKey?: unknown } | undefined;
    return { event, record, mine: record?.kind === SAV_CASE_INVESTIGATION_RECORD_KIND };
  // A record of ours whose input cannot be read may belong to this input: it counts as unreadable for every input.
  }).filter(row => row.mine && (row.record?.inputKey === inputKey || typeof row.record?.inputKey !== "string"))
    .sort((a, b) => b.event.caseVersion - a.event.caseVersion);
  const latest = ours[0];
  if (!latest) return { state: "none" };
  const parsed = storedSchema.safeParse(latest.record);
  return parsed.success ? { state: "found", caseVersion: latest.event.caseVersion, record: parsed.data as CaseInvestigationStoredRecord }
    : { state: "unreadable", caseVersion: latest.event.caseVersion };
}
