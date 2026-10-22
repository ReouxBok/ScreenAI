"use server";
import { revalidatePath } from "next/cache";
import { previewIntakeLaunch, commitIntakeLaunch, revokeIntakeExecutionPolicy } from "@/lib/sav/intake/launch-admin";
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
