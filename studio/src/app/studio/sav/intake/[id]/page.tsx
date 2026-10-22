import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readIntakeConsoleDetail } from "@/lib/sav/intake/console-detail";
import { intakeRuntimeHash } from "@/lib/sav/intake/runtime-contract";
import { formatParisDateTime } from "@/lib/paris-date";
import { MailConversation } from "../../[id]/mail-conversation";
import { IntakeChoiceForm } from "../choice-form";
import { intakeStatusLabel, intakeReasonLabel, intakeContextReasonLabels } from "@/lib/sav/intake/console-presentation";
import styles from "../intake.module.css";
export const dynamic = "force-dynamic";
const effectLabels: Record<string, string> = { ticket_create: "Création du ticket", note_create: "Note de contexte", note_associate: "Rattachement de la note",
  email_create: "Conservation de l’email CRM", email_associate: "Rattachement de l’email", stage_new: "Statut Nouveau", identity_send: "Demande d’identification" };
const stateLabels: Record<string, string> = { planned: "Prévu, sans départ", dispatched: "Départ enregistré, résultat à vérifier", acked: "Réponse fournisseur reçue, vérification en attente",
  confirmed: "Résultat vérifié", uncertain: "Résultat incertain, rapprochement requis" };
export default async function IntakeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireIntakeConsoleStaff();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const data = await readIntakeConsoleDetail(id);
  if (!data) notFound();
  const current = data.current;
  const blocked = data.diagnostics?.messageId === data.latestMessageId && data.diagnostics.attemptsExhausted
    && current && ["pending", "waiting"].includes(current.state) && !data.confirmedCurrent;
  const applicable = Boolean(data.confirmedCurrent || current && current.messageId === data.latestMessageId && current.sourceMatches);
  const plan = applicable ? current?.payload.plan : undefined, disposition = plan?.decision.disposition;
  const historicalPlan = !applicable ? current?.payload.plan : undefined;
  const contacts = [...(current?.candidateContactIds ?? [])].sort();
  const tickets = [...new Set([...(data.progress?.effects.filter(e=>e.kind==="ticket_create"&&e.state==="confirmed"&&e.ack?.id).map(e=>e.ack!.id!)??[]),...(plan?.decision.evidence.filter(e => e.source === "crm_ticket" && /^\d+$/.test(e.sourceId)).map(e => e.sourceId) ?? [])])];
  const target = disposition?.kind === "ticket" ? disposition.target : null;
  const portal = process.env.HUBSPOT_PORTAL_ID;
  const ticketUrl = portal && /^\d+$/.test(portal) && data.progress?.confirmed && data.progress.ticketId ? `https://app.hubspot.com/contacts/${portal}/ticket/${encodeURIComponent(data.progress.ticketId)}` : null;
  const dirty = data.projection.epoch !== data.projection.projectedEpoch;
  const canCorrect = data.projection.status !== "historical_outside_automation" && Boolean(current && current.messageId === data.latestMessageId && current.sourceMatches && current.candidateContactIds !== null && !data.progress?.confirmed && current.sourceHash && plan && !data.thread.paused
    && !data.choices.some(event => event.kind === "refuse" && event.parentVersion === current.version)
    && !data.choices.some(event => ["pending", "reading"].includes(event.state)));
  return <div className={styles.console}>
    <Link className={styles.back} href="/studio/sav/intake">← Nouveaux dossiers</Link>
    <header className={styles.heading}><div><span className="eyebrow">Dossier · version {current?.version ?? "en attente"}</span><h1>{data.thread.subject || "Nouvelle demande"}</h1>
      <p>{dirty ? "Mise à jour du traitement en cours" : intakeReasonLabel(data.projection.reason) ?? intakeStatusLabel(data.projection.status)}</p></div></header>
    <div className={styles.detailGrid}><div>
      <section className={styles.decision}><h2>{data.confirmedCurrent ? "Résultat confirmé pour cette demande" : "Décision actuelle"}</h2>
        {blocked && <p role="status">Analyse bloquée : les deux tentatives de ce message sont épuisées, y compris dans ses versions précédentes. Aucune relance automatique n’est autorisée par ce diagnostic.</p>}
        {data.projection.status === "historical_outside_automation" ? <p>Historique conservé, hors automatisation. Un nouvel entrant après le lancement reprendra normalement avec cet historique.</p> : !plan ? <p>{blocked ? "Les diagnostics des tentatives précédentes sont conservés ci-dessous." : "Analyse en cours ou attente technique."} Aucune action n’est présentée comme accomplie.</p> : <>
          <dl><div><dt>Classification</dt><dd>{plan.decision.classification}</dd></div><div><dt>Parcours</dt><dd>{disposition?.kind === "ticket" ? target?.operation === "create" ? "Créer une fiche ticket" : target?.operation === "reopen" ? "Rouvrir le ticket" : "Rattacher au ticket"
            : disposition?.kind === "request_identification" ? "Demander l’adresse d’inscription" : disposition?.kind === "collect_context" ? "Compléter les preuves" : "Sans ticket"}</dd></div>
            {target && <div><dt>Fiche proposée</dt><dd>Contact HubSpot {target.contactId}</dd></div>}
            {target && target.operation !== "create" && <div><dt>Ticket proposé</dt><dd>{target.ticketId}</dd></div>}</dl>
          {disposition?.kind === "collect_context" && <p>À vérifier : {disposition.reasons.map(reason => intakeContextReasonLabels[reason] ?? "preuve à compléter").join(", ")}.</p>}
          <details><summary>Sources de la décision ({plan.decision.evidence.length})</summary><ul className={styles.evidence}>
            {plan.decision.evidence.map(e => <li key={e.id}><strong>{e.source.replaceAll("_", " ")}</strong> · {e.sourceId}<time>{formatParisDateTime(new Date(e.observedAt))}</time></li>)}
          </ul></details>
        </>}
      </section>
      {historicalPlan && <section className={styles.history}><h2>Dernière analyse historique — non applicable à la demande actuelle</h2><p>Version {current?.version}. Les sources ou le dernier entrant ont changé ; ses anciennes propositions ne sont pas la décision actuelle.</p><details><summary>Consulter la proposition historique</summary><p>Classification historique : {historicalPlan.decision.classification}.</p>{historicalPlan.decision.disposition.kind === "ticket" && <p>Ancienne cible : contact {historicalPlan.decision.disposition.target.contactId}{historicalPlan.decision.disposition.target.operation !== "create" ? ` · ticket ${historicalPlan.decision.disposition.target.ticketId}` : " · création proposée"}.</p>}</details></section>}
      <section className={styles.decision}><h2>{applicable ? "Actions réellement accomplies" : "Actions historiques conservées"}</h2>
        {data.progress ? <ol className={styles.effects}>{data.progress.effects.map(effect => <li key={effect.id}>
          <span>{effectLabels[effect.kind] ?? effect.kind}</span><strong>{stateLabels[effect.state] ?? effect.state}</strong>
          {effect.confirmedAt && <time>{formatParisDateTime(effect.confirmedAt)}</time>}</li>)}</ol> : <p>Aucun effet n’a été engagé.</p>}
        {data.progress?.reason && <p>Attente : {intakeReasonLabel(data.progress.reason)}</p>}
        {data.progress?.confirmed && data.progress.ticketId && <p>Ticket confirmé : <strong>{data.progress.ticketId}</strong>. {ticketUrl && <a href={ticketUrl} target="_blank" rel="noreferrer">Ouvrir le ticket HubSpot</a>} {data.projection.status === "followup_pending" ? "Premier suivi encore en attente." : "L’avancement du suivi reste fondé sur ses sources collectées."}</p>}
        <p>Aucun brouillon de réponse de résolution n’a été produit par ce parcours. Les réponses supervisées existantes restent dans la file supervisée.</p>
      </section>
      <MailConversation messages={data.messages}/>
      {data.historyTruncated && <p role="status">Les 200 messages les plus récents sont affichés. L’historique est incomplet.</p>}
    </div><aside className={styles.side}>
      {canCorrect && current?.sourceHash && plan ? <IntakeChoiceForm expected={{ commandKey: randomUUID(), threadId: id,
        messageId: current.messageId, runId: current.id, version: current.version, sourceHash: current.sourceHash,
        candidatesHash: intakeRuntimeHash(contacts) }} contacts={contacts} tickets={tickets} classification={plan.decision.classification}/> :
        <section className={styles.notice}><h2>Correction indisponible</h2><p>{data.thread.paused ? "Le dossier est en pause." : "La version doit être courante, ses sources inchangées et aucun choix déjà en attente."}</p></section>}
      <section className={styles.history}><h2>Choix humains conservés</h2>{data.choices.length ? <ol>{data.choices.map(event => <li key={event.id}>
        <strong>{event.kind === "refuse" ? "Refus humain" : "Choix conditionnel"} · version {event.parentVersion}</strong><p>{event.reason}</p>
        <small>{event.actor} · {formatParisDateTime(event.at)} · {event.state === "consumed" ? "choix consommé" : event.state === "refused" ? "refus conservé" : event.state === "waiting" ? "preuves à compléter" : "vérification en attente"}</small></li>)}</ol> : <p>Aucun choix humain enregistré.</p>}</section>
      <details className={styles.history}><summary>Diagnostic technique</summary><p>{data.current?.payload.reason ?? data.progress?.reason ?? (blocked ? "Tentatives épuisées — consulter les versions précédentes." : "Aucun motif technique enregistré sur la version actuelle.")}</p>
        <p>{data.diagnostics?.totalAttempts ?? 0} tentative(s) cumulée(s) pour le dernier message. Les versions remplacées ne sont pas des décisions applicables.</p>
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
