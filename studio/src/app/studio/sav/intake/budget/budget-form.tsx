"use client";
import { useActionState, useState } from "react";
import { setBudgetAction, type BudgetAdminState } from "./actions";
import styles from "../intake.module.css";
const initial: BudgetAdminState = { ok: false, message: "" };
export function BudgetForm({ ceilingUsd, hasOverride }: { ceilingUsd: string; hasOverride: boolean }) {
  const [state, submit, pending] = useActionState(setBudgetAction, initial);
  const [usd, setUsd] = useState(""), [reason, setReason] = useState("");
  return <form action={submit} className={styles.choice}>
    <h2>Changer le plafond quotidien</h2>
    <p>Maximum {ceilingUsd} par jour. Le changement s’applique au prochain dossier, sans redéploiement. Les dépenses et réservations déjà comptées restent comptées.</p>
    <fieldset disabled={pending}>
      <label htmlFor="budget-usd">Plafond quotidien (USD)<input id="budget-usd" name="usd" inputMode="decimal" placeholder="5" value={usd} onChange={event => setUsd(event.target.value)}/></label>
      <label htmlFor="budget-reason">Motif<textarea id="budget-reason" name="reason" rows={2} minLength={3} maxLength={500} required value={reason} onChange={event => setReason(event.target.value)}/></label>
      <button type="submit" name="mode" value="set" disabled={!usd}>Enregistrer ce plafond</button>
      {hasOverride && <button type="submit" name="mode" value="reset" className="secondary">Revenir à la configuration</button>}
    </fieldset>
    {pending && <p role="status">Enregistrement…</p>}
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    {state.code && <details><summary>Diagnostic</summary><code>{state.code}</code></details>}
  </form>;
}
