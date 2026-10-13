import { formatParisDateTime } from "@/lib/paris-date";
import Link from "next/link";
import { and, eq, or } from "drizzle-orm";
import { requireDb } from "@/db";
import { knowledgeFamilies, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjectionCandidates, knowledgeProjections } from "@/db/schema";
import { hasRole } from "@/lib/auth";
import { requireSavStaff } from "@/lib/sav/auth";
import { paginateKnowledgeCandidates } from "@/lib/knowledge/candidates";
import { importOnboardingKnowledgeAction, importHubspotKnowledgeAction, reviewKnowledgeAction } from "../actions";

import { hubspotComparison, knowledgeComparisonInventory } from "@/lib/knowledge/hubspot-import";
import { HubspotReviewForm } from "./hubspot-review-form";
import { getOnboardingImport, inventoryOnboardingSources, listOnboardingImports } from "@/lib/knowledge/onboarding-import";
import { continueOnboardingImportAction, startOnboardingImportAction } from "./onboarding-actions";
import { OnboardingReviewForm } from "./onboarding-review-form";
import type { CanonicalKnowledge } from "@/lib/knowledge/contracts";

export const dynamic = "force-dynamic";

const statusLabels: Record<string, string> = { pending: "À valider par Ugo", needs_completion: "À compléter", needs_recording: "À compléter par un tutoriel", not_applicable: "Non applicable", approved: "Validé", rejected: "Écarté" };
const sourceLabels: Record<string, string> = { all: "Toutes les sources", onboarding: "Tutoriels → SAV", hubspot: "Fiches HubSpot", sav: "Résolutions SAV → tutoriels" };
const sourceChangeAlertStatuses = ["pending", "needs_completion", "approved"];
const notices: Record<string, string> = {
  hubspot_candidates_ready: "Import préparé : les fiches sont des candidats privés, sans publication ni activation. Un nouvel import du même fichier reprend les candidats existants.",
  draft_ready: "Décision enregistrée. Une validation positive prépare un brouillon SAV ; la publication reste une action distincte d’Ugo.",
  candidate_ready: "Candidat préparé, sans modification du tutoriel source.",
  onboarding_import_started: "Inventaire préparé. Lancez le traitement du lot pour préparer ses connaissances candidates.",
  onboarding_import_continued: "Passage terminé. Consultez les compteurs du lot et poursuivez jusqu’à ce que toutes les sources soient traitées.",
};
function stringList(value: unknown) { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function positivePage(value: string | undefined) { const page = Number(value); return Number.isSafeInteger(page) && page > 0 ? page : 1; }
function uuid(value: string | undefined) { return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : null; }
async function findCandidate(id: string) {
  const rows = await requireDb().select({ candidate: knowledgeProjectionCandidates, family: knowledgeFamilies, revision: knowledgeFamilyRevisions, source: knowledgeFamilySources })
    .from(knowledgeProjectionCandidates).innerJoin(knowledgeFamilies, eq(knowledgeFamilies.id, knowledgeProjectionCandidates.familyId))
    .innerJoin(knowledgeFamilyRevisions, eq(knowledgeFamilyRevisions.id, knowledgeProjectionCandidates.revisionId))
    .innerJoin(knowledgeFamilySources, eq(knowledgeFamilySources.id, knowledgeProjectionCandidates.sourceId))
    .where(eq(knowledgeProjectionCandidates.id, id)).limit(1);
  return rows.map((row) => ({ ...row, canonicalKey: row.family.canonicalKey }));
}
function KnowledgeDocument({ document }: { document: CanonicalKnowledge }) {
  return <section aria-label="Connaissance complète" style={{ maxWidth: "80ch", lineHeight: 1.65 }}>
    <h3>Objectif et valeur</h3><p style={{ whiteSpace: "pre-wrap" }}>{document.objective}</p>
    {document.supportContext && <>
      {document.supportContext.symptoms.length > 0 && <><h3>Quand utiliser cette connaissance</h3><ul>{document.supportContext.symptoms.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
      {document.supportContext.diagnosticQuestions.length > 0 && <><h3>Questions de diagnostic</h3><ul>{document.supportContext.diagnosticQuestions.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    </>}
    {document.onboardingContext?.entryPoint && <><h3>Point d’entrée</h3><p style={{ whiteSpace: "pre-wrap" }}>{document.onboardingContext.entryPoint}</p></>}
    <h3>Prérequis</h3>{document.prerequisites.length ? <ul>{document.prerequisites.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>Non renseignés dans cette proposition.</p>}
    <h3>Procédure</h3>{document.steps.length ? <ol>{document.steps.map((step) => <li key={step.id} style={{ marginBottom: 20 }}>
      <h4>{step.userLabel}</h4><p style={{ whiteSpace: "pre-wrap" }}>{step.instruction}</p>
      {step.location && <p><strong>Emplacement :</strong> {step.location}</p>}
      {step.prerequisites.length > 0 && <><strong>Conditions de l’étape</strong><ul>{step.prerequisites.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
      <p><strong>Résultat observable :</strong> {step.expectedResult || "À confirmer."}</p>
      {step.exceptions.length > 0 && <><strong>Exceptions</strong><ul>{step.exceptions.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
      {step.escalation && <p><strong>Passage à un humain :</strong> {step.escalation}</p>}
      {step.variants.map((variant, index) => <details key={index}><summary>Variante · {variant.roles.join(", ") || "Rôle à qualifier"}{variant.productVersion ? ` · ${variant.productVersion}` : ""}</summary><p>{variant.instruction}</p><p>Résultat : {variant.expectedResult || "À confirmer."}</p></details>)}
    </li>)}</ol> : <p>La procédure reste à compléter à partir de preuves.</p>}
    <h3>Résultat attendu</h3><p style={{ whiteSpace: "pre-wrap" }}>{document.expectedResult || "À confirmer."}</p>
    <h3>Exceptions et limites</h3>{document.exceptions.length ? <ul>{document.exceptions.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>Non renseignées dans cette proposition.</p>}
    <h3>Passage à un humain</h3><p style={{ whiteSpace: "pre-wrap" }}>{document.escalation || "À préciser."}</p>
    {document.onboardingContext && document.onboardingContext.sourceNotes.length > 0 && <details><summary>Précisions complémentaires de la source · {document.onboardingContext.sourceNotes.length}</summary>{document.onboardingContext.sourceNotes.map((value, index) => <p key={index} style={{ whiteSpace: "pre-wrap" }}>{value}</p>)}</details>}
    {document.supportContext?.responseTemplate && <details><summary>Exemple de réponse à adapter</summary><p style={{ whiteSpace: "pre-wrap" }}>{document.supportContext.responseTemplate}</p></details>}
    {(document.productVersion || document.validUntil) && <p>{document.productVersion && `Version produit : ${document.productVersion}. `}{document.validUntil && `Validité : ${document.validUntil}.`}</p>}
  </section>;
}

export default async function SavKnowledgeCandidatesPage({ searchParams }: { searchParams: Promise<{ result?: string; page?: string; status?: string; source?: string; batch?: string; candidate?: string }> }) {
  const staff = await requireSavStaff();
  const query = await searchParams;
  const { result } = query;
  const status = query.status && Object.hasOwn(statusLabels, query.status) ? query.status : "all";
  const sourceFilter = query.source && Object.hasOwn(sourceLabels, query.source) ? query.source : "all";
  const batchId = uuid(query.batch);
  const candidateId = uuid(query.candidate);
  const [catalog, imports, selectedBatch, selectedRows] = await Promise.all([
    paginateKnowledgeCandidates({ page: positivePage(query.page), pageSize: 20, status, source: sourceFilter }), listOnboardingImports(),
    batchId ? getOnboardingImport(batchId).catch(() => null) : Promise.resolve(null),
    candidateId ? findCandidate(candidateId) : Promise.resolve([]),
  ]);
  const { total, page, pageSize } = catalog;
  const rows = query.candidate ? selectedRows : catalog.rows;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const filters = { page, status, source: sourceFilter, batch: batchId ?? undefined, candidate: candidateId ?? undefined };
  const canImport = hasRole(staff.role, "admin");
  function pageUrl(target: number, selectedBatchId = batchId) {
    const params = new URLSearchParams({ page: String(target) });
    if (status !== "all") params.set("status", status);
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    if (selectedBatchId) params.set("batch", selectedBatchId);
    return `/studio/sav/connaissances?${params.toString()}`;
  }
  function candidateUrl(id: string, selectedBatchId = batchId) {
    return `${pageUrl(page, selectedBatchId)}&candidate=${encodeURIComponent(id)}#candidate-${encodeURIComponent(id)}`;
  }
  const approvedCandidates = rows.map(({ candidate }) => candidate).filter((candidate) => candidate.status === "approved" && candidate.targetSurface === "sav" && candidate.materializedVersionId);
  const [inventory, onboardingInventory, approvedRevisions] = await Promise.all([
    staff.email !== "ugo@limova.ai" && rows.some(({ source, candidate }) => source.evidence.importKind === "hubspot" && candidate.status === "pending") ? knowledgeComparisonInventory() : Promise.resolve([]),
    rows.some(({ source, candidate }) => source.evidence.importKind === "onboarding_catalog" && sourceChangeAlertStatuses.includes(candidate.status)) ? inventoryOnboardingSources() : Promise.resolve(null),
    approvedCandidates.length ? requireDb().select({ projectionVersionId: knowledgeProjections.versionId, familyId: knowledgeProjections.familyId, revision: knowledgeFamilyRevisions })
      .from(knowledgeProjections).innerJoin(knowledgeFamilyRevisions, and(eq(knowledgeFamilyRevisions.id, knowledgeProjections.revisionId), eq(knowledgeFamilyRevisions.familyId, knowledgeProjections.familyId)))
      .where(and(eq(knowledgeProjections.surface, "sav"), or(...approvedCandidates.map((candidate) => and(eq(knowledgeProjections.versionId, candidate.materializedVersionId!), eq(knowledgeProjections.familyId, candidate.familyId)))))) : Promise.resolve([]),
  ]);
  const currentOnboardingSources = new Map(onboardingInventory?.sources.map((source) => [source.key, source.hash]));
  const approvedRevisionByVersion = new Map(approvedRevisions.map((projection) => [`${projection.familyId}:${projection.projectionVersionId}`, projection.revision]));
  return <>
    <Link className="back-link" href="/studio/sav">← Retour au SAV</Link>
    <div className="page-intro compact"><div>
      <span className="eyebrow">Connaissance partagée · validation Ugo</span>
      <h1>Connaissances SAV à valider</h1>
      <p>Une même connaissance métier, des versions sources traçables et des projections distinctes. Aucun candidat n’est publié ou exécuté depuis cette page.</p>
    </div></div>
    <p><Link className="button secondary" href="/studio/contenus/nouveau?type=article&agentKey=sav">Préparer une connaissance SAV</Link></p>
    {result && <p className="login-notice" role="status">{notices[result] ?? "L’action n’a pas pu être terminée. Vérifiez la source et le contenu, puis réessayez. Les décisions déjà enregistrées sont conservées."}</p>}
    <details className="card" style={{ padding: 24 }} open={Boolean(selectedBatch) && !query.candidate}>
      <summary>Lots de conversion des tutoriels · {imports.length} lot{imports.length === 1 ? "" : "s"} récent{imports.length === 1 ? "" : "s"}</summary>
      <h2>Préparer les connaissances depuis les tutoriels actifs</h2>
      <p>Chaque connaissance conserve le titre du tutoriel. Les étapes, prérequis, résultats et limites sont préparés pour la revue d’Ugo. Les informations insuffisantes restent visibles comme points à compléter.</p>
      {canImport && <form action={startOnboardingImportAction}>
        <input type="hidden" name="returnPage" value={page}/><input type="hidden" name="returnStatus" value={status}/><input type="hidden" name="returnSource" value={sourceFilter}/>
        <button className="secondary">Préparer l’inventaire des tutoriels actifs</button>
      </form>}
      {imports.length === 0 && <p>Aucun lot préparé.</p>}
      {imports.map((batch) => <article key={batch.id} style={{ marginTop: 20 }}>
        <h3>Lot du {formatParisDateTime(batch.createdAt)}</h3>
        <p>{batch.processed} / {batch.total} sources préparées · {batch.remaining} en attente{batch.failed > 0 ? ` · ${batch.failed} en erreur` : ""}.</p>
        <progress value={batch.processed} max={Math.max(1, batch.total)} aria-label={`Progression du lot du ${formatParisDateTime(batch.createdAt)}`}/>
        <p>À la préparation : {batch.ready} à valider · {batch.needsCompletion} à compléter. Les statuts courants apparaissent dans les cartes.</p>
        <p><Link href={pageUrl(page, batch.id)}>Voir la couverture et les sources du lot</Link></p>
        {batch.failed > 0 && <p>Le lot contient des erreurs. Les sources concernées restent à reprendre avant de considérer l’inventaire terminé.</p>}
        {canImport && (batch.remaining > 0 || batch.failed > 0) && <form action={continueOnboardingImportAction}>
          <input type="hidden" name="importId" value={batch.id}/><input type="hidden" name="returnPage" value={page}/><input type="hidden" name="returnStatus" value={status}/><input type="hidden" name="returnSource" value={sourceFilter}/>
          <input type="hidden" name="returnBatch" value={batch.id}/>
          <button className="secondary">{batch.processed ? "Poursuivre ou reprendre le lot" : "Préparer les premiers candidats"} · 10 sources maximum</button>
        </form>}
        {batch.remaining === 0 && batch.failed === 0 && <p>Inventaire traité. La qualification, la publication et l’activation restent des étapes distinctes.</p>}
      </article>)}
      {query.batch && !selectedBatch && <p role="alert">Ce lot n’est pas accessible. Choisissez un lot dans la liste pour consulter sa couverture.</p>}
      {selectedBatch && <details open>
        <summary>Couverture complète du lot du {formatParisDateTime(selectedBatch.createdAt)}</summary>
        <p>{selectedBatch.manifest.inventory.studioActive} tutoriels Studio actifs, dont {selectedBatch.manifest.inventory.studioIndexed} indexés. {selectedBatch.manifest.inventory.curriculum} entrées du catalogue embarqué, dont {selectedBatch.manifest.inventory.mappedCurriculum} rapprochées des tutoriels Studio.</p>
        <p>{selectedBatch.total} sources à traiter après rapprochement. Chaque ligne indique sa situation dans le lot ; les décisions de revue courantes restent visibles dans les cartes ci-dessous.</p>
        <div style={{ overflowX: "auto" }}><table>
          <caption>Sources du lot et résultat de leur préparation</caption>
          <thead><tr><th scope="col">Tutoriel</th><th scope="col">Source et version</th><th scope="col">Préparation</th></tr></thead>
          <tbody>{selectedBatch.manifest.sources.map((entry) => {
            const outcome = selectedBatch.outcomes[entry.key];
            return <tr key={entry.key}>
              <th scope="row">{entry.itemId ? <Link href={`/studio/contenus/${encodeURIComponent(entry.itemId)}`}>{entry.title}</Link> : entry.title}</th>
              <td>{entry.kind === "studio" ? `Studio · version ${entry.version}` : "Catalogue embarqué"}
                {entry.aliases.length > 0 && <p>{entry.aliases.length} source{entry.aliases.length > 1 ? "s" : ""} liée{entry.aliases.length > 1 ? "s" : ""}{entry.aliases.some((alias) => alias.differs) ? " · différences à qualifier" : ""}.</p>}
                <details><summary>Références de traçabilité</summary><small>Source : {entry.key}<br/>Version : {entry.versionId ?? "catalogue embarqué"}<br/>Empreinte : {entry.hash}</small></details>
              </td>
              <td>{!outcome ? "En attente de traitement" : outcome.state === "failed" ? "En erreur — reprise nécessaire" : statusLabels[outcome.status ?? ""] ?? "Candidat préparé"}
                {outcome?.state === "failed" && <p>{outcome.error === "ONBOARDING_SOURCE_STALE" ? "La source a changé. Préparez un nouvel inventaire pour utiliser la version courante." : "La préparation a échoué. Reprenez le lot ; si l’erreur persiste, faites vérifier cette source."}</p>}
                {outcome && <small>{outcome.attempts} tentative{outcome.attempts > 1 ? "s" : ""}</small>}
                {outcome?.candidateId && <p><Link href={candidateUrl(outcome.candidateId, selectedBatch.id)}>Ouvrir la connaissance</Link></p>}
              </td>
            </tr>;
          })}</tbody>
        </table></div>
        <details><summary>{selectedBatch.manifest.inventory.excluded.length} contenus Studio exclus de ce lot</summary>
          <ul>{selectedBatch.manifest.inventory.excluded.map((entry) => <li key={entry.id}><Link href={`/studio/contenus/${encodeURIComponent(entry.id)}`}>Ouvrir le contenu</Link> · {({ archived: "Archivé", unpublished: "Non publié", disabled: "Désactivé pour l’IA", sav_scope: "Déjà dans la portée SAV" } as Record<string, string>)[entry.reason] ?? "Hors périmètre"}</li>)}</ul>
        </details>
        <p>Trame publiée : {selectedBatch.manifest.inventory.templateVersionId ? `${selectedBatch.manifest.inventory.templateReferences.length} références inventoriées.` : "Aucune trame publiée."}</p>
      </details>}
    </details>
    <details className="card" style={{ padding: 24 }}><summary>Importer des fiches HubSpot</summary>
      <p>Choisissez le fichier JSON privé au format Studio (800 Ko maximum). Les fiches restent à valider par Ugo. Aucun email brut ne doit être inclus.</p>
      <p>Si une tentative échoue, vous pouvez renvoyer le fichier : les fiches déjà préparées sont conservées sans doublon.</p>
      <form action={importHubspotKnowledgeAction}><label>Base de connaissances privée<input type="file" name="knowledgeFile" accept="application/json,.json" required/></label><button className="secondary">Préparer les candidats SAV</button></form>
    </details>
    <details className="card" style={{ padding: 24 }}><summary>Proposer une version de tutoriel au SAV</summary><p>Lecture seule du tutoriel. Aucun script Chrome ou contenu publié n’est modifié.</p><form action={importOnboardingKnowledgeAction}><label>ID du contenu<input name="itemId" required/></label><label>ID de la version source<input name="versionId" required/></label><button className="secondary">Préparer un candidat</button></form></details>
    <form method="get" action="/studio/sav/connaissances" aria-label="Filtrer les connaissances">
      {batchId && <input type="hidden" name="batch" value={batchId}/>}
      <div><label htmlFor="knowledge-status-filter">Statut</label><select id="knowledge-status-filter" name="status" defaultValue={status}><option value="all">Tous les statuts</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div><label htmlFor="knowledge-source-filter">Source</label><select id="knowledge-source-filter" name="source" defaultValue={sourceFilter}>{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <button className="secondary">Afficher les connaissances</button>
    </form>
    {query.candidate ? <p>Consultation d’une connaissance du lot, indépendamment des filtres. <Link href={pageUrl(page)}>← Revenir à la liste filtrée</Link></p> : <p>{total} candidat{total === 1 ? "" : "s"} correspondant{total === 1 ? "" : "s"} · Page {page} sur {pageCount}.</p>}
    {!query.candidate && <nav aria-label="Pagination des connaissances">
      {page > 1 && <Link className="button secondary" href={pageUrl(page - 1)}>← Page précédente</Link>}
      {page < pageCount && <Link className="button secondary" href={pageUrl(page + 1)}>Page suivante →</Link>}
    </nav>}
    <section className="learning-list">
      {rows.map(({ candidate, family, revision, source }) => {
        const imported = source.evidence.importKind === "hubspot";
        const onboarding = source.evidence.importKind === "onboarding_catalog";
        const sourceSnapshot = record(source.evidence.snapshot);
        const sourceChanged = onboarding && sourceChangeAlertStatuses.includes(candidate.status) && typeof sourceSnapshot.key === "string" && typeof sourceSnapshot.hash === "string" && currentOnboardingSources.get(sourceSnapshot.key) !== sourceSnapshot.hash;
        const title = typeof candidate.proposedInput.title === "string" ? candidate.proposedInput.title : typeof source.evidence.sourceTitle === "string" ? source.evidence.sourceTitle : family.title;
        const quality = record(source.evidence.quality);
        const missing = stringList(quality.missing);
        const warnings = stringList(quality.warnings);
        const sourceItemId = typeof source.evidence.sourceItemId === "string" ? source.evidence.sourceItemId : null;
        const comparison = imported && candidate.status === "pending" && staff.email !== "ugo@limova.ai" ? hubspotComparison(candidate, inventory) : null;
        const canReview = staff.email === "ugo@limova.ai" && ["pending", "needs_completion", "needs_recording", "not_applicable"].includes(candidate.status);
        const displayedRevision = candidate.status === "approved" && candidate.targetSurface === "sav" ? approvedRevisionByVersion.get(`${candidate.familyId}:${candidate.materializedVersionId}`) : revision;
        const displayedDocument = displayedRevision?.document;
        return <article id={`candidate-${candidate.id}`} className="card" style={{ padding: 24, minWidth: 0, overflowWrap: "anywhere", scrollMarginTop: 24 }} key={candidate.id}>
        <div>
          <span className="sav-learning-status pending">{statusLabels[candidate.status] ?? candidate.status}</span>
          <h2>{title}</h2>
          <p>{imported ? "HubSpot → SAV" : candidate.targetSurface === "sav" ? "Onboarding → SAV" : "SAV → onboarding"} · {displayedRevision ? `Révision métier ${displayedRevision.revision}` : "Révision validée indisponible"}</p>
          {displayedDocument && <><p style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{displayedDocument.objective}</p>
          <p>{displayedDocument.steps.length} étape{displayedDocument.steps.length === 1 ? "" : "s"}{missing.length > 0 ? ` · ${missing.length} point${missing.length === 1 ? "" : "s"} ${candidate.status === "approved" ? "absent" + (missing.length === 1 ? "" : "s") + " de la source initiale" : "à compléter"}` : ""}{warnings.length > 0 ? ` · ${warnings.length} point${warnings.length === 1 ? "" : "s"} d’attention` : ""}.</p></>}
          {candidate.status === "needs_completion" && <p>Une correction sourcée est nécessaire avant validation.</p>}
          {candidate.status === "needs_recording" && <p>Un enregistrement réel est nécessaire. Ce candidat n’est pas exécutable.</p>}
          {sourceChanged && <p className="login-notice" role="status">Le tutoriel source a changé. Les connaissances déjà publiées restent utilisables ; préparez puis validez une mise à jour.</p>}
          <details className="learning-preview" open={candidateId === candidate.id}>
          <summary>Lire la connaissance et ses limites</summary>
          <p>{candidate.explanation}</p>
          {onboarding && <section aria-label="Source du tutoriel et qualité de la connaissance">
            {sourceItemId && <p><Link href={`/studio/contenus/${encodeURIComponent(sourceItemId)}`}>Ouvrir le tutoriel source : {title}</Link></p>}
            <p>La version source sera vérifiée avant validation.</p>
            {missing.length > 0 && <><h3>{candidate.status === "approved" ? "Informations absentes de la source initiale" : "Informations à compléter"}</h3><ul>{missing.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
            {warnings.length > 0 && <><h3>Points d’attention</h3><ul>{warnings.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
          </section>}
          {displayedDocument ? <KnowledgeDocument document={displayedDocument}/> : <p role="alert">La révision validée n’est plus accessible ici. Consultez la projection existante avant de réutiliser cette connaissance.</p>}
          <details><summary>Provenance et version source</summary><p>Famille : {family.canonicalKey}<br/>Source : {source.sourceRef}<br/>Version : {source.sourceVersionId ?? "catalogue embarqué ou référence du lot"}</p></details>
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
          <details className="learning-preview"><summary>Comparer le texte actuel et le texte proposé</summary>
            <h3>Version actuelle</h3><pre style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" }}>{candidate.diff.before || "Aucune projection existante."}</pre>
            <h3>Texte proposé complet</h3><pre style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" }}>{candidate.diff.after || "Pas de contenu proposé pour cette surface."}</pre>
          </details>
          {candidate.targetItemId && <Link className="table-link" href={`/studio/contenus/${candidate.targetItemId}`}>Ouvrir la projection existante →</Link>}
          {candidate.reviewedAt && <p>Revu par {candidate.reviewedBy} le {formatParisDateTime(candidate.reviewedAt)} · Version préparée : {candidate.materializedVersionId ?? "aucune"}</p>}
          </details>
          {canReview && <details className="learning-preview">
          <summary>Revoir, corriger ou écarter cette connaissance</summary>
          {staff.email === "ugo@limova.ai" && imported && candidate.status === "pending" && <HubspotReviewForm candidateId={candidate.id} revisionId={revision.id} initialDocument={JSON.stringify(revision.document, null, 2)}/>}
          {staff.email === "ugo@limova.ai" && onboarding && ["pending", "needs_completion"].includes(candidate.status) && <OnboardingReviewForm candidateId={candidate.id} revisionId={revision.id} title={title} initialDocument={revision.document} needsCompletion={candidate.status === "needs_completion"} filters={filters}/>}
          {staff.email === "ugo@limova.ai" && !onboarding && !(imported && candidate.status === "pending") && ["pending", "needs_recording", "not_applicable"].includes(candidate.status) && <form action={reviewKnowledgeAction}>
            <input type="hidden" name="candidateId" value={candidate.id}/><input type="hidden" name="revisionId" value={revision.id}/>
            {candidate.status === "pending" && candidate.targetSurface === "sav" && <details><summary>Corriger la connaissance avant validation (JSON métier, sans DOM)</summary><label>Connaissance complète<textarea name="document" rows={16} defaultValue={JSON.stringify(revision.document, null, 2)} style={{ width: "100%" }}/></label></details>}
            <label>Motif de la décision<input name="reason" required minLength={10}/></label>
            {candidate.status === "pending" && candidate.targetSurface === "sav" && <button className="primary" name="decision" value="approve">Valider et préparer le brouillon SAV</button>}
            <button className="secondary" name="decision" value="reject">Écarter le candidat</button>
          </form>}
          </details>}
          {staff.email !== "ugo@limova.ai" && <p>Validation et publication réservées à Ugo. Vos autres accès Studio restent inchangés.</p>}
        </div>
      </article>;
      })}
      {!rows.length && <div className="empty card">{query.candidate ? "Cette connaissance n’est plus accessible. Revenez à la couverture du lot ou à la liste." : "Aucun candidat pour ces filtres. Préparez un lot de tutoriels ou consultez les autres statuts."}</div>}
    </section>
    {!query.candidate && <nav aria-label="Suite des connaissances">
      {page > 1 && <Link className="button secondary" href={pageUrl(page - 1)}>← Page précédente</Link>}
      {page < pageCount && <Link className="button secondary" href={pageUrl(page + 1)}>Page suivante →</Link>}
    </nav>}
  </>;
}
