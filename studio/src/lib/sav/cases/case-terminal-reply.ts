import { isSensitiveCaseFamily } from "./decision-contract";
import type { CaseSnapshot, CaseEvent } from "./case-types";
import { handoffNoticeTrigger } from "./case-handoff-notice";
import { readCaseInvestigationProgress } from "./investigation-record";

export const closingHandoffReplyEnabled = (env: Readonly<Record<string, string | undefined>>) => env.SAV_V2_CLOSING_HANDOFF_REPLY === "on";
export const isTerminalReply = (purpose: string) => purpose === "closing" || purpose === "handoff";
export const CLOSING_REPLY = "Merci pour votre confirmation, nous sommes ravis que le problème soit résolu. Si le problème revient, vous pouvez répondre à ce message.";
export const HANDOFF_REPLY = "Bonjour,\n\nMerci pour votre retour. Je transmets votre demande à un membre de l'équipe support Limova, qui reprend la suite et reviendra vers vous par email dès que possible. Vous n'avez rien à renvoyer : il dispose de tout l'historique de nos échanges.";

/**
 * Ugo (25/11): a hand-over BEFORE any exchange sends the customer nothing; only after at least one agent reply on the case does the hand-over reply go out.
 * True when an agent reply (`agent_outbound`) was recorded before the input event of the decision (`in:<event>` / `back:<event>`), so the hand-over reply itself never counts.
 */
export function agentRepliedBefore(events: readonly Pick<CaseEvent, "id" | "direction">[], inputKey: string) {
  const at = events.findIndex(e => e.id === inputKey.slice(inputKey.indexOf(":") + 1));
  return at > 0 && events.slice(0, at).some(e => e.direction === "agent_outbound");
}

/** Only the agent's own durable transfer, before any person takes over. CRM ownership is still checked separately. */
export function pendingHandoffReply(snapshot: CaseSnapshot, events: readonly CaseEvent[], triggerEventId: string) {
  const trigger = handoffReplyTrigger(snapshot, events);
  return trigger !== null && triggerEventId === trigger;
}

/** The trigger of the hand-over reply the agent may still send (`inbound:<mail>`), or null when no hand-over reply is allowed now. SAV-92 (17/11): also read by the hand-over stage. */
export function handoffReplyTrigger(snapshot: CaseSnapshot, events: readonly CaseEvent[]): string | null {
  if (snapshot.sensitivity !== "none" || snapshot.body.openRequests.some(row => isSensitiveCaseFamily(row.family)) || !snapshot.body.handoff || !(snapshot.owner === "human" && snapshot.phase === "handoff_pending" && !snapshot.body.handoff.humanSince)) return null;
  const trigger = handoffNoticeTrigger(snapshot, events);
  if (!trigger.ok) return null;
  const read = readCaseInvestigationProgress(events, trigger.inputKey);
  if (read.state !== "found" || read.record.decision?.validation.outcome !== "accepted" || read.record.decision.validation.decision.nextAction.kind !== "handoff") return null;
  if (read.record.decision.actionsPaused || read.record.decision.validation.decision.nextAction.reason === "sensitive_request") return null;
  if (events.some(e => e.caseVersion > read.caseVersion && (e.direction === "human_outbound" || e.kind === "inbound_confirmed"))) return null;
  const id = trigger.inputKey.slice(trigger.inputKey.indexOf(":") + 1), at = events.findIndex(e => e.id === id);
  if (at < 0 || !agentRepliedBefore(events, trigger.inputKey)) return null;
  const mail = trigger.inputKey.startsWith("back:") ? events.slice(0, at).findLast(e => e.direction === "customer_inbound" && e.sourceRef.type === "email") : events[at];
  return mail?.direction === "customer_inbound" && mail.sourceRef.type === "email" ? `inbound:${mail.sourceRef.id}` : null;
}

/** An automatic transfer is a consequence of the decision, not a new customer input for its acknowledgement. */
export function terminalReplyInput(events: readonly CaseEvent[], inputKey: string | null, env: Readonly<Record<string, string | undefined>>) {
  if (!closingHandoffReplyEnabled(env) || !inputKey?.startsWith("back:")) return inputKey;
  const event = events.find(e => e.id === inputKey.slice(5));
  if (!event || event.kind !== "owner_changed" || event.detail?.transition !== "handoff") return inputKey;
  const observation = events.find(e => e.caseVersion === event.caseVersion - 1 && e.kind === "observation_recorded");
  const key = (observation?.detail?.record as { inputKey?: unknown } | undefined)?.inputKey;
  if (typeof key !== "string" || event.dedupeKey !== `cmd:investigation-handoff-v${observation!.caseVersion}`) return inputKey;
  const read = readCaseInvestigationProgress(events, key);
  return read.state === "found" && read.record.decision?.validation.outcome === "accepted" && read.record.decision.validation.decision.nextAction.kind === "handoff" ? key : inputKey;
}

/** A closing acknowledgement needs the same accepted, independently checked customer confirmation as the closed stage. */
export function provenClosingReply(snapshot: CaseSnapshot, events: readonly CaseEvent[], triggerEventId: string) {
  if (snapshot.owner !== "agent" || snapshot.sensitivity !== "none" || snapshot.body.openRequests.some(row => isSensitiveCaseFamily(row.family))) return false;
  const latest = [...events].filter(e => e.kind === "observation_recorded" && (e.detail?.record as { kind?: unknown } | undefined)?.kind === "sav-case-investigation.v1").sort((a, b) => b.caseVersion - a.caseVersion)[0];
  const key = (latest?.detail?.record as { inputKey?: unknown } | undefined)?.inputKey;
  if (typeof key !== "string" || latest?.detail?.applied === false) return false;
  const read = readCaseInvestigationProgress(events, key), decision = read.state === "found" ? read.record.decision : null;
  if (!decision || decision.validation.outcome !== "accepted" || decision.validation.decision.nextAction.kind !== "confirm_resolution" || decision.actionsPaused || decision.closure?.plan !== "soft_close" || decision.closure.reason !== "checked") return false;
  const resolved = new Set(decision.validation.decision.nextAction.requestIds);
  if (snapshot.body.openRequests.some(row => row.status === "open" && !resolved.has(row.id))) return false;
  if (events.some(e => e.caseVersion > latest!.caseVersion && (e.kind === "human_command" || e.kind === "owner_changed" || e.kind === "inbound_confirmed" || e.direction === "human_outbound"))) return false;
  const at = events.findIndex(e => e.id === key.slice(key.indexOf(":") + 1));
  if (at < 0) return false;
  const mail = key.startsWith("back:") ? events.slice(0, at).findLast(e => e.direction === "customer_inbound" && e.sourceRef.type === "email") : events[at];
  return mail?.direction === "customer_inbound" && mail.sourceRef.type === "email" && triggerEventId === `inbound:${mail.sourceRef.id}`;
}
