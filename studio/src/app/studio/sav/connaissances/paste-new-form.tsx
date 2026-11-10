"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import type { SavKnowledgeDraft } from "@/lib/knowledge/workspace-contract";
import { preparePastedKnowledge, pasteNewLimits, type PasteNewPreparation } from "@/lib/knowledge/paste-new";
import { KnowledgeDocument } from "./knowledge-document";
import { saveKnowledgeProposalAction } from "./workspace-actions";

const statusLabel: Record<string, string> = { draft: "Brouillon interne (non soumis)", submitted: "Soumis à la revue" };

export function PasteNewForm() {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [preview, setPreview] = useState<PasteNewPreparation | null>(null);
  const [draft, setDraft] = useState<SavKnowledgeDraft | null>(null);
  const [savedKey, setSavedKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, startTransition] = useTransition();
  const locked = useRef(false);
  function edit(setter: (value: string) => void) { return (value: string) => { setter(value); setPreview(null); setNotice(""); setError(""); }; }
  function prepare() {
    try { setPreview(preparePastedKnowledge({ text, title, sourceLabel, sourceRef })); setError(""); }
    catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : "Texte non reconnu."); }
  }
  function save() {
    if (!preview || locked.current) return;
    if (draft && preview.fingerprint === savedKey) { setNotice("Ce contenu est déjà enregistré dans ce brouillon : aucune nouvelle version créée."); return; }
    locked.current = true;
    startTransition(async () => {
      try {
        const result = await saveKnowledgeProposalAction({ ...(draft ? { draftId: draft.id, expectedRevision: draft.revision } : {}), mode: "new", title: preview.title, document: preview.document, sources: preview.sources, reason: "Texte collé via l’assistant de création ; à relire avant soumission." });
        if (!result.draft) { setError(result.error ?? "Enregistrement impossible. Vos saisies sont conservées ; réessayez."); return; }
        setDraft(result.draft); setSavedKey(preview.fingerprint); setNotice("Brouillon enregistré. Il n’est ni soumis, ni publié, ni activé.");
      } catch { setError("L’action n’a pas abouti. Vos saisies sont conservées ; réessayez."); }
      finally { locked.current = false; }
    });
  }
  return <section aria-label="Ajout par texte collé">
    <label>Titre<input value={title} maxLength={pasteNewLimits.titleChars} onChange={event => edit(setTitle)(event.target.value)} placeholder="Facultatif si le texte commence par « # Titre »"/></label>
    <label>Texte de la connaissance<textarea value={text} rows={14} maxLength={pasteNewLimits.textChars} onChange={event => edit(setText)(event.target.value)} placeholder={"Objectif en une phrase\n1. Première étape\n2. Deuxième étape\n(ou rubriques ## Objectif, ## Procédure proposée…)"}/></label>
    <fieldset><legend>Origine</legend>
      <label>Libellé de la source<input value={sourceLabel} onChange={event => edit(setSourceLabel)(event.target.value)}/></label>
      <label>Référence (https://… ou knowledge-source:…)<input value={sourceRef} onChange={event => edit(setSourceRef)(event.target.value)}/></label>
    </fieldset>
    <button type="button" onClick={prepare} disabled={busy}>Prévisualiser</button>
    {error ? <p role="alert">{error}</p> : null}
    {preview ? <section aria-label="Aperçu du brouillon">
      <h2>{preview.title || "Sans titre"}</h2>
      {preview.missing.length ? <div role="status"><strong>À compléter avant soumission ou publication</strong> (le brouillon peut être enregistré) :<ul>{preview.missing.map(item => <li key={item}>{item}</li>)}</ul></div> : <p>Aucune information obligatoire manquante détectée.</p>}
      {preview.warnings.length ? <div role="alert"><strong>À revoir</strong><ul>{preview.warnings.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
      <KnowledgeDocument document={preview.document}/>
      <button type="button" onClick={save} disabled={busy}>{busy ? "Enregistrement…" : draft ? "Enregistrer les modifications du brouillon" : "Enregistrer le brouillon"}</button>
    </section> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {draft ? <p aria-label="État réel du brouillon">État : {statusLabel[draft.status] ?? draft.status} — révision {draft.revision}. <Link href={`/studio/sav/connaissances/proposer?draft=${encodeURIComponent(draft.id)}`}>Ouvrir le brouillon dans l’éditeur complet</Link></p> : null}
  </section>;
}
