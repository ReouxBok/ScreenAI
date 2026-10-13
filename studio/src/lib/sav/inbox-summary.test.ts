import { afterEach, describe, expect, it, vi } from "vitest";
import { v0Proposal } from "../../../test/sav-v0-review-fixture";
import { understandingFixture } from "../../../test/sav-understanding-fixtures";
import { buildSavInboxSummary, savInboxSubject } from "./inbox-summary";

function input() {
  const proposal = { ...v0Proposal(), understanding: understandingFixture() };
  return { subject: "Re: Re: Ancien sujet", analysisStatus: "done", analysisErrorCode: null,
    proposal, originalProposal: proposal, reviewStatus: null, hubspotTicketId: null };
}
afterEach(() => vi.unstubAllGlobals());

describe("SAV-53 inbox presentation", () => {
  it.each([
    ["Re: Re : Fwd:  TR:  Demande   téléphonie", "Demande téléphonie"],
    ["Rép: Aw: Sv: Réponse client", "Réponse client"],
    ["Re:  ", "Email sans objet"],
    ["Réparer la téléphonie", "Réparer la téléphonie"],
  ])("cleans display subjects without rewriting content: %s", (subject, expected) => expect(savInboxSubject(subject)).toBe(expected));

  it("uses the current semantic topic, problem and separate proposed action without AI", () => {
    const fetch = vi.fn(() => { throw new Error("NETWORK_FORBIDDEN"); }); vi.stubGlobal("fetch", fetch);
    const source = input(), before = JSON.stringify(source);
    expect(buildSavInboxSummary(source)).toMatchObject({ title: "Problème technique : Limova · agent téléphone", problem: "L’agent téléphone cesse de répondre.", nextAction: "Valider le dossier puis ouvrir le ticket proposé.", sourceLabel: "Synthèse de la demande" });
    expect(JSON.stringify(source)).toBe(before); expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves all requests and the human-only policy of a mixed financial request", () => {
    const source = input();
    source.proposal.understanding.requests.push({ ...source.proposal.understanding.requests[0], id: "refund", nature: "financial_operation", financialScope: "support_account", summary: "Demande aussi le remboursement du compte." });
    const result = buildSavInboxSummary(source);
    expect(result.problem).toContain("cesse de répondre"); expect(result.problem).toContain("remboursement du compte");
    expect(result.additionalRequests).toBe(1); expect(result.nextAction).toContain("prise en charge humaine");
  });

  it("suggests the dedicated partnership preview while keeping mixed financial requests human-led", () => {
    const source = input(); source.proposal.understanding.requests[0].nature = "partnership";
    expect(buildSavInboxSummary(source).nextAction).toContain("transfert à Nathan");
    source.proposal.understanding.requests.push({ ...source.proposal.understanding.requests[0], id: "refund", nature: "financial_operation", financialScope: "support_account" });
    expect(buildSavInboxSummary(source).nextAction).toContain("prise en charge humaine");
  });

  it("retains a reliable understanding when composition is degraded", () => {
    const result = buildSavInboxSummary({ ...input(), analysisErrorCode: "SAV_REPLY_COHERENCE_REJECTED" });
    expect(result.problem).toBe("L’agent téléphone cesse de répondre."); expect(result.nextAction).toContain("vérifier la proposition");
    expect(result.problem).not.toContain("SAV_");
  });

  it("does not turn a timeout or old email object into a semantic summary", () => {
    const result = buildSavInboxSummary({ ...input(), proposal: null, originalProposal: null, analysisErrorCode: "SAV_AI_TIMEOUT" });
    expect(result).toMatchObject({ title: "Ancien sujet", sourceLabel: "Objet de l’email", problem: "Aucun résumé fiable disponible. Le message doit être relu." });
    expect(result.nextAction).toContain("qualifier");
  });

  it("keeps an ambiguous current understanding visibly unqualified", () => {
    const source = input(); source.proposal.understanding.status = "needs_clarification";
    const result = buildSavInboxSummary(source);
    expect(result.sourceLabel).toBe("Objet de l’email"); expect(result.problem).toContain("reste à clarifier"); expect(result.nextAction).toContain("qualification");
  });

  it("uses explicit current human corrections and their no-ticket decision", () => {
    const source = input(); const corrected = { ...source.proposal, ticket: { title: "Simple confirmation du client", description: "Le client remercie l’équipe ; aucune demande supplémentaire." }, decision: { ...source.proposal.decision, kind: "no_ticket_needed" } };
    expect(buildSavInboxSummary({ ...source, proposal: corrected, reviewStatus: "approved" })).toMatchObject({ title: corrected.ticket.title, problem: corrected.ticket.description, sourceLabel: "Dossier corrigé", nextAction: "Vérifier qu’aucune suite n’est nécessaire." });
  });

  it("does not promote a refused proposal to an executable suggestion", () => {
    expect(buildSavInboxSummary({ ...input(), reviewStatus: "rejected" })).toMatchObject({ sourceLabel: "Synthèse à corriger", nextAction: "Corriger le dossier avant de poursuivre." });
  });

  it("keeps a full statement when no precise feature is known, including negation", () => {
    const source = input(); source.proposal.understanding.requests[0].feature = null;
    source.proposal.understanding.requests[0].summary = "Le client ne demande pas de résiliation, mais une aide pour le téléphone.";
    expect(buildSavInboxSummary(source).title).toBe(source.proposal.understanding.requests[0].summary);
  });
});
