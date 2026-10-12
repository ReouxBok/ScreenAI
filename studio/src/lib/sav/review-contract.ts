import { savContentHash, decryptSavPayload } from "./crypto";
import type { SavStructuredProposal } from "./proposal";
import { z } from "zod";

export const savReviewReasonSchema = z.enum(["misunderstanding", "wrong_category", "off_topic", "missing_knowledge", "incorrect_answer"]);
export const savReviewReasonsSchema = z.array(savReviewReasonSchema).max(5).default([]).transform(values => [...new Set(values)].sort());
export type SavReviewReason = z.infer<typeof savReviewReasonSchema>;
export const savReviewReasonLabels: Record<SavReviewReason, string> = {
    misunderstanding: "Mauvaise compréhension", wrong_category: "Mauvaise catégorie", off_topic: "Réponse hors sujet",
    missing_knowledge: "Connaissance manquante", incorrect_answer: "Réponse incorrecte",
};
/** Historical encrypted feedback only contained text. Never infer a reason from it. */
export function savStoredReviewReasons(value: unknown): SavReviewReason[] {
    const parsed = savReviewReasonsSchema.safeParse(value);
    return parsed.success ? parsed.data : [];
}
function understandingContent(p: SavStructuredProposal) {
    if (!p.understanding) return {};
    const material = Object.fromEntries(Object.entries(p.understanding).filter(([key]) => key !== "trace"));
    return { understanding: material };
}
function stable(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(stable);
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "collectedAt").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
    return value;
}
/** Generation IDs remain in the audit rows; hashes identify the content whose
 * verdict can survive regeneration. A draft alone cannot invalidate a dossier. */
export function savDossierSourceHash(p: SavStructuredProposal, message?: {
    bodyCiphertext: string;
    subject: string;
    fromEmail: string;
}) {
    return savContentHash(stable({ message: message ? { subject: message.subject, fromEmail: message.fromEmail, body: decryptSavPayload(message.bodyCiphertext) } : null, category: p.category, urgency: p.urgency, decision: { kind: p.decision.kind, reasonCode: p.decision.reasonCode, explanation: p.decision.explanation }, routing: p.routing,
        ticket: p.ticket, process: p.process.filter(step => step.kind !== "review_reply"), internalNote: p.internalNote, sources: p.sources, customerIdentity: p.customerIdentity,
        knowledgeRevision: p.knowledgeRevision, dossierContext: p.dossierContext, messageContext: p.messageContext, ...understandingContent(p) }));
}
export function savDraftSourceHash(p: SavStructuredProposal, message?: {
    bodyCiphertext: string;
    subject: string;
    fromEmail: string;
}, activeRevision?: string | null) {
    return savContentHash(stable({ activeRevision: activeRevision ?? null, text: p.replyDraft?.trim(), customerIdentity: p.customerIdentity, message: message ? { subject: message.subject, fromEmail: message.fromEmail, body: decryptSavPayload(message.bodyCiphertext) } : null, knowledgeRevision: p.knowledgeRevision, dossierContext: p.dossierContext, messageContext: p.messageContext, ...understandingContent(p), ...(p.understanding ? { category: p.category, decision: { kind: p.decision.kind, reasonCode: p.decision.reasonCode } } : {}), ...(p.replyAssessment ? { replyAssessment: { kind: p.replyAssessment.kind, coverage: p.replyAssessment.coverage } } : {}) }));
}
/** One validity contract for the detail, action guards and paginated inbox. */
export function savReviewMatchesProposal(review: { reviewScope: string; dossierSourceHash: string | null; decisionId: string; agentRunId: string } | null | undefined,
    source: { decisionId: string; agentRunId: string; proposal: SavStructuredProposal; message: { bodyCiphertext: string; subject: string; fromEmail: string } }) {
    return Boolean(review && (review.reviewScope === "dossier"
        ? review.dossierSourceHash === savDossierSourceHash(source.proposal, source.message)
        : review.decisionId === source.decisionId && review.agentRunId === source.agentRunId));
}
export function savDraftNotApplicable(p: SavStructuredProposal) {
    return p.decision.reasonCode === "cancellation_human_only" || !p.replyDraft?.trim();
}
