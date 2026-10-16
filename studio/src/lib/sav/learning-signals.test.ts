import { expect, it } from "vitest";
import { groupSavLearningSignals, type SavLearningSignal } from "./learning-signals";
it("groups ten gaps into one group, counts dossiers once and preserves version boundaries", () => {
  const base: SavLearningSignal = { kind: "knowledge_gap", domain: "seo", cardId: null, versionId: null, playbookVersionId: "book-1", runId: "run-1" };
  const signals = Array.from({ length: 10 }, (_, i) => ({ ...base, runId: `run-${i}` }));
  expect(groupSavLearningSignals([...signals, signals[0]])).toHaveLength(1);
  expect(groupSavLearningSignals(signals)[0].count).toBe(10);
  expect(groupSavLearningSignals([...signals, { ...base, playbookVersionId: "book-2" }])).toHaveLength(2);
  expect(JSON.stringify(groupSavLearningSignals(signals))).not.toContain("run-");
});
