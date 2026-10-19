import type { getSavProposalReview } from "@/lib/sav/review";
import type { getSavReplyDrafts } from "@/lib/sav/drafts";
import { savReplyForbidden, savReviewReasonLabels, type SavReviewReason } from "@/lib/sav/review-contract";
import { savReplyLanguage } from "@/lib/sav/reply-language";
import { DraftEditor } from "./draft-editor";
import styles from "./proposal-review.module.css";
type Props = {
    data: NonNullable<Awaited<ReturnType<typeof getSavProposalReview>>>;
    threadId: string;
    messageId: string;
    recipient?: string;
    sourceLanguage?: string;
    inboundText?: string;
    drafts: Awaited<ReturnType<typeof getSavReplyDrafts>>;
    sendAllowed: boolean;
    sendDisabledReason?: string | null;
    replyState?: "sent" | "pending" | "uncertain" | null;
};
export function DraftReview({ data, threadId, messageId, drafts, sendAllowed, sendDisabledReason, replyState, recipient="", sourceLanguage, inboundText = "" }: Props) {
    const verdict = data.draftVerdict;
    const notApplicable = savReplyForbidden(data.proposal);
    const current=drafts.versions.find(d=>d.isCurrent) ?? null;
    const origin = data.proposal.replyAssessment?.kind;
    const originLabels: Record<string, string> = { contextualized: "Brouillon contextualisé proposé par l’IA · à relire.", finance_standard: "Réponse financière standard : elle ne confirme aucune opération exécutée.", lead_template: "Modèle standard d’orientation · à vérifier pour cette demande.", human_handoff: "Passage à un humain : aucune résolution automatisée n’est attestée.", unavailable: "Génération de réponse indisponible.", forbidden: "Aucune réponse IA autorisée pour cette demande.", none: "Aucune réponse proposée." };
    return <section className={`${styles.review} ${styles.draft}`} aria-labelledby="draft-review-title">
  <h3 id="draft-review-title" className={styles.draftTitle}>Suggestion de réponse</h3>
  <p>Le dossier est suivi sans verdict de brouillon. Copier une suggestion ne prouve ni son envoi ni la résolution.</p>
  <p role="status">{notApplicable ? "Aucune réponse autorisée pour cette demande." : replyState === "sent" ? "Réponse envoyée." : replyState === "pending" ? "Envoi en attente." : replyState === "uncertain" ? "Envoi à vérifier dans Gmail." : data.proposal.replyDraft || current && !current.stale ? "Suggestion disponible · édition facultative." : "Aucune suggestion disponible · réponse humaine possible."}</p>
  {origin && !notApplicable && <p>{originLabels[origin] ?? "Origine de la réponse à vérifier."}</p>}
  {data.proposal.replyAssessment?.coherence?.status === "unavailable" && <p role="status">Contrôle de cohérence indisponible : le brouillon contextualisé n’a pas été retenu.</p>}
  {data.proposal.replyAssessment?.coherence?.status === "rejected" && <p role="status">Le contrôle de cohérence a refusé le brouillon contextualisé. La proposition affichée demande une reprise humaine.</p>}
  {notApplicable ? <p>Aucun brouillon autorisé pour cette demande. Traitement humain via le ticket.</p> : <DraftEditor key={current?.id ?? data.draftHash}
    requiresHumanLanguage={Boolean(sourceLanguage&&!(["fr","en","unknown"].includes(sourceLanguage)))} recipient={recipient} language={savReplyLanguage(data.proposal, inboundText)} threadId={threadId} messageId={messageId} decisionId={data.decisionId} agentRunId={data.agentRunId} sourceHash={data.draftHash}
    verdictId={verdict?.id ?? null} original={data.proposal.replyDraft} current={current} currentDraftId={current?.id ?? null}
    reason={verdict?.reason ?? ""} reasons={verdict?.reasons ?? []} reasonLabels={Object.entries(savReviewReasonLabels) as [SavReviewReason,string][]}
    sendAllowed={sendAllowed} sendDisabledReason={sendDisabledReason} replyState={replyState}/>}
  {drafts && <details className={styles.sources}><summary>Historique des brouillons ({drafts.versions.length})</summary><p>Les anciennes validations globales ne constituent pas une acceptation explicite du brouillon.</p>{drafts.versions.map(draft => <article key={draft.id}><p>Version {draft.revision} · {draft.status} · {draft.createdBy}{draft.stale ? " · contexte antérieur" : ""}</p><pre>{draft.text}</pre></article>)}</details>}
 </section>;
}
