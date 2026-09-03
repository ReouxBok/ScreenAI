import Link from "next/link";
import { AlertTriangle, ArrowLeft, ArrowUpRight, Bot, Check, CheckCircle2, Clock3, FileText, LockKeyhole, MessageSquareText, NotebookPen, TicketCheck, UserRoundCheck, XCircle } from "lucide-react";
import { isDatabaseConfigured } from "@/db";
import { requireStaff } from "@/lib/auth";
import { isSavPilotMode, savGeminiApiKey } from "@/lib/sav/config";
import { listSavPilotBatchItems, listSavPilotBatches, listSavPilotCandidates } from "@/lib/sav/service";
import { cancelPilotBatchLabAction } from "../actions";
import { SavLiveRefresh } from "../live-refresh";
import { PilotCandidateSelector } from "./candidate-selector";

export const dynamic = "force-dynamic";

const decisionLabels: Record<string, string> = {
  ticket_pending: "Créer un ticket",
  ticket_created: "Ticket nécessaire",
  attached_to_existing_ticket: "Rattacher au ticket existant",
  no_ticket_needed: "Ne pas créer de ticket",
  spam: "Classer comme spam",
  internal_notification: "Notification interne",
  automatic_reply: "Réponse automatique",
  bounce: "Échec de remise",
  duplicate: "Doublon",
  human_review_required: "Transmettre à un humain",
};

const errorMessages: Record<string, string> = {
  select_10: "Choisissez exactement 10 mails avant de lancer la simulation.",
  selection_stale: "Un mail sélectionné a déjà été pris dans un autre lot. La liste a été actualisée : choisissez à nouveau 10 mails.",
  start_failed: "Le lot n’a pas pu être créé. Vérifiez la configuration puis réessayez.",
};

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(value);
}

export default async function SavPilotLabPage({ searchParams }: { searchParams: Promise<{ batch?: string; launch?: string; error?: string; batchCancelled?: string }> }) {
  await requireStaff("admin");
  const { batch = "", launch = "", error = "", batchCancelled = "" } = await searchParams;
  const configured = isDatabaseConfigured();
  const [candidates, batches] = configured
    ? await Promise.all([listSavPilotCandidates(80), listSavPilotBatches(30)])
    : [[], []];
  const activeBatch = batches.find((item) => item.status === "processing" || item.status === "reviewing");
  const requestedBatch = batch ? batches.find((item) => item.id === batch) : undefined;
  const focusBatch = activeBatch ?? requestedBatch;
  const items = focusBatch ? await listSavPilotBatchItems(focusBatch.id) : [];
  const processing = focusBatch?.status === "processing";
  const invalidActiveBatch = Boolean(activeBatch?.externalWrites);
  const stage = invalidActiveBatch ? 1 : focusBatch?.status === "processing" ? 2 : focusBatch?.status === "reviewing" ? 3 : focusBatch ? 4 : 1;
  const canSelect = !activeBatch && !focusBatch;
  const pilotReady = isSavPilotMode();
  const modelReady = Boolean(savGeminiApiKey());
  const canLaunch = configured && pilotReady && modelReady && candidates.length >= 10;
  const reviewedItems = items.filter((item) => item.status === "reviewed").length;
  const safeFocusBatch = focusBatch && focusBatch.externalWrites === 0;

  return <div className="sav-lab-page">
    <SavLiveRefresh enabled={Boolean(processing)}/>
    <Link className="back-link" href="/studio/sav"><ArrowLeft size={14}/> Retour au registre SAV</Link>

    <header className="sav-lab-hero">
      <div><span className="eyebrow">Laboratoire SAV</span><h1>Un lot. Dix mails. Zéro action externe.</h1><p>Vous choisissez les cas, Charly simule ce qu’il aurait fait, puis vous contrôlez chaque proposition avant d’obtenir un rapport.</p></div>
      <div className="sav-lab-safety"><LockKeyhole size={20}/><span>Garde-fou actif</span><strong>Gmail et HubSpot en lecture seule</strong><small>Aucun envoi, ticket, note ou changement de statut pendant ce test.</small></div>
    </header>

    <ol className="sav-lab-steps" aria-label="Étapes du test">
      {["Sélection", "Analyse", "Revue", "Rapport"].map((label, index) => {
        const number = index + 1;
        return <li className={number === stage ? "current" : number < stage ? "done" : ""} key={label}><span>{number < stage ? <Check size={15}/> : number}</span><div><strong>{label}</strong><small>{number === 1 ? "Choisir 10 mails" : number === 2 ? "Simulation IA" : number === 3 ? "Valider un par un" : "Mesurer la qualité"}</small></div></li>;
      })}
    </ol>

    {errorMessages[error] && <div className="sav-lab-alert error" role="alert"><XCircle size={18}/><span>{errorMessages[error]}</span></div>}
    {batchCancelled && <div className="sav-lab-alert success" role="status"><CheckCircle2 size={18}/><span>Le lot a été annulé et conservé dans l’audit. Vous pouvez préparer un nouveau test.</span></div>}
    {launch === "instant" && <div className="sav-lab-alert success" role="status"><Bot size={18}/><span>Le lot est créé. L’analyse des 10 mails a démarré immédiatement.</span></div>}
    {launch === "deferred" && <div className="sav-lab-alert error" role="alert"><AlertTriangle size={18}/><span>Le lancement immédiat n’a pas répondu. Le lot est conservé et le mécanisme de reprise va relancer l’analyse.</span></div>}

    {activeBatch && invalidActiveBatch && <section className="sav-lab-incident card" role="alert">
      <AlertTriangle size={24}/>
      <div><span className="eyebrow">Ancien lot non conforme</span><h2>Ce lot ne peut pas servir au test.</h2><p>{activeBatch.externalWrites} écriture{activeBatch.externalWrites > 1 ? "s" : ""} HubSpot issue{activeBatch.externalWrites > 1 ? "s" : ""} de l’ancienne version ont été détectées. Les preuves restent conservées, mais le lot doit être annulé avant de repartir en simulation stricte.</p></div>
      <form action={cancelPilotBatchLabAction}><input type="hidden" name="pilotBatchId" value={activeBatch.id}/><input type="hidden" name="reason" value="Lot historique non conforme avec écritures externes"/><button className="danger" type="submit">Annuler ce lot et repartir</button></form>
    </section>}

    {focusBatch && !invalidActiveBatch && processing && <section className="sav-lab-batch card">
      <header><div><span className="eyebrow">Étape 2 · Analyse</span><h2>Charly traite les 10 mails sélectionnés.</h2><p>La page s’actualise automatiquement. Les propositions sont enregistrées dans le Studio uniquement.</p></div><span className="pilot-working"><Clock3 size={16}/> Analyse en cours</span></header>
      <div className="pilot-progress"><div>{Array.from({ length: focusBatch.total }, (_, index) => <i className={index < focusBatch.ready ? "ready" : ""} key={index}/>)}</div><span><strong>{focusBatch.ready}</strong>/{focusBatch.total} prêts</span></div>
      <div className="sav-lab-processing-list">{items.map((item, index) => <article key={item.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.subject}</strong><small>{item.fromEmail}</small></div><em className={item.status}>{item.status === "ready" ? "Prêt" : item.status === "error" ? "Erreur" : item.status === "processing" ? "En analyse" : "En attente"}</em></article>)}</div>
      <form action={cancelPilotBatchLabAction}><input type="hidden" name="pilotBatchId" value={focusBatch.id}/><input type="hidden" name="reason" value="Lot annulé manuellement pendant l’analyse"/><button className="ghost-danger" type="submit">Annuler ce test</button></form>
    </section>}

    {safeFocusBatch && focusBatch.status === "reviewing" && <section className="sav-lab-batch card" id="batch-review">
      <header><div><span className="eyebrow">Étape 3 · Revue</span><h2>Contrôlez les 10 propositions.</h2><p>Ouvrez chaque mail, comparez la décision et le brouillon, puis donnez votre verdict. Les actions ci-dessous restent des simulations.</p></div><div className="sav-lab-review-count"><strong>{reviewedItems}/10</strong><span>mails relus</span></div></header>
      <div className="pilot-progress"><div>{Array.from({ length: focusBatch.total }, (_, index) => <i className={index < focusBatch.reviewed ? "reviewed" : index < focusBatch.ready ? "ready" : ""} key={index}/>)}</div><span><strong>{focusBatch.reviewed}</strong>/{focusBatch.total} relus</span></div>
      <div className="sav-lab-review-list">{items.map((item, index) => <article className={item.status === "reviewed" ? "reviewed" : ""} key={item.id}>
        <div className="sav-lab-review-index">{item.status === "reviewed" ? <Check size={16}/> : String(index + 1).padStart(2, "0")}</div>
        <div className="sav-lab-review-mail"><small>{formatDate(item.receivedAt)} · {item.fromEmail}</small><strong>{item.subject}</strong><p>{item.preview || "Aucun aperçu disponible"}</p></div>
        <div className="sav-lab-review-decision"><span>{decisionLabels[item.decisionKind ?? ""] ?? "Analyse à vérifier"}</span><p>{item.explanation ?? (item.errorCode ? `Erreur : ${item.errorCode}` : "Justification en attente")}</p>{item.confidence !== null && <small>Confiance {Math.round(item.confidence / 10)} %</small>}</div>
        <div className="sav-lab-action-chips" aria-label="Actions proposées">
          {item.ticketProposed && <span><TicketCheck size={13}/> Ticket</span>}
          {item.draftPrepared && <span><MessageSquareText size={13}/> Réponse</span>}
          {item.noteProposed && <span><NotebookPen size={13}/> Note</span>}
          {item.humanProposed && <span><UserRoundCheck size={13}/> Humain</span>}
          {!item.ticketProposed && !item.draftPrepared && !item.noteProposed && !item.humanProposed && <span><FileText size={13}/> Aucune action</span>}
        </div>
        <Link className="button secondary" href={`/studio/sav/${item.threadId}?from=pilot&batch=${focusBatch.id}`}>{item.status === "reviewed" ? "Voir la revue" : "Relire ce mail"}<ArrowUpRight size={14}/></Link>
      </article>)}</div>
      <form action={cancelPilotBatchLabAction}><input type="hidden" name="pilotBatchId" value={focusBatch.id}/><input type="hidden" name="reason" value="Lot annulé manuellement pendant la revue"/><button className="ghost-danger" type="submit">Annuler ce test</button></form>
    </section>}

    {focusBatch && ["completed", "cancelled"].includes(focusBatch.status) && <section className="sav-lab-report card">
      <div><span className="eyebrow">Étape 4 · Rapport</span><h2>{focusBatch.status === "completed" ? "Le lot est entièrement relu." : "Ce lot a été annulé."}</h2><p>{focusBatch.status === "completed" ? "Voici la qualité mesurée sur ces 10 mails. Les résultats restent rattachés à cette version du harness." : "Les traces sont conservées pour l’audit, mais ce lot ne compte pas dans la validation."}</p></div>
      <div className="sav-lab-report-score"><strong>{focusBatch.acceptanceRate ?? 0}%</strong><span>de conformité pondérée</span></div>
      <dl><div><dt>Corrects</dt><dd>{focusBatch.correct}</dd></div><div><dt>Partiels</dt><dd>{focusBatch.partial}</dd></div><div><dt>Incorrects</dt><dd>{focusBatch.incorrect}</dd></div><div className={focusBatch.critical ? "critical" : ""}><dt>Critiques</dt><dd>{focusBatch.critical}</dd></div></dl>
      {!activeBatch && <Link className="button primary" href="/studio/sav/pilote">Préparer un nouveau lot de 10 mails</Link>}
    </section>}

    {canSelect && <section className="sav-lab-selection">
      <PilotCandidateSelector candidates={candidates.map((candidate) => ({ ...candidate, receivedLabel: formatDate(candidate.receivedAt) }))} canLaunch={canLaunch} blockedReason={!configured ? "La base SAV n’est pas configurée." : !pilotReady ? "Le mode pilote doit être activé." : !modelReady ? "La clé Gemini SAV doit être connectée." : candidates.length < 10 ? `Il faut encore ${10 - candidates.length} mail${10 - candidates.length > 1 ? "s" : ""} éligible${10 - candidates.length > 1 ? "s" : ""}.` : ""}/>
    </section>}

    {batches.length > 0 && <details className="sav-lab-history card"><summary>Historique des lots <span>{batches.length}</span></summary><div>{batches.map((item, index) => <Link className={item.id === focusBatch?.id ? "active" : ""} href={`/studio/sav/pilote?batch=${item.id}`} key={item.id}><span>Lot {batches.length - index}</span><strong>{item.reviewed}/{item.total} relus</strong><small>{item.status === "completed" ? `${item.acceptanceRate ?? 0}% conformes` : item.status === "cancelled" ? "Annulé · audit conservé" : item.status === "processing" ? "Analyse en cours" : "Revue en cours"}</small>{item.externalWrites > 0 && <em>Incident historique</em>}</Link>)}</div></details>}
  </div>;
}
