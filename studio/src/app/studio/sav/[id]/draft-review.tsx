import type { getSavProposalReview } from "@/lib/sav/review";
import type { getSavReplyDrafts } from "@/lib/sav/drafts";
import { savDraftNotApplicable, savReviewReasonLabels, type SavReviewReason } from "@/lib/sav/review-contract";
import { savReplyFooter } from "@/lib/sav/reply-format";
import { reviewDraftAction, sendStudioReplyAction } from "../actions";
import styles from "./proposal-review.module.css";
type Props = {
    data: NonNullable<Awaited<ReturnType<typeof getSavProposalReview>>>;
    threadId: string;
    messageId: string;
    drafts: Awaited<ReturnType<typeof getSavReplyDrafts>>;
    sendAllowed: boolean;
    sendDisabledReason?: string | null;
    replyState?: "sent" | "pending" | "uncertain" | null;
};
export function DraftReview({ data, threadId, messageId, drafts, sendAllowed, sendDisabledReason, replyState }: Props) {
    const verdict = data.draftVerdict;
    const accepted = verdict?.status === "accepted" && !verdict.stale && Boolean(verdict.draftId);
    const notApplicable = savDraftNotApplicable(data.proposal);
    const origin = data.proposal.replyAssessment?.kind;
    const originLabels: Record<string, string> = { contextualized: "Brouillon contextualisé proposé par l’IA · à relire.", finance_standard: "Réponse financière standard : elle ne confirme aucune opération exécutée.", lead_template: "Modèle standard d’orientation · à vérifier pour cette demande.", human_handoff: "Passage à un humain : aucune résolution automatisée n’est attestée.", unavailable: "Génération de réponse indisponible.", forbidden: "Aucune réponse IA autorisée pour cette demande.", none: "Aucune réponse proposée." };
    return <section className={`card ${styles.review} ${styles.draft}`} aria-labelledby="draft-review-title">
  <header><span className="eyebrow">Brouillon IA · lecture seule</span><h2 id="draft-review-title">Verdict du brouillon</h2></header>
  <p role="status">{notApplicable ? "Non applicable : aucun brouillon à accepter ou envoyer." : verdict?.stale ? "Contexte ou texte modifié : nouvelle lecture nécessaire." : accepted ? "Brouillon accepté · envoi distinct à confirmer." : verdict?.status === "rejected" ? "Brouillon refusé · traitement humain à observer." : "Brouillon à relire."}</p>
  {origin && <p>{originLabels[origin] ?? "Origine de la réponse à vérifier."}</p>}
  {data.proposal.replyAssessment?.coherence?.status === "unavailable" && <p role="status">Contrôle de cohérence indisponible : le brouillon contextualisé n’a pas été retenu.</p>}
  {data.proposal.replyAssessment?.coherence?.status === "rejected" && <p role="status">Le contrôle de cohérence a refusé le brouillon contextualisé. La proposition affichée demande une reprise humaine.</p>}
  <pre>{data.proposal.replyDraft ?? "Aucun brouillon."}</pre>
  {!notApplicable && <form action={reviewDraftAction} key={verdict?.id ?? "new"}>
   <input type="hidden" name="threadId" value={threadId}/><input type="hidden" name="messageId" value={messageId}/><input type="hidden" name="decisionId" value={data.decisionId}/><input type="hidden" name="agentRunId" value={data.agentRunId}/><input type="hidden" name="sourceHash" value={data.draftHash}/><input type="hidden" name="verdictId" value={verdict?.id ?? ""}/>
   <label>Motif du refus (facultatif)<textarea name="reason" maxLength={500} defaultValue={verdict?.status === "rejected" ? verdict.reason : ""}/></label>
   <fieldset><legend>Retours sur le brouillon (facultatif)</legend>{(Object.entries(savReviewReasonLabels) as [SavReviewReason, string][]).map(([value, label]) => <label key={value}><input type="checkbox" name="reasons" value={value} defaultChecked={verdict?.reasons?.includes(value) ?? false}/> {label}</label>)}<p>Retours conservés dans les évaluations, sans publication de connaissance.</p></fieldset>
   <div className="decision-buttons"><button className="primary" name="status" value="accepted" disabled={Boolean(replyState)}>Accepter le brouillon</button><button className="secondary" name="status" value="rejected" disabled={replyState === "sent"}>Refuser le brouillon</button></div>
   <p>Enregistre ce verdict uniquement. Le dossier reste validable indépendamment. Aucun envoi ni réécriture obligatoire.</p>
  </form>}
  {!notApplicable && <form action={sendStudioReplyAction}><input type="hidden" name="threadId" value={threadId}/><input type="hidden" name="draftId" value={accepted ? verdict!.draftId! : ""}/><button className="primary" disabled={!accepted || !sendAllowed || Boolean(replyState)}>Envoyer la réponse acceptée</button><p>{replyState === "sent" ? "Réponse déjà envoyée." : replyState === "uncertain" ? "Résultat à vérifier dans Gmail avant toute reprise." : replyState === "pending" ? "Envoi en attente. Aucun second envoi." : !sendAllowed ? sendDisabledReason : !accepted ? "Acceptez le brouillon courant avant l’envoi." : "Confirme l’envoi dans le fil Gmail d’origine."}</p></form>}
  <details className={styles.sources}><summary>Signature ajoutée uniquement à l’envoi</summary><pre>{savReplyFooter(data.proposal.messageContext?.language ?? "fr")}</pre></details>
  {drafts && <details className={styles.sources}><summary>Historique des brouillons ({drafts.versions.length})</summary><p>Les anciennes validations globales ne constituent pas une acceptation explicite du brouillon.</p>{drafts.versions.map(draft => <article key={draft.id}><p>Version {draft.revision} · {draft.status} · {draft.createdBy}{draft.stale ? " · contexte antérieur" : ""}</p><pre>{draft.text}</pre></article>)}</details>}
 </section>;
}
