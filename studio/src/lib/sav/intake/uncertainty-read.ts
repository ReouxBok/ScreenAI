import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeModelCalls, savIntakeExecutions, savIntakeEffects } from "@/db/schema";
import { intakeRuntimeHash } from "./runtime-contract";
import { classifyIntakeUncertainty, type IntakeUncertainty } from "./uncertainty";
type Reader = Pick<Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0], "select">;
/** Exact aggregate over the current message's V1 ledgers, across all run versions.
 * Output and input bounded to one page, no payload decryption or provider calls.
 * No negative claim about legacy actions or externally performed work is made. */
export async function readIntakeUncertainties(tx: Reader, messageIds: string[]): Promise<Record<string, IntakeUncertainty>> {
  const ids = [...new Set(messageIds)];
  if (ids.length > 25) throw Error("INTAKE_MONITOR_PAGE_LIMIT");
  if (!ids.length) return {};
  const keys = ids.map(intakeRuntimeHash);
  const calls = await tx.select({ key: savIntakeModelCalls.messageKey,
    uncertain: sql<boolean>`bool_or(${savIntakeModelCalls.state} <> 'settled')` }).from(savIntakeModelCalls)
    .where(inArray(savIntakeModelCalls.messageKey, keys)).groupBy(savIntakeModelCalls.messageKey);
  const effects = await tx.select({ id: savIntakeExecutions.messageId,
    uncertain: sql<boolean>`bool_or(${savIntakeEffects.state} in ('dispatched','acked','uncertain') and ${savIntakeEffects.confirmedAt} is null)` })
    .from(savIntakeExecutions).innerJoin(savIntakeEffects, eq(savIntakeEffects.executionId, savIntakeExecutions.id))
    .where(inArray(savIntakeExecutions.messageId, ids)).groupBy(savIntakeExecutions.messageId);
  return Object.fromEntries(ids.map((id, i) => [id, classifyIntakeUncertainty(calls.find(row => row.key === keys[i])?.uncertain === true, effects.find(row => row.id === id)?.uncertain === true)]));
}
