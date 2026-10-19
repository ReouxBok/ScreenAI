import { describe, expect, it, vi } from "vitest";
import { understandSavMessage, savUnderstandingResponseSchema } from "./understanding-model";
import { savSemanticPlan, validateSavUnderstanding } from "./understanding";
import { geminiFixture, understandingContent } from "../../../test/sav-understanding-fixtures";

const input = { subject: "Téléphone", body: "L’agent téléphone cesse de répondre." };
const sources = [{ source: "current_message" as const, sourceId: "current_body", text: input.body }];
function empty(status: "needs_clarification" | "unavailable" = "needs_clarification") {
  return { ...understandingContent(), status, primaryRequestId: null, requests: [], evidence: [], uncertainties: [] };
}

describe("explain non-qualified understanding without relaxing validation", () => {
  it("expresses the status/uncertainty invariant in both provider schema branches", () => {
    const branches = savUnderstandingResponseSchema.anyOf;
    expect(branches).toHaveLength(2);
    expect(branches[0].properties.status).toEqual({ type: "STRING", enum: ["qualified"] });
    expect(branches[0].properties.uncertainties).not.toHaveProperty("minItems");
    expect(branches[1].properties.status).toEqual({ type: "STRING", enum: ["needs_clarification", "unavailable"] });
    expect(branches[1].properties.uncertainties).toHaveProperty("minItems", "1");
    expect(branches[0].required).toEqual(branches[1].required);
    expect(Object.keys(branches[0].properties)).toEqual(Object.keys(branches[1].properties));
  });

  it.each(["needs_clarification", "unavailable"] as const)("keeps rejecting an unexplained %s, including after recovery", async status => {
    const raw = empty(status);
    expect(() => validateSavUnderstanding(raw, sources)).toThrow("SAV_UNDERSTANDING_INVALID_EVIDENCE");
    const network = vi.fn<typeof fetch>(async () => geminiFixture(raw));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("unavailable");
    expect(result.trace.validationDiagnostics?.map(d => d.rule)).toEqual(["uncertainty_required", "uncertainty_required"]);
    expect(result.trace.validationRecovery?.succeeded).toBe(false);
    const sent = JSON.parse(String(network.mock.calls[1][1]?.body));
    expect(sent.systemInstruction.parts[0].text).toContain("uncertainty_required");
    expect(sent.generationConfig.responseSchema).toEqual(savUnderstandingResponseSchema);
  });

  it("lets a source-backed recovery qualify a real request without inventing uncertainty", async () => {
    const recovered = understandingContent();
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(empty())).mockResolvedValueOnce(geminiFixture(recovered));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("qualified");
    expect(result.uncertainties).toEqual([]);
    expect(result.requests).toEqual(recovered.requests);
    expect(result.trace.validationRecovery?.succeeded).toBe(true);
    expect(() => validateSavUnderstanding(understandingContent(result), sources)).not.toThrow();
  });

  it("sends the conditional schema on the initial call and accepts a qualified request directly", async () => {
    const network = vi.fn<typeof fetch>(async () => geminiFixture(understandingContent()));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledOnce();
    expect(result.status).toBe("qualified");
    expect(result.uncertainties).toEqual([]);
    const sent = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(sent.generationConfig.responseSchema).toEqual(savUnderstandingResponseSchema);
  });

  it("does not let a fake qualified status evade the requirement for a real current request", async () => {
    const raw = { ...empty(), status: "qualified" };
    const network = vi.fn<typeof fetch>(async () => geminiFixture(raw));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("unavailable");
    expect(result.trace.validationDiagnostics?.map(d => d.rule)).toEqual(["qualified_request_required", "qualified_request_required"]);
  });

  it("does not fabricate a request or local reason to repair an empty candidate", async () => {
    const recovered = { ...empty(), uncertainties: [{ code: "missing_context" as const, requestIds: [] }] };
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(empty())).mockResolvedValueOnce(geminiFixture(recovered));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2);
    expect(result.requests).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.uncertainties).toEqual(recovered.uncertainties);
    expect(savSemanticPlan(result).replyPolicy).toBe("none");
  });

  it.each(["financial_data", "cancellation", "legal"] as const)("retains %s restrictions after the targeted recovery", async nature => {
    const recovered = understandingContent();
    recovered.requests[0].nature = nature;
    if (nature === "financial_data") recovered.requests[0].financialScope = "support_account";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(empty())).mockResolvedValueOnce(geminiFixture(recovered));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2);
    expect(savSemanticPlan(result).replyPolicy).toBe("none");
  });

  it("still rejects invented evidence even when a recovery supplies the missing reason", async () => {
    const recovered = understandingContent(); recovered.status = "needs_clarification";
    recovered.uncertainties = [{ code: "missing_context", requestIds: ["request-1"] }];
    recovered.evidence[0].excerpt = "Invented sentence that is not in any source";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(empty())).mockResolvedValueOnce(geminiFixture(recovered));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("unavailable");
    expect(result.trace.validationDiagnostics?.at(-1)?.rule).toBe("quote_not_in_source");
  });
});
