"use client";
import { useActionState, useState } from "react";
import { previewRenewalAction, commitRenewalAction, type RenewalAdminState } from "./actions";
import styles from "../intake.module.css";
const initial:RenewalAdminState={ok:false,message:""};
function Result({state}:{state:RenewalAdminState}) {
  return <>{state.message&&<p role={state.ok?"status":"alert"}>{state.message}</p>}{state.code&&<details><summary>Diagnostic</summary><code>{state.code}</code></details>}</>;
}
/** Renewal of an existing authority for the deployed code revision. GET is inert; nothing is sent on mount. */
export function RenewalAdminForm({commandId}:{commandId:string}) {
  const [source,setSource]=useState(""),[nonce,setNonce]=useState(commandId);
  const [preview,prepare,preparing]=useActionState(previewRenewalAction,initial);
  const [commit,confirm,committing]=useActionState(commitRenewalAction,initial);
  const busy=preparing||committing;
  const matches=Boolean(preview.preview&&source===preview.submittedSource);
  const s=preview.preview?.summary;
  return <div className={styles.adminForms}>
    <form action={prepare} className={styles.choice}>
      <h2>Renouveler une autorité existante</h2>
      <p>Recopie côté serveur une politique approuvée pour la version de code déployée. Admission, actions permises, plafond de dossiers, dates, ressources, budget et boîte restent identiques. Aucune date n’est prolongée.</p>
      <input type="hidden" name="commandId" value={nonce}/>
      <fieldset disabled={busy||commit.ok}>
        <label htmlFor="renewal-source">Identifiant de la politique source (vide : politique configurée côté serveur)<input id="renewal-source" name="sourcePolicyId" value={source} maxLength={100} spellCheck={false}
          onChange={event=>{setSource(event.target.value);setNonce(crypto.randomUUID());}}/></label>
        <button type="submit">Préparer l’aperçu de renouvellement</button>
      </fieldset>
      {preparing&&<p role="status">Vérification de la politique source…</p>}<Result state={preview}/>
    </form>
    {preview.preview&&s&&<section className={styles.choice}>
      <h2>Confirmer ce renouvellement exact</h2>
      <p>Échéance de l’aperçu : <time>{preview.preview.expiresAt}</time>. Toute modification impose un nouvel aperçu.</p>
      <dl>
        <dt>Politique source (conservée)</dt><dd><code>{preview.preview.sourcePolicyId}</code></dd>
        <dt>Version de code</dt><dd><code>{preview.preview.fromCodeRevision}</code> → <code>{preview.preview.toCodeRevision}</code></dd>
        <dt>Inchangé</dt><dd>Fin d’autorité <time>{s.expiresAt}</time> · {s.maxDossiers} dossiers maximum · admission {s.admission.kind==="automatic"?"automatique":`qualification (${s.admission.runCount} exécutions)`} · budget {s.budgetProfile??"qualification"} · actions : {s.mutations.join(", ")}</dd>
        <dt>Empreinte de l’aperçu</dt><dd><code>{preview.preview.hash}</code></dd>
      </dl>
      <form action={confirm}>
        <input type="hidden" name="previewId" value={preview.preview.id}/><input type="hidden" name="hash" value={preview.preview.hash}/>
        <button type="submit" disabled={busy||!matches||commit.ok}>Confirmer ce renouvellement exact</button>
      </form>
      {!matches&&<p role="alert">La source a changé. Préparez et vérifiez un nouvel aperçu.</p>}
      {committing&&<p role="status">Approbation du renouvellement…</p>}<Result state={commit}/>
      {commit.receipt&&<dl><dt>Nouvelle politique</dt><dd><code>{commit.receipt.policyId}</code></dd><dt>Empreinte de politique</dt><dd><code>{commit.receipt.policyHash}</code></dd></dl>}
    </section>}
  </div>;
}
