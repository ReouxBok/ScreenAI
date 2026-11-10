import "server-only";
import { dailyReviewConsoleSummary, readDailyReviewSnapshot, type DailyReviewSnapshot } from "@/lib/sav/daily-review-read";
import type { DailyCause } from "@/lib/sav/daily-review";
import type { UnifiedMonitoring } from "./unified-console-overview";

const labels: Record<DailyCause, string> = {
  no_pulse: "Démarrage non observé", worker_unfinished: "Fin de traitement non observée",
  worker_failed: "Échec de traitement observé", effect_missing: "Effet attendu non confirmé",
  effect_uncertain: "Effet externe incertain", unknown: "Progression non vérifiable",
  paused_by_human: "Attente humaine", succeeded: "Effet confirmé (résolution client non déduite)",
};
const sourceLabels = { available: "disponible", unavailable: "indisponible" };
const monitorLabels = { fresh: "récent", stale: "ancien ou date incohérente", missing: "absent", unavailable: "indisponible" };

/** Same authenticated, bounded SELECT reader as GET /api/internal/sav/monitoring.
 * No self-HTTP request, polling, collector, worker or repair is triggered. */
export async function readUnifiedMonitoring(
  read: () => Promise<DailyReviewSnapshot> = readDailyReviewSnapshot,
): Promise<UnifiedMonitoring> {
  try {
    const snapshot = await read(), { coverage } = snapshot;
    return {
      ...dailyReviewConsoleSummary(snapshot),
      causes: snapshot.report.groups.map(group => ({ label: `${labels[group.cause]} (${group.count})`, nextAction: group.nextAction })),
      scope: {
        ...snapshot.window, limitPerEngine: coverage.limitPerEngine, truncated: coverage.truncated,
        monitorObservedAt: coverage.monitorObservedAt, monitorStatus: monitorLabels[coverage.sources.monitor],
        sources: `V1 ${sourceLabels[coverage.sources.v1]} ; V2 ${sourceLabels[coverage.sources.v2]}`,
        incompleteRows: snapshot.missing.some(code => /_(invalid_row|duplicate_row)$/.test(code)),
        monitorPartial: snapshot.missing.includes("monitor_collection_partial"),
      },
    };
  } catch {
    // Authorization/reader failure must not disclose details or remove the intake list.
    return { state: "unavailable", coverage: "unknown", observedAt: null, causes: [] };
  }
}
