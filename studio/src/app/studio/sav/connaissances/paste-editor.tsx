"use client";

import { useState } from "react";
import type { CanonicalKnowledge } from "@/lib/knowledge/contracts";
import { parsePastedKnowledge } from "@/lib/knowledge/paste-document";
import { KnowledgeDocument } from "./knowledge-document";
import styles from "./workspace.module.css";

export function PasteEditor({ document, title, onPendingChange, onApply }: { document: CanonicalKnowledge; title: string; onPendingChange: (pending: boolean) => void; onApply: (result: ReturnType<typeof parsePastedKnowledge>) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ base: CanonicalKnowledge; result: ReturnType<typeof parsePastedKnowledge> } | null>(null);
  function updateText(value: string) {
    setText(value);
    setPreview(null);
    setError("");
    onPendingChange(Boolean(value.trim()));
  }
  return <details className={styles.panel}>
    <summary>Coller une fiche complète</summary>
    <label>Ou ouvrir un fichier Markdown ou texte<input type="file" accept=".md,.txt,text/plain,text/markdown" onChange={async event => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      event.currentTarget.value = "";
      if (file.size > 400000) { setError("Choisissez une fiche de moins de 400 Ko."); return; }
      try { updateText(await file.text()); } catch { setError("Impossible de lire ce fichier."); }
    }}/></label>
    <label>Texte de la fiche<textarea rows={8} value={text} placeholder={"# Titre de la fiche\n## Objectif\n…\n## Procédure proposée\n1. …"} onChange={event => updateText(event.target.value)}/></label>
    <p className={styles.subtle}>Les rubriques présentes remplacent celles du formulaire. Les sources se vérifient dans « Sources et preuves ».</p>
    <button type="button" className="secondary" disabled={!text.trim()} onClick={() => {
      try { setPreview({ base: document, result: parsePastedKnowledge(text, document) }); setError(""); }
      catch (err) { setPreview(null); setError(err instanceof Error ? err.message : "Impossible de lire la fiche."); }
    }}>Prévisualiser le texte collé</button>
    {text && <button type="button" className="secondary" onClick={() => updateText("")}>Écarter le texte importé</button>}
    {error && <p role="alert" className={styles.alert}>{error}</p>}
    {preview?.base === document && <section aria-label="Aperçu du texte collé">
      <h3>{title || preview.result.title || "Fiche à compléter"}</h3><KnowledgeDocument document={preview.result.document}/>
      <button type="button" className="primary" onClick={() => { onApply(preview.result); updateText(""); }}>Appliquer au formulaire</button>
    </section>}
  </details>;
}
