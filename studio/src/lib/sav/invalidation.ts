import "server-only";
import { and, eq, inArray, or } from "drizzle-orm";
import { requireDb } from "@/db";
import { savActions, savFollowups } from "@/db/schema";

/** Use the caller's transaction so a new message/takeover and invalidation commit together. */
export async function invalidateSavReplies(
  tx: Pick<ReturnType<typeof requireDb>, "update">,
  threadId: string,
  reason: "SAV_REPLY_OBSOLETE" | "SAV_THREAD_PAUSED",
  now = new Date(),
) {
  await tx.update(savActions).set({ status: "cancelled", errorCode: reason, updatedAt: now }).where(and(
    eq(savActions.threadId, threadId),
    or(
      and(eq(savActions.kind, "send_reply"), eq(savActions.status, "pending")),
      and(eq(savActions.kind, "draft_reply"), eq(savActions.status, "succeeded")),
    ),
  ));
  await tx.update(savFollowups).set({ status: "cancelled", cancelledAt: now }).where(and(
    eq(savFollowups.threadId, threadId), inArray(savFollowups.status, ["scheduled", "queued"]),
  ));
}
