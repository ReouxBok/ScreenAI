import { readSavExternalCompletion, listSavExternalCompletionMessageIds } from "../external-completion";
import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savThreads, savMessages } from "@/db/schema";
import type { IntakeRuntimeConfig } from "./runtime-contract";

type Reader = Pick<ReturnType<typeof requireDb>, "execute" | "select">;
type Scope = Pick<IntakeRuntimeConfig, "mailboxId" | "receivedAfter" | "createdAfter">;
export const SAV_INTAKE_LEGACY_PAUSE_REVISION = "sav-intake-legacy-pause.v1";

/** A pause is a human hold only when a person asked for it: "Transférer à un
 * humain" (request_human by a human) or a human correction to review_required.
 * The pre-intake V0 pipeline also paused every review_required AI decision; that
 * automatic pause must not freeze customer replies that intake now owns. */
const humanHold = (threadId: ReturnType<typeof sql>) => sql`(
  exists(select 1 from sav.actions a where a.thread_id = ${threadId} and a.kind = 'request_human' and a.actor_type = 'human')
  or exists(select 1 from sav.decisions d join sav.messages dm on dm.id = d.message_id
    where dm.thread_id = ${threadId} and d.actor_type = 'human' and d.kind = 'human_review_required' and d.is_current))`;

/** Latest inbound of the thread lies inside the launched intake scope. */
const latestInboundInScope = (threadId: ReturnType<typeof sql>, scope: Scope) => sql`exists(select 1 from sav.messages m
  where m.id = (select latest.id from sav.messages latest where latest.thread_id = ${threadId} and latest.direction = 'inbound'
    order by latest.received_at desc, latest.created_at desc, latest.id desc limit 1)
  and m.mailbox_id = ${scope.mailboxId}::uuid and m.received_at > ${scope.receivedAfter}::timestamptz and m.created_at > ${scope.createdAfter}::timestamptz)`;

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[];
}

/** Threads whose only pause comes from the legacy AI and whose latest inbound
 * belongs to intake. Read only; bounded. */
export async function listLegacyAiPausedIntakeThreads(scope: Scope, limit = 20, db: Reader = requireDb()) {
  const completedIds = await listSavExternalCompletionMessageIds(db, false, scope.mailboxId);
  const notCompleted = completedIds.length ? sql`not exists(select 1 from sav.messages cm where cm.thread_id=t.id and cm.id in (${sql.join(completedIds.map(id => sql`${id}::uuid`), sql`, `)}))` : sql`true`;
  const t = sql`t.id`;
  const result = await db.execute(sql`select t.id from sav.threads t
    where t.ai_paused and t.mailbox_id = ${scope.mailboxId}::uuid and ${latestInboundInScope(t, scope)} and not ${humanHold(t)} and ${notCompleted}
    order by t.updated_at asc, t.id asc limit ${Math.min(50, Math.max(1, limit))}`);
  return rows<{ id: string }>(result).map(row => row.id);
}

/** Lift the automatic legacy pause so intake can analyse the customer's reply.
 * Re-checked under the thread lock; a human hold is never lifted here. Status,
 * humanRequestedAt and the legacy deadline are kept for the legacy dashboard. */
export async function releaseLegacyAiPauses(scope: Scope, limit = 20) {
  const db = requireDb(), released: string[] = [];
  for (const threadId of await listLegacyAiPausedIntakeThreads(scope, limit, db)) {
    const done = await db.transaction(async tx => {
      const [thread] = await tx.select({ id: savThreads.id, aiPaused: savThreads.aiPaused, status: savThreads.status })
        .from(savThreads).where(eq(savThreads.id, threadId)).for("update");
      if (!thread?.aiPaused) return false;
      const [message] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
      if (message && await readSavExternalCompletion(message, tx)) return false;
      const id = sql`${threadId}::uuid`;
      const eligible = rows<{ ok: boolean }>(await tx.execute(sql`select (${latestInboundInScope(id, scope)} and not ${humanHold(id)}) as ok`))[0]?.ok;
      if (!eligible) return false;
      const now = new Date();
      const [updated] = await tx.update(savThreads).set({ aiPaused: false, updatedAt: now })
        .where(and(eq(savThreads.id, threadId), eq(savThreads.aiPaused, true))).returning({ id: savThreads.id });
      if (!updated) return false;
      await tx.insert(auditLogs).values({ actorEmail: "system", action: "sav_intake_legacy_ai_pause_released", entityType: "sav_thread", entityId: threadId,
        technicalMetadata: { revision: SAV_INTAKE_LEGACY_PAUSE_REVISION, status: thread.status }, createdAt: now });
      return true;
    });
    if (done) released.push(threadId);
  }
  return { released: released.length };
}
