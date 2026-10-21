import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
export async function intakeConsoleInstalled(db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) {
  const [marker] = await db.select({ status: savSyncState.status }).from(savSyncState)
    .where(eq(savSyncState.key, "sav-intake-console-schema-v1"));
  return marker?.status === "installed";
}
