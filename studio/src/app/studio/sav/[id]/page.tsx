import Link from "next/link";
import { ArrowLeft, Bot, CheckCircle2, CircleAlert, Clock3, ExternalLink, LockKeyhole, UserRound } from "lucide-react";
import { notFound } from "next/navigation";
import { requireSavStaff as requireStaff } from "@/lib/sav/auth";
import { getSavThreadDetail } from "@/lib/sav/service";
import { getSavProposalReview } from "@/lib/sav/review";
import { savAutomationMode, savReleaseStage } from "@/lib/sav/config";
import { isSavMessageEligible } from "@/lib/sav/cutover";
import { getSavRelatedThreads } from "@/lib/sav/thread-context";
import { savActionLabels, savToolStatusLabels, savDecisionLabels, savLabel, savRunStatusLabels, savThreadStatusLabels } from "@/lib/sav/labels";
import { MailConversation } from "./mail-conversation";
import { ProposalReview } from "./proposal-review";
import { ManualTicketStatus } from "./manual-ticket-status";
import { savManualTicketError } from "@/lib/sav/manual-ticket-status";
import { getSavReplyDrafts } from "@/lib/sav/drafts";
import styles from "./thread.module.css";
import { approveDraftAction, correctDecisionAction, createTicketAction, linkTicketAction, reconcileTicketAction, requestHumanAction, retryAction, retryAnalysisAction, reviewPilotItemAction, refreshSavContextAction, repairSavProposalAction } from "../actions";

export const dynamic = "force-dynamic";
const reviewNotices: Record<string, string> = { draft_saved: "Version du brouillon enregistrée dans le Studio. Aucun email envoyé.", SAV_DRAFT_CONTEXT_CHANGED: "Le contexte a changé : relisez la proposition actuelle avant de reprendre le brouillon.", SAV_DRAFT_VERSION_CHANGED: "Une autre version a été enregistrée. Relisez la version courante.", SAV_DRAFT_PROCESS_APPROVAL_REQUIRED: "Validez d’abord le process avant de valider le brouillon en interne.", SAV_KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED: "La connaissance a changé : une nouvelle analyse est nécessaire.", SAV_CRITICAL_PROPOSAL_CORRECTION_REQUIRED: "Corrigez le process ou la réponse avant de valider une proposition IA évaluée critique.", SAV_DISTINCT_ISSUE_CONFIRMATION_REQUIRED: "Un ticket ouvert existe pour ce client. Vérifiez qu’il s’agit d’un problème distinct et justifiez la nouvelle création.", SAV_EXISTING_TICKET_REQUIRES_LINK: "Un ticket semble déjà couvrir cette demande. Vérifiez le rattachement plutôt que créer un doublon." };

const manualReplyNotices: Record<string, string> = {
  reply_sent: "Réponse envoyée dans la conversation Gmail d’origine. Le process et les connaissances n’ont pas été validés par cet envoi.",
  reply_queued: "Réponse manuelle mise en attente. Aucun second envoi ne sera créé pour cet email.",
  SAV_WRITES_DISABLED: "Envoi désactivé dans cet environnement. Aucun email envoyé.",
  SAV_REPLY_MANUAL_CONTEXT_CHANGED: "Le contexte a changé. Relisez le nouvel email, la proposition et les connaissances avant de renvoyer.",
  SAV_REPLY_MANUAL_DRAFT_CHANGED: "Ce brouillon a été remplacé. Relisez et enregistrez la version courante.",
  SAV_REPLY_MANUAL_DRAFT_REQUIRED: "Un brouillon courant non abandonné est nécessaire.",
  SAV_REPLY_MANUAL_THREAD_HEADERS_MISSING: "Impossible de garantir une réponse dans le fil d’origine. Vérifiez le message source et ses en-têtes.",
  SAV_GMAIL_THREAD_CHANGED: "Un nouvel email est arrivé dans Gmail. Synchronisez et relisez la conversation avant d’envoyer.",
  SAV_GMAIL_PREFLIGHT_INCOMPLETE: "La conversation Gmail n’a pas pu être vérifiée. Aucun email envoyé.",
  SAV_REPLY_MANUAL_RECONCILIATION_REQUIRED: "Résultat d’envoi incertain. Vérifiez les messages envoyés dans Gmail avant toute reprise ; aucun renvoi automatique.",
  SAV_REPLY_MANUAL_APPROVAL_REQUIRED: "Seul le bouton d’envoi d’un brouillon Studio courant autorise une réponse manuelle.",
  SAV_REPLY_MANUAL_INVALID: "La réponse n’a pas pu être envoyée. Vérifiez le brouillon et le contexte.",
  SAV_THREAD_PAUSED: "Ce dossier a été repris manuellement. L’envoi est bloqué dans ce parcours.",
};

const filingNotices: Record<string, string> = {
  filed: "Email classé dans MAIL STUDIO SAV et retiré de la boîte de réception Gmail. Son état lu/non lu est inchangé.",
  already_filed: "Cet email est déjà dans MAIL STUDIO SAV, hors de la boîte de réception Gmail.",
  SAV_GMAIL_FILING_DISABLED: "Ouverture enregistrée dans le Studio. Le classement Gmail est désactivé dans cet environnement : aucun email déplacé.",
  SAV_GMAIL_STUDIO_LABEL_NOT_FOUND: "Classement non effectué : le dossier MAIL STUDIO SAV n’a pas été trouvé dans cette boîte Gmail. Aucun dossier créé, aucun archivage.",
  SAV_GMAIL_STUDIO_LABEL_AMBIGUOUS: "Classement non effectué : plusieurs dossiers Gmail correspondent. Vérifiez le libellé existant.",
  SAV_GMAIL_FILING_PERMISSION_DENIED: "Classement refusé par Gmail. Vérifiez les droits du token de service, notamment gmail.modify.",
  SAV_GMAIL_FILING_UNCERTAIN: "Résultat du classement non confirmé. Vérifiez MAIL STUDIO SAV et la boîte de réception dans Gmail ; le Studio ne le marque pas comme réussi.",
  SAV_GMAIL_FILING_BEFORE_CUTOVER: "Cet email est antérieur à l’activation V0 : aucun classement Gmail effectué.",
  SAV_GMAIL_FILING_PILOT_BLOCKED: "Ce cas de simulation n’est pas modifié dans Gmail.",
  SAV_GMAIL_FILING_FAILED: "Le classement Gmail n’a pas pu être confirmé. Vous pouvez consulter le dossier SAV ; vérifiez Gmail avant de considérer le mail comme classé.",
};

export default async function SavThreadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; batch?: string; review?: string; filing?: string }> }) {
  await requireStaff("admin");
  const { id } = await params;
  const { from = "", batch = "", review = "", filing = "" } = await searchParams;
  const detail = await getSavThreadDetail(id);
  if (!detail) notFound();
  const v0 = savReleaseStage() === "v0";
  const latestInbound = [...detail.messages].reverse().find((message) => message.direction === "inbound");
  const eligible = latestInbound ? await isSavMessageEligible(latestInbound.id) : false;
  const [proposalReview, relatedThreads, replyDrafts] = await Promise.all([
    v0 && latestInbound ? getSavProposalReview(latestInbound.id) : null,
    getSavRelatedThreads(id),
    getSavReplyDrafts(id),
  ]);
  const routing = proposalReview?.proposal.routing;
  const dossier = latestInbound?.body.supportContext;
  const contactId = dossier ? dossier.crm.data?.contactId : routing?.kind === "new" || routing?.kind === "matched" ? routing.contactId : null;
  const currentDecision = [...detail.decisions].reverse().find((decision) => decision.isCurrent);
  const displayedDecision = proposalReview?.proposal.decision ?? currentDecision;
  const needsTicketReconciliation = detail.actions.some((action) => !action.payload.hubspotTicketId && (action.errorCode === "SAV_MANUAL_RECONCILIATION_REQUIRED" || action.kind === "create_ticket" && action.payload.ticketCreateDispatchedAt));
  // V0 AI suggestions cannot execute. Only a queued human request blocks another click.
  const ticketRequestPending = detail.actions.some((action) => (!v0 || action.actorType === "human") && ["create_ticket", "link_ticket"].includes(action.kind) && ["pending", "running"].includes(action.status));
  const manualTicketAction = [...detail.actions].reverse().find((action) => action.actorType === "human" && ["create_ticket", "link_ticket"].includes(action.kind)) ?? null;
  const ticketWritesDisabled = savAutomationMode() === "shadow" || process.env.SAV_WRITES_DISABLED === "true";
  const approvedDraftIds = new Set(detail.actions.map((action) => action.payload.approvedDraftId).filter((value): value is string => typeof value === "string"));
  const drafts = detail.actions.filter((action) => action.kind === "draft_reply" && action.status === "succeeded" && !approvedDraftIds.has(action.id));
  const notes = detail.actions.filter((action) => action.kind === "create_note" && action.noteText);
  const pilotExternalActions = new Set(["create_ticket", "link_ticket", "log_email", "create_note", "send_reply", "update_ticket_status"]);
  const hubspotPortalId = process.env.HUBSPOT_PORTAL_ID ?? "143641967";
  const replyAction = detail.actions.find((action) => action.kind === "send_reply" && action.messageId === latestInbound?.id && action.payload.manualReplyConfirmed === true);
  const replyState = replyAction?.status === "succeeded" ? "sent" : replyAction?.payload.replySendDispatchedAt ? "uncertain" : replyAction && ["pending", "running"].includes(replyAction.status) ? "pending" : null;
  const sendDisabledReason = detail.pilotItem ? "Simulation : aucun email réel ne peut être envoyé depuis ce dossier."
    : savAutomationMode() === "shadow" || process.env.SAV_WRITES_DISABLED === "true" ? "Les envois sont désactivés dans cet environnement. Le brouillon reste dans le Studio."
    : !v0 ? "L’envoi manuel depuis ce brouillon est réservé à la V0."
    : null;

  return <>
    {filing && <p className={`login-notice ${["filed", "already_filed", "SAV_GMAIL_FILING_DISABLED", "SAV_GMAIL_FILING_PILOT_BLOCKED"].includes(filing) ? "" : "error"}`} role="status">{filingNotices[filing] ?? filingNotices.SAV_GMAIL_FILING_FAILED}</p>}
    {review && <p className="login-notice" role="status">{({ context_refreshed: "Contexte client actualisé. La proposition existante n’a pas été modifiée.", proposal_repaired: "Proposition reconstituée. Aucun email envoyé, aucun ticket créé." } as Record<string, string>)[review] ?? manualReplyNotices[review] ?? reviewNotices[review] ?? (review === "saved" ? "Revue enregistrée. Aucun email envoyé, aucun ticket créé par cette validation." : review === "ticket_queued" ? "Action manuelle enregistrée. Le worker vérifie Gmail et HubSpot avant de l’exécuter ; si les écritures sont bloquées, elle reste en attente." : review === "ticket_reconciled" ? "Ticket existant vérifié et rapproché. Aucun nouveau ticket créé." : review.startsWith("SAV_TICKET_") || review.startsWith("SAV_LINK_") || ["SAV_MANUAL_TICKET_INVALID", "SAV_MANUAL_RECONCILIATION_REQUIRED", "SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED", "SAV_MESSAGE_BEFORE_CUTOVER"].includes(review) ? savManualTicketError(review) : `Action refusée : ${review.slice(0, 100)}`)}</p>}
    <Link className="back-link" href={from === "pilot" ? `/studio/sav/pilote?batch=${encodeURIComponent(batch || detail.pilotItem?.batchId || "")}#batch-review` : "/studio/sav"}><ArrowLeft size={14}/> {from === "pilot" ? "Retour au lot de test" : "Retour à tous les mails"}</Link>
    <div className={`sav-thread-heading ${styles.heading}`}><div><span className="eyebrow">Dossier SAV</span><h1>{detail.thread.subject}</h1></div><div className={styles.customer}><small>Client</small><strong>{detail.thread.customerEmail}</strong><span className={`sav-thread-status ${detail.thread.status}`}>{detail.thread.aiPaused ? <UserRound size={15}/> : <Bot size={15}/>} {savLabel(savThreadStatusLabels, detail.thread.status)}</span></div></div>

    <a className={styles.contextJump} href="#sav-client-context">Voir le contexte client et les actions</a>
    <section className={`sav-thread-grid ${styles.layout}`}>
      <div className={`sav-conversation ${styles.main}`}>
        <MailConversation messages={detail.messages}/>
        {proposalReview && latestInbound && <ProposalReview data={proposalReview} threadId={detail.thread.id} messageId={latestInbound.id} drafts={replyDrafts} context={{ subject: latestInbound.subject, messageCount: detail.messages.length, relatedCount: relatedThreads.length, linkedTicketId: detail.thread.hubspotTicketId }} sendAllowed={!sendDisabledReason} sendDisabledReason={sendDisabledReason} replyState={replyState}/>}
        {!proposalReview && currentDecision?.evidence.some((source) => source.claim || source.excerpt) && <section className="card sav-note"><span className="eyebrow">Preuves de la réponse</span><h2>Affirmations reliées aux fiches validées</h2><ul>{currentDecision.evidence.map((source) => <li key={`${source.sourceType}:${source.sourceId}`}><strong>{source.title}</strong>{source.claim && <p>{source.claim}</p>}{source.excerpt && <blockquote>{source.excerpt}</blockquote>}{source.verifiedAt && <small>Fiche vérifiée le {source.verifiedAt}</small>}</li>)}</ul></section>}
        {v0 && !proposalReview && <section className={`card ${styles.context}`}><span className="eyebrow">Proposition IA</span><h2>{latestInbound?.analysisErrorCode ? "Analyse à relancer" : "Aucune proposition disponible"}</h2><p>{!eligible ? "Les anciens emails ne sont pas retraités. Cet email est antérieur à l’activation V0." : latestInbound?.analysisErrorCode ? "L’email est conservé. Vérifiez l’erreur dans les actions à droite avant de relancer." : latestInbound?.processedAt ? "L’analyse enregistrée ne contient pas de proposition exploitable. Le contexte client reste consultable indépendamment." : "Analyse en attente, en cours ou email antérieur à l’activation. Les anciens emails ne sont pas retraités automatiquement."}</p>{eligible && latestInbound?.processedAt && !detail.pilotItem && <form action={repairSavProposalAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="messageId" value={latestInbound.id}/><button className="secondary">Reconstituer la proposition manquante</button><p>Uniquement pour un email éligible non revu. Aucun email envoyé, aucun ticket créé.</p></form>}</section>}

        {notes.map((note) => <article className="sav-note card" key={note.id}><header><div><span className="eyebrow">Note interne IA</span><h2>Résumé proposé pour HubSpot</h2></div><span className={`status ${note.status}`}>{detail.pilotItem && note.status === "pending" ? "Simulation · non ajoutée" : note.status === "succeeded" ? "Ajoutée au ticket" : note.status === "failed" ? "Échec d’ajout" : "En attente"}</span></header><pre>{note.noteText}</pre></article>)}

        {!proposalReview && drafts.map((draft) => <article className="sav-draft card" key={draft.id}><header><div><span className="eyebrow">Brouillon IA</span><h2>Réponse prête à relire</h2></div><span>{v0 || detail.pilotItem ? "Envoi bloqué" : "Jamais envoyée sans trace"}</span></header><pre>{draft.draftText}</pre>{v0 || detail.pilotItem ? <p className="pilot-send-lock"><LockKeyhole size={15}/> Ce brouillon ancien ou de simulation reste dans le Studio. Seule la proposition d’un nouvel email éligible permet un envoi manuel distinct.</p> : <form action={approveDraftAction}><input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="draftActionId" value={draft.id}/><button className="primary" type="submit">Approuver et mettre en file d’envoi</button></form>}</article>)}

        {detail.pilotItem && !proposalReview && <section className="pilot-review card" aria-labelledby="pilot-review-title">
          <div><span className="eyebrow">Revue humaine du batch</span><h2 id="pilot-review-title">Évaluer le travail de Charly</h2><p>Votre verdict nourrit le rapport du batch. La réponse et la résolution restent sous contrôle humain.</p></div>
          {detail.pilotItem.status === "error" ? <p className="pilot-review-error"><CircleAlert size={16}/> L’analyse a échoué : {detail.pilotItem.errorCode}</p> : ["pending", "processing"].includes(detail.pilotItem.status) ? <p className="pilot-review-error"><Clock3 size={16}/> L’analyse de ce mail est en cours. La revue s’ouvrira dès que le brouillon et les actions seront prêts.</p> : <form action={reviewPilotItemAction}>
            <input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="pilotItemId" value={detail.pilotItem.id}/>
            {from === "pilot" && <><input type="hidden" name="returnTo" value="pilot"/><input type="hidden" name="pilotBatchId" value={batch || detail.pilotItem.batchId}/></>}
            <fieldset><legend>Verdict</legend><div className="pilot-verdicts">
              {[["correct", "Correct"], ["partial", "Partiel"], ["incorrect", "Incorrect"], ["critical", "Erreur critique"]].map(([value, label]) => <label key={value}><input type="radio" name="verdict" value={value} defaultChecked={detail.pilotItem?.verdict === value || (!detail.pilotItem?.verdict && value === "correct")}/><span>{label}</span></label>)}
            </div></fieldset>
            <fieldset><legend>Qualité par dimension</legend><div className="pilot-dimensions">
              {([
                ["Classification", "dimensionClassification", detail.pilotItem.classificationVerdict],
                ["Ticket et rattachement", "dimensionRouting", detail.pilotItem.routingVerdict],
                ["Preuves et factualité", "dimensionGrounding", detail.pilotItem.groundingVerdict],
                ["Ton de la réponse", "dimensionTone", detail.pilotItem.toneVerdict],
                ["Escalade humaine", "dimensionEscalation", detail.pilotItem.escalationVerdict],
              ] as const).map(([label, name, current]) => <label key={name}>{label}<select name={name} defaultValue={current ?? detail.pilotItem?.verdict ?? "correct"}><option value="correct">Correct</option><option value="partial">Partiel</option><option value="incorrect">Incorrect</option><option value="critical">Critique</option></select></label>)}
            </div></fieldset>
            <fieldset><legend>Points à corriger</legend><div className="pilot-feedback-codes">
              {[["wrong_classification", "Mauvais tri"], ["wrong_ticket_decision", "Mauvaise décision de ticket"], ["wrong_ticket_link", "Mauvais rattachement"], ["wrong_priority", "Mauvaise priorité"], ["unsupported_claim", "Information non prouvée"], ["wrong_tone", "Ton inadapté"], ["missing_information", "Information manquante"], ["unsafe_action", "Action risquée"], ["good_without_change", "Validé sans changement"]].map(([value, label]) => <label key={value}><input type="checkbox" name="feedbackCodes" value={value} defaultChecked={detail.pilotItem?.feedbackCodes.includes(value)}/><span>{label}</span></label>)}
            </div></fieldset>
            <label>Version corrigée du brouillon<textarea name="correctedDraft" defaultValue={detail.pilotItem.correctedDraft ?? drafts[0]?.draftText ?? ""} placeholder="Collez ici la réponse qui aurait dû être envoyée."/></label>
            <label>Commentaire de revue<textarea name="comment" defaultValue={detail.pilotItem.reviewerComment} placeholder="Expliquez la correction ou ce qui a bien fonctionné."/></label>
            <button className="primary" type="submit">Enregistrer la revue</button>
          </form>}
        </section>}
      </div>

      <aside id="sav-client-context" tabIndex={-1} className={`sav-audit-rail ${styles.rail}`} aria-label="Contexte client et actions">
        <section className={`card ${styles.context}`}><span className="eyebrow">Contexte client</span><h2>Fiche HubSpot liée</h2>{contactId ? <><a href={`https://app.hubspot.com/contacts/${hubspotPortalId}/contact/${encodeURIComponent(contactId)}`} target="_blank" rel="noreferrer">Ouvrir la fiche #{contactId} <ExternalLink size={14}/></a><p>Fiche reconnue pour l’expéditeur {latestInbound?.fromEmail}. Un email d’inscription confirmé différent sera vérifié avant toute action.</p></> : <p>{dossier?.crm.status === "error" ? "Recherche HubSpot indisponible : impossible de conclure à l’absence de fiche." : dossier?.crm.data ? "Aucune fiche retrouvée pour cet email. Les correspondances nom/téléphone restent à confirmer. Aucun contact ne sera créé." : routing?.kind === "review" && routing.reason === "customer_identity_unverified" ? "Identité à vérifier : les correspondances nom/téléphone ne sont pas encore une fiche liée. Aucun contact ne sera créé." : "Contexte HubSpot non encore collecté pour cet email."}</p>}{dossier?.crm.status === "partial" && <p>Fiche recherchée, mais recherche des tickets incomplète. Réessayez avant de conclure.</p>}{dossier && <small>Contexte collecté le {new Date(dossier.collectedAt).toLocaleString("fr-FR")}</small>}{latestInbound && <form action={refreshSavContextAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="messageId" value={latestInbound.id}/><button className="secondary">Actualiser le contexte client</button></form>}</section>
        <section className={`card ${styles.context}`}><h2>Ticket lié</h2>{detail.thread.hubspotTicketId ? <a href={`https://app.hubspot.com/contacts/${hubspotPortalId}/ticket/${encodeURIComponent(detail.thread.hubspotTicketId)}`} target="_blank" rel="noreferrer">Ticket #{detail.thread.hubspotTicketId} <ExternalLink size={14}/></a> : <><p>Aucun ticket lié à ce dossier.</p>{routing?.kind === "matched" && <p>Correspondance proposée : <a href={`https://app.hubspot.com/contacts/${hubspotPortalId}/ticket/${encodeURIComponent(routing.ticketId)}`} target="_blank" rel="noreferrer">#{routing.ticketId} <ExternalLink size={12}/></a>. Rattachement manuel à confirmer.</p>}</>}{!!dossier?.crm.data?.tickets.length && <><h3>Tickets retrouvés sur la fiche</h3><ul>{dossier.crm.data.tickets.map((ticket) => <li key={ticket.id}><a href={`https://app.hubspot.com/contacts/${hubspotPortalId}/ticket/${encodeURIComponent(ticket.id)}`} target="_blank" rel="noreferrer">{ticket.subject} · #{ticket.id}</a><small>{ticket.status === "closed" ? "Fermé" : "Ouvert"} · rattachement à vérifier</small></li>)}</ul></>}</section>
        <section className={`card ${styles.context}`}><h2>Conversations liées</h2>{relatedThreads.length ? <ul>{relatedThreads.map((thread) => <li key={thread.id}><Link href={`/studio/sav/${thread.id}`}>{thread.subject}</Link><small>{thread.relationLabel} · {thread.lastMessageAt.toLocaleDateString("fr-FR")}</small></li>)}</ul> : <p>Aucun lien fiable détecté dans les références email disponibles.</p>}{!!dossier?.otherConversations.length && <><h3>Autres échanges retrouvés</h3><ul>{dossier.otherConversations.filter((thread) => !relatedThreads.some((related) => related.id === thread.id)).map((thread) => <li key={thread.id}><Link href={`/studio/sav/${thread.id}`}>{thread.subject}</Link><small>{thread.relation}</small></li>)}</ul></>}{dossier?.otherConversationsError && <p>Recherche des autres échanges indisponible.</p>}<p>Recherche bornée dans les emails synchronisés du même expéditeur. Une correspondance d’expéditeur ne prouve pas qu’il s’agit du même problème. Aucune fusion automatique.</p></section>
        <section className={`card ${styles.actions}`}><span className="eyebrow">Actions manuelles</span><h2>Agir sur ce dossier</h2>
          {detail.pilotItem ? <p className="pilot-send-lock"><LockKeyhole size={15}/> Simulation stricte : aucune action Gmail ou HubSpot ne peut être exécutée depuis ce dossier.</p> : <>
            {v0 && <>
              <p>Valider le process ne crée pas de ticket. La création et le rattachement demandent un clic séparé.</p>
              {ticketWritesDisabled && <p className="login-notice">Écritures HubSpot désactivées : les boutons enregistrent une demande qui restera en attente.</p>}
              {!detail.thread.hubspotTicketId && <ManualTicketStatus action={manualTicketAction} writesDisabled={ticketWritesDisabled}/>}
              {!detail.thread.hubspotTicketId && (needsTicketReconciliation ? <><button className="primary" disabled>Créer un ticket HubSpot</button><p>Création bloquée : vérifiez et rapprochez le ticket existant ci-dessous.</p></> : ticketRequestPending ? <><button className="primary" disabled>Demande HubSpot en attente</button><p>Une demande de création ou de rattachement est déjà enregistrée. Suivi disponible dans le journal d’actions.</p></> : proposalReview?.review?.status === "approved" ? <>
                <form action={createTicketAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="reviewId" value={proposalReview.review.id}/><label>Si ce client a déjà un ticket ouvert : pourquoi est-ce un problème distinct ?<textarea name="distinctIssueReason" maxLength={2_000} placeholder="Justification humaine, au moins 20 caractères si nécessaire"/></label><button className="primary">Créer un ticket HubSpot</button></form>
                <details><summary>Rattacher à un ticket existant</summary><form action={linkTicketAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="reviewId" value={proposalReview.review.id}/><label>ID du ticket existant<input name="ticketId" required pattern="[0-9]+" defaultValue={routing?.kind === "matched" ? routing.ticketId : ""}/></label><button className="secondary">Confirmer le rattachement</button></form></details>
              </> : <><button className="primary" disabled>Créer un ticket HubSpot</button><p>Validez d’abord la proposition courante ci-dessous.</p></>)}
            </>}
            {!v0 && !detail.thread.hubspotTicketId && <form action={createTicketAction}><input type="hidden" name="threadId" value={id}/><button className="secondary">Créer le ticket HubSpot</button></form>}
            {!detail.thread.aiPaused && <form action={requestHumanAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="reason" value="Reprise demandée depuis le registre SAV"/><button className="ghost-danger">Transférer à un humain</button></form>}
          </>}
          {detail.thread.humanDueAt && <p className="human-deadline"><Clock3 size={15}/> Réponse humaine attendue avant le {new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(detail.thread.humanDueAt)}</p>}
          {latestInbound?.analysisErrorCode && <><h3>Erreur d’analyse</h3><code>{latestInbound.analysisErrorCode}</code>{latestInbound.analysisStatus === "failed" && !latestInbound.processedAt && <form action={retryAnalysisAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="messageId" value={latestInbound.id}/><button className="secondary">Relancer l’analyse après correction</button></form>}</>}
          {detail.actions.filter((action) => (action.errorCode === "SAV_MANUAL_RECONCILIATION_REQUIRED" || action.kind === "create_ticket" && action.status === "failed" && action.payload.ticketCreateDispatchedAt) && !action.payload.hubspotTicketId).map((action) => <div key={action.id}><h3>Vérification manuelle obligatoire</h3><p>La création a peut-être abouti. Ne recréez pas le ticket. Retrouvez-le dans HubSpot puis confirmez son ID ; le serveur vérifiera le compte associé et le contenu avant rapprochement.</p><form action={reconcileTicketAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="actionId" value={action.id}/><label>ID du ticket trouvé<input name="ticketId" pattern="[0-9]+" required/></label><label>Confirmation de votre vérification<input name="reason" minLength={10} required/></label><button className="secondary">Vérifier et rapprocher ce ticket existant</button></form></div>)}
        </section>
        <section className="card sav-decision-card"><span className="eyebrow">{proposalReview?.review ? "Décision du process revu" : "Décision proposée par l’IA"}</span><h2>{displayedDecision ? savLabel(savDecisionLabels, displayedDecision.kind) : "Non justifiée"}</h2><p>{displayedDecision?.explanation ?? "Aucune décision n’a encore été enregistrée."}</p>{displayedDecision && <div className="confidence"><span style={{ width: `${displayedDecision.confidence / 10}%` }}/><small>{Math.round(displayedDecision.confidence / 10)} % de confiance</small></div>}</section>

        {!v0 && currentDecision && <details className="card sav-correction"><summary>Corriger cette décision</summary><form action={correctDecisionAction}><input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="decisionId" value={currentDecision.id}/><label>Décision<select name="kind" defaultValue={currentDecision.kind === "ticket_pending" ? "human_review_required" : currentDecision.kind}><option value="ticket_created">Ticket créé</option><option value="attached_to_existing_ticket">Ticket existant</option><option value="no_ticket_needed">Aucun ticket nécessaire</option><option value="spam">Spam</option><option value="internal_notification">Notification interne</option><option value="automatic_reply">Réponse automatique</option><option value="bounce">Échec de remise</option><option value="duplicate">Doublon</option><option value="human_review_required">Humain requis</option></select></label><label>Code du motif<input name="reasonCode" defaultValue={currentDecision.reasonCode}/></label><label>Justification<textarea name="explanation" defaultValue={currentDecision.explanation}/></label><button className="primary" type="submit">Enregistrer la correction</button></form></details>}

        <details className={`card ${styles.audit}`}><summary>Traçabilité et journal d’actions</summary>
        <section className="sav-agent-runs"><span className="eyebrow">Traçabilité technique</span><h2>Exécutions de l’agent</h2>{detail.agentRuns.length === 0 ? <p>Aucune exécution enregistrée pour les anciens messages.</p> : <ol>{[...detail.agentRuns].reverse().map((run) => <li key={run.id}><details><summary><span><Bot size={14}/>{run.runtime === "google_adk" ? "Google ADK" : run.runtime.replaceAll("_", " ")}</span><em className={`run-status ${run.status}`}>{savLabel(savRunStatusLabels, run.status)}</em></summary><div className="agent-run-detail"><dl><div><dt>Mode</dt><dd>{run.mode}</dd></div><div><dt>Modèle</dt><dd>{run.model}</dd></div><div><dt>Prompt</dt><dd>{run.promptRevision}</dd></div><div><dt>Durée</dt><dd>{run.durationMs} ms</dd></div></dl>{run.errorCode && <code>{run.errorCode}</code>}{run.fallbackRuntime && <p>Repli de sécurité : {run.fallbackRuntime}</p>}<div><strong>Sources retenues</strong>{run.evidence.length ? <ul>{run.evidence.map((source) => <li key={`${run.id}:${source.sourceType}:${source.sourceId}`}>{source.sourceType} · {source.title}</li>)}</ul> : <small>Aucune source retenue.</small>}</div><div><strong>Outils appelés</strong>{run.toolTrace.length ? <ul>{run.toolTrace.map((tool) => <li key={`${run.id}:${tool.sequence}`}>{tool.name} · {savLabel(savToolStatusLabels, tool.status)} · {tool.durationMs} ms</li>)}</ul> : <small>Aucun outil appelé.</small>}</div></div></details></li>)}</ol>}</section>

        <section className="sav-timeline"><span className="eyebrow">Journal d’actions</span><ol>{detail.actions.map((action) => { const simulated = Boolean(detail.pilotItem && pilotExternalActions.has(action.kind)); return <li key={action.id}><span className={`action-icon ${action.status}`}>{action.status === "succeeded" ? <CheckCircle2 size={14}/> : action.status === "failed" ? <CircleAlert size={14}/> : <Clock3 size={14}/>}</span><div><strong>{savLabel(savActionLabels, action.kind)}</strong><small>{savLabel(savToolStatusLabels, action.status)} · {simulated && action.status === "pending" ? "Simulation · non exécutée" : simulated && action.status === "succeeded" ? "Exécutée · incident du pilote précédent" : action.actorType === "human" ? action.actorEmail : "Charly / système"} · {new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(action.createdAt)}</small>{action.errorCode && <code>{action.errorCode}</code>}{action.status === "failed" && !detail.pilotItem && !action.payload.replySendDispatchedAt && !(action.payload.ticketCreateDispatchedAt && !action.payload.hubspotTicketId) && <form action={retryAction}><input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="actionId" value={action.id}/><button className="button small secondary" type="submit">Réessayer</button></form>}</div></li>; })}</ol></section>
        </details>
      </aside>
    </section>
  </>;
}
