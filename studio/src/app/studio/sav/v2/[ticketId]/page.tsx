import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDb } from "@/db";
import { formatParisDateTime } from "@/lib/paris-date";
import { readCaseEffectsMode } from "@/lib/sav/cases/case-effects";
import { listCaseEvents, listCaseTimers, readCaseByTicket, readCaseDiagnostics } from "@/lib/sav/cases/case-store";
import { readSavAgentPause } from "@/lib/sav/intake/agent-pause";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { safeStudioHref } from "@/lib/ui/navigation-history";
import { BackLink } from "@/components/ui/back-link";
import { Badge, PageHeader, Status } from "@/components/ui/primitives";
import { describeCaseReply, describeCaseReplyDetail, readCaseReplies, readCaseReply, summarizeCaseReplies } from "../case-replies";
import { caseReplyReaders } from "../case-replies-port";
import { caseDossierReaders } from "../case-dossier-port";
import { caseViewerOf, describeHandoffNotice, readCaseCards, readCaseHandoffNotice, readCaseMails } from "../case-dossier-read";
import { readHandoffNoticeConfig } from "@/lib/sav/cases/case-handoff-notice";
import { buildCasePilotView } from "../case-view";
import { PipelinePanel } from "../pipeline-panel";
import { operationalReader } from "../operational-read-port";
import { describeOperationalState, readOperationalState } from "../operational-state-view";
import { qualificationDiagnosticReader } from "../qualification-diagnostic-port";
import { describeQualificationDiagnostic, readQualificationDiagnostic } from "../qualification-diagnostic-view";
import styles from "../v2.module.css";

export const dynamic = "force-dynamic";
const date = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? formatParisDateTime(new Date(value)) : "date illisible";

// One V2 case, strictly read-only: select-only readers of poles A/B/C, no model, CRM or Gmail call.
// The page approves and sends nothing and shows no button: what was decided or sent is only what the registry recorded.
export default async function SavV2CasePage({ params, searchParams }: { params: Promise<{ ticketId: string }>; searchParams: Promise<{ returnTo?: string; replies?: string; reply?: string }> }) {
  const staff = await requireIntakeConsoleStaff();
  const { ticketId } = await params;
  if (!/^\d{1,30}$/.test(ticketId)) notFound();
  const snapshot = await readCaseByTicket(ticketId);
  if (!snapshot) notFound();
  const admin = staff.role === "admin" || staff.role === "owner";
  const { returnTo, replies: repliesCursor, reply: replyId } = await searchParams, back = safeStudioHref(returnTo);
  // Pole C's registry is read only here, after the access check and once the case is known (its list decrypts each stored proposal).
  const [events, timers, pause, diagnostics, replies, qualification] = await Promise.all([listCaseEvents(snapshot.caseId), listCaseTimers(snapshot.caseId),
    readSavAgentPause(requireDb(), "v2"), admin ? readCaseDiagnostics(ticketId) : null,
    readCaseReplies(caseReplyReaders, { caseId: snapshot.caseId, cursor: repliesCursor }),
    // Pole A6, after the staff check, for the case read above; the caller is built from that check's result only.
    readQualificationDiagnostic(qualificationDiagnosticReader, staff, snapshot.caseId)]);
  // Without a choice in the link, the latest reply of the first page is the one shown: its id comes from the list just read for this case, never from a guess.
  const reply = await readCaseReply(caseReplyReaders, { caseId: snapshot.caseId, id: replyId ?? (!repliesCursor && replies.state === "ok" ? replies.items[0]?.id : undefined) });
  // Pole C9, only for the reply the page already read for this case (its id comes from that read, not from the URL), after the staff check.
  const operational = reply.state === "ok" ? await readOperationalState(operationalReader, staff, snapshot.caseId, reply.reply.id) : null;
  const view = buildCasePilotView({ snapshot, events, timers, pause, now: new Date() }), effects = readCaseEffectsMode(process.env);
  // The mails and the sheets, after the staff check and once the case and its journal are known.
  // The viewer comes from that check's result only, as for poles A6 and C9.
  const viewer = caseViewerOf(staff);
  const [mails, cardsRead, noticeRead] = await Promise.all([readCaseMails(caseDossierReaders, viewer, { threadIds: snapshot.threadIds, events }),
    readCaseCards(caseDossierReaders, viewer, view.cards.state === "found" ? [...view.cards.chosen, ...view.cards.consulted] : []),
    view.situation.kind === "team_required" ? readCaseHandoffNotice(caseDossierReaders, viewer, snapshot.caseId) : null]);
  const notice = noticeRead ? describeHandoffNotice(noticeRead, { enabled: readHandoffNoticeConfig(process.env).mode === "on" }) : null;
  const repliesSummary = summarizeCaseReplies(replies);
  const cardLine = (ref: { knowledgeId: string; contentVersionId: string }) => { const card = cardsRead.state === "ok" ? cardsRead.titleOf(ref) : null;
    return <li key={`${ref.knowledgeId}/${ref.contentVersionId}`}>{card ? <>{card.title} <span className={styles.small}>version {card.version}</span></> : <span className={styles.small}>Fiche {ref.knowledgeId}, version {ref.contentVersionId}{cardsRead.state === "ok" ? " : introuvable dans la base" : " : titre non lu"}</span>}</li>; };
  const fallback = back && new URL(back, "https://studio.invalid").pathname === "/studio/sav/v2" ? back : `/studio/sav/v2?ticket=${ticketId}`;
  // Every link inside the page keeps the way back to the list (its filters, cursor and row anchor) and the replies page being read.
  const here = (extra: { replies?: string; reply?: string }, anchor: string) =>
    `/studio/sav/v2/${ticketId}?${new URLSearchParams(Object.entries({ returnTo: fallback, ...extra }).filter((entry): entry is [string, string] => Boolean(entry[1])))}#${anchor}`;
  return <>
    <PageHeader back={<BackLink fallback={fallback}>Retour</BackLink>} title={`Ticket ${view.ticketId}`} status={<><Badge>Lecture seule</Badge>{view.sensitive ? <Badge tone="danger">Sensible : équipe</Badge> : null}</>}
      description={`${view.owner} · ${view.phase} · version ${view.version}, mise à jour ${date(view.updatedAt)}`}/>
    {view.humanHold?.state === "taken" ? <p className={styles.notice} role="status">Ticket pris par une personne de l’équipe le {date(view.humanHold.since)} : l’agent V2 n’investigue pas, ne propose rien, ne répond pas et ne relance pas, même après un nouveau mail du client. Cette page l’affiche seulement.</p>
      : view.humanHold?.state === "team_not_taken" ? <p className={styles.notice} role="status">Dossier confié à l’équipe, pas encore pris par une personne : l’agent V2 n’agit pas sur ce dossier. Cette page l’affiche seulement.</p>
      : null}

    <section className={styles.card} aria-labelledby="v2-situation"><h2 id="v2-situation">Où en est le dossier</h2>
      <p><Status tone={view.situation.tone}>{view.situation.title}</Status>{view.situation.detail ? <span className={styles.small}> {view.situation.detail}</span> : null}</p>
      {notice ? <div id="v2-notice"><p><Status tone={notice.tone}>{notice.line}</Status>{notice.link ? <> <a href={notice.link} target="_blank" rel="noreferrer">Voir le message</a></> : null}</p>
        <p><strong>Action suivante :</strong> {notice.next}</p></div> : null}
      <p><Status tone={repliesSummary.tone}>{repliesSummary.line}</Status></p>
      {repliesSummary.uncertain ? <p className={styles.notice} role="status">{repliesSummary.uncertain} envoi{repliesSummary.uncertain > 1 ? "s" : ""} incertain{repliesSummary.uncertain > 1 ? "s" : ""} sur cette page : à ne compter ni comme envoyé ni comme non envoyé.</p> : null}
      <h3 id="v2-engines">V1 et V2</h3>
      <p><strong>V2 :</strong> {view.engines.v2}</p>
      {view.engines.v1.length ? <ul>{view.engines.v1.map((row, i) => <li key={i}><strong>V1 :</strong> {row.label} <span className={styles.small}>Mail du {date(row.at)}.</span></li>)}</ul> : <p><strong>V1 :</strong> aucun mail client confirmé dans le journal de ce dossier.</p>}
    </section>

    <section className={styles.card} aria-labelledby="v2-mail"><h2 id="v2-mail">Mail du client</h2>
      {mails.state === "denied" ? <p role="alert">Lecture refusée : identité de la session non vérifiée.</p>
        : mails.state === "absent" ? <p>Lecture des mails non branchée sur cette version : ne rien voir ici ne veut pas dire qu’il n’y a pas de mail.</p>
        : mails.state === "unavailable" ? <p role="alert">Mails indisponibles : la lecture a échoué, ce n’est pas une absence de mail.</p>
        : mails.state === "empty" ? <p>Aucun mail client confirmé dans le journal de ce dossier.</p>
        : <>{mails.items.map((mail, i) => <div key={i} className={styles.mail}>
            {mail.state === "missing" ? <p role="alert">Mail du {date(mail.at)} : confirmé au journal mais introuvable dans les messages de ce dossier.</p> : <>
              <p><strong>{mail.subject || "Sans objet"}</strong> <span className={styles.small}>{mail.from ?? "expéditeur non enregistré"} · {date(mail.at)}</span></p>
              {mail.state === "unreadable" ? <p role="alert">Texte illisible : le déchiffrement a échoué, ce n’est pas un mail vide.</p>
                : mail.text ? <blockquote className={styles.reply}>{mail.text}</blockquote> : <p>Ce mail ne contient aucun texte.</p>}
              {mail.state === "ok" && (mail.truncated || mail.quotedHidden) ? <p className={styles.small}>{mail.truncated ? "Texte coupé à l’affichage. " : ""}{mail.quotedHidden ? "Historique cité masqué. " : ""}L’original reste entier dans la console.</p> : null}
            </>}
          </div>)}
          {mails.older ? <p className={styles.small}>{mails.older} mail{mails.older > 1 ? "s" : ""} plus ancien{mails.older > 1 ? "s" : ""} non affiché{mails.older > 1 ? "s" : ""} ici.</p> : null}</>}
      {view.original?.threadId ? <p className={styles.small}><Link href={`/studio/sav/intake/${view.original.threadId}`}>Lire le mail original dans la console</Link></p> : null}
    </section>

    <section className={styles.card} aria-labelledby="v2-cards"><h2 id="v2-cards">Fiche choisie</h2>
      {view.cards.state === "unreadable" ? <p role="alert">Décision illisible : on ne sait pas quelle fiche a été retenue. Ce n’est pas une absence de fiche.</p>
        : view.cards.state === "none" ? <p>Aucune décision enregistrée pour la dernière entrée : aucune fiche n’a encore été retenue.</p>
        : <>
          {cardsRead.state === "denied" ? <p role="alert">Lecture des fiches refusée : identité de la session non vérifiée.</p> : cardsRead.state === "unavailable" ? <p role="alert">Titres des fiches indisponibles : la lecture a échoué. Seuls les identifiants enregistrés sont affichés.</p> : cardsRead.state === "absent" ? <p>Lecture des fiches non branchée sur cette version : seuls les identifiants enregistrés sont affichés.</p> : null}
          {view.cards.chosen.length ? <ul>{view.cards.chosen.map(cardLine)}</ul> : <p>La proposition ne cite aucune fiche.</p>}
          {view.cards.consulted.length ? <><h3>Fiches consultées pour cette décision</h3><ul>{view.cards.consulted.map(cardLine)}</ul></> : <p className={styles.small}>Aucune fiche consultée enregistrée pour cette décision.</p>}
          <p className={styles.small}>{view.cards.scope ? `Périmètre des sources : ${view.cards.scope.revision}, politique ${view.cards.scope.policyRevision}.` : "Aucun périmètre de sources enregistré pour cette décision."}</p>
        </>}
    </section>

    <section className={styles.card} aria-labelledby="v2-admission"><h2 id="v2-admission">Propriétaire et admission</h2>
      <p>Responsable du dossier : <strong>{view.owner}</strong> <span className={styles.small}>(tel qu’enregistré dans le dossier V2 ; ce n’est pas une lecture HubSpot en direct)</span></p>
      {view.admission.state === "unknown" ? <p role="status">{view.admission.label}</p> : <>
        <p><Status tone={view.admission.state === "admitted" ? "neutral" : "warning"}>{view.admission.label}</Status> <span className={styles.small}>décidée le {date(view.admission.decidedAt)}, version {view.admission.version}, politique {view.admission.policyRevision ?? "non enregistrée"}.</span></p>
        {view.admission.state === "refused" ? <ul>{view.admission.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul> : null}
        {view.admission.stale ? <p className={styles.notice} role="status">Une entrée plus récente est arrivée : admission à réévaluer avant toute décision.</p> : null}
        <p className={styles.small}>Qualification enregistrée : {view.admission.identity} · {view.admission.crm}.</p>
      </>}
      {(() => { const q = describeQualificationDiagnostic(qualification, { caseId: snapshot.caseId, version: view.version }, date); return <div id="v2-qualification">
        <p><Status tone={q.tone}>{q.title}</Status></p>{q.detail ? <p className={styles.small}>{q.detail}</p> : null}
      </div>; })()}
    </section>

    <section className={styles.card} aria-labelledby="v2-request"><h2 id="v2-request">Demandes retenues</h2>
      {view.original ? <p>Premier mail reçu le {date(view.original.at)}.</p> : null}
      {view.requests.length ? <ul>{view.requests.map((request, i) => <li key={i}>{request.summary} <span className={styles.small}>{request.family} · {request.status} · depuis {date(request.openedAt)}</span>
        <br/>{"text" in request.subject ? <>Sujet : {request.subject.text} <span className={styles.small}>(analyse V1 acceptée le {date(request.subject.acceptedAt)})</span></> : <span className={styles.small}>Pas de sujet recherchable : {request.subject.missing}.</span>}
        {request.knowledge ? <><br/><span className={styles.small}>Connaissances : {request.knowledge.label}</span></> : null}</li>)}</ul> : <p>Aucune demande ouverte enregistrée.</p>}
    </section>

    <section className={styles.card} aria-labelledby="v2-evidence"><h2 id="v2-evidence">Vérifications déjà faites et informations manquantes</h2>
      {view.verifications.trials.length ? <><h3>Essais</h3><ul>{view.verifications.trials.map((trial, i) => <li key={i}><strong>{trial.label}</strong>{trial.result ? ` : ${trial.result}` : ""} <span className={styles.small}>fiche {trial.procedure.knowledgeId} · demandé le {date(trial.askedAt)}{trial.resultAt ? ` · résultat le ${date(trial.resultAt)}` : ""}</span></li>)}</ul></> : null}
      {view.verifications.answered.length ? <><h3>Questions déjà répondues</h3><ul>{view.verifications.answered.map((question, i) => <li key={i}>{question.text} <span className={styles.small}>posée le {date(question.askedAt)}</span></li>)}</ul></> : null}
      {view.verifications.checks.length || view.verifications.closure ? <><h3>Contrôles de l’agent</h3><ul>{view.verifications.checks.map((label, i) => <li key={i}>{label}</li>)}{view.verifications.closure ? <li>Résolution : {view.verifications.closure}</li> : null}</ul></> : null}
      <h3>Faits enregistrés</h3>
      {view.facts.length ? <ul>{view.facts.map((fact, i) => <li key={i}><strong>{fact.kind}</strong> : {fact.text} <span className={styles.small}>source {fact.source} · {date(fact.at)}</span></li>)}</ul> : <p>Aucun fait enregistré.</p>}
      {view.openQuestions.length ? <><h3>Questions sans réponse</h3><ul>{view.openQuestions.map((question, i) => <li key={i}>{question.text} <span className={styles.small}>posée le {date(question.askedAt)}</span></li>)}</ul></> : null}
      {view.proposal.state === "found" && view.proposal.missingInformation.length ? <><h3>Ce qui manque selon la proposition</h3><ul>{view.proposal.missingInformation.map((item, i) => <li key={i}>{item}</li>)}</ul></> : null}
    </section>

    <section className={styles.card} aria-labelledby="v2-wait"><h2 id="v2-wait">Pourquoi le dossier attend</h2>
      <p>Responsable : <strong>{view.owner}</strong> · {view.phase}</p>
      {view.waits.length ? <ul>{view.waits.map((wait, i) => <li key={i}><Status tone={wait.needsPerson ? "warning" : "neutral"}>{wait.label}</Status>{wait.detail ? <span className={styles.small}> {wait.detail}</span> : null}{wait.needsPerson ? <span className={styles.small}> Intervention humaine nécessaire.</span> : null}</li>)}</ul>
        : <p>Aucune cause d’attente enregistrée sur la version {view.version}.</p>}
      {view.followUp ? <p>{view.followUp.label}, échéance {date(view.followUp.dueAt)}{view.followUp.resumesAt ? `, reprise prévue ${date(view.followUp.resumesAt)}` : ""}.</p> : null}
    </section>

    <section className={styles.card} aria-labelledby="v2-proposal"><h2 id="v2-proposal">Proposition de l’agent</h2>
      {view.proposal.state === "none" ? <p>Aucune proposition enregistrée pour la dernière entrée.</p>
        : view.proposal.state === "unreadable" ? <p role="alert">Proposition illisible (enregistrée en version {view.proposal.recordedOn}) : problème technique, rien n’est présenté comme proposé.</p>
        : <>
          <p><strong>{view.proposal.action}</strong> · établie sur la version {view.proposal.proposedOn}</p>
          {view.proposal.stale ? <p className={styles.notice} role="status">Le dossier a changé depuis (version {view.version}) : cette proposition doit être revalidée avant tout usage.</p> : null}
          {view.proposal.handoffNeed ? <p>Besoin transmis à l’équipe : {view.proposal.handoffNeed}</p> : null}
          {view.proposal.reply ? <><h3>Réponse proposée</h3><blockquote className={styles.reply}>{view.proposal.reply}</blockquote><p className={styles.small}>{view.proposal.citations} connaissance{view.proposal.citations > 1 ? "s" : ""} citée{view.proposal.citations > 1 ? "s" : ""}.</p></> : null}
        </>}
      <div className={styles.seam} id="v2-check">
        <h3>Contrôle des règles</h3>
        {view.check.state === "none" ? <p>Aucun contrôle de décision enregistré pour la dernière entrée.</p>
          : view.check.state === "unreadable" ? <p role="alert">Contrôle de la décision illisible : problème technique, ni conforme ni refusé.</p>
          : <>
            <p><Status tone={view.check.accepted ? "neutral" : "warning"}>{view.check.verdict}</Status> <span className={styles.small}>Contrôlée sur la version {view.check.decidedOn}.</span></p>
            {view.check.stale ? <p className={styles.notice} role="status">Le dossier a changé depuis (version {view.version}) : ce contrôle ne vaut plus pour la version courante.</p> : null}
            {view.check.actionsPaused ? <p className={styles.notice} role="status">Décidée pendant la pause des actions : elle ne peut devenir aucun effet tant que la pause dure.</p> : null}
            {view.check.refusals.length ? <><h4>Motifs du refus</h4><ul>{view.check.refusals.map((label, i) => <li key={i}>{label}</li>)}</ul></> : null}
            {view.check.nextStep ? <p>Étape suivante : {view.check.nextStep}</p> : null}
            {view.check.unverified.length ? <><h4>Non vérifié par les règles</h4><ul>{view.check.unverified.map((label, i) => <li key={i} className={styles.small}>{label}</li>)}</ul></> : null}
            {view.check.signals.length ? <><h4>Signaux à mesurer (non bloquants)</h4><ul>{view.check.signals.map((label, i) => <li key={i} className={styles.small}>{label}</li>)}</ul></> : null}
            <p className={styles.small}>Provenance : connaissances {view.check.provenance.knowledgeRevision ?? "révision non enregistrée"} · {view.check.provenance.cards} fiche{view.check.provenance.cards > 1 ? "s" : ""} utilisée{view.check.provenance.cards > 1 ? "s" : ""}
              {view.check.provenance.modelCalls !== null ? ` · ${view.check.provenance.modelCalls} appel${view.check.provenance.modelCalls > 1 ? "s" : ""} modèle` : ""}
              {view.check.provenance.revisions ? ` · règles ${view.check.provenance.revisions.rules}, playbook ${view.check.provenance.revisions.playbookId}, modèle ${view.check.provenance.revisions.model}, prompt ${view.check.provenance.revisions.prompt}` : " · révisions non enregistrées"}.</p>
          </>}
      </div>
      <div className={styles.seam} id="v2-approval">
        <h3>Validation humaine de l’envoi</h3>
        <p>Rien ne peut être validé ni envoyé depuis cette page, et une proposition n’y est jamais présentée comme validée. Seule une décision enregistrée par le registre compte : voir « Réponse préparée ou envoyée, et preuves ».</p>
      </div>
      <div className={styles.seam} id="v2-note">
        <h3>Note interne HubSpot</h3>
        <p>Distincte de la réponse au client, avec sa propre autorisation. Son texte et sa validation ne sont pas encore définis : aucune note n’est proposée ni ajoutée depuis cette page.</p>
      </div>
    </section>

    <section className={styles.card} aria-labelledby="v2-effects"><h2 id="v2-effects">Réponse préparée ou envoyée, et preuves</h2>
      <p>Envois de l’agent V2 sur cet environnement : <strong>{effects.mode === "supervised" ? "mode supervisé demandé" : "désactivés"}</strong>{effects.ignored ? " (réglage non reconnu, traité comme désactivé)" : ""}.</p>
      <h3 id="v2-replies">Réponses préparées et leur suivi</h3>
      {replies.state === "absent" ? <p>Le registre des réponses validées n’est pas branché sur cette version : ne rien voir ici ne veut pas dire qu’aucune réponse n’existe, et aucun envoi n’est affiché comme envoyé ou confirmé.</p>
        : replies.state === "unavailable" ? <p role="alert">Registre des réponses indisponible : la lecture a échoué, ce n’est pas une liste vide. Aucun envoi n’est affiché comme envoyé ou confirmé.</p>
        : replies.state === "invalid" ? <p role="alert">Lien de page des réponses invalide. <Link href={here({}, "v2-replies")}>Revenir aux réponses les plus récentes</Link></p>
        : !replies.items.length ? <p>{repliesCursor ? <>Plus aucune réponse sur cette page. <Link href={here({}, "v2-replies")}>Revenir aux plus récentes</Link></> : "Aucune réponse préparée enregistrée pour ce dossier."}</p>
        : <>
          <ul>{replies.items.map(item => { const shown = describeCaseReply(item); return <li key={item.id} id={`reply-${item.id}`}>
            <Link href={here({ replies: repliesCursor, reply: item.id }, "v2-reply")}>{shown.purpose}</Link> · <Status tone={shown.tone}>{shown.status}</Status>
            <br/><span className={styles.small}>{shown.sent} Préparée le {date(item.createdAt)} sur la version {item.caseVersion}.{shown.j2 ? ` ${shown.j2.label}${shown.j2.dueAt ? ` le ${date(shown.j2.dueAt)}` : ""}.` : ""}</span>
          </li>; })}</ul>
          <p className={styles.small}>{repliesCursor ? <><Link href={here({}, "v2-replies")}>Revenir aux plus récentes</Link> · </> : null}
            {replies.next ? <Link href={here({ replies: replies.next }, "v2-replies")}>Réponses plus anciennes</Link> : "Fin des réponses."}</p>
        </>}
      {reply.state === "none" ? null : <div className={styles.seam} id="v2-reply">
        <h3>Réponse sélectionnée</h3>
        {reply.state === "absent" ? <p>Le registre des réponses n’est pas branché sur cette version : cette réponse ne peut pas être lue ici.</p>
          : reply.state === "invalid" ? <p role="alert">Identifiant de réponse invalide.</p>
          : reply.state === "unavailable" ? <p role="alert">Lecture de la réponse impossible : problème technique, rien n’est présenté comme envoyé.</p>
          : reply.state === "not_found" ? <p role="alert">Aucune réponse avec cet identifiant pour ce dossier.</p>
          : (() => { const shown = describeCaseReply(reply.reply), detail = describeCaseReplyDetail(reply.reply, date); return <>
            <p><strong>{shown.purpose}</strong> · <Status tone={shown.tone}>{shown.status}</Status></p>
            <p>{shown.sent}</p>
            <p>Destinataire : {reply.reply.recipient} · Objet : {reply.reply.proposal.subject}</p>
            <blockquote className={styles.reply}>{reply.reply.proposal.text}</blockquote>
            {reply.reply.proposal.question ? <p>Question posée : {reply.reply.proposal.question.text}</p> : null}
            <p>{detail.mentionOk ? detail.mention : <Status tone="danger">{detail.mention}</Status>}</p>
            <p className={styles.small}>Empreinte enregistrée du texte et de son destinataire : {detail.fingerprint} · préparée sur la version {reply.reply.caseVersion}.</p>
            <p className={styles.small}>{detail.languageProof}</p>
            <p>{detail.decision}{reply.reply.decidedBy ? <span className={styles.small}> Identifiant enregistré : {reply.reply.decidedBy}.</span> : null}</p>
            <ul>{detail.timeline.map((line, i) => <li key={i}>{line}</li>)}</ul>
            {operational ? (() => { const o = describeOperationalState(operational, { caseId: snapshot.caseId, validationId: reply.reply.id }, date); return <div id="v2-operational">
              <h4>Suivi des effets (lecture seule)</h4><p><Status tone={o.tone}>{o.lines[0]}</Status></p>
              {o.lines.length > 1 ? <ul>{o.lines.slice(1).map((line, i) => <li key={i} className={styles.small}>{line}</li>)}</ul> : null}
            </div>; })() : null}
            <p>{shown.validation}</p>
            {reply.reply.authorizationBasis ? <p className={styles.small}>Base de la décision enregistrée : {reply.reply.authorizationBasis}</p> : null}
          </>; })()}
      </div>}
      {view.observedOutbound.length ? <><h3>Messages observés dans le fil</h3><ul>{view.observedOutbound.map((message, i) => <li key={i}>{message.by} · {date(message.at)}</li>)}</ul></> : null}
    </section>

    <PipelinePanel/>

    {diagnostics ? <section className={styles.card} aria-labelledby="v2-diagnostics"><h2 id="v2-diagnostics">Diagnostic (administration)</h2>
      <p className={styles.small}>Contrat {diagnostics.contractRevision}{diagnostics.contractSupported ? "" : " (non lisible par cette version)"} · {diagnostics.eventCount} événements · dernier : {diagnostics.lastEventKind ?? "aucun"}
        {diagnostics.admission ? ` · admission ${diagnostics.admission.target} (${diagnostics.admission.reason ?? "sans motif"}), politique ${diagnostics.admission.policyRevision ?? "aucune"}` : " · sans admission"}
        {diagnostics.claim ? ` · pris par ${diagnostics.claim.holder} jusqu’à ${date(diagnostics.claim.until)}` : ""}</p>
    </section> : null}
  </>;
}
