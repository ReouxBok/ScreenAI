"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { SAV_CASE_REQUEST_FAMILIES, SAV_CASE_SENSITIVE_FAMILIES } from "@/lib/sav/cases/case-types";
import { prepareTemporaryIncidentDraft } from "@/lib/knowledge/temporary-incident-draft";
import type { SavKnowledgeDraft } from "@/lib/knowledge/workspace-contract";
import { saveKnowledgeProposalAction } from "../workspace-actions";

const empty = { id: "", title: "", family: "usage", productArea: "", knownSince: "", validUntil: "", reply: "", source: "" };
const labels: Record<keyof typeof empty, string> = { id: "Référence courte (ex. incident-routines-novembre)", title: "Titre", family: "Famille concernée", productArea: "Zone produit",
  knownSince: "Début de validité (date ISO avec fuseau)", validUntil: "Fin de validité (date ISO avec fuseau, 30 jours maximum)", reply: "Texte proposé au support", source: "Origine de l’information" };

export function TemporaryIncidentForm() {
  const [input, setInput] = useState(empty), [preview, setPreview] = useState<ReturnType<typeof prepareTemporaryIncidentDraft> | null>(null);
  const [draft, setDraft] = useState<SavKnowledgeDraft | null>(null), [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [busy, startTransition] = useTransition(), locked = useRef(false);
  function prepare() {
    try { setPreview(prepareTemporaryIncidentDraft(input)); setError(""); }
    catch { setPreview(null); setError("Vérifiez la référence, les champs et les dates de validité. Ne présentez pas un correctif comme acquis."); }
  }
  function save() {
    if (!preview || locked.current || draft || uncertain) return;
    locked.current = true;
    startTransition(async () => {
      try {
        const result = await saveKnowledgeProposalAction(preview);
        if (result.draft) { setDraft(result.draft); setError(""); }
        else { setUncertain(true); setError("Résultat d’enregistrement non confirmé. Vos saisies sont conservées ; vérifiez la bibliothèque avant de recommencer."); }
      } catch { setUncertain(true); setError("Résultat d’enregistrement non confirmé. Vos saisies sont conservées ; vérifiez la bibliothèque avant de recommencer."); }
      finally { locked.current = false; }
    });
  }
  return <section aria-label="Proposer un incident temporaire">
    <h2>Proposer un incident temporaire</h2>
    <p>Crée une nouvelle proposition de connaissance en brouillon. La revue humaine reste obligatoire. L’incident n’est pas utilisé par l’agent SAV.</p>
    {Object.keys(empty).map(key => {
      const field = key as keyof typeof empty;
      const edit = (value: string) => { setInput(previous => ({ ...previous, [field]: value })); setPreview(null); setError(""); };
      return <label key={field}>{labels[field]}{field === "family"
        ? <select value={input[field]} disabled={busy || Boolean(draft) || uncertain} onChange={e => edit(e.target.value)}>{SAV_CASE_REQUEST_FAMILIES.filter(value => !(SAV_CASE_SENSITIVE_FAMILIES as readonly string[]).includes(value)).map(value => <option key={value} value={value}>{value}</option>)}</select>
        : field === "reply" ? <textarea rows={4} maxLength={2000} value={input[field]} disabled={busy || Boolean(draft) || uncertain} onChange={e => edit(e.target.value)}/>
          : <input value={input[field]} maxLength={field === "source" ? 500 : 200} disabled={busy || Boolean(draft) || uncertain} onChange={e => edit(e.target.value)}/>}</label>;
    })}
    <button type="button" disabled={busy || Boolean(draft) || uncertain} onClick={prepare}>Prévisualiser l’incident</button>
    {error ? <p role="alert">{error}</p> : null}
    {preview ? <section aria-label="Aperçu de l’incident proposé"><h3>{preview.title}</h3><p>{preview.document.temporaryIncident?.approvedReply}</p>
      <p>Validité proposée : {preview.document.temporaryIncident?.knownSince} → {preview.document.temporaryIncident?.validUntil}. Aucun correctif annoncé.</p>
      <p>La source vérifiable, la procédure et les informations de diffusion restent à compléter dans le brouillon avant soumission.</p>
      <button type="button" disabled={busy || Boolean(draft) || uncertain} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer la proposition en brouillon"}</button></section> : null}
    {uncertain ? <p><Link href="/studio/sav/connaissances?tab=proposals">Vérifier les brouillons de la bibliothèque</Link></p> : null}
    {draft ? <p role="status">Brouillon enregistré — non soumis, non publié, non activé. <Link href={`/studio/sav/connaissances/proposer?draft=${encodeURIComponent(draft.id)}`}>Compléter et relire la proposition</Link></p> : null}
  </section>;
}
