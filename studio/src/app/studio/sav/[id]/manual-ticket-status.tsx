import { formatParisDateTime } from "@/lib/paris-date";
import { savManualTicketError } from "@/lib/sav/manual-ticket-status";

type TicketAction = {
  kind: string;
  status: string;
  errorCode: string | null;
  scheduledAt: Date | null;
  payload: Record<string, unknown>;
};

export function ManualTicketStatus({ action, writesDisabled }: { action: TicketAction | null; writesDisabled: boolean }) {
  if (!action) return null;
  const uncertainReturn = Boolean(action.payload.ticketReturnDispatchedAt && !action.payload.ticketReturnCompletedAt);
  const uncertain = uncertainReturn || action.kind === "create_ticket" && action.payload.ticketCreateDispatchedAt && !action.payload.hubspotTicketId;
  const pending = ["pending", "running"].includes(action.status);
  if (action.status === "succeeded") return null; // The linked ticket ID is displayed by the dossier.
  return <div className={`login-notice ${!pending || uncertain ? "error" : ""}`} role="status" aria-label="Suivi de la demande HubSpot">
    <strong>{uncertainReturn ? "Retour à vérifier dans HubSpot" : uncertain ? "Création à vérifier dans HubSpot" : pending ? "Demande HubSpot en attente de confirmation" : "Demande HubSpot non aboutie"}</strong>
    <p>{uncertainReturn ? savManualTicketError("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED") : uncertain ? savManualTicketError("SAV_MANUAL_RECONCILIATION_REQUIRED") : writesDisabled && pending ? savManualTicketError("SAV_WRITES_DISABLED") : action.errorCode || !pending ? savManualTicketError(action.errorCode) : "La demande sera vérifiée lors du prochain traitement périodique. Aucun ticket créé ou rattaché n’est encore confirmé."}</p>
    {pending && !uncertain && !writesDisabled && <p>{action.scheduledAt ? `Prochaine tentative prévue le ${formatParisDateTime(action.scheduledAt, { dateStyle: "short", timeStyle: "short" })}.` : "Le traitement passe toutes les 5 minutes."} Actualisez ce dossier pour consulter le résultat.</p>}
  </div>;
}
