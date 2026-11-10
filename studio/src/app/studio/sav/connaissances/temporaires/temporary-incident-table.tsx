import { fixStatement } from "@/lib/knowledge/temporary-incident-schema";
import type { TemporaryIncidentPreviewRow } from "@/lib/knowledge/temporary-incidents-read";
import styles from "../workspace.module.css";

const fixLabels = { none: "Incident connu, aucun correctif annoncé", fix_announced: "Correctif annoncé (déploiement non prouvé)", deploy_proven: "Déploiement prouvé", client_verified: "Résultat client vérifié" } as const;

/**
 * Describes the INCIDENT, never the knowledge item: the carrying revision may be approved, published or active,
 * but the incident itself is never projected, published, indexed or used by the agent (SAV-79, runtime not wired).
 */
export function incidentStateLabel(row: TemporaryIncidentPreviewRow) {
  if (!row.incident) return "Incident invalide : ignoré, à corriger";
  const approval = row.incidentApproved ? "approuvé avec la révision" : row.revisionApproved ? "révision approuvée sans relecteur SAV reconnu" : `en attente de revue de la révision (${row.reviewState})`;
  const lifecycle = row.incident.status === "revoked" ? "révoqué" : row.expired ? "expiré" : "déclaré actif";
  return `Incident ${lifecycle}, ${approval}. Jamais projeté dans la fiche ni publié ; non utilisé par l’agent SAV (branchement non réalisé).`;
}

export function TemporaryIncidentTable({ rows, formatDate }: { rows: TemporaryIncidentPreviewRow[]; formatDate: (value: string) => string }) {
  return (
    <>
      <p role="note">Aperçu en lecture seule des incidents enregistrés dans les révisions de connaissances. L’état de la fiche elle-même se consulte dans la bibliothèque.</p>
      <p>Affichage limité aux 100 révisions les plus récentes portant un incident. Cet aperçu ne constitue pas un inventaire exhaustif.</p>
      {rows.length === 0 ? <p>Aucun incident temporaire enregistré.</p> : (
        <table className={styles.table}>
          <thead><tr><th>Fiche (révision)</th><th>Incident</th><th>Périmètre</th><th>Validité</th><th>Preuve du correctif</th><th>État de l’incident</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const incident = row.incident;
              return (
                <tr key={row.revisionId}>
                  <td>{row.familyTitle} — révision {row.revision}</td>
                  <td>{incident ? <>{incident.title} (version d’incident {incident.revision}){incident.supersedes ? ` · remplace ${incident.supersedes}` : ""}</> : <>Invalide : {row.errors.join(", ")}</>}</td>
                  <td>{incident ? `${incident.scope.families.join(", ")} · ${incident.scope.productArea}` : "—"}</td>
                  <td>{incident ? `${formatDate(incident.knownSince)} → ${formatDate(incident.validUntil)}` : "—"}</td>
                  <td>{incident ? <>{fixLabels[incident.fix.level]}<br /><small>{fixStatement(incident.fix.level)}</small></> : "—"}</td>
                  <td>{incidentStateLabel(row)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
