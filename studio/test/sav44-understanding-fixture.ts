import type { SavUnderstandingV1 } from "../src/lib/sav/understanding";
export function sav44Understanding(): SavUnderstandingV1 {
  return { version: 1, status: "qualified", language: "fr", primaryRequestId: "request-1",
    requests: [{ id: "request-1", summary: "L’export du document échoue malgré une nouvelle tentative.", nature: "technical", financialScope: "none", product: "Produit fictif", feature: "Export", evidenceIds: ["evidence-1"] }],
    knownFacts: [{ id: "fact-1", key: "format", text: "Le document est au format PDF.", evidenceIds: ["evidence-1"] }],
    attemptedSteps: [{ id: "attempt-1", key: "retry", text: "Le client a déjà relancé l’export.", evidenceIds: ["evidence-1"] }],
    missingInformation: [{ id: "missing-1", key: "error", text: "Le message d’erreur exact manque.", requestIds: ["request-1"] }],
    evidence: [{ id: "evidence-1", source: "current_message", sourceId: "synthetic-message", excerpt: "L’export PDF échoue encore après une nouvelle tentative." }], uncertainties: [],
    trace: { contractRevision: "synthetic-contract", promptRevision: "synthetic-prompt", model: "synthetic-model", inputHash: "synthetic-input", codeRevision: "a".repeat(40), durationMs: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, errorCode: null } };
}
