import type { CrmDisplayRecord } from "@/lib/sav/intake/crm-display";
import { SkeletonLine } from "@/components/skeleton";
import styles from "./intake.module.css";

/** `pending`: HubSpot names are still being read; records only carry their link. */
export function IntakeCrmContext({ contact, ticket, confirmed, creationPlanned, verifiedAt, pending = false }: {
  contact?: CrmDisplayRecord; ticket?: CrmDisplayRecord; confirmed: boolean; creationPlanned: boolean; verifiedAt?: string; pending?: boolean;
}) {
  const name = (record: CrmDisplayRecord) => pending
    ? <><span className={styles.srOnly}>Nom HubSpot en cours de lecture</span><SkeletonLine inline width="70%" height={14}/></> : record.label;
  return <section className={styles.crmContext} aria-label="Fiche et ticket HubSpot" aria-busy={pending || undefined}>
    <div><h2>{confirmed ? "Fiche du ticket confirmé" : "Fiche proposée"}</h2>
      <p>{contact ? name(contact) : "Fiche non déterminée"}</p>
      {contact?.url && <a href={contact.url} target="_blank" rel="noopener noreferrer">Ouvrir la fiche HubSpot</a>}
      {contact && !pending && !contact.available && <small>Nom indisponible ; la référence CRM est conservée.</small>}
    </div>
    <div><h2>{confirmed ? "Ticket confirmé" : "Ticket proposé"}</h2>
      <p>{ticket ? name(ticket) : creationPlanned ? "Nouveau ticket prévu — aucune création confirmée" : "Aucun ticket retenu à ce stade"}</p>
      {ticket?.url && <a href={ticket.url} target="_blank" rel="noopener noreferrer">Ouvrir le ticket HubSpot</a>}
      <small>{confirmed ? "Prise en charge confirmée ; la résolution client reste à établir." : "Proposition conditionnelle, aucune action confirmée par ce panneau."}</small>
      {verifiedAt && <small>Dernier effet vérifié : {verifiedAt}. Le statut actuel doit être lu dans HubSpot.</small>}
    </div>
  </section>;
}
