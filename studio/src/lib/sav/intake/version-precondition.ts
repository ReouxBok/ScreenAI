import "server-only";
import { and, eq } from "drizzle-orm";
import { savIntakeConsole, savIntakeRuns } from "@/db/schema";
import type { requireDb } from "@/db";

type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
/** The dossier version a caller (an MCP agent) decided on: current run and console epoch. */
export type IntakeVersionPrecondition = { runId: string | null; version: number | null; sourceHash: string | null; epoch: number };

/** Re-checked inside the caller's transaction, after its thread locks: the current run row and
 * the console projection are locked, so no newer version can be accepted implicitly. */
export async function intakeVersionStillCurrent(tx: Tx, threadId: string, expected: IntakeVersionPrecondition) {
  const [run] = await tx.select({ id: savIntakeRuns.id, version: savIntakeRuns.version, sourceHash: savIntakeRuns.sourceHash }).from(savIntakeRuns)
    .where(and(eq(savIntakeRuns.threadId, threadId), eq(savIntakeRuns.isCurrent, true))).for("update");
  if ((run?.id ?? null) !== expected.runId || (run?.version ?? null) !== expected.version || (run?.sourceHash ?? null) !== expected.sourceHash) return false;
  const [projection] = await tx.select({ epoch: savIntakeConsole.epoch }).from(savIntakeConsole).where(eq(savIntakeConsole.threadId, threadId)).for("update");
  return projection?.epoch === expected.epoch;
}
