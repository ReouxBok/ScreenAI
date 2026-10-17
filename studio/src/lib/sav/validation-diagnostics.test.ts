import { describe, expect, it, vi, afterEach } from "vitest";
import { SavContractValidationError } from "./validation-diagnostics";
import { savValidationDiagnostic } from "./validation-diagnostics-server";
import { understandSavMessage } from "./understanding-model";
import { understandingContent, geminiFixture } from "../../../test/sav-understanding-fixtures";

afterEach(() => vi.unstubAllEnvs());
describe("private SAV validation diagnostics", () => {
  it("keeps structural evidence without rejected text or untrusted exception messages", () => {
    const candidate = { requests: [{ id: "secret@example.invalid", summary: "Private customer message" }], evidence: [{ excerpt: "Private quotation" }] };
    const diagnostic = savValidationDiagnostic(new Error("Provider secret@example.invalid"), "understanding", candidate);
    expect(diagnostic).toMatchObject({ rule: "validation_failed", shape: { requests: 1, evidence: 1 } });
    expect(diagnostic.candidateHash).toHaveLength(43);
    expect(JSON.stringify(diagnostic)).not.toMatch(/Private|secret@|Provider/);
  });
  it("identifies the precise rule without changing the refusal", async () => {
    const candidate = understandingContent(); candidate.requests[0].evidenceIds = ["unknown"];
    const result = await understandSavMessage({ subject: "Téléphone", body: "L’agent téléphone cesse de répondre." }, { apiKey: "fixture", fetch: vi.fn(async () => geminiFixture(candidate)) });
    expect(result.status).toBe("unavailable");
    expect(result.trace.validationDiagnostics).toContainEqual(expect.objectContaining({ phase: "understanding", rule: "unknown_evidence_reference", path: "evidenceIds" }));
  });
  it("retains the existing stable public error code", () => {
    expect(new SavContractValidationError("SAV_REPLY_OUTSIDE_REQUEST_PLAN", "unplanned_content", "coverage").message).toBe("SAV_REPLY_OUTSIDE_REQUEST_PLAN");
  });
});
