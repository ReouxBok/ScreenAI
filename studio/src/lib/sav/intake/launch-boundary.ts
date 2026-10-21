import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savSyncState, savMessages, savMailboxes, staffUsers, auditLogs } from "@/db/schema";
import { intakeConsoleInstalled } from "./console-capability";
import type { IntakeRuntimeConfig } from "./runtime-contract";

const launchSchema = z.object({ revision: z.literal("sav-intake-launch.v1"), mailboxId: z.uuid(),
  receivedAfter: z.iso.datetime(), createdAfter: z.iso.datetime(), actorId: z.uuid(), recordedAt: z.iso.datetime() }).strict();
const key = (mailboxId: string) => `sav-intake-launch:${mailboxId}`;
type Reader = Pick<ReturnType<typeof requireDb>, "select">;
/** Initial boundary survives OFF, expiry and deployments. It never resets. */
export async function readIntakeLaunch(mailboxId: string, db: Reader = requireDb()) {
  const [row] = await db.select().from(savSyncState).where(eq(savSyncState.key, key(mailboxId)));
  if (!row) return null;
  const launch = launchSchema.parse(JSON.parse(row.cursor ?? ""));
  if (row.status !== "intake_launch_v1" || launch.mailboxId !== mailboxId) throw Error("SAV_INTAKE_LAUNCH_INVALID");
  return launch;
}
export async function intakeLaunchMatches(config: IntakeRuntimeConfig, db: Reader = requireDb()) {
  const launch = await readIntakeLaunch(config.mailboxId, db);
  return !launch || Date.parse(launch.receivedAfter) === Date.parse(config.receivedAfter)
    && Date.parse(launch.createdAfter) === Date.parse(config.createdAfter);
}
export function historicalMessageSql() {
  return sql`exists(select 1 from sav.sync_state launch where launch.key='sav-intake-launch:' || ${savMessages.mailboxId}::text
    and launch.status='intake_launch_v1' and ((${savMessages.receivedAt} <= (launch.cursor::jsonb->>'receivedAfter')::timestamptz)
      or (${savMessages.createdAt} <= (launch.cursor::jsonb->>'createdAfter')::timestamptz)))`;
}
export async function intakeMessageHistorical(messageId: string) {
  if (!await intakeConsoleInstalled()) return false;
  const [message] = await requireDb().select({ id: savMessages.id }).from(savMessages)
    .where(sql`${savMessages.id}=${messageId} and ${historicalMessageSql()}`);
  return Boolean(message);
}
/** Explicit activation primitive, no route or automatic migration/GET write.
 * Preserves all old messages, drafts, decisions, receipts and external states. */
export async function recordIntakeLaunch(raw: unknown) {
  const input = z.object({ mailboxId: z.uuid(), receivedAfter: z.iso.datetime(), createdAfter: z.iso.datetime() }).strict().parse(raw);
  const { executionAdministrator } = await import("./execution-policy");
  const actor = await executionAdministrator();
  if (!await intakeConsoleInstalled()) throw Error("SAV_INTAKE_CONSOLE_MIGRATION_REQUIRED");
  if (Date.parse(input.receivedAfter) > Date.now() || Date.parse(input.createdAfter) > Date.now()) throw Error("SAV_INTAKE_LAUNCH_INVALID");
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-launch-v1'))`);
    const [staff] = await tx.select().from(staffUsers).where(eq(staffUsers.id, actor.id)).for("update");
    if (!staff?.active || !["admin","owner"].includes(staff.role) || staff.clerkId !== actor.clerkId || staff.email !== actor.email) throw Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED");
    if (!(await tx.select({id:savMailboxes.id}).from(savMailboxes).where(eq(savMailboxes.id,input.mailboxId)))[0]) throw Error("SAV_INTAKE_LAUNCH_INVALID");
    const old = await readIntakeLaunch(input.mailboxId, tx);
    if (old) {
      if (Date.parse(old.receivedAfter) !== Date.parse(input.receivedAfter) || Date.parse(old.createdAfter) !== Date.parse(input.createdAfter)) throw Error("SAV_INTAKE_LAUNCH_IMMUTABLE");
      return old;
    }
    const launch = launchSchema.parse({ ...input, revision: "sav-intake-launch.v1", actorId: actor.id, recordedAt: new Date().toISOString() });
    await tx.insert(savSyncState).values({ key: key(input.mailboxId), status: "intake_launch_v1", cursor: JSON.stringify(launch) });
    await tx.insert(auditLogs).values({ actorEmail: actor.email, action: "sav_intake_launch_recorded", entityType: "sav_mailbox", entityId: input.mailboxId,
      technicalMetadata: { receivedAfter: input.receivedAfter, createdAfter: input.createdAfter } });
    // One set-based projection seed; no analysis, backfill, writer or model.
    await tx.execute(sql`insert into sav.intake_console(thread_id,mailbox_id)
      select t.id,t.mailbox_id from sav.threads t where t.mailbox_id=${input.mailboxId} and exists(select 1 from sav.messages m where m.thread_id=t.id and m.direction='inbound')
      on conflict(thread_id) do update set epoch=sav.intake_console.epoch+1,updated_at=now()`);
    return launch;
  });
}
