import { savSupportDeliveryProjectionSchema } from "@/lib/knowledge/support-delivery";
import { SavContractValidationError } from "../validation-diagnostics";
import { savEvidenceContains } from "../evidence-text";
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
  assertSavGrounding(output, evidence, knowledgeById);
}

export function assertSavGrounding(
  output: SavAgentOutput,
  evidence: SavDecisionEvidence[],
  knowledgeById: ReadonlyMap<string, { content: string; verifiedAt: string | null; score: number; resolution?: Record<string, unknown> }> = new Map(),
) {
  const known = new Set(evidence.map((item) => item.sourceId));
  if (output.evidenceIds.some((id) => !known.has(id))) throw new Error("SAV_UNKNOWN_EVIDENCE");
  if (output.citations.some((citation) => !output.evidenceIds.includes(citation.sourceId))) throw new Error("SAV_CITATION_NOT_DECLARED");
  const hasReply = Boolean(output.replyDraft.trim());
  if (hasReply === (output.responseKind === "none")) throw new Error("SAV_RESPONSE_KIND_MISMATCH");
  // Human review is not a license to display an unsupported solution.
  const solution = output.responseKind === "solution";
  if (solution && output.citations.length === 0) throw new Error("SAV_UNGROUNDED_REPLY");
  for (const citation of output.citations) {
    const source = knowledgeById.get(citation.sourceId);
    if (!source) throw new Error("SAV_CITATION_MUST_USE_KNOWLEDGE");
    if (!evidence.some(e => e.sourceType === "knowledge" && e.sourceId === citation.sourceId && e.contentVersionId)) throw new Error("SAV_CITATION_VERSION_REQUIRED");
    const delivery = savSupportDeliveryProjectionSchema.safeParse(source.resolution?.delivery);
    const qualifiedProcedure = delivery.success && delivery.data.mode === "procedure" && delivery.data.groups.some(group => !group.requiresHuman && group.stepIds.length > 0
      && group.stepIds.every(id => { const step = delivery.data.steps.find(s => s.id === id); return !!step && savEvidenceContains(source.content, step.instruction); }));
    if (output.responseKind === "solution" && (!source.resolution || !(Array.isArray(source.resolution.steps) && source.resolution.steps.length) && !qualifiedProcedure)) throw new Error("SAV_CITATION_REQUIRES_RESOLUTION_CARD");
    if (!savEvidenceContains(source.content, citation.quote)) throw new SavContractValidationError("SAV_CITATION_QUOTE_MISMATCH", "quote_not_in_resolution_card", "citations.quote");
    if (source.score < 0.5) throw new Error("SAV_CITATION_RELEVANCE_TOO_LOW");
    if (typeof source.resolution?.validUntil === "string" && source.resolution.validUntil < new Date().toISOString().slice(0, 10)) throw new Error("SAV_CITATION_EXPIRED");
    const verifiedAt = source.verifiedAt ? new Date(source.verifiedAt) : null;
    if (!verifiedAt || Number.isNaN(verifiedAt.getTime()) || verifiedAt.getTime() > Date.now() || Date.now() - verifiedAt.getTime() > 90 * 86_400_000) throw new Error("SAV_CITATION_STALE");
  }
  if (solution || !output.requiresHuman) {
    const selected = new Set(output.evidenceIds);
    for (const [sourceId, source] of knowledgeById) {
      if (!selected.has(sourceId)) continue;
      const conflicts = Array.isArray(source.resolution?.conflictsWith) ? source.resolution.conflictsWith : [];
      if (conflicts.some((id) => typeof id === "string" && selected.has(id))) throw new Error("SAV_CONTRADICTORY_RESOLUTION_CARDS");
    }
  }
}
