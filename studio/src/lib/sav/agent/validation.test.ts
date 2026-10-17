import { describe, expect, it } from "vitest";
import type { SavAgentToolTrace } from "@/db/schema";
import { SAV_AGENT_TOOL_NAMES, type SavAgentOutput } from "./contracts";
import { assertSavAnalysisComplete } from "./validation";

const output: SavAgentOutput = { category: "technical", urgency: "normal", ticketRequired: true,
  reasonCode: "known_issue", explanation: "Une procédure connue est applicable.", confidence: 0.99,
  requiresHuman: false, responseKind: "solution", replyDraft: "Procédure", internalNote: "", evidenceIds: ["card-1"],
  citations: [{ sourceId: "card-1", claim: "Utiliser la procédure", quote: "Cliquez sur Enregistrer" }] };
const traces: SavAgentToolTrace[] = SAV_AGENT_TOOL_NAMES.map((name, index) => ({ name, sequence: index + 1, status: "succeeded", inputHash: "fixture", durationMs: 1 }));
const evidence = [{ sourceType: "knowledge" as const, sourceId: "card-1", contentVersionId: "card-version-1", title: "Procédure" }];
const freshKnowledge = new Map([["card-1", { content: "Cliquez sur Enregistrer pour appliquer la modification.", verifiedAt: new Date().toISOString(), score: 0.9, resolution: { steps: ["Cliquez sur Enregistrer"], conflictsWith: [] } }]]);
describe("SAV mandatory analysis stages", () => {
  it("rejects a confident answer that skipped a required tool", () => {
    expect(() => assertSavAnalysisComplete(output, traces.slice(1), evidence, freshKnowledge)).toThrow("SAV_REQUIRED_TOOL_UNAVAILABLE");
  });
  it("distinguishes failed tools from successful empty searches", () => {
    expect(() => assertSavAnalysisComplete(output, traces.map((trace) => ({ ...trace, status: "failed" })), evidence, freshKnowledge)).toThrow("SAV_REQUIRED_TOOL_UNAVAILABLE");
    expect(() => assertSavAnalysisComplete({ ...output, evidenceIds: [], citations: [], responseKind: "none", replyDraft: "", requiresHuman: true }, traces, [])).not.toThrow();
  });
  it("rejects invented sources even when another source is real", () => {
    expect(() => assertSavAnalysisComplete({ ...output, evidenceIds: ["card-1", "invented"] }, traces, evidence, freshKnowledge)).toThrow("SAV_UNKNOWN_EVIDENCE");
  });
  it("allows a grounded Studio draft without demanding a new ticket", () => {
    expect(() => assertSavAnalysisComplete({ ...output, ticketRequired: false }, traces, evidence, freshKnowledge)).not.toThrow();
  });
  it("requires the same grounding for a solution under human review", () => {
    expect(() => assertSavAnalysisComplete({ ...output, requiresHuman: true }, traces, evidence, freshKnowledge)).not.toThrow();
    expect(() => assertSavAnalysisComplete({ ...output, requiresHuman: true, citations: [] }, traces, evidence, freshKnowledge)).toThrow("SAV_UNGROUNDED_REPLY");
    const conflicting = new Map([
      ["card-1", { ...freshKnowledge.get("card-1")!, resolution: { steps: ["A"], conflictsWith: ["card-2"] } }],
      ["card-2", { ...freshKnowledge.get("card-1")!, resolution: { steps: ["B"], conflictsWith: ["card-1"] } }],
    ]);
    expect(() => assertSavAnalysisComplete({ ...output, requiresHuman: true, evidenceIds: ["card-1", "card-2"] }, traces,
      [...evidence, { sourceType: "knowledge", sourceId: "card-2", title: "Conflicting card" }], conflicting)).toThrow("SAV_CONTRADICTORY_RESOLUTION_CARDS");
  });
  it("rejects unsupported, weak or stale quotations", () => {
    expect(() => assertSavAnalysisComplete({ ...output, citations: [] }, traces, evidence, freshKnowledge)).toThrow("SAV_UNGROUNDED_REPLY");
    expect(() => assertSavAnalysisComplete({ ...output, citations: [{ ...output.citations[0], quote: "Texte absent de la fiche" }] }, traces, evidence, freshKnowledge)).toThrow("SAV_CITATION_QUOTE_MISMATCH");
    expect(() => assertSavAnalysisComplete(output, traces, evidence, new Map([["card-1", { ...freshKnowledge.get("card-1")!, score: 0.2 }]]))).toThrow("SAV_CITATION_RELEVANCE_TOO_LOW");
    expect(() => assertSavAnalysisComplete(output, traces, evidence, new Map([["card-1", { ...freshKnowledge.get("card-1")!, verifiedAt: "2020-01-01" }]]))).toThrow("SAV_CITATION_STALE");
    expect(() => assertSavAnalysisComplete(output, traces, evidence, new Map([["card-1", { ...freshKnowledge.get("card-1")!, resolution: { steps: ["A"], validUntil: "2020-01-01" } }]]))).toThrow("SAV_CITATION_EXPIRED");
  });
  it("requires a recorded source version and refuses future verification dates", () => {
    expect(() => assertSavAnalysisComplete(output, traces, evidence.map(({ contentVersionId, ...source }) => { void contentVersionId; return source; }), freshKnowledge)).toThrow("SAV_CITATION_VERSION_REQUIRED");
    expect(() => assertSavAnalysisComplete(output, traces, evidence, new Map([["card-1", { ...freshKnowledge.get("card-1")!, verifiedAt: new Date(Date.now() + 86400000).toISOString() }]]))).toThrow("SAV_CITATION_STALE");
  });
  it.each(["valid", "human_only", "unproven_step", "bad_reference"])("checks the qualified procedure catalog strictly: %s", scenario => {
    const delivery = { version: 1, mode: "procedure", steps: [{ id: "step-one", userLabel: "Contrôle", instruction: scenario === "unproven_step" ? "Instruction absente" : "Cliquez sur Enregistrer", expectedResult: "", prerequisites: [], exceptions: [], escalation: "" }], groups: [{ id: "procedure", label: "Parcours fictif", requiresHuman: scenario === "human_only", stepIds: [scenario === "bad_reference" ? "unknown-step" : "step-one"], prerequisites: [], exceptions: [], expectedResult: "", escalation: "" }] };
    const sources = new Map([["card-1", { ...freshKnowledge.get("card-1")!, resolution: { steps: [], delivery } }]]);
    const check = () => assertSavAnalysisComplete(output, traces, evidence, sources);
    if (scenario === "valid") expect(check).not.toThrow();
    else expect(check).toThrow("SAV_CITATION_REQUIRES_RESOLUTION_CARD");
  });
  it("allows a claim-free acknowledgement without manufacturing a citation", () => {
    expect(() => assertSavAnalysisComplete({ ...output, responseKind: "acknowledgement", replyDraft: "Votre demande est bien reçue.", evidenceIds: [], citations: [] }, traces, [])).not.toThrow();
  });
  it("rejects unstructured or contradictory resolution sources for an autonomous solution", () => {
    expect(() => assertSavAnalysisComplete(output, traces, evidence, new Map([["card-1", { ...freshKnowledge.get("card-1")!, resolution: undefined }]]))).toThrow("SAV_CITATION_REQUIRES_RESOLUTION_CARD");
    const contradictoryOutput = { ...output, evidenceIds: ["card-1", "card-2"] };
    const contradictoryEvidence = [...evidence, { sourceType: "knowledge" as const, sourceId: "card-2", title: "Autre procédure" }];
    const contradictoryKnowledge = new Map([
      ["card-1", { ...freshKnowledge.get("card-1")!, resolution: { steps: ["A"], conflictsWith: ["card-2"] } }],
      ["card-2", { ...freshKnowledge.get("card-1")!, resolution: { steps: ["B"], conflictsWith: ["card-1"] } }],
    ]);
    expect(() => assertSavAnalysisComplete(contradictoryOutput, traces, contradictoryEvidence, contradictoryKnowledge)).toThrow("SAV_CONTRADICTORY_RESOLUTION_CARDS");
  });
});
