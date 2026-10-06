import Link from "next/link";
import { requireSavStaff } from "@/lib/sav/auth";
import { listKnowledgeProjectionCandidates } from "@/lib/knowledge/candidates";
import { importOnboardingKnowledgeAction, importHubspotKnowledgeAction, reviewKnowledgeAction } from "../actions";

import { hubspotComparison, knowledgeComparisonInventory } from "@/lib/knowledge/hubspot-import";
import { HubspotReviewForm } from "./hubspot-review-form";

export const dynamic = "force-dynamic";

const statusLabels: Record<string, string> = { pending: "À valider par Ugo", needs_recording: "À compléter par un tutoriel", not_applicable: "Non applicable", approved: "Validé", rejected: "Écarté" };

export default async function SavKnowledgeCandidatesPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const staff = await requireSavStaff();
  const { result } = await searchParams;
  const rows = await listKnowledgeProjectionCandidates();
  const inventory = staff.email !== "ugo@limova.ai" && rows.some(({ source, candidate }) => source.evidence.importKind === "hubspot" && candidate.status === "pending") ? await knowledgeComparisonInventory() : [];
  return <>
    <Link className="back-link" href="/studio/sav">← Retour au SAV</Link>
    <div className="page-intro compact"><div>
      <span className="eyebrow">Connaissance partagée · validation Ugo</span>
      <h1>Connaissances SAV à valider</h1>
      <p>Une même connaissance métier, des versions sources traçables et des projections distinctes. Aucun candidat n’est publié ou exécuté depuis cette page.</p>
    </div></div>
    {result && <p className="login-notice" role="status">{result === "hubspot_candidates_ready" ? "Import préparé : les fiches sont des candidats privés, sans publication ni activation. Un nouvel import du même fichier reprend les candidats existants." : result === "draft_ready" ? "Décision enregistrée. Une validation positive prépare un brouillon SAV ; la publication reste une action distincte d’Ugo." : result === "candidate_ready" ? "Candidat préparé, sans modification du tutoriel source." : `Action refusée : ${result.slice(0, 100)}`}</p>}
    <details className="card" style={{ padding: 24 }}><summary>Importer des fiches HubSpot</summary>
      <p>Choisissez le fichier JSON privé au format Studio (800 Ko maximum). Les fiches restent à valider par Ugo. Aucun email brut ne doit être inclus.</p>
      <p>Si une tentative échoue, vous pouvez renvoyer le fichier : les fiches déjà préparées sont conservées sans doublon.</p>
      <form action={importHubspotKnowledgeAction}><label>Base de connaissances privée<input type="file" name="knowledgeFile" accept="application/json,.json" required/></label><button className="secondary">Préparer les candidats SAV</button></form>
    </details>
    <details className="card" style={{ padding: 24 }}><summary>Proposer une version de tutoriel au SAV</summary><p>Lecture seule du tutoriel. Aucun script Chrome ou contenu publié n’est modifié.</p><form action={importOnboardingKnowledgeAction}><label>ID du contenu<input name="itemId" required/></label><label>ID de la version source<input name="versionId" required/></label><button className="secondary">Préparer un candidat</button></form></details>
    <section className="learning-list">
      {rows.map(({ candidate, family, revision, source }) => {
        const imported = source.evidence.importKind === "hubspot";
        const comparison = imported && candidate.status === "pending" && staff.email !== "ugo@limova.ai" ? hubspotComparison(candidate, inventory) : null;
        return <article className="card" style={{ padding: 24, minWidth: 0, overflowWrap: "anywhere" }} key={candidate.id}>
        <div>
          <span className="sav-learning-status pending">{statusLabels[candidate.status] ?? candidate.status}</span>
          <h2>{family.title}</h2>
          <p>{imported ? "HubSpot → SAV" : candidate.targetSurface === "sav" ? "Onboarding → SAV" : "SAV → onboarding"} · Révision métier {revision.revision}</p>
          <p>{candidate.explanation}</p>
          <small>Famille : {family.canonicalKey} · Source : {source.sourceRef} · Version : {source.sourceVersionId ?? "non renseignée"}</small>
          <p>Validation métier : {revision.reviewState === "approved" ? "validée" : "en attente d’Ugo"}. {candidate.status === "needs_recording" && "Non exécutable : un enregistrement réel est requis."}</p>
          {imported && <details className="learning-preview"><summary>Provenance et précisions produit</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(source.evidence, null, 2)}</pre></details>}
          {comparison && <details className="learning-preview" open><summary>Comparaison avec les connaissances du Studio</summary>
            <p>{comparison.compared} versions comparées, y compris les brouillons et les autres candidats SAV. Les rapprochements de texte sont des suggestions ; ils ne garantissent pas l’absence de contradiction.</p>
            <p>Vérifiez les produits, les conditions et les versions. Écartez un doublon ou corrigez un désaccord avant validation. L’import ne remplace aucune autre fiche.</p>
            {!comparison.findings.length && <p>Aucun rapprochement automatique. La revue métier reste nécessaire.</p>}
            {comparison.findings.map((finding) => <details key={`${finding.ref}:${finding.versionId}`}><summary>{finding.title} · {finding.agentKey} · {finding.signal === "duplicate" ? "Doublon possible" : "Sujet proche"}</summary>
              <p>{finding.explanation}</p><small>{finding.ref} · Version {finding.versionId}</small>
              {finding.ref.startsWith("content:") && <p><Link href={`/studio/contenus/${finding.ref.slice(8)}`}>Ouvrir la fiche comparée →</Link></p>}
              <pre style={{ whiteSpace: "pre-wrap" }}>{finding.body}</pre>
            </details>)}
          </details>}
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
          {staff.email === "ugo@limova.ai" && imported && candidate.status === "pending" && <HubspotReviewForm candidateId={candidate.id} revisionId={revision.id} initialDocument={JSON.stringify(revision.document, null, 2)}/>}
          {staff.email === "ugo@limova.ai" && !(imported && candidate.status === "pending") && ["pending", "needs_recording", "not_applicable"].includes(candidate.status) && <form action={reviewKnowledgeAction}>
            <input type="hidden" name="candidateId" value={candidate.id}/><input type="hidden" name="revisionId" value={revision.id}/>
            {candidate.status === "pending" && candidate.targetSurface === "sav" && <details><summary>Corriger la connaissance avant validation (JSON métier, sans DOM)</summary><label>Connaissance complète<textarea name="document" rows={16} defaultValue={JSON.stringify(revision.document, null, 2)} style={{ width: "100%" }}/></label></details>}
            <label>Motif de la décision<input name="reason" required minLength={10}/></label>
            {candidate.status === "pending" && candidate.targetSurface === "sav" && <button className="primary" name="decision" value="approve">Valider et préparer le brouillon SAV</button>}
            <button className="secondary" name="decision" value="reject">Écarter le candidat</button>
          </form>}
          {staff.email !== "ugo@limova.ai" && <p>Validation et publication réservées à Ugo. Vos autres accès Studio restent inchangés.</p>}
        </div>
      </article>;
      })}
      {!rows.length && <div className="empty card">Aucun candidat. Les nouvelles conversions et résolutions revues alimenteront cette liste, sans reprise automatique de l’historique.</div>}
    </section>
  </>;
}
