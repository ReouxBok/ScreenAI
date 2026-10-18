import { describe, expect, it, vi } from "vitest";
import { understandSavMessage } from "./understanding-model";
import { geminiFixture, understandingContent } from "../../../test/sav-understanding-fixtures";

const input = { subject: "Téléphone", body: "L’agent téléphone cesse de répondre." };
describe("one bounded contract recovery under unchanged validation", () => {
  it("repairs source references by re-extracting the same request", async () => {
    const valid = understandingContent(), invalid = structuredClone(valid); invalid.evidence[0].sourceId = "missing_source";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(invalid)).mockResolvedValueOnce(geminiFixture(valid));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2); expect(result.status).toBe("qualified");
    expect(result.requests).toEqual(valid.requests);
    expect(result.trace.validationRecovery).toMatchObject({ attempted: true, succeeded: true, errorCode: null });
    expect(result.trace.validationDiagnostics?.[0].rule).toBe("source_not_found");
  });
  it("represents a natural failed attempt without inventing a versioned diagnostic reference", async () => {
    const invalid = understandingContent(); invalid.attemptedSteps = [{ id: "attempt", key: "restart", requestIds: ["request-1"], text: input.body, evidenceIds: ["evidence-1"], outcome: "not_expected", checkId: null, checkVersionId: null, checkCardId: null }];
    const valid = structuredClone(invalid); valid.attemptedSteps[0].outcome = "unknown";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(invalid)).mockResolvedValueOnce(geminiFixture(valid));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result.status).toBe("qualified"); expect(result.attemptedSteps).toEqual(valid.attemptedSteps);
  });
  it("refuses recovery that changes a financial request into technical support", async () => {
    const financial = understandingContent(); financial.requests[0].nature = "financial_operation"; financial.requests[0].financialScope = "none";
    // Force a full source recovery; a scope-only local correction must already
    // keep this request financial, rather than asking the provider to rewrite it.
    financial.evidence[0].sourceId = "missing_source";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(financial)).mockResolvedValueOnce(geminiFixture(understandingContent()));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result.status).toBe("unavailable");
    expect(result.trace.validationRecovery).toMatchObject({ succeeded: false, errorCode: "SAV_UNDERSTANDING_REPAIR_REJECTED" });
  });
  it("never deletes a secondary request to pass validation", async () => {
    const invalid = understandingContent(); invalid.requests.push({ ...invalid.requests[0], id: "secondary", summary: "Une seconde demande doit rester présente." }); invalid.primaryRequestId = "missing";
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(invalid)).mockResolvedValueOnce(geminiFixture(understandingContent()));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result.status).toBe("unavailable"); expect(result.trace.validationDiagnostics?.at(-1)?.rule).toBe("recovery_changed_request");
  });
  it("never drops a malformed sensitive secondary request", async () => {
    const invalid = understandingContent(); invalid.requests.push({ ...invalid.requests[0], id: "", nature: "cancellation", summary: "Je demande la résiliation du contrat.", evidenceIds: [] });
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(invalid)).mockResolvedValueOnce(geminiFixture(understandingContent()));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result.status).toBe("unavailable"); expect(result.trace.validationDiagnostics?.at(-1)?.rule).toBe("recovery_changed_request");
  });
  it.each(["knownFacts", "attemptedSteps"] as const)("never drops identifiable %s during reference recovery", async key => {
    const invalid = understandingContent(); invalid.evidence[0].sourceId = "missing_source";
    invalid[key] = [{ id: "fact", key: "version", text: "Version 2", requestIds: ["request-1"], evidenceIds: ["evidence-1"] }];
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(invalid)).mockResolvedValueOnce(geminiFixture(understandingContent()));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(result.status).toBe("unavailable"); expect(result.trace.validationDiagnostics?.at(-1)?.rule).toBe("recovery_changed_fact_or_attempt");
  });
  it.each(["requests", "knownFacts", "attemptedSteps"] as const)("refuses a malformed %s collection instead of treating it as empty", async key => {
    const invalid = { ...understandingContent(), [key]: { nature: "cancellation", summary: "Je résilie" } };
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(geminiFixture(invalid)).mockResolvedValueOnce(geminiFixture(understandingContent())) });
    expect(result.status).toBe("unavailable"); expect(result.trace.validationDiagnostics?.at(-1)?.rule).toBe("original_collection_not_preservable");
  });
  it("does not spend a second repair allowance after rejected citation repair", async () => {
    const invalid = understandingContent(); invalid.evidence[0].excerpt = "Unsupported quotation";
    const network = vi.fn<typeof fetch>(async () => geminiFixture(invalid));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(2); expect(result.status).toBe("unavailable"); expect(result.trace.validationRecovery).toBeUndefined();
  });
});
