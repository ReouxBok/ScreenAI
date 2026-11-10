import { unifiedBucketLabels, type UnifiedBucket, type UnifiedLine } from "./unified-console-model";
import { formatParisDateTime } from "@/lib/paris-date";
import styles from "./unified-console.module.css";
/** Injection boundary for the separately owned authenticated monitoring reader.
 * No network, invented live state, global count or repair command in this view. */
export type UnifiedMonitoring = {
  state: "unconnected" | "available" | "unavailable";
  observedAt: string | null;
  coverage: "complete" | "partial" | "unknown";
  causes: readonly { label: string; nextAction: string }[];
  scope?: {
    from: string; to: string; limitPerEngine: number; truncated: boolean;
    monitorObservedAt: string | null; monitorStatus: string; sources: string;
    incompleteRows: boolean; monitorPartial: boolean;
  };
};
export const UNCONNECTED_MONITORING: UnifiedMonitoring = { state: "unconnected", observedAt: null, coverage: "unknown", causes: [] };
export function UnifiedConsoleOverview({ lines, monitoring = UNCONNECTED_MONITORING }: { lines: Record<string, UnifiedLine>; monitoring?: UnifiedMonitoring }) {
  const counts = new Map<UnifiedBucket, number>();
  for (const line of Object.values(lines)) counts.set(line.bucket, (counts.get(line.bucket) ?? 0) + 1);
  return <section className={styles.overview} aria-labelledby="unified-page-heading">
    <h2 id="unified-page-heading">Sur cette page</h2>
    {counts.size ? <ul>{Array.from(counts, ([bucket, count]) => <li key={bucket}>{unifiedBucketLabels[bucket]} : <strong>{count}</strong></li>)}</ul> : <p>Aucun dossier affiché sur cette page.</p>}
    <p>Mail reçu → ticket confirmé → responsable → réponse ou attente. Une réponse envoyée ou une prise en charge terminée ne signifie pas que le problème client est résolu.</p>
    <details><summary>Collecte de surveillance · {monitoring.state === "unconnected" ? "non branchée" : monitoring.state === "unavailable" ? "indisponible" : monitoring.coverage === "partial" ? "couverture partielle" : monitoring.coverage === "unknown" ? "couverture inconnue" : "couverture complète"}</summary>
      {monitoring.state === "unconnected" ? <p>Collecte non branchée dans cette vue. Aucun état global n’est déduit des dossiers affichés.</p>
        : <>
          {monitoring.state === "unavailable" && <p>Collecte indisponible. Consulter les preuves du dossier ; aucun rétablissement n’est confirmé.</p>}
          <p>Lecture des données : {monitoring.observedAt ? formatParisDateTime(monitoring.observedAt) : "date inconnue"}. Cette lecture ne prouve pas que le worker est actif.</p>
          {monitoring.scope && <>
            <p>Dossiers courants créés du {formatParisDateTime(monitoring.scope.from)} au {formatParisDateTime(monitoring.scope.to)}. Limite : {monitoring.scope.limitPerEngine} par moteur. Ce relevé ne couvre pas tout le backlog et ne suit pas les filtres de cette page.</p>
            <p>Sources : {monitoring.scope.sources}. Les sources sont lues séparément.</p>
            {monitoring.scope.truncated && <p>Limite atteinte : relevé tronqué, certains dossiers ne sont pas représentés.</p>}
            {monitoring.scope.incompleteRows && <p>Certaines lignes sont invalides ou dupliquées : relevé incomplet.</p>}
            <p>Instantané technique global : {monitoring.scope.monitorStatus} · {monitoring.scope.monitorObservedAt ? formatParisDateTime(monitoring.scope.monitorObservedAt) : "date inconnue"}. Il est distinct de la fenêtre des dossiers.</p>
            {monitoring.scope.monitorPartial && <p>L’instantané technique contient une collecte partielle.</p>}
            <p>Démarrage et fin du worker, ainsi que les effets attendus : télémétrie non disponible. Une absence de trace ne prouve pas une panne.</p>
          </>}
          {monitoring.causes.length ? <ul>{monitoring.causes.map((cause, index) => <li key={index}>{cause.label} — Prochaine action : {cause.nextAction}</li>)}</ul> : <p>Aucune cause classée dans les données disponibles ; cela ne prouve pas l’absence d’incident.</p>}
        </>}
    </details>
  </section>;
}
