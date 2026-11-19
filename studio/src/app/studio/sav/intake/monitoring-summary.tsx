import { formatParisDateTime } from "@/lib/paris-date";
import type { IntakeMonitoring } from "@/lib/sav/intake/monitoring-read";
import styles from "./intake.module.css";
const date = (value: string | null) => value ? formatParisDateTime(value) : "Non observé";
export function MonitoringSummary({ data, refreshHref }: { data: IntakeMonitoring; refreshHref: string }) {
  const permission = { running: "Agent autorisé à travailler", actions_paused: "Actions suspendues · analyse autorisée", fully_paused: "Agent en pause complète", unknown: "Autorisation non vérifiable" }[data.permission];
  const configuration = { verified: "Configuration d’analyse vérifiée", restricted: "Vérification réservée au propriétaire du budget", unavailable: "Configuration d’analyse non vérifiable" }[data.configuration];
  const activity = { missing: "Aucune activité observée", unavailable: "Activité indisponible", stale: "Activité à vérifier · preuve de fin absente ou ancienne", failed: "Dernier passage en échec", observed: "Passage récent observé" }[data.activity.state];
  const collection = { missing: "Aucun relevé de surveillance", unavailable: "Relevé indisponible", partial: "Relevé partiel · incidents non résolus par cette lecture", stale: "Relevé ancien · actualisation nécessaire", complete: "Relevé technique complet · les incidents éventuels ne sont pas affichés ici" }[data.activity.collection];
  const read = data.gmailRead, plural = (n: number) => n > 1 ? "s" : "";
  const gmailRead = !read ? null : read.state === "off" ? "Désactivé" : read.state === "unavailable" ? "Non vérifiable"
    : `${read.pending} dossier${plural(read.pending)} terminé${plural(read.pending)} à marquer lu${plural(read.pending)}${read.parked ? ` · dont ${read.parked} en échec répété (nouvel essai une fois par jour)` : ""}`;
  return <section className={styles.monitoring} aria-labelledby="sav-monitoring-heading">
    <header><h2 id="sav-monitoring-heading">État de la prise en charge par l’Agent de tri</h2><a href={refreshHref}>Actualiser les informations</a></header>
    <dl><div><dt>Autorisation</dt><dd>{permission}</dd></div><div><dt>Configuration</dt><dd>{configuration}</dd></div><div><dt>Activité observée</dt><dd>{activity}</dd></div>{gmailRead && <div><dt>Mails lus dans contact@</dt><dd>{gmailRead}</dd></div>}</dl>
    <p>L’autorisation reflète seulement la pause ; avec un passage récent, elle ne prouve ni que les modes d’analyse et d’exécution sont actifs, ni la réussite des dossiers.</p>
    <details><summary>Horaires et portée des preuves</summary>
      <dl><div><dt>Dernier début</dt><dd>{date(data.activity.startedAt)}</dd></div><div><dt>Dernière fin</dt><dd>{date(data.activity.finishedAt)}</dd></div><div><dt>Dernier passage sans échec signalé</dt><dd>{date(data.activity.succeededAt)}</dd></div></dl>
      <p>{collection}{data.activity.observedAt && <> · {date(data.activity.observedAt)}</>}</p>
      {gmailRead && <p>Seuls les dossiers terminés (ticket créé, « Autre », accusé de réception, clôture administrative) sont marqués lus, avec tous leurs mails reçus. Les dossiers à valider, incertains ou bloqués restent volontairement non lus et ne sont pas comptés ici.</p>}
      <p>Lecture du {date(data.readAt)} · heures de Paris. Une preuve de plus de 15 minutes est signalée comme ancienne. La configuration affichée concerne l’analyse de l’Agent de tri ; elle ne certifie ni le budget disponible, ni les accès externes, ni la réussite des actions.</p>
    </details>
  </section>;
}
