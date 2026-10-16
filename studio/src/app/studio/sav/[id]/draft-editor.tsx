"use client";
import { useState } from "react";
import { reviewDraftAction, saveHumanDraftAction, sendStudioReplyAction } from "../actions";

type Props = {threadId:string;messageId:string;decisionId:string;agentRunId:string;sourceHash:string;verdictId:string|null;
  original:string|null;current:{id:string;text:string;stale:boolean;status:string;origin:string}|null;currentDraftId:string|null;
  acceptedDraftId:string|null;accepted:boolean;rejected:boolean;reason:string;reasons:string[];reasonLabels:Array<[string,string]>;
  sendAllowed:boolean;sendDisabledReason?:string|null;replyState?:string|null};
export function DraftEditor(p:Props) {
  const initial=p.current?.origin === "human" ? p.current.text : p.original ?? "";
  const [text,setText]=useState(initial);
  const dirty=text!==initial, manual=p.current?.origin === "human" ? p.current : null;
  const busy=Boolean(p.replyState), needsSave=dirty || Boolean(manual?.stale) || manual?.status === "abandoned";
  return <>
    <form action={saveHumanDraftAction}>
      <input type="hidden" name="threadId" value={p.threadId}/><input type="hidden" name="messageId" value={p.messageId}/><input type="hidden" name="expectedDraftId" value={p.currentDraftId ?? ""}/>
      <label>Corriger le brouillon<textarea name="text" required maxLength={10000} rows={10} value={text} disabled={busy} onChange={e=>setText(e.target.value)}/></label>
      <button className="secondary" disabled={busy || !text.trim() || Boolean(manual && !needsSave)}>Enregistrer ma version</button>
      <p>{needsSave ? "Enregistrez cette version avant de l’accepter ou de l’envoyer. La validation précédente ne vaut pas pour un texte modifié." : "Enregistrer conserve une version humaine ; cela n’accepte ni n’envoie la réponse."}</p>
    </form>
    {p.original && <details><summary>Brouillon initial de l’IA</summary><pre>{p.original}</pre></details>}
    <form action={reviewDraftAction}>
      <input type="hidden" name="threadId" value={p.threadId}/><input type="hidden" name="messageId" value={p.messageId}/><input type="hidden" name="decisionId" value={p.decisionId}/><input type="hidden" name="agentRunId" value={p.agentRunId}/>
      <input type="hidden" name="sourceHash" value={p.sourceHash}/><input type="hidden" name="verdictId" value={p.verdictId ?? ""}/><input type="hidden" name="draftId" value={manual?.id ?? ""}/>
      <label>Motif du refus (facultatif)<textarea name="reason" maxLength={500} defaultValue={p.rejected ? p.reason : ""}/></label>
      <fieldset><legend>Retours sur le brouillon (facultatif)</legend>{p.reasonLabels.map(([value,label])=><label key={value}><input type="checkbox" name="reasons" value={value} defaultChecked={p.reasons.includes(value)}/>{label}</label>)}</fieldset>
      <div className="decision-buttons"><button className="primary" name="status" value="accepted" disabled={busy || needsSave || !text.trim()}>Accepter cette version</button><button className="secondary" name="status" value="rejected" disabled={busy || dirty || !text.trim()}>Refuser le brouillon</button></div>
      <p>Cette validation est indépendante du process. Aucun envoi n’est déclenché.</p>
    </form>
    <form action={sendStudioReplyAction}><input type="hidden" name="threadId" value={p.threadId}/><input type="hidden" name="draftId" value={p.acceptedDraftId ?? ""}/>
      <button className="primary" disabled={!p.accepted || !p.sendAllowed || busy || needsSave}>Envoyer la réponse acceptée</button>
      <p>{p.replyState === "sent" ? "Réponse déjà envoyée." : p.replyState === "uncertain" ? "Résultat à vérifier dans Gmail avant toute reprise." : p.replyState === "pending" ? "Envoi en attente. Aucun second envoi." : !p.sendAllowed ? p.sendDisabledReason : needsSave ? "Une version modifiée doit être enregistrée puis acceptée." : !p.accepted ? "Acceptez la version courante avant l’envoi." : "Confirme l’envoi dans le fil Gmail d’origine."}</p>
    </form>
  </>;
}
