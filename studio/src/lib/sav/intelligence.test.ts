import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSavMessage } from "./intelligence";

const dependencies = vi.hoisted(() => ({ search: vi.fn(), agent: vi.fn(), crm: vi.fn() }));
vi.mock("@/lib/search", () => ({ searchKnowledge: dependencies.search }));
vi.mock("./agent/orchestrator", () => ({ runSavAdkAgent: dependencies.agent }));
vi.mock("./hubspot", () => ({ readSavHubspotContext: dependencies.crm }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("SAV analysis controls", () => {
  it.each(["off", "shadow", "pilot", "on"])("financial requests use only a standard draft and no model/knowledge search in %s", async mode => {
    vi.stubEnv("SAV_ADK_MODE", mode); vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    dependencies.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "no_contact" } });
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    for (const body of ["Quel est le montant de ma facture ?", "Mon agent tel marche pas et je veux un remboursement"]) {
      const result = await analyzeSavMessage({ from: "client@example.com", subject: "Support", body });
      expect(result).toMatchObject({ category: "billing", model: "rules-v1", proposal: { reasonCode: "finance_human_only", requiresHumanApproval: true } });
      expect(result.replyDraft).toContain("Les questions financières sont traitées par l’équipe Limova");
      expect(result.replyDraft).not.toMatch(/Quelle adresse email|Charly|IA|3 jours|remboursé|vérifié votre/);
      expect(result.structuredProposal?.process.some(step => step.kind === "product_step")).toBe(false);
    }
    expect(dependencies.agent).not.toHaveBeenCalled(); expect(dependencies.search).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it.each(["off", "on"])("keeps a contextual sourced draft under human review and ambiguous CRM routing in %s", async mode => {
    vi.stubEnv("SAV_ADK_MODE", mode); vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    const quote = "Dans Paramètres, ouvrez Facturation pour accéder aux factures.";
    const output = { category: "how_to", urgency: "normal", ticketRequired: true, reasonCode: "invoice_navigation",
      explanation: "Le client veut retrouver ses factures, procédure disponible et dossier à vérifier.", confidence: 0.99,
      requiresHuman: true, responseKind: "solution", replyDraft: `Bonjour, voici comment retrouver vos factures. ${quote}`, internalNote: "Demande de navigation vers les factures.",
      evidenceIds: ["card"], citations: [{ sourceId: "card", claim: "Accès aux factures", quote }] };
    const evidence = [{ sourceType: "knowledge", sourceId: "card", title: "Retrouver les factures", score: 0.9, excerpt: quote, claim: "Accès aux factures" }];
    dependencies.search.mockResolvedValue({ revision: "fixture", results: [{ id: "card", title: "Retrouver les factures", content: quote, verifiedAt: new Date().toISOString(), score: 0.9, resolution: { steps: [quote] } }] });
    dependencies.crm.mockResolvedValue({ contactFound: true, contactId: "31", tickets: [], routing: { kind: "ambiguous", reason: "multiple_exact_subjects", candidateIds: ["1", "2"] } });
    dependencies.agent.mockResolvedValue({ output, evidence, knowledgeRevision: "fixture", model: "fixture", ticketRouting: { kind: "review", reason: "multiple_exact_subjects", candidateIds: ["1", "2"] } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] })));
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Facturation", body: "Où télécharger mes factures ?" });
    expect(result.replyDraft).toBe(output.replyDraft);
    expect(result.proposal.requiresHumanApproval).toBe(true);
    expect(result.ticketRouting?.kind).toBe("review");
    expect(result.structuredProposal?.process.some(step => step.kind === "product_step" && step.sourceIds.includes("card"))).toBe(true);
    expect(result.structuredProposal?.process.some(step => ["create_ticket", "link_ticket"].includes(step.kind))).toBe(false);
    expect(result.replyDraft).not.toMatch(/Charly|IA|3 jours|instantanée/);
  });
  it("prepares the financial standard in English without a model or registration question", async () => {
    vi.stubEnv("SAV_ADK_MODE", "on"); vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    dependencies.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "fixture" } });
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Payment", body: "Hello, I was charged twice. Please refund my payment." });
    expect(result.replyDraft).toContain("Financial matters are handled by the Limova team");
    expect(result.replyDraft).not.toMatch(/Which email address|Bonjour|Charly|3 days/);
    expect(dependencies.agent).not.toHaveBeenCalled(); expect(dependencies.search).not.toHaveBeenCalled();
  });
  it("keeps an English targeted clarification without requiring a manufactured citation", async () => {
    vi.stubEnv("SAV_ADK_MODE", "off"); vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    dependencies.search.mockResolvedValue({ revision: "fixture", results: [] });
    dependencies.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "fixture" } });
    const draft = "Hello, I noted your request for 3 users and your availability Tuesday at 14:00. Which error do you see when inviting the users?";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ category: "account", urgency: "normal", ticketRequired: true,
      reasonCode: "invitation_details", explanation: "Invitation error missing, account email already supplied.", confidence: 0.99, requiresHuman: true,
      responseKind: "clarification", replyDraft: draft, internalNote: "Needs 3 users, available Tuesday at 14:00.", citations: [] }) }] } }] })));
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Account", body: "Hello, how can I invite 3 users? I am available Tuesday at 14:00. Account email: account@example.invalid" });
    expect(result.replyDraft).toBe(draft);
    expect(result.replyDraft).not.toContain("Which email address");
    expect(result.proposal.requiresHumanApproval).toBe(true);
  });
  it("does not show an ungrounded solution just because the model asked for human review", async () => {
    vi.stubEnv("SAV_ADK_MODE", "off"); vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    dependencies.search.mockResolvedValue({ revision: "fixture", results: [] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ category: "technical", urgency: "normal", ticketRequired: true,
      reasonCode: "invented_solution", explanation: "Unverified technical advice requiring review.", confidence: 0.99, requiresHuman: true,
      responseKind: "solution", replyDraft: "Invented fix: click the nonexistent magic button.", internalNote: "", citations: [] }) }] } }] })));
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Bug", body: "Mon agent téléphonique ne fonctionne plus, comment vérifier mes crédits ?" });
    expect(dependencies.search).toHaveBeenCalled();
    expect(result.replyDraft).not.toContain("magic button");
    expect(result.diagnostics).toContainEqual({ phase: "generation", errorCode: "SAV_UNGROUNDED_REPLY" });
  });
  it.each(["off", "shadow", "pilot", "on"])("a thank-you with an old cancellation does not consult CRM or a model in %s", async mode => {
    vi.stubEnv("SAV_ADK_MODE", mode); vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Re: Résiliation", body: "Merci !\n\nLe mardi, Charly a écrit :\nJe veux résilier mon abonnement." });
    expect(result.proposal).toMatchObject({ kind: "no_ticket_needed", reasonCode: "simple_acknowledgement" });
    expect(result.replyDraft).toBeNull();
    expect(result.structuredProposal?.messageContext?.quotedText).toContain("résilier");
    expect(dependencies.crm).not.toHaveBeenCalled(); expect(dependencies.agent).not.toHaveBeenCalled(); expect(dependencies.search).not.toHaveBeenCalled();
  });
  it.each([
    { from: "robot@mailinblack.com", subject: "Vérification", body: "Veuillez authentifier votre adresse expéditeur." },
    { from: "sales@example.com", subject: "Nos services", body: "Nous vous proposons des services de marketing." },
    { from: "partner@example.com", subject: "Partenariat", body: "Je souhaite un partenariat avec Limova." },
    { from: "prospect@example.com", subject: "Tarifs", body: "Quels sont vos tarifs ?" },
  ])("does not ask for a registration address or propose a ticket for non-support: %s", async input => {
    vi.stubEnv("SAV_ADK_MODE", "on"); vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    const result = await analyzeSavMessage(input);
    expect(result.proposal.requiresHumanApproval).toBe(true);
    expect(result.ticketRouting?.kind).toBe("none"); expect(result.replyDraft).toBeNull();
    expect(result.structuredProposal?.process.some(step => ["create_ticket", "link_ticket", "review_reply"].includes(step.kind))).toBe(false);
    expect(dependencies.crm).not.toHaveBeenCalled(); expect(dependencies.agent).not.toHaveBeenCalled(); expect(dependencies.search).not.toHaveBeenCalled();
  });
  it("uses current signature identity hints, never a quoted third-party phone", async () => {
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    dependencies.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "fixture" } });
    await analyzeSavMessage({ from: "client@example.com", subject: "Compte", body: "Comment retrouver mon compte ?\n-- \nTéléphone : 0612345678\nOn Tuesday, Someone wrote:\nNom : Personne Tierce\nTéléphone : 0698765432" });
    expect(dependencies.crm).toHaveBeenCalledWith(expect.objectContaining({ identityHints: { names: [], phones: ["0612345678"] } }));
  });
  it("does not re-ask a supplied account email or silently confirm it as a CRM identity", async () => {
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    dependencies.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "fixture" } });
    const result = await analyzeSavMessage({ from: "other@example.com", subject: "Compte", body: "Comment retrouver mes factures ?\nEmail du compte : account@example.invalid" });
    expect(result.replyDraft).not.toContain("Quelle adresse email");
    expect(result.structuredProposal?.customerIdentity.verifiedByHuman).toBe(false);
    expect(result.structuredProposal?.routing).toMatchObject({ kind: "review", reason: "customer_identity_unverified" });
    expect(result.structuredProposal?.messageContext?.facts).toContainEqual({ kind: "registration_email", excerpt: "Email du compte : account@example.invalid", line: 2 });
  });
  it.each(["off", "shadow", "pilot", "on"])("cancellation never produces an AI draft, including missing CRM identity, in %s", async (mode) => {
    vi.stubEnv("SAV_ADK_MODE", mode); vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    dependencies.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "no_contact" } });
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Résiliation", body: "Je souhaite résilier mon abonnement." });
    expect(result.proposal).toMatchObject({ reasonCode: "cancellation_human_only", requiresHumanApproval: true });
    expect(result.replyDraft).toBeNull(); expect(result.structuredProposal?.replyDraft).toBeNull();
    expect(result.structuredProposal?.process.some(step => step.kind === "review_reply")).toBe(false);
    expect(dependencies.agent).not.toHaveBeenCalled(); expect(dependencies.search).not.toHaveBeenCalled();
  });
  it.each(["off", "shadow", "pilot", "on"])("non-support mail bypasses models and CRM in %s", async (mode) => {
    vi.stubEnv("SAV_ADK_MODE", mode);
    vi.stubEnv("SAV_AI_ANALYSIS", "true");
    vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    for (const input of [
      { subject: "Re: aide", body: "Merci beaucoup !" },
      { subject: "Rapport", body: "Retour lundi", autoSubmitted: "auto-replied" },
    ]) {
      const result = await analyzeSavMessage({ from: "client@example.com", ...input });
      expect(result.proposal.kind).toMatch(/^(?:no_ticket_needed|automatic_reply)$/);
      expect(result.replyDraft).toBeNull();
    }
    expect(dependencies.agent).not.toHaveBeenCalled();
    expect(dependencies.search).not.toHaveBeenCalled();
    expect(dependencies.crm).not.toHaveBeenCalled();
  });
  it("requires explicit review for an ambiguous HubSpot association", async () => {
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    dependencies.crm.mockResolvedValue({ contactFound: true, contactId: "c1", tickets: [], routing: { kind: "ambiguous", reason: "multiple_exact_subjects", candidateIds: ["1", "2"] } });
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Utilisation", body: "Comment changer la couleur ?" });
    expect(result.structuredProposal?.routing).toEqual({ kind: "review", reason: "multiple_exact_subjects", candidateIds: ["1", "2"] });
    expect(result.structuredProposal?.process.some((step) => ["create_ticket", "link_ticket"].includes(step.kind))).toBe(false);
    expect(result.proposal.requiresHumanApproval).toBe(true);
  });
  it("does not silently accept a missing mandatory analysis trace", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(analyzeSavMessage({ from: "client@example.com", subject: "Re: aide", body: "Merci !" }, { messageId: "unavailable" })).rejects.toThrow("SAV_ANALYSIS_TRACE_REQUIRED");
    logger.mockRestore();
  });
  it.each([false, true])("scans unknown senders and asks for the registration email only without a candidate: %s", async (hasCandidate) => {
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    const identityCandidates = hasCandidate ? [{ contactId: "31", name: "Jeanne Martin", email: "compte@example.com", phoneHint: "…5678", matchedBy: "phone", confirmed: false }] : [];
    dependencies.crm.mockResolvedValue({ contactFound: false, identityCandidates, tickets: [], routing: { kind: "new", reason: "no_contact" } });
    const result = await analyzeSavMessage({ from: "autre@example.com", displayName: "Jeanne Martin", subject: "Compte", body: "Comment retrouver mon compte ? Téléphone : 0612345678" });
    expect(dependencies.crm).toHaveBeenCalledWith(expect.objectContaining({ identityHints: { names: ["Jeanne Martin"], phones: ["0612345678"] } }));
    expect(result.proposal.requiresHumanApproval).toBe(true);
    expect(result.structuredProposal?.identityCandidates).toEqual(identityCandidates);
    expect(result.structuredProposal?.customerIdentity.verifiedByHuman).toBe(false);
    if (hasCandidate) expect(result.replyDraft).not.toContain("Quelle adresse email");
    else expect(result.replyDraft).toContain("Quelle adresse email utilisez-vous pour votre compte Limova");
  });
  it.each(["off", "shadow", "pilot", "on"])("disabling AI prevents both engines and embeddings in %s", async (mode) => {
    vi.stubEnv("SAV_ADK_MODE", mode);
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    const network = vi.fn(() => { throw new Error("No network expected"); });
    vi.stubGlobal("fetch", network);
    const analysis = await analyzeSavMessage({ from: "client@example.com", subject: "Utilisation", body: "Comment changer la couleur ?" });
    expect(analysis.model).toBe("rules-v1");
    expect(dependencies.agent).not.toHaveBeenCalled();
    expect(dependencies.search).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("a successful, confident legacy fallback cannot authorize an autonomous answer", async () => {
    vi.stubEnv("SAV_ADK_MODE", "on");
    vi.stubEnv("SAV_AI_ANALYSIS", "true");
    vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    dependencies.agent.mockRejectedValue(new Error("SAV_REQUIRED_TOOL_UNAVAILABLE"));
    dependencies.search.mockResolvedValue({ revision: "fixture", results: [{ id: "card", title: "Procédure", content: "Procédure", score: 0.9 }] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      category: "how_to", urgency: "normal", ticketRequired: true, reasonCode: "known_procedure",
      explanation: "La procédure correspond au problème.", confidence: 0.99, requiresHuman: false,
      replyDraft: "Voici la procédure.", internalNote: "Procédure connue.",
    }) }] } }] })));
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Utilisation", body: "Comment changer la couleur ?" });
    expect(result.proposal).toMatchObject({ kind: "human_review_required", requiresHumanApproval: true, reasonCode: "agent_runtime_degraded" });
    expect(result.replyDraft).not.toContain("Voici la procédure.");
  });
});
