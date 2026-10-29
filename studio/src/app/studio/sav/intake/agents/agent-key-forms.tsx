"use client";
import { useActionState } from "react";
import { createAgentKeyAction, revokeAgentKeyAction, type AgentKeyState } from "./actions";
import styles from "../intake.module.css";
const initial: AgentKeyState = { ok: false, message: "" };
export function CreateAgentKeyForm({ days, defaultDays }: { days: readonly number[]; defaultDays: number }) {
  const [state, submit, pending] = useActionState(createAgentKeyAction, initial);
  return <form action={submit} className={styles.choice}>
    <h2>Créer une clé</h2>
    <p>La clé agit en votre nom, avec exactement vos droits dans le Studio. Ne la partagez pas ; révoquez-la dès qu’elle ne sert plus.</p>
    <fieldset disabled={pending}>
      <label htmlFor="agent-key-name">Nom (par exemple « Claude Code — portable »)<input id="agent-key-name" name="name" minLength={3} maxLength={80} required/></label>
      <label htmlFor="agent-key-days">Durée de validité<select id="agent-key-days" name="days" defaultValue={String(defaultDays)}>
        {days.map(d => <option key={d} value={d}>{d} jours</option>)}</select></label>
      <button type="submit">Créer la clé</button>
    </fieldset>
    {pending && <p role="status">Création…</p>}
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    {state.secret && <p><code>{state.secret}</code></p>}
    {state.code && <details><summary>Diagnostic</summary><code>{state.code}</code></details>}
  </form>;
}
export function RevokeAgentKeyForm({ id }: { id: string }) {
  const [state, submit, pending] = useActionState(revokeAgentKeyAction, initial);
  return <form action={submit}><input type="hidden" name="id" value={id}/>
    <button type="submit" className="secondary" disabled={pending}>Révoquer</button>
    {state.message && <small role={state.ok ? "status" : "alert"}>{state.message}</small>}</form>;
}
