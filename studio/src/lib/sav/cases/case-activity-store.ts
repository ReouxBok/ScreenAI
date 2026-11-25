// 25/11 (`SAV_V2_CASE_THREAD_REPLY=on`): when a closed V2 case last moved before a mail. Read by V1's case fact (`ack-ticket-store.ts`) and V2's customer return
// (`customer-return-store.ts`), so both apply the same 15-day window (`caseThreadReplyWithinWindow`). Read only.
import "server-only";
import { and, eq, inArray, lte, max } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEvents } from "@/db/schema";

type Reader = Pick<ReturnType<typeof requireDb>, "select">;

/** The case's latest reply, timer, command or owner change before `before`, else its latest customer mail; NaN when none is readable. Bookkeeping events
 * (admission, observations, CRM reads) can come after the closure and are not counted, so a window measured from here never exceeds 15 days after it. */
export async function savCaseLastActivity(caseId: string, before: Date, db: Reader = requireDb()): Promise<number> {
  const latest = async (kinds: string[]) => (await db.select({ at: max(savCaseEvents.occurredAt) }).from(savCaseEvents)
    .where(and(eq(savCaseEvents.caseId, caseId), inArray(savCaseEvents.kind, kinds), lte(savCaseEvents.occurredAt, before))))[0]?.at;
  const at = await latest(["outbound_observed", "timer_fired", "human_command", "owner_changed"]) ?? await latest(["inbound_confirmed"]);
  const time = at ? new Date(at).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : Number.NaN;
}
