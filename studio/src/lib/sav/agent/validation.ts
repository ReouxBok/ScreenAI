import type { SavAgentToolTrace, SavDecisionEvidence } from "@/db/schema";
import { SAV_AGENT_TOOL_NAMES, type SavAgentOutput } from "./contracts";

/** A prompt request to consult a source is not proof that it was consulted. */
export function assertSavAnalysisComplete(
  output: SavAgentOutput,
  traces: SavAgentToolTrace[],
  evidence: SavDecisionEvidence[],
  knowledgeById: ReadonlyMap<string, { content: string; verifiedAt: string | null; score: number; resolution?: Record<string, unknown> }> = new Map(),
) {
  for (const name of SAV_AGENT_TOOL_NAMES) {
    if (!traces.some((trace) => trace.name === name && trace.status === "succeeded" && trace.resultSummary?.unavailable !== true)) {
      throw new Error(`SAV_REQUIRED_TOOL_UNAVAILABLE:${name}`);
    }
  }
  const known = new Set(evidence.map((item) => item.sourceId));
  if (output.evidenceIds.some((id) => !known.has(id))) throw new Error("SAV_UNKNOWN_EVIDENCE");
  if (output.citations.some((citation) => !output.evidenceIds.includes(citation.sourceId))) throw new Error("SAV_CITATION_NOT_DECLARED");
  const hasReply = Boolean(output.replyDraft.trim());
  if (hasReply === (output.responseKind === "none")) throw new Error("SAV_RESPONSE_KIND_MISMATCH");
  const solution = output.responseKind === "solution" && !output.requiresHuman;
  if (solution && output.citations.length === 0) throw new Error("SAV_UNGROUNDED_REPLY");
  for (const citation of output.citations) {
    const source = knowledgeById.get(citation.sourceId);
    if (!source) throw new Error("SAV_CITATION_MUST_USE_KNOWLEDGE");
    if (output.responseKind === "solution" && (!source.resolution || !Array.isArray(source.resolution.steps))) throw new Error("SAV_CITATION_REQUIRES_RESOLUTION_CARD");
    const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("fr");
    if (!normalize(source.content).includes(normalize(citation.quote))) throw new Error("SAV_CITATION_QUOTE_MISMATCH");
    if (source.score < 0.5) throw new Error("SAV_CITATION_RELEVANCE_TOO_LOW");
    const verifiedAt = source.verifiedAt ? new Date(source.verifiedAt) : null;
    if (!verifiedAt || Number.isNaN(verifiedAt.getTime()) || Date.now() - verifiedAt.getTime() > 90 * 86_400_000) throw new Error("SAV_CITATION_STALE");
  }
  if (!output.requiresHuman) {
    const selected = new Set(output.evidenceIds);
    for (const [sourceId, source] of knowledgeById) {
      if (!selected.has(sourceId)) continue;
      const conflicts = Array.isArray(source.resolution?.conflictsWith) ? source.resolution.conflictsWith : [];
      if (conflicts.some((id) => typeof id === "string" && selected.has(id))) throw new Error("SAV_CONTRADICTORY_RESOLUTION_CARDS");
    }
  }
  if (!output.ticketRequired && !output.requiresHuman && output.replyDraft.trim()) throw new Error("SAV_INCONSISTENT_REPLY_WITHOUT_TICKET");
}
