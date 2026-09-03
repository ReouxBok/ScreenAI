import Link from "next/link";
import { ArrowLeft, Bot, CheckCircle2, CircleAlert, Clock3, ExternalLink, LockKeyhole, UserRound } from "lucide-react";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { getSavThreadDetail } from "@/lib/sav/service";
import { approveDraftAction, correctDecisionAction, createTicketAction, requestHumanAction, retryAction, reviewPilotItemAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SavThreadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; batch?: string }> }) {
  await requireStaff("admin");
  const { id } = await params;
  const { from = "", batch = "" } = await searchParams;
  const detail = await getSavThreadDetail(id);
  if (!detail) notFound();
  const currentDecision = [...detail.decisions].reverse().find((decision) => decision.isCurrent);
  const approvedDraftIds = new Set(detail.actions.map((action) => action.payload.approvedDraftId).filter((value): value is string => typeof value === "string"));
  const drafts = detail.actions.filter((action) => action.kind === "draft_reply" && action.status === "succeeded" && !approvedDraftIds.has(action.id));
  const notes = detail.actions.filter((action) => action.kind === "create_note" && action.noteText);
  const pilotExternalActions = new Set(["create_ticket", "link_ticket", "log_email", "create_note", "send_reply", "update_ticket_status"]);
  const hubspotPortalId = process.env.HUBSPOT_PORTAL_ID ?? "143641967";

  return <>
    <Link className="back-link" href={from === "pilot" ? `/studio/sav/pilote?batch=${encodeURIComponent(batch || detail.pilotItem?.batchId || "")}#batch-review` : "/studio/sav"}><ArrowLeft size={14}/> {from === "pilot" ? "Retour au lot de test" : "Retour à tous les mails"}</Link>
    <div className="sav-thread-heading"><div><span className="eyebrow">Dossier SAV</span><h1>{detail.thread.subject}</h1><p>{detail.thread.customerEmail} · {detail.thread.hubspotTicketId ? `Ticket HubSpot #${detail.thread.hubspotTicketId}` : "Aucun ticket associé"}</p></div><span className={`sav-thread-status ${detail.thread.status}`}>{detail.thread.aiPaused ? <UserRound size={15}/> : <Bot size={15}/>} {detail.thread.status.replaceAll("_", " ")}</span></div>

    <section className="sav-thread-grid">
      <div className="sav-conversation">
        <div className="section-heading"><div><span className="eyebrow">Conversation</span><h2>Messages échangés</h2></div></div>
        {detail.messages.map((message) => <article className={`sav-message ${message.direction}`} key={message.id}>
          <header><strong>{message.direction === "inbound" ? message.fromEmail : "Charly · IA"}</strong><time>{new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(message.receivedAt)}</time></header>
          <pre>{message.body.text}</pre>
          {message.direction === "outbound" && <span className="ai-authorship"><Bot size={13}/> Réponse générée par l’IA avec option humaine</span>}
        </article>)}

        {notes.map((note) => <article className="sav-note card" key={note.id}><header><div><span className="eyebrow">Note interne IA</span><h2>Résumé proposé pour HubSpot</h2></div><span className={`status ${note.status}`}>{detail.pilotItem && note.status === "pending" ? "Simulation · non ajoutée" : note.status === "succeeded" ? "Ajoutée au ticket" : note.status === "failed" ? "Échec d’ajout" : "En attente"}</span></header><pre>{note.noteText}</pre></article>)}

        {drafts.map((draft) => <article className="sav-draft card" key={draft.id}><header><div><span className="eyebrow">Brouillon IA</span><h2>Réponse prête à relire</h2></div><span>{detail.pilotItem ? "Pilote · envoi bloqué" : "Jamais envoyée sans trace"}</span></header><pre>{draft.draftText}</pre>{detail.pilotItem ? <p className="pilot-send-lock"><LockKeyhole size={15}/> Pendant le pilote, ce brouillon ne peut pas être envoyé depuis le Studio.</p> : <form action={approveDraftAction}><input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="draftActionId" value={draft.id}/><button className="primary" type="submit">Approuver et mettre en file d’envoi</button></form>}</article>)}

        {detail.pilotItem && <section className="pilot-review card" aria-labelledby="pilot-review-title">
          <div><span className="eyebrow">Revue humaine du batch</span><h2 id="pilot-review-title">Évaluer le travail de Charly</h2><p>Votre verdict nourrit le rapport du batch. La réponse et la résolution restent sous contrôle humain.</p></div>
          {detail.pilotItem.status === "error" ? <p className="pilot-review-error"><CircleAlert size={16}/> L’analyse a échoué : {detail.pilotItem.errorCode}</p> : ["pending", "processing"].includes(detail.pilotItem.status) ? <p className="pilot-review-error"><Clock3 size={16}/> L’analyse de ce mail est en cours. La revue s’ouvrira dès que le brouillon et les actions seront prêts.</p> : <form action={reviewPilotItemAction}>
            <input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="pilotItemId" value={detail.pilotItem.id}/>
            {from === "pilot" && <><input type="hidden" name="returnTo" value="pilot"/><input type="hidden" name="pilotBatchId" value={batch || detail.pilotItem.batchId}/></>}
            <fieldset><legend>Verdict</legend><div className="pilot-verdicts">
              {[["correct", "Correct"], ["partial", "Partiel"], ["incorrect", "Incorrect"], ["critical", "Erreur critique"]].map(([value, label]) => <label key={value}><input type="radio" name="verdict" value={value} defaultChecked={detail.pilotItem?.verdict === value || (!detail.pilotItem?.verdict && value === "correct")}/><span>{label}</span></label>)}
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

      <aside className="sav-audit-rail">
        <section className="card sav-decision-card"><span className="eyebrow">Décision actuelle</span><h2>{currentDecision?.kind.replaceAll("_", " ") ?? "Non justifiée"}</h2><p>{currentDecision?.explanation ?? "Aucune décision n’a encore été enregistrée."}</p>{currentDecision && <div className="confidence"><span style={{ width: `${currentDecision.confidence / 10}%` }}/><small>{Math.round(currentDecision.confidence / 10)} % de confiance</small></div>}
          {detail.pilotItem ? <p className="pilot-send-lock"><LockKeyhole size={15}/> Simulation stricte : aucune action Gmail ou HubSpot ne peut être exécutée depuis ce dossier.</p> : <>{!detail.thread.hubspotTicketId && <form action={createTicketAction}><input type="hidden" name="threadId" value={detail.thread.id}/><button className="secondary" type="submit">Créer le ticket HubSpot</button></form>}{!detail.thread.aiPaused && <form action={requestHumanAction}><input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="reason" value="Reprise demandée depuis le registre SAV"/><button className="ghost-danger" type="submit">Transférer à un humain</button></form>}</>}
          {detail.thread.humanDueAt && <p className="human-deadline"><Clock3 size={15}/> Réponse humaine attendue avant le {new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(detail.thread.humanDueAt)}</p>}
        </section>

        {currentDecision && <details className="card sav-correction"><summary>Corriger cette décision</summary><form action={correctDecisionAction}><input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="decisionId" value={currentDecision.id}/><label>Décision<select name="kind" defaultValue={currentDecision.kind === "ticket_pending" ? "human_review_required" : currentDecision.kind}><option value="ticket_created">Ticket créé</option><option value="attached_to_existing_ticket">Ticket existant</option><option value="no_ticket_needed">Aucun ticket nécessaire</option><option value="spam">Spam</option><option value="internal_notification">Notification interne</option><option value="automatic_reply">Réponse automatique</option><option value="bounce">Échec de remise</option><option value="duplicate">Doublon</option><option value="human_review_required">Humain requis</option></select></label><label>Code du motif<input name="reasonCode" defaultValue={currentDecision.reasonCode}/></label><label>Justification<textarea name="explanation" defaultValue={currentDecision.explanation}/></label><button className="primary" type="submit">Enregistrer la correction</button></form></details>}

        <section className="card sav-agent-runs"><span className="eyebrow">Traçabilité du harness</span><h2>Exécutions de l’agent</h2>{detail.agentRuns.length === 0 ? <p>Aucune exécution enregistrée pour les anciens messages.</p> : <ol>{[...detail.agentRuns].reverse().map((run) => <li key={run.id}><details><summary><span><Bot size={14}/>{run.runtime === "google_adk" ? "Google ADK" : run.runtime.replaceAll("_", " ")}</span><em className={`run-status ${run.status}`}>{run.status}</em></summary><div className="agent-run-detail"><dl><div><dt>Mode</dt><dd>{run.mode}</dd></div><div><dt>Modèle</dt><dd>{run.model}</dd></div><div><dt>Prompt</dt><dd>{run.promptRevision}</dd></div><div><dt>Durée</dt><dd>{run.durationMs} ms</dd></div></dl>{run.errorCode && <code>{run.errorCode}</code>}{run.fallbackRuntime && <p>Repli de sécurité : {run.fallbackRuntime}</p>}<div><strong>Sources retenues</strong>{run.evidence.length ? <ul>{run.evidence.map((source) => <li key={`${run.id}:${source.sourceType}:${source.sourceId}`}>{source.sourceType} · {source.title}</li>)}</ul> : <small>Aucune source retenue.</small>}</div><div><strong>Outils appelés</strong>{run.toolTrace.length ? <ul>{run.toolTrace.map((tool) => <li key={`${run.id}:${tool.sequence}`}>{tool.name} · {tool.status} · {tool.durationMs} ms</li>)}</ul> : <small>Aucun outil appelé.</small>}</div></div></details></li>)}</ol>}</section>

        <section className="card sav-timeline"><span className="eyebrow">Journal d’actions</span><ol>{detail.actions.map((action) => { const simulated = Boolean(detail.pilotItem && pilotExternalActions.has(action.kind)); return <li key={action.id}><span className={`action-icon ${action.status}`}>{action.status === "succeeded" ? <CheckCircle2 size={14}/> : action.status === "failed" ? <CircleAlert size={14}/> : <Clock3 size={14}/>}</span><div><strong>{action.kind.replaceAll("_", " ")}</strong><small>{simulated && action.status === "pending" ? "Simulation · non exécutée" : simulated && action.status === "succeeded" ? "Exécutée · incident du pilote précédent" : action.actorType === "human" ? action.actorEmail : "Charly / système"} · {new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(action.createdAt)}</small>{action.errorCode && <code>{action.errorCode}</code>}{action.status === "failed" && !detail.pilotItem && <form action={retryAction}><input type="hidden" name="threadId" value={detail.thread.id}/><input type="hidden" name="actionId" value={action.id}/><button className="button small secondary" type="submit">Réessayer</button></form>}</div></li>; })}</ol></section>
        {detail.thread.hubspotTicketId && <a className="button secondary sav-hubspot-link" href={`https://app.hubspot.com/contacts/${hubspotPortalId}/ticket/${detail.thread.hubspotTicketId}`} target="_blank" rel="noreferrer">Ouvrir dans HubSpot <ExternalLink size={14}/></a>}
      </aside>
    </section>
  </>;
}
