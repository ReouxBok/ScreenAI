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
/** Model-local IDs name links, not a new meaning. Preserve all material fields
 * and link targets, but use deterministic names only when hashing a verdict. */
function canonicalSemanticContent(p: SavStructuredProposal) {
    const u = p.understanding;
    if (!u) return { understanding: {}, coverage: p.replyAssessment?.coverage };
    const ids = (items: Array<{ id: string }>, prefix: string) => new Map(items.map((item, index) => [item.id, `${prefix}:${index}`]));
    const requests = ids(u.requests, "request"), evidence = ids(u.evidence, "evidence");
    const facts = ids(u.knownFacts, "fact"), attempts = ids(u.attemptedSteps, "attempt"), missing = ids(u.missingInformation, "missing");
    const ref = (map: Map<string, string>, value: string) => map.get(value) ?? value;
    const refs = (map: Map<string, string>, values: string[]) => values.map(value => ref(map, value));
    const { trace, ...material } = u;
    void trace;
    return { understanding: { understanding: { ...material,
        primaryRequestId: u.primaryRequestId === null ? null : ref(requests, u.primaryRequestId),
        requests: u.requests.map(item => ({ ...item, id: ref(requests, item.id), evidenceIds: refs(evidence, item.evidenceIds) })),
        evidence: u.evidence.map(item => ({ ...item, id: ref(evidence, item.id) })),
        knownFacts: u.knownFacts.map(item => ({ ...item, id: ref(facts, item.id), evidenceIds: refs(evidence, item.evidenceIds), ...(item.requestIds ? { requestIds: refs(requests, item.requestIds).sort() } : {}) })),
        attemptedSteps: u.attemptedSteps.map(item => ({ ...item, id: ref(attempts, item.id), evidenceIds: refs(evidence, item.evidenceIds), ...(item.requestIds ? { requestIds: refs(requests, item.requestIds).sort() } : {}) })),
        missingInformation: u.missingInformation.map(item => ({ ...item, id: ref(missing, item.id), requestIds: refs(requests, item.requestIds) })),
        uncertainties: u.uncertainties.map(item => ({ ...item, requestIds: refs(requests, item.requestIds) })),
        ...(u.customerRelationship ? { customerRelationship: { ...u.customerRelationship, evidenceIds: refs(evidence, u.customerRelationship.evidenceIds) } } : {}),
    } }, coverage: p.replyAssessment?.coverage.map(item => ({ ...item,
        requestId: ref(requests, item.requestId), missingInformationIds: refs(missing, item.missingInformationIds), repeatedAttemptIds: refs(attempts, item.repeatedAttemptIds),
    })) };
}
function stable(value: unknown, material = false): unknown {
    if (Array.isArray(value))
        return value.map(item => stable(item, material));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "collectedAt" && (!material || !["durationMs", "inputTokens", "outputTokens", "totalTokens"].includes(key))).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item, material)]));
    return value;
}
/** Generation IDs remain in the audit rows; hashes identify the content whose
 * verdict can survive regeneration. A draft alone cannot invalidate a dossier. */
function sourceBody(ciphertext: string) {
    const { supportContext, ...body } = decryptSavPayload<Record<string, unknown>>(ciphertext);
    void supportContext;
    return body;
}
export function savDossierSourceHash(p: SavStructuredProposal, message?: {
    bodyCiphertext: string;
    subject: string;
    fromEmail: string;
}, legacy = false) {
    return (legacy ? "" : "v2:") + savContentHash(stable({ message: message ? { subject: message.subject, fromEmail: message.fromEmail, body: legacy ? decryptSavPayload(message.bodyCiphertext) : sourceBody(message.bodyCiphertext) } : null, category: p.category, urgency: p.urgency, decision: { kind: p.decision.kind, reasonCode: p.decision.reasonCode, explanation: p.decision.explanation }, routing: p.routing,
        ticket: p.ticket, process: p.process.filter(step => step.kind !== "review_reply"), internalNote: p.internalNote, sources: p.sources, customerIdentity: p.customerIdentity,
        humanProcess: p.humanProcess, knowledgeRevision: p.knowledgeRevision, dossierContext: p.dossierContext, messageContext: p.messageContext, ...canonicalSemanticContent(p).understanding }, !legacy));
}
export function savDraftSourceHash(p: SavStructuredProposal, message?: {
    bodyCiphertext: string;
    subject: string;
    fromEmail: string;
}, activeRevision?: string | null) {
    return savContentHash(stable({ activeRevision: activeRevision ?? null, text: p.replyDraft?.trim(), customerIdentity: p.customerIdentity, humanProcess: p.humanProcess,
        reviewedProcess: { category:p.category,urgency:p.urgency,decision:p.decision,ticket:p.ticket,process:p.process,internalNote:p.internalNote },
        message: message ? { subject: message.subject, fromEmail: message.fromEmail, body: sourceBody(message.bodyCiphertext) } : null, knowledgeRevision: p.knowledgeRevision, dossierContext: p.dossierContext, messageContext: p.messageContext, ...canonicalSemanticContent(p).understanding, ...(p.understanding ? { category: p.category, decision: { kind: p.decision.kind, reasonCode: p.decision.reasonCode } } : {}), ...(p.replyAssessment ? { replyAssessment: { kind: p.replyAssessment.kind, coverage: canonicalSemanticContent(p).coverage } } : {}) }, true));
}
/** One validity contract for the detail, action guards and paginated inbox. */
export function savReviewMatchesProposal(review: { reviewScope: string; dossierSourceHash: string | null; decisionId: string; agentRunId: string } | null | undefined,
    source: { decisionId: string; agentRunId: string; proposal: SavStructuredProposal; message: { bodyCiphertext: string; subject: string; fromEmail: string } }) {
    return Boolean(review && (review.reviewScope === "dossier"
        ? review.dossierSourceHash === savDossierSourceHash(source.proposal, source.message, !review.dossierSourceHash?.startsWith("v2:"))
        : review.decisionId === source.decisionId && review.agentRunId === source.agentRunId));
}
export function savReplyForbidden(p: SavStructuredProposal) {
    if (p.humanProcess) return p.humanProcess.understanding.requests.some(r => ["financial_operation", "financial_data", "legal", "cancellation"].includes(r.nature));
    return ["cancellation_human_only", "finance_human_only", "legal_human_only"].includes(p.decision.reasonCode)
        || p.replyAssessment?.kind === "finance_standard" || p.replyAssessment?.kind === "forbidden"
        || p.understanding?.requests.some(r => ["financial_operation", "financial_data", "legal", "cancellation"].includes(r.nature))
        || (!p.understanding && p.category === "billing");
}
export function savDraftNotApplicable(p: SavStructuredProposal) {
    return savReplyForbidden(p) || !p.replyDraft?.trim();
}
