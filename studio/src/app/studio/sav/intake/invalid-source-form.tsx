"use client";
import { useActionState } from "react";
import { classifyInvalidSourceAction } from "./actions";
import styles from "./intake.module.css";

export function IntakeInvalidSourceForm({ threadId, messageId, requestKey }: { threadId: string; messageId: string; requestKey: string }) {
  const [state, action, pending] = useActionState(classifyInvalidSourceAction, { ok: false, message: "" });
  return <section className={styles.notice} aria-label="Source du mail invalide"><h2>Source du mail invalide</h2>
    <p>L’adresse de l’expéditeur ou la liste des destinataires ne permet pas l’analyse. Après vérification du mail, tu peux le classer dans Autres : aucune analyse IA, aucun mail ni aucune action HubSpot. Une nouvelle réponse reviendra dans le flux.</p>
    <form action={action}>
      <input type="hidden" name="threadId" value={threadId}/>
      <input type="hidden" name="messageId" value={messageId}/>
      <input type="hidden" name="requestKey" value={requestKey}/>
      <label><input type="checkbox" name="confirmed" required disabled={pending || state.ok}/> J’ai vérifié que ce mail n’est pas une demande support.</label>
      <button type="submit" disabled={pending || state.ok} aria-busy={pending}>Classer dans Autres</button>
      {pending && <p role="status">Classement en cours…</p>}
      {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  </section>;
}
