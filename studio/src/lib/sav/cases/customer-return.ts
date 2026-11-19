import { closingHandoffReplyEnabled, isTerminalReply } from "./case-terminal-reply";
// V2 customer return (LOCAL, OFF): the PURE part of the joint between a new customer mail and the V2 case it may continue. No database, clock, network or model.
//   route     which path a new inbound mail takes: continue the SAME case, reopen it (same incident still present), normal admission (new subject, no or
//             ambiguous link), keep it closed (a thanks or an automatic reply), leave it to the person or the team who owns it, or wait (owner unread, pause)
//   stages    after a CONFIRMED V2 reply the ticket waits for the customer; after a PROVEN resolution it is closed. Intents, keys and the gate only: the HubSpot
//             stage ids are injected (never guessed) and nothing here sends; an engaged write is verified, never sent again
// Nothing here classifies a mail: the facts are the stored link, V1's own confirmed records and the owner read now. A mail that needs judging goes to B
// (an open case, with its context) or to V1's normal intake (a closed case, a new subject), never to a keyword.
import type { CaseEffectLedgerState } from "./case-effects";
import { SAV_CASE_ACCESS_BLOCK_ID, type CaseOwner, type CasePhase, type CaseSensitivity } from "./case-types";
import { autoBlockProblem, readAutoReplyConfig, type AutoReplyConfig, type SavAutoOpenBlock } from "./block-auto-reply";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";

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

/** SAV-92 (Ugo 17/11): « handoff » = the V2 hand-over gives the ticket back to the team: stage « Nouveau » (V1's new stage) and NO owner. */
export type CaseTicketStageTarget = "waiting_customer" | "closed" | "handoff";
/** SAV-92 (Ugo 17/11): the hand-over stage has its own switch (exact `on`), on top of `SAV_V2_TICKET_STAGES=on`. Off: nothing differs from before. */
export const caseHandoffStageEnabled = (env: Readonly<Record<string, string | undefined>>) => env.SAV_V2_HANDOFF_STAGE === "on";
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
  | Readonly<{ kind: "resolution_recorded"; cycle: number }>
  | Readonly<{ kind: "j2_confirmed"; replyKey: string; sentAt: string; cycle: number; caseVersion: number }>
  /** SAV-92 (17/11): the V2 hand-over recorded at `caseVersion` (its `owner_changed` event): one « Nouveau, no owner » per hand-over. */
  | Readonly<{ kind: "handoff_recorded"; caseVersion: number }>;
export type CaseTicketStagePlanInput = Readonly<{
  config: CaseTicketStageConfig;
  caseId: string;
  ticketId: string;
  case: Readonly<{ owner: CaseOwner; phase: CasePhase; sensitivity: CaseSensitivity; cycle: Readonly<{ number: number; endedBy?: "resolved" | "closed_no_reply" | "handoff" }>;
    /** SAV-92: a request of the case is the team's (handed off by the entry): the team works the ticket too, V2 moves no stage. Absent: none. */
    teamPartPending?: boolean;
    /** SAV-92 (17/11): the version of the V2 hand-over still in force (the case with the team, nobody took it yet). Absent: none. */
    handoffVersion?: number }>;
  trigger: CaseTicketStageTrigger;
  /** SAV-92 (17/11): `SAV_V2_HANDOFF_STAGE=on`. Read only for a hand-over trigger. */
  handoffStage?: boolean;
  /** Date of the latest customer mail of the case, if any: one received after the reply makes « attente client » stale. */
  lastCustomerInboundAt: string | null;
}>;
export type CaseTicketStageIntent = Readonly<{ key: string; target: CaseTicketStageTarget; stageId: string; ticketId: string; caseId: string }>;
export type CaseTicketStagePlan = Readonly<{ plan: true; intent: CaseTicketStageIntent }> | Readonly<{ plan: false; reason: string }>;

export function planCaseTicketStage(input: CaseTicketStagePlanInput): CaseTicketStagePlan {
  const { config, trigger } = input, current = input.case;
  if (config.mode !== "on") return { plan: false, reason: `stages_${config.why}` };
  // SAV-92 (Ugo 17/11): the hand-over gives the ticket to the team, sensitive or not (a sensitive topic sends no message, the ticket still goes back), for the hand-over
  // still in force only (nobody took the case since). The team's ticket is the point here, so neither the agent's ownership nor the team part is asked.
  if (trigger.kind === "handoff_recorded") {
    if (!input.handoffStage) return { plan: false, reason: "handoff_stage_off" };
    if (current.owner !== "human" || current.phase !== "handoff_pending" || current.handoffVersion !== trigger.caseVersion) return { plan: false, reason: "handoff_not_current" };
    return { plan: true, intent: { key: caseTicketStageKey(input.caseId, "handoff", `handoff-v${trigger.caseVersion}`), target: "handoff", stageId: SAV_HUBSPOT_SUPPORT.stages.new, ticketId: input.ticketId, caseId: input.caseId } };
  }
  // A person's or the team's ticket is never moved by V2, whatever its stage.
  if (current.owner !== "agent") return { plan: false, reason: "owner_not_agent" };
  if (current.sensitivity !== "none") return { plan: false, reason: "sensitive" };
  // SAV-92: neither « attente client » nor « fermé » while the team still has its part of the customer's message on this ticket.
  if (current.teamPartPending) return { plan: false, reason: "team_part_pending" };
  if (trigger.kind === "reply_confirmed") {
    if (current.phase === "resolved") return { plan: false, reason: "case_resolved" };
    if (!Number.isFinite(Date.parse(trigger.sentAt))) return { plan: false, reason: "sent_at_invalid" };
    if (input.lastCustomerInboundAt && Date.parse(input.lastCustomerInboundAt) > Date.parse(trigger.sentAt)) return { plan: false, reason: "customer_replied_since" };
    return { plan: true, intent: { key: caseTicketStageKey(input.caseId, "waiting_customer", trigger.replyKey), target: "waiting_customer", stageId: config.waitingCustomer, ticketId: input.ticketId, caseId: input.caseId } };
  }
  if (trigger.kind === "j2_confirmed") {
    if (current.phase !== "closed_no_reply" || current.cycle.endedBy !== "closed_no_reply" || current.cycle.number !== trigger.cycle) return { plan: false, reason: "j2_closure_stale" };
    if (!Number.isFinite(Date.parse(trigger.sentAt))) return { plan: false, reason: "sent_at_invalid" };
    if (input.lastCustomerInboundAt && Date.parse(input.lastCustomerInboundAt) > Date.parse(trigger.sentAt)) return { plan: false, reason: "customer_replied_since" };
    return { plan: true, intent: { key: caseTicketStageKey(input.caseId, "closed", trigger.replyKey), target: "closed", stageId: config.closed, ticketId: input.ticketId, caseId: input.caseId } };
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
  // SAV-92 (17/11): a hand-over is confirmed by « Nouveau » AND no owner (the V2 owner it was written from is precisely what must be gone).
  if (intent.target === "handoff") return observed.stage === intent.stageId && observed.ownerId === null ? "confirmed" : "not_applied";
  return observed.stage === intent.stageId && observed.ownerId === v2OwnerId ? "confirmed" : "not_applied";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Automatic reply approval (no systematic human validation inside the qualified scope): the allow-list of blocks (`block-auto-reply.ts`)
// ---------------------------------------------------------------------------------------------------------------------------------

/** The persisted basis of a rule approval. It names the RULE (an allow-listed automatic approval), never a block: the case says which block it was,
 * and every reader of the basis (the AI mention, the Studio wording) keeps reading this one value, exactly as before. */
export const ACCESS_AUTO_APPROVAL_BASIS = "auto_access.v1";
export const SAV_AUTO_APPROVAL_BASIS = ACCESS_AUTO_APPROVAL_BASIS;
export type AccessAutoApprovalConfig = Readonly<{ mode: "off"; why: "disabled" | "approver_invalid" }> | Readonly<{ mode: "on"; approverId: string }>;
/**
 * Access's own view of the allow-list, same shape as before: `on` only when `access` is listed (with the rule approver), so a list without Access
 * never turns on an Access-only path (the threadless first mail). With `SAV_V2_AUTO_REPLY=access` it reads exactly as it always did.
 */
export function readAccessAutoApprovalConfig(env: Readonly<Record<string, string | undefined>>): AccessAutoApprovalConfig {
  const config = readAutoReplyConfig(env);
  if (!config.blocks.has(SAV_CASE_ACCESS_BLOCK_ID)) return { mode: "off", why: "disabled" };
  return config.mode === "on" ? { mode: "on", approverId: config.approverId } : { mode: "off", why: config.why };
}

export type AccessAutoApprovalFacts = Readonly<{
  case: Readonly<{ owner: CaseOwner; sensitivity: CaseSensitivity; admitted: boolean }>;
  /** Families of the case's OPEN requests. */
  openFamilies: readonly string[];
  /** Each open request's family and block (`caseRequestBlockId`), same rows as `openFamilies`. Read only when the allow-list is more than `access`:
   * absent there, the blocks are unknown and nothing is approved. */
  openBlocks?: readonly SavAutoOpenBlock[];
  /** B's latest decision on the version the reply was proposed at: accepted, its access scope stamp current, every source shown to the customer verified. */
  decision: Readonly<{ accepted: boolean; scopeCurrent: boolean; shownSourcesVerified: boolean; nextAction: string }> | null;
  ownerNow: CustomerReturnOwnerNow;
}>;
export type AutoApprovalFacts = AccessAutoApprovalFacts;
export type AccessAutoApprovalOutcome = Readonly<{ allowed: true; basis: typeof ACCESS_AUTO_APPROVAL_BASIS }> | Readonly<{ allowed: false; reason: string }>;

/** An Access-shaped config (`readAccessAutoApprovalConfig`) is the list `access` alone: the legacy reading, unchanged. */
const asAutoReplyConfig = (config: AutoReplyConfig | AccessAutoApprovalConfig): AutoReplyConfig => "blocks" in config ? config
  : config.mode === "on" ? { mode: "on", approverId: config.approverId, blocks: new Set([SAV_CASE_ACCESS_BLOCK_ID]), pairs: new Set(), ignored: [] }
  : { mode: "off", why: config.why, blocks: new Set(config.why === "approver_invalid" ? [SAV_CASE_ACCESS_BLOCK_ID] : []), pairs: new Set(), ignored: [] };

/** The rule that stands in for a person's approval, and only for this: an admitted agent case of ONE allow-listed block (or a qualified pair) whose reply rests
 * on B's accepted, sourced decision. Terminal acknowledgements also require their dedicated switch. Anything else (a block not listed, a mixed case, an unverified
 * source, an owner not V2) goes to a person, as today. It approves; it never revokes or declines. With the list `access` alone: exactly the former Access rule. */
export function decideAutoApproval(input: Readonly<{ config: AutoReplyConfig | AccessAutoApprovalConfig; action: string; approverId: string; purpose: string; env?: Readonly<Record<string, string | undefined>>; facts: AccessAutoApprovalFacts | null }>): AccessAutoApprovalOutcome {
  const config = asAutoReplyConfig(input.config), { facts } = input;
  if (config.mode !== "on") return { allowed: false, reason: `auto_${config.why}` };
  if (input.action !== "approve") return { allowed: false, reason: "action_not_auto" };
  if (input.approverId.toLowerCase() !== config.approverId) return { allowed: false, reason: "approver_not_rule" };
  const terminal = closingHandoffReplyEnabled(input.env ?? {}) && isTerminalReply(input.purpose);
  if (!["answer", "question", "reminder"].includes(input.purpose) && !terminal) return { allowed: false, reason: "purpose_not_auto" };
  if (!facts) return { allowed: false, reason: "facts_unread" };
  if (facts.case.owner !== "agent" || !facts.case.admitted) return { allowed: false, reason: "case_not_admitted" };
  if (facts.case.sensitivity !== "none") return { allowed: false, reason: "sensitive" };
  const blocked = autoBlockProblem(facts, config);
  if (blocked) return { allowed: false, reason: blocked };
  if (input.purpose !== "reminder") {
    if (!facts.decision?.accepted) return { allowed: false, reason: "decision_not_accepted" };
    const matches = terminal
      ? facts.decision.nextAction === (input.purpose === "closing" ? "confirm_resolution" : "handoff")
      : ["answer", "ask"].includes(facts.decision.nextAction);
    if (!matches) return { allowed: false, reason: "decision_not_reply" };
    if (!facts.decision.scopeCurrent) return { allowed: false, reason: "scope_not_current" };
    if (!facts.decision.shownSourcesVerified) return { allowed: false, reason: "sources_unverified" };
  }
  if (facts.ownerNow !== "v2") return { allowed: false, reason: facts.ownerNow === "unknown" ? "owner_unread" : "owner_not_v2" };
  return { allowed: true, basis: ACCESS_AUTO_APPROVAL_BASIS };
}
/** Former name, same function: callers written for Access keep compiling and deciding exactly as before. */
export const decideAccessAutoApproval = decideAutoApproval;
