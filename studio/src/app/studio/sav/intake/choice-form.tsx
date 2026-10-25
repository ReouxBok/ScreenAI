"use client";
import { useActionState, useRef, useState, useSyncExternalStore } from "react";
import type { CrmDisplay } from "@/lib/sav/intake/crm-display";
import { orientationLabels, orientationPreview, orientationSupportsTickets, type Orientation } from "@/lib/sav/intake-ux/orientation";
import { lookupUxOrientation, submitUxOrientation, type OrientationState } from "./orientation-actions";
import styles from "./intake.module.css";

export type IntakeChoiceFormProps = {
  expected: { commandKey: string; threadId: string; messageId: string; runId: string; version: number; sourceHash: string; candidatesHash: string };
  contacts: string[]; tickets: string[]; classification: string; display?: CrmDisplay;
  actorId?: string; selectedContactId?: string; selectedTicketId?: string;
};
type Draft = { commandKey: string; reason: string; contactId: string; ticketId: string; classification: string; intent: "orient" | "refuse"; submission?: OrientationState["status"]; eventId?: string };
const memory = new Map<string, string>();
const changeEvent = "sav-intake-draft-change";
function subscribe(notify: () => void) { window.addEventListener(changeEvent, notify); return () => window.removeEventListener(changeEvent, notify); }
function stored(key: string) { try { return sessionStorage.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } }
function parseDraft(raw: string | null, initial: Draft, props: IntakeChoiceFormProps): Draft {
  if (!raw || raw.length > 5000) return initial;
  try {
    const d = JSON.parse(raw);
    if (typeof d.commandKey !== "string" || !/^[0-9a-f-]{36}$/i.test(d.commandKey) || typeof d.reason !== "string" || d.reason.length > 2000
      || !["orient", "refuse"].includes(d.intent) || typeof d.classification !== "string" || d.classification !== "" && !Object.hasOwn(orientationLabels, d.classification)
      || typeof d.contactId !== "string" || typeof d.ticketId !== "string"
      || d.submission !== undefined && !["idle", "recorded", "unknown", "rejected"].includes(d.submission)
      || d.eventId !== undefined && (typeof d.eventId !== "string" || !/^[0-9a-f-]{36}$/i.test(d.eventId))
      || d.contactId && !props.contacts.includes(d.contactId) || d.ticketId && !props.tickets.includes(d.ticketId)) return initial;
    return d;
  } catch { return initial; }
}
export function IntakeChoiceForm(props: IntakeChoiceFormProps) {
  const { expected, contacts, tickets, classification, display } = props;
  const storageKey = `sav:intake:orientation:v1:${props.actorId ?? "staff"}:${expected.messageId}:${expected.runId}:${expected.sourceHash}`;
  const initial: Draft = { commandKey: expected.commandKey, reason: "", contactId: contacts.includes(props.selectedContactId ?? "") ? props.selectedContactId! : "",
    ticketId: tickets.includes(props.selectedTicketId ?? "") ? props.selectedTicketId! : "", classification: Object.hasOwn(orientationLabels, classification) ? classification : "", intent: "orient" };
  const raw = useSyncExternalStore(subscribe, () => stored(storageKey), () => null);
  const draft = parseDraft(raw, initial, props), submitting = useRef(false);
  const [inspection, setInspection] = useState<{ message: string; eventId?: string; retrySame?: boolean }>({ message: "" });
  const [checking, setChecking] = useState(false);
  function edit(patch: Partial<Draft>) {
    const next = JSON.stringify({ ...draft, ...patch }); memory.set(storageKey, next);
    try { sessionStorage.setItem(storageKey, next); } catch { /* In-memory draft survives local validation failures. */ }
    window.dispatchEvent(new Event(changeEvent));
  }
  const [state, action, pending] = useActionState(async (previous: OrientationState) => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...expected, ...draft })) form.set(key, String(value));
    try { const result = await submitUxOrientation(previous, form); edit({ submission: result.status, eventId: result.eventId }); return result; }
    catch { edit({ submission: "unknown" }); return { status: "unknown" as const, message: "La connexion a été interrompue. Vérifiez la même commande avant toute nouvelle soumission ; votre saisie est conservée." }; }
    finally { submitting.current = false; }
  }, { status: "idle", message: "" } as OrientationState);
  const recorded = state.status === "recorded" || draft.submission === "recorded" || Boolean(inspection.eventId);
  const unknown = state.status === "unknown" || draft.submission === "unknown";
  const frozen = pending || recorded || unknown;
  const eventId = state.eventId ?? inspection.eventId ?? draft.eventId;
  async function inspect() {
    setChecking(true);
    try {
      const result = await lookupUxOrientation({ commandKey: draft.commandKey, threadId: expected.threadId, messageId: expected.messageId });
      setInspection(!result.readable ? { message: "Lecture de la commande impossible. Conservez cette référence et rechargez le dossier avant toute nouvelle demande." }
        : result.receipt ? { eventId: result.receipt.eventId, message: `Commande retrouvée : ${result.receipt.state === "consumed" ? "revalidation terminée ; vérifiez les effets dans le dossier" : result.receipt.state === "waiting" ? "preuves à compléter" : result.receipt.state === "refused" ? "refus conservé" : "en attente de revalidation"}.` }
          : { message: "Aucune commande retrouvée pour cette référence. Vous pouvez renvoyer la même demande, sans changer sa clé ni ses champs.", retrySame: true });
    } catch { setInspection({ message: "La connexion ne permet pas de vérifier cette commande. Conservez la référence ; aucun renvoi automatique." }); }
    finally { setChecking(false); }
  }
  return <form action={action} className={styles.choice} aria-label="Modifier l’orientation" onSubmit={event => {
    if (submitting.current || pending || recorded || unknown && !inspection.retrySame) { event.preventDefault(); return; }
    submitting.current = true;
    edit({ submission: "unknown" }); // Persist the exact frozen draft BEFORE dispatch, including refresh during the request.
  }}>
    <h2>Modifier l’orientation</h2>
    {Object.entries(expected).map(([name, value]) => <input key={name} type="hidden" name={name} value={name === "commandKey" ? draft.commandKey : value}/>)}
    <p>Une seule décision conserve la catégorie et les cibles visibles. Elle reste conditionnelle à la relecture des sources et ne donne aucun droit supplémentaire.</p>
    <fieldset disabled={frozen}>
      <label htmlFor="intake-intent">Décision<select id="intake-intent" name="intent" aria-label="Décision" value={draft.intent} onChange={event => edit({ intent: event.target.value as Draft["intent"] })}>
        <option value="orient">Corriger l’orientation</option><option value="refuse">Arrêter cette proposition</option>
      </select></label>
      {draft.intent === "orient" && <>
        <label htmlFor="intake-classification">Catégorie<select id="intake-classification" name="classification" aria-label="Catégorie" required value={draft.classification} onChange={event => edit({ classification: event.target.value,
          ...(!orientationSupportsTickets(event.target.value) ? { contactId: "", ticketId: "" } : {}) })}>
          <option value="" disabled>Choisir la catégorie</option>
          {Object.entries(orientationLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        {orientationSupportsTickets(draft.classification) && contacts.length > 0 && <label htmlFor="intake-contact">Fiche candidate<select id="intake-contact" name="contactId" aria-label="Fiche candidate" value={draft.contactId} onChange={event => edit({ contactId: event.target.value })}>
          <option value="">Conserver l’évaluation des fiches</option>{contacts.map(id => <option key={id} value={id}>{display?.contacts[id]?.label ?? "Fiche — nom indisponible"}</option>)}
        </select></label>}
        {orientationSupportsTickets(draft.classification) && tickets.length > 0 && <label htmlFor="intake-ticket">Ticket à examiner<select id="intake-ticket" name="ticketId" aria-label="Ticket à examiner" value={draft.ticketId} onChange={event => edit({ ticketId: event.target.value })}>
          <option value="">Conserver l’évaluation du sujet</option>{tickets.map(id => <option key={id} value={id}>{display?.tickets[id]?.label ?? "Ticket — sujet indisponible"}</option>)}
        </select></label>}
      </>}
      <label htmlFor="intake-reason">Motif de la décision<textarea id="intake-reason" name="reason" value={draft.reason} onChange={event => edit({ reason: event.target.value })} required minLength={10} maxLength={2000} rows={3}/></label>
      <p className={styles.consequence}>{orientationPreview({ ...draft, classification: draft.classification as Orientation["classification"] })}</p>
    </fieldset>
    {raw && !recorded && !pending && !unknown && <p>Brouillon local conservé pour ce message et cette version. Il n’est pas encore transmis.</p>}
    {unknown && !pending && !recorded && <p role="status">Demande figée : l’enregistrement doit être rapproché avant de modifier ou renvoyer ces champs.</p>}
    <button type="submit" disabled={pending || recorded || unknown && !inspection.retrySame} aria-busy={pending}>
      {draft.intent === "refuse" ? "Arrêter la proposition" : inspection.retrySame ? "Renvoyer la même demande" : "Enregistrer l’orientation"}
    </button>
    {pending && <p role="status">Enregistrement de cette décision en cours…</p>}
    {state.message && <p role={state.status === "recorded" ? "status" : "alert"}>{state.message}</p>}
    <p><small>Référence de demande : {draft.commandKey}</small></p>
    {eventId && <p role="status">Commande enregistrée : {eventId}. Consultez ses effets confirmés dans le dossier.</p>}
    {(unknown || recorded) && <button type="button" className="secondary" onClick={inspect} disabled={checking} aria-busy={checking}>Vérifier la commande enregistrée</button>}
    {inspection.message && <p role="status">{inspection.message}</p>}
    <p><small>Le motif est conservé avec la correction. Il n’ajoute pas de contexte libre à l’analyse de l’agent ; utilisez le champ distinct « Informations pour l’agent » lorsqu’il est disponible.</small></p>
  </form>;
}
