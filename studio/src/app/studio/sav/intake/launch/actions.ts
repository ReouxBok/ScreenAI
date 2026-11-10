"use server";
import { revalidatePath } from "next/cache";
import { previewIntakeLaunch, commitIntakeLaunch, revokeIntakeExecutionPolicy } from "@/lib/sav/intake/launch-admin";
import { previewIntakeExecutionRenewal, commitIntakeExecutionRenewal, type IntakeRenewalSummary, type IntakeRenewalReceipt } from "@/lib/sav/intake/execution-renewal";
export type LaunchAdminState = {
  ok:boolean; message:string; code?:string; submittedJson?:string;
  preview?:{id:string;hash:string;expiresAt:string;input:unknown};
  receipt?:{policyId:string;policyHash:string;mailboxId:string;receivedAfter:string;createdAfter:string};
};
const text=(form:FormData,key:string)=>typeof form.get(key)==="string"?String(form.get(key)):"";
function rejected(error:unknown):LaunchAdminState {
  const code=error instanceof Error&&/^SAV_[A-Z_]+$/.test(error.message)?error.message:"SAV_INTAKE_ADMIN_INVALID_COMMAND";
  return {ok:false,message:"La commande a été refusée. Vérifiez votre session, les paramètres et le diagnostic ; aucun départ fournisseur n’est autorisé par ce formulaire.",code};
}
/** Next server actions enforce same-origin/CSRF in addition to the strict
 * verified-session administrator checks inside the shared server primitives. */
export async function previewLaunchAction(_previous:LaunchAdminState,form:FormData):Promise<LaunchAdminState> {
  try {
    const json=text(form,"configuration");
    if(new TextEncoder().encode(json).length>20000)throw Error("SAV_INTAKE_ADMIN_INPUT_TOO_LARGE");
    const preview=await previewIntakeLaunch(text(form,"commandId"),JSON.parse(json));
    return {ok:true,message:"Aperçu conservé. Vérifiez le contenu exact avant de confirmer.",submittedJson:json,
      preview:{id:preview.previewId,hash:preview.hash,expiresAt:preview.expiresAt,input:preview.input}};
  } catch(error) {return rejected(error);}
}
export async function commitLaunchAction(_previous:LaunchAdminState,form:FormData):Promise<LaunchAdminState> {
  try {
    const receipt=await commitIntakeLaunch(text(form,"previewId"),text(form,"hash"));
    revalidatePath("/studio/sav");revalidatePath("/studio/sav/intake");
    return {ok:true,message:"Frontière et autorité enregistrées. Les interrupteurs serveur restent inchangés ; OFF conserve les nouveaux mails en attente.",receipt};
  } catch(error) {return rejected(error);}
}
export async function revokeLaunchAction(_previous:LaunchAdminState,form:FormData):Promise<LaunchAdminState> {
  try {
    await revokeIntakeExecutionPolicy(text(form,"policyId"),text(form,"reason"));
    revalidatePath("/studio/sav/intake");
    return {ok:true,message:"Autorité révoquée. Aucun nouveau départ sous cette politique ; les rapprochements et reçus tardifs restent conservés."};
  } catch(error) {return rejected(error);}
}
export type RenewalAdminState = {
  ok:boolean; message:string; code?:string; submittedSource?:string;
  preview?:{id:string;hash:string;expiresAt:string;sourcePolicyId:string;sourcePolicyHash:string;fromCodeRevision:string;toCodeRevision:string;summary:IntakeRenewalSummary};
  receipt?:IntakeRenewalReceipt;
};
function renewalRejected(error:unknown):RenewalAdminState {
  const code=error instanceof Error&&/^SAV_[A-Z_]+$/.test(error.message)?error.message:"SAV_INTAKE_ADMIN_INVALID_COMMAND";
  // Review M-1: a commit can fail after the canonical approval (lost lease, receipt write), so no non-effect is claimed.
  return {ok:false,message:"Le renouvellement n’a pas abouti. Vérifiez le diagnostic et l’état des politiques. Si une confirmation a été interrompue, reprenez la même commande avant de préparer un nouvel aperçu.",code};
}
/** Renewal: server-side copy of an existing policy for the deployed code revision only. No JSON, payload or key from the browser. */
export async function previewRenewalAction(_previous:RenewalAdminState,form:FormData):Promise<RenewalAdminState> {
  try {
    const source=text(form,"sourcePolicyId");
    if(source.length>100)throw Error("SAV_INTAKE_ADMIN_INPUT_TOO_LARGE");
    const preview=await previewIntakeExecutionRenewal(text(form,"commandId"),source);
    return {ok:true,message:"Aperçu de renouvellement conservé dix minutes. Seule la version de code change.",submittedSource:source,
      preview:{id:preview.previewId,hash:preview.hash,expiresAt:preview.expiresAt,sourcePolicyId:preview.sourcePolicyId,sourcePolicyHash:preview.sourcePolicyHash,
        fromCodeRevision:preview.fromCodeRevision,toCodeRevision:preview.toCodeRevision,summary:preview.summary}};
  } catch(error) {return renewalRejected(error);}
}
export async function commitRenewalAction(_previous:RenewalAdminState,form:FormData):Promise<RenewalAdminState> {
  try {
    const receipt=await commitIntakeExecutionRenewal(text(form,"previewId"),text(form,"hash"));
    revalidatePath("/studio/sav/intake");
    return {ok:true,message:"Nouvelle politique approuvée. L’ancienne est conservée telle quelle. Aucune variable serveur n’a été modifiée : reportez l’identifiant et l’empreinte dans la configuration canonique.",receipt};
  } catch(error) {return renewalRejected(error);}
}
