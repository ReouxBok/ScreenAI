"use client";
import { useActionState } from "react";
import { runComparisonAction, type ComparisonActionState } from "./actions";
import styles from "../intake.module.css";
const initial: ComparisonActionState = { ok: false, message: "" };
export function ComparisonForm({ stage, ready, complete }: { stage: "sentinels" | "remaining"; ready: boolean; complete: boolean }) {
  const [state, submit, pending] = useActionState(runComparisonAction, initial);
  return <form action={submit} className={styles.choice}>
    <h2>{stage === "sentinels" ? "Dix sentinelles — maximum 5 USD" : "Cinquante suivants — maximum 20 USD au total"}</h2>
    <input type="hidden" name="stage" value={stage}/>
    <fieldset disabled={pending || !ready || complete}>
      {stage === "remaining" && <label><input type="checkbox" name="reviewed" value="confirmed" required/>
        J’ai vérifié les dix résultats contre les décisions attendues et je confirme la poursuite.</label>}
      <button type="submit">{complete ? "Plus aucun dossier à lancer dans cette phase" : "Comparer le prochain dossier"}</button>
    </fieldset>
    {!ready && <p>Les dix sentinelles doivent avoir un résultat exploitable avant cette phase.</p>}
    {pending && <p role="status">Comparaison en cours…</p>}
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    {state.code && <code>{state.code}</code>}
  </form>;
}
