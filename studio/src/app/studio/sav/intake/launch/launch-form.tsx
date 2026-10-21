"use client";
import { useActionState, useState } from "react";
import { previewLaunchAction, commitLaunchAction, revokeLaunchAction, type LaunchAdminState } from "./actions";
import styles from "../intake.module.css";
const initial:LaunchAdminState={ok:false,message:""};
function Result({state}:{state:LaunchAdminState}) {
  return <>{state.message&&<p role={state.ok?"status":"alert"}>{state.message}</p>}{state.code&&<details><summary>Diagnostic</summary><code>{state.code}</code></details>}</>;
}
export function LaunchAdminForm({commandId}:{commandId:string}) {
  const [draft,setDraft]=useState(""),[nonce,setNonce]=useState(commandId);
  const [preview,prepare,preparing]=useActionState(previewLaunchAction,initial);
  const [commit,confirm,committing]=useActionState(commitLaunchAction,initial);
  const [revoke,cancel,revoking]=useActionState(revokeLaunchAction,initial);
  const [policyId,setPolicyId]=useState(""),[reason,setReason]=useState("");
  const busy=preparing||committing||revoking;
  const matches=Boolean(preview.preview&&draft===preview.submittedJson);
  return <div className={styles.adminForms}>
    <form action={prepare} className={styles.choice}>
      <h2>1. Préparer l’aperçu privé</h2>
      <p>Paramètres techniques runtime et politique, sans clé d’accès ni texte de modèle. L’aperçu crée uniquement un nonce chiffré, valable dix minutes.</p>
      <input type="hidden" name="commandId" value={nonce}/>
      <fieldset disabled={busy||commit.ok}>
        <label htmlFor="launch-json">Configuration JSON privée<textarea id="launch-json" name="configuration" rows={16} value={draft} required maxLength={20000} spellCheck={false}
          onChange={event=>{setDraft(event.target.value);setNonce(crypto.randomUUID());}} placeholder={'{"runtime": {...}, "policy": {...}}'}/></label>
        <button type="submit">Préparer un nouvel aperçu</button>
      </fieldset>
      {preparing&&<p role="status">Vérification des paramètres…</p>}<Result state={preview}/>
    </form>
    {preview.preview&&<section className={styles.choice}>
      <h2>2. Confirmer ce contenu exact</h2>
      <p>Échéance de l’aperçu : <time>{preview.preview.expiresAt}</time>. Toute modification du JSON impose un nouvel aperçu.</p>
      <p>Empreinte : <code>{preview.preview.hash}</code></p>
      <details open><summary>Paramètres à approuver</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(preview.preview.input,null,2)}</pre></details>
      <form action={confirm}>
        <input type="hidden" name="previewId" value={preview.preview.id}/><input type="hidden" name="hash" value={preview.preview.hash}/>
        <button type="submit" disabled={busy||!matches||commit.ok}>Confirmer la frontière et la politique</button>
      </form>
      {!matches&&<p role="alert">Le contenu a changé. Préparez et vérifiez un nouvel aperçu.</p>}
      {committing&&<p role="status">Enregistrement de la confirmation…</p>}<Result state={commit}/>
      {commit.receipt&&<dl><dt>Politique approuvée</dt><dd><code>{commit.receipt.policyId}</code></dd><dt>Empreinte de politique</dt><dd><code>{commit.receipt.policyHash}</code></dd></dl>}
    </section>}
    <form action={cancel} className={styles.choice}>
      <h2>Révoquer une autorité</h2>
      <fieldset disabled={busy}>
        <label htmlFor="revoke-policy">Identifiant de politique<input id="revoke-policy" name="policyId" required value={policyId||commit.receipt?.policyId||""} onChange={event=>setPolicyId(event.target.value)}/></label>
        <label htmlFor="revoke-reason">Motif de révocation<textarea id="revoke-reason" name="reason" rows={3} minLength={10} maxLength={2000} required value={reason} onChange={event=>setReason(event.target.value)}/></label>
        <button type="submit" className="secondary">Révoquer cette autorité</button>
      </fieldset>
      {revoking&&<p role="status">Révocation en cours…</p>}<Result state={revoke}/>
    </form>
  </div>;
}
