"use client";
import { useRef, useState } from "react";
import { ContinuityClientError, continuitySelection, continuityPreview, continuityCommit, type ContinuityPreview } from "./continuity-client";
import styles from "../intake.module.css";

/** Operator control only. GET is inert; no transfer is attempted on mount or
 * retried after an uncertain response. The canonical API enforces authority. */
export function ContinuityAdminForm() {
  const [source, setSource] = useState("");
  const [ids, setIds] = useState("");
  const [preview, setPreview] = useState<ContinuityPreview | null>(null);
  const [drained, setDrained] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
  const inFlight = useRef(false);
  const invalidate = () => { setPreview(null); setDrained(false); setMessage(""); };
  async function prepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || locked) return;
    inFlight.current = true; setBusy(true); setPreview(null); setDrained(false); setMessage("");
    try { setPreview(await continuityPreview(continuitySelection(source, ids))); }
    catch { setMessage("Aperçu refusé ou indisponible. Vérifiez la sélection, la session et la compatibilité ; aucun transfert demandé."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function confirm() {
    if (inFlight.current || locked || !preview || !drained) return;
    inFlight.current = true; setBusy(true); setMessage("");
    try { const result = await continuityCommit(preview, drained); setReceipt(result.id); setLocked(true);
      setMessage("Transfert enregistré. Aucun appel IA ni départ fournisseur effectué par cette commande. Vérifiez ensuite la reprise et ses résultats."); }
    catch (error) {
      if (error instanceof ContinuityClientError && !error.uncertain) {
        setPreview(null); setDrained(false); setMessage("Transfert refusé. Recontrôlez la session et les sources, puis rechargez le panneau avant de préparer un nouvel aperçu.");
      } else { setLocked(true); setMessage("Résultat du transfert incertain. Ne recommencez pas : vérifiez le reçu d’audit et les politiques des exécutions avant toute nouvelle commande."); }
    } finally {
      // A POST is single-shot for this mounted panel, even before React flushes
      // the locked state. Never unlock on an ambiguous network/commit result.
      setLocked(true); setBusy(false);
    }
  }
  return <section className={styles.choice} aria-labelledby="continuity-title">
    <h2 id="continuity-title">Reprendre les exécutions après une livraison compatible</h2>
    <p>Réservé aux administrateurs. Cette commande transfère seulement l’autorité des exécutions sélectionnées ; elle conserve leurs actions confirmées et ne les relance pas.</p>
    <form onSubmit={prepare}>
      <fieldset disabled={busy || locked}>
        <label htmlFor="continuity-source">Politique source<input id="continuity-source" required value={source} onChange={e => { setSource(e.target.value); invalidate(); }} /></label>
        <label htmlFor="continuity-executions">Identifiants des exécutions (100 maximum)<textarea id="continuity-executions" required rows={4} maxLength={4000} value={ids} onChange={e => { setIds(e.target.value); invalidate(); }} /></label>
        <button type="submit">Préparer l’aperçu de continuité</button>
      </fieldset>
    </form>
    {preview && <div>
      <dl><dt>Politique source</dt><dd>{preview.sourcePolicyId}</dd><dt>Politique cible</dt><dd>{preview.targetPolicyId}</dd><dt>Empreinte vérifiée</dt><dd>{preview.hash}</dd></dl>
      <ul>{preview.executionIds.map(id => <li key={id}>{id}</li>)}</ul>
      <label><input type="checkbox" checked={drained} disabled={busy || locked} onChange={e => setDrained(e.target.checked)} />J’atteste que les anciens hôtes et producteurs sont fermés et que le drainage Workflow, Queues et baux a été vérifié.</label>
      <button type="button" disabled={busy || locked || !drained} onClick={confirm}>Confirmer ce transfert exact</button>
    </div>}
    {busy && <p role="status">Commande en cours…</p>}
    {message && <p role={locked && !receipt ? "alert" : "status"}>{message}</p>}
    {receipt && <p>Reçu de continuité : <code>{receipt}</code></p>}
  </section>;
}
