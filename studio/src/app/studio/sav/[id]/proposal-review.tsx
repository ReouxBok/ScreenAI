import { formatParisDateTime } from "@/lib/paris-date";
import type { getSavProposalReview } from "@/lib/sav/review";
import type { getSavReplyDrafts } from "@/lib/sav/drafts";
import type { SavStructuredProposal } from "@/lib/sav/proposal";
import { savLabel, savRoutingLabels, savRoutingReasonLabels, savVerdictLabels } from "@/lib/sav/labels";
import { reviewProposalAction } from "../actions";
import { savReviewReasonLabels, type SavReviewReason } from "@/lib/sav/review-contract";
import { ProcessEditor } from "./process-editor";
import styles from "./dossier.module.css";

export const SAV_REVIEW_FORM_ID = "sav-review-form";
const verdicts = [["correct", "Correct"], ["partial", "Partiel"], ["incorrect", "Incorrect"], ["critical", "Critique"]] as const;
type Ticket = { id: string; subject: string; status: "open" | "closed"; stageId?: string | null; ownerName?: string | null; ownerId?: string | null };
type Props = { tickets?: Ticket[]; data: NonNullable<Awaited<ReturnType<typeof getSavProposalReview>>>; threadId: string; messageId: string;
  drafts?: Awaited<ReturnType<typeof getSavReplyDrafts>> };

/** Identity confirmation lives next to the HubSpot record (section 2) but submits with the dossier form. */
export function IdentityCheck({ proposal: p }: { proposal: SavStructuredProposal }) {
  return <div className={styles.inlineNote}>
    <label><input form={SAV_REVIEW_FORM_ID} type="checkbox" name="identityVerified" defaultChecked={p.customerIdentity.verifiedByHuman}/> J’ai vérifié le compte du demandeur</label>
    <label>Email d’inscription vérifié <input form={SAV_REVIEW_FORM_ID} type="email" name="registrationEmail" defaultValue={p.customerIdentity.registrationEmail ?? ""} placeholder="si différent"/></label>
    <small>Aucun nouveau contact ne sera créé.</small>
  </div>;
}

/** Name/phone candidates are only search hints, never a linked record. */
export function IdentityCandidates({ proposal: p }: { proposal: SavStructuredProposal }) {
  if (p.routing.kind !== "review" || p.routing.reason !== "customer_identity_unverified") return null;
  return <div className="login-notice"><p>Aucun contact ne sera créé. Le nom et le téléphone servent uniquement à retrouver des candidats.</p>{p.identityCandidates.length ? <ul>{p.identityCandidates.map((candidate) => <li key={candidate.contactId}>{candidate.name || "Nom non renseigné"} · {candidate.email} · {candidate.phoneHint} · correspondance par {candidate.matchedBy === "phone" ? "téléphone" : "nom"}, à vérifier humainement.</li>)}</ul> : <p>Aucune correspondance nom/téléphone confirmée. Vérifier les informations déjà fournies ; demander l’adresse email d’inscription uniquement si elle manque réellement.</p>}</div>;
}

export function ProposalReview({ data, threadId, messageId, drafts, tickets }: Props) {
  const p = data.proposal;
  return <>
    {data.review && <p className={`login-notice ${styles.panel}`} role="status">{data.review.scope==="legacy_global"?"Revue globale historique · ":"Dossier · "}{data.review.status === "approved" ? "validé" : "à reprendre"} par {data.review.reviewedBy} · {formatParisDateTime(data.review.reviewedAt)} · évaluation initiale : {savLabel(savVerdictLabels, data.review.verdict)}</p>}
    {data.historicalReview && <p className={styles.panel} role="status">Une revue antérieure est conservée dans l’historique. Le dossier actuel doit être relu.</p>}
    <form id={SAV_REVIEW_FORM_ID} action={reviewProposalAction} key={data.expectedReviewId ?? "unreviewed"} aria-labelledby="proposal-review-title">
      <h3 id="proposal-review-title" hidden>Proposition de l’IA</h3>
      <input type="hidden" name="threadId" value={threadId}/><input type="hidden" name="messageId" value={messageId}/><input type="hidden" name="decisionId" value={data.decisionId}/><input type="hidden" name="agentRunId" value={data.agentRunId}/><input type="hidden" name="reviewId" value={data.expectedReviewId ?? data.review?.id ?? ""}/><input type="hidden" name="knowledgeRevision" value={drafts?.knowledgeRevision ?? ""}/>
      <input type="hidden" name="reasonCode" value={p.decision.reasonCode}/>
      <ProcessEditor proposal={p} tickets={tickets ?? p.dossierContext?.crm.data?.tickets ?? []}/>
      <div className={styles.panel}>
        <details className={styles.optional}><summary>Évaluer la proposition de l’IA · facultatif<small>Verdict, erreurs constatées, procédure réutilisable à proposer à Ugo</small></summary><div>
          <fieldset><legend>Erreurs de la proposition IA d’origine (facultatif)</legend>{(Object.entries(savReviewReasonLabels) as [SavReviewReason, string][]).map(([value, label]) => <label key={value}><input type="checkbox" name="reasons" value={value} defaultChecked={data.review?.reasons?.includes(value) ?? false}/> {label}</label>)}<p className={styles.hint}>Ces motifs sont conservés comme cas d’évaluation. Une mauvaise compréhension ou catégorie ne crée aucune connaissance produit.</p></fieldset>
          <fieldset><legend>Évaluation de l’IA d’origine</legend><label>Verdict global<select name="verdict" defaultValue={data.review?.verdict ?? "correct"}>{verdicts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className={styles.fields}>{[["classification", "Classification"], ["routing", "Rattachement"], ["grounding", "Fiabilité"], ["tone", "Ton"], ["escalation", "Escalade"]].map(([key, label]) => <label key={key}>{label}<select name={`dimension_${key}`} defaultValue={data.review?.dimensions[key] ?? "correct"}>{verdicts.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>)}</div><label>Commentaire (facultatif)<textarea name="comment" defaultValue={data.review?.comment ?? ""}/></label></fieldset>
          <fieldset><legend>Connaissance à faire valider séparément</legend><label>Réutilisation<select name="reusability" defaultValue="none"><option value="none">Évaluation seulement</option><option value="tone_only">Ton uniquement</option><option value="customer_specific">Cas propre à ce client</option><option value="reusable">Procédure réutilisable à proposer à Ugo</option></select></label><label>Procédure générique (sans donnée client)<textarea name="reusableResolution"/></label><label>Pourquoi est-elle réutilisable ?<textarea name="justification"/></label></fieldset>
        </div></details>
        <details className={styles.optional}><summary>Compléments internes · facultatif<small>Justification générale et résumé interne conservés avec le dossier</small></summary><div>
          <label>Justification générale<textarea name="explanation" defaultValue={p.decision.explanation} required minLength={10}/></label>
          <label>Résumé interne<textarea name="internalNote" defaultValue={p.internalNote ?? ""}/></label>
          <p className={styles.hint}>Rattachement proposé par l’IA : {savLabel(savRoutingLabels, p.routing.kind)} · {savLabel(savRoutingReasonLabels, p.routing.reason, "Motif à vérifier")}</p>
        </div></details>
      </div>
      <div className={styles.footer}>
        <p>Enregistre le dossier et l’évaluation. Une connaissance proposée doit ensuite être validée séparément par Ugo. Aucun email envoyé, aucun ticket créé, aucune connaissance publiée par ce bouton.</p>
        <button className="primary" type="submit">Valider le dossier</button>
      </div>
    </form>
  </>;
}
