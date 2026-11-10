// Pure triage of the old V0 engine's queue (sav.actions, sav.followups) after the engine is retired.
// It only describes: no database, no clock, no network, no write, and no disposition that executes anything. Every row keeps its status;
// the verdict is the input of an audited, Ugo-approved procedure that is not part of this module. See SAV-9.

/** Payload markers a V0 worker writes right before it calls the provider: past this point the outcome can be unknown. */
export const V0_DISPATCH_MARKERS = [
  "ticketCreateDispatchedAt", "ticketReturnDispatchedAt", "replySendDispatchedAt", "forwardDispatchedAt", "intakeOccupationDispatchedAt",
] as const;

export type V0BacklogRow = Readonly<{
  id: string;
  kind: string;
  actorType: string;
  status: string;
  attemptCount: number;
  pilotBatchId: string | null;
  payload: Readonly<Record<string, unknown>>;
}>;

export type V0BacklogClass =
  | "data_not_effect" // drafts: nothing to execute
  | "human_command" // a person's command: the human path still serves it
  | "confirmed" // succeeded: evidence, never repeated
  | "closed_without_effect" // failed or cancelled with no dispatch marker
  | "engaged_unverified" // dispatched, or running/failed/cancelled after a dispatch marker: outcome unknown
  | "held_not_sent" // pending/running, machine author, no dispatch marker: never sent, now held
  | "pilot_simulation"; // pilot batches are proposals shown in the Studio, never commands
export type V0BacklogDisposition = "keep_unchanged" | "verify_read_only" | "hold_for_audited_decision";

export type V0BacklogVerdict = Readonly<{
  class: V0BacklogClass;
  disposition: V0BacklogDisposition;
  // Constant on purpose: this module can never authorise an execution, a replay or an acknowledgement.
  mayExecute: false;
  reason: string;
}>;

const EFFECT_KINDS: ReadonlySet<string> = new Set(["send_reply", "request_human", "create_ticket", "link_ticket", "create_note", "log_email", "update_ticket_status"]);

const verdict = (cls: V0BacklogClass, disposition: V0BacklogDisposition, reason: string): V0BacklogVerdict => ({ class: cls, disposition, mayExecute: false, reason });

export function hasV0DispatchMarker(payload: Readonly<Record<string, unknown>>): boolean {
  return V0_DISPATCH_MARKERS.some((marker) => payload[marker] !== undefined && payload[marker] !== null && payload[marker] !== "");
}

/**
 * One verdict per row, fail-closed: an unknown status or kind is never read as "nothing happened".
 * Order matters: evidence of an external call beats every status, so a row that failed after its marker stays "engaged_unverified".
 */
export function triageV0Action(row: V0BacklogRow): V0BacklogVerdict {
  if (row.pilotBatchId) return verdict("pilot_simulation", "keep_unchanged", "pilot rows are Studio proposals, blocked from any write");
  if (!EFFECT_KINDS.has(row.kind)) {
    return row.kind === "draft_reply"
      ? verdict("data_not_effect", "keep_unchanged", "a draft is data for a person to read, not an effect")
      : verdict("engaged_unverified", "verify_read_only", "unknown action kind: not assumed harmless");
  }
  if (row.status === "succeeded") return verdict("confirmed", "keep_unchanged", "confirmed effect: kept as evidence, never repeated");
  if (hasV0DispatchMarker(row.payload)) {
    return verdict("engaged_unverified", "verify_read_only", "a provider call may have happened: verify with read-only requests, never resend");
  }
  if (row.actorType === "human") return verdict("human_command", "keep_unchanged", "human command: served by the human path, not by the retired engine");
  if (row.status === "failed" || row.status === "cancelled") return verdict("closed_without_effect", "keep_unchanged", "closed before any provider call");
  if (row.status === "pending" || row.status === "running") {
    return verdict("held_not_sent", "hold_for_audited_decision", "never sent and now held: leave as is until an approved procedure decides its fate");
  }
  return verdict("engaged_unverified", "verify_read_only", "unknown status: not assumed harmless");
}

export type V0FollowupRow = Readonly<{ id: string; status: string; actionId: string | null }>;

/** A scheduled follow-up is a promise nobody will keep; a queued one follows its action. Neither is executed or cancelled here. */
export function triageV0Followup(row: V0FollowupRow, action: V0BacklogRow | null): V0BacklogVerdict {
  if (row.status === "scheduled" && row.actionId === null) {
    return verdict("held_not_sent", "hold_for_audited_decision", "scheduled follow-up of the retired engine: never queued, now held");
  }
  if (row.actionId !== null) {
    if (action === null) return verdict("engaged_unverified", "verify_read_only", "queued follow-up whose action row is missing: not assumed harmless");
    return triageV0Action(action);
  }
  if (row.status === "cancelled") return verdict("closed_without_effect", "keep_unchanged", "closed follow-up");
  return verdict("engaged_unverified", "verify_read_only", "unknown follow-up state: not assumed harmless");
}

export type V0BacklogSummary = Readonly<{
  total: number;
  byClass: Readonly<Record<V0BacklogClass, number>>;
  byDisposition: Readonly<Record<V0BacklogDisposition, number>>;
  // Rows an operator must look at first: an external call may have happened.
  toVerify: readonly string[];
  toHold: readonly string[];
}>;

/** Deterministic counts for the before/after inventory. Row ids come back sorted, so two runs on the same data are equal. */
export function summarizeV0Backlog(rows: readonly Readonly<{ id: string; verdict: V0BacklogVerdict }>[]): V0BacklogSummary {
  const byClass: Record<V0BacklogClass, number> = {
    data_not_effect: 0, human_command: 0, confirmed: 0, closed_without_effect: 0, engaged_unverified: 0, held_not_sent: 0, pilot_simulation: 0,
  };
  const byDisposition: Record<V0BacklogDisposition, number> = { keep_unchanged: 0, verify_read_only: 0, hold_for_audited_decision: 0 };
  for (const row of rows) { byClass[row.verdict.class] += 1; byDisposition[row.verdict.disposition] += 1; }
  const ids = (disposition: V0BacklogDisposition) => rows.filter((row) => row.verdict.disposition === disposition).map((row) => row.id).sort();
  return { total: rows.length, byClass, byDisposition, toVerify: ids("verify_read_only"), toHold: ids("hold_for_audited_decision") };
}
