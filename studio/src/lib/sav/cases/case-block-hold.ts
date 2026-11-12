import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { readSavBlockSwitch, savBlockReplyGate } from "./block-switch";

/*
 * SAV-18 (review, MEDIUM): a case held by its block's switch (`block_held`: off, paused or unreadable) is a durable, visible wait, not a log line.
 * One marker per case (like the continuation failure marker), set when the passage reports `block_held`, cleared by the next pass that is not held.
 * The continuation sweep skips a held case while its block still never sends, so held cases never take its slots; once the block's switch lets the
 * rule or a person act again, the next sweep takes the case once and the pass clears the marker.
 */

export const CASE_BLOCK_HOLD_MARK = { action: "sav_v2_continuation_block_held", entityType: "sav_v2_case" } as const;
export const CASE_BLOCK_HOLD_REASONS = ["block_off", "block_paused", "block_setting_invalid"] as const;
export type CaseBlockHoldReason = typeof CASE_BLOCK_HOLD_REASONS[number];
export type CaseBlockHold = Readonly<{ blockId: string; reason: CaseBlockHoldReason; since: string; lastAt: string }>;
type Db = ReturnType<typeof requireDb>;

const row = (caseId: string) => and(eq(auditLogs.entityType, CASE_BLOCK_HOLD_MARK.entityType), eq(auditLogs.entityId, caseId), eq(auditLogs.action, CASE_BLOCK_HOLD_MARK.action));
const BLOCK_ID = /^[a-z][a-z0-9_-]{1,39}$/;
function parse(meta: unknown): CaseBlockHold | null {
  const m = meta as Partial<Record<keyof CaseBlockHold, unknown>> | null;
  if (!m || typeof m.blockId !== "string" || !BLOCK_ID.test(m.blockId) || !CASE_BLOCK_HOLD_REASONS.includes(m.reason as CaseBlockHoldReason)
    || typeof m.since !== "string" || typeof m.lastAt !== "string") return null;
  return { blockId: m.blockId, reason: m.reason as CaseBlockHoldReason, since: m.since, lastAt: m.lastAt };
}

/** Sets (or refreshes, keeping `since`) the case's held marker; `null` clears it. Never touches the case, its events, a proposal or an execution. */
export async function markCaseBlockHold(caseId: string, hold: Readonly<{ blockId: string; reason: string }> | null, db: Db = requireDb()) {
  const [existing] = await db.select().from(auditLogs).where(row(caseId));
  if (hold === null) { if (existing) await db.delete(auditLogs).where(row(caseId)); return; }
  const now = new Date().toISOString(), previous = parse(existing?.technicalMetadata);
  const technicalMetadata = { blockId: BLOCK_ID.test(hold.blockId) ? hold.blockId : "access", reason: CASE_BLOCK_HOLD_REASONS.includes(hold.reason as CaseBlockHoldReason) ? hold.reason : "block_setting_invalid",
    since: previous && previous.blockId === hold.blockId ? previous.since : now, lastAt: now };
  if (existing) await db.update(auditLogs).set({ technicalMetadata }).where(row(caseId));
  else await db.insert(auditLogs).values({ actorEmail: "system", ...CASE_BLOCK_HOLD_MARK, entityId: caseId, technicalMetadata });
}

export async function readCaseBlockHold(caseId: string, db: Db = requireDb()): Promise<CaseBlockHold | null> {
  const [existing] = await db.select({ meta: auditLogs.technicalMetadata }).from(auditLogs).where(row(caseId));
  return existing ? parse(existing.meta) ?? { blockId: "access", reason: "block_setting_invalid", since: "", lastAt: "" } : null;
}

/** Among `caseIds`, those still held: a marker whose block's switch still never sends (read now). A marker of a block that may act again is not held: the case resumes. */
export async function caseIdsStillHeldByBlock(caseIds: readonly string[], db: Db = requireDb()): Promise<Set<string>> {
  if (!caseIds.length) return new Set();
  const marks = await db.select({ id: auditLogs.entityId, meta: auditLogs.technicalMetadata }).from(auditLogs)
    .where(and(eq(auditLogs.entityType, CASE_BLOCK_HOLD_MARK.entityType), eq(auditLogs.action, CASE_BLOCK_HOLD_MARK.action), inArray(auditLogs.entityId, [...caseIds])));
  const gates = new Map<string, boolean>(), held = new Set<string>();
  for (const mark of marks) {
    const blockId = parse(mark.meta)?.blockId ?? "access";
    if (!gates.has(blockId)) gates.set(blockId, savBlockReplyGate(await readSavBlockSwitch(db, blockId)).send === "never");
    if (gates.get(blockId) && mark.id) held.add(mark.id);
  }
  return held;
}
