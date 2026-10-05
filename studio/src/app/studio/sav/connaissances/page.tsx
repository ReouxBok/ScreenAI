import Link from "next/link";
import { requireSavStaff } from "@/lib/sav/auth";
import { listKnowledgeProjectionCandidates } from "@/lib/knowledge/candidates";
import { importOnboardingKnowledgeAction, reviewKnowledgeAction } from "../actions";

export const dynamic = "force-dynamic";

const statusLabels: Record<string, string> = { pending: "À valider par Ugo", needs_recording: "À compléter par un tutoriel", not_applicable: "Non applicable", approved: "Validé", rejected: "Écarté" };

export default async function SavKnowledgeCandidatesPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const staff = await requireSavStaff();
  const { result } = await searchParams;
  const rows = await listKnowledgeProjectionCandidates();
  return <>
    <Link className="back-link" href="/studio/sav">← Retour au SAV</Link>
    <div className="page-intro compact"><div>
      <span className="eyebrow">Connaissance partagée · validation Ugo</span>
      <h1>Propositions SAV ↔ onboarding</h1>
      <p>Une même connaissance métier, des versions sources traçables et des projections distinctes. Aucun candidat n’est publié ou exécuté depuis cette page.</p>
    </div></div>
    {result && <p className="login-notice" role="status">{result === "draft_ready" ? "Décision enregistrée. Une validation positive prépare un brouillon SAV ; la publication reste une action distincte d’Ugo." : result === "candidate_ready" ? "Candidat préparé, sans modification du tutoriel source." : `Action refusée : ${result.slice(0, 100)}`}</p>}
    <details className="card" style={{ padding: 24 }}><summary>Proposer une version de tutoriel au SAV</summary><p>Lecture seule du tutoriel. Aucun script Chrome ou contenu publié n’est modifié.</p><form action={importOnboardingKnowledgeAction}><label>ID du contenu<input name="itemId" required/></label><label>ID de la version source<input name="versionId" required/></label><button className="secondary">Préparer un candidat</button></form></details>
    <section className="learning-list">
      {rows.map(({ candidate, family, revision, source }) => <article className="card" style={{ padding: 24, minWidth: 0, overflowWrap: "anywhere" }} key={candidate.id}>
        <div>
          <span className="sav-learning-status pending">{statusLabels[candidate.status] ?? candidate.status}</span>
          <h2>{family.title}</h2>
          <p>{candidate.targetSurface === "sav" ? "Onboarding → SAV" : "SAV → onboarding"} · Révision métier {revision.revision}</p>
          <p>{candidate.explanation}</p>
          <small>Famille : {family.canonicalKey} · Source : {source.sourceRef} · Version : {source.sourceVersionId ?? "non renseignée"}</small>
          <p>Validation métier : {revision.reviewState === "approved" ? "validée" : "en attente d’Ugo"}. {candidate.status === "needs_recording" && "Non exécutable : un enregistrement réel est requis."}</p>
          <details className="learning-preview"><summary>Avant / proposition</summary>
            <h3>Avant</h3><pre style={{ whiteSpace: "pre-wrap" }}>{candidate.diff.before || "Aucune projection existante."}</pre>
            <h3>Proposition</h3><pre style={{ whiteSpace: "pre-wrap" }}>{candidate.diff.after || "Pas de contenu proposé pour cette surface."}</pre>
          </details>
          <details className="learning-preview"><summary>Parcours métier et prérequis</summary>
            <p>{revision.document.objective}</p>
            <ol>{revision.document.steps.map((step) => <li key={step.id}>
              <p>{step.instruction}</p><small>{step.location} · Résultat : {step.expectedResult || "À confirmer"}</small>
              {step.prerequisites.length > 0 && <p>Prérequis : {step.prerequisites.join(" · ")}</p>}
            </li>)}</ol>
            <p>Escalade : {revision.document.escalation}</p>
          </details>
          {candidate.targetItemId && <Link className="table-link" href={`/studio/contenus/${candidate.targetItemId}`}>Ouvrir la projection existante →</Link>}
          {candidate.reviewedAt && <p>Revu par {candidate.reviewedBy} le {candidate.reviewedAt.toLocaleString("fr-FR")} · Version préparée : {candidate.materializedVersionId ?? "aucune"}</p>}
          {staff.email === "ugo@limova.ai" && ["pending", "needs_recording", "not_applicable"].includes(candidate.status) && <form action={reviewKnowledgeAction}>
            <input type="hidden" name="candidateId" value={candidate.id}/><input type="hidden" name="revisionId" value={revision.id}/>
            {candidate.status === "pending" && candidate.targetSurface === "sav" && <details><summary>Corriger la connaissance avant validation (JSON métier, sans DOM)</summary><label>Connaissance complète<textarea name="document" rows={16} defaultValue={JSON.stringify(revision.document, null, 2)} style={{ width: "100%" }}/></label></details>}
            <label>Motif de la décision<input name="reason" required minLength={10}/></label>
            {candidate.status === "pending" && candidate.targetSurface === "sav" && <button className="primary" name="decision" value="approve">Valider et préparer le brouillon SAV</button>}
            <button className="secondary" name="decision" value="reject">Écarter le candidat</button>
          </form>}
          {staff.email !== "ugo@limova.ai" && <p>Validation et publication réservées à Ugo. Vos autres accès Studio restent inchangés.</p>}
        </div>
      </article>)}
      {!rows.length && <div className="empty card">Aucun candidat. Les nouvelles conversions et résolutions revues alimenteront cette liste, sans reprise automatique de l’historique.</div>}
    </section>
  </>;
}
