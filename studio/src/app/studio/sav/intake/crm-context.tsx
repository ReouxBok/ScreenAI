import type { CrmDisplayRecord } from "@/lib/sav/intake/crm-display";
import styles from "./intake.module.css";

export function IntakeCrmContext({ contact, ticket, confirmed, creationPlanned, verifiedAt }: {
  contact?: CrmDisplayRecord; ticket?: CrmDisplayRecord; confirmed: boolean; creationPlanned: boolean; verifiedAt?: string;
}) {
  return <section className={styles.crmContext} aria-label="Fiche et ticket HubSpot">
    <div><h2>{confirmed ? "Fiche du ticket confirmé" : "Fiche proposée"}</h2>
      <p>{contact?.label ?? "Fiche non déterminée"}</p>
      {contact?.url && <a href={contact.url} target="_blank" rel="noopener noreferrer">Ouvrir la fiche HubSpot</a>}
      {contact && !contact.available && <small>Nom indisponible ; la référence CRM est conservée.</small>}
    </div>
    <div><h2>{confirmed ? "Ticket confirmé" : "Ticket proposé"}</h2>
      <p>{ticket?.label ?? (creationPlanned ? "Nouveau ticket prévu — aucune création confirmée" : "Aucun ticket retenu à ce stade")}</p>
      {ticket?.url && <a href={ticket.url} target="_blank" rel="noopener noreferrer">Ouvrir le ticket HubSpot</a>}
      <small>{confirmed ? "Prise en charge confirmée ; la résolution client reste à établir." : "Proposition conditionnelle, aucune action confirmée par ce panneau."}</small>
      {verifiedAt && <small>Dernier effet vérifié : {verifiedAt}. Le statut actuel doit être lu dans HubSpot.</small>}
    </div>
  </section>;
}
