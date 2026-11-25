// V2 human handoff notice (local, OFF): the PURE part. When V2 has taken a case, investigated it and its accepted decision is to hand the case to the team,
// the team gets ONE Slack notice per handoff, in one template for every kind of ticket. Nothing here reads, sends or writes: it decides WHETHER a stored case
// holds such a final decision (the only trigger), WHAT the notice says (from the stored decision and the CRM facts a caller verified, never from a mail),
// and the key, the marker and the intent the existing executor protocol dispatches and verifies.
//   trigger   the latest investigation record of the case holds an ACCEPTED decision whose next action is `handoff`, no newer input or person since
//   content   need, what was tried and how it ended, reason, next human action; contact and ticket links only when verified against the CRM
//   no alert  a resolved case, a question to the customer, a draft to validate, a refused or reviewed decision, an out-of-scope or withdrawn case, a retry in
//             progress: none of these is a handoff decision, so none has a trigger
// Free text is cut, stripped of e-mail addresses, links, long codes and Slack control characters, so a notice can neither copy a mail nor carry a secret.
import { createHash } from "node:crypto";
import { crmRecordUrl } from "../intake/crm-display";
import type { EffectIntent } from "../intake/execution-types";
import { caseRequestSearchText, caseTeamPartRequests, SAV_CASE_AGENT_REQUESTS_PER_MAIL, type CaseSnapshot, type CaseTrial } from "./case-types";
import { SAV_CASE_EFFECT_PERMISSIONS } from "./case-effects";
import { buildCaseHandoffSummary, caseHandoffSummaryLines, type CaseHandoffSummary } from "./case-handoff-summary";
import { caseTechnicalHandoffWait, investigationHandoffCommand, readCaseInvestigationProgress, SAV_CASE_INVESTIGATION_RECORD_KIND, type CaseInvestigationJournalEvent, type CaseTechnicalHandoffWait } from "./investigation-record";
import type { SAV_SMART_HANDOFF_REASONS } from "./smart/smart-contract";

export const HANDOFF_NOTICE_CONTRACT = "sav-v2-handoff-notice.v1";
export const HANDOFF_NOTICE_TITLE = "Nouveau ticket à transmettre à l'équipe";
/** The reply key of the case execution that hosts a notice, and the business key of its one effect. */
export const HANDOFF_NOTICE_KEY_PREFIX = "handoff-notice:";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_KEY = /^(in|back|ticket):[A-Za-z0-9._@<>=+-]{1,200}$/;
/** One notice per final handoff decision: the case and the input the decision answers. A new customer mail is a new input, hence a new decision and a new key. */
export function handoffNoticeKey(caseId: string, inputKey: string): string {
  if (!UUID.test(caseId) || !INPUT_KEY.test(inputKey)) throw new Error("SAV_HANDOFF_NOTICE_KEY_INVALID");
  return `${HANDOFF_NOTICE_KEY_PREFIX}${caseId.toLowerCase()}:${inputKey}`;
}
/** What the notice carries so a reader of the channel (and the verification) can tie the message to its key without the key itself. */
export const handoffNoticeMarker = (key: string) => `HO-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
// Not `\b`: the rendered marker sits between underscores (Slack italics), which are word characters.
const MARKER = /(?<![A-Za-z0-9])HO-[0-9a-f]{12}(?![A-Za-z0-9])/;
export const handoffNoticeMarkerIn = (text: string): string | null => MARKER.exec(text)?.[0] ?? null;

// ---------------------------------------------------------------------------------------------------------------------------------
// Configuration: injected, fail closed
// ---------------------------------------------------------------------------------------------------------------------------------

export type HandoffNoticeConfig =
  | Readonly<{ mode: "off"; why: "disabled" | "token_missing" | "channel_invalid" | "owner_invalid" | "portal_invalid" }>
  | Readonly<{ mode: "on"; channel: string; teamOwnerId: string | null; portalId: string | null; analysisEmoji?: string }>;
const SLACK_CHANNEL = /^C[A-Z0-9]{8,14}$/, NUMERIC = /^[0-9]{1,30}$/, SLACK_BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,200}$/;

/**
 * Only the exact string `on` enables the notice. The channel, the bot token, the team owner and the HubSpot portal are all injected (nothing is read from a file or
 * committed): a value that is present and malformed is a refusal (`off`), never a guess; the token itself is not returned, the Slack adapter reads it from the same env.
 */
export function readHandoffNoticeConfig(env: Readonly<Record<string, string | undefined>>): HandoffNoticeConfig {
  if (env.SAV_HANDOFF_NOTICE !== "on") return { mode: "off", why: "disabled" };
  if (!SLACK_BOT_TOKEN.test(env.SAV_HANDOFF_SLACK_BOT_TOKEN ?? "")) return { mode: "off", why: "token_missing" };
  if (!SLACK_CHANNEL.test(env.SAV_HANDOFF_SLACK_CHANNEL_ID ?? "")) return { mode: "off", why: "channel_invalid" };
  const owner = env.SAV_HANDOFF_TEAM_OWNER_ID, portal = env.HUBSPOT_PORTAL_ID;
  if (owner !== undefined && owner !== "" && !NUMERIC.test(owner)) return { mode: "off", why: "owner_invalid" };
  if (portal !== undefined && portal !== "" && !NUMERIC.test(portal)) return { mode: "off", why: "portal_invalid" };
  const emoji = env.SAV_HANDOFF_ANALYSIS_EMOJI ?? "mag";
  const analysisEmoji = env.SAV_HANDOFF_ANALYSIS_SIGNAL === "on" && /^[a-z0-9_+-]{1,40}$/.test(emoji) ? emoji : undefined;
  return { ...(analysisEmoji ? { analysisEmoji } : {}), mode: "on", channel: env.SAV_HANDOFF_SLACK_CHANNEL_ID!, teamOwnerId: owner ? owner : null, portalId: portal ? portal : null };
}

const SLACK_USER = /^[UW][A-Z0-9]{6,12}$/;
let warnedAboutHandoffSlackMentions = false;
/**
 * The people the notice pings, as one line of Slack mentions (`<@U…> <@U…>`), built ONLY from `SAV_HANDOFF_SLACK_MENTIONS` (comma-separated Slack user ids, injected
 * configuration): never from a mail, the CRM or the model. An entry that is not a strict user id is ignored (one warning per process). Unset, empty or nothing valid: "".
 */
export function handoffSlackMentionLine(env: Readonly<Record<string, string | undefined>>): string {
  const entries = (env.SAV_HANDOFF_SLACK_MENTIONS ?? "").split(",").map(entry => entry.trim()).filter(Boolean);
  const valid = entries.filter(entry => SLACK_USER.test(entry));
  if (valid.length !== entries.length && !warnedAboutHandoffSlackMentions) {
    warnedAboutHandoffSlackMentions = true;
    console.warn("SAV_HANDOFF_SLACK_MENTIONS holds invalid Slack user ids; they are ignored", { ignored: entries.length - valid.length });
  }
  return [...new Set(valid)].map(id => `<@${id}>`).join(" ");
}
/**
 * The text that leaves for Slack: the mention line on top of the notice, added AFTER the last look (`scrubHandoffNoticeText`), which still strips every mention the
 * sealed text could carry. Not sealed in the intent: the ledger row stays the same with or without mentions, and the verification ties the message by its marker only.
 */
export function withHandoffSlackMentions(text: string, env: Readonly<Record<string, string | undefined>>): string {
  const line = handoffSlackMentionLine(env);
  return line ? `${line}\n${text}` : text;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------------------------------------------------------------

export const HANDOFF_REASONS = ["explicit_human_request", "sensitive_request", "knowledge_missing", "knowledge_conflict", "evidence_inaccessible", "diagnosis_out_of_tools", "repeated_failure",
  // Ugo (14/11): not a model reason. The store hands the case over itself when the validator refused the decision of an input twice (`refusalHandoff`).
  "decision_refused",
  // SAV-92 (Ugo 14/11): not a model reason either. Part of a multi-request mail that no active block covers: the agent keeps the other requests and its one
  // reply says this part was passed on; the team is told exactly which part is theirs. The case is not transferred.
  "outside_active_blocks",
  // SAV-92 review (counter-review of 66e648a): not a model reason. The team part of a mail could not be noticed until the wait's bound, so the agent sent
  // nothing and the WHOLE mail went to the team (`case-team-part-wait.ts`); its notice says so in fixed words, never the partial "team part" text.
  "team_part_handoff_unavailable",
  // SAV-99 (Ugo 19/11): not a model reason. A person gave the ticket to the agent, which did not take it (outside its blocks, sensitive, unreadable,
  // contact not found, ambiguous thread...): the case was born with the team, the ticket goes back to « Nouveau » with no owner, and no mail was sent.
  "agent_not_taken",
  // Ugo (25/11): not model reasons. A technical dead end of the investigation (`SAV_CASE_TECHNICAL_HANDOFF_WAITS`, investigation-record.ts): the store gives the
  // case to the team, no mail sent. Written out, not spread: `technicalHandoffTrigger` only compiles while every dead end is one of these reasons.
  "technical_exhausted", "context_invalid", "knowledge_request_invalid"] as const;
export type HandoffReason = typeof HANDOFF_REASONS[number];
export const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  explicit_human_request: "le client demande à parler à une personne",
  sensitive_request: "demande sensible, réservée à l'équipe",
  knowledge_missing: "aucune fiche de connaissance ne couvre la demande",
  knowledge_conflict: "des fiches de connaissance se contredisent",
  evidence_inaccessible: "un élément nécessaire au diagnostic n'est pas accessible à l'agent",
  diagnosis_out_of_tools: "le diagnostic dépasse les outils de l'agent",
  agent_not_taken: "ticket attribué à l'agent, qui ne l'a pas pris en charge",
  repeated_failure: "les essais de l'agent ont échoué à répétition",
  decision_refused: "le validateur a refusé deux fois la décision de l'agent pour ce message",
  outside_active_blocks: "cette partie du message est laissée à l'équipe : aucun bloc actif de l'agent ne la couvre, ou elle dépasse la limite de demandes d'une réponse",
  team_part_handoff_unavailable: "la partie équipe du message n'a pas pu être signalée à temps : le mail entier revient à l'équipe",
  technical_exhausted: "panne technique, les appels permis de l'agent sont épuisés (code technical_exhausted)",
  context_invalid: "panne technique, le dossier n'a pas pu être préparé pour l'agent (code context_invalid)",
  knowledge_request_invalid: "panne technique, la recherche de connaissances a été refusée avant tout appel (code knowledge_request_invalid)",
};
/** SAV-92: the fixed next human action of a team part. The agent keeps the rest of the case. */
export const HANDOFF_TEAM_PART_INTERVENTION = "Reprendre uniquement la partie ci-dessus. L'agent V2 garde les autres demandes du même message ; sa réponse au client indique que cette partie est transmise à l'équipe.";
/** The fixed next human action after the bound of a team-part wait: the agent sent nothing, the team takes the whole mail. */
export const HANDOFF_WHOLE_MAIL_INTERVENTION = "Mail entier à reprendre, aucune réponse envoyée : l'agent n'a rien répondu au client. Reprendre toutes les demandes du message.";
/** The fixed next human action of a technical dead end: never an error message. */
export const HANDOFF_TECHNICAL_INTERVENTION = "Reprendre le message et répondre au client : rien ne lui a été envoyé par l'agent. Signaler la panne à l'équipe technique.";
/** The fixed next human action of a refused decision: never model text. */
export const HANDOFF_REFUSED_INTERVENTION = "Reprendre le dossier : vérifier les faits constatés et la demande, puis répondre au client. Aucune réponse n'a été envoyée par l'agent.";

export type HandoffTriggerRefusal = "no_record" | "no_decision" | "not_handoff" | "not_accepted" | "stale_input" | "taken_by_person";
export type HandoffNoticeTrigger = Readonly<{
  ok: true; caseId: string; ticketId: string; inputKey: string;
  /** Case version of the event that persisted the decision: whatever happens to the case after it makes the decision stale. */
  recordedAtVersion: number; reason: HandoffReason;
  report: Readonly<{ need: string; expected: string | null; observed: string | null; trialIds: readonly string[]; hypotheses: readonly string[]; missingInformation: readonly string[]; expectedIntervention: string }>;
}> | Readonly<{ ok: false; why: HandoffTriggerRefusal }>;

/** The handoff a twice-refused decision stands for: requests, observed facts and trials as stored, refusal labels as written by our validator. */
function refusedHandoffAction(snapshot: Pick<CaseSnapshot, "body">, rejections: ReadonlyArray<{ label: string }>) {
  const open = snapshot.body.openRequests.filter(row => row.status === "open");
  const need = open.map(row => caseRequestSearchText(row) ?? row.summary).join(" ; ") || "non précisé";
  const observed = snapshot.body.facts.filter(fact => fact.kind === "observed").slice(-3).map(fact => fact.text).join(" ; ") || null;
  return { kind: "handoff" as const, reason: "decision_refused" as const, report: { need, expected: null, observed,
    trialIds: snapshot.body.trials.map(trial => trial.id), hypotheses: [] as string[],
    // Rendered as « Motifs des refus » for this reason (renderHandoffNotice).
    missingInformation: [...new Set(rejections.map(row => row.label))].slice(0, 5), expectedIntervention: HANDOFF_REFUSED_INTERVENTION } };
}

/**
 * SAV-92: the team's part of a mail as a handoff report: which requests, in their searchable words (never the mail itself), and our fixed intervention.
 * `recorded` (review of batch 2, finding 1): the ids the decision recorded; without them (a record written before), the parts of the admission in force.
 */
function teamPartHandoffAction(snapshot: Pick<CaseSnapshot, "body"> & Partial<Pick<CaseSnapshot, "admission">>, recorded?: readonly string[]) {
  const parts = recorded ? snapshot.body.openRequests.filter(row => row.status === "handed_off" && recorded.includes(row.id))
    : caseTeamPartRequests({ admission: snapshot.admission ?? null, body: snapshot.body });
  if (!parts.length) return null;
  // Counter-review n°2: a part left for the request limit is covered by a block; the team reads why it is theirs.
  const overLimit = new Set((snapshot.admission?.qualification.requests ?? []).filter(row => row.provenance.kind === "team_part" && row.provenance.reason === "request_limit").map(row => row.requestId));
  const quoted = (row: typeof parts[number]) => { const text = caseRequestSearchText(row); return text ? `« ${text} »` : "demande non décrite, voir le mail du client"; };
  const described = parts.map(row => overLimit.has(row.id) ? `${quoted(row)} (couverte par un bloc, mais au-delà de ${SAV_CASE_AGENT_REQUESTS_PER_MAIL} demandes par réponse)` : quoted(row));
  const need = `Partie du message à reprendre par l'équipe (${parts.length} demande${parts.length > 1 ? "s" : ""}) : ${described.join(" ; ")}`;
  return { kind: "handoff" as const, reason: "outside_active_blocks" as const, report: { need, expected: null, observed: null, trialIds: [] as string[], hypotheses: [] as string[],
    missingInformation: [] as string[], expectedIntervention: HANDOFF_TEAM_PART_INTERVENTION } };
}

/** The reason of the transfer at the bound of a team-part wait (`SAV_CASE_TEAM_PART_WAIT_CODE` in case-team-part-wait.ts, a server-only module). */
const TEAM_PART_WAIT_HANDOFF_REASON = "team_part_handoff_unavailable";
/**
 * SAV-92 review P2-4: the decision recorded at `version` never reached the customer: its team part could not be noticed, and at the bound of that wait the
 * WHOLE mail was handed to the team (owner_changed `handoff`, reason above). Its "team part" notice would say the agent replied and keeps the rest: false.
 */
export function teamPartWaitHandedOff(events: readonly CaseInvestigationJournalEvent[], version: number) {
  return teamPartWaitTransfer(events, version) !== undefined;
}
/**
 * Counter-review n°2 (dfd02e0): the bound's transfer belongs to the decision at `version` only if no newer decision was recorded between the two (any
 * `observation_recorded` is a newer input). Otherwise it is the bound of a LATER mail: this decision's reply did leave, its partial notice stays true.
 * The send fence (case-handoff-notice-store.ts) applies the same condition.
 */
const teamPartWaitTransfer = (events: readonly CaseInvestigationJournalEvent[], version: number) => events.filter(event => event.kind === "owner_changed" && event.caseVersion > version
  && event.detail?.transition === "handoff" && event.detail.reason === TEAM_PART_WAIT_HANDOFF_REASON
  && !events.some(other => other.kind === "observation_recorded" && other.caseVersion > version && other.caseVersion < event.caseVersion))
  .sort((a, b) => a.caseVersion - b.caseVersion)[0];
/** Its own key, never the partial notice's (that key may already hold a queued partial notice, which the send fence then cancels). */
const wholeMailInputKey = (inputKey: string) => `${inputKey}+whole-mail`;

/**
 * Counter-review of 66e648a: at the bound of the team-part wait, the notice of the decision recorded at `version` becomes ONE fixed-text notice "whole mail,
 * no reply sent", keyed on its input. Dated at the transfer: what follows it like any durable transfer (a person's command, another owner change) makes it stale;
 * a customer follow-up does not (it belongs to the human case). A person who took the case cancels it.
 */
function wholeMailNoticeTrigger(snapshot: Pick<CaseSnapshot, "caseId" | "ticketId" | "body">, events: readonly CaseInvestigationJournalEvent[], inputKey: string, version: number):
  Extract<HandoffNoticeTrigger, { ok: true }> | Extract<HandoffNoticeTrigger, { ok: false }> | null {
  const transfer = teamPartWaitTransfer(events, version);
  if (!transfer) return null;
  if (snapshot.body.handoff?.humanSince) return { ok: false, why: "taken_by_person" };
  const reason = "team_part_handoff_unavailable" as const, key = wholeMailInputKey(inputKey);
  if (!INPUT_KEY.test(key)) return { ok: false, why: "no_record" };
  const stale = staleHandoffEventKinds(true, reason);
  if (events.some(event => event.caseVersion > transfer.caseVersion && stale.includes(event.kind))) return { ok: false, why: "stale_input" };
  const requests = snapshot.body.openRequests.filter(row => row.status !== "resolved");
  const described = requests.map(row => caseRequestSearchText(row));
  const need = `Mail entier à reprendre (${requests.length} demande${requests.length > 1 ? "s" : ""}), aucune réponse envoyée : ${described.map(text => text ? `« ${text} »` : "demande non décrite, voir le mail du client").join(" ; ") || "voir le mail du client"}`;
  return { ok: true, caseId: snapshot.caseId, ticketId: snapshot.ticketId, inputKey: key, recordedAtVersion: transfer.caseVersion, reason,
    report: { need, expected: null, observed: null, trialIds: [], hypotheses: [], missingInformation: [], expectedIntervention: HANDOFF_WHOLE_MAIL_INTERVENTION } };
}

/** Events after the decision that make it no longer the final word: a newer customer mail, a newer investigation, a person's command, an owner change. */
export function staleHandoffEventKinds(transferred: boolean, reason?: HandoffReason) {
  // SAV-92 (review of batch 2, finding 1): the customer was told this part went to the team. Nothing after the decision (a reply of the customer, a new
  // investigation, a re-admission) makes that promise void: only a person taking the case cancels the notice (`taken_by_person`, checked on its own).
  if (reason === "outside_active_blocks") return [];
  // The whole mail went to the team by the wait's own transfer: a customer follow-up belongs to that human case, as after any durable transfer.
  if (reason === "team_part_handoff_unavailable") transferred = true;
  const kinds = ["observation_recorded", "human_command", "owner_changed"];
  // A customer follow-up belongs to the pending human case after durable transfer.
  if (!transferred) kinds.push("inbound_confirmed");
  return kinds;
}

export function awaitingHandoff(snapshot: Pick<CaseSnapshot, "owner" | "phase" | "body">, reason: HandoffReason) {
  return snapshot.owner === "human" && snapshot.phase === "handoff_pending" && snapshot.body.handoff?.reason === reason && !snapshot.body.handoff.humanSince;
}

/**
 * The ONE trigger. The latest investigation record of the case must hold a decision that passed the validator (`accepted`: not one sent to review, not a refusal) whose
 * next action is a handoff, persisted by the claim that took the case; and nothing may have happened to the case since (a newer mail or investigation re-opens the
 * question, a person already took it). A case a person had from the start, one never taken by V2 and one out of scope have no investigation record, hence no trigger.
 */
export function handoffNoticeTrigger(snapshot: Pick<CaseSnapshot, "caseId" | "ticketId" | "body" | "owner" | "phase"> & Partial<Pick<CaseSnapshot, "admission">>, events: readonly CaseInvestigationJournalEvent[]): HandoffNoticeTrigger {
  const latest = events.filter(event => event.kind === "observation_recorded" && (event.detail?.record as { kind?: unknown } | undefined)?.kind === SAV_CASE_INVESTIGATION_RECORD_KIND)
    .sort((a, b) => b.caseVersion - a.caseVersion)[0];
  const inputKey = (latest?.detail?.record as { inputKey?: unknown } | undefined)?.inputKey;
  if (!latest || typeof inputKey !== "string") return { ok: false, why: "no_record" };
  const read = readCaseInvestigationProgress(events, inputKey);
  if (read.state !== "found" || read.caseVersion !== latest.caseVersion) return { ok: false, why: "no_record" };
  const decision = read.record.decision;
  if (!decision) return technicalHandoffTrigger(snapshot, events, inputKey, read.caseVersion, caseTechnicalHandoffWait(read.record.progress));
  // Ugo (14/11): a decision the validator refused twice is handed over like an accepted handoff, with a report built from the STORED case (verified
  // facts, trials, requests) and our own fixed refusal labels; never from the refused model output.
  const refused = decision.validation.outcome === "needs_review" && decision.refusalHandoff?.reason === "decision_refused" ? decision.validation : null;
  if (decision.validation.outcome !== "accepted" && !refused) return { ok: false, why: "not_accepted" };
  const decided = refused ? refusedHandoffAction(snapshot, refused.rejections) : decision.validation.outcome === "accepted" ? decision.validation.decision.nextAction : null;
  // SAV-92: an accepted decision that keeps the case (an answer, a question...) still owes the team the part of the mail no active block covers: one notice per input,
  // the same key, fence and channel as a handoff, with nothing transferred. A handoff or a refusal already gives the whole case to the team.
  const action = decided && decided.kind !== "handoff" ? teamPartHandoffAction(snapshot, decision.teamParts) : decided;
  if (!action || action.kind !== "handoff") return { ok: false, why: "not_handoff" };
  if (snapshot.body.handoff?.humanSince) return { ok: false, why: "taken_by_person" };
  // Review P2-4 and its counter-review: the whole mail went to the team at the bound of the team-part wait. Never the partial text saying the agent replied:
  // the fixed "whole mail, no reply sent" notice instead.
  if (latest.detail?.applied === false) return { ok: false, why: "stale_input" };
  if (action.reason === "outside_active_blocks") { const whole = wholeMailNoticeTrigger(snapshot, events, inputKey, read.caseVersion); if (whole) return whole; }
  // Only a matching, committed transfer lets new mail wait for the human team.
  const transferred = events.find(event => event.caseVersion === read.caseVersion + 1 && event.kind === "owner_changed"
    && event.dedupeKey === "cmd:" + investigationHandoffCommand(read.caseVersion)
    && event.detail?.transition === "handoff" && event.detail.reason === action.reason);
  const recordedAtVersion = transferred?.caseVersion ?? read.caseVersion;
  const staleKinds = staleHandoffEventKinds(Boolean(transferred) && awaitingHandoff(snapshot, action.reason), action.reason);
  if (events.some(event => event.caseVersion > recordedAtVersion && staleKinds.includes(event.kind))) return { ok: false, why: "stale_input" };
  if (!INPUT_KEY.test(inputKey)) return { ok: false, why: "no_record" };
  const { report } = action;
  return { ok: true, caseId: snapshot.caseId, ticketId: snapshot.ticketId, inputKey, recordedAtVersion, reason: action.reason,
    report: { need: report.need, expected: report.expected, observed: report.observed, trialIds: report.trialIds, hypotheses: report.hypotheses,
      missingInformation: report.missingInformation, expectedIntervention: report.expectedIntervention } };
}

/**
 * Ugo (25/11): the notice of a technical dead end. No decision was recorded, so the trigger is the store's own committed transfer right after the record (same
 * command key as a decision's transfer, the wait code as reason), the case still waiting for the team. The report is the stored requests and our fixed words only:
 * never a diagnostic or an error message. Without that transfer (a record written before this rule, a person since): no notice.
 */
function technicalHandoffTrigger(snapshot: Pick<CaseSnapshot, "caseId" | "ticketId" | "body" | "owner" | "phase">, events: readonly CaseInvestigationJournalEvent[], inputKey: string,
  recordedVersion: number, reason: CaseTechnicalHandoffWait | null): HandoffNoticeTrigger {
  if (!reason) return { ok: false, why: "no_decision" };
  if (snapshot.body.handoff?.humanSince) return { ok: false, why: "taken_by_person" };
  const transferred = events.find(event => event.caseVersion === recordedVersion + 1 && event.kind === "owner_changed" && event.dedupeKey === "cmd:" + investigationHandoffCommand(recordedVersion)
    && event.detail?.transition === "handoff" && event.detail.reason === reason);
  if (!transferred || !awaitingHandoff(snapshot, reason)) return { ok: false, why: "no_decision" };
  const stale = staleHandoffEventKinds(true, reason);
  if (events.some(event => event.caseVersion > transferred.caseVersion && stale.includes(event.kind))) return { ok: false, why: "stale_input" };
  if (!INPUT_KEY.test(inputKey)) return { ok: false, why: "no_record" };
  const need = snapshot.body.openRequests.filter(row => row.status === "open").map(row => caseRequestSearchText(row) ?? row.summary).join(" ; ") || "voir le mail du client";
  return { ok: true, caseId: snapshot.caseId, ticketId: snapshot.ticketId, inputKey, recordedAtVersion: transferred.caseVersion, reason,
    report: { need, expected: null, observed: null, trialIds: [], hypotheses: [], missingInformation: [], expectedIntervention: HANDOFF_TECHNICAL_INTERVENTION } };
}

/** SAV-99: the fixed next human action of a ticket the agent did not take. */
export const HANDOFF_NOT_TAKEN_INTERVENTION = "Reprendre le ticket : il est remis en « Nouveau », sans propriétaire. Aucun mail n'a été envoyé au client par l'agent.";

/**
 * SAV-99 (Ugo 19/11): the notice of a ticket a person gave the agent and the agent did not take. Such a case is BORN with the team (`openCaseFromHubspotTicket`
 * with a wait reason): no investigation record, so `handoffNoticeTrigger` never fires for it. Its one input is the CRM observation that opened it (`ticket:<event>`);
 * a person who took it since, or any later input (mail, investigation, command, owner change), means there is nothing to notice any more.
 * `why`: the plain reason, from the stored reason code (`caseNotTakenWhy`), never the ticket's text.
 */
export function agentNotTakenNoticeTrigger(snapshot: Pick<CaseSnapshot, "caseId" | "ticketId" | "body" | "owner" | "phase" | "threadIds">, events: readonly (CaseInvestigationJournalEvent & { id?: string })[],
  why: (reason: string | undefined) => string): HandoffNoticeTrigger {
  const handoff = snapshot.body.handoff;
  if (snapshot.owner !== "human" || snapshot.phase !== "handoff_pending" || !handoff || snapshot.threadIds.length) return { ok: false, why: "not_handoff" };
  if (handoff.humanSince) return { ok: false, why: "taken_by_person" };
  const born = [...events].sort((a, b) => a.caseVersion - b.caseVersion).find(event => event.kind === "crm_observed");
  if (!born || typeof born.id !== "string" || events.some(event => event.kind !== "crm_observed")) return { ok: false, why: born ? "stale_input" : "no_record" };
  const inputKey = `ticket:${born.id}`;
  if (!INPUT_KEY.test(inputKey)) return { ok: false, why: "no_record" };
  return { ok: true, caseId: snapshot.caseId, ticketId: snapshot.ticketId, inputKey, recordedAtVersion: born.caseVersion, reason: "agent_not_taken",
    report: { need: `Ticket attribué à l'Agent SAV, non pris en charge : ${why(handoff.reason)}`, expected: null, observed: null, trialIds: [], hypotheses: [], missingInformation: [],
      expectedIntervention: HANDOFF_NOT_TAKEN_INTERVENTION } };
}

/**
 * SAV-92 (review of batch 2, finding 1): every team part the case still owes the team, one per input whose recorded decision (accepted, not a handoff)
 * left part of the mail to the team: not only the latest input. Each is keyed on ITS input (`handoffNoticeKey`), so the notice sweep recreates nothing twice
 * and admits one a crash or a later mail left behind. A person who took the case cancels them all (they have the whole case).
 */
export function teamPartNoticeTriggers(snapshot: Pick<CaseSnapshot, "caseId" | "ticketId" | "body" | "owner" | "phase"> & Partial<Pick<CaseSnapshot, "admission">>,
  events: readonly CaseInvestigationJournalEvent[]): Extract<HandoffNoticeTrigger, { ok: true }>[] {
  if (snapshot.body.handoff?.humanSince) return [];
  const inputs = [...new Set(events.flatMap(event => {
    const record = event.kind === "observation_recorded" ? event.detail?.record as { kind?: unknown; inputKey?: unknown } | undefined : undefined;
    return record?.kind === SAV_CASE_INVESTIGATION_RECORD_KIND && typeof record.inputKey === "string" && INPUT_KEY.test(record.inputKey) ? [record.inputKey] : [];
  }))];
  return inputs.flatMap(inputKey => {
    const read = readCaseInvestigationProgress(events, inputKey);
    if (read.state !== "found") return [];
    const decision = read.record.decision, recorded = events.find(event => event.kind === "observation_recorded" && event.caseVersion === read.caseVersion);
    if (!decision?.teamParts?.length || decision.validation.outcome !== "accepted" || decision.validation.decision.nextAction.kind === "handoff" || recorded?.detail?.applied === false) return [];
    // Review P2-4 and its counter-review: this input's reply never left and the whole mail went to the team at the wait's bound: the fixed whole-mail notice.
    const whole = wholeMailNoticeTrigger(snapshot, events, inputKey, read.caseVersion);
    if (whole) return whole.ok ? [whole] : [];
    const action = teamPartHandoffAction(snapshot, decision.teamParts);
    if (!action) return [];
    return [{ ok: true as const, caseId: snapshot.caseId, ticketId: snapshot.ticketId, inputKey, recordedAtVersion: read.caseVersion, reason: action.reason, report: { ...action.report } }];
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The content
// ---------------------------------------------------------------------------------------------------------------------------------

const NOTICE_LIMITS = { need: 400, line: 240, intervention: 400, hypotheses: 3, trials: 5, missing: 5, text: 3500 } as const;
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi;
// A long run of letters and digits mixing both is a code, a token or an identifier of a person's account, never a sentence.
const CODE = /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
const LONG_NUMBER = /\b(?:[0-9][ .]?){9,}[0-9]\b/g;
// A secret by its SHAPE (tokens of the providers we use or know, bearer headers, long hexadecimal, IBAN) or by its WORD (« le code est 718236 », « mot de passe : x », « token=abc »).
const SECRET_SHAPE = /\b(?:xox[abprs]-|xapp-|sk-|ghp_|gho_|github_pat_|AKIA|eyJ)[A-Za-z0-9._-]{6,}/g;
const BEARER = /\bBearer\s+\S+/gi;
const HEX = /\b(?=[0-9a-f]*[0-9])[0-9a-f]{24,}\b/gi;
const IBAN = /\b[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g;
const SECRET_WORD = "code|otp|pin|passcode|mot de passe|mots de passe|password|mdp|token|jeton|secret|cl[ée]";
const SECRET_GIVEN = new RegExp(`\\b(?:${SECRET_WORD})\\b(?:\\s+(?:de|d['’]|du|des)\\s*\\p{L}+)*\\s*(?:est|is|:|=)\\s*\\S+`, "giu");
const SECRET_NAMED = new RegExp(`\\b(?:${SECRET_WORD})\\b(?:\\s+(?:de|d['’]|du|des)\\s*\\p{L}+)*\\s+(?=\\S*[0-9])(?=\\S*\\p{L})[\\p{L}0-9-]{4,}`, "giu");
// Three digits or more in a row (a code, a phone number, a card, an account): never kept in free text. One or two digits (« 3 essais ») are.
const NUMBER = /(?<![\p{L}0-9])(?:[0-9][ .\-]?){2,}[0-9](?![\p{L}0-9])/gu;

/**
 * Free text of the decision (written by the model from the case) or of the CRM (a name), made safe for the channel: one line, no address, link, token, code, secret named
 * by its word, or number of three digits or more (a one-time code, a phone number, a card), nothing Slack would interpret (mentions, links, formatting), cut at `max`.
 * Whatever is removed is replaced by a neutral word, so a reader knows something was. Idempotent: a text already made safe comes out unchanged.
 */
export function sanitizeNoticeText(value: string, max: number = NOTICE_LIMITS.line): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(EMAIL, "[adresse masquée]").replace(LINK, "[lien masqué]").replace(SECRET_SHAPE, "[code masqué]").replace(BEARER, "[code masqué]")
    .replace(SECRET_GIVEN, "[code masqué]").replace(SECRET_NAMED, "[code masqué]").replace(HEX, "[code masqué]").replace(CODE, "[code masqué]")
    .replace(IBAN, "[numéro masqué]").replace(LONG_NUMBER, "[numéro masqué]").replace(NUMBER, "[numéro masqué]")
    .replace(/<[!@#][^>]*>/g, " ").replace(/&/g, "et").replace(/[<>]/g, " ").replace(/[*_~`|@#]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * The same cleaning applied to facts that were sealed BEFORE a rule existed (a historical execution): every free field is made safe again when the notice is rendered.
 * Structured fields (reason, trials by identifier and outcome, counts) are not free text and are untouched.
 */
export function resanitizeNoticeFacts(facts: HandoffNoticeFacts): HandoffNoticeFacts {
  const one = (value: string | null, max: number) => value === null ? null : sanitizeNoticeText(value, max) || null;
  return { ...facts, need: sanitizeNoticeText(facts.need, NOTICE_LIMITS.need), expected: one(facts.expected, NOTICE_LIMITS.line), observed: one(facts.observed, NOTICE_LIMITS.line),
    hypotheses: facts.hypotheses.map(item => sanitizeNoticeText(item)).filter(Boolean), missingInformation: facts.missingInformation.map(item => sanitizeNoticeText(item, 160)).filter(Boolean),
    expectedIntervention: sanitizeNoticeText(facts.expectedIntervention, NOTICE_LIMITS.intervention) };
}

const OUTCOME_LABELS: Record<CaseTrial["outcome"], string> = { pending: "en attente de retour du client", failed: "échec", succeeded: "réussie", unknown: "résultat inconnu" };
export type HandoffNoticeFacts = Readonly<{
  contract: typeof HANDOFF_NOTICE_CONTRACT; caseId: string; ticketId: string; inputKey: string; recordedAtVersion: number; reason: HandoffReason;
  need: string; expected: string | null; observed: string | null; hypotheses: readonly string[]; missingInformation: readonly string[]; expectedIntervention: string;
  trials: ReadonlyArray<Readonly<{ knowledgeId: string; outcome: CaseTrial["outcome"] }>>; questionsAsked: number;
  /** SAV-92: the synthesis of the stored case (`case-handoff-summary.ts`), masked and bounded. Absent from notices sealed before it existed. */
  summary?: CaseHandoffSummary;
  modelReason?: typeof SAV_SMART_HANDOFF_REASONS[number];
  conversationId?: string;
}>;

/** The synthesis never blocks a notice: a body it cannot read gives a notice without it (the template alone, as before SAV-92). */
function handoffSummaryOf(body: Parameters<typeof buildCaseHandoffSummary>[0], received?: Parameters<typeof buildCaseHandoffSummary>[1]): { summary?: CaseHandoffSummary } {
  try { return { summary: buildCaseHandoffSummary(body, received) }; } catch { return {}; }
}

/** The sealed facts of a notice: the decision's report, the trials it cites and the questions already asked, all taken from the stored case and already made safe. */
export function handoffNoticeFacts(trigger: Extract<HandoffNoticeTrigger, { ok: true }>, body: Pick<CaseSnapshot["body"], "trials" | "questions" | "facts" | "openRequests">,
  /** SAV-92 (15/11): files received on the case's stored mails (names masked), read by the caller; absent: not listed. */ received?: Parameters<typeof buildCaseHandoffSummary>[1]): HandoffNoticeFacts {
  const cited = new Set(trigger.report.trialIds);
  // A knowledge id is our own structured identifier, not free text: it is kept as is when it has the shape of one, and masked otherwise.
  const knowledgeId = (id: string) => /^[A-Za-z0-9._-]{1,80}$/.test(id) ? id : "[identifiant masqué]";
  const trials = body.trials.filter(trial => cited.has(trial.id)).map(trial => ({ knowledgeId: knowledgeId(trial.procedure.knowledgeId), outcome: trial.outcome }));
  const one = (value: string | null, max: number) => value === null ? null : sanitizeNoticeText(value, max) || null;
  return {
    contract: HANDOFF_NOTICE_CONTRACT, caseId: trigger.caseId, ticketId: trigger.ticketId, inputKey: trigger.inputKey, recordedAtVersion: trigger.recordedAtVersion, reason: trigger.reason,
    need: sanitizeNoticeText(trigger.report.need, NOTICE_LIMITS.need), expected: one(trigger.report.expected, NOTICE_LIMITS.line), observed: one(trigger.report.observed, NOTICE_LIMITS.line),
    hypotheses: trigger.report.hypotheses.slice(0, NOTICE_LIMITS.hypotheses).map(item => sanitizeNoticeText(item)).filter(Boolean),
    missingInformation: trigger.report.missingInformation.slice(0, NOTICE_LIMITS.missing).map(item => sanitizeNoticeText(item, 160)).filter(Boolean),
    expectedIntervention: sanitizeNoticeText(trigger.report.expectedIntervention, NOTICE_LIMITS.intervention),
    trials, questionsAsked: body.questions.length, ...handoffSummaryOf(body, received),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// CRM verification (the reading is the caller's; the judgement is here)
// ---------------------------------------------------------------------------------------------------------------------------------

/** What a read-only CRM reading of the case's ticket gave back: the ticket, and the contacts associated to it with the addresses they carry. */
export type HandoffCrmReading = Readonly<{
  ticket: Readonly<{ id: string; archived: boolean }> | null;
  contacts: ReadonlyArray<Readonly<{ id: string; firstname: string | null; lastname: string | null; emails: readonly string[]; archived: boolean }>>;
}>;
export type HandoffContactVerdict = Readonly<{ status: "verified"; id: string; name: string | null }> | Readonly<{ status: "unverified"; why: "ticket_not_found" | "no_matching_contact" | "several_matching_contacts" | "customer_address_unknown" }>;
export type HandoffTicketVerdict = Readonly<{ status: "verified"; id: string }> | Readonly<{ status: "unverified"; why: "ticket_not_found" }>;
export type HandoffCrmVerdict = Readonly<{ contact: HandoffContactVerdict; ticket: HandoffTicketVerdict }>;

const lower = (value: string) => value.trim().toLowerCase();
/**
 * A link is only shown for what the CRM confirmed: the ticket exists (not archived) under the case's own ticket id, and EXACTLY ONE contact associated to that ticket
 * carries the customer's address of the thread. A name or a company never creates the relation; several matches, none, or an unknown address leave the contact unverified.
 */
export function judgeHandoffCrm(reading: HandoffCrmReading, input: Readonly<{ ticketId: string; customerEmail: string | null }>): HandoffCrmVerdict {
  const ticketFound = reading.ticket !== null && reading.ticket.id === input.ticketId && !reading.ticket.archived;
  const ticket: HandoffTicketVerdict = ticketFound ? { status: "verified", id: input.ticketId } : { status: "unverified", why: "ticket_not_found" };
  if (!ticketFound) return { ticket, contact: { status: "unverified", why: "ticket_not_found" } };
  const address = input.customerEmail ? lower(input.customerEmail) : "";
  if (!address) return { ticket, contact: { status: "unverified", why: "customer_address_unknown" } };
  const matching = reading.contacts.filter(contact => !contact.archived && /^[0-9]{1,30}$/.test(contact.id) && contact.emails.some(email => lower(email) === address));
  if (matching.length === 0) return { ticket, contact: { status: "unverified", why: "no_matching_contact" } };
  if (matching.length > 1) return { ticket, contact: { status: "unverified", why: "several_matching_contacts" } };
  const [found] = matching;
  const name = sanitizeNoticeText([found!.firstname, found!.lastname].filter(Boolean).join(" "), 120);
  return { ticket, contact: { status: "verified", id: found!.id, name: name || null } };
}

const UNVERIFIED_LABELS: Record<Extract<HandoffContactVerdict, { status: "unverified" }>["why"], string> = {
  ticket_not_found: "ticket introuvable dans le CRM",
  no_matching_contact: "aucun contact du ticket ne porte l'adresse du client",
  several_matching_contacts: "plusieurs contacts du ticket portent l'adresse du client",
  customer_address_unknown: "adresse du client inconnue",
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------------------------------------------------------------

export type HandoffNoticeRender = Readonly<{ text: string; marker: string; key: string }>;

export const CONVERSATION_LINE_PREFIX = "*Conversation Limova :* ";

/** The notice, deterministic for its inputs: a verification compares the marker, never the text. */
export function renderHandoffNotice(sealed: HandoffNoticeFacts, crm: HandoffCrmVerdict, portalId: string | null, analysisSignal = false): HandoffNoticeRender {
  // Facts sealed under an older rule are cleaned again here: the text that leaves is never older than the rule.
  const facts = resanitizeNoticeFacts(sealed);
  const key = handoffNoticeKey(facts.caseId, facts.inputKey), marker = handoffNoticeMarker(key);
  const contactUrl = crm.contact.status === "verified" ? crmRecordUrl(portalId ?? undefined, "contact", crm.contact.id) : null;
  const ticketUrl = crm.ticket.status === "verified" ? crmRecordUrl(portalId ?? undefined, "ticket", crm.ticket.id) : null;
  const client = crm.contact.status === "verified"
    ? `${crm.contact.name ?? "Nom indisponible"} — ${contactUrl ? `<${contactUrl}|fiche contact HubSpot>` : "fiche contact vérifiée, lien indisponible (portail HubSpot non configuré)"}`
    : `contact non vérifié (${UNVERIFIED_LABELS[crm.contact.why]}), aucun lien proposé`;
  const ticket = crm.ticket.status === "verified"
    ? (ticketUrl ? `<${ticketUrl}|ticket ${crm.ticket.id}>` : `ticket ${crm.ticket.id} vérifié, lien indisponible (portail HubSpot non configuré)`)
    : `ticket non vérifié (${UNVERIFIED_LABELS.ticket_not_found}), aucun lien proposé`;
  const tried: string[] = [];
  facts.trials.slice(0, NOTICE_LIMITS.trials).forEach(trial => tried.push(`• Procédure ${trial.knowledgeId} : ${OUTCOME_LABELS[trial.outcome]}`));
  if (facts.trials.length > NOTICE_LIMITS.trials) tried.push(`• et ${facts.trials.length - NOTICE_LIMITS.trials} autre(s) procédure(s)`);
  if (facts.questionsAsked > 0) tried.push(`• ${facts.questionsAsked} question(s) posée(s) au client`);
  if (facts.expected) tried.push(`• Attendu : ${facts.expected}`);
  if (facts.observed) tried.push(`• Constaté : ${facts.observed}`);
  facts.hypotheses.forEach(item => tried.push(`• Hypothèse : ${item}`));
  if (!tried.length) tried.push("• Aucun essai enregistré avant le relais");
  const next = [facts.expectedIntervention || "à définir par l'équipe", ...(facts.missingInformation.length
    ? [`${facts.reason === "decision_refused" ? "Motifs des refus" : "Informations manquantes"} : ${facts.missingInformation.join(" ; ")}`] : [])];
  const body = [
    `*${HANDOFF_NOTICE_TITLE}*`,
    `*Client :* ${client}`,
    `*Problème :* ${facts.need || "non précisé"}`,
    `*Ce que l'agent a tenté et le résultat :*\n${tried.join("\n")}`,
    `*Motif du relais :* ${HANDOFF_REASON_LABELS[facts.reason]}`,
    `*Ticket HubSpot :* ${ticket}`,
    ...(analysisSignal && UUID.test(facts.conversationId ?? "") ? [`${CONVERSATION_LINE_PREFIX}\`${facts.conversationId}\``] : []),
    `*Prochaine action proposée :* ${next.join(". ")}`,
    // SAV-92: after the existing template, so a cut only ever shortens the synthesis.
    ...(facts.summary ? [`*Synthèse du dossier :*\n${caseHandoffSummaryLines(facts.summary, HANDOFF_REASON_LABELS[facts.reason], sanitizeNoticeText).join("\n")}`] : []),
  ].join("\n");
  // The marker always survives the cut: the verification ties the posted message to its key by it.
  const reference = `_Réf. ${marker}_`;
  const text = `${body.slice(0, NOTICE_LIMITS.text - reference.length - 1)}\n${reference}`;
  return { text, marker, key };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The HubSpot handoff note (SAV-92, Ugo 16/11): a short narrative for the team, never the structured list
// ---------------------------------------------------------------------------------------------------------------------------------

/** Why the case goes to the team, in plain words: no internal term (sheet, validator, block, model), no identifier. */
const NOTE_REASON_SENTENCES: Record<HandoffReason, string> = {
  explicit_human_request: "Le client souhaite échanger avec une personne.",
  sensitive_request: "La demande est sensible et relève de l'équipe.",
  knowledge_missing: "Je n'ai pas de solution adaptée à cette demande.",
  knowledge_conflict: "Les solutions dont je dispose ne concordent pas pour cette demande.",
  evidence_inaccessible: "Il me manque un élément pour aller plus loin.",
  diagnosis_out_of_tools: "La suite du diagnostic demande une intervention de l'équipe.",
  repeated_failure: "Les solutions proposées n'ont pas suffi.",
  decision_refused: "Je préfère laisser l'équipe reprendre ce message.",
  outside_active_blocks: "Cette partie de la demande relève de l'équipe ; je continue de traiter le reste du message.",
  team_part_handoff_unavailable: "Aucune réponse ne lui a été envoyée : tout le message est à reprendre.",
  agent_not_taken: "Je n'ai pas pris ce ticket en charge et aucun mail n'a été envoyé au client.",
  // Ugo (25/11): fixed words and the closed code, never an error message. Neutral: the calls may be model or embedding calls, or lost in a crash.
  technical_exhausted: "Panne technique : l'agent n'a pas pu traiter ce message (appels permis épuisés). Rien n'a été envoyé au client. Code : technical_exhausted.",
  context_invalid: "Panne technique : l'agent n'a pas pu préparer le dossier de ce message. Rien n'a été envoyé au client. Code : context_invalid.",
  knowledge_request_invalid: "Panne technique : la recherche de connaissances de ce message a été refusée. Rien n'a été envoyé au client. Code : knowledge_request_invalid.",
};
const NOTE_TRIAL_OUTCOMES: Record<CaseTrial["outcome"], string> = {
  failed: "le problème persiste", pending: "nous attendons son retour", succeeded: "le client indique que cela a fonctionné", unknown: "nous ne savons pas encore si cela a suffi",
};
const NOTE_LIMITS = { problem: 240, part: 300 } as const;
const endSentence = (value: string) => /[.!?…»]$/.test(value) ? value : `${value}.`;
const lowerFirst = (value: string) => value.charAt(0).toLocaleLowerCase("fr") + value.slice(1);

/**
 * The text of the team's HubSpot note: what the customer reports, what was asked and tried (never which sheet: a first solution, another one), the links and
 * files the customer sent, why the case goes to the team. Built from the sealed facts only; never the agent's reply, never an identifier (case, ticket, sheet,
 * model), free text cleaned again. One sentence per line; a link stands last on its line so HubSpot reads it whole. Deterministic for its input.
 */
export function handoffNoteText(facts: Pick<HandoffNoticeFacts, "reason" | "need"> & Readonly<{ summary: CaseHandoffSummary }>): string {
  const { summary, reason } = facts;
  const lines: string[] = [];
  const problem = summary.problem.text ? sanitizeNoticeText(summary.problem.text, NOTE_LIMITS.problem) : "";
  if (problem && summary.problem.source === "customer_words") lines.push(`Le client écrit : « ${problem} »`);
  else if (problem) lines.push(endSentence(`Le client signale : ${lowerFirst(problem)}`));
  else lines.push("Le client nous a contactés.");
  // A team part says which part is the team's (the fixed prefix of its `need` is dropped, the described requests are kept).
  if (reason === "outside_active_blocks") {
    const part = sanitizeNoticeText(facts.need.replace(/^[^:]*:\s*/, ""), NOTE_LIMITS.part);
    if (part) lines.push(endSentence(`La partie à reprendre : ${part}`));
  }
  const asked = summary.exchanges.length + summary.exchangesOmitted;
  if (asked) lines.push(`Nous lui avons posé ${asked === 1 ? "une question" : `${asked} questions`} ; ${summary.exchanges.at(-1)?.answered ? "il nous a répondu." : "nous attendons encore sa réponse."}`);
  const tried = summary.tried.length + summary.triedOmitted, last = summary.tried.at(-1);
  if (tried && last) {
    const what = tried === 1 ? "une première solution" : tried === 2 ? "une première solution puis une autre solution" : `une première solution puis ${tried - 1} autres solutions`;
    lines.push(`Nous avons essayé ${what} ; ${NOTE_TRIAL_OUTCOMES[last.outcome]}.`);
  }
  const urls = summary.transmitted.urls ?? [], masked = summary.transmitted.urlsMasked ?? 0;
  if (urls.length) lines.push(`Il nous a envoyé ${urls.length === 1 ? "ce lien" : "ces liens"} : ${urls.join(" ; ")}`);
  // A rejected link (authentication, token-shaped, http...) is never written, only said to exist.
  if (masked) lines.push(`Il nous a ${urls.length ? "aussi " : ""}envoyé ${masked === 1 ? "un lien (masqué" : `${masked} liens (masqués`} par sécurité, voir le mail).`);
  const files = summary.received ? summary.received.files.length + summary.received.omitted : summary.transmitted.attachments;
  if (files) lines.push(`Il a joint ${files === 1 ? "un fichier" : `${files} fichiers`} à ses messages.`);
  // Review Astra: « le problème persiste » already says the solutions did not suffice; the reason is not repeated.
  if (!(reason === "repeated_failure" && last?.outcome === "failed")) lines.push(NOTE_REASON_SENTENCES[reason]);
  lines.push(reason === "outside_active_blocks" ? "Je passe cette partie de la demande à l'équipe." : "Je passe le dossier à l'équipe.");
  return lines.join("\n");
}

// The lines of the notice that carry free text, and the only links that may stay in it (the ones `renderHandoffNotice` builds from a CRM-verified id and the portal id).
const FREE_TEXT_LINE = /^(\*Problème :\* |• (?:Attendu|Constaté|Hypothèse|Question|Réponse) : |• Problème, [a-zA-ZÀ-ÿ' ]{1,40} : |• Essai [A-Za-z0-9._[\] -]{1,80} : |\*Prochaine action proposée :\* )(.*)$/;
const INTERNAL_LINK = /<https:\/\/app\.hubspot\.com\/contacts\/[0-9]{1,20}\/record\/0-[15]\/[0-9]{1,30}\|[^<>|\n]{1,80}>/g;
/**
 * The last look before Slack, on the text exactly as it is about to leave (including an intent sealed in the ledger BEFORE a rule existed): the free-text lines are made
 * safe again, and any `<...>` that is not one of our own CRM links is removed (mentions, other links). The marker, the structured lines and the internal links are kept.
 */
export function scrubHandoffNoticeText(text: string, analysisSignal = true): string {
  const lines = text.split("\n").flatMap((line, index, original) => {
    if (line.startsWith(CONVERSATION_LINE_PREFIX)) {
      const value = line.slice(CONVERSATION_LINE_PREFIX.length);
      if (original[index - 1]?.startsWith("*Ticket HubSpot :* ") && value.startsWith("`") && value.endsWith("`") && UUID.test(value.slice(1, -1))) {
        return analysisSignal ? [line] : [];
      }
      return `${CONVERSATION_LINE_PREFIX}${sanitizeNoticeText(value, 1000)}`;
    }
    const free = FREE_TEXT_LINE.exec(line);
    return free ? `${free[1]}${sanitizeNoticeText(free[2]!, 1000)}` : line;
  });
  const kept: string[] = [];
  const protectedText = lines.join("\n").replace(INTERNAL_LINK, link => `\u0000${kept.push(link) - 1}\u0000`);
  return protectedText.replace(/<[^>\n]*>/g, " ").replace(/\u0000(\d+)\u0000/g, (_, n: string) => kept[Number(n)]!);
}

export type HandoffNoticeIntent = EffectIntent & Readonly<{ kind: "handoff_notify"; permission: typeof SAV_CASE_EFFECT_PERMISSIONS.handoff; text: string; marker: string; channel: string }>;
/** The effect the existing executor dispatches: the rendered text, its marker and the configured channel are sealed in the ledger row, so a later pass never rebuilds them. */
export function buildHandoffNoticeIntent(input: Readonly<{ render: HandoffNoticeRender; caseId: string; ticketId: string; channel: string }>): HandoffNoticeIntent {
  if (!SLACK_CHANNEL.test(input.channel) || !/^[0-9]{1,30}$/.test(input.ticketId) || !input.render.text.trim()) throw new Error("SAV_HANDOFF_NOTICE_INTENT_INVALID");
  return { kind: "handoff_notify", permission: SAV_CASE_EFFECT_PERMISSIONS.handoff, key: input.render.key, ticketId: input.ticketId, sourceMessageId: input.caseId,
    text: input.render.text, marker: input.render.marker, channel: input.channel };
}
