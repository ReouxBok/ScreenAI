import "server-only";
import { randomUUID } from "node:crypto";
import { recordSavWorkerPulse } from "@/lib/sav/monitor";

export type SavV2EffectsTrigger = "vercel_cron" | "gmail_webhook" | "heartbeat_workflow";
export type SavV2EffectsPassOptions = { trigger: SavV2EffectsTrigger; pulseId?: string; budgetMs?: number };
export type SavV2EffectsStep = { status: "ok"; durationMs: number; data: unknown } | { status: "error"; durationMs: number; errorCode: string };

const code = (error: unknown) => (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160);
/** The cron's log shape stays exactly as before; only a fallback pass names its trigger. */
const triggerField = (trigger: SavV2EffectsTrigger) => trigger === "vercel_cron" ? {} : { trigger };

/**
 * One V2 effects catch-up pass (11/11), shared by the Vercel cron /api/cron/sav-v2-effects (primary path) and the self-scheduler
 * fallback (lib/sav/self-scheduler.ts): the same `reconcileCaseV2Effects` with the same switches and guards, and the same pulse
 * (`sav-monitor:v1:worker:sav-v2-effects`) at the start and at the end, failed when the catch-up fails. A fallback pass adds
 * `trigger` to its step log. Never throws once the start pulse is written; the caller maps `hasStepFailure` to its answer.
 */
export async function runSavV2EffectsPass(options: SavV2EffectsPassOptions): Promise<{ payload: { caseEffects: SavV2EffectsStep }; hasStepFailure: boolean; pulseId: string }> {
  const startedAt = Date.now(), deadlineMs = startedAt + (options.budgetMs ?? 270_000), pulseId = options.pulseId ?? randomUUID(), pulseStartedAt = new Date(startedAt).toISOString();
  await recordSavWorkerPulse(pulseId, pulseStartedAt, undefined, "sav-v2-effects");
  try {
    if (process.env.SAV_V2_ENTRY !== "on" || process.env.SAV_CASE_RECORDING !== "on") {
      await recordSavWorkerPulse(pulseId, pulseStartedAt, false, "sav-v2-effects");
      return { payload: { caseEffects: { status: "ok", durationMs: 0, data: { skipped: "v2_off" } } }, hasStepFailure: false, pulseId };
    }
    const { reconcileCaseV2Effects } = await import("@/lib/sav/cases/v2-effects-binding");
    const data = await reconcileCaseV2Effects({ env: process.env, deadlineMs });
    const durationMs = Date.now() - startedAt;
    console.info("sav_worker_step", { name: "v2_case_effects", status: "ok", durationMs, ...triggerField(options.trigger) });
    await recordSavWorkerPulse(pulseId, pulseStartedAt, false, "sav-v2-effects");
    return { payload: { caseEffects: { status: "ok", durationMs, data } }, hasStepFailure: false, pulseId };
  } catch (error) {
    const durationMs = Date.now() - startedAt, errorCode = code(error);
    console.error("sav_worker_step", { name: "v2_case_effects", status: "error", durationMs, errorCode, ...triggerField(options.trigger) });
    await recordSavWorkerPulse(pulseId, pulseStartedAt, true, "sav-v2-effects");
    return { payload: { caseEffects: { status: "error", durationMs, errorCode } }, hasStepFailure: true, pulseId };
  }
}
