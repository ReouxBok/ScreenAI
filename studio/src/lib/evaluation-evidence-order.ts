interface EvaluationEvidenceEvent {
  ordinal: number;
  kind: string;
  toolName: string | null;
  status: string | null;
  technicalMetadata: Record<string, string | number | boolean | null>;
}
const MUTATIONS = new Set(["click_element", "fill_field", "navigate_internal", "scroll_page"]);

export function readOrderedEvaluationEvidence(events: EvaluationEvidenceEvent[]) {
  const ordered = [...events].sort((a, b) => a.ordinal - b.ordinal);
  const failed = ordered.some(event => ["failed", "blocked", "unexpected"].includes(event.status ?? ""));
  const manual = ordered.some(event => event.technicalMetadata.manualIntervention === true);
  const validOrder = ordered.every((event, index) => Number.isSafeInteger(event.ordinal) && event.ordinal > 0
    && (!index || event.ordinal > ordered[index - 1].ordinal));
  if (!validOrder) return { failed, manual, delivered: false, actionSucceeded: false, verified: false };
  let lastMutation = -1, lastVerification = -1, lastResponse = -1;
  ordered.forEach((event, index) => {
    if (MUTATIONS.has(event.toolName ?? "")) lastMutation = index;
    if (event.toolName === "verify_expected_result") lastVerification = index;
    if (event.kind === "response") lastResponse = index;
  });
  return {
    failed, manual,
    delivered: lastResponse > lastMutation && ordered[lastResponse]?.status === "ok",
    actionSucceeded: lastMutation >= 0 && ordered[lastMutation].status === "ok",
    verified: lastMutation >= 0 && lastVerification > lastMutation && ordered[lastVerification].status === "ok",
  };
}
