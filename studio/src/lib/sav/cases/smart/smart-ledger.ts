import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../../crypto";

/*
 * Agent SAV intelligent, lot E (20/11): the OWN spend ledger of the new agent's shadow (and of its bench self-test), separate from V2's daily
 * budget, which it never reads nor touches. Storage: `sav.sync_state`, no migration, like the Access self-test:
 *   - one ledger row per scope (a UTC day for the shadow, a run id for the bench), `{ items, settledMicroUsd, open }`, locked FOR UPDATE at
 *     each change, so two overlapping passes (the cron and the self-scheduler) are serialised;
 *   - one row per item (a mail, a conversation turn), its result encrypted, CLAIMED in the same transaction that reserves the item's WORST case
 *     (every call it may make) BEFORE any paid call. A second claimer finds it and never pays again.
 * Settling replaces the reservation by the measured cost (a call with an unknown or uncertain usage costs its full reservation). An item left
 * claimed (a crash, a call that never answered) keeps its whole reservation forever: never released, never paid twice, the cap stays true.
 */

export type SmartLedgerState = { version: 1; items: number; settledMicroUsd: number; open: Record<string, number> };
export type SmartItemRow<T> = { version: 1; scope: string; reservedMicroUsd: number; costMicroUsd: number | null; result: T | null };
export type SmartClaim = Readonly<{ status: "claimed" }> | Readonly<{ status: "refused"; reason: "already_claimed" | "money_cap" | "item_cap" }>;

export const smartLedgerKey = (prefix: string, scope: string) => `${prefix}:ledger:${scope}`;
export const smartItemKey = (prefix: string, item: string) => `${prefix}:item:${item}`;
export const smartLedgerSpent = (state: SmartLedgerState) => state.settledMicroUsd + Object.values(state.open).reduce((sum, value) => sum + value, 0);

/** Reserves the worst case of one item and claims it, atomically; refused when already claimed, past the money cap or the item cap. */
export async function claimSmartItem(input: Readonly<{ prefix: string; scope: string; item: string; worstMicroUsd: number; capMicroUsd: number; maxItems: number | null; now: Date }>): Promise<SmartClaim> {
  const ledgerKey = smartLedgerKey(input.prefix, input.scope), itemKey = smartItemKey(input.prefix, input.item);
  return requireDb().transaction(async tx => {
    await tx.insert(savSyncState).values({ key: ledgerKey, status: "open", cursor: JSON.stringify({ version: 1, items: 0, settledMicroUsd: 0, open: {} } satisfies SmartLedgerState), startedAt: input.now }).onConflictDoNothing();
    const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, ledgerKey)).for("update");
    const state = JSON.parse(row!.cursor ?? "null") as SmartLedgerState;
    const [existing] = await tx.select({ key: savSyncState.key }).from(savSyncState).where(eq(savSyncState.key, itemKey));
    if (existing) return { status: "refused", reason: "already_claimed" } as const;
    if (input.maxItems !== null && state.items >= input.maxItems) return { status: "refused", reason: "item_cap" } as const;
    if (smartLedgerSpent(state) + input.worstMicroUsd > input.capMicroUsd) return { status: "refused", reason: "money_cap" } as const;
    await tx.insert(savSyncState).values({ key: itemKey, status: "pending", startedAt: input.now,
      cursor: encryptSavPayload({ version: 1, scope: input.scope, reservedMicroUsd: input.worstMicroUsd, costMicroUsd: null, result: null } satisfies SmartItemRow<never>) });
    const next: SmartLedgerState = { ...state, items: state.items + 1, open: { ...state.open, [input.item]: input.worstMicroUsd } };
    await tx.update(savSyncState).set({ cursor: JSON.stringify(next), processedCount: next.items, updatedAt: input.now }).where(eq(savSyncState.key, ledgerKey));
    return { status: "claimed" } as const;
  });
}

/** Settles one claimed item with its measured cost and stores its result (encrypted), atomically. A second settle changes nothing. */
export async function settleSmartItem<T>(input: Readonly<{ prefix: string; scope: string; item: string; costMicroUsd: number; result: T; status: string; now: Date }>): Promise<boolean> {
  const ledgerKey = smartLedgerKey(input.prefix, input.scope), itemKey = smartItemKey(input.prefix, input.item);
  return requireDb().transaction(async tx => {
    const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, ledgerKey)).for("update");
    const [item] = await tx.select().from(savSyncState).where(eq(savSyncState.key, itemKey)).for("update");
    if (!row || !item || item.status !== "pending") return false;
    const state = JSON.parse(row.cursor ?? "null") as SmartLedgerState, stored = decryptSavPayload<SmartItemRow<T>>(item.cursor ?? "");
    const open = { ...state.open };
    delete open[input.item];
    const next: SmartLedgerState = { ...state, settledMicroUsd: state.settledMicroUsd + input.costMicroUsd, open };
    await tx.update(savSyncState).set({ cursor: JSON.stringify(next), updatedAt: input.now }).where(eq(savSyncState.key, ledgerKey));
    await tx.update(savSyncState).set({ status: input.status, completedAt: input.now, updatedAt: input.now,
      cursor: encryptSavPayload({ ...stored, costMicroUsd: input.costMicroUsd, result: input.result } satisfies SmartItemRow<T>) }).where(eq(savSyncState.key, itemKey));
    return true;
  });
}

/** The ledger of one scope (read only), or an empty one. */
export async function readSmartLedger(prefix: string, scope: string): Promise<SmartLedgerState> {
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, smartLedgerKey(prefix, scope)));
  return row?.cursor ? JSON.parse(row.cursor) as SmartLedgerState : { version: 1, items: 0, settledMicroUsd: 0, open: {} };
}
