import type { SavLifecycleTicket } from "@/lib/sav/ticket-lifecycle";

export function savTicketStageLabel(ticket: Pick<SavLifecycleTicket, "status" | "stageId">) {
  return ticket.status === "closed" ? "Fermé" : ({ "1": "Nouveau", "2": "En attente du client", "3": "En attente de l’équipe" } as Record<string, string>)[ticket.stageId ?? ""] ?? "Statut à vérifier";
}
