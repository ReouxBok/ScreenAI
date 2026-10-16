import { expect, it } from "vitest";
import { savDashboardLearningProgress } from "./learning-progress";

it.each(["already_covered", "weekly_limit", "cutover_not_active", "comparison_error"])("finishes a qualified resolution with terminal learning outcome %s", (learningDisposition) => {
  const observations = [{ id: "observation", cycle: 1, state: "qualified_without_candidate", sourceErrors: [], closed: true, closedCatchupUntil: new Date("2026-10-14T12:00:00Z"), lastSyncAt: new Date("2026-10-15T12:00:00Z") }] as unknown as Parameters<typeof savDashboardLearningProgress>[0];
  const cycles = [{ observationId: "observation", cycle: 1, qualification: "resolved", qualifiedAt: new Date(), candidateId: null, learningDisposition }] as unknown as Parameters<typeof savDashboardLearningProgress>[1];
  expect(savDashboardLearningProgress(observations, cycles, [])).toBe("none");
  expect(savDashboardLearningProgress(observations, [{ ...cycles[0], learningDisposition: null }], [])).toBe("qualification");
});
