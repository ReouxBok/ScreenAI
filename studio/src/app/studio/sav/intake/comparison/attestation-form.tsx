"use client";
import { useActionState } from "react";
import { attestComparisonAction, type ComparisonActionState } from "./actions";
import styles from "../intake.module.css";
const initial: ComparisonActionState = { ok: false, message: "" };
/** Records a human verdict on one receipt. No customer, CRM or Gmail action exists here. */
export function AttestationForm({ campaignId, messageId, receiptSha256 }: { campaignId: string; messageId: string; receiptSha256: string }) {
  const [state, submit, pending] = useActionState(attestComparisonAction, initial);
  return <form action={submit} className={styles.choice}>
    <h2>Attestation humaine</h2>
    <input type="hidden" name="expectedCampaignId" value={campaignId}/>
    <input type="hidden" name="messageId" value={messageId}/>
    <input type="hidden" name="receiptSha256" value={receiptSha256}/>
    <fieldset disabled={pending || state.ok}>
      <label>Empreinte SHA-256 de l’attendu indépendant, figé avant le passage
        <input name="oracleSha256" required pattern="[a-fA-F0-9]{64}" autoComplete="off"/></label>
      <label><input type="radio" name="outcome" value="matches_oracle" required/> Le reçu correspond à l’attendu</label>
      <label><input type="radio" name="outcome" value="differs_from_oracle"/> Le reçu ne correspond pas à l’attendu</label>
      <label><input type="checkbox" name="confirmed" value="confirmed" required/> J’ai comparé ce reçu précis (demandes, citations, verdicts, note, propriétaire, étape) à l’attendu figé.</label>
      <button type="submit">Enregistrer l’attestation</button>
    </fieldset>
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    {state.code && <code>{state.code}</code>}
  </form>;
}
