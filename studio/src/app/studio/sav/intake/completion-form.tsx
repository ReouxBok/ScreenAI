"use client";
import { useActionState } from "react";
import { completeIntakeDossierAction } from "./actions";
import styles from "./intake.module.css";

export function IntakeCompletionForm({ threadId, messageId, requestKey }: { threadId: string; messageId: string; requestKey: string }) {
  const [state, action, pending] = useActionState(completeIntakeDossierAction, { ok: false, message: "" });
  return <section className={styles.notice} aria-label="Dossier déjà traité"><h2>Déjà traité ?</h2>
    <p>Range ce dossier dans Terminés. Aucun mail envoyé, aucune fermeture HubSpot ni validation d’apprentissage. Une nouvelle réponse du client reviendra dans le flux.</p>
    <form action={action}>
      <input type="hidden" name="threadId" value={threadId}/>
      <input type="hidden" name="messageId" value={messageId}/>
      <input type="hidden" name="requestKey" value={requestKey}/>
      <label><input type="checkbox" name="confirmed" required disabled={pending || state.ok}/> J’ai déjà traité cette demande.</label>
      <button type="submit" disabled={pending || state.ok} aria-busy={pending}>Marquer traité hors Studio</button>
      {pending && <p role="status">Classement administratif en cours…</p>}
      {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  </section>;
}
