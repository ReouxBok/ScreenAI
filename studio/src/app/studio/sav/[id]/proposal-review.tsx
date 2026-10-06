import type { getSavProposalReview } from "@/lib/sav/review";
import type { getSavReplyDrafts } from "@/lib/sav/drafts";
import { savCategoryLabels, savDecisionLabels, savLabel, savProcessLabels, savRoutingLabels, savRoutingReasonLabels, savUrgencyLabels, savVerdictLabels } from "@/lib/sav/labels";
import { reviewProposalAction, saveReplyDraftAction, sendStudioReplyAction } from "../actions";
import styles from "./proposal-review.module.css";
import { savReplyFooter } from "@/lib/sav/reply-format";

const verdicts = [["correct", "Correct"], ["partial", "Partiel"], ["incorrect", "Incorrect"], ["critical", "Critique"]] as const;
type Props = { data: NonNullable<Awaited<ReturnType<typeof getSavProposalReview>>>; threadId: string; messageId: string;
  drafts?: Awaited<ReturnType<typeof getSavReplyDrafts>>; context?: { subject: string; messageCount: number; relatedCount: number; linkedTicketId: string | null };
  sendAllowed?: boolean; sendDisabledReason?: string | null; replyState?: "sent" | "pending" | "uncertain" | null };

export function ProposalReview({ data, threadId, messageId, drafts, context, sendAllowed = false, sendDisabledReason, replyState }: Props) {
  const p = data.proposal;
  const current = drafts?.versions.find((draft) => draft.isCurrent);
  const knowledge = p.sources.filter((source) => source.sourceType === "knowledge" && (source.claim || source.excerpt || p.process.some((step) => step.sourceIds.includes(source.sourceId))));
  const contactId = p.dossierContext?.crm.data?.contactId ?? (p.routing.kind === "new" || p.routing.kind === "matched" ? p.routing.contactId : null);
  const ticketId = context?.linkedTicketId || (p.routing.kind === "matched" ? p.routing.ticketId : null);
  return <section className={`pilot-review card ${styles.review}`} aria-labelledby="proposal-review-title">
    <header><span className="eyebrow">À relire et corriger</span><h2 id="proposal-review-title">Proposition de l’IA</h2></header>
    {data.review && <p className="login-notice">Process {data.review.status === "approved" ? "validé" : "à reprendre"} par {data.review.reviewedBy} · {data.review.reviewedAt.toLocaleString("fr-FR")} · évaluation initiale : {savLabel(savVerdictLabels, data.review.verdict)}</p>}
    <form action={reviewProposalAction} key={`${current?.id ?? "new"}:${data.review?.id ?? "unreviewed"}`}>
      <input type="hidden" name="threadId" value={threadId}/><input type="hidden" name="messageId" value={messageId}/><input type="hidden" name="decisionId" value={data.decisionId}/><input type="hidden" name="agentRunId" value={data.agentRunId}/><input type="hidden" name="reviewId" value={data.review?.id ?? ""}/><input type="hidden" name="knowledgeRevision" value={drafts?.knowledgeRevision ?? ""}/><input type="hidden" name="draftId" value={current?.id ?? ""}/>
      <section className={styles.section}><h3>Résumé du sujet</h3>
        <p className={styles.summary}>{p.internalNote?.replace(/^Analyse pilote IA — à valider\s*/u, "").trim() || p.decision.explanation}</p>
        {context && <p>Sujet du client : {context.subject}</p>}
        <ul className={styles.contextList}>
          <li>Fiche HubSpot : {contactId ? `retrouvée · contact #${contactId}` : p.routing.reason === "customer_identity_unverified" ? "email non reconnu, identité à confirmer" : "non confirmée dans cette analyse"}.</li>
          <li>Ticket : {ticketId ? `retrouvé · #${ticketId}` : "aucun ticket confirmé pour cette demande"}.</li>
          {!!p.dossierContext?.crm.data?.tickets.length && <li>Tickets sur la fiche : {p.dossierContext.crm.data.tickets.map(ticket => `${ticket.subject} (#${ticket.id})`).join(" ; ")}. À distinguer d’un rattachement confirmé à cette demande.</li>}
          {!!p.dossierContext?.otherConversations.length && <li>Autres échanges du même expéditeur : {p.dossierContext.otherConversations.length}, sujets à vérifier.</li>}
          {context && <><li>Conversation : {context.messageCount} message{context.messageCount > 1 ? "s" : ""} dans ce fil.</li><li>Autres fils reliés : {context.relatedCount || "aucun"}.</li></>}
        </ul>
        {p.routing.kind === "review" && p.routing.reason === "customer_identity_unverified" && <div className="login-notice"><p>Aucun contact ne sera créé. Le nom et le téléphone servent uniquement à retrouver des candidats.</p>{p.identityCandidates.length ? <ul>{p.identityCandidates.map((candidate) => <li key={candidate.contactId}>{candidate.name} · {candidate.email} · {candidate.phoneHint} · correspondance par {candidate.matchedBy === "phone" ? "téléphone" : "nom"}, à vérifier humainement (contact #{candidate.contactId}).</li>)}</ul> : <p>Aucune correspondance nom/téléphone confirmée. Demander l’adresse email d’inscription Limova dans la réponse.</p>}</div>}
      </section>
      <section className={styles.section}><h3>Action proposée</h3>
        <p><strong>{ticketId ? "Rattacher au ticket existant" : ["ticket_pending", "human_review_required"].includes(p.decision.kind) ? p.routing.kind === "review" ? "Vérifier le client avant de créer un ticket" : "Proposer la création d’un ticket" : savLabel(savDecisionLabels, p.decision.kind)}</strong></p><p>{p.decision.explanation}</p>
        <fieldset><legend>Ticket proposé · création par un clic séparé</legend>
          <label>Titre (5 mots maximum)<input name="title" defaultValue={p.ticket.title} required maxLength={500}/></label>
          <div className={styles.ticketMetrics}><span>Pipeline <strong>Support</strong></span><span>Statut <strong>Nouveau</strong></span><span>Propriétaire <strong>Non assigné</strong></span><span>Source <strong>Email</strong></span></div>
          <div className="pilot-dimensions"><label>Catégorie<select name="category" defaultValue={p.category}>{["technical", "account", "billing", "integration", "how_to", "acknowledgement", "other"].map((value) => <option key={value} value={value}>{savLabel(savCategoryLabels, value)}</option>)}</select></label><label>Urgence<select name="urgency" defaultValue={p.urgency}>{["low", "normal", "high", "critical"].map((value) => <option key={value} value={value}>{savLabel(savUrgencyLabels, value)}</option>)}</select></label></div>
          <label>Description complète<textarea name="description" defaultValue={p.ticket.description} required rows={5}/></label>
          <p>Valider le process ne crée pas ce ticket. Le bouton de création reste dans les actions du dossier.</p>
        </fieldset>
      </section>
      <section className={styles.section}><h3 id="studio-draft-title">Proposition de brouillon de réponse</h3>
        {current?.stale && <p role="status">Le brouillon précédent est obsolète. La proposition actuelle est affichée : relisez-la avant de l’enregistrer ou de l’envoyer.</p>}
        <label>Réponse au client<textarea name="replyDraft" rows={9} maxLength={10_000} defaultValue={!current?.stale && current?.status !== "abandoned" ? current?.text ?? p.replyDraft ?? "" : p.replyDraft ?? ""}/></label>
        <details className={styles.sources}><summary>Signature ajoutée uniquement à l’envoi</summary><pre>{savReplyFooter(p.messageContext?.language ?? "fr")}</pre>{!p.messageContext && <><p>Pour un message client en anglais, l’avertissement utilisé sera :</p><pre>{savReplyFooter("en")}</pre></>}<p>Elle ne fait pas partie du brouillon. Cliquer sur Envoyer autorise la réponse ci-dessus avec cette signature ; valider le process n’envoie rien.</p></details>
        <div className="decision-buttons"><button className="secondary" formAction={saveReplyDraftAction} formNoValidate>Enregistrer le brouillon</button><button className="primary" formAction={sendStudioReplyAction} formNoValidate disabled={!sendAllowed || Boolean(replyState)}>Envoyer la réponse</button></div>
        <p>{replyState === "sent" ? "Réponse déjà envoyée pour cet email." : replyState === "pending" ? "Envoi en cours ou en attente. Aucun second envoi ne sera créé." : replyState === "uncertain" ? "Résultat d’envoi à vérifier dans Gmail. Ne pas renvoyer automatiquement." : !sendAllowed ? sendDisabledReason ?? "L’envoi n’est pas disponible pour ce dossier. Le brouillon reste dans le Studio." : "Ce bouton envoie uniquement cette réponse dans le fil Gmail d’origine. Il ne valide ni le process ni une connaissance."}</p>
        {drafts && <details className={styles.sources}><summary>Historique des brouillons ({drafts.versions.length}{drafts.versions.length === 50 ? " dernières versions" : ""})</summary>{drafts.versions.map((draft) => <article key={draft.id}><p>Version {draft.revision} · {draft.status === "abandoned" ? "Abandonné" : draft.status === "validated" ? "Validé en interne" : "Brouillon"}{draft.stale ? " · contexte obsolète" : ""} · {draft.createdBy}</p><pre>{draft.text}</pre></article>)}</details>}
      </section>
      <section className={styles.section}><h3>Connaissances utilisées</h3>{knowledge.length ? <ul>{knowledge.map((source, index) => <li key={`${source.sourceId}:${index}`}><strong>{source.title}</strong>{source.claim && <p>{source.claim}</p>}</li>)}</ul> : <p>Aucune connaissance spécifique utilisée dans cette proposition.</p>}</section>
      <details className={styles.sources}><summary>Corriger le process et la qualification</summary>
        <fieldset><legend>Process proposé</legend>{p.process.map((step, index) => <label key={index}>{index + 1}. {savLabel(savProcessLabels, step.kind)}<input type="hidden" name={`processKind_${index}`} value={step.kind}/><input type="hidden" name={`processSources_${index}`} value={JSON.stringify(step.sourceIds)}/><textarea name={`processLabel_${index}`} defaultValue={step.kind === "review_reply" && step.label.includes("Aucun envoi email") ? "Relire le brouillon, puis envoyer uniquement par le bouton distinct « Envoyer la réponse » dans le fil Gmail d’origine." : step.label} required minLength={3}/></label>)}<input type="hidden" name="processCount" value={p.process.length}/><label>Étapes supplémentaires (une par ligne)<textarea name="additionalSteps"/></label></fieldset>
        <label>Décision<select name="decisionKind" defaultValue={p.decision.kind}>{["ticket_pending", "no_ticket_needed", "human_review_required", "spam", "internal_notification", "automatic_reply", "bounce", "duplicate"].map((value) => <option key={value} value={value}>{savLabel(savDecisionLabels, value)}</option>)}</select></label><input type="hidden" name="reasonCode" value={p.decision.reasonCode}/><label>Justification<textarea name="explanation" defaultValue={p.decision.explanation} required minLength={10}/></label>
        <fieldset><legend>Compte Limova confirmé</legend><label>Email d’inscription vérifié<input type="email" name="registrationEmail" defaultValue={p.customerIdentity.registrationEmail ?? ""}/></label><label><input type="checkbox" name="identityVerified" defaultChecked={p.customerIdentity.verifiedByHuman}/> J’ai vérifié le compte du demandeur</label><p>Aucun nouveau contact ne sera créé.</p></fieldset><label>Résumé interne<textarea name="internalNote" defaultValue={p.internalNote ?? ""}/></label>
        <p>Rattachement : {savLabel(savRoutingLabels, p.routing.kind)} · {savLabel(savRoutingReasonLabels, p.routing.reason, "Motif à vérifier")}</p>
      </details>
      <details className={styles.sources}><summary>Évaluer la proposition et proposer une connaissance</summary>
        <fieldset><legend>Évaluation de l’IA d’origine</legend><label>Verdict global<select name="verdict" defaultValue={data.review?.verdict ?? "correct"}>{verdicts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="pilot-dimensions">{[["classification", "Classification"], ["routing", "Rattachement"], ["grounding", "Fiabilité"], ["tone", "Ton"], ["escalation", "Escalade"]].map(([key, label]) => <label key={key}>{label}<select name={`dimension_${key}`} defaultValue={data.review?.dimensions[key] ?? "correct"}>{verdicts.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>)}</div><label>Commentaire (facultatif)<textarea name="comment" defaultValue={data.review?.comment ?? ""}/></label></fieldset>
        <fieldset><legend>Connaissance à faire valider séparément</legend><label>Réutilisation<select name="reusability" defaultValue="none"><option value="none">Évaluation seulement</option><option value="tone_only">Ton uniquement</option><option value="customer_specific">Cas propre à ce client</option><option value="reusable">Procédure réutilisable à proposer à Ugo</option></select></label><label>Procédure générique (sans donnée client)<textarea name="reusableResolution"/></label><label>Pourquoi est-elle réutilisable ?<textarea name="justification"/></label></fieldset>
      </details>
      <div className={styles.validation}><button className="primary" type="submit">Valider le process corrigé</button><p>Enregistre le process et l’évaluation. Une connaissance proposée doit ensuite être validée séparément par Ugo. Aucun email envoyé, aucun ticket créé, aucune connaissance publiée par ce bouton.</p></div>
    </form>
  </section>;
}
