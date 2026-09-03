import Link from "next/link";
import { ArrowLeft, BookOpenCheck, DatabaseZap } from "lucide-react";
import { requireStaff } from "@/lib/auth";
import { getHubspotBackfillState, HUBSPOT_EMAIL_READ_SCOPE, isHubspotEmailReadScopeError } from "@/lib/sav/hubspot";
import { listLearningCandidates } from "@/lib/sav/learning";
import { continueBackfillAction, reviewLearningAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SavResolutionsPage({ searchParams }: { searchParams: Promise<{ backfill?: string }> }) {
  await requireStaff("admin");
  const [candidates, backfill, query] = await Promise.all([
    listLearningCandidates(),
    getHubspotBackfillState(),
    searchParams,
  ]);
  const pendingCount = candidates.filter((candidate) => candidate.status === "pending").length;
  const permissionBlocked = backfill?.status === "blocked" && isHubspotEmailReadScopeError(backfill.lastError);

  return <>
    <Link className="back-link" href="/studio/sav"><ArrowLeft size={14}/> Retour au registre SAV</Link>
    <div className="page-intro compact">
      <div>
        <span className="eyebrow">Apprentissage supervisé</span>
        <h1>Les tickets résolus deviennent des fiches vérifiables.</h1>
        <p>Chaque résolution issue d’un ticket fermé reste une proposition. L’administrateur décide si elle devient un brouillon de connaissance.</p>
      </div>
    </div>

    {query.backfill && <p className="login-notice" role="status">
      {query.backfill === "complete" ? "Tous les tickets HubSpot ont été analysés." : query.backfill === "permission_required" ? `Ajoutez la permission ${HUBSPOT_EMAIL_READ_SCOPE} à la clé de service HubSpot, puis relancez le test.` : "25 tickets supplémentaires ont été analysés."}
    </p>}

    <section className="resolution-backfill card">
      <div className="resolution-backfill-icon"><DatabaseZap size={24}/></div>
      <div>
        <span className="eyebrow">Historique HubSpot</span>
        <h2>{backfill?.status === "complete" ? "Analyse terminée" : permissionBlocked ? "Autorisation HubSpot requise" : "Construire la mémoire SAV"}</h2>
        <p>{backfill?.processedCount ?? 0} tickets analysés. {permissionBlocked ? <>Ajoutez <code>{HUBSPOT_EMAIL_READ_SCOPE}</code> à la clé de service. Le reste du SAV continue sans interruption et le worker retestera automatiquement.</> : "Le worker avance automatiquement par petits lots et reprend après une interruption."}</p>
        {backfill?.lastError && !permissionBlocked && <code>{backfill.lastError}</code>}
      </div>
      {backfill?.status !== "complete" && <form action={continueBackfillAction}>
        <button className="primary" type="submit">{permissionBlocked ? "Retester l’accès HubSpot" : "Analyser 25 maintenant"}</button>
      </form>}
    </section>

    <div className="section-heading">
      <div><span className="eyebrow">Candidats</span><h2>{pendingCount} résolution{pendingCount > 1 ? "s" : ""} à relire</h2></div>
    </div>

    <section className="learning-list">
      {candidates.map((candidate) => <article className="learning-card card" key={candidate.id}>
        <div className="learning-card-icon"><BookOpenCheck size={20}/></div>
        <div>
          <span className={`sav-learning-status ${candidate.status}`}>
            {candidate.status === "pending" ? "À relire" : candidate.status === "approved" ? "Brouillon créé" : "Écarté"}
          </span>
          <h3>{candidate.proposedSubject || `Ticket HubSpot #${candidate.hubspotTicketId}`}</h3>
          <p>{candidate.explanation}</p>
          <details className="learning-preview">
            <summary>Voir la résolution proposée</summary>
            <pre>{candidate.proposedResolution}</pre>
          </details>
          <small>Ticket HubSpot #{candidate.hubspotTicketId} · détecté le {new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(candidate.createdAt)}</small>
          {candidate.contentItemId && <Link className="table-link" href={`/studio/contenus/${candidate.contentItemId}`}>Ouvrir la fiche →</Link>}
        </div>
        {candidate.status === "pending" && <form action={reviewLearningAction} className="learning-actions">
          <input type="hidden" name="candidateId" value={candidate.id}/>
          <button className="primary" name="decision" value="approve" type="submit">Créer le brouillon</button>
          <button className="ghost-danger" name="decision" value="reject" type="submit">Écarter</button>
        </form>}
      </article>)}
      {!candidates.length && <div className="empty card">Les tickets clôturés avec une résolution exploitable apparaîtront ici après l’analyse HubSpot.</div>}
    </section>
  </>;
}
