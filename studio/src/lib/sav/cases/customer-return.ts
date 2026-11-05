// V2 customer return (LOCAL, OFF): the PURE part of the joint between a new customer mail and the V2 case it may continue. No database, clock, network or model.
//   route     which path a new inbound mail takes: continue the SAME case, reopen it (same incident still present), normal admission (new subject, no or
//             ambiguous link), keep it closed (a thanks or an automatic reply), leave it to the person or the team who owns it, or wait (owner unread, pause)
//   stages    after a CONFIRMED V2 reply the ticket waits for the customer; after a PROVEN resolution it is closed. Intents, keys and the gate only: the HubSpot
//             stage ids are injected (never guessed) and nothing here sends; an engaged write is verified, never sent again
// Nothing here classifies a mail: the facts are the stored link, V1's own confirmed records and the owner read now. A mail that needs judging goes to B
// (an open case, with its context) or to V1's normal intake (a closed case, a new subject), never to a keyword.
import type { CaseEffectLedgerState } from "./case-effects";
import type { CaseOwner, CasePhase, CaseSensitivity } from "./case-types";

export const CUSTOMER_RETURN_REVISION = "sav-v2-customer-return.v1";

/** The phases that end a cycle. A new mail on them never reopens by itself: only V1's confirmed reopen of the same ticket says « same incident ». */
export const SAV_CASE_CLOSED_PHASES = ["resolved", "closed_no_reply"] as const satisfies readonly CasePhase[];
export const caseReturnPhaseClosed = (phase: CasePhase) => (SAV_CASE_CLOSED_PHASES as readonly CasePhase[]).includes(phase);

export type CustomerReturnOwnerNow = "v2" | "human" | "none" | "unknown";
export type CustomerReturnFacts = Readonly<{
  /** Cases whose threads hold this mail's thread. The durable link is exactly one. */
  link: "one_case" | "no_case" | "several_cases";
  case: Readonly<{ owner: CaseOwner; phase: CasePhase; sensitivity: CaseSensitivity }> | null;
  /** The case journal already holds this mail (`inbound:<gmail id>`): a replay, or V1's relay came first. */
  alreadyRecorded: boolean;
  /** Older than the case's first customer mail: an earlier exchange. */
  beforeCase: boolean;
  /** Proven by the stored Gmail headers (V1's automation gate): an automatic reply or a delivery report. Never the subject or the text. */
  automated: boolean;
  /** V1 accepted an acknowledgement-only analysis of this very mail (a « merci »). */
  acknowledgement: boolean;
  /** V1's CONFIRMED ticket for this mail: the case's ticket (linked or reopened), another ticket (a new subject), or none yet.
   * `pending`: V1 holds an execution of this mail that is not confirmed: its ticket is not known yet, so the mail is nobody's to consume. */
  v1Target: "same_ticket" | "other_ticket" | "none" | "pending";
  /** A customer mail already on the case's journal is later in `customerMailOrder`: this one arrived late and never becomes the latest input. */
  olderThanLatest: boolean;
  /** The HubSpot owner of the case's ticket, read now. `unknown` is never « nobody ». */
  ownerNow: CustomerReturnOwnerNow;
  /** Intake or V2 agent pause at any level but running, or unreadable. */
  paused: boolean;
}>;

export type CustomerReturnRoute =
  /** Open case of the agent, ticket still the V2 owner's: the same case goes on, nothing recreated or reclassified. */
  | Readonly<{ route: "continue"; reason: "open_case_v2_owner" }>
  /** Closed case, V1 confirmed this mail on the same ticket (its 15-day same-subject reopen): the incident is still there, a new cycle starts. */
  | Readonly<{ route: "reopen"; reason: "same_incident_v1_confirmed" }>
  /** Not V2's to continue: V1's normal intake and relay decide (a new ticket opens a new case with its own admission). */
  | Readonly<{ route: "normal_admission"; reason: "no_case" | "several_cases" | "new_subject" | "before_case" }>
  /** Closed case: a thanks or an automatic reply is kept in V1's records and reopens nothing. */
  | Readonly<{ route: "keep_closed"; reason: "acknowledgement" | "automated" }>
  /** Open case: an automatic reply (absence, delivery report) is no customer answer. It neither continues the case nor cancels the J2. */
  | Readonly<{ route: "ignore_automated"; reason: "automated" }>
  /** A person or the team holds the case, or it is on hold: nothing is moved or written here; V1's relay records the mail as before. */
  | Readonly<{ route: "leave_to_owner"; reason: "case_with_team" | "case_on_hold" }>
  /** The ticket left the V2 owner (a person took it, or nobody owns it now): the case goes to the team with the mail; the ticket is not touched. */
  | Readonly<{ route: "hand_to_team"; reason: "human_owner" | "v2_owner_removed" | "sensitive" }>
  /** Nothing decided yet; the mail is kept and the next pass decides again. */
  | Readonly<{ route: "wait"; reason: "owner_unread" | "paused" | "v1_pending" }>
  /** A late delivery of an older mail: the newer input stays the one to answer and whatever it set (a J2 included) stays. Nothing written; the mail stays stored in its thread. */
  | Readonly<{ route: "keep_latest"; reason: "older_than_latest" }>
  | Readonly<{ route: "already_recorded" }>;

/** The explicit order of two customer mails: reception, then storage, then id, so a tie gives one answer whichever pass reads it. Positive: `a` is later. */
export type CustomerMailPosition = Readonly<{ receivedAt: Date; createdAt: Date; id: string }>;
export function customerMailOrder(a: CustomerMailPosition, b: CustomerMailPosition) {
  return a.receivedAt.getTime() - b.receivedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Order is the contract: the link first (no blind continuation), then the journal (no duplicate), then who holds the case, then what the mail is. */
export function decideCustomerReturn(facts: CustomerReturnFacts): CustomerReturnRoute {
  if (facts.link === "several_cases") return { route: "normal_admission", reason: "several_cases" };
  if (facts.link === "no_case" || !facts.case) return { route: "normal_admission", reason: "no_case" };
  if (facts.alreadyRecorded) return { route: "already_recorded" };
  if (facts.beforeCase) return { route: "normal_admission", reason: "before_case" };
  const current = facts.case;
  if (current.owner === "system_hold") return { route: "leave_to_owner", reason: "case_on_hold" };
  if (current.owner === "human") return { route: "leave_to_owner", reason: "case_with_team" };
  // V1 confirmed this very mail on another ticket: it is a new subject whatever this case is doing, open or closed, and this case never consumes it.
  if (facts.v1Target === "other_ticket") return { route: "normal_admission", reason: "new_subject" };
  if (facts.olderThanLatest) return { route: "keep_latest", reason: "older_than_latest" };
  // An agent case is never sensitive (finance and cancellation are the team's); kept as a fence, not a path.
  if (current.sensitivity !== "none") return { route: "hand_to_team", reason: "sensitive" };
  if (caseReturnPhaseClosed(current.phase)) {
    if (facts.automated) return { route: "keep_closed", reason: "automated" };
    if (facts.acknowledgement) return { route: "keep_closed", reason: "acknowledgement" };
    // Same incident or new subject is V1's confirmed decision on this very mail, never guessed here.
    if (facts.v1Target === "none" || facts.v1Target === "pending") return { route: "wait", reason: "v1_pending" };
  } else if (facts.automated) return { route: "ignore_automated", reason: "automated" };
  else if (facts.v1Target === "pending") return { route: "wait", reason: "v1_pending" };
  if (facts.paused) return { route: "wait", reason: "paused" };
  if (facts.ownerNow === "unknown") return { route: "wait", reason: "owner_unread" };
  if (facts.ownerNow === "human") return { route: "hand_to_team", reason: "human_owner" };
  if (facts.ownerNow === "none") return { route: "hand_to_team", reason: "v2_owner_removed" };
  return caseReturnPhaseClosed(current.phase) ? { route: "reopen", reason: "same_incident_v1_confirmed" } : { route: "continue", reason: "open_case_v2_owner" };
}

/** Whether the route needs the owner read now (one CRM GET), so nothing is read for a mail that another fact already routes. */
export const customerReturnNeedsOwner = (route: CustomerReturnRoute) => route.route === "wait" && route.reason === "owner_unread";

// ---------------------------------------------------------------------------------------------------------------------------------
// Ticket stages: « attente client » after a confirmed V2 reply, « fermé » after a proven resolution
// ---------------------------------------------------------------------------------------------------------------------------------

export type CaseTicketStageTarget = "waiting_customer" | "closed";
export type CaseTicketStageConfig =
  | Readonly<{ mode: "off"; why: "disabled" | "stage_missing" | "stage_invalid" | "stages_equal" }>
  | Readonly<{ mode: "on"; waitingCustomer: string; closed: string }>;
const STAGE = /^[A-Za-z0-9_-]{1,40}$/;

/** Only the exact string `on` enables it, and both HubSpot stage ids are injected: absent, malformed or equal is `off`, never a guess. */
export function readCaseTicketStageConfig(env: Readonly<Record<string, string | undefined>>): CaseTicketStageConfig {
  if (env.SAV_V2_TICKET_STAGES !== "on") return { mode: "off", why: "disabled" };
  const waitingCustomer = env.SAV_V2_STAGE_WAITING_CUSTOMER, closed = env.SAV_V2_STAGE_CLOSED;
  if (!waitingCustomer || !closed) return { mode: "off", why: "stage_missing" };
  if (!STAGE.test(waitingCustomer) || !STAGE.test(closed)) return { mode: "off", why: "stage_invalid" };
  if (waitingCustomer === closed) return { mode: "off", why: "stages_equal" };
  return { mode: "on", waitingCustomer, closed };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRIGGER = /^[A-Za-z0-9._@<>=+:-]{1,240}$/;
/** One write per (case, target, trigger): the confirmed reply's key, or the cycle that ended resolved. A replay or a second pass finds the same key. */
export function caseTicketStageKey(caseId: string, target: CaseTicketStageTarget, trigger: string) {
  if (!UUID.test(caseId) || !TRIGGER.test(trigger)) throw new Error("SAV_CASE_STAGE_KEY_INVALID");
  return `case-stage:${caseId.toLowerCase()}:${target}:${trigger}`;
}

export type CaseTicketStageTrigger =
  /** The receipt of a V2 reply is confirmed (`reply:<case>:<trigger>` confirmed by the executor), sent at `sentAt`. */
  | Readonly<{ kind: "reply_confirmed"; replyKey: string; sentAt: string }>
  /** The case cycle `cycle` ended `resolved` on an accepted `confirm_resolution` (evidence checked by the decision validator). */
  | Readonly<{ kind: "resolution_recorded"; cycle: number }>;
export type CaseTicketStagePlanInput = Readonly<{
  config: CaseTicketStageConfig;
  caseId: string;
  ticketId: string;
  case: Readonly<{ owner: CaseOwner; phase: CasePhase; sensitivity: CaseSensitivity; cycle: Readonly<{ number: number; endedBy?: "resolved" | "closed_no_reply" | "handoff" }> }>;
  trigger: CaseTicketStageTrigger;
  /** Date of the latest customer mail of the case, if any: one received after the reply makes « attente client » stale. */
  lastCustomerInboundAt: string | null;
}>;
export type CaseTicketStageIntent = Readonly<{ key: string; target: CaseTicketStageTarget; stageId: string; ticketId: string; caseId: string }>;
export type CaseTicketStagePlan = Readonly<{ plan: true; intent: CaseTicketStageIntent }> | Readonly<{ plan: false; reason: string }>;

export function planCaseTicketStage(input: CaseTicketStagePlanInput): CaseTicketStagePlan {
  const { config, trigger } = input, current = input.case;
  if (config.mode !== "on") return { plan: false, reason: `stages_${config.why}` };
  // A person's or the team's ticket is never moved by V2, whatever its stage.
  if (current.owner !== "agent") return { plan: false, reason: "owner_not_agent" };
  if (current.sensitivity !== "none") return { plan: false, reason: "sensitive" };
  if (trigger.kind === "reply_confirmed") {
    if (current.phase === "resolved") return { plan: false, reason: "case_resolved" };
    if (!Number.isFinite(Date.parse(trigger.sentAt))) return { plan: false, reason: "sent_at_invalid" };
    if (input.lastCustomerInboundAt && Date.parse(input.lastCustomerInboundAt) > Date.parse(trigger.sentAt)) return { plan: false, reason: "customer_replied_since" };
    return { plan: true, intent: { key: caseTicketStageKey(input.caseId, "waiting_customer", trigger.replyKey), target: "waiting_customer", stageId: config.waitingCustomer, ticketId: input.ticketId, caseId: input.caseId } };
  }
  // Closing needs a PROVEN resolution: an administrative closure without reply (J2) or a handoff is not one.
  if (current.phase !== "resolved" || current.cycle.endedBy !== "resolved" || current.cycle.number !== trigger.cycle) return { plan: false, reason: "resolution_not_proven" };
  return { plan: true, intent: { key: caseTicketStageKey(input.caseId, "closed", `cycle-${trigger.cycle}`), target: "closed", stageId: config.closed, ticketId: input.ticketId, caseId: input.caseId } };
}

export type CaseTicketStageLive = Readonly<{
  config: CaseTicketStageConfig;
  pause: Readonly<{ intake: "running" | "actions_paused" | "fully_paused" | "invalid"; v2: "running" | "actions_paused" | "fully_paused" | "invalid" }>;
  /** The ticket owner read just before the marker: only the V2 owner's ticket is moved. */
  ownerNow: CustomerReturnOwnerNow;
  /** The case re-read now still asks for this target (agent's, not sensitive; for `closed`, still resolved on the same cycle). */
  caseStillTarget: boolean;
  /** A customer mail recorded after the reply: « attente client » would be stale. */
  customerRepliedSince: boolean;
}>;
export type CaseTicketStageDecision =
  | Readonly<{ action: "done" }> | Readonly<{ action: "verify_only" }> | Readonly<{ action: "dispatch" }>
  | Readonly<{ action: "hold"; code: "stages_off" | "paused" | "owner_unread" }>
  | Readonly<{ action: "cancel"; code: "owner_changed" | "new_input" | "case_moved" }>;

/** Same order as the reply gate: confirmed is final; an engaged write (marker, ack, uncertain) is verified only, whatever changed since; only a planned one is judged. */
export function decideCaseTicketStage(state: CaseEffectLedgerState, target: CaseTicketStageTarget, live: CaseTicketStageLive): CaseTicketStageDecision {
  if (state === "confirmed") return { action: "done" };
  if (state === "dispatched" || state === "acked" || state === "uncertain") return { action: "verify_only" };
  if (live.config.mode !== "on") return { action: "hold", code: "stages_off" };
  if (live.pause.intake !== "running" || live.pause.v2 !== "running") return { action: "hold", code: "paused" };
  if (live.ownerNow === "unknown") return { action: "hold", code: "owner_unread" };
  if (live.ownerNow !== "v2") return { action: "cancel", code: "owner_changed" };
  if (target === "waiting_customer" && live.customerRepliedSince) return { action: "cancel", code: "new_input" };
  if (!live.caseStillTarget) return { action: "cancel", code: "case_moved" };
  return { action: "dispatch" };
}

/** Reading back after a marker. Only the stage asked AND the V2 owner kept confirm; a failed read proves nothing (still uncertain, verify again, never resend). */
export function verifyCaseTicketStage(intent: CaseTicketStageIntent, observed: Readonly<{ stage: string | null; ownerId: string | null }> | undefined, v2OwnerId: string): "confirmed" | "not_applied" | "unreadable" {
  if (!observed) return "unreadable";
  return observed.stage === intent.stageId && observed.ownerId === v2OwnerId ? "confirmed" : "not_applied";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Automatic reply approval for the access family (no systematic human validation inside the qualified scope)
// ---------------------------------------------------------------------------------------------------------------------------------

export const ACCESS_AUTO_APPROVAL_BASIS = "auto_access.v1";
export type AccessAutoApprovalConfig = Readonly<{ mode: "off"; why: "disabled" | "approver_invalid" }> | Readonly<{ mode: "on"; approverId: string }>;
/** Only `SAV_V2_AUTO_REPLY=access` enables it, with a dedicated approver id (a UUID that stands for the rule, never a person's). */
export function readAccessAutoApprovalConfig(env: Readonly<Record<string, string | undefined>>): AccessAutoApprovalConfig {
  if (env.SAV_V2_AUTO_REPLY !== "access") return { mode: "off", why: "disabled" };
  const approverId = env.SAV_V2_AUTO_APPROVER_ID ?? "";
  return UUID.test(approverId) ? { mode: "on", approverId: approverId.toLowerCase() } : { mode: "off", why: "approver_invalid" };
}

export type AccessAutoApprovalFacts = Readonly<{
  case: Readonly<{ owner: CaseOwner; sensitivity: CaseSensitivity; admitted: boolean }>;
  /** Families of the case's OPEN requests. */
  openFamilies: readonly string[];
  /** B's latest decision on the version the reply was proposed at: accepted, its access scope stamp current, every source shown to the customer verified. */
  decision: Readonly<{ accepted: boolean; scopeCurrent: boolean; shownSourcesVerified: boolean; nextAction: string }> | null;
  ownerNow: CustomerReturnOwnerNow;
}>;
export type AccessAutoApprovalOutcome = Readonly<{ allowed: true; basis: typeof ACCESS_AUTO_APPROVAL_BASIS }> | Readonly<{ allowed: false; reason: string }>;

/** The rule that stands in for a person's approval, and only for this: an access-only, admitted agent case whose reply rests on B's accepted, sourced decision.
 * Anything else (another family, a mixed case, a handoff, an unverified source, an owner not V2) goes to a person, as today. It approves; it never revokes or declines. */
export function decideAccessAutoApproval(input: Readonly<{ config: AccessAutoApprovalConfig; action: string; approverId: string; purpose: string; facts: AccessAutoApprovalFacts | null }>): AccessAutoApprovalOutcome {
  const { config, facts } = input;
  if (config.mode !== "on") return { allowed: false, reason: `auto_${config.why}` };
  if (input.action !== "approve") return { allowed: false, reason: "action_not_auto" };
  if (input.approverId.toLowerCase() !== config.approverId) return { allowed: false, reason: "approver_not_rule" };
  if (!["answer", "question", "reminder"].includes(input.purpose)) return { allowed: false, reason: "purpose_not_auto" };
  if (!facts) return { allowed: false, reason: "facts_unread" };
  if (facts.case.owner !== "agent" || !facts.case.admitted) return { allowed: false, reason: "case_not_admitted" };
  if (facts.case.sensitivity !== "none") return { allowed: false, reason: "sensitive" };
  if (!facts.openFamilies.length || facts.openFamilies.some(family => family !== "access")) return { allowed: false, reason: "not_access_only" };
  if (input.purpose !== "reminder") {
    if (!facts.decision?.accepted) return { allowed: false, reason: "decision_not_accepted" };
    if (!["answer", "ask"].includes(facts.decision.nextAction)) return { allowed: false, reason: "decision_not_reply" };
    if (!facts.decision.scopeCurrent) return { allowed: false, reason: "scope_not_current" };
    if (!facts.decision.shownSourcesVerified) return { allowed: false, reason: "sources_unverified" };
  }
  if (facts.ownerNow !== "v2") return { allowed: false, reason: facts.ownerNow === "unknown" ? "owner_unread" : "owner_not_v2" };
  return { allowed: true, basis: ACCESS_AUTO_APPROVAL_BASIS };
}
