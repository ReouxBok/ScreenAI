"use client";

import { useState } from "react";
import { previewHubspotReviewAction, reviewKnowledgeAction } from "../actions";

type Comparison = NonNullable<Awaited<ReturnType<typeof previewHubspotReviewAction>>["comparison"]>;

export function HubspotReviewForm({ candidateId, revisionId, initialDocument }: { candidateId: string; revisionId: string; initialDocument: string }) {
  const [document, setDocument] = useState(initialDocument);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function preview() {
    setBusy(true); setComparison(null); setAcknowledged(false); setError("");
    const form = new FormData();
    form.set("candidateId", candidateId); form.set("revisionId", revisionId); form.set("document", document);
    try {
      const result = await previewHubspotReviewAction(form);
      setComparison(result.comparison); setError(result.error ?? "");
    } catch { setError("Comparaison indisponible. Réessayez avant de valider."); }
    finally { setBusy(false); }
  }
  return <form action={reviewKnowledgeAction}>
    <input type="hidden" name="candidateId" value={candidateId}/><input type="hidden" name="revisionId" value={revisionId}/>
    <details><summary>Corriger la connaissance avant validation (JSON métier, sans DOM)</summary>
      <label>Connaissance complète<textarea name="document" rows={16} value={document} readOnly={busy} onChange={(event) => { setDocument(event.target.value); setComparison(null); setAcknowledged(false); }} style={{ width: "100%" }}/></label>
    </details>
    <button type="button" className="secondary" disabled={busy} onClick={preview}>{busy ? "Comparaison en cours…" : "Actualiser la comparaison"}</button>
    {error && <p role="alert">{error}</p>}
    {comparison && <section aria-label="Comparaison du contenu corrigé">
      <p>{comparison.compared} versions comparées. Les rapprochements sont indicatifs : vérifiez les sources et les éventuelles contradictions.</p>
      {!comparison.findings.length && <p>Aucun rapprochement automatique. La revue métier reste nécessaire.</p>}
      {comparison.findings.map((finding) => <details key={`${finding.ref}:${finding.versionId}`}><summary>{finding.title} · {finding.signal === "duplicate" ? "Doublon possible" : "Sujet proche"}</summary><p>{finding.explanation}</p><small>{finding.ref} · {finding.versionId}</small><pre style={{ whiteSpace: "pre-wrap" }}>{finding.body}</pre></details>)}
      <details open><summary>Version actuelle / proposition corrigée</summary>
        <h3>Version actuelle du brouillon SAV</h3><pre style={{ whiteSpace: "pre-wrap" }}>{comparison.before || "Aucune projection existante."}</pre>
        <h3>Proposition corrigée</h3><pre style={{ whiteSpace: "pre-wrap" }}>{comparison.after}</pre>
      </details>
      <input type="hidden" name="comparisonSnapshot" value={comparison.snapshot}/>
      <label><input type="checkbox" name="comparisonAcknowledged" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}/>J’ai vérifié les sources, le contenu corrigé et la version actuelle. Mon motif explique la décision.</label>
    </section>}
    <label>Motif de la décision<input name="reason" required minLength={10}/></label>
    <button className="primary" name="decision" value="approve" disabled={busy || !comparison || !acknowledged}>Valider et préparer le brouillon SAV</button>
    <button className="secondary" name="decision" value="reject" disabled={busy}>Écarter le candidat</button>
  </form>;
}
