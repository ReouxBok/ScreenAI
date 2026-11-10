"use client";
import { useState } from "react";
import { reviewDraftAction, saveHumanDraftAction } from "../actions";
type Props={requiresHumanLanguage?:boolean;language?:"fr"|"en"|"unknown";recipient:string;threadId:string;messageId:string;decisionId:string;agentRunId:string;sourceHash:string;feedbackSourceHash?:string;verdictId:string|null;
 original:string|null;current:{id:string;text:string;stale:boolean;status:string;origin:string}|null;currentDraftId:string|null;reason:string;reasons:string[];reasonLabels:Array<[string,string]>;
 sendAllowed:boolean;sendDisabledReason?:string|null;replyState?:string|null};
export function DraftEditor(p:Props) {
 const initial=p.current?.origin==="human"&&!p.current.stale?p.current.text:p.original??"";
 const [text,setText]=useState(initial),[copied,setCopied]=useState(false);
 const dirty=text!==initial,busy=Boolean(p.replyState);
 return <>
  <form action={saveHumanDraftAction}>
   <input type="hidden" name="threadId" value={p.threadId}/><input type="hidden" name="messageId" value={p.messageId}/><input type="hidden" name="expectedDraftId" value={p.currentDraftId??""}/>
   <label>Suggestion de réponse<textarea name="text" required maxLength={10000} rows={10} value={text} disabled={busy} onChange={e=>setText(e.target.value)}/></label>
   <div className="decision-buttons"><button type="button" className="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);}catch{setCopied(false);}}}>Copier</button><button className="secondary" disabled={busy||!text.trim()}>Enregistrer ma version</button></div>
   {copied&&<p role="status">Suggestion copiée. Aucun envoi attesté.</p>}<p>L’édition et l’enregistrement sont facultatifs. Le suivi du dossier continue indépendamment de cette suggestion.</p>
  </form>
  {p.original&&<details><summary>Suggestion initiale de l’IA</summary><pre>{p.original}</pre></details>}
  {/* SAV-60: sending the suggestion (A09) left with the V0 circuit; the recorded send state stays visible. */}
  <p role="status">{p.replyState==="sent"?"Réponse déjà envoyée.":p.replyState==="uncertain"?"Résultat à vérifier dans Gmail.":p.replyState==="pending"?"Envoi enregistré en attente. Aucun second envoi.":p.sendDisabledReason??"Aucun envoi depuis ce dossier."}</p>
  {p.original&&<details><summary>Feedback facultatif sur la suggestion</summary><form action={reviewDraftAction}>
   <input type="hidden" name="threadId" value={p.threadId}/><input type="hidden" name="messageId" value={p.messageId}/><input type="hidden" name="decisionId" value={p.decisionId}/><input type="hidden" name="agentRunId" value={p.agentRunId}/><input type="hidden" name="sourceHash" value={p.feedbackSourceHash??p.sourceHash}/><input type="hidden" name="verdictId" value={p.verdictId??""}/>
   <label>Commentaire<textarea name="reason" maxLength={500} defaultValue={p.reason}/></label><fieldset><legend>Retours sur la suggestion</legend>{p.reasonLabels.map(([value,label])=><label key={value}><input type="checkbox" name="reasons" value={value} defaultChecked={p.reasons.includes(value)}/>{label}</label>)}</fieldset>
   <button className="secondary" name="status" value="rejected" disabled={busy||dirty}>Signaler un problème dans la suggestion initiale</button>
  </form></details>}
 </>;
}
