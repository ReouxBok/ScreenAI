import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeSavMessage, type SavEvaluationResources } from "./intelligence";
import { defaultSavPlaybook } from "./playbook-contract";
import { savSemanticPlan, type SavUnderstandingV1 } from "./understanding";
import { coverageFixture, geminiFixture, understandingFixture, understandingContent } from "../../../test/sav-understanding-fixtures";
import type { SavAgentOutput } from "./agent/contracts";

const deps = vi.hoisted(() => ({ search: vi.fn(), agent: vi.fn(), crm: vi.fn(), understand: vi.fn(), coherence: vi.fn(), playbook: vi.fn(), retrieval: vi.fn() }));
vi.mock("./playbook", () => ({ readActiveSavPlaybook: deps.playbook }));
vi.mock("./request-retrieval-db", () => ({ searchSavKnowledgeByRequest: deps.retrieval }));
vi.mock("@/lib/search", () => ({ searchKnowledge: deps.search }));
vi.mock("./agent/orchestrator", () => ({ runSavAdkAgent: deps.agent }));
vi.mock("./hubspot", () => ({ readSavHubspotContext: deps.crm }));
vi.mock("./understanding-model", () => ({ understandSavMessage: deps.understand }));
vi.mock("./reply-coherence", () => ({ checkSavReplyCoherence: deps.coherence }));

const modes = ["off", "shadow", "pilot", "on"] as const;
const input = { from: "fixture@example.invalid", subject: "Re: Résiliation", body: "Je ne veux pas résilier. Mon agent coupe après mon achat à 79 euros.\nOn Tuesday, Support wrote:\nJe veux un remboursement." };
function outputFor(u: SavUnderstandingV1) {
  const coverage = coverageFixture(u);
  return { category: savSemanticPlan(u).category, urgency: "normal", ticketRequired: true, reasonCode: "fixture_support", explanation: "Le problème produit doit être vérifié.", confidence: 0.99, requiresHuman: true,
    responseKind: "handoff", replyDraft: coverage.map(c => c.text).join("\n\n"), internalNote: "Dossier fictif à vérifier.", coverage, citations: [] as SavAgentOutput["citations"], evidenceIds: [] };
}
function adkResult(u: SavUnderstandingV1) {
  return { output: outputFor(u), evidence: [], toolTrace: [], model: "fixture-model", promptRevision: "fixture-prompt", inputHash: "fixture-in", outputHash: "fixture-out", durationMs: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30, knowledgeRevision: "fixture-kb", ticketRouting: { kind: "new", contactId: "fixture-contact", reason: "fixture" } };
}
function coherence(status = "passed") {
  return { status, issues: status === "rejected" ? ["unsupported_advice"] : [], promptRevision: "fixture-coherence", model: "fixture-model", inputHash: "fixture-in", outputHash: status === "unavailable" ? null : "fixture-out", durationMs: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30, errorCode: status === "passed" ? null : status === "rejected" ? "SAV_REPLY_COHERENCE_REJECTED" : "SAV_AI_HTTP_500" };
}
function evaluation(mode: typeof modes[number], network: typeof fetch): SavEvaluationResources {
  return { apiKey: "fixture-key", model: "fixture-model", mode, pilot: mode === "pilot", searchKnowledge: deps.search, readHubspotContext: deps.crm, fetch: network };
}
beforeEach(() => {
  deps.playbook.mockResolvedValue({ versionId: "fixture-playbook", version: 1, document: defaultSavPlaybook });
  deps.retrieval.mockImplementation(async input => ({ contractRevision: "fixture", revision: "fixture-kb", requests: input.requests.map((r: { id: string }) => ({ requestId: r.id, status: "no_source", candidateKeys: [], limitations: [] })), sources: [], alerts: [], metrics: { attempts: 1, queryCount: 1, embeddingBatchesUpperBound: 1, serializedBytes: 100, contextTextTokensUpperBound: 100 } }));
  vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture-key");
  deps.search.mockResolvedValue({ revision: "fixture-kb", results: [] });
  deps.crm.mockResolvedValue({ contactFound: true, contactId: "fixture-contact", tickets: [], routing: { kind: "new", reason: "fixture" } });
  deps.coherence.mockResolvedValue(coherence());
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external request"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("SAV registration prerequisite before product composition", () => {
  const absent = { contactFound: false, contactId: undefined, errorCode: null, identityCandidates: [], tickets: [], routing: { kind: "new", reason: "no_contact" } };
  it.each(modes)("asks for registration email before any product plan in %s", async mode => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u); deps.crm.mockResolvedValue(absent);
    const network = vi.fn();
    const result = await analyzeSavMessage({ from: "sender@example.invalid", subject: "Activation", body: "L’agent téléphone cesse de répondre." }, { evaluation: evaluation(mode, network) });
    expect(result.proposal.reasonCode).toBe("registration_email_required");
    expect(result.replyDraft).toContain("adresse email utilisée lors de votre inscription");
    expect(result.replyAssessment).toMatchObject({ kind: "contextualized", coherence: { status: "passed" } });
    expect(result.understanding?.requests).toEqual(u.requests);
    expect(result.structuredProposal?.process.every(p => !["product_step", "create_ticket", "link_ticket"].includes(p.kind))).toBe(true);
    expect(result.structuredProposal?.customerIdentity.verifiedByHuman).toBe(false);
    expect(deps.agent).not.toHaveBeenCalled(); expect(deps.search).not.toHaveBeenCalled(); expect(deps.retrieval).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    expect(deps.coherence).toHaveBeenCalledOnce(); expect(deps.crm).toHaveBeenCalledOnce();
  });
  it.each(["403", "429", "timeout", "SAV_HUBSPOT_TICKETS_TRUNCATED"])("never translates a %s failure into customer absence", async code => {
    deps.understand.mockResolvedValue(understandingFixture()); deps.crm.mockRejectedValue(new Error(code));
    const result = await analyzeSavMessage({ from: "sender@example.invalid", subject: "Support", body: "Demande fictive" }, { evaluation: evaluation("off", vi.fn()) });
    expect(result.proposal.reasonCode).toBe("registration_lookup_unavailable");
    expect(result.replyDraft).not.toMatch(/aucun|retrouv|inscription|\?/);
    expect(result.ticketRouting).toMatchObject({ kind: "review", reason: "hubspot_context_unavailable" });
  });
  it("reuses an evidenced address once, reads its context before final understanding and keeps human identity confirmation", async () => {
    const body = "L’agent téléphone cesse de répondre. Mon email d’inscription est account@example.invalid";
    const u = understandingFixture(); u.evidence[0].excerpt = body;
    u.knownFacts = [{ id: "reg", key: "registration_email", text: "account@example.invalid", evidenceIds: [u.evidence[0].id] }];
    deps.understand.mockResolvedValue(u);
    deps.crm.mockResolvedValueOnce(absent).mockResolvedValueOnce({ ...absent, contactFound: true, contactId: "correct-account", contactName: "Compte fictif" });
    const source = { from: "sender@example.invalid", subject: "Support", body };
    const network = vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)));
    const result = await analyzeSavMessage(source, { evaluation: evaluation("off", network) });
    expect(deps.crm).toHaveBeenCalledTimes(2);
    expect(deps.crm).toHaveBeenLastCalledWith(expect.objectContaining({ email: "account@example.invalid", includeHistory: true, toleratePartial: true }));
    expect(deps.crm.mock.calls[1][0]).not.toHaveProperty("currentTicketId");
    expect(deps.understand).toHaveBeenCalledTimes(2);
    expect(deps.understand.mock.calls[1][0].dossierContext.crm.data.contactId).toBe("correct-account");
    expect(result.structuredProposal?.customerIdentity).toEqual({ registrationEmail: "account@example.invalid", verifiedByHuman: false });
    expect(result.ticketRouting).toMatchObject({ kind: "review", reason: "registration_email_confirmation_required" });
    expect(result.structuredProposal?.process.some(p => p.kind === "create_ticket" || p.kind === "link_ticket")).toBe(false);
    expect(result.replyDraft).not.toContain("adresse email utilisée lors de votre inscription");
    expect(source.from).toBe("sender@example.invalid");
  });
  it("asks to verify a provided but unmatched address rather than requesting it again", async () => {
    const body = "Mon email d’inscription est account@example.invalid";
    const u = understandingFixture(); u.evidence[0].excerpt = body;
    u.knownFacts = [{ id: "reg", key: "registration_email", text: "account@example.invalid", evidenceIds: [u.evidence[0].id] }];
    deps.understand.mockResolvedValue(u); deps.crm.mockResolvedValue(absent);
    const result = await analyzeSavMessage({ from: "sender@example.invalid", subject: "Support", body }, { evaluation: evaluation("off", vi.fn()) });
    expect(deps.crm).toHaveBeenCalledTimes(2); expect(deps.understand).toHaveBeenCalledOnce();
    expect(result.replyDraft).toContain("vérifier l’adresse d’inscription indiquée");
    expect(result.replyDraft).not.toContain("préciser l’adresse email utilisée");
  });
  it("reuses an explicit address in the same customer's inbound history", async () => {
    const text = "Mon email d’inscription est account@example.invalid";
    const u = understandingFixture();
    u.evidence.push({ id: "history-reg", source: "history", sourceId: "message:old-inbound", excerpt: text });
    u.knownFacts = [{ id: "reg", key: "registration_email", text: "account@example.invalid", evidenceIds: ["history-reg"] }];
    deps.understand.mockResolvedValue(u); deps.crm.mockResolvedValue(absent);
    await analyzeSavMessage({ from: "sender@example.invalid", subject: "Support", body: "Mon agent ne répond pas.",
      conversation: { threadId: "fixture", currentMessageId: "new-inbound", hubspotTicketId: null, status: "new", aiPaused: false, senderMatchesCustomer: true,
        messages: [{ id: "old-inbound", direction: "inbound", from: "sender@example.invalid", receivedAt: "2026-10-18T10:00:00.000Z", text, truncated: false }], olderSummary: [], historyTruncated: false, attachmentNotice: "Non lues" } }, { evaluation: evaluation("off", vi.fn()) });
    expect(deps.crm).toHaveBeenCalledTimes(2);
    expect(deps.crm).toHaveBeenLastCalledWith(expect.objectContaining({ email: "account@example.invalid" }));
  });
  it("does not use another participant's registration address", async () => {
    const text = "Mon email d’inscription est other@example.invalid";
    const u = understandingFixture();
    u.evidence.push({ id: "history-reg", source: "history", sourceId: "message:other-inbound", excerpt: text });
    u.knownFacts = [{ id: "reg", key: "registration_email", text: "other@example.invalid", evidenceIds: ["history-reg"] }];
    deps.understand.mockResolvedValue(u); deps.crm.mockResolvedValue(absent);
    const result = await analyzeSavMessage({ from: "sender@example.invalid", subject: "Support", body: "Mon agent ne répond pas.",
      conversation: { threadId: "fixture", currentMessageId: "new-inbound", hubspotTicketId: null, status: "new", aiPaused: false, senderMatchesCustomer: true,
        messages: [{ id: "other-inbound", direction: "inbound", from: "other@example.invalid", receivedAt: "2026-10-18T10:00:00.000Z", text, truncated: false }], olderSummary: [], historyTruncated: false, attachmentNotice: "Non lues" } }, { evaluation: evaluation("off", vi.fn()) });
    expect(deps.crm).toHaveBeenCalledOnce(); expect(result.structuredProposal?.customerIdentity.registrationEmail).toBeNull();
  });
  it("does not turn a failed alternate-address read into customer absence or a second lookup", async () => {
    const body = "Mon email d’inscription est account@example.invalid";
    const u = understandingFixture(); u.evidence[0].excerpt = body;
    u.knownFacts = [{ id: "reg", key: "registration_email", text: "account@example.invalid", evidenceIds: [u.evidence[0].id] }];
    deps.understand.mockResolvedValue(u); deps.crm.mockResolvedValueOnce(absent).mockRejectedValueOnce(new Error("403"));
    const result = await analyzeSavMessage({ from: "sender@example.invalid", subject: "Support", body }, { evaluation: evaluation("off", vi.fn()) });
    expect(deps.crm).toHaveBeenCalledTimes(2); expect(result.proposal.reasonCode).toBe("registration_lookup_unavailable");
    expect(result.replyDraft).not.toContain("vérifier l’adresse d’inscription indiquée");
    expect(result.replyDraft).not.toMatch(/retrouv|aucun/);
  });
  it("does not ask a pre-purchase prospect for registration before general product information", async () => {
    const u = understandingFixture({ customerRelationship: { kind: "prospect", evidenceIds: ["evidence-1"] } });
    deps.understand.mockResolvedValue(u); deps.crm.mockResolvedValue(absent);
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)))) });
    expect(result.proposal.reasonCode).not.toMatch(/^registration_/);
    expect(result.replyDraft).not.toMatch(/inscription/);
  });
  it("does not repeat the question when the original address is already the declared registration email", async () => {
    const body = "Mon email d’inscription est sender@example.invalid";
    const u = understandingFixture(); u.evidence[0].excerpt = body;
    u.knownFacts = [{ id: "reg", key: "registration_email", text: "sender@example.invalid", evidenceIds: [u.evidence[0].id] }];
    deps.understand.mockResolvedValue(u); deps.crm.mockResolvedValue(absent);
    const result = await analyzeSavMessage({ from: "sender@example.invalid", subject: "Support", body }, { evaluation: evaluation("off", vi.fn()) });
    expect(deps.crm).toHaveBeenCalledOnce(); expect(result.replyDraft).toContain("vérifier l’adresse d’inscription indiquée");
  });
  it("does not ask for an address when a contact was found but ticket reads failed", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    deps.crm.mockResolvedValue({ ...absent, contactFound: true, contactId: "found", errorCode: "SAV_HUBSPOT_TICKETS_UNAVAILABLE" });
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)))) });
    expect(result.proposal.reasonCode).not.toMatch(/^registration_/);
    expect(result.replyDraft).not.toMatch(/inscription/); expect(deps.crm).toHaveBeenCalledOnce();
    expect(result.ticketRouting).toMatchObject({ kind: "review", reason: "hubspot_context_unavailable" });
  });
  it("keeps the actual coherence guard on the server-owned clarification", async () => {
    deps.understand.mockResolvedValue(understandingFixture()); deps.crm.mockResolvedValue(absent);
    deps.coherence.mockImplementation((...args) => import("./reply-coherence").then(async () => {
      const actual = await vi.importActual<typeof import("./reply-coherence")>("./reply-coherence");
      return actual.checkSavReplyCoherence(...args as Parameters<typeof actual.checkSavReplyCoherence>);
    }));
    const network = vi.fn<typeof fetch>(async () => geminiFixture({ passed: true, issues: [], coveredRequestIds: ["request-1"] }));
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", network) });
    expect(network).toHaveBeenCalledOnce(); expect(result.replyAssessment?.coherence?.status).toBe("passed");
    expect(JSON.parse(String(network.mock.calls[0][1]?.body)).contents[0].parts[0].text).toContain("registration_identity_question");
  });
  it.each(["rejected", "unavailable"])("does not bypass a %s coherence result", async status => {
    deps.understand.mockResolvedValue(understandingFixture()); deps.crm.mockResolvedValue(absent); deps.coherence.mockResolvedValue(coherence(status));
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", vi.fn()) });
    expect(result.replyAssessment?.kind).not.toBe("contextualized");
    expect(result.replyAssessment?.errorCode).toBeTruthy(); expect(result.ticketRouting?.kind).toBe("review");
  });
});

describe("SAV shared semantic pipeline with synthetic provider outputs", () => {
  it("proposes the analyzed nominal title without copying the subject or changing a linked CRM record", async () => {
    const u = understandingFixture({ ticketTitle: "Activation téléphonique et numéro dédié" });
    deps.understand.mockResolvedValue(u);
    const result = await analyzeSavMessage({from:"fixture@example.invalid",subject:"Bonjour je vous écris pour configurer",body:"Demande fictive de configuration."}, {evaluation:evaluation("off",vi.fn<typeof fetch>(async()=>geminiFixture(outputFor(u))))});
    expect(result.structuredProposal?.ticket.title).toBe(u.ticketTitle);
    expect(result.structuredProposal?.understanding).not.toHaveProperty("ticketTitle");
    expect(result.replyDraft).toMatch(/^Bonjour,/); expect(result.replyDraft).toMatch(/Bien à vous,$/);
    expect(deps.coherence).toHaveBeenCalledWith(expect.objectContaining({replyDraft:result.replyDraft}),expect.anything());
  });
  it.each([
    ["fr", "L’agent ne répond toujours pas."],
    ["fr", "Je n’arrive pas à terminer la configuration."],
    ["fr", "Ça recommence depuis ce matin."],
    ["fr", "Je ne sais pas quelle information vous envoyer pour mon problème."],
    ["en", "It still fails when I try again."],
    ["fr", "La pièce jointe montre le problème, comment continuer ?"],
  ] as const)("continues a proven but incomplete %s request to a reviewed draft: %s", async (language, body) => {
    deps.understand.mockImplementation(async (...args) => (await vi.importActual<typeof import("./understanding-model")>("./understanding-model")).understandSavMessage(...args as Parameters<typeof import("./understanding-model").understandSavMessage>));
    const empty = understandingContent(); empty.status = "needs_clarification"; empty.language = "unknown";
    empty.requests = []; empty.primaryRequestId = null; empty.evidence = []; empty.uncertainties = [{ code: "ambiguous_intent", requestIds: [] }];
    const u = understandingFixture({ status: "needs_clarification", language, uncertainties: [{ code: "ambiguous_intent", requestIds: ["request-1"] }] });
    u.requests[0] = { ...u.requests[0], summary: body, nature: "unknown", product: null, feature: null };
    u.evidence[0].excerpt = body;
    u.missingInformation = [{ id: "question", key: "desired_outcome", text: language === "en" ? "What do you want to achieve?" : "Quel résultat souhaitez-vous obtenir ?", requestIds: ["request-1"] }];
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(empty))
      .mockResolvedValueOnce(geminiFixture(understandingContent(u))).mockResolvedValueOnce(geminiFixture(outputFor(u)));
    const result = await analyzeSavMessage({ from: "fixture@example.invalid", subject: "Support", body }, { evaluation: evaluation("off", network) });
    expect(network).toHaveBeenCalledTimes(3); expect(result.understanding?.trace.validationRecovery?.succeeded).toBe(true);
    expect(result.replyAssessment?.kind).toBe("contextualized"); expect(result.replyAssessment?.coherence?.status).toBe("passed");
    expect(result.replyDraft).toContain(language === "en" ? "what you want to do" : "ce que vous souhaitez faire");
    expect(result.proposal.requiresHumanApproval).toBe(true);
    expect(result.replyDraft).not.toMatch(/L’équipe doit|humain doit|redémarr|résolu/i);
    expect(deps.coherence).toHaveBeenCalledOnce();
  });
  it("requires sections once and assembles the draft without a model-supplied duplicate", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    const output = outputFor(u);
    const network = vi.fn<typeof fetch>(async () => geminiFixture({ ...output, replyDraft: undefined }));
    const result = await analyzeSavMessage({ from: "fixture@example.invalid", subject: "Support", body: "Le produit ne fonctionne pas." }, { evaluation: evaluation("off", network) });
    expect(result.replyDraft).toBe(result.replyAssessment?.coverage.map(p => p.text).join("\n\n"));
    expect(result.replyDraft).toContain("Quelle version");
    const body = JSON.parse(network.mock.calls[0][1]!.body as string);
    expect(body.generationConfig.responseSchema.properties).not.toHaveProperty("replyDraft");
    expect(result.replyAssessment?.coverage).toHaveLength(output.coverage.length);
    expect(result.replyAssessment?.coverage[0]).toMatchObject({ requestId: output.coverage[0].requestId, kind: "clarification", sourceIds: [] });
  });
  it("does not run a shadow comparator on the live dossier path", async () => {
    vi.stubEnv("SAV_ADK_MODE", "shadow");
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    const network = vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)));
    vi.stubGlobal("fetch", network);
    const result = await analyzeSavMessage({ from: "fixture@example.invalid", subject: "Support", body: "Le produit ne fonctionne pas." });
    expect(result.understanding?.status).toBe("qualified");
    expect(network).toHaveBeenCalledOnce(); expect(deps.agent).not.toHaveBeenCalled();
  });
  it("retains rejected source alerts and the plan when model composition is disabled", async () => {
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    deps.understand.mockResolvedValue(understandingFixture());
    deps.search.mockResolvedValue({ revision: "fixture-kb", results: [{ id: "expired-card", contentVersionId: "expired-v1", title: "Procédure fictive périmée", content: "Ouvrez le contrôle fictif.", score: .9, verifiedAt: new Date().toISOString(), resolution: { steps: ["Ouvrez le contrôle fictif."], validUntil: "2020-01-01" } }] });
    const network = vi.fn();
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", network) });
    expect(result.replyAssessment?.harness?.retrievalAlerts).toContainEqual({ code: "expired", sourceKey: "expired-card:expired-v1" });
    expect(result.replyAssessment?.harness?.plans[0]).toMatchObject({ mode: "clarification", nextCheck: null });
    expect(network).not.toHaveBeenCalled();
  });
  it.each(modes)("preserves a content-matched existing issue with a generic email subject in %s", async mode => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u); deps.agent.mockResolvedValue(adkResult(u));
    deps.crm.mockResolvedValue({ contactFound: true, contactId: "fixture-contact", tickets: [{ id: "401", subject: "Incident du téléphone IA" }],
      routing: { kind: "matched", ticketId: "401", reason: "semantic_same_issue", returnOperation: "reactivate" } });
    const network = vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)));
    const result = await analyzeSavMessage({ from: "fixture@example.invalid", subject: "Re: Suite à votre demande - Urgent", body: "Le produit ne fonctionne pas." }, { evaluation: evaluation(mode, network) });
    expect(result.ticketRouting).toMatchObject({ kind: "matched", ticketId: "401", reason: "customer_return_reactivate" });
    expect(result.structuredProposal?.process.some(step => step.kind === "create_ticket")).toBe(false);
    expect(result.structuredProposal?.process).toContainEqual(expect.objectContaining({ kind: "link_ticket", sourceIds: ["401"] }));
    expect(deps.crm).toHaveBeenCalledWith(expect.objectContaining({ body: "Le produit ne fonctionne pas." }));
  });
  it("uses the forwarded original in CRM and model context, not the colleague's stale enrichment", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    const network = vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)));
    const forwarded = { from: "colleague@limova.ai", subject: "À traiter", body: "---------- Forwarded message ---------\nFrom: alice@example.com\nSubject: Connexion impossible\n\nLe produit ne fonctionne pas.",
      dossierContext: { version: 1 as const, messageId: "fixture-message", collectedAt: new Date().toISOString(), customerIdentity: { kind: "sender" as const, email: "colleague@limova.ai" },
        crm: { status: "error" as const, data: null, errorCode: "fixture" }, conversation: null, conversationError: null,
        otherConversations: [{ id: "colleague-history", subject: "PRIVATE_COLLEAGUE_HISTORY", relation: "Same sender", messages: [] }], otherConversationsError: null } };
    await analyzeSavMessage(forwarded, { evaluation: evaluation("off", network) });
    expect(deps.crm).toHaveBeenCalledWith(expect.objectContaining({ email: "alice@example.com", subject: "Connexion impossible", currentTicketId: undefined, identityHints: undefined }));
    expect(deps.understand.mock.calls[0][0]).toMatchObject({ from: "alice@example.com", subject: "Connexion impossible", body: "Le produit ne fonctionne pas." });
    expect(JSON.stringify(deps.understand.mock.calls[0][0])).not.toContain("PRIVATE_COLLEAGUE_HISTORY");
    expect(forwarded.from).toBe("colleague@limova.ai");
  });
  it("does not query CRM or propose a response for an ambiguous forwarded sender", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    const network = vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)));
    const result = await analyzeSavMessage({ from: "colleague@limova.ai", subject: "Support", body: "---------- Forwarded message ---------\nFrom: alice@example.com\nFrom: bob@example.com\nSubject: Support\n\nDemande" }, { evaluation: evaluation("off", network) });
    expect(deps.crm).not.toHaveBeenCalled();
    expect(result.proposal).toMatchObject({ kind: "human_review_required", reasonCode: "forwarded_customer_unresolved" });
    expect(result.replyDraft).toBeNull();
    expect(result.ticketRouting).toMatchObject({ kind: "review", reason: "forwarded_customer_unresolved" });
  });
  it.each(["off", "on"] as const)("keeps the server ticket requirement when the %s composer contradicts it", async mode => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    const answer = { ...outputFor(u), ticketRequired: false, requiresHuman: false };
    deps.agent.mockResolvedValue({ ...adkResult(u), output: answer });
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, vi.fn<typeof fetch>(async () => geminiFixture(answer))) });
    expect(result.proposal.kind).toBe(mode === "off" ? "human_review_required" : "ticket_pending");
    expect(result.ticketRouting?.kind).toBe("new");
  });
  it.each(modes)("understands once before retrieval and preserves technical meaning in %s", async mode => {
    const u = understandingFixture(); u.requests[0].financialScope = "incidental_price";
    deps.understand.mockResolvedValue(u); deps.agent.mockResolvedValue(adkResult(u));
    const network = vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)));
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(deps.understand).toHaveBeenCalledOnce();
    expect(result.category).toBe("technical"); expect(result.replyAssessment?.coverage.map(part => part.requestId)).toContain(u.requests[0].id);
    expect(result.understanding).toEqual(u); expect(result.structuredProposal?.understanding).toEqual(u);
    expect(result.replyAssessment?.coherence?.status).toBe("passed"); expect(deps.coherence).toHaveBeenCalledOnce();
    if (mode === "off" || mode === "shadow") {
      expect(deps.search).toHaveBeenCalledWith(expect.objectContaining({ query: savSemanticPlan(u).retrievalQuery }));
      expect(deps.search.mock.invocationCallOrder[0]).toBeGreaterThan(deps.understand.mock.invocationCallOrder[0]);
      expect(network).toHaveBeenCalledOnce();
      const sent = JSON.parse(String(network.mock.calls[0]?.[1]?.body));
      expect(sent.contents[0].parts[0].text).toContain(u.requests[0].summary);
    }
    if (mode !== "off") expect(deps.agent).toHaveBeenCalledWith(expect.objectContaining({ understanding: u }), expect.any(Object));
  });
  it.each(modes)("keeps supplied facts and questions in the contract with no late identity boilerplate in %s", async mode => {
    const u = understandingFixture();
    u.knownFacts = [{ id: "fact-email", key: "registration_email", text: "account@example.invalid", evidenceIds: ["evidence-1"] }];
    deps.understand.mockResolvedValue(u); deps.agent.mockResolvedValue(adkResult(u));
    deps.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "no_contact" } });
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)))) });
    expect(result.replyAssessment?.coverage.map(part => part.requestId)).toContain(u.requests[0].id); expect(result.replyDraft).not.toMatch(/Quelle adresse|Which email/);
    expect(result.ticketRouting).toMatchObject({ kind: "review", reason: "customer_identity_unverified" });
    expect(result.structuredProposal?.customerIdentity.verifiedByHuman).toBe(false);
  });
  it.each(modes)("keeps mixed technical and refund requests without a draft in %s", async mode => {
    const u = understandingFixture(); u.requests.push({ ...u.requests[0], id: "refund", summary: "Demander un remboursement.", nature: "financial_operation", financialScope: "support_account" });
    deps.understand.mockResolvedValue(u); const network = vi.fn();
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(result.category).toBe("technical"); expect(result.proposal.reasonCode).toBe("finance_human_only");
    expect(result.replyDraft).toBeNull();
    for (const request of u.requests) expect(result.proposal.explanation).toContain(request.summary);
    expect(deps.understand).toHaveBeenCalledOnce(); expect(deps.search).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(deps.coherence).not.toHaveBeenCalled();
  });
  it.each(modes)("forbids every cancellation draft including mixed finance and missing identity in %s", async mode => {
    const u = understandingFixture(); u.requests.push({ ...u.requests[0], id: "cancel", nature: "cancellation", summary: "Mettre fin à l’abonnement." });
    deps.understand.mockResolvedValue(u); deps.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "no_contact" } });
    const network = vi.fn(); const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(result.proposal.reasonCode).toBe("cancellation_human_only"); expect(result.replyDraft).toBeNull(); expect(result.structuredProposal?.replyDraft).toBeNull();
    expect(deps.search).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it.each(modes)("does not invent a semantic classification after an unavailable understanding in %s", async mode => {
    const u = understandingFixture({ status: "unavailable", language: "unknown", requests: [], primaryRequestId: null, evidence: [], uncertainties: [{ code: "provider_unavailable", requestIds: [] }] }); u.trace.errorCode = "SAV_AI_HTTP_402";
    deps.understand.mockResolvedValue(u); const network = vi.fn();
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(result).toMatchObject({ category: "other", replyDraft: null, proposal: { reasonCode: "understanding_unavailable", confidence: 0, requiresHumanApproval: true } });
    expect(result.diagnostics).toContainEqual({ phase: "generation", errorCode: "SAV_AI_HTTP_402" });
    expect(deps.search).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it.each(modes)("uses a lead template only after qualifying a prospect in %s", async mode => {
    const u = understandingFixture(); u.requests[0].nature = "commercial"; u.customerRelationship = { kind: "prospect", evidenceIds: ["evidence-1"] };
    deps.understand.mockResolvedValue(u);
    const template = "Bonjour, voici le formulaire fictif : https://example.invalid/demo.";
    deps.search.mockResolvedValue({ revision: "fixture-lead", results: [{ id: "lead", contentVersionId: "lead-v1", title: "Fixture", content: template, score: 0.9, verifiedAt: new Date().toISOString(), resolution: { audience: "lead", symptoms: ["Découverte"], steps: ["Consulter le formulaire"], escalation: "Humain", conflictsWith: [], supersedes: [], responseTemplate: template } }] });
    const network = vi.fn(); const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(result.replyDraft).toBe(template); expect(result.ticketRouting?.kind).toBe("none");
    expect(deps.search).toHaveBeenCalledWith(expect.objectContaining({ savAudience: "lead" }));
    expect(deps.search.mock.invocationCallOrder[0]).toBeGreaterThan(deps.understand.mock.invocationCallOrder[0]);
    expect(network).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled();
  });
  it.each(["existing_customer", "unknown"] as const)("does not apply a prospect template to %s", async kind => {
    const u = understandingFixture(); u.requests[0].nature = "commercial"; u.customerRelationship = { kind, evidenceIds: kind === "unknown" ? [] : ["evidence-1"] }; deps.understand.mockResolvedValue(u);
    const network = vi.fn(); const result = await analyzeSavMessage(input, { evaluation: evaluation("off", network) });
    expect(result.replyDraft).toBeNull(); expect(result.proposal.reasonCode).toBe("commercial_context_to_review");
    expect(deps.search).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it.each(modes)("runs no semantic/model/CRM work for reliable technical automation headers in %s", async mode => {
    const result = await analyzeSavMessage({ ...input, autoSubmitted: "auto-replied" }, { evaluation: evaluation(mode, vi.fn()) });
    expect(result.proposal.kind).toBe("automatic_reply"); expect(result.replyDraft).toBeNull();
    expect(deps.understand).not.toHaveBeenCalled(); expect(deps.crm).not.toHaveBeenCalled(); expect(deps.search).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled();
  });
  it.each(["rejected", "unavailable"])("replaces a %s coherence verdict with a marked contextual human handoff", async status => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u); deps.coherence.mockResolvedValue(coherence(status));
    const answer = outputFor(u); answer.coverage[0].text = "Cette réponse fournisseur doit être supprimée."; answer.replyDraft = answer.coverage[0].text;
    const network = vi.fn<typeof fetch>(async () => geminiFixture(answer)); const result = await analyzeSavMessage(input, { evaluation: evaluation("off", network) });
    expect(result.replyDraft).not.toContain("doit être supprimée"); expect(result.replyDraft).toContain(u.requests[0].summary);
    expect(result.replyAssessment).toMatchObject({ kind: "human_handoff", coherence: { status } });
    expect(result.proposal.confidence).toBe(0); expect(network).toHaveBeenCalledOnce(); expect(deps.coherence).toHaveBeenCalledTimes(status === "rejected" ? 2 : 1);
  });
  it.each(["off", "on"] as const)("rejects missing secondary request coverage in %s", async mode => {
    const u = understandingFixture(); u.requests.push({ ...u.requests[0], id: "second", summary: "Une seconde demande explicite." }); deps.understand.mockResolvedValue(u);
    const incomplete = outputFor(u); incomplete.coverage = incomplete.coverage.slice(0, 1); incomplete.replyDraft = incomplete.coverage[0].text;
    deps.agent.mockResolvedValue({ ...adkResult(u), output: incomplete });
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, vi.fn<typeof fetch>(async () => geminiFixture(incomplete))) });
    expect(result.replyAssessment?.kind).toBe(mode === "off" ? "contextualized" : "human_handoff"); expect(result.replyDraft).toContain("seconde demande");
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "generation", errorCode: "SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING" })]));
    expect(deps.coherence).toHaveBeenCalledTimes(mode === "off" ? 1 : 0);
    if (mode === "off") expect(result.replyAssessment?.recovery).toMatchObject({ strategy: "investigation", validated: true });
  });
  it("does not retry another composer after ADK failure", async () => {
    deps.understand.mockResolvedValue(understandingFixture()); deps.agent.mockRejectedValue(new Error("SAV_ADK_TIMEOUT"));
    const network = vi.fn(); const result = await analyzeSavMessage(input, { evaluation: evaluation("on", network) });
    expect(result.proposal.reasonCode).toBe("agent_runtime_degraded"); expect(result.replyAssessment?.kind).toBe("human_handoff");
    expect(deps.agent).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled(); expect(deps.search).not.toHaveBeenCalled();
  });
  it("retains the exact source version for the server-selected next control", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    const first = "Consultez le panneau de diagnostic fictif."; const second = "Relevez le code d’erreur affiché dans ce panneau.";
    deps.search.mockResolvedValue({ revision: "fixture-kb", results: [{ id: "card", contentVersionId: "card-version-1", title: "Procédure fictive", content: `${first}\n${second}`, score: 0.9, verifiedAt: new Date().toISOString(), resolution: { steps: [first, second], conflictsWith: [] } }] });
    const answer = outputFor(u); answer.responseKind = "solution";
    answer.coverage[0] = { ...answer.coverage[0], kind: "solution", text: "Vous signalez un problème technique.", sourceIds: ["card"] }; answer.replyDraft = answer.coverage[0].text;
    answer.citations = [{ sourceId: "card", claim: "Ouvrir le diagnostic", quote: first }, { sourceId: "card", claim: "Relever le code", quote: second }];
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", vi.fn<typeof fetch>(async () => geminiFixture(answer))) });
    expect(result.replyDraft).toContain(first);
    expect(result.replyAssessment?.harness?.plans[0].nextCheck?.instruction).toBe(first);
    expect(result.evidence.filter(e => e.sourceId === "card")).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentVersionId: "card-version-1", claim: "Ouvrir le diagnostic", excerpt: first }),
      expect.objectContaining({ contentVersionId: "card-version-1", claim: "Relever le code", excerpt: second }),
    ]));
  });
  it("carries a qualified procedure through real retrieval projection, planning and grounding", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    const instruction = "Consultez le panneau de démonstration.";
    const delivery = { version: 1, mode: "procedure", steps: [{ id: "step-one", userLabel: "Contrôle fictif", instruction, expectedResult: "", prerequisites: [], exceptions: [], escalation: "" }], groups: [{ id: "procedure", label: "Parcours fictif", requiresHuman: false, stepIds: ["step-one"], prerequisites: [], exceptions: [], expectedResult: "", escalation: "" }] };
    deps.search.mockResolvedValue({ revision: "fixture-kb", results: [{ id: "card", contentVersionId: "version", title: "Procédure fictive", content: instruction, score: .9, verifiedAt: new Date().toISOString(), resolution: { steps: [instruction], delivery } }] });
    const answer = outputFor(u); answer.responseKind = "solution";
    answer.coverage[0] = { ...answer.coverage[0], kind: "solution", text: "Un problème est signalé.", sourceIds: ["card"], procedureGroupId: "procedure" };
    answer.citations = [{ sourceId: "card", claim: "Consulter le panneau", quote: instruction }];
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", vi.fn(async () => geminiFixture(answer))) });
    expect(result.replyDraft).toContain(instruction);
    expect(result.replyAssessment?.coverage[0].kind).toBe("solution");
    expect(result.replyAssessment?.recovery).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });
  it("does not display an ungrounded solution even under human review", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u); const answer = outputFor(u);
    answer.responseKind = "solution"; answer.coverage[0] = { ...answer.coverage[0], kind: "solution", text: "Cliquez sur un bouton inventé.", sourceIds: ["missing-card"] }; answer.replyDraft = answer.coverage[0].text;
    answer.citations = [{ sourceId: "missing-card", claim: "Cliquer sur ce bouton", quote: "Une quote qui n’a jamais été fournie." }];
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", vi.fn<typeof fetch>(async () => geminiFixture(answer))) });
    expect(result.replyDraft).not.toContain("bouton inventé"); expect(result.replyAssessment?.kind).toBe("contextualized");
    expect(result.replyAssessment?.recovery).toMatchObject({ validated: true });
    expect(deps.coherence).toHaveBeenCalledOnce(); expect(result.diagnostics?.some(d => d.errorCode === "SAV_REPLY_OUTSIDE_REQUEST_PLAN")).toBe(true);
  });
  it("rebuilds a rejected composition as an investigation only after independent coherence passes", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    deps.coherence.mockResolvedValueOnce(coherence("rejected")).mockResolvedValueOnce(coherence());
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", vi.fn(async () => geminiFixture(outputFor(u)))) });
    expect(deps.coherence).toHaveBeenCalledTimes(2);
    expect(result.replyAssessment?.recovery).toMatchObject({ originalErrorCode: "SAV_REPLY_COHERENCE_REJECTED", validated: true });
    expect(result.replyAssessment?.coherence?.totalTokens).toBe(30);
    expect(result.replyAssessment?.coherenceAttempts?.map(c => c.status)).toEqual(["rejected", "passed"]);
    expect(result.replyAssessment?.coherenceAttempts?.[0].issues).toContain("unsupported_advice");
    expect(result.replyDraft).toContain("Quelle version");
    expect(result.replyDraft).not.toContain("L’équipe doit vérifier");
    expect(result.proposal.requiresHumanApproval).toBe(true);
  });
  it.each([{ messageId: "fixture" }, { pilotBatchId: "fixture" }])("forbids any persisted identity on an evaluation run: %j", async persisted => {
    await expect(analyzeSavMessage(input, { ...persisted, evaluation: evaluation("off", vi.fn()) })).rejects.toThrow("SAV_EVALUATION_PERSISTENCE_FORBIDDEN");
    expect(deps.understand).not.toHaveBeenCalled(); expect(deps.crm).not.toHaveBeenCalled();
  });
});
