import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savMailboxes, savMessages, savSyncState } from "@/db/schema";

export const SAV_V0_CUTOVER_KEY = "sav-v0-cutover";
const cutoverSchema = z.object({
  receivedAfter: z.iso.datetime({ offset: true }),
  mailboxEmail: z.email(), intakeRecipient: z.literal("contact@limova.ai"),
  deploymentSha: z.string().regex(/^[a-f0-9]{40}$/), activatedBy: z.email(),
});
export type SavV0Cutover = z.infer<typeof cutoverSchema>;

export async function getSavV0Cutover(): Promise<SavV0Cutover | null> {
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, SAV_V0_CUTOVER_KEY)).limit(1);
  if (!row || row.status !== "active" || !row.cursor) return null;
  return cutoverSchema.parse(JSON.parse(row.cursor));
}

/** Explicit rollout operation. Never called by ingestion, crons, or a model. */
export async function activateSavV0Cutover(input: SavV0Cutover) {
  const boundary = cutoverSchema.parse(input);
  if (boundary.activatedBy.toLowerCase() !== "ugo@limova.ai") throw new Error("SAV_CUTOVER_UGO_APPROVAL_REQUIRED");
  if (Date.parse(boundary.receivedAfter) > Date.now()) throw new Error("SAV_CUTOVER_IN_FUTURE");
  const db = requireDb();
  return db.transaction(async (tx) => {
    const [mailbox] = await tx.select({ id: savMailboxes.id }).from(savMailboxes).where(eq(savMailboxes.email, boundary.mailboxEmail)).limit(1);
    if (!mailbox) throw new Error("SAV_CUTOVER_MAILBOX_NOT_CONFIGURED");
    const [created] = await tx.insert(savSyncState).values({ key: SAV_V0_CUTOVER_KEY, status: "active", cursor: JSON.stringify(boundary), startedAt: new Date() }).onConflictDoNothing().returning();
    if (!created) {
      const [existing] = await tx.select().from(savSyncState).where(eq(savSyncState.key, SAV_V0_CUTOVER_KEY)).limit(1);
      if (existing?.status !== "active" || existing.cursor !== JSON.stringify(boundary)) throw new Error("SAV_CUTOVER_IMMUTABLE");
      return boundary;
    }
    await tx.insert(auditLogs).values({ actorEmail: boundary.activatedBy, action: "sav_v0_cutover_activated", entityType: "sav_mailbox", entityId: mailbox.id, technicalMetadata: boundary });
    return boundary;
  });
}

/** Correlated SQL predicate: historical rows remain stored but never enter V0. */
export function savV0EligibleMessageFilter() {
  return sql`exists (
    select 1 from sav.sync_state as v0_cutover
    join sav.mailboxes as v0_mailbox on v0_mailbox.id = ${savMessages.mailboxId}
    where v0_cutover.key = ${SAV_V0_CUTOVER_KEY} and v0_cutover.status = 'active'
    and v0_mailbox.email = (v0_cutover.cursor::jsonb ->> 'mailboxEmail')
    and ${savMessages.receivedAt} > (v0_cutover.cursor::jsonb ->> 'receivedAfter')::timestamptz
  )`;
}

export async function isSavMessageEligible(messageId: string) {
  const [message] = await requireDb().select({ id: savMessages.id }).from(savMessages)
    .where(sql`${savMessages.id} = ${messageId} and ${savV0EligibleMessageFilter()}`).limit(1);
  return Boolean(message);
}
