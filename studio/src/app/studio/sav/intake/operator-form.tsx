"use client";
import { useActionState, useRef, useState, useSyncExternalStore } from "react";
import type { OperatorCommand, OperatorReceipt, OperatorStep } from "@/lib/sav/intake-ux/operator-contract";
import type { IntakeOperatorInformation } from "@/lib/sav/intake/operator-information-contract";
import { lookupOperatorAction, submitOperatorAction, type OperatorFormState } from "./operator-actions";
import styles from "./intake.module.css";
type Binding = Pick<OperatorCommand, "threadId" | "messageId" | "runId" | "version" | "sourceHash">;
const memory = new Map<string, string>(), eventName = "sav-operator-draft";
const read = (key: string) => { try { return sessionStorage.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } };
function subscribe(fn: () => void) { window.addEventListener(eventName, fn); return () => window.removeEventListener(eventName, fn); }
type Draft = { requestKey: string; text: string; submission: OperatorFormState["status"]; expectedInformationId: string | null; binding:Binding };
const labels: Record<OperatorStep, string> = { reads: "Reprendre les lectures manquantes", analysis: "Poursuivre l’analyse nécessaire", admission: "Vérifier l’admission du plan existant", execution: "Poursuivre l’exécution existante", verify_only: "Vérifier uniquement les résultats incertains", reanalysis: "Nouvelle analyse demandée" };
function receiptText(r: OperatorReceipt) {
  return r.consumedAt ? "Ces informations ont été lues par une analyse validée. Consultez sa décision et les effets séparément."
    : r.state === "consumed" ? "Nouvelle analyse enregistrée dans l’historique. Consultez la décision et les effets séparément."
      : r.state === "finished" ? r.outcome === "confirmed" ? "Exécution confirmée par le moteur. Consultez les effets vérifiés dans le dossier." : r.outcome === "checked" ? "Vérification effectuée ; consultez les résultats et les éventuelles incertitudes restantes." : r.outcome === "observed" ? "Analyse enregistrée. Les effets restent à vérifier séparément." : "La reprise s’est arrêtée ou reste en attente. Consultez sa cause dans le diagnostic."
        : r.state === "waiting" ? "La demande reste en attente : consultez le diagnostic."
          : r.state === "reading" || r.state === "running" ? "Traitement en cours, résultats encore à vérifier." : "Demande enregistrée, en attente du traitement existant.";
}
function OperatorRequestForm({ binding, actorId, kind, requestKey, enabled, unavailableReason, step, information,serverRequest }: {
  binding: Binding; actorId: string; kind: OperatorCommand["kind"]; requestKey: string; enabled: boolean; unavailableReason: string;
  step?: { step: OperatorStep; nextAt?: string } | null; information: IntakeOperatorInformation | null;serverRequest?:{command:OperatorCommand;receipt:OperatorReceipt};
}) {
  const key = `sav:intake:operator:v1:${actorId}:${binding.messageId}:${kind}`;
  const raw = useSyncExternalStore(subscribe, () => read(key), () => null);
  const initial: Draft = { requestKey, text: kind === "information" ? information?.text ?? "" : "", submission: "idle", expectedInformationId: information?.id ?? null,binding };
  if(serverRequest){const c=serverRequest.command;Object.assign(initial,{requestKey:c.requestKey,text:c.kind==="information"?c.information??"":c.reason,submission:"recorded",expectedInformationId:c.expectedInformationId??null,binding:{threadId:c.threadId,messageId:c.messageId,runId:c.runId,version:c.version,sourceHash:c.sourceHash}});}
  let draft = initial;
  try { const saved = raw && JSON.parse(raw); if (saved && /^[0-9a-f-]{36}$/i.test(saved.requestKey) && typeof saved.text === "string" && saved.text.length <= 2000 && ["idle", "recorded", "unknown", "rejected"].includes(saved.submission) && saved.binding?.threadId===binding.threadId && saved.binding?.messageId===binding.messageId && /^[0-9a-f-]{36}$/i.test(saved.binding?.runId) && /^[a-f0-9]{64}$/.test(saved.binding?.sourceHash) && Number.isSafeInteger(saved.binding?.version) && (saved.expectedInformationId === null || typeof saved.expectedInformationId === "string" && /^[0-9a-f-]{36}$/i.test(saved.expectedInformationId))) draft = saved; } catch { /* Corrupt local storage never becomes authority. */ }
  const active = useRef(false), [checking, setChecking] = useState(false), [lookup, setLookup] = useState<{ text: string; receipt?: OperatorReceipt; retry?: boolean }>({ text: "" });
  const persist = (patch: Partial<Draft>) => { const value = JSON.stringify({ ...draft, ...patch }); memory.set(key, value); try { sessionStorage.setItem(key, value); } catch { /* Local fallback. */ } window.dispatchEvent(new Event(eventName)); };
  const [state, action, pending] = useActionState(async (previous: OperatorFormState) => {
    const form = new FormData();
    for (const [name, value] of Object.entries({ ...draft.binding, requestKey: draft.requestKey, kind,
      reason: kind === "information" ? "Informations complémentaires fournies par l’opérateur pour une nouvelle analyse." : draft.text,
      ...(kind === "information" ? { information: draft.text, expectedInformationId: draft.expectedInformationId ?? "" } : {}) })) form.set(name, String(value));
    try { const result = await submitOperatorAction(previous, form); persist({ submission: result.status }); return result; }
    catch { persist({ submission: "unknown" }); return { status: "unknown" as const, message: "Réponse perdue. Vérifiez la référence conservée avant toute nouvelle soumission." }; }
    finally { active.current = false; }
  }, { status: "idle", message: "" } as OperatorFormState);
  const recorded = draft.submission === "recorded" || Boolean(lookup.receipt);
  const unknown = draft.submission === "unknown", staleDraft = draft.binding.runId!==binding.runId || draft.binding.sourceHash!==binding.sourceHash, frozen = pending || recorded || unknown;
  const title = kind === "resume" ? "Reprendre le traitement" : kind === "reanalyse" ? "Refaire l’analyse" : "Informations pour l’agent";
  const receipt = lookup.receipt ?? (state.receipt?.id===draft.requestKey?state.receipt:undefined) ?? (serverRequest?.receipt.id===draft.requestKey?serverRequest.receipt:undefined);
  async function inspect() {
    setChecking(true);
    try { const result = await lookupOperatorAction({ requestKey: draft.requestKey, threadId: binding.threadId, messageId: binding.messageId });
      setLookup(!result.readable ? { text: "Lecture impossible. Conservez la référence ; aucun renvoi automatique." }
        : result.receipt ? { text: receiptText(result.receipt), receipt: result.receipt }
          : { text: "Aucune demande retrouvée. Vous pouvez renvoyer exactement la même demande, sans modifier les champs.", retry: true });
    } catch { setLookup({ text: "Vérification indisponible. Conservez la référence ; aucun renvoi automatique." }); }
    finally { setChecking(false); }
  }
  return <form action={action} className={styles.choice} aria-label={title} onSubmit={e => {
    if (!enabled || staleDraft && !recorded && !unknown || active.current || pending || recorded || unknown && !lookup.retry) { e.preventDefault(); return; }
    active.current = true; persist({ submission: "unknown" });
  }}>
    <h2>{title}</h2>
    {kind === "resume" ? <p>{step ? labels[step.step] : "Aucune étape disponible."} Les effets confirmés restent conservés. Un résultat incertain sera seulement vérifié, sans renvoi.</p>
      : <p>{kind === "information" ? "Ce texte est un contexte humain, sans permission supplémentaire. Son enregistrement demande une nouvelle analyse de ce message." : "Cette demande relit le message et son contexte. L’ancienne décision et les corrections humaines sont conservées."} Les actions de ticket autorisées peuvent suivre après contrôle. Aucun mail ne sera envoyé par cette réinvestigation. Les tentatives et le budget existants restent conservés.</p>}
    {step?.nextAt && kind === "resume" && <p>Reprise admissible à partir de {new Date(step.nextAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}, sous réserve des contrôles.</p>}
    <label>{kind === "information" ? "Informations complémentaires" : "Motif de la demande"}<textarea aria-label={kind === "information" ? "Informations complémentaires" : `Motif — ${title}`} value={draft.text}
      onChange={e => persist({ text: e.target.value })} required minLength={kind === "information" ? 1 : 10} maxLength={2000} rows={3} disabled={!enabled || frozen}/></label>
    {!enabled && <p>{unavailableReason}</p>}
    {staleDraft && !recorded && !unknown && <p role="status">Cette saisie concernait une ancienne version. Préparez-la explicitement pour la version actuelle avant de l’envoyer.</p>}
    {raw && !pending && !recorded && !unknown && <p>Saisie locale conservée ; elle n’est pas transmise.</p>}
    {unknown && <p role="status">Demande figée jusqu’au rapprochement de sa référence.</p>}
    <button type="submit" className={kind==="resume"?undefined:"secondary"} disabled={!enabled || staleDraft && !recorded && !unknown || pending || recorded || unknown && !lookup.retry} aria-busy={pending}>{lookup.retry ? "Renvoyer la même demande" : kind === "information" ? "Enregistrer et refaire l’analyse" : title}</button>
    {pending && <p role="status">Enregistrement en cours…</p>}
    {state.message && draft.submission!=="idle" && <p role={state.status === "recorded" ? "status" : "alert"}>{state.message}</p>}
    <p><small>Référence : {draft.requestKey}</small></p>
    {receipt && <p role="status">{receiptText(receipt)}</p>}
    {(recorded || unknown) && <button type="button" className="secondary" disabled={checking} onClick={inspect} aria-busy={checking}>Vérifier cette demande</button>}
    {lookup.text && <p role="status">{lookup.text}</p>}
    {enabled&&!pending&&!unknown&&(staleDraft&&!recorded||receipt&&["consumed","finished","waiting"].includes(receipt.state))&&<button type="button" className="secondary" onClick={()=>{persist({requestKey:crypto.randomUUID(),submission:"idle",binding,expectedInformationId:information?.id??null});setLookup({text:""});}}>Préparer une nouvelle demande sur la version actuelle</button>}
  </form>;
}
export function IntakeOperatorActions({ binding, actorId, requestKeys, panel }: { binding: Binding; actorId: string; requestKeys: Record<OperatorCommand["kind"], string>;
  panel: { information: IntakeOperatorInformation | null; requests?:Partial<Record<OperatorCommand["kind"],{command:OperatorCommand;receipt:OperatorReceipt}>>; allowResume: boolean; allowReanalysis: boolean; allowInformation: boolean; unavailableReason: string; resume: { step: OperatorStep; nextAt?: string } | null } }) {
  return <section aria-label="Poursuite du dossier">
    {panel.information && <div className={styles.notice}><h2>Informations enregistrées · version {panel.information.revision}</h2><p>{panel.information.text}</p><small>Enregistrées le {new Date(panel.information.at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}. La sauvegarde ne prouve pas leur lecture par l’analyse ; vérifiez la demande correspondante.</small></div>}
    {(["resume", "reanalyse", "information"] as const).map(kind => <OperatorRequestForm key={kind} binding={binding} actorId={actorId} kind={kind} requestKey={requestKeys[kind]} information={panel.information}
      serverRequest={panel.requests?.[kind]} enabled={kind === "resume" ? panel.allowResume : kind === "reanalyse" ? panel.allowReanalysis : panel.allowInformation} unavailableReason={panel.unavailableReason} step={panel.resume}/>) }
  </section>;
}
