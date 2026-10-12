import type { SavUnderstandingContent, SavUnderstandingV1, SavReplyCoverage } from "../src/lib/sav/understanding";
import { SAV_UNDERSTANDING_REVISION, SAV_UNDERSTANDING_PROMPT_REVISION } from "../src/lib/sav/understanding";

/** Synthetic declared meanings: these fixtures test policy, not a model's accuracy. */
export function understandingFixture(overrides: Partial<SavUnderstandingV1> = {}): SavUnderstandingV1 {
  return { version: 1, status: "qualified", language: "fr", primaryRequestId: "request-1",
    requests: [{ id: "request-1", summary: "L’agent téléphone cesse de répondre.", nature: "technical", financialScope: "none", product: "Limova", feature: "agent téléphone", evidenceIds: ["evidence-1"] }],
    knownFacts: [], attemptedSteps: [], missingInformation: [],
    evidence: [{ id: "evidence-1", source: "current_message", sourceId: "current_body", excerpt: "L’agent téléphone cesse de répondre." }], uncertainties: [],
    trace: { contractRevision: SAV_UNDERSTANDING_REVISION, promptRevision: SAV_UNDERSTANDING_PROMPT_REVISION, model: "fixture-model", inputHash: "fixture-input-hash", codeRevision: null, durationMs: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30, errorCode: null },
    ...overrides };
}
export function understandingContent(u = understandingFixture()): SavUnderstandingContent {
  const { trace, ...content } = u;
  void trace;
  return content;
}
export function coverageFixture(u = understandingFixture()): SavReplyCoverage {
  return u.requests.map(request => ({ requestId: request.id, text: `L’équipe doit vérifier votre demande : ${request.summary}`, kind: "handoff", sourceIds: [], missingInformationIds: [], repeatedAttemptIds: [], repeatJustification: "" }));
}
export function geminiFixture(value: unknown) {
  return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
}
