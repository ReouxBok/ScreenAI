import "server-only";
import { and, eq, like } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEvents, savMessages } from "@/db/schema";
import type { SavIntakeDecision } from "../intake/contract";
import { decideCaseAdmission } from "./admission-policy";
import { appendCaseEvent, readCaseByTicket, savCaseRecordingEnabled, transitionCaseOwner } from "./case-store";
import { caseAwaitsV2Attribution, caseDedupeKey, type CaseAdmissionDecision, type CaseSnapshot } from "./case-types";
import { caseSensitivityOf, relayAdmissionInput, relayPaused, v2HubspotOwnerId, type CaseBoundaryDeps } from "./intake-boundary";

export { v2HubspotOwnerId };

export const SAV_V2_OWNER_REFUSALS = [
  "no_v2_owner_configured", "recording_off", "owner_unknown", "human_owner_present", "already_v2_owner", "source_missing", "sensitive", "case_not_pending", "case_with_team", "not_admitted", "paused",
] as const;
export type V2OwnerRefusal = typeof SAV_V2_OWNER_REFUSALS[number];
export type V2OwnerAttribution =
  | { assign: true; ownerId: string }
  | { assign: false; reason: V2OwnerRefusal; admission?: CaseAdmissionDecision["reasons"][number] };

/** Deterministic, no model call: every condition must be positive (contract v9 §4). The HubSpot
 * owner is the one read just now; an existing human owner is never captured, a V2 owner a person
 * removed is not put back, and the ticket status (« Nouveau » included) is not an input at all.
 * `admission`: decided now from this mail as the relay will, never the case's older record. */
export function decideV2OwnerAttribution(input: {
  v2OwnerId: string | null;
  /** `undefined` when the fresh read failed or did not return the owner. */
  currentOwnerId: string | null | undefined;
  /** The message being executed, as V1 classified it: finance, cancellation or a mixed mail exclude. */
  decision: Pick<SavIntakeDecision, "classification" | "requests">;
  case: Pick<CaseSnapshot, "owner" | "phase" | "body" | "sensitivity"> | null;
  admission: Pick<CaseAdmissionDecision, "target" | "reasons">;
}): V2OwnerAttribution {
  if (!input.v2OwnerId) return { assign: false, reason: "no_v2_owner_configured" };
  if (input.currentOwnerId === undefined) return { assign: false, reason: "owner_unknown" };
  if (input.currentOwnerId === input.v2OwnerId) return { assign: false, reason: "already_v2_owner" };
  if (input.currentOwnerId !== null) return { assign: false, reason: "human_owner_present" };
  if (caseSensitivityOf(input.decision) !== "none" || (input.case && input.case.sensitivity !== "none")) return { assign: false, reason: "sensitive" };
  if (input.case?.owner === "agent") return { assign: false, reason: "case_not_pending" };
  if (input.case && !caseAwaitsV2Attribution(input.case)) return { assign: false, reason: "case_with_team" };
  return input.admission.target === "agent" ? { assign: true, ownerId: input.v2OwnerId } : { assign: false, reason: "not_admitted", admission: input.admission.reasons[0] };
}

/** `ExecutorAdapters.v2OwnerAttribution` for one execution (contract v9 §4): the message is bound
 * when the port is built, so the executor's call is unchanged. Reads the database and the ticket
 * owner only; it writes nothing. Since review R1 (31/10) the executor never asks it and plans no
 * owner write: HubSpot has no conditional PATCH, so a read then a write could overwrite a human. */
export function v2OwnerAttributionPort(input: { messageId: string; deps?: CaseBoundaryDeps & { readTicketOwner?: (ticketId: string, signal: AbortSignal) => Promise<string | null | undefined> } }) {
  const deps = input.deps ?? {};
  return async ({ ticketId, decision, signal }: { ticketId: string; decision: Pick<SavIntakeDecision, "classification" | "requests">; signal: AbortSignal }): Promise<V2OwnerAttribution> => {
    const v2OwnerId = v2HubspotOwnerId(deps.env);
    if (!v2OwnerId) return { assign: false, reason: "no_v2_owner_configured" };
    if (!savCaseRecordingEnabled(deps.env)) return { assign: false, reason: "recording_off" };
    const currentOwnerId = deps.readTicketOwner ? await deps.readTicketOwner(ticketId, signal) : undefined;
    const [message] = await requireDb().select({ gmailMessageId: savMessages.gmailMessageId, direction: savMessages.direction }).from(savMessages).where(eq(savMessages.id, input.messageId));
    if (!message?.gmailMessageId || message.direction !== "inbound") return { assign: false, reason: "source_missing" };
    const current = await readCaseByTicket(ticketId);
    const { admission } = await relayAdmissionInput({ messageId: input.messageId, gmailMessageId: message.gmailMessageId, decision, confirmedTicket: true, deps });
    const fresh = decideCaseAdmission({ policy: admission.policy, qualification: admission.qualification, caseSensitivity: current?.sensitivity ?? "none" });
    return decideV2OwnerAttribution({ v2OwnerId, currentOwnerId, decision, case: current, admission: fresh });
  };
}

/** `ExecutorAdapters.v2OwnerAtCreation` (pilot access, 3/11, local): may the ticket V1 is about to CREATE
 * carry the dedicated V2 owner in its POST? The same decision the relay will take on this mail (same policy,
 * same qualification, same pauses), with no ticket to read: nobody can own a ticket that does not exist yet.
 * Reads the database only, writes nothing; the relay still reads the created ticket's owner afterwards. */
export function v2OwnerAtCreationPort(deps: CaseBoundaryDeps = {}) {
  return async ({ decision }: { decision: Pick<SavIntakeDecision, "messageId" | "classification" | "requests">; signal: AbortSignal }): Promise<V2OwnerAttribution> => {
    const v2OwnerId = v2HubspotOwnerId(deps.env);
    if (!v2OwnerId) return { assign: false, reason: "no_v2_owner_configured" };
    if (!savCaseRecordingEnabled(deps.env)) return { assign: false, reason: "recording_off" };
    if (await relayPaused(requireDb())) return { assign: false, reason: "paused" };
    if (caseSensitivityOf(decision) !== "none") return { assign: false, reason: "sensitive" };
    const [message] = await requireDb().select({ gmailMessageId: savMessages.gmailMessageId, direction: savMessages.direction }).from(savMessages).where(eq(savMessages.id, decision.messageId));
    if (!message?.gmailMessageId || message.direction !== "inbound") return { assign: false, reason: "source_missing" };
    const { admission } = await relayAdmissionInput({ messageId: decision.messageId, gmailMessageId: message.gmailMessageId, decision, confirmedTicket: true, deps });
    const fresh = decideCaseAdmission({ policy: admission.policy, qualification: admission.qualification, caseSensitivity: "none" });
    return fresh.target === "agent" ? { assign: true, ownerId: v2OwnerId } : { assign: false, reason: "not_admitted", admission: fresh.reasons[0] };
  };
}

/** The same port for `createIntakeExecutorAdapters`, built once per pass: the executed message is
 * `decision.messageId`, which admission refuses unless equal to the run's message (execution-store.ts,
 * `plan.decision.messageId !== run.messageId`). The one-line seam proposed to ROOT/C; this lot does not wire it. */
export function v2OwnerAttributionAdapter(deps: Parameters<typeof v2OwnerAttributionPort>[0]["deps"] = {}) {
  return (input: { ticketId: string; decision: Pick<SavIntakeDecision, "messageId" | "classification" | "requests">; signal: AbortSignal }) =>
    v2OwnerAttributionPort({ messageId: input.decision.messageId, deps })(input);
}

const STAGE = /^[A-Za-z0-9_-]{1,40}$/;
type ObservedOwner = "v2" | "human" | "none" | "unknown";
/** A HubSpot change of the ticket's owner or stage without a new mail (contract v9 §5): one durable,
 * versioned `crm_observed` per (ticket, HubSpot modification time); a duplicate changes nothing and
 * an older change than one already seen is kept but moves nothing. No mail is read again, no request
 * opened, nothing is an inbound input for B. Only the latest change may take a case from the agent:
 * a human owner, or the V2 owner removed. Seeing the V2 owner or « Nouveau » here never gives one back:
 * that needs `hand_back` (a person) or `v2_attribution` (the relay or its sweep, on V1's verified effect or the owner read now). */
export async function observeTicketCrmChange(input: {
  ticketId: string; ownerId?: string | null; stage?: string; hubspotUpdatedAt: string; env?: Record<string, string | undefined>;
}): Promise<{ recorded: false; reason: "recording_off" | "no_case" } | { recorded: boolean; outOfOrder: boolean; takeover: boolean; case: CaseSnapshot }> {
  if (!savCaseRecordingEnabled()) return { recorded: false, reason: "recording_off" };
  const current = await readCaseByTicket(input.ticketId);
  if (!current) return { recorded: false, reason: "no_case" };
  if (input.stage !== undefined && !STAGE.test(input.stage)) throw new Error("SAV_CASE_CRM_STAGE_INVALID");
  // Dedupe keys allow no colon: the HubSpot modification date is keyed by its epoch milliseconds.
  const at = Date.parse(input.hubspotUpdatedAt);
  if (!Number.isFinite(at)) throw new Error("SAV_CASE_OCCURRED_AT_INVALID");
  const prefix = `crm:${input.ticketId}:`;
  const seen = await requireDb().select({ key: savCaseEvents.dedupeKey }).from(savCaseEvents)
    .where(and(eq(savCaseEvents.caseId, current.caseId), eq(savCaseEvents.kind, "crm_observed"), like(savCaseEvents.dedupeKey, `${prefix}%`)));
  const outOfOrder = seen.some(row => Number(row.key.slice(prefix.length)) > at);
  const v2 = v2HubspotOwnerId(input.env);
  const owner: ObservedOwner = input.ownerId === undefined ? "unknown" : input.ownerId === null ? "none" : input.ownerId === v2 ? "v2" : "human";
  const sourceRef = { type: "hubspot_object" as const, id: input.ticketId };
  const appended = await appendCaseEvent({
    caseId: current.caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm(input.ticketId, String(at)), sourceRef,
    detail: { crmChange: input.ownerId === undefined ? "status_changed" : "owner_changed", owner, ...(input.stage === undefined ? {} : { stage: input.stage }), outOfOrder },
  });
  const after = (await readCaseByTicket(input.ticketId))!;
  const takeover = appended.appended && !outOfOrder
    && ((after.owner === "agent" && (owner === "human" || owner === "none")) || (caseAwaitsV2Attribution(after) && owner === "human"));
  if (!takeover) return { recorded: appended.appended, outOfOrder, takeover: false, case: after };
  const moved = await transitionCaseOwner({
    caseId: after.caseId, expectedVersion: after.version, transition: "human_takeover", actor: { type: "system" },
    commandKey: `hubspot-owner.${input.ticketId}.${at}`, reason: owner === "none" ? "hubspot_owner_removed" : "hubspot_owner_human", sourceRef,
  });
  return { recorded: true, outOfOrder, takeover: true, case: moved.case };
}

/** v8 name, kept for callers: an owner-only observation. */
export function observeTicketOwner(input: { ticketId: string; observedOwnerId: string | null; hubspotUpdatedAt: string; env?: Record<string, string | undefined> }) {
  return observeTicketCrmChange({ ticketId: input.ticketId, ownerId: input.observedOwnerId, hubspotUpdatedAt: input.hubspotUpdatedAt, env: input.env });
}

/** Ugo's idea, still to be specified: from Friday noon to Sunday evening the human ticket
 * would not go back to « Nouveau » at once. Central decision point, inactive without a
 * configured window (no Sunday hour is invented). Receiving, attaching and creating are
 * never deferred, an agent ticket is never deferred, and the global pause is not involved. */
export type HumanRequeueWindow = {
  timeZone: string;
  /** ISO weekday 1 (Monday) .. 7 (Sunday), local time "HH:MM". */
  start: { isoDay: number; time: string };
  end: { isoDay: number; time: string };
};
export type RequeueOperation = "receive" | "attach" | "create" | "requeue_new";
export function decideHumanRequeueWindow(input: { now: Date; window: HumanRequeueWindow | null; operation: RequeueOperation; ticketOwner: "human" | "v2" | "none" }):
  { defer: false; reason: "window_unconfigured" | "operation_not_deferrable" | "not_human_ticket" | "outside_window" } | { defer: true; reason: "inside_window" } {
  if (!input.window) return { defer: false, reason: "window_unconfigured" };
  if (input.operation !== "requeue_new") return { defer: false, reason: "operation_not_deferrable" };
  if (input.ticketOwner !== "human") return { defer: false, reason: "not_human_ticket" };
  const minute = weekMinute(input.now, input.window.timeZone), start = specMinute(input.window.start), end = specMinute(input.window.end);
  const inside = start <= end ? minute >= start && minute < end : minute >= start || minute < end;
  return inside ? { defer: true, reason: "inside_window" } : { defer: false, reason: "outside_window" };
}
function specMinute(spec: { isoDay: number; time: string }) {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(spec.time);
  if (!Number.isInteger(spec.isoDay) || spec.isoDay < 1 || spec.isoDay > 7 || !match) throw new Error("SAV_REQUEUE_WINDOW_INVALID");
  return (spec.isoDay - 1) * 1440 + Number(match[1]) * 60 + Number(match[2]);
}
/** Minutes since Monday 00:00 in the window's time zone (daylight saving handled by Intl). */
function weekMinute(now: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map(part => [part.type, part.value]));
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!);
  return day * 1440 + Number(parts.hour) * 60 + Number(parts.minute);
}
