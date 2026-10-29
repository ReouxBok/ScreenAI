"use client";
import { useActionState } from "react";
import type { ManualOtherBinding } from "@/lib/sav/intake/manual-other-classification";
import { classifyManualOtherAction } from "./manual-other-actions";
import styles from "./intake.module.css";

export function IntakeManualOtherForm({ binding, requestKey }: { binding: ManualOtherBinding; requestKey: string }) {
  const [state, action, pending] = useActionState(classifyManualOtherAction, { ok: false, message: "" });
  return <section className={styles.notice} aria-label="Classement humain dans Autres"><h2>Classer dans Autres</h2>
    <p>Après lecture du message affiché, vous pouvez ranger cette réponse automatique ou notification sans demande client dans Autres. C’est votre décision, sans verdict IA. Cette commande n’envoie aucun mail, ne marque aucun mail comme lu et ne modifie aucun ticket HubSpot. Une nouvelle réponse reviendra dans le flux.</p>
    <p>Le texte intégral et l’inventaire des pièces jointes sont liés à cette version du message. {binding.attachmentCount} pièce(s) jointe(s) figurent dans cet inventaire. Leur analyse IA n’est pas exigée pour votre décision ; ce classement ne les déclare pas lues par l’IA.</p>
    <form action={action}>
      {Object.entries(binding).map(([name, value]) => <input key={name} type="hidden" name={name} value={value ?? ""}/>)}
      <input type="hidden" name="requestKey" value={requestKey}/>
      <label>Motif du classement<textarea name="reason" required minLength={10} maxLength={2000} disabled={pending || state.ok}/></label>
      <label><input type="checkbox" name="confirmed" required disabled={pending || state.ok}/> J’ai lu le texte intégral et examiné l’inventaire des pièces jointes affiché. Je décide que ce message ne contient aucune demande client, financière ou de résiliation à traiter, en tenant compte des pièces jointes non analysées.</label>
      <button type="submit" disabled={pending || state.ok} aria-busy={pending}>Classer dans Autres</button>
      {pending && <p role="status">Classement en cours…</p>}
      {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  </section>;
}
