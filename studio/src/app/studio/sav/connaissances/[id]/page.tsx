import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSavStaff } from "@/lib/sav/auth";
import { getSavKnowledgeDetail } from "@/lib/knowledge/workspace";
import { formatParisDateTime } from "@/lib/paris-date";
import { DeliveryPreview } from "../delivery-editor";
import { KnowledgeDocument } from "../knowledge-document";
import { KnowledgePublication, KnowledgeRevisionButton, KnowledgeWorkspaceReview } from "../workspace-review";
import { OnboardingReviewForm } from "../onboarding-review-form";
import { HubspotReviewForm } from "../hubspot-review-form";
import { knowledgeErrorMessage, knowledgeHistoryLabel, knowledgeState, safeKnowledgeReturn } from "../workspace-labels";
import styles from "../workspace.module.css";

export const dynamic = "force-dynamic";
function sourceUrl(ref: string) {
  if (/^content:[a-f0-9-]{36}(?::[a-f0-9-]{36})?$/i.test(ref)) return `/studio/contenus/${ref.split(":")[1]}`;
  if (/^sav-learning:[a-f0-9-]{36}$/i.test(ref)) return `/studio/sav/connaissances/${ref.slice(13)}?kind=learning`;
  if (/^\/studio\//.test(ref) && !ref.includes("\\")) return ref;
  try { const parsed = new URL(ref); return parsed.protocol === "https:" ? parsed.href : null; } catch { return null; }
}
export default async function SavKnowledgeDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ kind?: string; from?: string; result?: string }> }) {
  const staff = await requireSavStaff();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!/^[a-f0-9-]{36}$/i.test(id)) notFound();
  const kind = ["candidate", "draft", "learning"].includes(query.kind ?? "") ? query.kind : "item";
  const detail = await getSavKnowledgeDetail(kind === "candidate" ? { candidateId: id } : kind === "draft" ? { draftId: id } : kind === "learning" ? { learningCandidateId: id } : { itemId: id }, staff.email);
  if (!detail) notFound();
  const { row } = detail;
  const importKind = detail.reviewKind;
  return <div className={styles.workspace}>
    <Link className="back-link" href={safeKnowledgeReturn(query.from)}>← Bibliothèque des connaissances</Link>
    <div className={styles.heading}><div><span className="eyebrow">Connaissance SAV · {row.origin === "automatic" ? "Apprentissage automatique" : row.origin === "human" ? "Proposition humaine" : "Origine à qualifier"}</span><h1>{row.title}</h1><p className={styles.subtle}>{row.summary}</p><span className={styles.badge}>{knowledgeState(row.state)}</span></div>
      <div className={styles.row}>{row.itemId && <Link className="button secondary" href={`/studio/sav/connaissances/proposer?target=${row.itemId}`}>Proposer une amélioration</Link>}{row.draftId && <Link className="button primary" href={`/studio/sav/connaissances/proposer?draft=${row.draftId}`}>Reprendre le brouillon</Link>}{row.learningCandidateId && !row.candidateId && <Link className="button primary" href={`/studio/sav/connaissances/proposer?learning=${row.learningCandidateId}`}>Préparer une proposition sourcée</Link>}</div></div>
    {query.result && <p className={styles.alert} role="status">{/^[A-Z_]+$/.test(query.result) ? knowledgeErrorMessage(query.result) : "Décision enregistrée. La version active reste conservée jusqu’à activation explicite."}</p>}
    {detail.alerts.map((alert, index) => <p className={styles.alert} role="status" key={index}>{/^[A-Z_]+$/.test(alert) ? knowledgeErrorMessage(alert) : alert}</p>)}
    {detail.missing.length > 0 && <section className={styles.alert}><h2>Informations à compléter</h2><ul>{detail.missing.map(entry => <li key={entry}>{entry}</li>)}</ul><p>Une connaissance incomplète ne peut pas être publiée.</p></section>}
    <div className={styles.versions}><span className={styles.badge}>{detail.activeVersion ? `Active · v${detail.activeVersion.version}` : "Aucune version active"}</span><span className={styles.badge}>{detail.publishedVersion ? `Publiée · v${detail.publishedVersion.version}` : "Non publiée"}</span>{detail.proposedVersion && <span className={`${styles.badge} ${styles.warning}`}>Proposée · v{detail.proposedVersion.version}</span>}{row.hasPendingUpdate && <span className={`${styles.badge} ${styles.warning}`}>Mise à jour à valider</span>}</div>
    {(detail.proposedBody || detail.document) && <section className={styles.panel} aria-label="Procédure proposée"><h2>{row.kind === "item" && !row.hasPendingUpdate ? "La procédure" : "La proposition"}</h2>{detail.document ? <KnowledgeDocument document={detail.document}/> : <pre className={styles.text}>{detail.proposedBody}</pre>}</section>}
    {detail.document && <section className={styles.panel}><DeliveryPreview document={detail.document} delivery={detail.delivery}/></section>}
    <section className={styles.panel} aria-label="Comparer la version active et proposée"><h2>Version active et version proposée</h2><div className={styles.comparison}><section><h3>{detail.activeVersion ? `Version active · v${detail.activeVersion.version}` : "Aucune version active"}</h3><p className={styles.subtle}>C’est la version conservée pour l’agent jusqu’à une activation explicite.</p><pre className={styles.text}>{detail.activeVersion?.body ?? "Cette connaissance n’est pas encore utilisée par l’agent."}</pre></section><section><h3>{detail.proposedVersion ? `Version proposée · v${detail.proposedVersion.version}` : "Proposition en cours"}</h3><pre className={styles.text}>{detail.proposedBody || detail.proposedVersion?.body || "Aucune nouvelle proposition."}</pre></section></div></section>
    <section className={styles.panel} aria-label="Sources de la connaissance"><h2>Sources et preuves</h2><p className={styles.subtle}>Les références restent liées à cette version. Les preuves privées sont accessibles dans leur dossier d’origine.</p>{detail.sources.length ? <ul>{detail.sources.map((source, index) => { const href = sourceUrl(source.ref); return <li key={`${source.ref}:${index}`}>{href ? <Link href={href}>{source.label}</Link> : <><strong>{source.label}</strong><p className={styles.subtle}>{source.ref}</p></>}</li>; })}</ul> : <p>Aucune source renseignée. La publication reste bloquée.</p>}</section>
    {detail.comparison.length > 0 && <section className={styles.panel}><h2>Connaissances proches</h2><p className={styles.subtle}>Ces rapprochements aident la revue ; vérifiez les différences de contexte et les contradictions.</p>{detail.comparison.map(finding => <details key={`${finding.ref}:${finding.versionId}`}><summary>{finding.title} · {finding.signal === "duplicate" ? "Doublon possible" : "Sujet proche"}</summary><p>{finding.explanation}</p><pre className={styles.text}>{finding.body}</pre></details>)}</section>}
    {detail.reviewKind === "workspace" && row.candidateId && ["pending", "needs_completion", "rejected"].includes(row.state) && <section className={styles.panel}><h2>Ajouter des précisions ou de nouvelles preuves</h2><p className={styles.subtle}>Préparer une nouvelle révision conserve la connaissance et ses décisions précédentes. La version active ne change pas.</p><KnowledgeRevisionButton candidateId={row.candidateId}/></section>}
    {detail.canReview && row.candidateId && detail.revisionId && detail.document && (importKind === "onboarding" ? <section className={styles.panel}><h2>Relire et décider</h2><OnboardingReviewForm candidateId={row.candidateId} revisionId={detail.revisionId} title={row.title} initialDocument={detail.document} needsCompletion={row.state === "needs_completion"} filters={{ page: 1, status: "all", source: "all", candidate: row.candidateId, detail: true }}/></section>
      : importKind === "hubspot" ? <section className={styles.panel}><h2>Relire et décider</h2><HubspotReviewForm detail candidateId={row.candidateId} revisionId={detail.revisionId} initialDocument={JSON.stringify(detail.document, null, 2)}/></section>
      : <KnowledgeWorkspaceReview key={`${row.candidateId}:${detail.revisionId}:${row.state}`} candidateId={row.candidateId} revisionId={detail.revisionId} initialDocument={detail.document}/>)}
    {row.itemId && staff.email === "ugo@limova.ai" && (detail.canPublish || detail.canActivate) && <KnowledgePublication key={`${detail.proposedVersion?.id}:${detail.publishedVersion?.id}:${detail.activeVersion?.id}`} itemId={row.itemId} title={row.title} proposedVersionId={detail.proposedVersion?.id ?? null} publishedVersionId={detail.publishedVersion?.id ?? null} activeVersionId={detail.activeVersion?.id ?? null} canPublish={detail.canPublish} canActivate={detail.canActivate}/>}
    {staff.email !== "ugo@limova.ai" && <p className={styles.subtle}>La publication, l’activation et le retour à une version antérieure restent réservés à Ugo.</p>}
    <details className={styles.panel}><summary>Historique des versions et décisions · {detail.history.length}</summary>{detail.history.length ? <ol className={styles.timeline}>{detail.history.map((event, index) => <li key={`${event.at.toISOString()}:${index}`}><strong>{knowledgeHistoryLabel(event.action)}</strong><p>{event.reason}</p><small>{event.actor} · {formatParisDateTime(event.at)}</small></li>)}</ol> : <p>Aucune décision enregistrée.</p>}</details>
  </div>;
}
