"use client";
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { renderSavOutboundReply, savManualReplyMode } from "@/lib/sav/reply-format";
import { normalizeSavConfirmationText } from "@/lib/sav/reply-confirmation-text";
import { reviewDraftAction, saveHumanDraftAction, sendSuggestedReplyAction } from "../actions";
type Props={requiresHumanLanguage?:boolean;language?:"fr"|"en"|"unknown";recipient:string;threadId:string;messageId:string;decisionId:string;agentRunId:string;sourceHash:string;feedbackSourceHash?:string;verdictId:string|null;
 original:string|null;current:{id:string;text:string;stale:boolean;status:string;origin:string}|null;currentDraftId:string|null;reason:string;reasons:string[];reasonLabels:Array<[string,string]>;
 sendAllowed:boolean;sendDisabledReason?:string|null;replyState?:string|null};
function ConfirmSend({disabled}:{disabled:boolean}) {const {pending}=useFormStatus();return <button className="primary" disabled={disabled||pending}>{pending?"Envoi en cours…":"Confirmer l’envoi de cette réponse"}</button>;}
export function DraftEditor(p:Props) {
 const initial=p.current?.origin==="human"&&!p.current.stale?p.current.text:p.original??"";
 const [text,setText]=useState(initial),[copied,setCopied]=useState(false),[hash,setHash]=useState<{preview:string;value:string}|null>(null);
 const dirty=text!==initial,origin=dirty||(p.current?.origin==="human"&&!p.current.stale)?"human":"ai",busy=Boolean(p.replyState);
 const confirmationText=normalizeSavConfirmationText(text);
 let preview="";try{if(confirmationText.trim())preview=renderSavOutboundReply(confirmationText,p.language??"fr",savManualReplyMode(origin));}catch{}
 useEffect(()=>{let active=true;crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(preview))).then(buffer=>{if(active)setHash({preview,value:btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")});}).catch(()=>{if(active)setHash(null);});return()=>{active=false;};},[preview]);
 return <>
  <form action={saveHumanDraftAction}>
   <input type="hidden" name="threadId" value={p.threadId}/><input type="hidden" name="messageId" value={p.messageId}/><input type="hidden" name="expectedDraftId" value={p.currentDraftId??""}/>
   <label>Suggestion de réponse<textarea name="text" required maxLength={10000} rows={10} value={text} disabled={busy} onChange={e=>setText(e.target.value)}/></label>
   <div className="decision-buttons"><button type="button" className="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);}catch{setCopied(false);}}}>Copier</button><button className="secondary" disabled={busy||!text.trim()}>Enregistrer ma version</button></div>
   {copied&&<p role="status">Suggestion copiée. Aucun envoi attesté.</p>}<p>L’édition et l’enregistrement sont facultatifs. Le suivi du dossier continue indépendamment de cette suggestion.</p>
  </form>
  {p.original&&<details><summary>Suggestion initiale de l’IA</summary><pre>{p.original}</pre></details>}
  <form action={sendSuggestedReplyAction}>
   <input type="hidden" name="threadId" value={p.threadId}/><input type="hidden" name="messageId" value={p.messageId}/><input type="hidden" name="decisionId" value={p.decisionId}/><input type="hidden" name="agentRunId" value={p.agentRunId}/><input type="hidden" name="sourceHash" value={p.sourceHash}/><input type="hidden" name="expectedDraftId" value={p.currentDraftId??""}/><input type="hidden" name="text" value={confirmationText}/><input type="hidden" name="origin" value={origin}/><input type="hidden" name="recipient" value={p.recipient}/><input type="hidden" name="outboundHash" value={hash?.preview===preview?hash.value:""}/>
   <h4>Aperçu exact de l’envoi</h4><p>Destinataire : <strong>{p.recipient}</strong> · fil Gmail d’origine.</p><pre>{preview}</pre>
   {p.requiresHumanLanguage&&<p role="alert">La traduction sert à lire le mail. La rédaction automatique et la signature dans sa langue ne sont pas qualifiées. Rédigez une réponse humaine adaptée à la langue originale avant de confirmer.</p>}
   <ConfirmSend disabled={Boolean(p.requiresHumanLanguage&&origin!=="human")||!p.sendAllowed||busy||!preview||hash?.preview!==preview||!p.recipient}/>
   <p>{p.replyState==="sent"?"Réponse déjà envoyée.":p.replyState==="uncertain"?"Résultat à vérifier dans Gmail avant toute reprise.":p.replyState==="pending"?"Envoi en attente. Aucun second envoi.":!p.sendAllowed?p.sendDisabledReason:"Ce bouton confirme le texte et le destinataire affichés. Aucun verdict préalable n’est requis."}</p>
  </form>
  <details><summary>Feedback facultatif sur la suggestion</summary><form action={reviewDraftAction}>
   <input type="hidden" name="threadId" value={p.threadId}/><input type="hidden" name="messageId" value={p.messageId}/><input type="hidden" name="decisionId" value={p.decisionId}/><input type="hidden" name="agentRunId" value={p.agentRunId}/><input type="hidden" name="sourceHash" value={p.feedbackSourceHash??p.sourceHash}/><input type="hidden" name="verdictId" value={p.verdictId??""}/>
   <label>Commentaire<textarea name="reason" maxLength={500} defaultValue={p.reason}/></label><fieldset><legend>Retours sur la suggestion</legend>{p.reasonLabels.map(([value,label])=><label key={value}><input type="checkbox" name="reasons" value={value} defaultChecked={p.reasons.includes(value)}/>{label}</label>)}</fieldset>
   <button className="secondary" name="status" value="rejected" disabled={busy||dirty}>Signaler un problème dans la suggestion initiale</button>
  </form></details>
 </>;
}
