"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SavKnowledgeDetail, SavKnowledgeDraft, SavKnowledgeRow, SavKnowledgeSource } from "@/lib/knowledge/workspace-contract";
import { KnowledgeEditor, cleanKnowledgeDocument, emptyKnowledgeDocument } from "./knowledge-editor";
import { KnowledgeDocument } from "./knowledge-document";
import { findKnowledgeAction, loadKnowledgeTargetAction, previewKnowledgeProposalAction, saveKnowledgeProposalAction, submitKnowledgeProposalAction } from "./workspace-actions";
import { knowledgeDetailUrl } from "./workspace-labels";
import { DeliveryEditor, DeliveryPreview } from "./delivery-editor";
import { unclassifiedSavDelivery, type SavSupportDelivery } from "@/lib/knowledge/support-delivery";
import styles from "./workspace.module.css";

type Preview = NonNullable<Awaited<ReturnType<typeof previewKnowledgeProposalAction>>["preview"]>;
export function KnowledgeProposalPreviewDocument({ draft, sources = draft.sources }: { draft: Pick<SavKnowledgeDraft, "title" | "document" | "sources" | "delivery">; sources?: SavKnowledgeSource[] }) {
  return <section><h3>Proposition : {draft.title}</h3><KnowledgeDocument document={draft.document}/><DeliveryPreview document={draft.document} delivery={draft.delivery}/><h4>Sources de cette proposition</h4><ul>{sources.map((source, index) => <li key={`${source.ref}:${index}`}>{source.label} — {source.ref}</li>)}</ul></section>;
}
export function KnowledgeProposalForm({ initial, learningCandidateId }: { initial: SavKnowledgeDetail | null; learningCandidateId?: string }) {
  const router = useRouter();
  const initialDraft = initial?.draft;
  const [draft, setDraft] = useState<SavKnowledgeDraft | null>(initialDraft ?? null);
  const [mode, setMode] = useState<"new" | "improve">(initialDraft?.mode ?? (initial?.row.itemId ? "improve" : "new"));
  const [targetItemId, setTargetItemId] = useState(initialDraft?.targetItemId ?? initial?.row.itemId ?? "");
  const [targetTitle, setTargetTitle] = useState(initial?.activeVersion?.title ?? initial?.publishedVersion?.title ?? initial?.row.title ?? "");
  const [title, setTitle] = useState(initialDraft?.title ?? initial?.row.title ?? "");
  const [document, setDocument] = useState(initialDraft?.document ?? initial?.document ?? emptyKnowledgeDocument);
  const [delivery, setDelivery] = useState<SavSupportDelivery>(initialDraft?.delivery ?? initial?.delivery ?? unclassifiedSavDelivery);
  const [sources, setSources] = useState<SavKnowledgeSource[]>(initialDraft?.sources ?? (learningCandidateId ? initial?.sources : undefined) ?? [{ label: "", ref: "" }]);
  const [reason, setReason] = useState(initialDraft?.reason ?? "");
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<SavKnowledgeRow[]>([]);
  const [searched, setSearched] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, startTransition] = useTransition();
  const locked = useRef(false);
  const previewRef = useRef<HTMLElement>(null);
  function change() { setPreview(null); setAcknowledged(false); setNotice(""); setError(""); }
  function run(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    startTransition(async () => { setError(""); try { await operation(); } catch { setError("L’action n’a pas abouti. Vos saisies sont conservées ; réessayez."); } finally { locked.current = false; } });
  }
  function applySavedDraft(saved: SavKnowledgeDraft, activeTitle?: string) {
    setDraft(saved); setMode(saved.mode); setTargetItemId(saved.targetItemId ?? "");
    if (activeTitle) setTargetTitle(activeTitle); else if (saved.targetItemId !== targetItemId) setTargetTitle("Consultez la connaissance liée avant confirmation");
    setTitle(saved.title); setDocument(saved.document); setDelivery(saved.delivery ?? unclassifiedSavDelivery); setSources(saved.sources); setReason(saved.reason);
  }
  async function save(showPreview: boolean) {
    const result = await saveKnowledgeProposalAction({ ...(draft ? { draftId: draft.id, expectedRevision: draft.revision } : {}), mode, ...(mode === "improve" ? { targetItemId } : {}), title, document: cleanKnowledgeDocument(document), delivery, sources: sources.filter(source => source.label.trim() || source.ref.trim()), reason, ...(learningCandidateId ? { learningCandidateId } : {}) });
    if (!result.draft) { setError(result.error ?? "Enregistrement impossible."); return; }
    if (result.draft.status === "submitted" && result.draft.candidateId) { router.push(`/studio/sav/connaissances/${result.draft.candidateId}?kind=candidate`); return; }
    applySavedDraft(result.draft); setNotice("Brouillon interne enregistré. Aucune proposition n’est soumise sans votre confirmation.");
    window.history.replaceState(null, "", `/studio/sav/connaissances/proposer?draft=${encodeURIComponent(result.draft.id)}`);
    if (showPreview) {
      const response = await previewKnowledgeProposalAction(result.draft.id);
      setPreview(response.preview); setError(response.error ?? ""); setAcknowledged(false);
      if (response.preview) { applySavedDraft(response.preview.draft, response.preview.activeVersion?.title); requestAnimationFrame(() => previewRef.current?.focus()); }
    }
  }
  return <div className={styles.workspace}>
    <p className={styles.steps}>1. Choisir → 2. Rédiger et sourcer → 3. Aperçu → 4. Soumettre</p>
    <form className={styles.editor} onSubmit={event => { event.preventDefault(); run(() => save(true)); }}>
      <fieldset disabled={busy} className={styles.panel}>
        <legend>Type de proposition</legend>
        {learningCandidateId && <p className={styles.alert}>Cette proposition provient d’une résolution observée. L’origine apprentissage automatique et ses preuves sont conservées.</p>}
        <label className={styles.choice}><input type="radio" name="mode" value="new" checked={mode === "new"} onChange={() => { setMode("new"); setTargetItemId(""); change(); }}/>Nouvelle connaissance</label>
        <label className={styles.choice}><input type="radio" name="mode" value="improve" checked={mode === "improve"} onChange={() => { setMode("improve"); change(); }}/>Améliorer une connaissance existante</label>
        <label>Rechercher les connaissances proches<input type="search" value={q} maxLength={200} placeholder="Titre ou sujet de la procédure" onChange={event => setQ(event.target.value)}/></label>
        <div><button type="button" className="secondary" onClick={() => run(async () => { const result = await findKnowledgeAction(q); setMatches(result.rows); setSearched(true); setError(result.error ?? ""); })}>Rechercher avant de créer</button></div>
        {searched && matches.length === 0 && <p>Aucune connaissance active trouvée. La comparaison complète sera effectuée avant soumission.</p>}
        {matches.map(row => <div className={styles.choice} key={row.id}><div><Link href={knowledgeDetailUrl(row)} target="_blank" rel="noreferrer">{row.title}</Link><p className={styles.subtle}>{row.summary}</p>
          <button type="button" className="secondary" onClick={() => run(async () => { if (!row.itemId) return; const result = await loadKnowledgeTargetAction(row.itemId); if (!result.detail) { setError(result.error ?? "Cette connaissance n’est plus accessible."); return; } setMode("improve"); setTargetItemId(row.itemId); setTargetTitle(row.title); setTitle(row.title); setDelivery(result.detail.delivery ?? unclassifiedSavDelivery); if (result.detail.document) setDocument(result.detail.document); change(); })}>Améliorer cette connaissance</button></div></div>)}
        {mode === "improve" && <p className={targetItemId ? styles.subtle : styles.alert}>{targetItemId ? `Connaissance ciblée : ${targetTitle}. La version active restera utilisée jusqu’à une activation distincte.` : "Choisissez la connaissance à améliorer dans les résultats."}</p>}
        {mode === "improve" && targetItemId && <Link href={`/studio/sav/connaissances/${targetItemId}?kind=item`} target="_blank" rel="noreferrer">Consulter la connaissance ciblée</Link>}
      </fieldset>
      <fieldset disabled={busy} className={styles.panel}><legend>Proposition</legend>
        <label>Titre de la connaissance<input value={title} maxLength={200} onChange={event => { setTitle(event.target.value); change(); }}/></label>
        <p className={styles.subtle}>Conservez le titre du tutoriel lorsqu’il est la source. Rédigez une procédure générique, sans identité ni corps de mail client.</p>
        <KnowledgeEditor document={document} onChange={next => { setDocument(next); setDelivery(unclassifiedSavDelivery); change(); }} disabled={busy}/>
        <DeliveryEditor document={cleanKnowledgeDocument(document)} value={delivery} onChange={(next, doc) => { setDelivery(next); setDocument(doc); change(); }}/><label>Motif de la création ou de l’amélioration<textarea value={reason} maxLength={2000} onChange={event => { setReason(event.target.value); change(); }}/></label>
      </fieldset>
      <fieldset disabled={busy} className={styles.panel}><legend>Sources et preuves</legend>
        <p className={styles.subtle}>Ajoutez les références vérifiables qui justifient cette procédure. Les preuves privées restent dans le Studio.</p>
        {sources.map((source, index) => <div className={styles.sources} key={index}>
          <label>Nom de la source {index + 1}<input maxLength={300} value={source.label} onChange={event => { setSources(sources.map((value, position) => position === index ? { ...value, label: event.target.value } : value)); change(); }}/></label>
          <label>Référence de la source {index + 1}<input maxLength={1000} value={source.ref} placeholder="Lien ou référence Studio" onChange={event => { setSources(sources.map((value, position) => position === index ? { ...value, ref: event.target.value } : value)); change(); }}/></label>
          <button type="button" className="secondary" onClick={() => { setSources(sources.filter((_, position) => position !== index)); change(); }} aria-label={`Retirer la source ${index + 1}`}>Retirer</button>
        </div>)}
        <div><button type="button" className="secondary" disabled={sources.length >= 20} onClick={() => { setSources([...sources, { label: "", ref: "" }]); change(); }}>Ajouter une source</button></div>
      </fieldset>
      <div className={styles.row}><button type="button" className="secondary" disabled={busy} onClick={() => run(() => save(false))}>{busy ? "Enregistrement…" : "Enregistrer le brouillon"}</button><button className="primary" disabled={busy || mode === "improve" && !targetItemId}>{busy ? "Préparation…" : "Enregistrer et voir l’aperçu"}</button></div>
    </form>
    {error && <p className={`${styles.alert} ${styles.error}`} role="alert">{error}</p>}{notice && <p className={styles.alert} role="status">{notice}</p>}
    {preview && <section ref={previewRef} tabIndex={-1} className={styles.panel} aria-label="Aperçu avant soumission">
      <h2>Aperçu avant soumission</h2><p>Relisez la procédure et les sujets proches. La soumission crée une proposition à valider ; elle ne remplace aucune version active.</p>
      <div className={styles.comparison}><section><h3>Version active conservée</h3><pre className={styles.text}>{preview.activeVersion?.body ?? "Nouvelle connaissance : aucune version active."}</pre></section><KnowledgeProposalPreviewDocument draft={preview.draft} sources={preview.sources}/></div>
      {preview.missing.length > 0 && <div className={styles.alert}><h3>À compléter</h3><ul>{preview.missing.map(entry => <li key={entry}>{entry}</li>)}</ul></div>}
      <h3>Sujets proches à vérifier</h3>{preview.comparison.length === 0 ? <p>Aucun rapprochement automatique. Vérifiez les conditions et les éventuelles contradictions.</p> : preview.comparison.map(finding => <details key={`${finding.ref}:${finding.versionId}`}><summary>{finding.title} · {finding.signal === "duplicate" ? "Doublon possible" : "Sujet proche"}</summary><p>{finding.explanation}</p><pre className={styles.text}>{finding.body}</pre></details>)}
      <label className={styles.choice}><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy}/>J’ai vérifié les sources, la procédure complète et les connaissances proches.</label>
      <button className="primary" disabled={busy || !acknowledged || preview.missing.length > 0} onClick={() => run(async () => { const result = await submitKnowledgeProposalAction({ draftId: preview.draft.id, snapshot: preview.snapshot }); if (!result.candidate) { setError(result.error ?? "Soumission impossible."); return; } router.push(`/studio/sav/connaissances/${result.candidate.id}?kind=candidate`); router.refresh(); })}>{busy ? "Soumission…" : "Confirmer et soumettre à validation"}</button>
    </section>}
  </div>;
}
