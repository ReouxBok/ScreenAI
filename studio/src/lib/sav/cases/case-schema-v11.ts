import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import type { ExecutionTx } from "../intake/execution-store";

/** SAV-99: migration 0055 (a ticket's hand-over stage and its notice may have no thread). Before it, nothing without a thread is queued for them. */
export async function ticketHandbackSchemaInstalled(db: Pick<ExecutionTx, "select"> = requireDb()) {
  const [row] = await db.select({ status: savSyncState.status }).from(savSyncState).where(eq(savSyncState.key, "sav-case-schema-v11"));
  return row?.status === "installed";
}
