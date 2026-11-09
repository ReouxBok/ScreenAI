import { intakeUncertaintyLabel } from "@/lib/sav/intake/uncertainty";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readIntakeConsoleDetail } from "@/lib/sav/intake/console-detail";
import { intakeDossierView, intakeEffectLabels as effectLabels, intakeEffectStateLabels as stateLabels, intakeRouteLabel, intakeEffectsTitle, intakeDossierActions, readIntakeManualOther } from "@/lib/sav/intake/dossier-view";
import { intakeRuntimeHash } from "@/lib/sav/intake/runtime-contract";
import { formatParisDateTime } from "@/lib/paris-date";
import { MailConversation } from "../../[id]/mail-conversation";
import {readIntakeCrmDisplay} from "@/lib/sav/intake/crm-display-server";
import { releaseIntakeHumanHoldAction } from "../actions";
import {IntakeRecoveryForm} from "../recovery-form";
import { IntakeCompletionForm } from "../completion-form";
import { manualOtherUnavailableLabels } from "@/lib/sav/intake/manual-other-classification";
import { IntakeManualOtherForm } from "../manual-other-form";
import { IntakeInvalidSourceForm } from "../invalid-source-form";
import { intakeStatusLabel, intakeProjectionLabel, intakeExecutionStateLabel, intakeReasonLabel, intakeContextReasonLabels, intakeCrmDeltaLabel, intakeNextStepLabel } from "@/lib/sav/intake/console-presentation";
import styles from "../intake.module.css";
import { IntakeBackLink } from "../navigation";
import { CrmRecord, StreamedChoiceForm, StreamedCrmContext } from "../crm-streamed";
import { IntakeProcessingSummary } from "../processing-summary";
import { readUxMessageControls } from "@/lib/sav/intake-ux/message-controls";
import { readOperatorPanel } from "@/lib/sav/intake-ux/operator-commands";
import { deliveryEmailUrl, readDeliveryReportTicket } from "@/lib/sav/intake/delivery-report-ticket";
import { crmRecordUrl } from "@/lib/sav/intake/crm-display";
import { IntakeOperatorActions } from "../operator-form";
export const dynamic = "force-dynamic";
export default async function IntakeDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{holdRelease?:string;returnTo?:string}> }) {
  const staff=await requireIntakeConsoleStaff();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const data = await readIntakeConsoleDetail(id);
  if (!data) notFound();
  const query = await searchParams;
  const releaseNotice=query?.holdRelease;
  const { current, blocked, plan, disposition, historicalPlan, contacts, tickets, target, historicalTarget, dirty, canCorrect, currentEffects, question, handoff } = intakeDossierView(data);
  const pendingOriginals = !dirty && !data.handledExternally && current?.messageId === data.latestMessageId && current?.sourceMatches
    && current.payload.reason === "SAV_INTAKE_PRIOR_REQUEST_PENDING" ? plan?.decision.evidence.filter(e => e.id.startsWith("prior-open-") && e.source === "customer_history") : undefined;
  const deliveryReport = !dirty && !data.handledExternally && !data.humanHeld && !data.thread.paused &&
    current?.messageId === data.latestMessageId && current?.sourceMatches &&
    (current.payload.reason === "SAV_INTAKE_SUPPORT_DELIVERY_FAILURE" || current.payload.reason === "SAV_INTAKE_PRIOR_REQUEST_PENDING"
      && current.payload.traces?.some(t => typeof t === "object" && t !== null && "phase" in t && t.phase === "automation_gate" && "kind" in t && t.kind === "support_delivery_failure"));
  const deliveryTarget = deliveryReport && data.latestMessageId
    ? await readDeliveryReportTicket(id,data.latestMessageId) : null;
  const portal = process.env.HUBSPOT_PORTAL_ID;
  const noticeLink = deliveryTarget?.ok ? deliveryEmailUrl(deliveryTarget.receipt, portal) : null;
  const noticeText = deliveryReport ? data.messages.find(message => message.id === data.latestMessageId)?.body.text : undefined;
  // Not awaited: names stream in under Suspense while the reads below proceed.
  const display=readIntakeCrmDisplay([...contacts,...(target?[target.contactId]:[]),...(historicalTarget?[historicalTarget.contactId]:[])],
    [...tickets,...(target&&target.operation!=="create"?[target.ticketId]:[]),...(historicalTarget&&historicalTarget.operation!=="create"?[historicalTarget.ticketId]:[]),...(data.progress?.ticketId?[data.progress.ticketId]:[])]);
  const controls = data.latestMessageId ? await readUxMessageControls(id, data.latestMessageId) : { blocked: true, reason: "Aucun message courant disponible." };
  const actions = intakeDossierActions(data, { current, canCorrect, plan }, staff), { operatorBinding } = actions;
  const operatorPanel = operatorBinding && actions.administrator ? await readOperatorPanel(operatorBinding) : null;
  // SAV-71: the same eligibility, with its bounded reason, as the MCP get_dossier and classify_other.
  const manualOtherEligibility = await readIntakeManualOther(data, actions.manualOther);
  const manualOtherBinding = manualOtherEligibility?.binding;
  return <div className={styles.console}>
    <IntakeBackLink className={styles.back} returnTo={query?.returnTo}/>
    <header className={styles.heading}><div><span className="eyebrow">Dossier · version {current?.version ?? "en attente"}</span><h1>{data.thread.subject || "Nouvelle demande"}</h1>
      <p>{dirty ? "Mise à jour du traitement en cours" : intakeReasonLabel(data.projection.reason) ?? intakeProjectionLabel(data.projection.status, data.uncertainty)}</p></div></header>
    {releaseNotice && <p role="status">{releaseNotice === "released" && !data.thread.paused && !data.humanHeld && !data.handledExternally ? "La pause est levée pour ce dossier. Le moteur pourra poursuivre si les preuves et la politique existante le permettent. Si une nouvelle qualification est nécessaire, utilisez « Refaire l’analyse » dans le panneau de poursuite." : "La pause est conservée : le dossier a changé, une opération reste en cours ou votre accès ne permet pas cette reprise. Rechargez le dossier et vérifiez ses preuves."}</p>}
    {pendingOriginals && <section className={styles.notice} aria-label="Demandes antérieures à traiter">
      <h2>Vérifier la prise en charge des mails précédents</h2>
      <p>Le dernier message est un avis automatique. Ouvrez les demandes ci-dessous et rattachez les originaux à leur ticket dans HubSpot. Si le fil est incomplet, vérifiez aussi son historique dans la boîte du support.</p>
      {pendingOriginals.map(e => {
        const original = data.messages.find(m => m.id === e.sourceId);
        return original && <details key={original.id}><summary>{original.fromEmail} · {formatParisDateTime(original.receivedAt)}</summary>
          <p style={{ whiteSpace: "pre-wrap" }}>{original.body.text}</p></details>;
      })}
      <p>Une fois les rattachements vérifiés, utilisez « Déjà traité ? » pour attester votre prise en charge du dossier.</p>
    </section>}
    {deliveryReport && <section className={styles.notice} aria-label="Avis de distribution">
      <h2>Avis de distribution à vérifier</h2>
      <p>Vérifiez si le message initial a été livré et consignez l’avis sur son ticket.</p>
      {deliveryTarget?.ok ? <p>Ticket proposé <strong>#{deliveryTarget.ticketId}</strong> — le message HubSpot #{deliveryTarget.emailId} correspond au parent direct de cet avis et est associé uniquement à ce ticket.
        {crmRecordUrl(portal,"ticket",deliveryTarget.ticketId) && <> <a href={crmRecordUrl(portal,"ticket",deliveryTarget.ticketId)!}>Ouvrir le ticket dans HubSpot</a></>}
        <br/>{deliveryTarget.receipt.state === "associated" ? `Avis entrant HubSpot #${deliveryTarget.receipt.emailId} déjà rattaché à ce ticket.`
          : deliveryTarget.receipt.state === "unassociated" ? `Avis entrant HubSpot #${deliveryTarget.receipt.emailId} retrouvé sans ticket. Rattachement manuel à vérifier.`
          : deliveryTarget.receipt.reason}
        {noticeLink && <> <a href={noticeLink}>Ouvrir l’activité de l’avis entrant</a></>}</p>
        : deliveryTarget && <p role="status">{deliveryTarget.reason}</p>}
      {deliveryTarget?.ok && deliveryTarget.receipt.state !== "associated" && <>
        {deliveryTarget.receipt.state === "unassociated" && <p>Dans HubSpot, associez l’activité entrante #{deliveryTarget.receipt.emailId} au ticket #{deliveryTarget.ticketId}, puis vérifiez le reçu ci-dessous.</p>}
        {noticeText && <details><summary>Texte de l’avis dans Studio</summary>
          <textarea aria-label="Texte original de l’avis à copier" readOnly value={noticeText} rows={6}/>
        </details>}
        <form method="get">
          {query?.returnTo && <input type="hidden" name="returnTo" value={query.returnTo}/>}
          <button type="submit">Relire le rattachement dans HubSpot</button>
        </form>
      </>}
    </section>}
    <StreamedCrmContext display={display} portal={portal} contactId={target?.contactId}
      ticketId={data.confirmedCurrent && data.progress?.ticketId ? data.progress.ticketId : target && target.operation !== "create" ? target.ticketId : undefined}
      confirmed={Boolean(data.confirmedCurrent)} creationPlanned={target?.operation === "create" && !data.confirmedCurrent}
      verifiedAt={data.confirmedCurrent ? data.progress?.effects.filter(e => e.state === "confirmed" && e.confirmedAt).map(e => e.confirmedAt!).sort((a,b)=>b.getTime()-a.getTime())[0]?.toISOString() : undefined}/>
    {data.projection.status === "uncertain" && <p role="status">{intakeUncertaintyLabel(data.uncertainty)}. Les effets confirmés restent conservés ; ce résumé ne vaut pas résolution du dossier.</p>}
    <div className={styles.detailGrid}><div>
      <MailConversation messages={data.messages}/>
      {data.historyTruncated && <p role="status">Les 200 messages les plus récents sont affichés. L’historique est incomplet.</p>}
      <section className={styles.decision}><h2>{data.humanHeld && !data.handledExternally ? "Prise en charge par l’équipe" : data.handledExternally ? "Disposition administrative" : data.confirmedCurrent ? "Résultat confirmé pour cette demande" : "Décision actuelle"}</h2>
        {blocked && <p role="status">Analyse bloquée : le plafond de tentatives de ce message est atteint ou indéterminé, toutes versions confondues{data.diagnostics?.attemptBudget ? ` (${data.diagnostics.attemptBudget.failed} échec(s), ${data.diagnostics.attemptBudget.total} tentative(s) au total)` : ""}. Aucune relance automatique : voir la prise en charge ci-dessous.</p>}
        {data.handledExternally ? <p>{["handled_externally", "human_other", "human_review"].includes(data.projection.status) ? data.projection.reason : "Le traitement externe est enregistré. Une commande humaine ou un résultat externe reste à rapprocher ; le dossier conserve ses preuves et son attente."}</p> : data.humanHeld ? <p>À valider par l’équipe. La pause humaine est conservée ; aucune action automatique ne peut reprendre sans levée explicite de cette pause.</p> : data.projection.status === "historical_outside_automation" ? <p>Historique conservé, hors automatisation. Un nouvel entrant après le lancement reprendra normalement avec cet historique.</p> : !plan ? <p>{blocked ? "Les diagnostics des tentatives précédentes sont conservés ci-dessous." : "Analyse en cours ou attente technique."} Aucune action n’est présentée comme accomplie.</p> : <>
          <dl><div><dt>Classification</dt><dd>{plan.decision.classification}</dd></div><div><dt>Parcours</dt><dd>{intakeRouteLabel(disposition)}</dd></div>
            {target && <div><dt>Fiche proposée</dt><dd><CrmRecord display={display} portal={portal} kind="contact" id={target.contactId}/></dd></div>}
            {target && target.operation !== "create" && <div><dt>Ticket proposé</dt><dd><CrmRecord display={display} portal={portal} kind="ticket" id={target.ticketId}/></dd></div>}</dl>
          {disposition?.kind === "collect_context" && <p>À vérifier : {disposition.reasons.map(reason => intakeContextReasonLabels[reason] ?? "preuve à compléter").join(", ")}.</p>}
          <details><summary>Sources de la décision ({plan.decision.evidence.length})</summary><ul className={styles.evidence}>
            {plan.decision.evidence.map(e => <li key={e.id}><strong>{e.source.replaceAll("_", " ")}</strong> · {e.sourceId}<time>{formatParisDateTime(new Date(e.observedAt))}</time></li>)}
          </ul></details>
        </>}
      </section>
      {handoff && <section className={styles.decision} aria-label="Prise en charge par l’équipe"><h2>Prise en charge par l’équipe</h2>
        {handoff.causes.length > 0 && <p>Cause : {handoff.causes.map(c => c.replace(/\.$/u, "")).join(", ")}.</p>}
        {handoff.actions.length > 0 && <><h3>Intervention attendue</h3><ul>{handoff.actions.map(action => <li key={action}>{action}</li>)}</ul></>}
        {handoff.tickets.length > 0 && <><h3>Tickets examinés</h3><ul>{handoff.tickets.map(t => <li key={t.ticketId}><CrmRecord display={display} portal={portal} kind="ticket" id={t.ticketId}/> · {t.relation}{t.why ? ` — ${t.why}` : ""}</li>)}</ul></>}
        {handoff.missing.length > 0 && <><h3>Éléments manquants</h3><ul>{handoff.missing.map((m, i) => <li key={i}>{m.why}</li>)}</ul></>}
        {handoff.rationale && <p>Analyse : {handoff.rationale}</p>}
        <p>{data.progress?.effects.some(e => e.state === "confirmed") ? `Actions déjà confirmées conservées : ${data.progress.effects.filter(e => e.state === "confirmed").length}.` : "Aucune action n’a encore été faite dans HubSpot ou Gmail."}</p>
      </section>}
      {historicalPlan && <section className={styles.history}><h2>Dernière analyse historique — non applicable à la demande actuelle</h2><p>Version {current?.version}. Les sources ou le dernier entrant ont changé ; ses anciennes propositions ne sont pas la décision actuelle.</p><details><summary>Consulter la proposition historique</summary><p>Classification historique : {historicalPlan.decision.classification}.</p>{historicalPlan.decision.disposition.kind === "ticket" && <p>Ancienne cible : <CrmRecord display={display} portal={portal} kind="contact" id={historicalPlan.decision.disposition.target.contactId}/>{historicalPlan.decision.disposition.target.operation !== "create" ? <> · <CrmRecord display={display} portal={portal} kind="ticket" id={historicalPlan.decision.disposition.target.ticketId}/></> : " · création proposée"}.</p>}</details></section>}
      <section className={styles.decision}><h2>{intakeEffectsTitle(currentEffects)}</h2>
        {data.progress ? <ol className={styles.effects}>{data.progress.effects.map(effect => <li key={effect.id} data-state={effect.state}>
          <span>{effectLabels[effect.kind] ?? effect.kind}</span><strong>{stateLabels[effect.state] ?? effect.state}</strong>
          {effect.confirmedAt && <time>{formatParisDateTime(effect.confirmedAt)}</time>}</li>)}</ol> : <p>Aucun effet n’a été engagé.</p>}
        {data.progress?.reason && <p>Attente : {intakeReasonLabel(data.progress.reason)}</p>}
        {data.progress?.crmDelta && <p>{intakeCrmDeltaLabel(data.progress.crmDelta)}</p>}
        {data.diagnostics?.execution && data.diagnostics.execution.state !== "confirmed" && <p>Prochaine étape : {intakeNextStepLabel(data.diagnostics.execution.nextStep)}</p>}
        {data.progress?.crmRecheck && <p>{data.progress.crmRecheck.humanRequired ? `Contrôles automatiques arrêtés (${data.progress.crmRecheck.attempts}/${data.progress.crmRecheck.max}) : décision humaine attendue.`
          : `Contrôle automatique ${data.progress.crmRecheck.attempts}/${data.progress.crmRecheck.max}${data.progress.crmRecheck.nextAt ? `, prochain au plus tôt ${formatParisDateTime(new Date(data.progress.crmRecheck.nextAt))}` : ""}. Les actions confirmées ne sont pas rejouées.`}</p>}
        {data.confirmedCurrent && data.progress?.ticketId && <p>Ticket confirmé : <CrmRecord display={display} portal={portal} kind="ticket" id={data.progress.ticketId}/>. {data.projection.status === "followup_pending" ? "Premier suivi encore en attente." : "L’avancement du suivi reste fondé sur ses sources collectées."}</p>}
        <p>Aucun brouillon de réponse de résolution n’a été produit par ce parcours. Les réponses supervisées existantes restent dans la file supervisée.</p>
      </section>
    </div><aside className={styles.side}>
      <IntakeProcessingSummary status={intakeProjectionLabel(data.projection.status, data.uncertainty)} cause={intakeReasonLabel(data.progress?.reason ?? data.projection.reason)} question={question}
        confirmedEffects={data.progress?.effects.filter(e=>e.state==="confirmed").length??0} uncertain={data.progress?.state==="uncertain"||Boolean(data.progress?.effects.some(e=>["dispatched","acked","uncertain"].includes(e.state)))}
        paused={data.thread.paused||data.humanHeld} exhausted={Boolean(blocked)}
        lastActivity={data.diagnostics?.runs.flatMap(r=>r.events.map(e=>e.createdAt)).sort((a,b)=>b.getTime()-a.getTime())[0] ? formatParisDateTime(data.diagnostics.runs.flatMap(r=>r.events.map(e=>e.createdAt)).sort((a,b)=>b.getTime()-a.getTime())[0]) : undefined}/>
      {!pendingOriginals && manualOtherBinding && <IntakeManualOtherForm key={`manual-other-${manualOtherBinding.messageId}-${manualOtherBinding.version}-${manualOtherBinding.sourceHash}`} binding={manualOtherBinding} requestKey={randomUUID()}/>}
      {manualOtherEligibility?.reason && <section className={styles.notice} aria-label="Classement dans Autres indisponible"><h2>Classement dans Autres indisponible</h2>
        <p>{manualOtherUnavailableLabels[manualOtherEligibility.reason]}</p></section>}
      {actions.classifyInvalidSource && current && <IntakeInvalidSourceForm key={`invalid-${current.messageId}`} threadId={id} messageId={current.messageId} requestKey={randomUUID()}/>}
      {actions.closeHandledOutside && data.latestMessageId && <IntakeCompletionForm priorRequests={Boolean(pendingOriginals)} key={data.latestMessageId} threadId={id} messageId={data.latestMessageId} requestKey={randomUUID()}/>}
      {actions.releaseHold && data.latestMessageId && <section className={styles.notice}><h2>Reprendre ce dossier</h2>
        <p>Cette action lève uniquement sa pause humaine. Le moteur automatique pourra poursuivre si les preuves et la politique existante le permettent. Les tentatives et les preuves sont conservées. Si une nouvelle qualification est nécessaire, utilisez ensuite « Refaire l’analyse » dans le panneau de poursuite.</p>
        <form action={releaseIntakeHumanHoldAction}>
          <input type="hidden" name="requestKey" value={randomUUID()}/><input type="hidden" name="threadId" value={id}/>
          <input type="hidden" name="messageId" value={data.latestMessageId}/><input type="hidden" name="expectedEpoch" value={data.projection.epoch}/>
          <input type="hidden" name="returnTo" value={query?.returnTo ?? ""}/>
          <label>Motif de la reprise<textarea name="reason" required minLength={10} maxLength={2000}/></label>
          <button type="submit">Lever la pause</button>
        </form></section>}
      {!pendingOriginals && actions.recordChoice && current?.sourceHash && plan ? <StreamedChoiceForm expected={{ commandKey: randomUUID(), threadId: id,
        messageId: current.messageId, runId: current.id, version: current.version, sourceHash: current.sourceHash,
        candidatesHash: intakeRuntimeHash(contacts) }} contacts={contacts} tickets={tickets} display={display} classification={plan.decision.classification}
        actorId={staff.id} selectedContactId={target?.contactId} selectedTicketId={target && target.operation !== "create" ? target.ticketId : undefined}/> :
        <section className={styles.notice}><h2>Correction indisponible</h2><p>{data.thread.paused ? "Le dossier est en pause." : "La version doit être courante, ses sources inchangées et aucun choix déjà en attente."}</p></section>}
      {operatorBinding && operatorPanel && <IntakeOperatorActions binding={operatorBinding} actorId={staff.id} requestKeys={{resume:randomUUID(),reanalyse:randomUUID(),information:randomUUID()}} panel={operatorPanel}/>}
      <section className={styles.history}><h2>Choix humains conservés</h2>{data.choices.length ? <ol>{data.choices.map(event => <li key={event.id}>
        <strong>{event.kind === "refuse" ? "Refus humain" : "Choix conditionnel"} · version {event.parentVersion}</strong><p>{event.reason}</p>
        <small>{event.actor} · {formatParisDateTime(event.at)} · {event.state === "consumed" ? "choix consommé" : event.state === "refused" ? "refus conservé" : event.state === "waiting" ? "preuves à compléter" : "vérification en attente"}</small></li>)}</ol> : <p>Aucun choix humain enregistré.</p>}</section>
      <details className={styles.history}><summary>Diagnostic technique</summary><p>{data.current?.payload.reason ?? data.progress?.reason ?? (blocked ? "Tentatives épuisées — consulter les versions précédentes." : "Aucun motif technique enregistré sur la version actuelle.")}</p>
        {actions.administratorVerifications&&data.latestMessageId&&<IntakeRecoveryForm threadId={id} messageId={data.latestMessageId}
          hasNoteReceipt={actions.noteReceipt} allowReanalysis={false} showReanalysis={false}
          unavailableReason={controls.reason}/>}
        <p>{data.diagnostics?.totalAttempts ?? 0} tentative(s) cumulée(s) pour le dernier message. Les versions remplacées ne sont pas des décisions applicables.</p>
        {data.diagnostics?.execution && <p>Exécution : {intakeExecutionStateLabel(data.diagnostics.execution.state ?? "waiting")} · {data.diagnostics.execution.waitingPasses ?? 0} passage(s) en attente
          {data.diagnostics.execution.lastPassAt ? ` · dernier ${formatParisDateTime(data.diagnostics.execution.lastPassAt)}` : ""} · {data.diagnostics.execution.reason ?? "aucun code"}
          {data.diagnostics.execution.originalCrmRecorded === false ? " · empreinte HubSpot d’origine absente (analyse antérieure)" : ""}.</p>}
        {data.diagnostics?.runs.map(run => <details key={run.runId}><summary>Version {run.version} · {intakeStatusLabel(run.state)} · {run.attempts} tentative(s)</summary>
          <p>{run.diagnostic.readable ? run.diagnostic.reason ? intakeReasonLabel(run.diagnostic.reason) : "Aucun code technique enregistré dans cette version." : "Diagnostic historique illisible ou hors limite ; cause non évaluable."}</p>
          {run.diagnostic.contextReasons.length > 0 && <p>Preuves à compléter : {run.diagnostic.contextReasons.map(reason => intakeContextReasonLabels[reason]).join(", ")}.</p>}
          <ul>{run.diagnostic.traces.filter(trace => trace.errorCode || trace.reason).map((trace, index) => <li key={index}>{trace.operation ?? trace.method ?? trace.phase ?? "Vérification"} : {trace.errorCode ?? trace.reason}</li>)}</ul>
          <details><summary>Événements conservés ({run.events.length})</summary><ul>{run.events.map(event => <li key={event.id}>{formatParisDateTime(event.createdAt)} · {event.kind ?? "événement"} : {event.diagnostic.readable
            ? [event.diagnostic.reason, ...event.diagnostic.contextReasons, ...event.diagnostic.traces.flatMap(t => [t.errorCode, t.reason].filter(Boolean))].filter(Boolean).join(", ") || "aucun code technique conservé"
            : "détail illisible ou hors limite"}</li>)}</ul></details>
        </details>)}
        {(data.diagnostics?.versionsTruncated || data.diagnostics?.eventsTruncated) && <p>Historique affiché partiellement : limites de lecture atteintes.</p>}
      </details>
    </aside></div>
  </div>;
}
