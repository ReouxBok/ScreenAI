import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savSyncState } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { executionAdministrator } from "./execution-policy";
import { SAV_INTAKE_BUDGET_BOUNDS, SAV_INTAKE_OPERATIONAL_PROFILE } from "./budget-profile";
import { readIntakeBudgetOverride, SAV_INTAKE_BUDGET_OVERRIDE_KEY, type IntakeBudgetOverride } from "./budget-override";
import { savIntakeRuntimeConfig } from "./runtime-contract";
import { SAV_INTAKE_BUDGET_OWNER_EMAIL } from "./budget-amount";
import { readSavIntakeBudget } from "./runtime-store";

const AUDIT = { action: "sav_intake_daily_budget_set", entityType: "sav_intake_budget", entityId: "daily" } as const;
export async function intakeBudgetOwner() {
  const staff = await executionAdministrator().catch(() => { throw Error("SAV_INTAKE_BUDGET_UNAUTHORIZED"); });
  if (staff.email !== SAV_INTAKE_BUDGET_OWNER_EMAIL) throw Error("SAV_INTAKE_BUDGET_UNAUTHORIZED");
  return staff;
}
const inputSchema = z.object({ maxNanoUsd: z.number().int().min(1).max(SAV_INTAKE_BUDGET_BOUNDS.studio.maxNanoUsd).nullable(), reason: z.string().trim().min(3).max(500) }).strict();
/** Serialized with every reservation through the same budget lock. Never touches the ledger. */
export async function setIntakeDailyBudget(raw: unknown): Promise<IntakeBudgetOverride> {
  const staff = await intakeBudgetOwner(), input = inputSchema.parse(raw);
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-runtime-model-budget-v1'))`);
    // An unreadable previous row is replaced, never trusted; the audit keeps that fact.
    const previous = await readIntakeBudgetOverride(tx).then(value => value?.maxNanoUsd ?? null, () => "invalid" as const);
    const next: IntakeBudgetOverride = { revision: SAV_INTAKE_BUDGET_OVERRIDE_KEY, maxNanoUsd: input.maxNanoUsd, setBy: staff.email, setAt: new Date().toISOString(), reason: input.reason };
    const values = { key: SAV_INTAKE_BUDGET_OVERRIDE_KEY, cursor: encryptSavPayload(next), status: "active", updatedAt: new Date(next.setAt) };
    await tx.insert(savSyncState).values(values).onConflictDoUpdate({ target: savSyncState.key, set: values });
    await tx.insert(auditLogs).values({ actorEmail: staff.email, ...AUDIT,
      technicalMetadata: { previousNanoUsd: previous, nextNanoUsd: input.maxNanoUsd, reason: input.reason } });
    return next;
  });
}
export type IntakeBudgetPanel = {
  configuredNanoUsd: number | null; effectiveNanoUsd: number | null; override: IntakeBudgetOverride | null; overrideInvalid: boolean; operational: boolean;
  usage: Awaited<ReturnType<typeof readSavIntakeBudget>> | null; configurationError: string | null; ceilingNanoUsd: number;
  history: Array<{ at: string; actor: string; previousNanoUsd: number | string | null; nextNanoUsd: number | null; reason: string }>;
};
export async function readIntakeBudgetPanel(): Promise<IntakeBudgetPanel> {
  await intakeBudgetOwner();
  const db = requireDb();
  let config: ReturnType<typeof savIntakeRuntimeConfig> = null, configurationError: string | null = null;
  try { config = savIntakeRuntimeConfig(process.env); } catch (error) { configurationError = error instanceof Error ? error.message : "SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED"; }
  let override: IntakeBudgetOverride | null = null, overrideInvalid = false;
  try { override = await readIntakeBudgetOverride(db); } catch { overrideInvalid = true; }
  const operational = config?.budgetProfile === SAV_INTAKE_OPERATIONAL_PROFILE;
  const usage = config && !overrideInvalid ? await readSavIntakeBudget(config) : null;
  const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.action, AUDIT.action), eq(auditLogs.entityType, AUDIT.entityType)))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(10);
  const history = rows.map(row => { const m = row.technicalMetadata;
    return { at: row.createdAt.toISOString(), actor: row.actorEmail, previousNanoUsd: m.previousNanoUsd as number | string | null,
      nextNanoUsd: typeof m.nextNanoUsd === "number" ? m.nextNanoUsd : null, reason: String(m.reason ?? "") }; });
  return { configuredNanoUsd: config?.maxNanoUsd ?? null, effectiveNanoUsd: usage?.maxNanoUsd ?? null, override, overrideInvalid, operational, usage, configurationError,
    ceilingNanoUsd: SAV_INTAKE_BUDGET_BOUNDS.studio.maxNanoUsd, history };
}
