import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savSyncState } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { executionAdministrator } from "./execution-policy";
import { readSavAgentPause, savAgentPauseKey, SAV_AGENT_PAUSE_LEVELS, SAV_AGENT_PAUSE_REVISION, type SavAgentPause, type SavAgentPauseLevel, type SavAgentPauseState } from "./agent-pause";

const AUDIT = { action: "sav_agent_pause_set", entityType: "sav_agent_pause" } as const;
/** Same authority as the execution policy: active admin/owner with SAV access. */
export async function savAgentPauseAdministrator() {
  return executionAdministrator().catch(() => { throw Error("SAV_AGENT_PAUSE_UNAUTHORIZED"); });
}
// v2 is reserved in the stored key and reader; it becomes settable when an agent reads it.
// expectedLevel/expectedSetAt: optional precondition (MCP), compared under the lock before any write.
const inputSchema = z.object({ agent: z.literal("intake"), level: z.enum(SAV_AGENT_PAUSE_LEVELS), reason: z.string().trim().min(3).max(500),
  expectedLevel: z.enum(SAV_AGENT_PAUSE_LEVELS).optional(), expectedSetAt: z.iso.datetime().nullable().optional() }).strict();
/** Serialized with every model reservation through the same budget lock, so a reservation
 * either committed before the change or sees it. Never touches the ledger, attempts or wakes. */
export async function setSavAgentPause(raw: unknown): Promise<SavAgentPause> {
  const staff = await savAgentPauseAdministrator(), input = inputSchema.parse(raw);
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-runtime-model-budget-v1'))`);
    // An unreadable previous row is replaced, never trusted; the audit keeps that fact.
    const state = await readSavAgentPause(tx, input.agent), previous = state.invalid ? "invalid" : state.level;
    if (input.expectedLevel !== undefined && state.level !== input.expectedLevel
      || input.expectedSetAt !== undefined && (state.setting?.setAt ?? null) !== input.expectedSetAt) throw Error("SAV_AGENT_PAUSE_CHANGED");
    const next: SavAgentPause = { revision: SAV_AGENT_PAUSE_REVISION, agent: input.agent, level: input.level, setBy: staff.email, setAt: new Date().toISOString(), reason: input.reason };
    const values = { key: savAgentPauseKey(input.agent), cursor: encryptSavPayload(next), status: "active", updatedAt: new Date(next.setAt) };
    await tx.insert(savSyncState).values(values).onConflictDoUpdate({ target: savSyncState.key, set: values });
    await tx.insert(auditLogs).values({ actorEmail: staff.email, ...AUDIT, entityId: input.agent,
      technicalMetadata: { previousLevel: previous, nextLevel: input.level, reason: input.reason } });
    return next;
  });
}
export type SavAgentPausePanel = {
  state: SavAgentPauseState;
  history: Array<{ at: string; actor: string; previousLevel: string; nextLevel: SavAgentPauseLevel; reason: string }>;
};
export async function readSavAgentPausePanel(): Promise<SavAgentPausePanel> {
  await savAgentPauseAdministrator();
  const db = requireDb(), state = await readSavAgentPause(db, "intake");
  const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.action, AUDIT.action), eq(auditLogs.entityType, AUDIT.entityType), eq(auditLogs.entityId, "intake")))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(10);
  const history = rows.map(row => { const m = row.technicalMetadata;
    return { at: row.createdAt.toISOString(), actor: row.actorEmail, previousLevel: String(m.previousLevel ?? ""), nextLevel: m.nextLevel as SavAgentPauseLevel, reason: String(m.reason ?? "") }; });
  return { state, history };
}
export type SavAgentPauseBanner = { level: Exclude<SavAgentPauseLevel, "running">; setBy: string | null; setAt: string | null; invalid: boolean };
/** Console banner: no administrator needed (the console page has its own access check); no reason shown. */
export async function readSavAgentPauseBanner(): Promise<SavAgentPauseBanner | null> {
  const state = await readSavAgentPause(requireDb(), "intake");
  if (state.level === "running") return null;
  return { level: state.level, setBy: state.setting?.setBy ?? null, setAt: state.setting?.setAt ?? null, invalid: state.invalid };
}
