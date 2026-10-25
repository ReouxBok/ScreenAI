"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordOperatorCommand, readOperatorReceipt } from "@/lib/sav/intake-ux/operator-commands";
import type { OperatorReceipt } from "@/lib/sav/intake-ux/operator-contract";
export type OperatorFormState = { status: "idle" | "recorded" | "rejected" | "unknown"; message: string; receipt?: OperatorReceipt };
export async function submitOperatorAction(_previous: OperatorFormState, form: FormData): Promise<OperatorFormState> {
  try {
    const kind = form.get("kind");
    const receipt = await recordOperatorCommand({ requestKey: form.get("requestKey"), threadId: form.get("threadId"), messageId: form.get("messageId"),
      runId: form.get("runId"), version: Number(form.get("version")), sourceHash: form.get("sourceHash"), kind, reason: form.get("reason"),
      ...(kind === "information" ? { information: form.get("information"), expectedInformationId: form.get("expectedInformationId") || null } : {}) });
    revalidatePath(`/studio/sav/intake/${String(form.get("threadId"))}`); revalidatePath("/studio/sav/intake");
    return { status: "recorded", receipt, message: "Demande enregistrée. Le traitement existant la reprendra après ses contrôles ; aucun effet n’est encore annoncé comme accompli." };
  } catch (error) {
    if(error instanceof Error&&error.message==="SAV_INTAKE_OPERATOR_CALLS_EXHAUSTED")return{status:"rejected",message:"Les trois appels autorisés pour ce message ont déjà été utilisés. Le texte reste en saisie locale, sans nouvelle analyse ni remise à zéro du budget."};
    if (error instanceof z.ZodError || error instanceof Error && ["SAV_INTAKE_OPERATOR_CONFLICT", "SAV_INTAKE_RECOVERY_CONFLICT", "SAV_INTAKE_EXECUTION_UNAUTHORIZED"].includes(error.message))
      return { status: "rejected", message: "Demande refusée : accès, version, informations identiques, pause, commande existante ou effets déjà engagés. Votre saisie est conservée ; rechargez les preuves." };
    return { status: "unknown", message: "L’enregistrement n’est pas confirmé. Vérifiez cette même référence avant de renvoyer ; aucun renvoi automatique." };
  }
}
export async function lookupOperatorAction(raw: { requestKey: string; threadId: string; messageId: string }) {
  try { z.object({ requestKey: z.uuid(), threadId: z.uuid(), messageId: z.uuid() }).strict().parse(raw);
    return { readable: true, receipt: await readOperatorReceipt(raw) };
  } catch { return { readable: false, receipt: null }; }
}
