import { SAV_HUBSPOT_SUPPORT } from "./hubspot-mapping";

export type SavLifecycleTicket = {
  id: string; status: "open" | "closed"; stageId?: string | null;
  createdAt?: string | null; closedAt?: string | null;
};
export type SavTicketReturnOperation = "keep" | "reactivate" | "create" | "review";
export const SAV_TICKET_RETURN_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

/** Compare with the customer's return, so a delayed worker cannot change the 15-day rule. */
export function savTicketReturnPlan(ticket: SavLifecycleTicket, returnedAt: Date | string) {
  if (ticket.status === "closed") {
    const closed = ticket.closedAt ? Date.parse(ticket.closedAt) : NaN;
    const returned = new Date(returnedAt).getTime();
    if (!Number.isFinite(closed) || !Number.isFinite(returned) || closed > returned)
      return { operation: "review" as const, reason: "closed_date_unavailable" };
    return returned - closed > SAV_TICKET_RETURN_WINDOW_MS
      ? { operation: "create" as const, reason: "closed_over_15_days" }
      : { operation: "reactivate" as const, reason: "closed_within_15_days" };
  }
  if (ticket.stageId === SAV_HUBSPOT_SUPPORT.stages.new) return { operation: "keep" as const, reason: "already_new" };
  if (ticket.stageId === SAV_HUBSPOT_SUPPORT.stages.awaitingContact || ticket.stageId === SAV_HUBSPOT_SUPPORT.stages.awaitingTeam)
    return { operation: "reactivate" as const, reason: "waiting_customer_return" };
  return { operation: "review" as const, reason: "ticket_stage_unknown" };
}

export function sortSavTicketsNewestFirst<T extends { id: string; createdAt?: string | null }>(tickets: readonly T[]): T[] {
  const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;
  return [...tickets].sort((a, b) => {
    const left = timestamp(a.createdAt), right = timestamp(b.createdAt);
    return left === right ? b.id.localeCompare(a.id, undefined, { numeric: true }) : left > right ? -1 : 1;
  });
}

export const savTicketReturnLabels: Record<SavTicketReturnOperation, string> = {
  keep: "Rattacher sans modifier le ticket Nouveau",
  reactivate: "Remettre en Nouveau et ajouter l’email en note",
  create: "Créer un nouveau ticket (clôture de plus de 15 jours)",
  review: "Vérifier la clôture ou le statut dans HubSpot",
};
