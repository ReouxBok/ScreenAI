import { describe, expect, it, vi } from "vitest";
import { understandSavMessage } from "./understanding-model";
import { repairSavUnderstandingRepresentation, retainSavUnderstandingProse } from "./understanding-representation";
import { assertSavUnderstandingRecoveryPreserves, savSemanticPlan, validateSavUnderstanding } from "./understanding";
import { addSavInvestigationQuestions, buildSavInvestigationReply } from "./investigation";
import { geminiFixture, understandingContent } from "../../../test/sav-understanding-fixtures";
import type { SavRequestPlan } from "./request-planner";

const input = { subject: "Téléphone", body: "L’agent téléphone cesse de répondre." };
const sources = [{ source: "current_message" as const, sourceId: "current_body", text: input.body }];
const plan: SavRequestPlan = { requestId: "request-1", domain: "general", mode: "knowledge_gap", card: null, missingFacts: [], nextCheck: null, repeatAllowed: false, limits: [] };

describe("representational repairs with the original guards", () => {
  it("keeps the complete reported attempt while removing an unsupported catalogued outcome", async () => {
    const raw = understandingContent();
    raw.attemptedSteps = [{ id: "attempt", key: "restart", text: input.body, requestIds: ["request-1"], evidenceIds: ["evidence-1"], outcome: "not_expected", checkId: null, checkCardId: null, checkVersionId: null }];
    const network = vi.fn<typeof fetch>(async () => geminiFixture(raw));
    expect(() => validateSavUnderstanding(raw, sources)).toThrow();
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledOnce();
    expect(result.attemptedSteps).toEqual([{ ...raw.attemptedSteps[0], outcome: "unknown" }]);
    expect(result.trace.validationRecovery).toMatchObject({ succeeded: true });
    expect(() => validateSavUnderstanding(understandingContent(result), sources)).not.toThrow();
    expect(() => assertSavUnderstandingRecoveryPreserves(raw, understandingContent(result))).not.toThrow();
  });
  it.each(["checkCardId", "checkVersionId"] as const)("never erases an incomplete catalogued %s", reference => {
    const raw = understandingContent();
    raw.attemptedSteps = [{ id: "attempt", key: "restart", text: input.body, evidenceIds: ["evidence-1"], outcome: "not_expected", [reference]: "unverified-reference" }];
    expect(repairSavUnderstandingRepresentation(raw)).toBeNull();
    expect(() => validateSavUnderstanding(raw, sources)).toThrow();
  });
  it.each(["financial_operation", "financial_data"] as const)("repairs %s scope while keeping the financial restriction", async nature => {
    const raw = understandingContent(); raw.requests[0].nature = nature;
    const network = vi.fn<typeof fetch>(async () => geminiFixture(raw));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledOnce();
    expect(result.requests[0]).toEqual({ ...raw.requests[0], financialScope: "support_account" });
    expect(savSemanticPlan(result)).toMatchObject({ replyPolicy: "none", reasonCode: "finance_human_only" });
  });
  it("does not remove an ambiguous financial scope locally", () => {
    const raw = understandingContent(); raw.requests[0].financialScope = "support_account";
    expect(repairSavUnderstandingRepresentation(raw)).toBeNull();
    expect(() => validateSavUnderstanding(raw, sources)).toThrow();
  });
  it("retains original prose rather than accepting a repair's paraphrase", async () => {
    const raw = understandingContent(); raw.requests[0].financialScope = "support_account";
    raw.knownFacts = [{ id: "fact", key: "reported", text: input.body, evidenceIds: ["evidence-1"], requestIds: ["request-1"] }];
    const recovered = structuredClone(raw); recovered.requests[0].financialScope = "none";
    recovered.requests[0].summary = "A paraphrased request"; recovered.knownFacts[0].text = "Rewritten fact";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(raw)).mockResolvedValueOnce(geminiFixture(recovered));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result.status).toBe("qualified"); expect(result.requests[0].summary).toBe(raw.requests[0].summary);
    expect(result.knownFacts).toEqual(raw.knownFacts);
    expect(result.trace.validationRecovery?.succeeded).toBe(true);
  });
  it("still rejects changed request nature and missing secondary requests", () => {
    const raw = understandingContent(); raw.requests.push({ ...raw.requests[0], id: "finance", nature: "financial_operation", financialScope: "support_account" });
    const recovered = structuredClone(raw); recovered.requests[1].nature = "technical";
    expect(() => assertSavUnderstandingRecoveryPreserves(raw, retainSavUnderstandingProse(raw, recovered) as typeof raw)).toThrow();
    recovered.requests.pop();
    expect(() => assertSavUnderstandingRecoveryPreserves(raw, retainSavUnderstandingProse(raw, recovered) as typeof raw)).toThrow();
  });
});

describe("one bounded second reading before clarification", () => {
  function empty() {
    const raw = understandingContent(); raw.status = "needs_clarification"; raw.language = "unknown";
    raw.requests = []; raw.primaryRequestId = null; raw.evidence = [];
    raw.uncertainties = [{ code: "ambiguous_intent", requestIds: [] }];
    return raw;
  }
  it("recovers a current, evidenced but ambiguous demand into concrete investigation questions", async () => {
    const clarified = understandingContent(); clarified.status = "needs_clarification"; clarified.requests[0].nature = "unknown";
    clarified.uncertainties = [{ code: "ambiguous_intent", requestIds: ["request-1"] }];
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(empty())).mockResolvedValueOnce(geminiFixture(clarified));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2); expect(result.trace.validationRecovery?.succeeded).toBe(true);
    expect(savSemanticPlan(result).replyPolicy).toBe("compose");
    const plans = addSavInvestigationQuestions(result, [plan]);
    result.missingInformation = plans.flatMap(p => p.missingFacts.map(f => ({ id: f.id, key: f.key, text: f.question, requestIds: [p.requestId] })));
    const reply = buildSavInvestigationReply(result, plans);
    expect(reply.replyDraft).toContain("ce que vous souhaitez faire");
    expect(reply.replyDraft).not.toMatch(/humain|équipe|redémarr/i);
  });
  it("resolves a missing language without discarding the existing demand", async () => {
    const raw = understandingContent(); raw.status = "needs_clarification"; raw.language = "unknown";
    raw.uncertainties = [{ code: "ambiguous_intent", requestIds: ["request-1"] }];
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(raw)).mockResolvedValueOnce(geminiFixture(understandingContent()));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result.language).toBe("fr"); expect(result.requests).toEqual(raw.requests);
  });
  it.each(["notification", "empty_request"])("does not manufacture a demand for %s", async () => {
    const raw = empty(); const network = vi.fn<typeof fetch>(async () => geminiFixture(raw));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2); expect(result.requests).toEqual([]);
    expect(result.trace.validationRecovery?.succeeded).toBe(false); expect(savSemanticPlan(result).replyPolicy).toBe("none");
  });
  it("keeps the validated first extraction when the second pass invents a citation", async () => {
    const bad = understandingContent(); bad.evidence[0].excerpt = "Invented proof";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(empty())).mockResolvedValueOnce(geminiFixture(bad));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2); expect(result.status).toBe("needs_clarification"); expect(result.requests).toEqual([]);
    expect(result.trace.validationRecovery).toMatchObject({ succeeded: false, errorCode: "SAV_UNDERSTANDING_INVALID_EVIDENCE" });
  });
  it("does not turn a historic request into a current demand", async () => {
    const bad = understandingContent(); bad.evidence[0].source = "history";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(empty())).mockResolvedValueOnce(geminiFixture(bad));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result.requests).toEqual([]); expect(result.trace.validationRecovery?.succeeded).toBe(false);
  });
  it.each(["financial_data", "cancellation", "legal"] as const)("retains %s restrictions after clarification", async nature => {
    const clarified = understandingContent(); clarified.requests[0].nature = nature;
    if (nature === "financial_data") clarified.requests[0].financialScope = "support_account";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(empty())).mockResolvedValueOnce(geminiFixture(clarified));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(savSemanticPlan(result).replyPolicy).toBe("none");
  });
});
