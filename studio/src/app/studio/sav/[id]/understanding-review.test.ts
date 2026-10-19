import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { v0Proposal } from "../../../../../test/sav-v0-review-fixture";
import { sav44Understanding } from "../../../../../test/sav44-understanding-fixture";
vi.mock("../actions", () => ({ reviewProposalAction: vi.fn(), saveHumanDraftAction: vi.fn(), reviewDraftAction: vi.fn(), sendStudioReplyAction: vi.fn(), sendSuggestedReplyAction: vi.fn() }));
import { UnderstandingReview } from "./understanding-review";
import { ProposalReview } from "./proposal-review";
import { DraftReview } from "./draft-review";
const original = { ...v0Proposal(), category: "billing" as const, understanding: sav44Understanding() };
const data = () => ({ before: original, proposal: { ...original, category: "technical" as const }, decisionId: "synthetic-decision", agentRunId: "synthetic-run", model: "synthetic-model", promptRevision: "synthetic-prompt", expectedReviewId: null, draftHash: "x".repeat(43), draftVerdict: null, historicalReview: null, review: null });
describe("SAV44 original understanding and independent feedback forms", () => {
  it("shows original/corrected category, sourced meaning, known facts and missing information without a confidence score", () => {
    const html = renderToStaticMarkup(createElement(UnderstandingReview, { original, corrected: { ...original, category: "technical" } }));
    for (const text of ["Compréhension initiale de l’IA", "Demande principale", "L’export", "Catégorie IA d’origine", "Catégorie corrigée humainement", "PDF", "Déjà essayé par le client", "Le message d’erreur exact manque", "Message actuel"]) expect(html).toContain(text);
    expect(html).not.toMatch(/%|[Cc]onfiance/);
  });
  it("distinguishes provider unavailability, ambiguity and missing historical contract", () => {
    const unavailable = { ...original, understanding: { ...original.understanding, status: "unavailable" as const, primaryRequestId: null, requests: [], uncertainties: [{ code: "provider_unavailable" as const, requestIds: [] }] } };
    expect(renderToStaticMarkup(createElement(UnderstandingReview, { original: unavailable, corrected: unavailable }))).toContain("Le fournisseur IA est indisponible");
    const ambiguous = { ...original, understanding: { ...original.understanding, status: "needs_clarification" as const, uncertainties: [{ code: "ambiguous_intent" as const, requestIds: ["request-1"] }] } };
    expect(renderToStaticMarkup(createElement(UnderstandingReview, { original: ambiguous, corrected: ambiguous }))).toContain("Demande à qualifier");
    expect(renderToStaticMarkup(createElement(UnderstandingReview, { original: v0Proposal(), corrected: v0Proposal() }))).toContain("Analyse historique");
  });
  it("keeps dossier correction, feedback and knowledge proposal explicit without editable draft", () => {
    const html = renderToStaticMarkup(createElement(ProposalReview, { data: data(), threadId: "synthetic-thread", messageId: "synthetic-message" }));
    expect(html).toContain('name="reasons" value="wrong_category"'); expect(html).toContain("Mauvaise compréhension");
    expect(html).toContain("ne crée aucune connaissance produit"); expect(html).toContain('name="category"');
    expect(html).not.toContain('name="replyDraft"'); expect(html).toContain("Valider le dossier");
  });
  it("shows standard origin and rejected coherence separately from acceptance and sending", () => {
    const props: ComponentProps<typeof DraftReview> = { data: { ...data(), proposal: { ...original, replyAssessment: { kind: "human_handoff", coverage: [], errorCode: null, coherence: { status: "rejected", issues: ["off_topic"], promptRevision: "synthetic", model: "synthetic", inputHash: "synthetic", outputHash: "synthetic", durationMs: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, errorCode: "SYNTHETIC" } } } }, threadId: "synthetic-thread", messageId: "synthetic-message", drafts: { knowledgeRevision: "synthetic", versions: [] }, sendAllowed: true };
    const html = renderToStaticMarkup(createElement(DraftReview, props));
    expect(html).toContain("Passage à un humain"); expect(html).toContain("contrôle de cohérence a refusé");
    expect(html).toContain('name="reasons" value="off_topic"'); expect(html).not.toContain("Accepter cette version"); expect(html).toContain("Feedback facultatif");
    expect(html).toContain('disabled="">Confirmer l’envoi de cette réponse'); expect(html).not.toContain('name="replyDraft"');
  });
});
