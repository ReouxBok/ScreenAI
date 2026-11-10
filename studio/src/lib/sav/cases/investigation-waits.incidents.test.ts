import { expect, it } from "vitest";
import { listCaseInvestigationWaits } from "./investigation-waits";
import type { CaseInvestigationProgress } from "./investigation-runner";

it.each(["read_failed", "invalid", "conflict", "scope_limit"] as const)("labels temporary %s without inventing provider failure, cost or activity", problem => {
  const progress: CaseInvestigationProgress = { modelCalls: 1, attempts: [], proposal: null, closure: null, last: null, recordedOn: null,
    waiting: { reason: "technical_wait", since: "2026-11-10T08:00:00Z", caseVersion: 2, temporaryIncidentProblem: problem } };
  const [item] = listCaseInvestigationWaits([{ caseId: "syn-case", inputKey: "syn-input", progress }], new Date("2026-11-10T08:03:00Z"));
  expect(item).toMatchObject({ label: "Attente de vérification des informations temporaires.", modelCalls: 1, embeddingCalls: null, problem: `temporary_incident_${problem}`, waitingMinutes: 3, needsPerson: problem !== "read_failed" });
  expect(item.label).not.toMatch(/génération|fournisseur|coût|activité/iu);
  expect(item.unblock).toContain("déjà consommés restent conservés");
});
