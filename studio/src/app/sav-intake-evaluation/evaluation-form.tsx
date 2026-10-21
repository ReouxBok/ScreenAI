"use client";
import { useState } from "react";

export default function EvaluationForm() {
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [result, setResult] = useState("");
  async function execute(start: boolean) {
    if (busy || (start && !file)) return;
    setBusy(true); setResult("");
    try {
      if (start && file!.size > 1_000_000) throw Error("Fichier trop volumineux (1 Mo maximum).");
      const response = await fetch("/api/internal/sav/intake-evaluation", { method: start ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
        ...(start ? { headers: { "Content-Type": "application/json" }, body: await file!.text() } : {}) });
      const data = await response.json(); setResult(JSON.stringify(data, null, 2));
    } catch { setResult("Lecture interrompue. Consultez l’état conservé ; ne lancez pas une nouvelle campagne."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Lancement du pilote">
    <label>Fichier privé autorisé (JSON, 1 Mo maximum) <input type="file" accept="application/json,.json" disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
    <p><button type="button" disabled={busy || !file} onClick={() => void execute(true)}>Lancer les trois pilotes sans action client</button>{" "}
      <button type="button" disabled={busy} onClick={() => void execute(false)}>Consulter le résultat conservé</button></p>
    <p role="status">{busy ? "Évaluation en cours…" : "Aucune exécution en cours dans cette page."}</p>
    {result && <pre aria-label="Résultat privé" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{result}</pre>}
  </section>;
}
