import type { SavTicketReturnOperation } from "./ticket-lifecycle";

/** Presentation only: the lifecycle plan and the confirmed CRM target stay unchanged. */
export function savTicketActionPresentation(ticket: { subject: string; status: "open" | "closed" }, operation: SavTicketReturnOperation, newTitle?: string) {
  const title = ticket.subject.trim() || "Ticket sans titre";
  if (operation === "reactivate") return {
    label: ticket.status === "closed" ? "Réouvrir le ticket" : "Repasser en Nouveau",
    title,
    explanation: "Le ticket existant passe en Nouveau. Son propriétaire est conservé et le retour du client est ajouté en note.",
  };
  if (operation === "create") return {
    label: "Ouvrir un nouveau ticket",
    title: newTitle?.trim() || title,
    explanation: `Le ticket « ${title} » est fermé depuis plus de 15 jours. Un nouveau ticket sera ouvert avec le même propriétaire.`,
  };
  if (operation === "keep") return {
    label: "Rattacher le ticket",
    title,
    explanation: "Ce ticket est déjà en Nouveau. Le dossier sera rattaché sans modifier son statut.",
  };
  return { label: "Vérifier le ticket", title, explanation: "Le statut ou la date de clôture doit être vérifié dans HubSpot avant de choisir une action." };
}
