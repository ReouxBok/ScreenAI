import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Bot, CheckCircle2, Clock3, FlaskConical, Inbox, TicketCheck, UserRoundCheck } from "lucide-react";
import { isDatabaseConfigured } from "@/db";
import { requireStaff } from "@/lib/auth";
import { savAutomationMode, savGeminiApiKey, savHarnessMode } from "@/lib/sav/config";
import { getHubspotBackfillState, HUBSPOT_EMAIL_READ_SCOPE, isHubspotEmailReadScopeError } from "@/lib/sav/hubspot";
import { getSavDashboard, getSavImprovementSignals, listSavActionIncidents, listSavAgentPerformance, listSavInbox, listSavPilotBatches, listSavWebhookIncidents } from "@/lib/sav/service";
import { retryAction, retryWebhookAction } from "./actions";

export const dynamic = "force-dynamic";

const decisionLabels: Record<string, string> = {
  ticket_pending: "Ticket à traiter",
  ticket_created: "Ticket créé",
  attached_to_existing_ticket: "Ticket existant",
  no_ticket_needed: "Sans ticket",
  spam: "Spam",
  internal_notification: "Notification interne",
  automatic_reply: "Réponse automatique",
  bounce: "Échec de remise",
  duplicate: "Doublon",
  human_review_required: "Humain requis",
};

const modeLabels = { shadow: "Observation", assist: "Assisté", semi: "Semi-autonome", on: "Autonome contrôlé" } as const;
const feedbackLabels: Record<string, string> = {
  wrong_classification: "Mauvaise classification",
  wrong_ticket_decision: "Mauvaise décision de ticket",
  wrong_ticket_link: "Mauvais rattachement HubSpot",
  wrong_priority: "Priorité incorrecte",
  unsupported_claim: "Affirmation non étayée",
  wrong_tone: "Ton à corriger",
  missing_information: "Information manquante",
  unsafe_action: "Action dangereuse",
  good_without_change: "Bonne réponse sans changement",
};

export default async function SavDashboardPage({ searchParams }: { searchParams: Promise<{ view?: string; q?: string; batch?: string; batchCancelled?: string; launch?: string }> }) {
  await requireStaff("admin");
  const configured = isDatabaseConfigured();
  const [{ view = "all", q = "", batch = "", batchCancelled = "", launch = "" }, dashboard, inbox, incidents, actionIncidents, pilotBatches, agentPerformance, improvementSignals, hubspotBackfill] = await Promise.all([
    searchParams,
    configured ? getSavDashboard() : Promise.resolve({ total: 0, withoutDecision: 0, tickets: 0, human: 0, closedNoAction: 0, pilotQueued: 0, pendingLearning: 0, failedActions: 0, degradedRuns: 0, gmailPending: 0, gmailFailed: 0, gmailQuarantined: 0 }),
    configured ? listSavInbox(250) : Promise.resolve([]),
    configured ? listSavWebhookIncidents() : Promise.resolve([]),
    configured ? listSavActionIncidents() : Promise.resolve([]),
    configured ? listSavPilotBatches() : Promise.resolve([]),
    configured ? listSavAgentPerformance() : Promise.resolve([]),
    configured ? getSavImprovementSignals() : Promise.resolve({ reviewed: 0, correct: 0, partial: 0, incorrect: 0, critical: 0, correctedDrafts: 0, feedback: [] }),
    configured ? getHubspotBackfillState() : Promise.resolve(null),
  ]);
  const normalizedQuery = q.trim().toLocaleLowerCase("fr");
  const rows = inbox.filter((row) => {
    if (batch && row.pilotBatchId !== batch) return false;
    if (normalizedQuery && !`${row.fromEmail} ${row.subject} ${row.preview}`.toLocaleLowerCase("fr").includes(normalizedQuery)) return false;
    if (view === "tickets") return ["ticket_pending", "ticket_created", "attached_to_existing_ticket"].includes(row.decisionKind ?? "");
    if (view === "human") return row.threadStatus === "human_requested" || row.threadStatus === "human_processing";
    if (view === "no-ticket") return row.threadStatus === "closed_no_action";
    if (view === "unjustified") return !row.decisionId;
    return true;
  });
  const mode = savAutomationMode();
  const harnessMode = savHarnessMode();
  const harnessReady = Boolean(savGeminiApiKey());
  const activePilotBatch = pilotBatches.find((item) => item.status === "processing" || item.status === "reviewing");
  const selectedPilotBatch = batch ? pilotBatches.find((item) => item.id === batch) : null;
  const selectedPilotBatchIndex = selectedPilotBatch ? pilotBatches.findIndex((item) => item.id === selectedPilotBatch.id) : -1;
  const selectedPilotBatchNumber = selectedPilotBatchIndex >= 0 ? pilotBatches.length - selectedPilotBatchIndex : null;
  const hubspotLearningBlocked = hubspotBackfill?.status === "blocked" && isHubspotEmailReadScopeError(hubspotBackfill.lastError);

  return <>
    <section className="sav-hero">
      <div className="sav-hero-copy"><span className="eyebrow">Registre SAV</span><h1>Chaque mail laisse une trace.</h1><p>Charly qualifie, justifie et simule les actions. Pendant le pilote, aucune donnée n’est écrite dans Gmail ou HubSpot.</p></div>
      <div className="sav-mode-panel"><span>Mode actuel</span><strong>{modeLabels[mode]}</strong><small>{mode === "shadow" ? "Aucun envoi ni ticket automatique" : mode === "assist" ? "Les actions attendent une validation" : "Automatisation surveillée"}</small><small>Harness ADK : {harnessMode} · {harnessReady ? "clé Gemini SAV connectée" : "clé Gemini requise"}</small><i className={`sav-mode-light ${mode}`}/></div>
    </section>

    {!configured && <div className="setup card"><strong>Base SAV non configurée.</strong> Ajoutez les variables SAV, puis appliquez les migrations avant de connecter Gmail.</div>}
    {batchCancelled && <p className="login-notice" role="status">Le batch invalide a été conservé dans l’audit puis annulé. Les dix prochains mails peuvent maintenant être analysés.</p>}
    {launch === "instant" && <p className="login-notice" role="status">L’analyse des 10 mails a démarré immédiatement. Cette page affiche la progression automatiquement.</p>}
    {launch === "deferred" && <p className="login-notice error" role="alert">Le lancement immédiat n’a pas répondu. Le batch est conservé et sera repris automatiquement par le cron de sécurité.</p>}
    {hubspotLearningBlocked && <section className="sav-integration-warning card" role="alert">
      <AlertTriangle size={20}/><div><strong>Historique HubSpot en attente d’autorisation</strong><p>Les mails entrants et les tickets pilotes continuent de fonctionner. Pour analyser les anciens échanges et générer les fiches de résolution, ajoutez la permission <code>{HUBSPOT_EMAIL_READ_SCOPE}</code> à la clé de service HubSpot.</p></div><Link href="/studio/sav/resolutions">Vérifier l’accès <ArrowUpRight size={14}/></Link>
    </section>}

    <section className="sav-stats" aria-label="Indicateurs SAV">
      <article><Inbox size={18}/><span>Reçus</span><strong>{dashboard.total}</strong></article>
      <article><TicketCheck size={18}/><span>Avec ticket</span><strong>{dashboard.tickets}</strong></article>
      <article><UserRoundCheck size={18}/><span>Reprise humaine</span><strong>{dashboard.human}</strong></article>
      <article className={dashboard.withoutDecision ? "needs-attention" : ""}><AlertTriangle size={18}/><span>Sans justification</span><strong>{dashboard.withoutDecision}</strong></article>
      <article className={incidents.length || dashboard.failedActions || dashboard.degradedRuns ? "needs-attention" : ""}><AlertTriangle size={18}/><span>Incidents techniques</span><strong>{incidents.length + dashboard.failedActions + dashboard.degradedRuns}</strong></article>
      <article className={dashboard.gmailPending ? "needs-attention" : ""}><Clock3 size={18}/><span>Gmail en attente</span><strong>{dashboard.gmailPending}</strong></article>
      <article className={dashboard.gmailFailed ? "needs-attention" : ""}><AlertTriangle size={18}/><span>Gmail en échec</span><strong>{dashboard.gmailFailed}</strong></article>
      <article className={dashboard.gmailQuarantined ? "needs-attention" : ""}><AlertTriangle size={18}/><span>Gmail en quarantaine</span><strong>{dashboard.gmailQuarantined}</strong></article>
    </section>

    <section className={`sav-lab-entry card ${activePilotBatch?.externalWrites ? "has-incident" : ""}`} aria-labelledby="pilot-entry-title">
      <div className="sav-lab-entry-icon"><FlaskConical size={24}/></div>
      <div><span className="eyebrow">Pilote supervisé</span><h2 id="pilot-entry-title">Tester Charly sur 10 mails isolés</h2><p>Choisissez vous-même les dix messages, observez les décisions et brouillons simulés, puis relisez chaque résultat dans un parcours dédié.</p></div>
      <div className="sav-lab-entry-action"><span className="pilot-lock active"><CheckCircle2 size={15}/> Simulation stricte</span><Link className="button primary" href="/studio/sav/pilote">{activePilotBatch ? "Continuer le test en cours" : "Préparer un lot de 10 mails"}<ArrowUpRight size={15}/></Link>{activePilotBatch && <small>{activePilotBatch.externalWrites ? "Un ancien lot non conforme doit être annulé." : `${activePilotBatch.reviewed}/${activePilotBatch.total} mails relus`}</small>}</div>
    </section>

    {agentPerformance.length > 0 && <section className="sav-performance card" aria-labelledby="sav-performance-title">
      <div><span className="eyebrow">Amélioration continue</span><h2 id="sav-performance-title">Qualité par version du harness</h2><p>Les corrections humaines restent rattachées au modèle et au prompt exacts qui ont produit la proposition. Une nouvelle version ne peut pas hériter du score d’une ancienne.</p></div>
      <div className="sav-performance-table" role="table" aria-label="Performance des versions SAV">
        <div role="row" className="sav-performance-head"><span>Version</span><span>Exécutions</span><span>Revues</span><span>Conformité</span><span>Dégradé</span><span>Latence</span></div>
        {agentPerformance.slice(0, 12).map((item) => <div role="row" key={`${item.runtime}:${item.mode}:${item.model}:${item.promptRevision}`}>
          <span><strong>{item.promptRevision}</strong><small>{item.runtime.replaceAll("_", " ")} · {item.model} · {item.mode}</small></span>
          <span>{item.runs}</span><span>{item.reviewed}</span><span>{item.acceptanceRate === null ? "—" : `${item.acceptanceRate}%`}</span>
          <span className={item.degraded ? "needs-attention" : ""}>{item.degraded} ({item.degradedRate}%)</span><span>{(item.averageDurationMs / 1_000).toFixed(1)} s</span>
        </div>)}
      </div>
    </section>}

    <section className="sav-improvement card" aria-labelledby="sav-improvement-title">
      <div><span className="eyebrow">Boucle d’amélioration</span><h2 id="sav-improvement-title">Les corrections humaines deviennent des signaux mesurables.</h2><p>Chaque verdict alimente la qualité par version. Une réponse corrigée peut ensuite devenir une fiche SAV, mais seulement après relecture, validation, publication et activation pour l’IA.</p></div>
      <div className="sav-improvement-stats"><span><strong>{improvementSignals.reviewed}</strong> revues</span><span><strong>{improvementSignals.correctedDrafts}</strong> corrections rédigées</span><span className={improvementSignals.critical ? "needs-attention" : ""}><strong>{improvementSignals.critical}</strong> critiques</span></div>
      <ol>{improvementSignals.feedback.slice(0, 6).map((signal) => <li key={signal.code}><span>{feedbackLabels[signal.code] ?? signal.code.replaceAll("_", " ")}</span><strong>{signal.count}</strong>{signal.critical > 0 && <em>{signal.critical} critique{signal.critical > 1 ? "s" : ""}</em>}</li>)}</ol>
      {!improvementSignals.reviewed && <small>Commencez par relire les 10 éléments du batch actif : aucune montée en autonomie n’est possible sans ces verdicts.</small>}
    </section>

    <nav className="sav-tabs" aria-label="Vues SAV">
      <Link className={view === "all" ? "active" : ""} href="/studio/sav">Tous les mails</Link>
      <Link className={view === "tickets" ? "active" : ""} href="/studio/sav?view=tickets">Tickets</Link>
      <Link className={view === "human" ? "active" : ""} href="/studio/sav?view=human">Humain requis</Link>
      <Link className={view === "no-ticket" ? "active" : ""} href="/studio/sav?view=no-ticket">Sans ticket</Link>
      <Link className={view === "unjustified" ? "active" : ""} href="/studio/sav?view=unjustified">Sans justification</Link>
      <Link href="/studio/sav/resolutions">Fiches de résolution <span>{dashboard.pendingLearning}</span></Link>
    </nav>

    <form className="sav-search" method="get"><input type="hidden" name="view" value={view}/><label htmlFor="sav-q">Rechercher dans les mails</label><div><input id="sav-q" name="q" defaultValue={q} placeholder="Expéditeur, objet ou extrait…"/><button type="submit">Rechercher</button></div></form>

    {selectedPilotBatch && <section className="batch-review-heading" id="batch-review">
      <div><span className="eyebrow">Batch {selectedPilotBatchNumber}</span><h2>Relire les {selectedPilotBatch.total} propositions</h2><p>Ouvrez un mail pour voir la décision, le brouillon et les actions simulées, puis enregistrez votre verdict.</p></div>
      <Link className="button secondary" href="/studio/sav">Quitter la revue</Link>
    </section>}

    <section className="decision-ledger" aria-label={selectedPilotBatch ? `Mails du batch ${selectedPilotBatchNumber}` : "Tous les mails reçus"}>
      <header><span>{rows.length} mail{rows.length > 1 ? "s" : ""}</span><span>Décision et justification</span><span>Action</span></header>
      {rows.map((row) => <Link className="decision-ledger-row" href={`/studio/sav/${row.threadId}`} key={row.messageId}>
        <span className="ledger-rail" aria-hidden="true"><i className={row.decisionKind === "human_review_required" ? "human" : row.decisionId ? "decided" : "missing"}/></span>
        <span className="ledger-mail"><small>{new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(row.receivedAt)}</small><strong>{row.subject}</strong><span>{row.fromEmail}</span><p>{row.preview || "Aucun aperçu disponible"}</p></span>
        <span className="ledger-decision"><em className={`sav-decision ${row.decisionKind ?? "missing"}`}>{row.decisionKind ? decisionLabels[row.decisionKind] : "Non justifié"}</em><strong>{row.explanation ?? "Ce mail attend encore une décision traçable."}</strong>{row.confidence !== null && <small>Confiance {Math.round(row.confidence / 10)} % · {row.actorType === "human" ? "corrigé par un humain" : "décidé par Charly"}</small>}</span>
        <span className="ledger-action">{row.pilotItemStatus === "pending" || row.pilotItemStatus === "processing" ? <><FlaskConical size={16}/><strong>Analyse batch</strong></> : row.pilotVerdict ? <><CheckCircle2 size={16}/><strong>{row.pilotVerdict}</strong></> : row.pilotItemStatus === "ready" ? <><Bot size={16}/><strong>Simulation prête</strong></> : row.hubspotTicketId ? <><TicketCheck size={16}/><strong>#{row.hubspotTicketId}</strong></> : row.aiPaused ? <><Clock3 size={16}/><strong>Équipe SAV</strong></> : <><Bot size={16}/><strong>En attente</strong></>}<ArrowUpRight size={15}/></span>
      </Link>)}
      {!rows.length && <div className="empty sav-empty"><Inbox size={24}/><strong>Aucun mail dans cette vue</strong><span>Les notifications Gmail apparaîtront ici avec leur justification.</span></div>}
    </section>

    {incidents.length > 0 && <section className="sav-incidents card" aria-labelledby="sav-incidents-title">
      <div><span className="eyebrow">À reprendre</span><h2 id="sav-incidents-title">Notifications non traitées</h2><p>Ces événements restent visibles et n’ont pas été perdus. Relancez-les après avoir corrigé la configuration ou l’incident externe.</p></div>
      <ol>{incidents.map((incident) => <li key={incident.id}>
        <div><strong>{incident.provider === "gmail" ? "Gmail" : "HubSpot"}</strong><span>{incident.errorCode || "Erreur technique"} · {incident.attempts} tentative{incident.attempts > 1 ? "s" : ""}</span></div>
        <form action={retryWebhookAction}><input type="hidden" name="receiptId" value={incident.id}/><button className="secondary" type="submit">Relancer</button></form>
      </li>)}</ol>
    </section>}

    {actionIncidents.length > 0 && <section className="sav-incidents card" aria-labelledby="sav-actions-incidents-title">
      <div><span className="eyebrow">Actions externes</span><h2 id="sav-actions-incidents-title">Actions Gmail ou HubSpot en échec</h2><p>L’erreur exacte reste visible. Une relance reprend la même action idempotente, sans créer volontairement de doublon.</p></div>
      <ol>{actionIncidents.map((incident) => <li key={incident.id}>
        <div><strong>{incident.kind} · {incident.subject}</strong><span>{incident.errorCode || "Erreur technique"}</span></div>
        <form action={retryAction}><input type="hidden" name="actionId" value={incident.id}/><input type="hidden" name="threadId" value={incident.threadId}/><button className="secondary" type="submit">Relancer</button></form>
      </li>)}</ol>
    </section>}
  </>;
}
