import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../crypto";

type Reader = Pick<Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0], "select">;
export const SAV_AGENT_PAUSE_REVISION = "sav-agent-pause.v1";
/** `v2` is reserved: the resolution agent will read its own row here, nothing reads it yet. */
export const SAV_AGENT_KEYS = ["intake", "v2"] as const;
export type SavAgentKey = typeof SAV_AGENT_KEYS[number];
/** actions_paused: analysis continues, no external effect (observe). fully_paused: no claim,
 * no model reservation, no effect, no wake. Running is stored too, to keep who resumed. */
export const SAV_AGENT_PAUSE_LEVELS = ["running", "actions_paused", "fully_paused"] as const;
export type SavAgentPauseLevel = typeof SAV_AGENT_PAUSE_LEVELS[number];
export const SAV_AGENT_PAUSE_CODES = {
  actions_paused: "SAV_INTAKE_AGENT_ACTIONS_PAUSED", fully_paused: "SAV_INTAKE_AGENT_FULLY_PAUSED", invalid: "SAV_INTAKE_AGENT_PAUSE_INVALID",
} as const;
/** Codes that stop an analysis: the attempt they interrupt is given back, never burned. */
export const SAV_AGENT_ANALYSIS_PAUSE_CODES: ReadonlySet<string> = new Set([SAV_AGENT_PAUSE_CODES.fully_paused, SAV_AGENT_PAUSE_CODES.invalid]);
export const savAgentPauseKey = (agent: SavAgentKey) => `${SAV_AGENT_PAUSE_REVISION}:${agent}`;
export const savAgentPauseSchema = z.object({
  revision: z.literal(SAV_AGENT_PAUSE_REVISION), agent: z.enum(SAV_AGENT_KEYS), level: z.enum(SAV_AGENT_PAUSE_LEVELS),
  setBy: z.string().min(3).max(320), setAt: z.iso.datetime(), reason: z.string().trim().min(3).max(500),
}).strict();
export type SavAgentPause = z.infer<typeof savAgentPauseSchema>;
export type SavAgentPauseState = { level: SavAgentPauseLevel; setting: SavAgentPause | null; invalid: boolean };

/** Outside configHash: a change neither redeploys nor breaks continuity. It can only restrict:
 * every caller still applies its own env checks first. A row that cannot be decrypted or
 * validated fails closed as fully_paused with its own code, never as running. */
export async function readSavAgentPause(db: Reader, agent: SavAgentKey = "intake"): Promise<SavAgentPauseState> {
  const [row] = await db.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, savAgentPauseKey(agent)));
  if (!row) return { level: "running", setting: null, invalid: false };
  try {
    const setting = savAgentPauseSchema.parse(decryptSavPayload(row.cursor!));
    if (setting.agent !== agent) throw Error("SAV_AGENT_PAUSE_KEY_MISMATCH");
    return { level: setting.level, setting, invalid: false };
  } catch { return { level: "fully_paused", setting: null, invalid: true }; }
}
export function savAgentPauseCode(state: SavAgentPauseState): string | null {
  return state.invalid ? SAV_AGENT_PAUSE_CODES.invalid : state.level === "running" ? null : SAV_AGENT_PAUSE_CODES[state.level];
}
/** Claim and model reservation. */
export async function assertSavAgentAnalysisAllowed(db: Reader, agent: SavAgentKey = "intake") {
  const state = await readSavAgentPause(db, agent);
  if (state.level === "fully_paused") throw Error(savAgentPauseCode(state)!);
}
/** Admission and external effect dispatch (HubSpot / Gmail). */
export async function assertSavAgentActionsAllowed(db: Reader, agent: SavAgentKey = "intake") {
  const code = savAgentPauseCode(await readSavAgentPause(db, agent));
  if (code) throw Error(code);
}
