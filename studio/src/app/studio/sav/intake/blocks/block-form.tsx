"use client";
import { useActionState, useState } from "react";
import { setBlockSwitchAction, type BlockSwitchAdminState } from "./actions";
import styles from "../intake.module.css";
const initial: BlockSwitchAdminState = { ok: false, message: "" };
const MODES = [
  ["off", "Arrêt", "Le bloc n’envoie rien ; ses dossiers attendent avec un motif visible (block_off)."],
  ["draft", "Brouillon", "La réponse est proposée à un humain pour validation, jamais envoyée seule."],
  ["auto", "Automatique", "Comportement actuel, dans la limite de l’interrupteur global de réponse automatique."],
] as const;
export function BlockSwitchForm({ blockId, mode, paused }: { blockId: string; mode: string; paused: boolean }) {
  const [state, submit, pending] = useActionState(setBlockSwitchAction, initial);
  const [nextMode, setMode] = useState(mode), [nextPaused, setPaused] = useState(paused), [reason, setReason] = useState("");
  const unchanged = nextMode === mode && nextPaused === paused;
  return <form action={submit} className={styles.choice}>
    <input type="hidden" name="blockId" value={blockId}/>
    <fieldset disabled={pending}>
      <legend>Mode du bloc</legend>
      {MODES.map(([value, label, help]) => <label key={value} htmlFor={`block-${blockId}-${value}`}>
        <span><input id={`block-${blockId}-${value}`} type="radio" name="mode" value={value} checked={nextMode === value} onChange={() => setMode(value)}/> {label}{value === mode ? " (actuel)" : ""}</span>
        <small>{help}</small></label>)}
      <label htmlFor={`block-${blockId}-paused`}><span><input id={`block-${blockId}-paused`} type="checkbox" name="paused" checked={nextPaused} onChange={event => setPaused(event.target.checked)}/> Pause du bloc</span>
        <small>En pause, le bloc n’envoie rien, quel que soit son mode (block_paused).</small></label>
      <label htmlFor={`block-${blockId}-reason`}>Motif<textarea id={`block-${blockId}-reason`} name="reason" rows={2} minLength={3} maxLength={500} required value={reason} onChange={event => setReason(event.target.value)}/></label>
      <button type="submit" disabled={unchanged || reason.trim().length < 3}>Enregistrer</button>
    </fieldset>
    {pending && <p role="status">Enregistrement…</p>}
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    {state.code && <details><summary>Diagnostic</summary><code>{state.code}</code></details>}
  </form>;
}
