import { formatParisDateTime } from "@/lib/paris-date";
import Link from "next/link";
import { ArrowLeft, BookOpenCheck, Gauge, History, ListChecks } from "lucide-react";
import { requireSavStaff as requireStaff } from "@/lib/sav/auth";
import { listLearningCandidates } from "@/lib/sav/learning";
import { savLearningAdmissionMetrics } from "@/lib/sav/learning-admission";
import { reviewLearningAction } from "../actions";

export const dynamic = "force-dynamic";

const reasonLabel: Record<string, string> = {
  comparison_started: "Comparaison démarrée", not_reusable: "Non réutilisable", insufficient_evidence: "Preuve insuffisante",
  conflict: "Preuve contradictoire", already_covered: "Déjà couvert", amendment: "Amélioration proposée", new: "Nouvelle procédure proposée",
  weekly_limit: "Plafond hebdomadaire atteint", open_limit: "File ouverte complète",
  comparison_error: "Erreur de comparaison", cycle_before_learning_cutover: "Cycle antérieur à la frontière", cutover_not_active: "Frontière non activée",
  evidence_before_learning_cutover: "Preuve antérieure à la frontière", comparison_context_changed: "Catalogue modifié pendant la comparaison",
  comparison_retryable: "Comparaison interrompue : reprise possible",
  comparison_context_incomplete: "Comparaison impossible : contexte incomplet", rejected_unchanged_proof: "Refus conservé : aucune preuve nouvelle",
  candidate_revision_required: "Nouvelle information : révision humaine de la proposition nécessaire", source_changed: "Preuve modifiée pendant la comparaison",
  no_new_resolution_cycle: "Aucun nouveau cycle de résolution prouvé", source_truncated: "Source tronquée : admission bloquée",
  human_resolution_proof_required: "Preuve de résolution humaine requise", grouped_existing_candidate: "Ajout à une proposition existante",
};

export default async function SavResolutionsPage({ searchParams }: { searchParams: Promise<{ review?: string }> }) {
  const staff = await requireStaff("admin");
  const [allCandidates, metrics, query] = await Promise.all([listLearningCandidates(), savLearningAdmissionMetrics(), searchParams]);
  const historical = allCandidates.filter((candidate) => candidate.historical);
  const candidates = allCandidates.filter((candidate) => !candidate.historical);
  const pendingCount = candidates.filter((candidate) => candidate.status === "pending").length;
  const reviewable = staff.email === "ugo@limova.ai";

  return <>
    <Link className="back-link" href="/studio/sav"><ArrowLeft size={14}/> Retour au registre SAV</Link>
    <div className="page-intro compact">
      <div>
        <span className="eyebrow">Apprentissage supervisé · V0</span>
        <h1>Propositions fondées sur des résolutions prouvées</h1>
        <p>Une clôture seule ne crée pas de connaissance. Une proposition doit comparer une preuve humaine exploitable au catalogue, puis passer la revue Ugo.</p>
      </div>
    </div>

    {query.review === "sync_in_progress" && <p className="login-notice" role="alert">Les preuves sont en cours d’actualisation. Attendez la fin de la synchronisation puis relisez le bilan.</p>}
    {query.review === "stale" && <p className="login-notice" role="alert">Les preuves ou la qualification ont changé. Relisez et qualifiez le bilan actuel avant de créer un brouillon.</p>}

    <section className="resolution-backfill card" aria-label="Frontière et capacité d’apprentissage">
      <div className="resolution-backfill-icon"><Gauge size={24}/></div>
      <div>
        <span className="eyebrow">Frontière d’apprentissage</span>
        <h2>{metrics.cutover ? "Flux postérieur à la frontière" : "Activation explicite requise"}</h2>
        <p>{metrics.cutover ? `Cycles de résolution commencés après le ${formatParisDateTime(new Date(metrics.cutover.activatedAt), { dateStyle: "medium" })} seulement.` : "Aucun ticket historique ne sera retraité. Le flux automatique reste fermé jusqu’à l’activation explicite du dispositif."}</p>
        <p>Analyse IA : {metrics.dailyModelCalls} appel{metrics.dailyModelCalls === 1 ? "" : "s"} aujourd’hui, sans plafond journalier et avec déduplication · Propositions : {metrics.openAutomaticProposals}/{metrics.openLimit} ouvertes · {metrics.signals.reduce((sum, entry) => sum + entry.count, 0)} signaux agrégés sur les 7 derniers jours.</p>
        <p className="subtle">Les signaux détaillés sont limités aux 100 plus récents et à 30 jours. Les preuves sources restent dans leurs dossiers privés.</p>
      </div>
      <div className="sav-learning-status pending">{metrics.weeklyLimit} nouvelles propositions / 7 jours glissants</div>
    </section>

    <section className="section-heading">
      <div><span className="eyebrow">Revue humaine</span><h2>{pendingCount} proposition{pendingCount > 1 ? "s" : ""} à examiner</h2></div>
    </section>

    <section className="learning-list">
      {candidates.map((candidate) => <article className="learning-card card" key={candidate.id}>
        <div className="learning-card-icon"><BookOpenCheck size={20}/></div>
        <div>
          <span className={`sav-learning-status ${candidate.status}`}>{candidate.status === "pending" ? "À relire" : candidate.status === "approved" ? "Brouillon interne créé" : "Écartée"}</span>
          <h3>{candidate.proposedSubject || "Résolution de ticket HubSpot"}</h3>
          <p>{candidate.explanation}</p>
          <details className="learning-preview"><summary>Voir la résolution proposée</summary><pre>{candidate.proposedResolution}</pre></details>
          <h4>Conditions</h4><ul>{candidate.proposedConditions?.length ? candidate.proposedConditions.map((condition: string, index: number) => <li key={index}>{condition}</li>) : <li>À compléter avant publication</li>}</ul>
          <h4>Résultat attendu</h4><p>{candidate.proposedExpectedResult || "À préciser"}</p>
          <h4>Limites</h4><ul>{candidate.proposedLimitations?.length ? candidate.proposedLimitations.map((limit: string, index: number) => <li key={index}>{limit}</li>) : <li>À qualifier pendant la revue</li>}</ul>
          <p><strong>{candidate.evidenceCaseCount} dossier{candidate.evidenceCaseCount === 1 ? "" : "s"} distinct{candidate.evidenceCaseCount === 1 ? "" : "s"}</strong> · jusqu’à 3 preuves représentatives : {candidate.evidenceTicketIds?.length ? candidate.evidenceTicketIds.map((id: string, index: number) => <a key={id} href={`https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID ?? "143641967"}/ticket/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">{index ? " · " : ""}Preuve {index + 1}</a>) : "références conservées dans le dossier"}</p>
          <small>{candidate.createdBy === "human" ? "Qualification humaine" : "Apprentissage automatique"} · {formatParisDateTime(candidate.createdAt, { dateStyle: "medium" })}</small>
          {candidate.syncInProgress && <p role="status">Actualisation des preuves en cours. Les actions de revue sont suspendues.</p>}
          {candidate.status === "pending" && reviewable && !candidate.syncInProgress && <p><Link className="button secondary" href={`/studio/sav/connaissances/proposer?learning=${candidate.id}`}>Préparer une connaissance ou un amendement</Link></p>}
          {candidate.contentItemId && <Link className="table-link" href={`/studio/contenus/${candidate.contentItemId}`}>Ouvrir la fiche interne →</Link>}
        </div>
        {candidate.status === "pending" && reviewable && <form action={reviewLearningAction} className="learning-actions">
          <input type="hidden" name="candidateId" value={candidate.id}/>
          <button className="primary" name="decision" value="approve" type="submit" disabled={candidate.syncInProgress}>Créer un brouillon interne</button>
          <button className="ghost-danger" name="decision" value="reject" type="submit" disabled={candidate.syncInProgress}>Écarter cette proposition</button>
        </form>}
      </article>)}
      {!candidates.length && <div className="empty card"><ListChecks size={20}/> Aucune proposition active. Une preuve insuffisante, un doublon ou un plafond atteint reste un signal, jamais une carte cachée à valider.</div>}
    </section>

    <details className="resolution-backfill card">
      <summary><History size={16}/> Stock historique conservé · {historical.length}</summary>
      <p className="subtle">Ces candidats antérieurs à la frontière restent consultables pour la traçabilité. Ils ne sont ni réanalysés ni admissibles à la validation de ce flux.</p>
      {historical.length ? <ul>{historical.map((candidate) => <li key={candidate.id}>{candidate.proposedSubject || "Proposition historique illisible"} · {candidate.status} · {formatParisDateTime(candidate.createdAt, { dateStyle: "medium" })}</li>)}</ul> : <p>Aucun candidat historique chargé.</p>}
    </details>

    <details className="resolution-backfill card">
      <summary>Journal borné des signaux · {metrics.recentSignals.length} / 100</summary>
      {metrics.recentSignals.length ? <ul>{metrics.recentSignals.map((signal) => <li key={signal.id}>
        {formatParisDateTime(signal.createdAt, { dateStyle: "short", timeStyle: "short" })} · {signal.origin} · {reasonLabel[signal.reasonCode] ?? signal.reasonCode} · {signal.state}
        {signal.candidateId && <> · <Link href={`/studio/sav/connaissances/proposer?learning=${signal.candidateId}`}>Examiner la proposition liée</Link></>}
        {signal.errorCode ? ` · ${signal.errorCode}` : ""}{signal.inputTokens || signal.outputTokens ? ` · ${signal.inputTokens ?? 0}/${signal.outputTokens ?? 0} tokens` : ""}{signal.durationMs ? ` · ${signal.durationMs} ms` : ""}
      </li>)}</ul> : <p>Aucun signal enregistré dans les 30 derniers jours.</p>}
    </details>
  </>;
}
