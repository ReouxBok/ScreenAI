import { z } from "zod";
import type { SavDecisionEvidence } from "@/db/schema";
import type { SavAnalysis } from "./intelligence";

export const savRoutingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), reason: z.string() }),
  z.object({ kind: z.literal("new"), reason: z.string(), contactId: z.string() }),
  z.object({ kind: z.literal("matched"), reason: z.string(), ticketId: z.string(), contactId: z.string() }),
  z.object({ kind: z.literal("review"), reason: z.string(), candidateIds: z.array(z.string()).default([]) }),
]);
export type SavProposalRouting = z.infer<typeof savRoutingSchema>;
export const savStructuredProposalSchema = z.object({
  schemaVersion: z.literal(1),
  category: z.enum(["technical", "account", "billing", "integration", "how_to", "acknowledgement", "other"]),
  urgency: z.enum(["low", "normal", "high", "critical"]),
  decision: z.object({ kind: z.string(), reasonCode: z.string(), explanation: z.string(), confidence: z.number().int().min(0).max(1000) }),
  routing: savRoutingSchema,
  ticket: z.object({ title: z.string().max(500), description: z.string().max(100_000) }),
  process: z.array(z.object({ kind: z.enum(["human_review", "create_ticket", "link_ticket", "product_step", "review_reply", "verify_outcome"]), label: z.string().min(3).max(2_000), sourceIds: z.array(z.string()) })).min(1).max(30),
  internalNote: z.string().nullable(),
  replyDraft: z.string().nullable(),
  sources: z.array(z.object({ sourceType: z.string(), sourceId: z.string(), contentVersionId: z.string().optional(), title: z.string(), claim: z.string().optional(), excerpt: z.string().optional() })),
  knowledgeRevision: z.string(),
  model: z.string(),
  identityCandidates: z.array(z.object({ contactId: z.string(), name: z.string(), email: z.string(), phoneHint: z.string(), matchedBy: z.enum(["name", "phone"]), confirmed: z.literal(false) })).max(10).default([]),
  customerIdentity: z.object({ registrationEmail: z.email().nullable(), verifiedByHuman: z.boolean() }).default({ registrationEmail: null, verifiedByHuman: false }),
}).strict();
export type SavStructuredProposal = z.infer<typeof savStructuredProposalSchema>;

/** This is a proposed process for the reviewer, never a queue of executable steps. */
export function buildSavStructuredProposal(input: { subject: string; body: string }, analysis: SavAnalysis) {
  const routing = analysis.ticketRouting ?? { kind: "review" as const, reason: "hubspot_context_unavailable", candidateIds: [] };
  const process: SavStructuredProposal["process"] = [];
  const support = ["ticket_pending", "human_review_required"].includes(analysis.proposal.kind);
  if (analysis.proposal.requiresHumanApproval || routing.kind === "review") process.push({ kind: "human_review", label: analysis.proposal.explanation, sourceIds: [] });
  if (support && routing.kind === "new") process.push({ kind: "create_ticket", label: "Vérifier la proposition, puis créer le ticket HubSpot par un clic humain séparé.", sourceIds: [] });
  if (support && routing.kind === "matched") process.push({ kind: "link_ticket", label: `Vérifier le rattachement au ticket HubSpot ${routing.ticketId} avant toute action.`, sourceIds: [routing.ticketId] });
  if (!analysis.proposal.requiresHumanApproval) {
    for (const source of analysis.evidence.filter((item) => item.sourceType === "knowledge" && item.excerpt)) {
      process.push({ kind: "product_step", label: source.excerpt!, sourceIds: [source.sourceId] });
    }
  }
  if (analysis.replyDraft) process.push({ kind: "review_reply", label: "Relire le brouillon dans le Studio. Envoyer la réponse uniquement par un clic humain distinct, dans le fil Gmail d’origine.", sourceIds: analysis.evidence.filter((source) => source.sourceType === "knowledge").map((source) => source.sourceId) });
  if (!process.length) process.push({ kind: "verify_outcome", label: "Vérifier cette qualification sans créer de nouveau ticket.", sourceIds: [] });
  return savStructuredProposalSchema.parse({
    schemaVersion: 1, category: analysis.category, urgency: analysis.urgency,
    decision: { kind: analysis.proposal.kind, reasonCode: analysis.proposal.reasonCode, explanation: analysis.proposal.explanation, confidence: analysis.proposal.confidence },
    routing, ticket: { title: input.subject.trim().split(/\s+/).slice(0, 5).join(" ").slice(0, 500) || "Demande support à vérifier", description: input.body },
    process, internalNote: analysis.internalNote, replyDraft: analysis.replyDraft,
    sources: analysis.evidence.map((source: SavDecisionEvidence) => ({ sourceType: source.sourceType, sourceId: source.sourceId, contentVersionId: source.contentVersionId, title: source.title, claim: source.claim, excerpt: source.excerpt })),
    knowledgeRevision: analysis.knowledgeRevision ?? "not_consulted", model: analysis.model, identityCandidates: analysis.identityCandidates ?? [],
  });
}
