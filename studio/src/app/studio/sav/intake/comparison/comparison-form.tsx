"use client";
import { useActionState } from "react";
import { runComparisonAction, type ComparisonActionState } from "./actions";
import styles from "../intake.module.css";
import { comparisonActionResponse, COMPARISON_RESPONSE_LOST } from "./action-response";
const guardedAction = (previous: ComparisonActionState, form: FormData) => comparisonActionResponse(runComparisonAction, previous, form);
const initial: ComparisonActionState = { ok: false, message: "" };
export function ComparisonForm({ stage, ready, complete }: { stage: "sentinels" | "remaining"; ready: boolean; complete: boolean }) {
  const [state, submit, pending] = useActionState(guardedAction, initial);
  const responseLost = state.code === COMPARISON_RESPONSE_LOST;
  return <form action={submit} className={styles.choice}>
    <h2>{stage === "sentinels" ? "Dix sentinelles — maximum 5 USD" : "Cinquante suivants — maximum 20 USD au total"}</h2>
    <input type="hidden" name="stage" value={stage}/>
    <fieldset disabled={pending || !ready || complete || responseLost}>
      {stage === "remaining" && <label><input type="checkbox" name="reviewed" value="confirmed" required/>
        J’ai vérifié les dix résultats contre les décisions attendues et je confirme la poursuite.</label>}
      <button type="submit">{complete ? "Plus aucun dossier à lancer dans cette phase" : "Comparer le prochain dossier"}</button>
    </fieldset>
    {!ready && <p>{stage === "sentinels" ? "Un résultat est incomplet, incertain ou encore en cours. Consultez le rapport avant de poursuivre." : "Les dix sentinelles doivent avoir un résultat exploitable avant cette phase, sans autre comparaison incomplète ou en cours."}</p>}
    {pending && <p role="status">Comparaison en cours…</p>}
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    {state.code && <code>{state.code}</code>}
    {responseLost && <button type="button" onClick={() => window.location.reload()}>Consulter le rapport sans relancer</button>}
  </form>;
}
