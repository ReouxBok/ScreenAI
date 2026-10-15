import type { savObservationCycles, savResolutionObservations } from "@/db/schema";
import type { SavLearningProgress } from "./dashboard-state";

type Observation = typeof savResolutionObservations.$inferSelect;
type Cycle = typeof savObservationCycles.$inferSelect;
export function savDashboardLearningProgress(observations: Observation[], cycles: Cycle[], candidates: Array<{ id: string; status: string; sourceRef?: string }>): SavLearningProgress {
  const states = observations.map((observation): SavLearningProgress => {
    const cycle = cycles.find(c => c.observationId === observation.id && c.cycle === observation.cycle);
    if (observation.state === "waiting_ticket") return "waiting_ticket";
    if (observation.sourceErrors.length || observation.state === "sources_incomplete" || cycle?.qualification === "insufficient_sources") return "incomplete";
    if (!observation.closed) return "collecting";
    if (!observation.closedCatchupUntil || !observation.lastSyncAt || observation.lastSyncAt < observation.closedCatchupUntil) return "catchup";
    if (!cycle?.qualifiedAt || !cycle.qualification || cycle.qualification === "resolved" && !cycle.candidateId) return "qualification";
    if (cycle.candidateId && !["approved", "rejected"].includes(candidates.find(c => c.id === cycle.candidateId)?.status ?? "")) return "candidate";
    return "none";
  });
  // A reusable human dossier review can create learning without a refused
  // draft/observation. Older observation cycles stay excluded from this path.
  if (candidates.some(candidate => candidate.status === "pending" && candidate.sourceRef && !candidate.sourceRef.startsWith("sav-observation:"))) states.push("candidate");
  return (["incomplete", "qualification", "candidate", "waiting_ticket", "collecting", "catchup"] as const).find(state => states.includes(state)) ?? "none";
}

