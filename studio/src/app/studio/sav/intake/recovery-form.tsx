"use client";
import {useActionState} from "react";
import {requestRecoveryAction,reconcileIdentificationAction} from "./actions";
export function IntakeRecoveryForm({threadId,messageId}:{threadId:string;messageId:string}){
 const [state,action,pending]=useActionState(requestRecoveryAction,{ok:false,message:""});
 const [receipt,verify,verifying]=useActionState(reconcileIdentificationAction,{ok:false,message:""});
 return <section aria-label="Reprise administrateur"><h2>Reprise administrateur</h2>
  <form action={verify}><input type="hidden" name="threadId" value={threadId}/><button disabled={verifying}>Rapprocher les envois existants sans renvoyer</button>
   {receipt.message&&<p role={receipt.ok?"status":"alert"}>{receipt.message}</p>}</form>
  <form action={action}><input type="hidden" name="threadId" value={threadId}/><input type="hidden" name="messageId" value={messageId}/>
   <label>Motif de la réinvestigation<textarea name="reason" required minLength={10} maxLength={2000}/></label>
   <p>Une reprise explicite pour ce message, sous le budget existant. Les tentatives précédentes sont conservées. Aucun mail ne sera envoyé par cette reprise ; les actions de ticket restent soumises aux vérifications habituelles.</p>
   <button disabled={pending||state.ok}>Réinvestiguer avec les correctifs</button>{state.message&&<p role={state.ok?"status":"alert"}>{state.message}</p>}
  </form></section>;
}
