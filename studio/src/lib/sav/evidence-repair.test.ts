import { afterEach, describe, expect, it, vi } from "vitest";
import { savEvidenceContains } from "./evidence-text";
import { assembleSavReplySections, validateSavUnderstanding } from "./understanding";
import { understandSavMessage } from "./understanding-model";
import { geminiFixture, understandingContent, understandingFixture, coverageFixture } from "../../../test/sav-understanding-fixtures";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("exact evidence with French typography", () => {
  it.each([
    ["L’agent dit « Bonjour » — sans réponse", 'L\'agent dit "Bonjour" - sans réponse'],
    ["Le coût est 79\u202f€ par mois", "Le coût est 79 € par mois"],
    ["L\u2019écran\u00a0reste bleu", "L'écran reste bleu"],
  ])("accepts only typography-equivalent excerpts: %s", (source, quote) => expect(savEvidenceContains(source, quote)).toBe(true));
  it.each([
    ["Je ne veux pas résilier", "Je veux résilier"], ["79 €", "790 €"], ["25 m²", "25 m2"],
    ["10 Mo", "10 mo"], ["−5 €", "5 €"], ["Je ne peux pas me connecter", "Je peux me connecter"],
  ])("preserves meaning and values in %s", (source, quote) => expect(savEvidenceContains(source, quote)).toBe(false));
  it("keeps source identity strict even when its text is equivalent", () => {
    const u = understandingContent(); u.evidence[0].sourceId = "another_source";
    expect(() => validateSavUnderstanding(u, [{ source: "current_message", sourceId: "current_body", text: u.evidence[0].excerpt }])).toThrow();
  });
  it("removes a redundant question only after validating every request and reference", () => {
    const u = understandingContent();
    u.knownFacts = [{ id: "fact", key: "registration_email", text: "Adresse fournie", evidenceIds: ["evidence-1"] }];
    u.missingInformation = [{ id: "question", key: "registration_email", text: "Quelle adresse ?", requestIds: ["request-1"] }];
    const sources = [{ source: "current_message" as const, sourceId: "current_body", text: u.evidence[0].excerpt }];
    expect(validateSavUnderstanding(u, sources)).toMatchObject({ requests: u.requests, knownFacts: u.knownFacts, missingInformation: [] });
    u.missingInformation[0].requestIds = ["invented"];
    expect(() => validateSavUnderstanding(u, sources)).toThrow();
  });
});
describe("server assembly", () => {
  it("orders every section by request and refuses duplicates or omissions", () => {
    const u = understandingFixture(); u.requests.push({ ...u.requests[0], id: "secondary", summary: "Deuxième problème" });
    const coverage = coverageFixture(u);
    expect(assembleSavReplySections(u, [...coverage].reverse())).toEqual({ coverage, replyDraft: coverage.map(p => p.text).join("\n\n") });
    expect(() => assembleSavReplySections(u, [coverage[0]])).toThrow();
    expect(() => assembleSavReplySections(u, [coverage[0], coverage[0]])).toThrow();
  });
});
describe("one citation repair, original intents retained", () => {
  const input = { subject: "Support", body: "L’agent téléphone cesse de répondre. Je souhaite aussi un remboursement." };
  function broken() {
    const u = understandingContent();
    u.requests.push({ ...u.requests[0], id: "refund", summary: "Je souhaite aussi un remboursement.", nature: "financial_operation", financialScope: "support_account", evidenceIds: ["refund-proof"] });
    u.evidence.push({ id: "refund-proof", source: "current_message", sourceId: "current_body", excerpt: "Je souhaite aussi un remboursement." });
    u.evidence[0].excerpt = "Citation absente de la source";
    return u;
  }
  it("repairs only an excerpt and keeps the secondary finance restriction", async () => {
    const original = broken(), repaired = structuredClone(original); repaired.evidence[0].excerpt = "L’agent téléphone cesse de répondre.";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(original)).mockResolvedValueOnce(geminiFixture(repaired));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result).toMatchObject({ status: "qualified", requests: original.requests, trace: { errorCode: null, validationRepair: { attempted: true, succeeded: true } } });
    expect(network).toHaveBeenCalledTimes(2);
    expect(result.trace.validationRepair?.transport?.correlationId).toBe(result.trace.transport?.correlationId);
  });
  it.each(["drop_secondary", "change_policy", "change_source", "still_wrong"])("refuses repaired output that would %s", async scenario => {
    const original = broken(), repaired = structuredClone(original); repaired.evidence[0].excerpt = "L’agent téléphone cesse de répondre.";
    if (scenario === "drop_secondary") { repaired.requests.pop(); repaired.evidence.pop(); }
    if (scenario === "change_policy") { repaired.requests[1].nature = "technical"; repaired.requests[1].financialScope = "none"; }
    if (scenario === "change_source") repaired.evidence[0].sourceId = "another_source";
    if (scenario === "still_wrong") repaired.evidence[0].excerpt = "Invention persistante";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(original)).mockResolvedValueOnce(geminiFixture(repaired));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result).toMatchObject({ status: "unavailable", trace: { errorCode: "SAV_UNDERSTANDING_REPAIR_REJECTED", validationRepair: { succeeded: false } } });
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("does not repair duplicated IDs or invented sources", async () => {
    const original = broken(); original.requests.push({ ...original.requests[0] });
    const network = vi.fn<typeof fetch>().mockResolvedValue(geminiFixture(original));
    expect(await understandSavMessage(input, { apiKey: "fixture", fetch: network })).toMatchObject({ status: "unavailable", trace: { errorCode: "SAV_UNDERSTANDING_INVALID_EVIDENCE" } });
    expect(network).toHaveBeenCalledOnce();
  });
});
