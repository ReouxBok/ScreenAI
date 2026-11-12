import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { SAV_CASE_ACCESS_BLOCK_ID, SAV_CASE_BLOCK_ID } from "./case-types";
import { readAccessAutoApprovalConfig } from "./customer-return";

/*
 * Per-block switch (12/11, Ugo): each treatment block has a mode `off | draft | auto` and a pause, set by an administrator in the Studio,
 * stored like the agent pause (`sav-agent-pause.v1`): one encrypted row per block in `sav.sync_state`, actor, reason, timestamp, audited history.
 * Outside configHash: a change neither redeploys nor breaks continuity. It can only RESTRICT: the global automatic reply
 * (`SAV_V2_AUTO_REPLY=access` + approver) and every check of A's rule still apply first, so the effective mode is the stricter of the two.
 *
 * No row = today's behaviour (`auto`, not paused). `off` or paused: the block's reply is never proposed, approved or queued; its case waits
 * visibly with a closed code (`block_off`, `block_paused`). `draft`: the reply is proposed for a person, never approved by the rule.
 * An unreadable row fails closed (`block_setting_invalid`, never sends), never as auto.
 */

type Reader = Pick<Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0], "select">;
export const SAV_BLOCK_SWITCH_REVISION = "sav-block-switch.v1";
export const SAV_BLOCK_MODES = ["off", "draft", "auto"] as const;
export type SavBlockMode = typeof SAV_BLOCK_MODES[number];
export const SAV_BLOCK_SWITCH_DEFAULT = Object.freeze({ mode: "auto" as SavBlockMode, paused: false });
export const savBlockSwitchKey = (blockId: string) => `${SAV_BLOCK_SWITCH_REVISION}:${blockId}`;
export const savBlockSwitchSchema = z.object({
  revision: z.literal(SAV_BLOCK_SWITCH_REVISION), blockId: z.string().regex(SAV_CASE_BLOCK_ID), mode: z.enum(SAV_BLOCK_MODES), paused: z.boolean(),
  setBy: z.string().min(3).max(320), setAt: z.iso.datetime(), reason: z.string().trim().min(3).max(500),
}).strict();
export type SavBlockSwitch = z.infer<typeof savBlockSwitchSchema>;
export type SavBlockSwitchState = Readonly<{ blockId: string; mode: SavBlockMode; paused: boolean; setting: SavBlockSwitch | null; invalid: boolean }>;

export async function readSavBlockSwitch(db: Reader, blockId: string): Promise<SavBlockSwitchState> {
  const [row] = await db.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, savBlockSwitchKey(blockId)));
  if (!row) return { blockId, ...SAV_BLOCK_SWITCH_DEFAULT, setting: null, invalid: false };
  try {
    const setting = savBlockSwitchSchema.parse(decryptSavPayload(row.cursor!));
    if (setting.blockId !== blockId) throw Error("SAV_BLOCK_SWITCH_KEY_MISMATCH");
    return { blockId, mode: setting.mode, paused: setting.paused, setting, invalid: false };
  } catch { return { blockId, mode: "off", paused: false, setting: null, invalid: true }; }
}

/** What the block lets the reply passage do. `rule`: today's path (A's rule may still refuse). `person`: proposed, never approved by the rule. `never`: nothing proposed. */
export type SavBlockReplyGate = Readonly<{ send: "rule" }> | Readonly<{ send: "person"; code: "block_draft" }>
  | Readonly<{ send: "never"; code: "block_off" | "block_paused" | "block_setting_invalid" }>;
export function savBlockReplyGate(state: Pick<SavBlockSwitchState, "mode" | "paused" | "invalid">): SavBlockReplyGate {
  if (state.invalid) return { send: "never", code: "block_setting_invalid" };
  if (state.paused) return { send: "never", code: "block_paused" };
  if (state.mode === "off") return { send: "never", code: "block_off" };
  if (state.mode === "draft") return { send: "person", code: "block_draft" };
  return { send: "rule" };
}

/** The effective mode, for the Studio: the stricter of the block's switch and the global automatic reply (which today exists for Access only). */
export type SavBlockEffectiveMode = "off" | "paused" | "draft" | "auto";
export function savBlockEffectiveMode(state: Pick<SavBlockSwitchState, "blockId" | "mode" | "paused" | "invalid">, env: Readonly<Record<string, string | undefined>>): SavBlockEffectiveMode {
  const gate = savBlockReplyGate(state);
  if (gate.send === "never") return gate.code === "block_paused" ? "paused" : "off";
  if (gate.send === "person") return "draft";
  return state.blockId === SAV_CASE_ACCESS_BLOCK_ID && readAccessAutoApprovalConfig(env).mode === "on" ? "auto" : "draft";
}
