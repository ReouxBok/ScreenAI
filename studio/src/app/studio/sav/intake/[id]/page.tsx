import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readIntakeConsoleDetail } from "@/lib/sav/intake/console-detail";
import { intakeRuntimeHash } from "@/lib/sav/intake/runtime-contract";
import { formatParisDateTime } from "@/lib/paris-date";
import { MailConversation } from "../../[id]/mail-conversation";
import {readIntakeCrmDisplay} from "@/lib/sav/intake/crm-display-server";
import { releaseIntakeHumanHoldAction } from "../actions";
import {IntakeRecoveryForm} from "../recovery-form";
import { IntakeCompletionForm } from "../completion-form";
import { readManualOtherBinding } from "@/lib/sav/intake/manual-other-classification";
import { IntakeManualOtherForm } from "../manual-other-form";
import { IntakeInvalidSourceForm } from "../invalid-source-form";
import { intakeStatusLabel, intakeReasonLabel, intakeContextReasonLabels, intakeHandoff, intakeCrmDeltaLabel, intakeNextStepLabel } from "@/lib/sav/intake/console-presentation";
import styles from "../intake.module.css";
import { IntakeBackLink } from "../navigation";
import { CrmRecord, StreamedChoiceForm, StreamedCrmContext } from "../crm-streamed";
import { IntakeProcessingSummary } from "../processing-summary";
import { readUxMessageControls } from "@/lib/sav/intake-ux/message-controls";
import { readOperatorPanel } from "@/lib/sav/intake-ux/operator-commands";
import { IntakeOperatorActions } from "../operator-form";
export const dynamic = "force-dynamic";
const effectLabels: Record<string, string> = { ticket_create: "Création du ticket", note_create: "Note de contexte", note_associate: "Rattachement de la note",
  email_create: "Conservation de l’email CRM", email_associate: "Rattachement de l’email", stage_new: "Statut Nouveau", identity_send: "Demande d’identification" };
const stateLabels: Record<string, string> = { planned: "Prévu, sans départ", dispatched: "Départ enregistré, résultat à vérifier", acked: "Réponse fournisseur reçue, vérification en attente",
  confirmed: "Résultat vérifié", uncertain: "Résultat incertain, rapprochement requis" };
export default async function IntakeDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{holdRelease?:string;returnTo?:string}> }) {
  const staff=await requireIntakeConsoleStaff();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const data = await readIntakeConsoleDetail(id);
  if (!data) notFound();
  const query = await searchParams;
  const releaseNotice=query?.holdRelease;
  const current = data.current;
  const blocked = !data.handledExternally && !data.humanHeld && data.diagnostics?.messageId === data.latestMessageId && data.diagnostics.attemptsExhausted !== false
    && current && ["pending", "waiting"].includes(current.state) && !data.confirmedCurrent;
  const applicable = !data.handledExternally && !data.humanHeld && Boolean(data.confirmedCurrent || current && current.messageId === data.latestMessageId && current.sourceMatches);
  const plan = applicable ? current?.payload.plan : undefined, disposition = plan?.decision.disposition;
  const historicalPlan = !applicable ? current?.payload.plan : undefined;
  const contacts = [...(current?.candidateContactIds ?? [])].sort();
  const tickets = [...new Set([...(data.progress?.effects.filter(e=>e.kind==="ticket_create"&&e.state==="confirmed"&&e.ack?.id).map(e=>e.ack!.id!)??[]),...(plan?.decision.evidence.filter(e => e.source === "crm_ticket" && /^\d+$/.test(e.sourceId)).map(e => e.sourceId) ?? [])])];
  const target = disposition?.kind === "ticket" ? disposition.target : null;
  const portal = process.env.HUBSPOT_PORTAL_ID;
  const historicalTarget=historicalPlan?.decision.disposition.kind==="ticket"?historicalPlan.decision.disposition.target:null;
  // Not awaited: names stream in under Suspense while the reads below proceed.
  const display=readIntakeCrmDisplay([...contacts,...(target?[target.contactId]:[]),...(historicalTarget?[historicalTarget.contactId]:[])],
    [...tickets,...(target&&target.operation!=="create"?[target.ticketId]:[]),...(historicalTarget&&historicalTarget.operation!=="create"?[historicalTarget.ticketId]:[]),...(data.progress?.ticketId?[data.progress.ticketId]:[])]);
  const dirty = data.projection.epoch !== data.projection.projectedEpoch;
  const canCorrect = !data.handledExternally && !data.humanHeld && data.projection.status !== "historical_outside_automation" && Boolean(current && current.messageId === data.latestMessageId && current.sourceMatches && current.candidateContactIds !== null && !data.progress?.confirmed && current.sourceHash && plan && !data.thread.paused
    && !data.choices.some(event => event.kind === "refuse" && event.parentVersion === current.version)
    && !data.choices.some(event => ["pending", "reading"].includes(event.state)));
  const controls = data.latestMessageId ? await readUxMessageControls(id, data.latestMessageId) : { blocked: true, reason: "Aucun message courant disponible." };
  const operatorBinding = current?.sourceHash && current.messageId === data.latestMessageId ? {threadId:id,messageId:current.messageId,runId:current.id,version:current.version,sourceHash:current.sourceHash} : null;
  const operatorPanel = operatorBinding && ["admin","owner"].includes(staff.role) ? await readOperatorPanel(operatorBinding) : null;
  const manualOtherBinding = staff.email === "ugo@limova.ai" && ["admin", "owner"].includes(staff.role)
    && !data.handledExternally && !data.humanHeld && !data.thread.paused && !data.confirmedCurrent && !current?.sourceInvalid
    && data.latestMessageId && !data.progress?.effects.some(effect => effect.state !== "planned")
    && (data.projection.view === "to_validate" || data.projection.view === null)
    ? await readManualOtherBinding(id, data.latestMessageId, data.projection.epoch) : null;
  const currentEffects = Boolean(data.confirmedCurrent || applicable && data.progress?.runId === current?.id);
  const question = data.projection.view === "to_validate" || ["human_choice", "human_hold", "human_review"].includes(data.projection.status)
    ? plan?.progress?.kind === "human_choice" ? "Choisir la bonne fiche ou le ticket qui recevra ce mail"
      : disposition?.kind === "no_ticket" && disposition.nextAction === "supervised_investor" ? "Prendre en charge cette demande d’investissement"
        : disposition?.kind === "no_ticket" && disposition.nextAction === "supervised_partnership" ? "Prendre en charge cette demande de partenariat"
          : disposition?.kind === "no_ticket" && disposition.nextAction === "supervised_commercial" ? "Prendre en charge cette demande commerciale" : "Quelle suite l’équipe doit-elle donner à cette demande ?" : null;
  const judgement = (current?.payload.traces as { phase?: string }[] | undefined)?.findLast(t => t?.phase === "simple_judgement") as Parameters<typeof intakeHandoff>[0]["judgement"];
  const assessed = (current?.payload.semantics?.records.find(r => r.method === "assessIssues")?.result as { tickets?: { ticketId: string; relation: string }[] } | undefined)?.tickets;
  const handoffReasons = [...(disposition?.kind === "collect_context" ? disposition.reasons : []), ...(current?.payload.reason === "SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED" || current?.payload.reason === "SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED" || current?.payload.reason === "SAV_INTAKE_RUNTIME_ROLLING_BUDGET_DEFERRED" ? [current.payload.reason] : [])];
  const handoff = !data.handledExternally && !data.confirmedCurrent && (blocked || handoffReasons.length > 0 || question)
    ? intakeHandoff({ reasons: handoffReasons, blockedCause: blocked ? "attempts_exhausted" : null, assessments: assessed, judgement }) : null;
  return <div className={styles.console}>
    <IntakeBackLink className={styles.back} returnTo={query?.returnTo}/>
    <header className={styles.heading}><div><span className="eyebrow">Dossier · version {current?.version ?? "en attente"}</span><h1>{data.thread.subject || "Nouvelle demande"}</h1>
      <p>{dirty ? "Mise à jour du traitement en cours" : intakeReasonLabel(data.projection.reason) ?? intakeStatusLabel(data.projection.status)}</p></div></header>
    {releaseNotice && <p role="status">{releaseNotice === "released" && !data.thread.paused && !data.humanHeld && !data.handledExternally ? "La pause est levée pour ce dossier. Le moteur pourra poursuivre si les preuves et la politique existante le permettent. Si une nouvelle qualification est nécessaire, utilisez « Refaire l’analyse » dans le panneau de poursuite." : "La pause est conservée : le dossier a changé, une opération reste en cours ou votre accès ne permet pas cette reprise. Rechargez le dossier et vérifiez ses preuves."}</p>}
    <StreamedCrmContext display={display} portal={portal} contactId={target?.contactId}
      ticketId={data.confirmedCurrent && data.progress?.ticketId ? data.progress.ticketId : target && target.operation !== "create" ? target.ticketId : undefined}
      confirmed={Boolean(data.confirmedCurrent)} creationPlanned={target?.operation === "create" && !data.confirmedCurrent}
      verifiedAt={data.confirmedCurrent ? data.progress?.effects.filter(e => e.state === "confirmed" && e.confirmedAt).map(e => e.confirmedAt!).sort((a,b)=>b.getTime()-a.getTime())[0]?.toISOString() : undefined}/>
    <div className={styles.detailGrid}><div>
      <MailConversation messages={data.messages}/>
      {data.historyTruncated && <p role="status">Les 200 messages les plus récents sont affichés. L’historique est incomplet.</p>}
      <section className={styles.decision}><h2>{data.humanHeld && !data.handledExternally ? "Prise en charge par l’équipe" : data.handledExternally ? "Disposition administrative" : data.confirmedCurrent ? "Résultat confirmé pour cette demande" : "Décision actuelle"}</h2>
        {blocked && <p role="status">Analyse bloquée : le plafond de tentatives de ce message est atteint ou indéterminé, toutes versions confondues{data.diagnostics?.attemptBudget ? ` (${data.diagnostics.attemptBudget.failed} échec(s), ${data.diagnostics.attemptBudget.total} tentative(s) au total)` : ""}. Aucune relance automatique : voir la prise en charge ci-dessous.</p>}
        {data.handledExternally ? <p>{["handled_externally", "human_other", "human_review"].includes(data.projection.status) ? data.projection.reason : "Le traitement externe est enregistré. Une commande humaine ou un résultat externe reste à rapprocher ; le dossier conserve ses preuves et son attente."}</p> : data.humanHeld ? <p>À valider par l’équipe. La pause humaine est conservée ; aucune action automatique ne peut reprendre sans levée explicite de cette pause.</p> : data.projection.status === "historical_outside_automation" ? <p>Historique conservé, hors automatisation. Un nouvel entrant après le lancement reprendra normalement avec cet historique.</p> : !plan ? <p>{blocked ? "Les diagnostics des tentatives précédentes sont conservés ci-dessous." : "Analyse en cours ou attente technique."} Aucune action n’est présentée comme accomplie.</p> : <>
          <dl><div><dt>Classification</dt><dd>{plan.decision.classification}</dd></div><div><dt>Parcours</dt><dd>{disposition?.kind === "ticket" ? target?.operation === "create" ? "Créer une fiche ticket" : target?.operation === "reopen" ? "Rouvrir le ticket" : "Rattacher au ticket"
            : disposition?.kind === "request_identification" ? "Demander l’adresse d’inscription" : disposition?.kind === "collect_context" ? "Compléter les preuves" : "Sans ticket"}</dd></div>
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
      <section className={styles.decision}><h2>{currentEffects ? "Actions réellement accomplies" : "Actions historiques conservées"}</h2>
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
      <IntakeProcessingSummary status={intakeStatusLabel(data.projection.status)} cause={intakeReasonLabel(data.progress?.reason ?? data.projection.reason)} question={question}
        confirmedEffects={data.progress?.effects.filter(e=>e.state==="confirmed").length??0} uncertain={data.progress?.state==="uncertain"||Boolean(data.progress?.effects.some(e=>["dispatched","acked","uncertain"].includes(e.state)))}
        paused={data.thread.paused||data.humanHeld} exhausted={Boolean(blocked)}
        lastActivity={data.diagnostics?.runs.flatMap(r=>r.events.map(e=>e.createdAt)).sort((a,b)=>b.getTime()-a.getTime())[0] ? formatParisDateTime(data.diagnostics.runs.flatMap(r=>r.events.map(e=>e.createdAt)).sort((a,b)=>b.getTime()-a.getTime())[0]) : undefined}/>
      {manualOtherBinding && <IntakeManualOtherForm key={`manual-other-${manualOtherBinding.messageId}-${manualOtherBinding.version}-${manualOtherBinding.sourceHash}`} binding={manualOtherBinding} requestKey={randomUUID()}/>}
      {!data.handledExternally && current?.sourceInvalid && current.messageId === data.latestMessageId && staff.email === "ugo@limova.ai" && ["admin", "owner"].includes(staff.role) && <IntakeInvalidSourceForm key={`invalid-${current.messageId}`} threadId={id} messageId={current.messageId} requestKey={randomUUID()}/>}
      {(!data.handledExternally || data.projection.status === "human_review") && data.latestMessageId && staff.email === "ugo@limova.ai" && ["admin", "owner"].includes(staff.role) && <IntakeCompletionForm key={data.latestMessageId} threadId={id} messageId={data.latestMessageId} requestKey={randomUUID()}/>}
      {data.humanHeld && !data.handledExternally && data.latestMessageId && ["admin","owner"].includes(staff.role) && <section className={styles.notice}><h2>Reprendre ce dossier</h2>
        <p>Cette action lève uniquement sa pause humaine. Le moteur automatique pourra poursuivre si les preuves et la politique existante le permettent. Les tentatives et les preuves sont conservées. Si une nouvelle qualification est nécessaire, utilisez ensuite « Refaire l’analyse » dans le panneau de poursuite.</p>
        <form action={releaseIntakeHumanHoldAction}>
          <input type="hidden" name="requestKey" value={randomUUID()}/><input type="hidden" name="threadId" value={id}/>
          <input type="hidden" name="messageId" value={data.latestMessageId}/><input type="hidden" name="expectedEpoch" value={data.projection.epoch}/>
          <input type="hidden" name="returnTo" value={query?.returnTo ?? ""}/>
          <label>Motif de la reprise<textarea name="reason" required minLength={10} maxLength={2000}/></label>
          <button type="submit">Lever la pause</button>
        </form></section>}
      {canCorrect && current?.sourceHash && plan ? <StreamedChoiceForm expected={{ commandKey: randomUUID(), threadId: id,
        messageId: current.messageId, runId: current.id, version: current.version, sourceHash: current.sourceHash,
        candidatesHash: intakeRuntimeHash(contacts) }} contacts={contacts} tickets={tickets} display={display} classification={plan.decision.classification}
        actorId={staff.id} selectedContactId={target?.contactId} selectedTicketId={target && target.operation !== "create" ? target.ticketId : undefined}/> :
        <section className={styles.notice}><h2>Correction indisponible</h2><p>{data.thread.paused ? "Le dossier est en pause." : "La version doit être courante, ses sources inchangées et aucun choix déjà en attente."}</p></section>}
      {operatorBinding && operatorPanel && <IntakeOperatorActions binding={operatorBinding} actorId={staff.id} requestKeys={{resume:randomUUID(),reanalyse:randomUUID(),information:randomUUID()}} panel={operatorPanel}/>}
      <section className={styles.history}><h2>Choix humains conservés</h2>{data.choices.length ? <ol>{data.choices.map(event => <li key={event.id}>
        <strong>{event.kind === "refuse" ? "Refus humain" : "Choix conditionnel"} · version {event.parentVersion}</strong><p>{event.reason}</p>
        <small>{event.actor} · {formatParisDateTime(event.at)} · {event.state === "consumed" ? "choix consommé" : event.state === "refused" ? "refus conservé" : event.state === "waiting" ? "preuves à compléter" : "vérification en attente"}</small></li>)}</ol> : <p>Aucun choix humain enregistré.</p>}</section>
      <details className={styles.history}><summary>Diagnostic technique</summary><p>{data.current?.payload.reason ?? data.progress?.reason ?? (blocked ? "Tentatives épuisées — consulter les versions précédentes." : "Aucun motif technique enregistré sur la version actuelle.")}</p>
        {["admin","owner"].includes(staff?.role??"")&&data.latestMessageId&&<IntakeRecoveryForm threadId={id} messageId={data.latestMessageId}
          hasNoteReceipt={Boolean(data.progress?.effects.some(effect=>effect.kind==="note_create"&&effect.ack?.id))} allowReanalysis={false} showReanalysis={false}
          unavailableReason={controls.reason}/>}
        <p>{data.diagnostics?.totalAttempts ?? 0} tentative(s) cumulée(s) pour le dernier message. Les versions remplacées ne sont pas des décisions applicables.</p>
        {data.diagnostics?.execution && <p>Exécution : {intakeStatusLabel(data.diagnostics.execution.state ?? "waiting")} · {data.diagnostics.execution.waitingPasses ?? 0} passage(s) en attente
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
