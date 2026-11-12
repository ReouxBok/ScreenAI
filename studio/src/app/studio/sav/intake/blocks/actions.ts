"use server";
import { revalidatePath } from "next/cache";
import { setSavBlockSwitch } from "@/lib/sav/cases/block-switch-admin";
export type BlockSwitchAdminState = { ok: boolean; message: string; code?: string };
const text = (form: FormData, key: string) => typeof form.get(key) === "string" ? String(form.get(key)).trim() : "";
export async function setBlockSwitchAction(_previous: BlockSwitchAdminState, form: FormData): Promise<BlockSwitchAdminState> {
  try {
    await setSavBlockSwitch({ blockId: text(form, "blockId"), mode: text(form, "mode"), paused: text(form, "paused") === "on", reason: text(form, "reason") });
    revalidatePath("/studio/sav/intake/blocks");
    return { ok: true, message: "Réglage du bloc enregistré. Il s’applique au prochain passage, sans redéploiement." };
  } catch (error) {
    const code = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_BLOCK_SWITCH_INVALID_COMMAND";
    return { ok: false, message: "Le changement a été refusé. Vérifiez le mode choisi et le motif (3 caractères minimum).", code };
  }
}
