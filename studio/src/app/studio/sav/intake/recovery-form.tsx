"use client";
import {useActionState} from "react";
import {requestRecoveryAction,reconcileIdentificationAction,reconcileNoteAction} from "./actions";
export function IntakeRecoveryForm({threadId,messageId,hasNoteReceipt=false,mode="administration",allowReanalysis=true,unavailableReason,showReanalysis=true}:{threadId:string;messageId:string;hasNoteReceipt?:boolean;mode?:"administration"|"analysis";allowReanalysis?:boolean;unavailableReason?:string;showReanalysis?:boolean}){
 const [state,action,pending]=useActionState(requestRecoveryAction,{ok:false,message:""});
 const [receipt,verify,verifying]=useActionState(reconcileIdentificationAction,{ok:false,message:""});
 const [note,verifyNote,verifyingNote]=useActionState(reconcileNoteAction,{ok:false,message:""});
 return <section aria-label={mode==="analysis"?"Nouvelle analyse du dossier":"Vérifications administrateur"}><h2>{mode==="analysis"?"Refaire l’analyse":"Vérifications administrateur"}</h2>
  {mode==="administration"&&<><form action={verify}><input type="hidden" name="threadId" value={threadId}/><button disabled={verifying}>Rapprocher les envois existants sans renvoyer</button>
   {receipt.message&&<p role={receipt.ok?"status":"alert"}>{receipt.message}</p>}</form>
  {hasNoteReceipt&&<form action={verifyNote}><input type="hidden" name="threadId" value={threadId}/><input type="hidden" name="messageId" value={messageId}/>
   <p>Vérifie le reçu original et le rattachement au ticket. Ne recrée pas la note et ne modifie pas le ticket.</p>
   <button disabled={verifyingNote||note.ok}>Vérifier la note déjà rattachée</button>
   {note.message&&<p role={note.ok?"status":"alert"}>{note.message}</p>}</form>}</>}
  {showReanalysis&&<form action={action}><input type="hidden" name="threadId" value={threadId}/><input type="hidden" name="messageId" value={messageId}/>
   <label>Motif de la nouvelle analyse<textarea name="reason" required minLength={10} maxLength={2000} disabled={!allowReanalysis||pending||state.ok}/></label>
   <p>Cette demande enregistre une nouvelle analyse pour ce message, sous le budget existant. L’ancienne décision et les tentatives restent conservées. Les actions de ticket autorisées peuvent suivre après vérification. Aucun mail ne sera envoyé par cette réinvestigation.</p>
   {!allowReanalysis&&<p>{unavailableReason??"Une action est déjà engagée, une pause ou une commande protège ce dossier. Consultez les effets et le diagnostic avant toute reprise."}</p>}
   <button type="submit" disabled={!allowReanalysis||pending||state.ok} aria-busy={pending}>Refaire l’analyse</button>{state.message&&<p role={state.ok?"status":"alert"}>{state.message}</p>}
  </form>}</section>;
}
