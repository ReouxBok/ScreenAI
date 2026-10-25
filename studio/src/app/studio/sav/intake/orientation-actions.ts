"use server";
import { revalidatePath } from "next/cache";
import { recordUxOrientation, readUxOrientationReceipt } from "@/lib/sav/intake-ux/orientation-server";
export type OrientationState = { status: "idle" | "recorded" | "unknown" | "rejected"; message: string; eventId?: string };
export async function submitUxOrientation(_previous: OrientationState, form: FormData): Promise<OrientationState> {
  const field = (key: string) => typeof form.get(key) === "string" ? String(form.get(key)) : "";
  try {
    const result = await recordUxOrientation({ commandKey: field("commandKey"), threadId: field("threadId"), messageId: field("messageId"), runId: field("runId"),
      version: Number(field("version")), sourceHash: field("sourceHash"), candidatesHash: field("candidatesHash"), intent: field("intent"), classification: field("intent") === "refuse" ? "support" : field("classification"),
      ...(field("contactId") ? { contactId: field("contactId") } : {}), ...(field("ticketId") ? { ticketId: field("ticketId") } : {}), reason: field("reason") });
    revalidatePath(`/studio/sav/intake/${field("threadId")}`); revalidatePath("/studio/sav/intake");
    return { status: "recorded", eventId: result.eventId, message: "Décision enregistrée. La revalidation doit encore aboutir avant de confirmer une action. La file humaine est traitée par le passage périodique du moteur." };
  } catch (error) {
    const known = error instanceof Error && (error.name === "ZodError" || /^SAV_INTAKE_(?:HUMAN_CONFLICT|CONSOLE_UNAUTHORIZED|SEMANTIC_PROVENANCE_MISSING|CONSOLE_MIGRATION_REQUIRED)$/.test(error.message));
    return { status: known ? "rejected" : "unknown", message: known
      ? "La correction ne peut pas être enregistrée sur cette version. Conservez votre saisie et rechargez le dossier pour vérifier ses sources, son accès et les commandes déjà en cours."
      : "Le résultat de l’enregistrement est inconnu. Vérifiez la même commande avant toute nouvelle soumission ; votre saisie est conservée." };
  }
}
export async function lookupUxOrientation(input: { commandKey: string; threadId: string; messageId: string }) {
  try { return { readable: true as const, receipt: await readUxOrientationReceipt(input) }; }
  catch { return { readable: false as const, receipt: null }; }
}
