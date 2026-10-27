import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { SAV_INTAKE_BUDGET_BOUNDS, SAV_INTAKE_OPERATIONAL_PROFILE, type IntakeBudgetPins } from "./budget-profile";

type Reader = Pick<Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0], "select">;
export const SAV_INTAKE_BUDGET_OVERRIDE_KEY = "sav-intake-daily-budget-override.v1";
/** maxNanoUsd null means "back to the pinned configuration value". */
export const savIntakeBudgetOverrideSchema = z.object({
  revision: z.literal(SAV_INTAKE_BUDGET_OVERRIDE_KEY),
  maxNanoUsd: z.number().int().min(1).max(SAV_INTAKE_BUDGET_BOUNDS.studio.maxNanoUsd).nullable(),
  setBy: z.string().min(3).max(320), setAt: z.iso.datetime(), reason: z.string().trim().min(3).max(500),
}).strict();
export type IntakeBudgetOverride = z.infer<typeof savIntakeBudgetOverrideSchema>;

/** A stored override that cannot be decrypted or validated fails closed: it never
 * silently falls back to another cap. */
export async function readIntakeBudgetOverride(db: Reader): Promise<IntakeBudgetOverride | null> {
  const [row] = await db.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, SAV_INTAKE_BUDGET_OVERRIDE_KEY));
  if (!row) return null;
  try { return savIntakeBudgetOverrideSchema.parse(decryptSavPayload(row.cursor!)); } catch { throw Error("SAV_INTAKE_BUDGET_OVERRIDE_INVALID"); }
}
/** Daily cap set from the Studio by the budget owner. Deliberately outside configHash: a change
 * neither redeploys nor breaks execution continuity. Operational profile only; the rolling
 * 30-day cap and the daily call count stay those of the pinned configuration, and the shared
 * ledger is never reset. Callers read it under the budget lock to stay consistent with it. */
export async function effectiveIntakeBudgetPins<T extends IntakeBudgetPins>(db: Reader, config: T): Promise<T> {
  if (config.budgetProfile !== SAV_INTAKE_OPERATIONAL_PROFILE) return config;
  const override = await readIntakeBudgetOverride(db);
  return override?.maxNanoUsd ? { ...config, maxNanoUsd: override.maxNanoUsd } : config;
}
