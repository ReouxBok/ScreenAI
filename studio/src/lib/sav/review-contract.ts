import { savContentHash, decryptSavPayload } from "./crypto";
import type { SavStructuredProposal } from "./proposal";
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
        knowledgeRevision: p.knowledgeRevision, dossierContext: p.dossierContext, messageContext: p.messageContext }));
}
export function savDraftSourceHash(p: SavStructuredProposal, message?: {
    bodyCiphertext: string;
    subject: string;
    fromEmail: string;
}, activeRevision?: string | null) {
    return savContentHash(stable({ activeRevision: activeRevision ?? null, text: p.replyDraft?.trim(), customerIdentity: p.customerIdentity, message: message ? { subject: message.subject, fromEmail: message.fromEmail, body: decryptSavPayload(message.bodyCiphertext) } : null, knowledgeRevision: p.knowledgeRevision, dossierContext: p.dossierContext, messageContext: p.messageContext }));
}
export function savDraftNotApplicable(p: SavStructuredProposal) {
    return p.decision.reasonCode === "cancellation_human_only" || !p.replyDraft?.trim();
}
