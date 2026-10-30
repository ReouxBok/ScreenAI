"use server";
import { revalidatePath } from "next/cache";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { createStudioMcpToken, revokeStudioMcpToken } from "@/lib/mcp/tokens";
export type AgentKeyState = { ok: boolean; message: string; secret?: string; code?: string };
const text = (form: FormData, key: string) => typeof form.get(key) === "string" ? String(form.get(key)).trim() : "";
const code = (error: unknown, fallback: string) => error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : fallback;
export async function createAgentKeyAction(_previous: AgentKeyState, form: FormData): Promise<AgentKeyState> {
  try {
    const staff = await requireIntakeConsoleStaff();
    const created = await createStudioMcpToken(staff, { name: text(form, "name"), days: Number(text(form, "days")) });
    revalidatePath("/studio/sav/intake/agents");
    return { ok: true, secret: created.secret, message: "Clé créée. Copiez-la maintenant : elle ne sera plus jamais affichée." };
  } catch (error) {
    const failure = code(error, "SAV_MCP_TOKEN_INVALID_COMMAND");
    return { ok: false, code: failure, message: failure === "SAV_MCP_TOKEN_LIMIT" ? "Cinq clés actives au maximum : révoquez-en une avant d’en créer une autre."
      : "La création a été refusée. Vérifiez le nom (3 à 80 caractères) et la durée." };
  }
}
export async function revokeAgentKeyAction(_previous: AgentKeyState, form: FormData): Promise<AgentKeyState> {
  try {
    const staff = await requireIntakeConsoleStaff();
    await revokeStudioMcpToken(staff, text(form, "id"));
    revalidatePath("/studio/sav/intake/agents");
    return { ok: true, message: "Clé révoquée : elle est refusée dès maintenant." };
  } catch (error) {
    return { ok: false, code: code(error, "SAV_MCP_TOKEN_INVALID_COMMAND"), message: "La révocation a été refusée." };
  }
}
