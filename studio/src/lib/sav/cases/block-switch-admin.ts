import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savSyncState } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { executionAdministrator } from "../intake/execution-policy";
import { SAV_CASE_BLOCK_REGISTRY } from "./case-block-registry";
import { readSavBlockSwitch, savBlockEffectiveMode, savBlockSwitchKey, SAV_BLOCK_MODES, SAV_BLOCK_SWITCH_REVISION, type SavBlockEffectiveMode, type SavBlockMode,
  type SavBlockSwitch, type SavBlockSwitchState } from "./block-switch";

const AUDIT = { action: "sav_block_switch_set", entityType: "sav_block_switch" } as const;
/** Same authority as the agent pause and the execution policy: active admin/owner with SAV access. */
export async function savBlockSwitchAdministrator() {
  return executionAdministrator().catch(() => { throw Error("SAV_BLOCK_SWITCH_UNAUTHORIZED"); });
}
/** Only the blocks the code knows (`SAV_CASE_BLOCK_REGISTRY`): a switch for an unknown block would protect nothing. */
export const savBlockSwitchBlockIds = () => SAV_CASE_BLOCK_REGISTRY.map(block => block.blockId);
const inputSchema = z.object({ blockId: z.string().refine(id => savBlockSwitchBlockIds().includes(id), "SAV_BLOCK_UNKNOWN"), mode: z.enum(SAV_BLOCK_MODES), paused: z.boolean(),
  reason: z.string().trim().min(3).max(500) }).strict();
const label = (state: Pick<SavBlockSwitchState, "mode" | "paused" | "invalid">) => state.invalid ? "invalid" : `${state.mode}${state.paused ? "+paused" : ""}`;

/** Serialized per block (advisory lock); it never touches the ledger, a budget, an attempt, a proposal or a queued execution. */
export async function setSavBlockSwitch(raw: unknown): Promise<SavBlockSwitch> {
  const staff = await savBlockSwitchAdministrator(), input = inputSchema.parse(raw);
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${savBlockSwitchKey(input.blockId)}))`);
    const previous = label(await readSavBlockSwitch(tx, input.blockId));
    const next: SavBlockSwitch = { revision: SAV_BLOCK_SWITCH_REVISION, blockId: input.blockId, mode: input.mode, paused: input.paused, setBy: staff.email, setAt: new Date().toISOString(), reason: input.reason };
    const values = { key: savBlockSwitchKey(input.blockId), cursor: encryptSavPayload(next), status: "active", updatedAt: new Date(next.setAt) };
    await tx.insert(savSyncState).values(values).onConflictDoUpdate({ target: savSyncState.key, set: values });
    await tx.insert(auditLogs).values({ actorEmail: staff.email, ...AUDIT, entityId: input.blockId,
      technicalMetadata: { previous, next: label({ ...next, invalid: false }), reason: input.reason } });
    return next;
  });
}

export type SavBlockSwitchHistory = Array<{ at: string; actor: string; previous: string; next: string; reason: string }>;
export type SavBlockSwitchPanel = {
  /** The global automatic reply (`SAV_V2_AUTO_REPLY=access` with a valid approver): on or off, nothing else from the configuration. */
  globalAutoReply: boolean;
  blocks: Array<SavBlockSwitchState & { mode: SavBlockMode; effective: SavBlockEffectiveMode; history: SavBlockSwitchHistory }>;
};
/** Administrators only. No budget, cap or amount is read or shown. */
export async function readSavBlockSwitchPanel(env: Readonly<Record<string, string | undefined>> = process.env): Promise<SavBlockSwitchPanel> {
  await savBlockSwitchAdministrator();
  const db = requireDb();
  const blocks = await Promise.all(savBlockSwitchBlockIds().map(async blockId => {
    const state = await readSavBlockSwitch(db, blockId);
    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.action, AUDIT.action), eq(auditLogs.entityType, AUDIT.entityType), eq(auditLogs.entityId, blockId)))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(10);
    const history = rows.map(row => { const m = row.technicalMetadata;
      return { at: row.createdAt.toISOString(), actor: row.actorEmail, previous: String(m.previous ?? ""), next: String(m.next ?? ""), reason: String(m.reason ?? "") }; });
    return { ...state, effective: savBlockEffectiveMode(state, env), history };
  }));
  return { globalAutoReply: savBlockEffectiveMode({ blockId: "access", mode: "auto", paused: false, invalid: false }, env) === "auto", blocks };
}
