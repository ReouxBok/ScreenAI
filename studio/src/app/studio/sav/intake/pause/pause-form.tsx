"use client";
import { useActionState, useState } from "react";
import { setPauseAction, type PauseAdminState } from "./actions";
import styles from "../intake.module.css";
const initial: PauseAdminState = { ok: false, message: "" };
const LEVELS = [
  ["running", "Agent actif", "Analyse et actions selon la configuration."],
  ["actions_paused", "Suspendre les actions", "L’analyse continue, appels IA facturés ; aucune nouvelle action HubSpot ou Gmail ne part."],
  ["fully_paused", "Pause complète", "Ni analyse, ni appel IA, ni action. Les emails reçus attendent la reprise."],
] as const;
export function PauseForm({ current }: { current: string }) {
  const [state, submit, pending] = useActionState(setPauseAction, initial);
  const [level, setLevel] = useState(current === "running" ? "fully_paused" : "running"), [reason, setReason] = useState("");
  return <form action={submit} className={styles.choice}>
    <h2>Changer l’état de l’agent</h2>
    <p>Le changement s’applique au prochain passage, sans redéploiement. La configuration reste prioritaire : ce réglage ne peut que restreindre l’agent.</p>
    <fieldset disabled={pending}>
      <legend>Niveau</legend>
      {LEVELS.map(([value, label, help]) => <label key={value} htmlFor={`pause-${value}`}>
        <span><input id={`pause-${value}`} type="radio" name="level" value={value} checked={level === value} onChange={() => setLevel(value)}/> {label}{value === current ? " (actuel)" : ""}</span>
        <small>{help}</small></label>)}
      <label htmlFor="pause-reason">Motif<textarea id="pause-reason" name="reason" rows={2} minLength={3} maxLength={500} required value={reason} onChange={event => setReason(event.target.value)}/></label>
      <button type="submit" disabled={level === current || reason.trim().length < 3}>Enregistrer</button>
    </fieldset>
    {pending && <p role="status">Enregistrement…</p>}
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    {state.code && <details><summary>Diagnostic</summary><code>{state.code}</code></details>}
  </form>;
}
