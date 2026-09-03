import Link from "next/link";
import { notFound } from "next/navigation";
import { archiveAction, deleteContentAction, reviewDecisionAction, rollbackAction, submitAction } from "@/app/studio/actions";
import { ContentEvaluationPanel } from "@/components/content-evaluation-panel";
import { ContentForm } from "@/components/content-form";
import { TrainingRecordingReview } from "@/components/training-recording-review";
import { VersionComparison } from "@/components/version-comparison";
import { canEditContent, canManageProduction } from "@/lib/access";
import { requireStaff } from "@/lib/auth";
import { getEvaluationForContent } from "@/lib/evaluations";
import { getTrainingByContentItemId } from "@/lib/training";
import { getContentDetail } from "@/lib/workflow";

export const dynamic = "force-dynamic";
const steps = ["draft", "in_review", "published", "archived"] as const;

export default async function DetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ delete?: string; evaluation?: string; testCode?: string; testCase?: string }>;
}) {
  const { id } = await params;
  const staff = await requireStaff();
  const { delete: deleteState, evaluation, testCode, testCase } = await searchParams;
  const detail = await getContentDetail(id);
  if (!detail) notFound();
  const current = detail.versions.find((version) => version.id === detail.item.currentDraftVersionId) ?? detail.versions[0];
  const previous = detail.versions.find((version) => version.version === (current?.version ?? 1) - 1);
  const sourceTraining = await getTrainingByContentItemId(id);
  const evaluationData = detail.item.type === "onboarding" ? await getEvaluationForContent(id) : null;
  const isAdmin = canManageProduction(staff.role);
  const canEdit = canEditContent(staff.role, detail.item.publishedVersionId);

  return <>
    <span className="eyebrow">{detail.item.type === "article" ? "Article" : "Parcours"} · version {current?.version ?? 0}</span>
    <h1 className="page-title">{detail.item.title}</h1>
    <section className="content-management card" aria-label="Gestion du contenu">
      <div>
        <span className={`status ${detail.item.status}`}>{detail.item.status === "published" ? "Validé" : detail.item.status === "in_review" ? "À valider" : detail.item.status === "draft" ? "Brouillon" : "Archivé"}</span>
        <p>Créé par <strong>{detail.item.ownerEmail}</strong> · {detail.item.aiEnabled ? "utilisé par l’agent IA" : "non destiné à l’agent IA"}</p>
        {!canEdit && <p>Ce contenu est en production. Seuls l’administrateur et l’owner peuvent encore le modifier ou le supprimer.</p>}
      </div>
      {canEdit && <div className="content-management-actions">
        <Link className="button primary" href="#content-editor-form">Modifier le contenu</Link>
        <details className="content-delete" open={deleteState === "used-in-template" || undefined}>
          <summary>Supprimer</summary>
          <div className="content-delete-panel">
            <h2>Supprimer définitivement ?</h2>
            <p>Les versions, les tests de qualité et l’index de ce contenu seront supprimés. Une démonstration source éventuelle restera disponible.</p>
            {detail.item.publishedVersionId && <p className="content-delete-warning">Une version de ce contenu est actuellement en production et disparaîtra immédiatement.</p>}
            {deleteState === "used-in-template" && <p className="login-error" role="alert">Ce contenu est utilisé dans la trame d’onboarding. Retirez-le d’abord de la trame, puis republiez celle-ci.</p>}
            <form action={deleteContentAction}>
              <input type="hidden" name="itemId" value={id}/>
              <button className="ghost-danger" type="submit">Confirmer la suppression</button>
            </form>
          </div>
        </details>
      </div>}
    </section>
    <div className="editor-layout">
      <section className="editor-card card">
        {canEdit ? <ContentForm key={current?.id ?? detail.item.id} defaults={{
          id: detail.item.id,
          type: detail.item.type,
          slug: detail.item.slug,
          title: detail.item.title,
          summary: detail.item.summary,
          categorySlug: detail.category?.slug,
          agentKey: detail.item.agentKey,
          visibility: detail.item.visibility,
          ownerEmail: detail.item.ownerEmail,
          bodyMarkdown: current?.bodyMarkdown,
          metadata: current?.metadata as Record<string, unknown>,
        }}/> : <div className="locked-content"><strong>Contenu verrouillé pour les membres</strong><p>Vous pouvez consulter son historique, mais sa version en production ne peut être modifiée que par Ugo ou Reouven.</p></div>}
        {current && <VersionComparison current={current.bodyMarkdown} previous={previous?.bodyMarkdown}/>}
        {sourceTraining && <TrainingRecordingReview session={sourceTraining} context="validation"/>}
        {detail.item.type === "onboarding" && <ContentEvaluationPanel itemId={id} data={evaluationData} testCode={testCode} testCaseId={testCase} required={evaluation === "required"}/>}
        <section className="decision-section">
          <div><span className="eyebrow">Prochaine étape</span><h2>{detail.item.status === "draft" ? "Envoyer à la validation" : detail.item.status === "in_review" ? "Décider de cette version" : detail.item.status === "published" ? "Cette version est active" : "Contenu archivé"}</h2></div>
          {detail.item.status === "draft" && canEdit && <form action={submitAction}><input type="hidden" name="itemId" value={id}/><input type="hidden" name="comment" value="Soumis pour validation"/><button className="primary">Demander la validation</button></form>}
          {detail.item.status === "in_review" && isAdmin && <form action={reviewDecisionAction} className="decision-form">
            <input type="hidden" name="itemId" value={id}/>
            <div className="field"><label htmlFor="reviewComment">Commentaire uniquement si vous demandez une correction</label><input id="reviewComment" name="comment" placeholder="Ex. Préciser l’étape de connexion"/></div>
            <div className="decision-buttons"><button className="primary" name="decision" value="publish">Valider et publier</button><button className="ghost-danger" name="decision" value="reject">Demander une correction</button></div>
          </form>}
          {detail.item.status === "in_review" && !isAdmin && <p className="muted">Cette version attend la validation de l’administrateur ou de l’owner.</p>}
          {detail.item.status === "published" && isAdmin && <details className="quiet-actions"><summary>Autres actions</summary><form action={archiveAction} className="admin-action"><input type="hidden" name="itemId" value={id}/><input type="hidden" name="reason" value="Archivage manuel"/><button>Archiver</button></form></details>}
        </section>
        <div className="section-heading"><h2>Historique</h2></div>
        <div className="table-wrap"><table><thead><tr><th>Version</th><th>Auteur</th><th>Commentaire</th><th>Date</th><th></th></tr></thead><tbody>{detail.versions.map((version) => <tr key={version.id}>
          <td>v{version.version}{detail.item.publishedVersionId === version.id ? " · active" : ""}</td>
          <td>{version.authorEmail}</td><td>{version.changeNote}</td><td>{version.createdAt.toLocaleString("fr-FR")}</td>
          <td>{isAdmin && detail.item.publishedVersionId !== version.id && <details><summary>Restaurer</summary><form action={rollbackAction} className="admin-action compact"><input type="hidden" name="itemId" value={id}/><input type="hidden" name="versionId" value={version.id}/><input type="hidden" name="reason" value={`Restauration manuelle de la version ${version.version}`}/><button>Confirmer</button></form></details>}</td>
        </tr>)}</tbody></table></div>
      </section>
      <aside className="publication-rail card"><span className="eyebrow">Chemin éditorial</span><div style={{ height: 18 }}/>{steps.map((step) => <div key={step} className={`rail-step ${detail.item.status === step ? "active" : ""}`}>{step === "draft" ? "Brouillon" : step === "in_review" ? "À valider" : step === "published" ? "Publié" : "Archivé"}</div>)}<hr/><p className="muted">La version active reste servie tant que les embeddings et les tests de la suivante ne sont pas validés.</p></aside>
    </div>
  </>;
}
