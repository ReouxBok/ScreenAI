import { savStructuredProposalSchema } from "../src/lib/sav/proposal";
import { sav44Understanding } from "./sav44-understanding-fixture";
import { buildSavRegistrationClarification } from "../src/lib/sav/registration-identity";

// Explicitly public, synthetic and local-only. Never use this key outside this harness.
export const SAV_SEMANTIC_E2E_KEY = "local-only-sav-semantic-e2e-fixture-key-2026";
export const SAV_SEMANTIC_E2E_THREAD = "00000000-0000-4000-8000-000000000043";
export const SAV_REGISTRATION_E2E_THREAD = "00000000-0000-4000-8000-000000000079";
export const SAV_SEMANTIC_E2E_BODY = "L’export PDF échoue encore après une nouvelle tentative. Une capture est jointe.";
export const SAV_SEMANTIC_E2E_DRAFT = "Bonjour, quel message d’erreur voyez-vous lors de l’export PDF ?";
export function savSemanticE2eProposal() {
  const understanding = sav44Understanding();
  understanding.uncertainties = [{ code: "unread_attachment", requestIds: ["request-1"] }];
  return savStructuredProposalSchema.parse({
    schemaVersion: 1, category: "technical", urgency: "normal",
    decision: { kind: "human_review_required", reasonCode: "fixture_semantic_request", explanation: "L’export PDF échoue malgré une nouvelle tentative. Le message d’erreur doit être confirmé humainement.", confidence: 0 },
    routing: { kind: "new", reason: "fixture_existing_contact", contactId: "999001" },
    ticket: { title: "Échec export PDF fictif", description: SAV_SEMANTIC_E2E_BODY },
    process: [{ kind: "human_review", label: "Vérifier le contexte de l’export avant de proposer une action.", sourceIds: [] }],
    internalNote: "Cas synthétique local uniquement. Aucune intégration externe.", replyDraft: SAV_SEMANTIC_E2E_DRAFT,
    sources: [], knowledgeRevision: "not_consulted", model: "synthetic-e2e-model", understanding,
    replyAssessment: { kind: "contextualized", errorCode: null, coverage: [{ requestId: "request-1", text: SAV_SEMANTIC_E2E_DRAFT, kind: "clarification", sourceIds: [], missingInformationIds: ["missing-1"], repeatedAttemptIds: [], repeatJustification: "" }] },
  });
}

export function savRegistrationE2eProposal() {
  const p = savSemanticE2eProposal();
  const reply = buildSavRegistrationClarification(p.understanding!, "not_found", { email: null, ambiguous: false });
  return savStructuredProposalSchema.parse({ ...p,
    decision: { ...p.decision, reasonCode: "registration_email_required", explanation: "Identifier le compte par son email d’inscription avant toute proposition d’action sur celui-ci." },
    routing: { kind: "review", reason: "customer_identity_unverified", candidateIds: [] },
    understanding: reply.understanding, replyDraft: reply.replyDraft,
    replyAssessment: { kind: "contextualized", coverage: reply.coverage, errorCode: null },
  });
}
