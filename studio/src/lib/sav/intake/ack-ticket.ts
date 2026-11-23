// SAV-128 (Ugo 23/11): a customer's thank-you or « c'est résolu » goes INTO the ticket of its Gmail thread, so the team (later V2) confirms the resolution
// and closes it. The PURE part: the note, the reasons an acknowledgement stays without ticket, their console labels. Nothing here reads, writes or sends.
// The engine (`engine.ts`) links the thread's ticket with the rights V1 already has (link_ticket, associate_email, append_ticket_note, set_ticket_new);
// the runtime gives it the per-mail fact (`ack-ticket-store.ts`). `SAV_ACK_CLOSE=on` (autonomous close, its own right) keeps the previous path instead.

/** Version of the note text below; bound in the decision (`acknowledgement_summary`). */
export const SAV_ACK_TICKET_NOTE_VERSION = 1;
const SUMMARY_MAX = 200;

/** One line of the customer's own words (first non-empty line, spaces collapsed, cut at 200 characters). */
export function savAckTicketSummary(currentText: string): string {
  const line = currentText.split(/\r?\n/).map(row => row.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : line;
}

/** The note added to the thread's ticket. `previousStage` is the stage read before the link: an open ticket is moved back to « Nouveau ». */
export function savAckTicketNote(currentText: string, previousStage: "new" | "open"): string {
  return [`Le client remercie / confirme la résolution : « ${savAckTicketSummary(currentText)} »`,
    previousStage === "open" ? "Le ticket repasse en Nouveau : l'équipe confirme la résolution puis le ferme."
      : "Le ticket est en Nouveau : l'équipe confirme la résolution puis le ferme."].join("\n");
}

/** Why an acknowledgement stays without ticket (today's « acknowledgement_only »), when the fact was given to the engine. */
export const SAV_ACK_TICKET_REASONS = ["no_thread_ticket", "contact_not_found", "contact_ambiguous", "thread_ticket_not_on_contact", "thread_ticket_closed",
  "thread_ticket_stage_unknown", "multi_ticket_warning_unavailable", "crm_incomplete"] as const;
export type SavAckTicketReason = typeof SAV_ACK_TICKET_REASONS[number];
export type SavAckTicketOutcome = Readonly<{ outcome: "attached"; ticketId: string }> | Readonly<{ outcome: "not_attached"; reason: SavAckTicketReason }>;

export const savAckTicketReasonLabels: Record<SavAckTicketReason, string> = {
  no_thread_ticket: "aucun ticket lié au fil",
  contact_not_found: "aucune fiche HubSpot pour l’expéditeur (pas de mail d’identification pour un remerciement)",
  contact_ambiguous: "plusieurs fiches HubSpot possibles",
  thread_ticket_not_on_contact: "le ticket du fil n’est pas sur la fiche de l’expéditeur",
  thread_ticket_closed: "le ticket du fil est déjà fermé",
  thread_ticket_stage_unknown: "étape du ticket du fil inconnue",
  multi_ticket_warning_unavailable: "avertissement « plusieurs tickets ouverts » indisponible",
  crm_incomplete: "lecture HubSpot incomplète",
};

/** The console reason of an acknowledgement left without ticket. */
export function savAckTicketConsoleReason(outcome: SavAckTicketOutcome | undefined): string {
  const base = "Accusé de réception sans nouvelle demande ; aucun ticket fermé par ce classement.";
  if (outcome?.outcome !== "not_attached") return base;
  const label = (savAckTicketReasonLabels as Record<string, string | undefined>)[outcome.reason];
  return label ? `${base} Non rattaché au ticket : ${label}.` : base;
}
