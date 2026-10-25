"use server";
import { redirect } from "next/navigation";
import { completeSavDossierManually } from "@/lib/sav/external-completion";
import { releaseIntakeHumanHold } from "@/lib/sav/intake/human-hold-release";
import { revalidatePath } from "next/cache";
import { recordIntakeHumanCommand } from "@/lib/sav/intake/human-commands";
import {requestIntakeReinvestigation,reconcileThreadIdentification} from "@/lib/sav/intake/operator-recovery";
import { reconcileIntakeNoteForClosure } from "@/lib/sav/intake/note-recovery";
import { intakeListDestination } from "@/lib/sav/intake-ux/navigation";
export type IntakeChoiceFormState = { ok: boolean; message: string };
export async function completeIntakeDossierAction(_previous: IntakeChoiceFormState, form: FormData): Promise<IntakeChoiceFormState> {
 try {
  const result = await completeSavDossierManually({requestKey:form.get("requestKey"),threadId:form.get("threadId"),messageId:form.get("messageId"),confirmed:form.get("confirmed")==="on"});
  if (!result.marked && !result.alreadyCompleted) {
   const message = result.skipped.active_worker ? "Un traitement est encore en cours. Réessayez après sa fin."
    : result.skipped.unsettled_action ? "Une action ou un résultat externe reste à vérifier. Le dossier est conservé en attente."
    : "Le dossier a changé ou ne peut pas être clôturé ainsi. Rechargez-le avant de réessayer.";
   return {ok:false,message};
  }
  revalidatePath(`/studio/sav/intake/${String(form.get("threadId"))}`);
  revalidatePath(`/studio/sav/${String(form.get("threadId"))}`);
  revalidatePath("/studio/sav/intake");revalidatePath("/studio/sav");
  return {ok:true,message:"Dossier passé en Terminés : déjà traité. Aucun mail envoyé ni ticket HubSpot fermé. Un nouvel email reviendra dans le flux."};
 } catch { return {ok:false,message:"Clôture non enregistrée. Vérifiez votre accès et rechargez le dossier ; aucune action externe n’a été déclenchée."}; }
}
export async function requestRecoveryAction(_previous:IntakeChoiceFormState,form:FormData):Promise<IntakeChoiceFormState>{
 try{await requestIntakeReinvestigation({threadId:form.get("threadId"),messageId:form.get("messageId"),reason:form.get("reason")});
  revalidatePath(`/studio/sav/intake/${String(form.get("threadId"))}`);return {ok:true,message:"Réinvestigation enregistrée, sans remise à zéro des tentatives ni envoi de mail."};
 }catch{return {ok:false,message:"Reprise non enregistrée : sources modifiées, pause, effet existant ou reprise déjà demandée. Rechargez le dossier."};}
}
export async function reconcileIdentificationAction(_previous:IntakeChoiceFormState,form:FormData):Promise<IntakeChoiceFormState>{
 try{const result=await reconcileThreadIdentification(String(form.get("threadId")));revalidatePath(`/studio/sav/intake/${String(form.get("threadId"))}`);
  return {ok:true,message:`${result.confirmed} envoi(s) existant(s) rapproché(s). Aucun mail renvoyé.`};
 }catch{return {ok:false,message:"Les preuves ne permettent pas encore de confirmer cet envoi. Aucun mail renvoyé."};}
}
export async function reconcileNoteAction(_previous:IntakeChoiceFormState,form:FormData):Promise<IntakeChoiceFormState>{
 try {
  await reconcileIntakeNoteForClosure({threadId:form.get("threadId"),messageId:form.get("messageId")});
  revalidatePath(`/studio/sav/intake/${String(form.get("threadId"))}`);revalidatePath("/studio/sav/intake");
  return {ok:true,message:"Note existante et rattachement vérifiés. Vous pouvez passer le dossier en Terminés. Aucune note créée ni aucun mail envoyé."};
 } catch {
  return {ok:false,message:"La note et son rattachement ne sont pas entièrement confirmés, ou le dossier a changé. Le dossier reste protégé ; aucune action externe relancée."};
 }
}
export async function saveIntakeChoice(_previous: IntakeChoiceFormState, form: FormData): Promise<IntakeChoiceFormState> {
  const text = (key: string) => typeof form.get(key) === "string" ? String(form.get(key)) : "";
  const kind = text("kind");
  try {
    const result = await recordIntakeHumanCommand({ commandKey: text("commandKey"), threadId: text("threadId"), messageId: text("messageId"),
      runId: text("runId"), version: Number(text("version")), sourceHash: text("sourceHash"), candidatesHash: text("candidatesHash"), kind,
      ...(kind === "select" && text("contactId") ? { contactId: text("contactId") } : {}),
      ...(kind === "select" && text("ticketId") ? { ticketId: text("ticketId") } : {}),
      ...(kind === "classify" ? { classification: text("classification") } : {}), reason: text("reason") });
    revalidatePath(`/studio/sav/intake/${text("threadId")}`);
    revalidatePath("/studio/sav/intake");
    return { ok: true, message: result.status === "recorded" ? kind === "refuse"
      ? "Refus enregistré. La proposition reste arrêtée ; les éventuels résultats externes en cours seront rapprochés."
      : "Choix enregistré. Le worker doit revalider les preuves avant toute reprise." : "Choix conservé." };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return { ok: false, message: code === "SAV_INTAKE_HUMAN_CONFLICT"
      ? "Le dossier a changé ou un choix existe déjà. Rechargez sa dernière version avant de corriger."
      : code === "SAV_INTAKE_SEMANTIC_PROVENANCE_MISSING"
      ? "Cette analyse ne conserve pas les résultats validés nécessaires à une reprise. Une réinvestigation est requise."
      : "Le choix n’a pas été enregistré. Vérifiez votre accès, le motif et la version courante." };
  }
}

export async function releaseIntakeHumanHoldAction(form: FormData): Promise<void> {
 const threadId=String(form.get("threadId")??"");let status="blocked";
 try { await releaseIntakeHumanHold({requestKey:form.get("requestKey"),threadId,messageId:form.get("messageId"),expectedEpoch:Number(form.get("expectedEpoch")),reason:form.get("reason")});status="released"; }
 catch { /* Keep the pause and the dossier when any safety condition changed. */ }
 revalidatePath(`/studio/sav/intake/${threadId}`);revalidatePath("/studio/sav/intake");
 const destination = intakeListDestination(form.get("returnTo"));
 redirect(`/studio/sav/intake/${encodeURIComponent(threadId)}?${new URLSearchParams({holdRelease:status,...(destination?{returnTo:destination}:{})})}`);
}
