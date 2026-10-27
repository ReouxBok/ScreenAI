"use server";
import { revalidatePath } from "next/cache";
import { setSavAgentPause } from "@/lib/sav/intake/agent-pause-admin";
export type PauseAdminState = { ok: boolean; message: string; code?: string };
const text = (form: FormData, key: string) => typeof form.get(key) === "string" ? String(form.get(key)).trim() : "";
const done = { running: "Agent relancé. Les dossiers en attente reprennent au prochain passage automatique.",
  actions_paused: "Actions suspendues. L’analyse continue ; aucune action HubSpot ou Gmail ne part.",
  fully_paused: "Agent en pause complète. Les emails reçus sont conservés et attendent la reprise." } as Record<string, string>;
export async function setPauseAction(_previous: PauseAdminState, form: FormData): Promise<PauseAdminState> {
  try {
    const level = text(form, "level");
    await setSavAgentPause({ agent: "intake", level, reason: text(form, "reason") });
    revalidatePath("/studio/sav/intake/pause"); revalidatePath("/studio/sav/intake");
    return { ok: true, message: done[level] };
  } catch (error) {
    const code = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_AGENT_PAUSE_INVALID_COMMAND";
    return { ok: false, message: "Le changement a été refusé. Vérifiez le niveau choisi et le motif (3 caractères minimum).", code };
  }
}
