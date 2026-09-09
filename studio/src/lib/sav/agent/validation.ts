import type { SavAgentToolTrace, SavDecisionEvidence } from "@/db/schema";
import { SAV_AGENT_TOOL_NAMES, type SavAgentOutput } from "./contracts";

/** A prompt request to consult a source is not proof that it was consulted. */
export function assertSavAnalysisComplete(output: SavAgentOutput, traces: SavAgentToolTrace[], evidence: SavDecisionEvidence[]) {
  for (const name of SAV_AGENT_TOOL_NAMES) {
    if (!traces.some((trace) => trace.name === name && trace.status === "succeeded" && trace.resultSummary?.unavailable !== true)) {
      throw new Error(`SAV_REQUIRED_TOOL_UNAVAILABLE:${name}`);
    }
  }
  const known = new Set(evidence.map((item) => item.sourceId));
  if (output.evidenceIds.some((id) => !known.has(id))) throw new Error("SAV_UNKNOWN_EVIDENCE");
  if (!output.ticketRequired && !output.requiresHuman && output.replyDraft.trim()) throw new Error("SAV_INCONSISTENT_REPLY_WITHOUT_TICKET");
}
