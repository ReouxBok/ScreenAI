import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { admissionLock } from "./execution-store";
import { savIntakeRuntimeConfig } from "./runtime-contract";
import { guardOperatorCommand, operatorBody, operatorCommandRow, operatorResumeStep } from "../intake-ux/operator-commands";
import { OPERATOR_COMMAND_ACTION } from "./operator-information-contract";
import { executeSavIntakeWake, type SavIntakeWakeDeps } from "./event-pipeline";
import { reconcileIntakeEffectsReadOnly } from "./executor";
import { createIntakeExecutorAdapters } from "./execution-adapters";

/** A command dispatcher in the existing cron, not a second execution engine.
 * Durable source/actor/lease guards precede the canonical targeted paths. */
export async function consumeOperatorResume(id: string, deps: SavIntakeWakeDeps & { beforeCanonicalResume?: () => Promise<void> } = {}) {
  const env = deps.env ?? (() => process.env), config = savIntakeRuntimeConfig(env());
  if (!config) return { state: "waiting", reason: "off" };
  const token = randomUUID(), db = requireDb();
  const claim = await db.transaction(async tx => {
    await admissionLock(tx);
    const [row] = await tx.select().from(auditLogs).where(operatorCommandRow(id)).for("update");
    if (!row || !["queued", "running"].includes(String(row.technicalMetadata.state)) || row.technicalMetadata.kind !== "resume") return null;
    const meta = row.technicalMetadata, until = typeof meta.leaseUntil === "string" ? Date.parse(meta.leaseUntil) : 0;
    if (until > Date.now() || typeof meta.nextAt === "string" && Date.parse(meta.nextAt) > Date.now()) return null;
    const body = operatorBody(row);
    try {
      const guard = await guardOperatorCommand(tx, body.command, body.actorId, config);
      const selected = await operatorResumeStep(guard, config, new Date(), tx);
      if (meta.step !== selected.step) throw Error("SAV_INTAKE_OPERATOR_STEP_CHANGED");
      if (selected.nextAt && Date.parse(selected.nextAt) > Date.now()) return null;
      await tx.update(auditLogs).set({ technicalMetadata: { ...meta, state: "running", leaseToken: token, leaseUntil: new Date(Date.now() + 90_000).toISOString() } }).where(eq(auditLogs.id, id));
      return { body, step: selected.step, executionId: guard.execution?.id };
    } catch {
      await tx.update(auditLogs).set({ technicalMetadata: { ...meta, state: "waiting", reason: "SAV_INTAKE_OPERATOR_REVALIDATION_REQUIRED" } }).where(eq(auditLogs.id, id));
      return null;
    }
  });
  if (!claim) return { state: "waiting", reason: "not_claimed" };
  let outcome: { state: string; reason?: string; checked?:number };
  try {
    await deps.beforeCanonicalResume?.(); // Test seam at the race boundary, never a client field.
    if (claim.step === "verify_only") {
      if (!claim.executionId) throw Error("SAV_INTAKE_OPERATOR_REVALIDATION_REQUIRED");
      const adapters = deps.adapters ?? createIntakeExecutorAdapters({ env });
      const result = await reconcileIntakeEffectsReadOnly(claim.executionId, { verify: adapters.verify }, Date.now() + 40_000);
      outcome = result.checked===0?{state:"waiting",reason:"SAV_INTAKE_OPERATOR_VERIFICATION_BUSY",checked:0}:{ state: "checked", checked:result.checked, ...(result.effects.some(e => ["dispatched", "acked", "uncertain"].includes(e.state)) ? { reason: "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED" } : {}) };
    } else if (claim.step === "execution" || claim.step === "admission") {
      outcome = await executeSavIntakeWake(claim.body.command.runId, deps);
    } else {
      const result = await (await import("./runtime")).analyseSavIntakeRuntime(claim.body.command.runId, config, { env, ...(deps.network ? { network: deps.network } : {}) });
      outcome = "skipped" in result ? { state: "waiting", reason: result.skipped } : { state: result.state };
    }
  } catch (error) {
    outcome = { state: "waiting", reason: error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_OPERATOR_INTERRUPTED" };
  }
  await db.transaction(async tx => {
    await admissionLock(tx);
    const [row] = await tx.select().from(auditLogs).where(operatorCommandRow(id)).for("update");
    if (row?.technicalMetadata.leaseToken !== token) return;
    await tx.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, state: "finished", outcome: outcome.state, reason: outcome.reason ?? null,
      checked:outcome.checked??null, finishedAt: new Date().toISOString(), leaseUntil: null, leaseToken: null } }).where(eq(auditLogs.id, id));
  });
  return outcome;
}
export async function reconcileOperatorResumes(deps: SavIntakeWakeDeps = {}) {
  const now = new Date().toISOString();
  const [row] = await requireDb().select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, OPERATOR_COMMAND_ACTION),eq(auditLogs.entityType,"sav_intake_operator_command"),
    sql`${auditLogs.technicalMetadata}->>'kind'='resume' and ${auditLogs.technicalMetadata}->>'state' in ('queued','running')
      and (${auditLogs.technicalMetadata}->>'leaseUntil' is null or ${auditLogs.technicalMetadata}->>'leaseUntil'<=${now})
      and (${auditLogs.technicalMetadata}->>'nextAt' is null or ${auditLogs.technicalMetadata}->>'nextAt'<=${now})`,
  )).orderBy(asc(auditLogs.createdAt), asc(auditLogs.id)).limit(1);
  return row ? consumeOperatorResume(row.id, deps) : null;
}
