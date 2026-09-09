import { describe, expect, it } from "vitest";
import type { SavAgentToolTrace } from "@/db/schema";
import { SAV_AGENT_TOOL_NAMES, type SavAgentOutput } from "./contracts";
import { assertSavAnalysisComplete } from "./validation";

const output: SavAgentOutput = { category: "technical", urgency: "normal", ticketRequired: true,
  reasonCode: "known_issue", explanation: "Une procédure connue est applicable.", confidence: 0.99,
  requiresHuman: false, replyDraft: "Procédure", internalNote: "", evidenceIds: ["card-1"] };
const traces: SavAgentToolTrace[] = SAV_AGENT_TOOL_NAMES.map((name, index) => ({ name, sequence: index + 1, status: "succeeded", inputHash: "fixture", durationMs: 1 }));
const evidence = [{ sourceType: "knowledge" as const, sourceId: "card-1", title: "Procédure" }];
describe("SAV mandatory analysis stages", () => {
  it("rejects a confident answer that skipped a required tool", () => {
    expect(() => assertSavAnalysisComplete(output, traces.slice(1), evidence)).toThrow("SAV_REQUIRED_TOOL_UNAVAILABLE");
  });
  it("distinguishes failed tools from successful empty searches", () => {
    expect(() => assertSavAnalysisComplete(output, traces.map((trace) => ({ ...trace, status: "failed" })), evidence)).toThrow("SAV_REQUIRED_TOOL_UNAVAILABLE");
    expect(() => assertSavAnalysisComplete({ ...output, evidenceIds: [], replyDraft: "", requiresHuman: true }, traces, [])).not.toThrow();
  });
  it("rejects invented sources even when another source is real", () => {
    expect(() => assertSavAnalysisComplete({ ...output, evidenceIds: ["card-1", "invented"] }, traces, evidence)).toThrow("SAV_UNKNOWN_EVIDENCE");
  });
  it("rejects an action plan that both ignores and answers the customer", () => {
    expect(() => assertSavAnalysisComplete({ ...output, ticketRequired: false }, traces, evidence)).toThrow("SAV_INCONSISTENT_REPLY_WITHOUT_TICKET");
  });
});
