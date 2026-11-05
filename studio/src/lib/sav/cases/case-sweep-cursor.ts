// V2 sweeps (local, OFF): a bounded, DURABLE walk over the cases touched since a date, so that no case is starved by the ones before it.
// The previous sweeps read « newest first, at most N » with no cursor: when N cases stayed in a state that does nothing (a thanks, a wait, a notice already queued), the N+1th
// was never read again. Here the walk is by case id (stable: a case touched again does not change place), N per call, from a cursor kept in `sav.sync_state`; at the end of the
// window the cursor is cleared and the next call starts over. The cursor only says where to start reading: every effect behind a sweep keeps its own unique key, so a crash
// before the cursor moves, two concurrent sweeps or a second lap re-read cases and write nothing twice (one notice, one closure).
import "server-only";
import { and, asc, eq, gt, gte } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCases, savSyncState } from "@/db/schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9_-]{1,40}$/;
export const sweepCursorKey = (name: string) => NAME.test(name) ? `sav-v2-sweep.v1:${name}` : (() => { throw Error("SAV_SWEEP_NAME_INVALID"); })();

export type SweepPage = Readonly<{
  ids: readonly string[];
  /** True when this page ended the window: the next call starts over from the first case. */
  windowEnded: boolean;
  /**
   * Moves the cursor past the cases that were HANDLED (`handled` of the page, default all). A sweep that stopped early (deadline) commits only its prefix, so the next call
   * starts at the first unhandled case: nothing is skipped. A crash before the commit re-reads the page, which is harmless.
   */
  commit: (handled?: number) => Promise<void>;
}>;

export async function nextSweepPage(input: Readonly<{ name: string; since: Date; limit: number }>): Promise<SweepPage> {
  const db = requireDb(), key = sweepCursorKey(input.name), limit = Math.min(Math.max(Math.trunc(input.limit), 1), 200);
  const [row] = await db.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, key));
  // The cursor belongs to a window: another `since`, or an unreadable value, starts from the first case.
  const [window, after] = (row?.cursor ?? "").split("|");
  const start = window === input.since.toISOString() && after && UUID.test(after) ? after : null;
  const ids = (await db.select({ id: savCases.id }).from(savCases)
    .where(start ? and(gte(savCases.updatedAt, input.since), gt(savCases.id, start)) : gte(savCases.updatedAt, input.since))
    .orderBy(asc(savCases.id)).limit(limit)).map(r => r.id);
  const windowEnded = ids.length < limit;
  return {
    ids, windowEnded,
    commit: async (handled = ids.length) => {
      const done = Math.min(Math.max(Math.trunc(handled), 0), ids.length);
      if (done === 0 && ids.length > 0) return; // nothing handled: the cursor stays where it was
      // A short or empty page ended the window; so does a full one handled to its last case only if it was the last page (windowEnded).
      const cursor = windowEnded && done === ids.length ? null : `${input.since.toISOString()}|${ids[done - 1]}`;
      await db.insert(savSyncState).values({ key, cursor, status: "idle", updatedAt: new Date() })
        .onConflictDoUpdate({ target: savSyncState.key, set: { cursor, updatedAt: new Date() } });
    },
  };
}
