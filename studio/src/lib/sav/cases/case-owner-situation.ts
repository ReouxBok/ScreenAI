// Pole A (SAV-11/44, 3/11): who holds a relayed case and what V2 may do with it, from the case record and ONE current owner reading. Pure: it reads,
// writes and calls nothing, so a page, a read model or C can show it. The reading comes from the caller (A's `ticketOwnerPort`, or "not_read"); this
// file never infers an owner from the case. An admitted ticket nobody owns stays with the team: taking it needs a conditional (compare-and-set) owner
// write that HubSpot does not prove, so nothing is written (review R1, 31/10; Ugo's safety conditions of 31/10).
import { caseAwaitsV2Attribution, type CaseAdmissionReason, type CaseSnapshot } from "./case-types";
import type { TicketOwnerReading } from "./admission-runtime";

export const SAV_CASE_OWNER_SITUATIONS = [
  "excluded_sensitive", "team_not_admitted", "human_owner", "owner_unknown", "v2_owner_read_pending", "admitted_take_blocked", "agent", "agent_unconfirmed", "system_hold",
] as const;
export type CaseOwnerSituation = typeof SAV_CASE_OWNER_SITUATIONS[number];
/** What the caller could read of the ticket's CRM owner just now: a reading, a failed read, or no read at all. */
export type CaseOwnerReadingInput = TicketOwnerReading | "read_failed" | "not_read";
export type CaseOwnerSituationView = Readonly<{
  situation: CaseOwnerSituation;
  /** Only "agent": the agent may start new work, and C still judges the owner again before each step. */
  v2Work: boolean;
  /** Never true in this version: no path writes a ticket owner. */
  ownerWrite: false;
  label: string; nextAction: string;
}>;

const TEXT: Record<CaseOwnerSituation, readonly [label: string, nextAction: string]> = {
  excluded_sensitive: ["Finance, résiliation ou demande sensible : traité par l'équipe, hors autonomie.", "L'équipe reprend le dossier ; aucune action de l'agent."],
  team_not_admitted: ["Non admis pour l'agent : traité par l'équipe.", "L'équipe reprend le dossier ; la raison d'admission dit ce qui manque."],
  human_owner: ["Ticket tenu par une personne : aucun traitement V2.", "Aucune action de l'agent ; un nouveau mail ne rend pas le ticket à l'agent."],
  owner_unknown: ["Propriétaire du ticket non lu : rien n'est fait.", "Relire le propriétaire ; inconnu ne vaut jamais sans propriétaire."],
  v2_owner_read_pending: ["Admis, propriétaire V2 lu sur le ticket : le dossier passe à l'agent à la prochaine reprise.", "Aucune action de l'équipe ni écriture ; une pause en cours retarde ce passage, et le propriétaire est relu avant."],
  admitted_take_blocked: ["Admis, ticket sans propriétaire : la prise automatique n'est pas possible sans garantie du CRM.", "Aucune écriture ; l'équipe garde le ticket tant que la prise sûre n'est pas décidée."],
  agent: ["Dossier de l'agent, propriétaire V2 confirmé.", "L'agent peut avancer ; le propriétaire est relu avant chaque nouvelle étape."],
  agent_unconfirmed: ["Dossier de l'agent, mais le propriétaire actuel n'est pas lu comme V2 : aucune nouvelle étape.", "Relire le propriétaire ; une personne a pu reprendre le ticket."],
  system_hold: ["Dossier suspendu.", "Une personne lève la suspension."],
};
const view = (situation: CaseOwnerSituation): CaseOwnerSituationView =>
  ({ situation, v2Work: situation === "agent", ownerWrite: false, label: TEXT[situation][0], nextAction: TEXT[situation][1] });
const SENSITIVE_REASONS: readonly CaseAdmissionReason[] = ["case_sensitive", "sensitive_family", "mixed_sensitive"];

/** In this order: a hold, sensitivity (whoever owns the ticket), a person's takeover, the admission, then the owner reading. */
export function describeCaseOwnerSituation(current: Pick<CaseSnapshot, "owner" | "phase" | "body" | "sensitivity" | "admission">, reading: CaseOwnerReadingInput): CaseOwnerSituationView {
  if (current.owner === "system_hold") return view("system_hold");
  if (current.sensitivity !== "none" || (current.admission && SENSITIVE_REASONS.includes(current.admission.reasons[0]!))) return view("excluded_sensitive");
  if (current.owner === "agent") return view(reading === "v2" ? "agent" : "agent_unconfirmed");
  if (current.phase === "human_owned" || current.body.handoff?.humanSince) return view("human_owner");
  if (!caseAwaitsV2Attribution(current)) return view("team_not_admitted");
  // Admitted, waiting for a V2 owner: only the current reading tells case 1 (nobody) from case 2 (a person).
  if (reading === "human") return view("human_owner");
  if (reading === "none") return view("admitted_take_blocked");
  if (reading === "v2") return view("v2_owner_read_pending");
  return view("owner_unknown");
}
