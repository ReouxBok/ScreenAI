"use client";
import { useActionState, useState } from "react";
import { saveIntakeChoice } from "./actions";
import styles from "./intake.module.css";
export type IntakeChoiceFormProps = {
  expected: { commandKey: string; threadId: string; messageId: string; runId: string; version: number; sourceHash: string; candidatesHash: string };
  contacts: string[]; tickets: string[]; classification: string;
};
export function IntakeChoiceForm({ expected, contacts, tickets, classification }: IntakeChoiceFormProps) {
  const [state, action, pending] = useActionState(saveIntakeChoice, { ok: false, message: "" });
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState("");
  const [ticket, setTicket] = useState("");
  const [category, setCategory] = useState(classification);
  return <form action={action} className={styles.choice}>
    {Object.entries(expected).map(([name, value]) => <input key={name} type="hidden" name={name} value={value}/>)}
    <h2>Corriger cette version</h2>
    <p>Votre choix reste conditionnel à la relecture des sources. Il ne donne aucun droit supplémentaire.</p>
    <fieldset disabled={pending || state.ok}>
      {contacts.length > 0 && <><legend>Fiche parmi les candidats équivalents</legend><div className={styles.radios}>
        {contacts.map(id => <label key={id}><input type="radio" name="contactId" value={id} checked={contact === id} onChange={() => setContact(id)}/> Fiche HubSpot {id}</label>)}
      </div></>}
      {tickets.length > 0 && <label htmlFor="intake-ticket">Ticket à examiner<select id="intake-ticket" name="ticketId" value={ticket} onChange={event => setTicket(event.target.value)}>
        <option value="">Conserver l’évaluation du sujet</option>{tickets.map(id => <option key={id} value={id}>Ticket {id}</option>)}
      </select><small>Le worker vérifie sa pertinence et son lien réel à la fiche.</small></label>}
      <label htmlFor="intake-classification">Classification<select id="intake-classification" name="classification" value={category} onChange={event => setCategory(event.target.value)}>
        <option value="support">Support</option><option value="finance">Facturation</option><option value="cancellation">Résiliation</option>
        <option value="partnership">Partenariat</option><option value="commercial">Commercial</option><option value="investor">Investisseur</option><option value="other">Autres</option>
      </select></label>
      <label htmlFor="intake-reason">Motif sourcé<textarea id="intake-reason" name="reason" value={reason} onChange={event => setReason(event.target.value)} required minLength={10} maxLength={2000} rows={3}
        placeholder="Indiquez les éléments vérifiés qui justifient cette correction."/></label>
      <div className={styles.actions}>
        {(contacts.length > 0 || tickets.length > 0) && <button type="submit" name="kind" value="select">Enregistrer la sélection</button>}
        <button type="submit" className="secondary" name="kind" value="classify">Corriger le classement</button>
        <button type="submit" className="secondary" name="kind" value="refuse">Refuser la proposition</button>
      </div>
    </fieldset>
    {pending && <p role="status">Enregistrement en cours…</p>}
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
  </form>;
}
