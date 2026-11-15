import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";

/*
 * SAV-92 (review batch 3, B1): a reply that names a team part is proposed only once that part's notice is durably queued. When the notice cannot be
 * queued (`team_part_handoff_unavailable`: the notice is off, its policy is absent, or the queue failed), nothing is promised to the customer and the
 * case used to wait SILENTLY, retried at every sweep. Now:
 *   - visible: one marker per case (like the block hold), with the closed code, a closed detail, the number of passes refused and since when; read by
 *     the diagnostics and the V2 console;
 *   - bounded: a transient failure heals at the next pass (the marker is cleared by the first pass with another outcome); after
 *     `SAV_CASE_TEAM_PART_WAIT_BOUNDS.maxPasses` refused passes, or `maxWaitMs` since the first one, the WHOLE mail goes to the team: the case is
 *     handed off (owner `human`, phase `handoff_pending`, reason `team_part_handoff_unavailable`), so the agent stops retrying and a person sees it.
 *     The marker then stays, `handedToTeam`, as the visible trace (cleared only by a later pass with another outcome, once the case is the agent's
 *     again). Nothing is sent to the customer by this module, ever.
 */

export const SAV_CASE_TEAM_PART_WAIT_CODE = "team_part_handoff_unavailable";
export const CASE_TEAM_PART_WAIT_MARK = { action: "sav_v2_continuation_team_part_wait", entityType: "sav_v2_case" } as const;
/** 6 refused passes (the immediate one and five sweeps) or 2 hours, whichever comes first. */
export const SAV_CASE_TEAM_PART_WAIT_BOUNDS = Object.freeze({ maxPasses: 6, maxWaitMs: 2 * 60 * 60 * 1000 });
/** Closed details only (the passage's own codes); anything else is `other`. */
export const SAV_CASE_TEAM_PART_WAIT_DETAILS = ["disabled", "token_missing", "channel_invalid", "owner_invalid", "portal_invalid", "notice_unreadable",
  "execution_policy_absent", "trigger_refused", "other"] as const;
export type CaseTeamPartWaitDetail = typeof SAV_CASE_TEAM_PART_WAIT_DETAILS[number];

export type CaseTeamPartWait = Readonly<{ code: typeof SAV_CASE_TEAM_PART_WAIT_CODE; detail: CaseTeamPartWaitDetail; passes: number; since: string; lastAt: string; handedToTeam: string | null }>;

const closedDetail = (value: string | undefined): CaseTeamPartWaitDetail => (SAV_CASE_TEAM_PART_WAIT_DETAILS as readonly string[]).includes(value ?? "") ? value as CaseTeamPartWaitDetail
  : value && /^(no_record|no_decision|not_handoff|not_accepted|stale_input|taken_by_person|whole_mail_handed_off|input_other|key_conflict)$/.test(value) ? "trigger_refused" : "other";

function parse(meta: unknown): CaseTeamPartWait | null {
  const m = meta as Partial<Record<keyof CaseTeamPartWait, unknown>> | null;
  if (!m || m.code !== SAV_CASE_TEAM_PART_WAIT_CODE || typeof m.passes !== "number" || !Number.isInteger(m.passes) || m.passes < 1 || typeof m.since !== "string"
    || typeof m.lastAt !== "string" || !(m.handedToTeam === null || typeof m.handedToTeam === "string")) return null;
  return { code: SAV_CASE_TEAM_PART_WAIT_CODE, detail: closedDetail(typeof m.detail === "string" ? m.detail : undefined), passes: m.passes, since: m.since, lastAt: m.lastAt, handedToTeam: m.handedToTeam };
}

/** Pure: the next state of the wait after one more refused pass, and whether the bound is reached (the whole mail then goes to the team). */
export function nextCaseTeamPartWait(previous: CaseTeamPartWait | null, detail: string | undefined, now: Date, bounds = SAV_CASE_TEAM_PART_WAIT_BOUNDS) {
  // A wait already handed to the team and refused again (the case came back to the agent): a new wait, bounded again from zero.
  const base = previous?.handedToTeam ? null : previous;
  const at = now.toISOString(), since = base?.since && Number.isFinite(Date.parse(base.since)) ? base.since : at;
  const passes = (base?.passes ?? 0) + 1;
  const bounded = passes >= bounds.maxPasses || now.getTime() - Date.parse(since) >= bounds.maxWaitMs;
  return { wait: { code: SAV_CASE_TEAM_PART_WAIT_CODE, detail: closedDetail(detail), passes, since, lastAt: at, handedToTeam: null } as CaseTeamPartWait, bounded };
}

type Db = ReturnType<typeof requireDb>;
const row = (caseId: string) => and(eq(auditLogs.entityType, CASE_TEAM_PART_WAIT_MARK.entityType), eq(auditLogs.entityId, caseId), eq(auditLogs.action, CASE_TEAM_PART_WAIT_MARK.action));

export async function readCaseTeamPartWait(caseId: string, db: Db = requireDb()): Promise<CaseTeamPartWait | null> {
  const [existing] = await db.select({ meta: auditLogs.technicalMetadata }).from(auditLogs).where(row(caseId));
  // An unreadable marker is still a wait: shown, never hidden.
  return existing ? parse(existing.meta) ?? { code: SAV_CASE_TEAM_PART_WAIT_CODE, detail: "other", passes: 1, since: "", lastAt: "", handedToTeam: null } : null;
}

async function write(caseId: string, wait: CaseTeamPartWait, exists: boolean, db: Db) {
  if (exists) await db.update(auditLogs).set({ technicalMetadata: wait }).where(row(caseId));
  else await db.insert(auditLogs).values({ actorEmail: "system", ...CASE_TEAM_PART_WAIT_MARK, entityId: caseId, technicalMetadata: wait });
}

export type CaseTeamPartWaitOutcome = { state: "cleared" | "none" } | { state: "waiting"; passes: number } | { state: "handed_to_team" | "handoff_failed"; passes: number };

/**
 * After a continuation pass. `refused`: the pass returned `team_part_handoff_unavailable` (with its closed detail). Anything else clears a marker
 * that was not yet handed to the team (the wait is over). A refused pass counts one more; at the bound the case is handed to the team, once
 * (idempotent command key per case version). A case no longer the agent's (a person took it) is only marked, never transferred again.
 */
export async function settleCaseTeamPartWait(caseId: string, refused: Readonly<{ detail?: string }> | null, now = new Date(), db: Db = requireDb()): Promise<CaseTeamPartWaitOutcome> {
  const [existing] = await db.select({ meta: auditLogs.technicalMetadata }).from(auditLogs).where(row(caseId));
  const previous = existing ? parse(existing.meta) : null;
  // Another outcome: the wait is over (a pass only runs on a case the agent holds, so a handed-off trace is cleared only once the case came back and passed).
  if (!refused) {
    if (!existing) return { state: "none" };
    await db.delete(auditLogs).where(row(caseId));
    return { state: "cleared" };
  }
  const { wait, bounded } = nextCaseTeamPartWait(previous, refused.detail, now);
  if (!bounded) { await write(caseId, wait, Boolean(existing), db); return { state: "waiting", passes: wait.passes }; }
  // Loaded here: the case store reads this marker for its diagnostics (no import cycle at load time).
  const { readCase, transitionCaseOwner } = await import("./case-store");
  const current = await readCase(caseId);
  if (current?.owner === "agent") {
    try {
      await transitionCaseOwner({ caseId, expectedVersion: current.version, transition: "handoff", actor: { type: "agent" },
        commandKey: `team-part-wait-handoff-v${current.version}`, reason: SAV_CASE_TEAM_PART_WAIT_CODE });
    } catch {
      // The case moved meanwhile (a new mail, a person): kept visible, counted; the next pass tries again on the fresh version.
      await write(caseId, wait, Boolean(existing), db);
      return { state: "handoff_failed", passes: wait.passes };
    }
  }
  await write(caseId, { ...wait, handedToTeam: now.toISOString() }, Boolean(existing), db);
  return { state: "handed_to_team", passes: wait.passes };
}
