import { sortSavTicketsNewestFirst } from "@/lib/sav/ticket-lifecycle";
import { formatParisDateTime } from "@/lib/paris-date";
import Link from "next/link";
import { ArrowLeft, Bot, CheckCircle2, CircleAlert, Clock3, ExternalLink, LockKeyhole, UserRound } from "lucide-react";
import { notFound } from "next/navigation";
import { requireSavStaff as requireStaff } from "@/lib/sav/auth";
import { getSavThreadDetail } from "@/lib/sav/service";
import { getSavExternalCompletion } from "@/lib/sav/external-completion";
import { getSavProposalReview } from "@/lib/sav/review";
import { savAutomationMode, savReleaseStage } from "@/lib/sav/config";
import { isSavMessageEligible } from "@/lib/sav/cutover";
import { getSavRelatedThreads } from "@/lib/sav/thread-context";
import { resolveSavCustomerMessage } from "@/lib/sav/forwarded-identity";
import { savActionLabels, savToolStatusLabels, savDecisionLabels, savLabel, savRunStatusLabels, savThreadStatusLabels } from "@/lib/sav/labels";
import { getSavPartnershipTransferState, isSavPartnershipForward } from "@/lib/sav/partnership-forward";
import { PartnershipTransfer } from "../partnership-transfer";
import { DossierViewport } from "./dossier-viewport";
import { SavFilingProgress } from "../filing-progress";
import { SavDossierOpened, SavDossierBackLink } from "../dossier-opened";
import { TicketSelector } from "./ticket-selector";
import { savTicketStageLabel } from "./ticket-status-label";
import { DossierSection } from "./dossier-section";
import { FindingsSummary, UsedKnowledge } from "./findings-summary";
import { UnderstandingReview } from "./understanding-review";
import layout from "./dossier.module.css";
import { SavContextProgress } from "../context-progress";
import { MailConversation } from "./mail-conversation";
import { ProposalReview, IdentityCheck, IdentityCandidates } from "./proposal-review";
import { ManualTicketStatus } from "./manual-ticket-status";
import { savManualTicketError } from "@/lib/sav/manual-ticket-status";
import { ResolutionObservation } from "./resolution-observation";
import { getSavObservations } from "@/lib/sav/observations";
import { DraftReview } from "./draft-review";
import { getSavReplyDrafts } from "@/lib/sav/drafts";
import styles from "./thread.module.css";
import { reconcileTicketReturnAction, approveDraftAction, correctDecisionAction, createTicketAction, reconcileTicketAction, requestHumanAction, retryAction, retryAnalysisAction, reviewPilotItemAction, refreshSavContextAction, repairSavProposalAction } from "../actions";

export const dynamic = "force-dynamic";
const reviewNotices: Record<string, string> = { SAV_PROCESS_ACTION_IN_PROGRESS: "Une action est en cours ou son résultat reste à vérifier. Attendez son résultat avant de modifier le process.", SAV_TICKET_TITLE_REQUIRED: "Le titre du nouveau ticket doit résumer le problème en 4 à 6 mots.", SAV_HUMAN_PROCESS_CONFIRMATION_REQUIRED: "Vérifiez l’action et le ticket, puis confirmez votre choix dans le process.", draft_saved: "Version du brouillon enregistrée dans le Studio. Aucun email envoyé.", SAV_DRAFT_CONTEXT_CHANGED: "Le contexte a changé : relisez la proposition actuelle avant de reprendre le brouillon.", SAV_DRAFT_VERSION_CHANGED: "Une autre version a été enregistrée. Relisez la version courante.", SAV_DRAFT_PROCESS_APPROVAL_REQUIRED: "Validez d’abord le process avant de valider le brouillon en interne.", SAV_KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED: "La connaissance a changé : une nouvelle analyse est nécessaire.", SAV_CRITICAL_PROPOSAL_CORRECTION_REQUIRED: "Corrigez le process ou la réponse avant de valider une proposition IA évaluée critique.", SAV_DISTINCT_ISSUE_CONFIRMATION_REQUIRED: "Un ticket ouvert existe pour ce client. Vérifiez qu’il s’agit d’un problème distinct et justifiez la nouvelle création.", SAV_EXISTING_TICKET_REQUIRES_LINK: "Un ticket semble déjà couvrir cette demande. Vérifiez le rattachement plutôt que créer un doublon.", SAV_CONTEXT_REFRESH_FAILED: "Le contexte HubSpot n’a pas pu être actualisé complètement. Aucune demande de création ou de rattachement n’a été enregistrée. Réessayez après vérification de l’accès HubSpot." };

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

export default async function SavThreadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; batch?: string; review?: string; filing?: string; filingId?: string; context?: string; refreshId?: string; returnTo?: string }> }) {
  const staff = await requireStaff("admin");
  const { id } = await params;
  const { from = "", batch = "", review = "", filing = "", filingId = "", context = "", refreshId = "", returnTo } = await searchParams;
  const detail = await getSavThreadDetail(id);
  if (!detail) notFound();
  const v0 = savReleaseStage() === "v0";
  const latestInbound = [...detail.messages].filter(message => message.direction === "inbound").sort((a, b) => b.receivedAt?.getTime() - a.receivedAt?.getTime() || b.createdAt?.getTime() - a.createdAt?.getTime() || b.id.localeCompare(a.id))[0];
  const customerMessage = latestInbound ? resolveSavCustomerMessage({ fromEmail: latestInbound.fromEmail, subject: latestInbound.subject, body: latestInbound.body.text }) : null;
  const isForward = customerMessage && customerMessage.kind !== "sender";
  const eligible = latestInbound ? await isSavMessageEligible(latestInbound.id) : false;
  const [proposalReview, relatedThreads, replyDrafts, observations, partnershipState, externalCompletion] = await Promise.all([
    v0 && latestInbound ? getSavProposalReview(latestInbound.id) : null,
    isForward ? Promise.resolve([]) : getSavRelatedThreads(id),
    getSavReplyDrafts(id),
    getSavObservations(id),
    v0 && !detail.pilotItem ? getSavPartnershipTransferState(id) : null,
    v0 && !detail.pilotItem && latestInbound ? getSavExternalCompletion(latestInbound) : null,
  ]);
  const routing = proposalReview?.proposal.routing;
  const savedDossier = latestInbound?.body.supportContext;
  // Historical enrichment of the forwarding colleague is not customer context.
  // A deliberate refresh is required before presenting it as the client's CRM.
  const dossier = !isForward || customerMessage.kind === "forwarded"
    && savedDossier?.customerIdentity?.kind === "forwarded" && savedDossier.customerIdentity.email === customerMessage.email
    ? savedDossier : undefined;
  const customerContextBlocked = Boolean(isForward && !dossier);
  const crmTickets = sortSavTicketsNewestFirst(dossier?.crm.data?.tickets ?? []);
  const ticketMatch = dossier?.crm.data?.routing;
  const newTicketTitle = proposalReview?.proposal.ticket.title || latestInbound?.subject || detail.thread.subject;
  const returnUncertain = detail.actions.some(action => action.payload.ticketReturnDispatchedAt && !action.payload.ticketReturnCompletedAt || action.kind === "link_ticket" && action.errorCode === "SAV_TICKET_ACK_CONTEXT_CHANGED");
  const returnCompleted = detail.actions.some(action => action.messageId === latestInbound?.id && action.status === "succeeded" && ["create_ticket", "link_ticket"].includes(action.kind) && action.actorType === "human");
  const linkedHubspotTicket = detail.thread.hubspotTicketId ? dossier?.crm.data?.tickets.find((ticket) => ticket.id === detail.thread.hubspotTicketId) : undefined;
  const contactId = customerContextBlocked ? null : dossier ? dossier.crm.data?.contactId : routing?.kind === "new" || routing?.kind === "matched" ? routing.contactId : null;
  const contactName = contactId ? dossier?.crm.data?.contactName ?? (proposalReview?.proposal.dossierContext?.crm.data?.contactId === contactId ? proposalReview.proposal.dossierContext.crm.data.contactName : null) : null;
  const currentDecision = [...detail.decisions].reverse().find((decision) => decision.isCurrent);
  const displayedDecision = proposalReview?.proposal.decision ?? currentDecision;
  const needsTicketReconciliation = detail.actions.some((action) => action.kind === "create_ticket" && action.errorCode === "SAV_TICKET_ACK_CONTEXT_CHANGED" || !action.payload.hubspotTicketId && (action.errorCode === "SAV_MANUAL_RECONCILIATION_REQUIRED" || action.kind === "create_ticket" && action.payload.ticketCreateDispatchedAt));
  // V0 AI suggestions cannot execute. Only a queued human request blocks another click.
  const ticketRequestPending = detail.actions.some((action) => (!v0 || action.actorType === "human") && ["create_ticket", "link_ticket"].includes(action.kind) && ["pending", "running"].includes(action.status));
  const manualTicketAction = [...detail.actions].reverse().find((action) => action.actorType === "human" && ["create_ticket", "link_ticket"].includes(action.kind) && (!action.messageId || action.messageId === latestInbound?.id)) ?? null;
  const currentTicketFailure = manualTicketAction?.messageId === latestInbound?.id || !manualTicketAction?.messageId
    ? manualTicketAction && ["failed", "cancelled"].includes(manualTicketAction.status) : false;
  const persistedTicketNotice = ["ticket_queued", "ticket_done", "ticket_processing_deferred", "ticket_reconciled"].includes(review)
    ? currentTicketFailure ? savManualTicketError(manualTicketAction?.errorCode ?? null)
      : returnUncertain ? savManualTicketError("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED")
      : needsTicketReconciliation ? savManualTicketError("SAV_MANUAL_RECONCILIATION_REQUIRED")
      : returnCompleted && detail.thread.hubspotTicketId ? "Action ticket terminée. Le ticket confirmé est lié au dossier."
      : ticketRequestPending ? "Demande HubSpot en attente de confirmation. Consultez son suivi ci-dessous."
      : "Consultez le suivi de l’action et le ticket lié : ce lien de retour ne confirme aucun résultat." : null;
  const ticketWritesDisabled = savAutomationMode() === "shadow" || process.env.SAV_WRITES_DISABLED === "true";
  const approvedDraftIds = new Set(detail.actions.map((action) => action.payload.approvedDraftId).filter((value): value is string => typeof value === "string"));
  const drafts = detail.actions.filter((action) => action.kind === "draft_reply" && action.status === "succeeded" && !approvedDraftIds.has(action.id));
  const notes = detail.actions.filter((action) => action.kind === "create_note" && action.noteText);
  const pilotExternalActions = new Set(["create_ticket", "link_ticket", "log_email", "create_note", "send_reply", "update_ticket_status"]);
  const hubspotPortalId = process.env.HUBSPOT_PORTAL_ID ?? "143641967";
  const replyAction = detail.actions.find((action) => action.kind === "send_reply" && !isSavPartnershipForward(action) && action.messageId === latestInbound?.id && action.payload.manualReplyConfirmed === true);
  const replyState = replyAction?.status === "succeeded" ? "sent" : replyAction?.payload.replySendDispatchedAt ? "uncertain" : replyAction && ["pending", "running"].includes(replyAction.status) ? "pending" : null;
  const sendDisabledReason = detail.pilotItem ? "Simulation : aucun email réel ne peut être envoyé depuis ce dossier."
    : customerContextBlocked ? "Identité du client transféré à vérifier : actualisez le contexte avant toute réponse."
    : savAutomationMode() === "shadow" || process.env.SAV_WRITES_DISABLED === "true" ? "Les envois sont désactivés dans cet environnement. Le brouillon reste dans le Studio."
    : !v0 ? "L’envoi manuel depuis ce brouillon est réservé à la V0."
    : null;

  const suggestedTicketId = proposalReview?.proposal.humanProcess ? proposalReview.proposal.humanProcess.ticketId ?? null : ticketMatch?.kind === "matched" ? ticketMatch.ticketId : null;
  const dossierApproved = proposalReview?.review?.status === "approved";
  const ticketActionNeeded = !dossierApproved || ["ticket_pending", "human_review_required"].includes(proposalReview?.proposal.decision.kind ?? "");
  type ProgressState = "done" | "todo" | "alert" | "pending";
  const progress: { label: string; detail: string; state: ProgressState }[] = [
    { label: "Conversation", detail: `${detail.messages.length} message${detail.messages.length > 1 ? "s" : ""}`, state: "done" },
    latestInbound?.analysisErrorCode ? { label: "Analyse de l’agent", detail: "Erreur d’analyse", state: "alert" }
      : proposalReview ? { label: "Analyse de l’agent", detail: "Proposition disponible", state: "done" } : { label: "Analyse de l’agent", detail: "En attente", state: "todo" },
    dossierApproved ? { label: "Dossier validé", detail: `Par ${proposalReview?.review?.reviewedBy}`, state: "done" }
      : proposalReview?.review ? { label: "Dossier validé", detail: "À reprendre", state: "alert" }
      : proposalReview ? { label: "Dossier validé", detail: "À valider", state: "todo" } : { label: "Dossier validé", detail: "Après l’analyse", state: "pending" },
    returnUncertain || needsTicketReconciliation ? { label: "Action HubSpot", detail: "Résultat à vérifier", state: "alert" }
      : ticketRequestPending ? { label: "Action HubSpot", detail: "En cours", state: "todo" }
      : currentTicketFailure ? { label: "Action HubSpot", detail: "Action non aboutie", state: "alert" }
      : detail.thread.hubspotTicketId ? { label: "Action HubSpot", detail: "Ticket lié", state: "done" }
      : !ticketActionNeeded ? { label: "Action HubSpot", detail: "Aucune action ticket", state: "done" }
      : dossierApproved ? { label: "Action HubSpot", detail: "À préparer", state: "todo" } : { label: "Action HubSpot", detail: "Après validation", state: "pending" },
    replyState === "sent" ? { label: "Réponse", detail: "Envoyée", state: "done" }
      : replyState === "uncertain" ? { label: "Réponse", detail: "Envoi à vérifier", state: "alert" }
      : replyState === "pending" ? { label: "Réponse", detail: "En file d’envoi", state: "todo" } : { label: "Réponse", detail: "À relire", state: "pending" },
  ];

  return <DossierViewport key={id}>
    {externalCompletion && <p className="login-notice" role="status"><strong>Traité hors Studio.</strong> Ce message a été classé administrativement le {formatParisDateTime(externalCompletion.createdAt)}. Cela ne valide ni la proposition IA ni le brouillon et ne crée aucun apprentissage. Un nouvel email revient dans le flux normal.</p>}
    {v0 && !detail.pilotItem && eligible && latestInbound && !latestInbound.studioOpenedAt && <SavDossierOpened threadId={id} messageId={latestInbound.id}/>}
    {filing === "pending" && /^[a-f0-9-]{36}$/i.test(filingId) && <SavFilingProgress threadId={id} commandId={filingId}/> }
    {filing && (filing !== "pending" || !/^[a-f0-9-]{36}$/i.test(filingId)) && <p className={`login-notice ${["filed", "already_filed", "SAV_GMAIL_FILING_DISABLED", "SAV_GMAIL_FILING_PILOT_BLOCKED"].includes(filing) ? "" : "error"}`} role="status">{filingNotices[filing] ?? filingNotices.SAV_GMAIL_FILING_FAILED}</p>}
    {refreshId && <SavContextProgress threadId={id} requestId={refreshId}/>}
    {context && !refreshId && <p className={`login-notice ${context === "refreshed" ? "" : "error"}`} role="status">{context === "refreshed" ? "Contexte client actualisé à l’ouverture du dossier." : "Contexte HubSpot incomplet : vérifiez l’accès puis utilisez « Actualiser le contexte client »."}</p>}
    {review && <p className="login-notice" role="status">{({ observation_qualified: "Bilan qualifié. Aucune connaissance publiée.", draft_reviewed: "Verdict du brouillon enregistré. Aucun email envoyé, aucun ticket créé.", SAV_DRAFT_READ_ONLY: "Le brouillon IA est en lecture seule.", context_refreshed: "Contexte client actualisé. La proposition existante n’a pas été modifiée.", proposal_repaired: "Proposition reconstituée. Aucun email envoyé, aucun ticket créé." } as Record<string, string>)[review] ?? persistedTicketNotice ?? manualReplyNotices[review] ?? reviewNotices[review] ?? (review === "saved" ? "Revue enregistrée. Aucun email envoyé, aucun ticket créé par cette validation." : review === "ticket_queued" ? "Action enregistrée. Son exécution immédiate ou son état en cours est visible dans le journal ; le worker planifié reprend toute action encore en attente." : review === "ticket_done" ? "Action ticket exécutée et confirmée par HubSpot. Consultez le journal pour le ticket concerné." : review === "ticket_processing_deferred" ? "Action enregistrée durablement. Le traitement immédiat n’a pas pu démarrer ; le worker planifié la reprendra et son état restera visible dans le journal." : review === "ticket_reconciled" ? "Ticket existant vérifié et rapproché. Aucun nouveau ticket créé." : review.startsWith("SAV_TICKET_") || review.startsWith("SAV_LINK_") || ["SAV_MANUAL_TICKET_INVALID", "SAV_MANUAL_RECONCILIATION_REQUIRED", "SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED", "SAV_PROPOSAL_STALE", "SAV_MESSAGE_BEFORE_CUTOVER"].includes(review) ? savManualTicketError(review) : `Action refusée : ${review.slice(0, 100)}`)}</p>}
    {from === "pilot" ? <Link className="back-link" href={`/studio/sav/pilote?batch=${encodeURIComponent(batch || detail.pilotItem?.batchId || "")}#batch-review`}><ArrowLeft size={14}/> Retour au lot de test</Link> : <div className="back-link"><SavDossierBackLink threadId={id} returnTo={returnTo}/></div>}
    <div className={`sav-thread-heading ${styles.heading}`}><div><span className="eyebrow">Dossier SAV</span><h1>{customerMessage?.subject ?? detail.thread.subject}</h1></div><div className={styles.customer}><small>Client</small><strong>{customerMessage?.email ?? (isForward ? "Identité à vérifier" : detail.thread.customerEmail)}</strong>{isForward && <small>Transféré par {latestInbound?.fromEmail}. Une réponse Gmail restera adressée à ce collègue dans le fil d’origine.</small>}<span className={`sav-thread-status ${detail.thread.status}`}>{detail.thread.aiPaused ? <UserRound size={15}/> : <Bot size={15}/>} {savLabel(savThreadStatusLabels, detail.thread.status)}</span></div></div>

    <a className={styles.contextJump} href="#sav-action">Aller à l’action à valider</a>
    <section className={layout.layout}>
      <div className={layout.flow}>
        <DossierSection id="sav-conversation" number={1} title="Conversation" subtitle={`${detail.messages.length} message${detail.messages.length > 1 ? "s" : ""}`}>
          <MailConversation embedded key={`mail:${latestInbound?.id ?? id}`} messages={detail.messages.map(message => ({ id: message.id, receivedAt: message.receivedAt, createdAt: message.createdAt, direction: message.direction, fromEmail: message.fromEmail, body: { text: message.body.text, attachments: message.body.attachments } }))}/>
        </DossierSection>

        <DossierSection id="sav-findings" number={2} title="Ce que l’agent a trouvé">
          {proposalReview && <FindingsSummary proposal={proposalReview.proposal}/>}
          {proposalReview?.before && <div className={layout.block}><details className={layout.optional}><summary>Compréhension initiale de l’IA<small>Diagnostic d’origine, preuves citées et incertitudes</small></summary><div><UnderstandingReview original={proposalReview.before} corrected={proposalReview.proposal}/></div></details>
            <a href="#sav-correct-understanding" className={layout.hint}>Corriger la compréhension (section 3)</a></div>}

          <div className={layout.block}>
            <div className={layout.blockHeader}><h3 className={layout.blockTitle}>Fiche HubSpot</h3>{dossier && <small>Contexte collecté le {formatParisDateTime(dossier.collectedAt)}</small>}</div>
            <div className={layout.contact}>
              <div>{contactId ? <><a href={`https://app.hubspot.com/contacts/${hubspotPortalId}/contact/${encodeURIComponent(contactId)}`} target="_blank" rel="noreferrer"><strong>{contactName ? `Fiche de ${contactName}` : "Ouvrir la fiche HubSpot"}</strong> <ExternalLink size={14}/></a><p>Fiche reconnue pour {isForward ? "le client transféré" : "l’expéditeur"} {customerMessage?.email}. Un email d’inscription confirmé différent sera vérifié avant toute action.</p></> : <p>{customerContextBlocked ? "Identité du client transféré à vérifier. Actualisez le contexte client ; aucun historique du collègue ne sera utilisé." : dossier?.crm.status === "error" ? "Recherche HubSpot indisponible : impossible de conclure à l’absence de fiche." : dossier?.crm.data ? "Aucune fiche retrouvée pour cet email. Les correspondances nom/téléphone restent à confirmer. Aucun contact ne sera créé." : routing?.kind === "review" && routing.reason === "customer_identity_unverified" ? "Identité à vérifier : les correspondances nom/téléphone ne sont pas encore une fiche liée. Aucun contact ne sera créé." : "Contexte HubSpot non encore collecté pour cet email."}</p>}
                {dossier?.crm.status === "partial" && <p>Fiche recherchée, mais recherche des tickets incomplète. Réessayez avant de conclure.</p>}</div>
              {latestInbound && <form action={refreshSavContextAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="messageId" value={latestInbound.id}/><button className="secondary">Actualiser le contexte client</button></form>}
            </div>
            {proposalReview && <IdentityCandidates proposal={proposalReview.proposal}/>}
            {proposalReview && <IdentityCheck proposal={proposalReview.proposal}/>}
          </div>

          <div className={layout.block}>
            <div className={layout.blockHeader}><h3 className={layout.blockTitle}>Tickets de la fiche</h3><small>Dates et heures à l’heure de Paris</small></div>
            {detail.thread.hubspotTicketId ? <p className={layout.inlineNote}><span><strong>Ticket réellement lié :</strong> <a href={`https://app.hubspot.com/contacts/${hubspotPortalId}/ticket/${encodeURIComponent(detail.thread.hubspotTicketId)}`} target="_blank" rel="noreferrer">{linkedHubspotTicket?.subject || "Ouvrir le ticket HubSpot"} <ExternalLink size={14}/></a></span><small>Date de création : {formatParisDateTime(linkedHubspotTicket?.createdAt)}</small></p>
              : <p className={layout.muted}>Aucun ticket lié à ce dossier.{!customerContextBlocked && routing?.kind === "matched" && <> Correspondance proposée : <a href={`https://app.hubspot.com/contacts/${hubspotPortalId}/ticket/${encodeURIComponent(routing.ticketId)}`} target="_blank" rel="noreferrer">{crmTickets.find(ticket => ticket.id === routing.ticketId)?.subject || "Ouvrir le ticket HubSpot"} <ExternalLink size={12}/></a>. Rattachement manuel à confirmer.</>}</p>}
            {crmTickets.length > 0 && <ul className={layout.tickets}>{crmTickets.map((ticket) => <li key={ticket.id} className={layout.ticket}>
              <span className={`${layout.badge} ${layout.neutral} ${layout.ticketStatus}`}>{savTicketStageLabel(ticket)}</span>
              <span className={layout.ticketBody}><a href={`https://app.hubspot.com/contacts/${hubspotPortalId}/ticket/${encodeURIComponent(ticket.id)}`} target="_blank" rel="noreferrer">{ticket.subject || "Ouvrir le ticket HubSpot"}</a>
                <small>Date de création : {formatParisDateTime(ticket.createdAt)} · {ticket.ownerName ? `Propriétaire : ${ticket.ownerName}` : ticket.ownerId ? "Propriétaire non résolu" : "Non assigné"}</small></span>
              <span className={`${layout.badge} ${ticket.id === detail.thread.hubspotTicketId ? layout.done : ticket.id === suggestedTicketId ? layout.todo : layout.neutral} ${layout.ticketTag}`}>{ticket.id === detail.thread.hubspotTicketId ? "Réellement lié" : ticket.id === suggestedTicketId ? "Correspondance proposée" : "Rattachement à vérifier"}</span>
            </li>)}</ul>}
          </div>

          <div className={layout.block}>
            <h3 className={layout.blockTitle}>Conversations liées</h3>
            {relatedThreads.length ? <ul className={layout.knowledge}>{relatedThreads.map((thread) => <li key={thread.id}><Link href={`/studio/sav/${thread.id}`}>{thread.subject}</Link><small className={layout.muted}>{thread.relationLabel} · {formatParisDateTime(thread.lastMessageAt, { dateStyle: "short" })}</small></li>)}</ul> : <p className={layout.muted}>Aucun lien fiable détecté dans les références email disponibles.</p>}
            {!!dossier?.otherConversations.length && <ul className={layout.knowledge}>{dossier.otherConversations.filter((thread) => !relatedThreads.some((related) => related.id === thread.id)).map((thread) => <li key={thread.id}><Link href={`/studio/sav/${thread.id}`}>{thread.subject}</Link><small className={layout.muted}>{thread.relation}</small></li>)}</ul>}
            {dossier?.otherConversationsError && <p className={layout.muted}>Recherche des autres échanges indisponible.</p>}
            <p className={layout.muted}>Recherche bornée dans les emails synchronisés du même expéditeur. Une correspondance d’expéditeur ne prouve pas qu’il s’agit du même problème. Aucune fusion automatique.</p>
          </div>

          {proposalReview && <UsedKnowledge proposal={proposalReview.proposal}/>}
          {!proposalReview && currentDecision?.evidence.some((source) => source.claim || source.excerpt) && <div className={layout.block}><h3 className={layout.blockTitle}>Preuves de la réponse</h3><ul className={layout.knowledge}>{currentDecision.evidence.map((source, index) => <li key={`${source.sourceType}:${source.sourceId}:${index}`}><strong>{source.title}</strong>{source.claim && <p>{source.claim}</p>}{source.excerpt && <blockquote>{source.excerpt}</blockquote>}{source.verifiedAt && <small>Fiche vérifiée le {source.verifiedAt}</small>}</li>)}</ul></div>}
        </DossierSection>

        <DossierSection id="sav-action" number={3} title="Action proposée" badge={detail.pilotItem ? "Simulation" : proposalReview?.review?.status === "approved" ? "Dossier validé" : proposalReview ? "À valider" : undefined} tone={proposalReview?.review?.status === "approved" ? "done" : "todo"}>
          {proposalReview && latestInbound && <ProposalReview tickets={crmTickets} data={proposalReview} threadId={detail.thread.id} messageId={latestInbound.id} drafts={replyDrafts}/>}
          {v0 && !proposalReview && <div className={layout.panel}><h3 className={layout.blockTitle}>{latestInbound?.analysisErrorCode ? "Analyse à relancer" : "Aucune proposition disponible"}</h3><p className={layout.hint}>{!eligible ? "Les anciens emails ne sont pas retraités. Cet email est antérieur à l’activation V0." : latestInbound?.analysisErrorCode ? "L’email est conservé. Vérifiez l’erreur dans la colonne de droite avant de relancer." : latestInbound?.processedAt ? "L’analyse enregistrée ne contient pas de proposition exploitable. Le contexte client reste consultable indépendamment." : "Analyse en attente, en cours ou email antérieur à l’activation. Les anciens emails ne sont pas retraités automatiquement."}</p>{eligible && latestInbound?.processedAt && !detail.pilotItem && <form action={repairSavProposalAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="messageId" value={latestInbound.id}/><button className="secondary">Reconstituer la proposition manquante</button><p className={layout.hint}>Uniquement pour un email éligible non revu. Aucun email envoyé, aucun ticket créé.</p></form>}</div>}

          <div className={layout.panel} aria-label="Exécution de l’action">
            <h3 className={layout.blockTitle}>Exécuter l’action</h3>
            {detail.pilotItem ? <p className="pilot-send-lock"><LockKeyhole size={15}/> Simulation stricte : aucune action Gmail ou HubSpot ne peut être exécutée depuis ce dossier.</p> : <>
              {v0 && <>
                <p className={layout.hint}>Valider le dossier ne crée rien dans HubSpot. L’action se prépare ensuite ici : aperçu exact, puis confirmation.</p>
                {ticketWritesDisabled && <p className="login-notice">Écritures HubSpot désactivées : les boutons enregistrent une demande qui restera en attente.</p>}
                <ManualTicketStatus action={manualTicketAction} writesDisabled={ticketWritesDisabled}/>
                {returnUncertain && <div role="alert"><p>La note ou la réouverture a peut-être abouti. Vérifiez le ticket dans HubSpot avant toute reprise. Complétez manuellement l’action si nécessaire, puis confirmez le résultat ci-dessous.</p>
                  {detail.actions.filter(action => action.status === "failed" && action.payload.ticketReturnDispatchedAt && (!action.payload.ticketReturnCompletedAt || action.errorCode === "SAV_TICKET_ACK_CONTEXT_CHANGED")).map(action => <form action={reconcileTicketReturnAction} key={action.id}>
                    <input type="hidden" name="threadId" value={id}/><input type="hidden" name="actionId" value={action.id}/><label>ID de la note de retour vérifiée dans HubSpot<input name="noteId" required pattern="[0-9]+" defaultValue={typeof action.payload.ticketReturnNoteId === "string" ? action.payload.ticketReturnNoteId : ""}/></label><button className="secondary">Vérifier la note et le statut Nouveau</button><p>Lecture seule : vérifie la note exacte enregistrée lors de la tentative, le ticket et la fiche client sans rien recréer.</p>
                  </form>)}
                </div>}
                <TicketSelector key={`ticket:${latestInbound?.id ?? id}:${proposalReview?.review?.id ?? "unreviewed"}`} threadId={id}
                  reviewId={proposalReview?.review?.status === "approved" && ["ticket_pending", "human_review_required"].includes(proposalReview.proposal.decision.kind) ? proposalReview.review.id : null}
                  tickets={crmTickets.map(({ id, subject, status, stageId, ownerId, ownerName, createdAt, closedAt, updatedAt }) => ({ id, subject, status, stageId, ownerId, ownerName, createdAt, closedAt, updatedAt }))}
                  linkedTicketId={detail.thread.hubspotTicketId} humanChoice={proposalReview?.proposal.humanProcess} suggestedTicketId={suggestedTicketId}
                  newTicketTitle={newTicketTitle} crmReady={!customerContextBlocked && dossier?.crm.status === "ready" && Boolean(dossier.crm.data?.contactId)}
                  completed={returnCompleted} pending={ticketRequestPending}
                  blockedReason={returnUncertain || needsTicketReconciliation ? "Résultat HubSpot incertain : rapprochez l’action existante avant toute nouvelle demande."
                    : proposalReview?.review?.status === "approved" && !["ticket_pending", "human_review_required"].includes(proposalReview.proposal.decision.kind) ? "La décision validée ne demande aucune action sur un ticket." : null}/>
                {detail.actions.filter((action) => (action.errorCode === "SAV_TICKET_ACK_CONTEXT_CHANGED" && action.kind === "create_ticket" || (action.errorCode === "SAV_MANUAL_RECONCILIATION_REQUIRED" || action.kind === "create_ticket" && action.status === "failed" && action.payload.ticketCreateDispatchedAt) && !action.payload.hubspotTicketId)).map((action) => <div key={action.id}><h3>Vérification manuelle obligatoire</h3><p>La création a peut-être abouti. Ne recréez pas le ticket. Retrouvez-le dans HubSpot puis confirmez son ID ; le serveur vérifiera le compte associé et le contenu avant rapprochement.</p><form action={reconcileTicketAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="actionId" value={action.id}/><label>ID du ticket trouvé<input name="ticketId" pattern="[0-9]+" required defaultValue={typeof action.payload.hubspotTicketId === "string" ? action.payload.hubspotTicketId : ""}/></label><label>Confirmation de votre vérification<input name="reason" minLength={10} required/></label><button className="secondary">Vérifier et rapprocher ce ticket existant</button></form></div>)}
              </>}
              {!v0 && !detail.thread.hubspotTicketId && <form action={createTicketAction}><input type="hidden" name="threadId" value={id}/><button className="secondary">Créer le ticket HubSpot</button></form>}
            </>}
          </div>
          {partnershipState && <div className={layout.panel}><PartnershipTransfer key={`partnership:${latestInbound?.id ?? id}`} threadId={id} state={partnershipState}/></div>}
        </DossierSection>

        {proposalReview && latestInbound && <DossierSection id="sav-draft" number={4} title="Brouillon de réponse" badge={replyState === "sent" ? "Envoyée" : proposalReview.draftVerdict?.status === "accepted" && !proposalReview.draftVerdict.stale ? "Acceptée · à envoyer" : "À relire"} tone={replyState === "sent" ? "done" : "todo"}>
          <div className={layout.block}><DraftReview inboundText={latestInbound.body.text} data={proposalReview} threadId={id} messageId={latestInbound.id} drafts={replyDrafts} sendAllowed={!sendDisabledReason} sendDisabledReason={sendDisabledReason} replyState={replyState}/></div>
        </DossierSection>}

        <ResolutionObservation rows={observations} isUgo={staff.email.toLowerCase()==="ugo@limova.ai"}/>

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

      <aside id="sav-dossier-rail" className={layout.rail} aria-label="Avancement du dossier">
        <section className={`card ${layout.progress}`} aria-labelledby="sav-progress-title">
          <h2 id="sav-progress-title" className={layout.blockTitle}>Avancement du dossier</h2>
          <ol>{progress.map(step => <li key={step.label} className={step.state === "pending" ? layout.pending : undefined}>
            <span className={`${layout.dot} ${step.state === "done" ? layout.done : step.state === "todo" ? layout.todo : step.state === "alert" ? layout.alert : ""}`} aria-hidden="true">{step.state === "done" ? "✓" : step.state === "alert" ? "!" : ""}</span>
            <span><strong>{step.label}</strong><small>{step.detail}</small></span>
          </li>)}</ol>
        </section>
        <section className={`card ${layout.progress}`}>
          {detail.thread.humanDueAt && <p className="human-deadline"><Clock3 size={15}/> Réponse humaine attendue avant le {formatParisDateTime(detail.thread.humanDueAt, { dateStyle: "medium", timeStyle: "short" })}</p>}
          {!detail.pilotItem && !detail.thread.aiPaused && <form action={requestHumanAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="reason" value="Reprise demandée depuis le registre SAV"/><button className="ghost-danger">Transférer à un humain</button></form>}
          {latestInbound?.analysisErrorCode && <><h3>Erreur d’analyse</h3><code>{latestInbound.analysisErrorCode}</code>{latestInbound.analysisStatus === "failed" && !latestInbound.processedAt && <form action={retryAnalysisAction}><input type="hidden" name="threadId" value={id}/><input type="hidden" name="messageId" value={latestInbound.id}/><button className="secondary">Relancer l’analyse après correction</button></form>}</>}
          <div className="sav-decision-card"><span className="eyebrow">{proposalReview?.review ? "Décision du process revu" : "Décision proposée par l’IA"}</span><h2>{displayedDecision ? savLabel(savDecisionLabels, displayedDecision.kind) : "Non justifiée"}</h2><p>{displayedDecision?.explanation ?? "Aucune décision n’a encore été enregistrée."}</p>{displayedDecision && <p>{proposalReview?.before?.understanding ? "Qualification proposée à vérifier dans les sources ; aucune probabilité de fiabilité calibrée." : "Estimation IA historique non calibrée ; validation humaine requise."}</p>}</div>
        </section>

        {!v0 && currentDecision && <details className="card sav-correction"><summary>Corriger cette décision</summary><form action={correctDecisionAction}><input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="decisionId" value={currentDecision.id}/><label>Décision<select name="kind" defaultValue={currentDecision.kind === "ticket_pending" ? "human_review_required" : currentDecision.kind}><option value="ticket_created">Ticket créé</option><option value="attached_to_existing_ticket">Ticket existant</option><option value="no_ticket_needed">Aucun ticket nécessaire</option><option value="spam">Spam</option><option value="internal_notification">Notification interne</option><option value="automatic_reply">Réponse automatique</option><option value="bounce">Échec de remise</option><option value="duplicate">Doublon</option><option value="human_review_required">Humain requis</option></select></label><label>Code du motif<input name="reasonCode" defaultValue={currentDecision.reasonCode}/></label><label>Justification<textarea name="explanation" defaultValue={currentDecision.explanation}/></label><button className="primary" type="submit">Enregistrer la correction</button></form></details>}

        <details className={`card ${styles.audit}`}><summary>Traçabilité et journal d’actions</summary>
          <p><a href={`/api/internal/sav/dossiers/${id}/diagnostics`} target="_blank" rel="noreferrer">Consulter les diagnostics d’analyse en lecture seule</a></p>
        <section className="sav-agent-runs"><span className="eyebrow">Traçabilité technique</span><h2>Exécutions de l’agent</h2>{detail.agentRuns.length === 0 ? <p>Aucune exécution enregistrée pour les anciens messages.</p> : <ol>{[...detail.agentRuns].reverse().map((run) => <li key={run.id}><details><summary><span><Bot size={14}/>{run.runtime === "google_adk" ? "Google ADK" : run.runtime.replaceAll("_", " ")}</span><em className={`run-status ${run.status}`}>{savLabel(savRunStatusLabels, run.status)}</em></summary><div className="agent-run-detail"><dl><div><dt>Mode</dt><dd>{run.mode}</dd></div><div><dt>Modèle</dt><dd>{run.model}</dd></div><div><dt>Prompt</dt><dd>{run.promptRevision}</dd></div><div><dt>Durée</dt><dd>{run.durationMs} ms</dd></div></dl>{run.errorCode && <code>{run.errorCode}</code>}{run.fallbackRuntime && <p>Repli de sécurité : {run.fallbackRuntime}</p>}<div><strong>Sources retenues</strong>{run.evidence.length ? <ul>{run.evidence.map((source, index) => <li key={`${run.id}:${source.sourceType}:${source.sourceId}:${index}`}>{source.sourceType} · {source.title}</li>)}</ul> : <small>Aucune source retenue.</small>}</div><div><strong>Outils appelés</strong>{run.toolTrace.length ? <ul>{run.toolTrace.map((tool) => <li key={`${run.id}:${tool.sequence}`}>{tool.name} · {savLabel(savToolStatusLabels, tool.status)} · {tool.durationMs} ms</li>)}</ul> : <small>Aucun outil appelé.</small>}</div></div></details></li>)}</ol>}</section>

        <section className="sav-timeline"><span className="eyebrow">Journal d’actions</span><ol>{detail.actions.map((action) => { const simulated = Boolean(detail.pilotItem && pilotExternalActions.has(action.kind)); return <li key={action.id}><span className={`action-icon ${action.status}`}>{action.status === "succeeded" ? <CheckCircle2 size={14}/> : action.status === "failed" ? <CircleAlert size={14}/> : <Clock3 size={14}/>}</span><div><strong>{isSavPartnershipForward(action) ? "Transfert partenariat à Nathan" : savLabel(savActionLabels, action.kind)}</strong><small>{savLabel(savToolStatusLabels, action.status)} · {simulated && action.status === "pending" ? "Simulation · non exécutée" : simulated && action.status === "succeeded" ? "Exécutée · incident du pilote précédent" : action.actorType === "human" ? action.actorEmail : "Charly / système"} · {formatParisDateTime(action.createdAt, { dateStyle: "short", timeStyle: "short" })}</small>{action.errorCode && <code>{action.errorCode}</code>}{action.status === "failed" && !detail.pilotItem && action.errorCode !== "SAV_PROPOSAL_STALE" && action.errorCode !== "SAV_REVIEW_STALE" && !action.payload.replySendDispatchedAt && action.errorCode !== "SAV_TICKET_ACK_CONTEXT_CHANGED" && !action.errorCode?.startsWith("SAV_TICKET_PREVIEW_") && !action.payload.forwardDispatchedAt && !(action.payload.ticketReturnDispatchedAt && !action.payload.ticketReturnCompletedAt) && !(action.payload.ticketCreateDispatchedAt && !action.payload.hubspotTicketId) && <form action={retryAction}><input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="actionId" value={action.id}/><button className="button small secondary" type="submit">Réessayer</button></form>}</div></li>; })}</ol></section>
        </details>
      </aside>
    </section>
  </DossierViewport>;
}
