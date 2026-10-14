import "server-only";

import { appendEvaluationEvent, findEvaluationByToken } from "./evaluations";
import { verifyEvaluationObservation } from "./evaluation-verification";

export async function verifyStudioEvaluation(code: string, observation: unknown, signal?: AbortSignal) {
  const detail = await findEvaluationByToken(code);
  if (!detail || detail.run.status !== "running" || detail.testCase.kind !== "live_action" || detail.item.agentKey === "sav") return null;
  const verdict = await verifyEvaluationObservation(detail.testCase.expectation, observation, signal);
  if (signal?.aborted || verdict.reason === "unavailable" || verdict.reason === "invalid_observation") return null;
  const current = await findEvaluationByToken(code);
  if (!current || current.run.status !== "running" || current.run.id !== detail.run.id
    || current.version.id !== detail.version.id || current.testCase.id !== detail.testCase.id) return null;
  return appendEvaluationEvent(code, {
    kind: "tool_result", toolName: "verify_expected_result",
    status: verdict.verified ? "ok" : "not_found", contextVersion: verdict.contextVersion,
  });
}
