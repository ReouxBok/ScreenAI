import { randomUUID } from "node:crypto";
import { recordSavWorkerPulse } from "@/lib/sav/monitor";

export const runtime = "nodejs";
export const maxDuration = 300;

const code = (error: unknown) => (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160);

/**
 * V2 effects catch-up (11/11), moved out of `sav-reconcile`: every 10 minutes, the same `reconcileCaseV2Effects` with the same switches and guards.
 * A reply is normally sent at once when it is queued by a caller with time left (`sendQueuedCaseReplyNow`); this worker sends what that left (a shared
 * worker, a short budget, a closed guard, a failure, a crash), verifies engaged sends, and is the ONLY runner of the handoff notices, ticket stages and
 * proven closures (they wait up to 10 minutes). Its own pulse (`sav-monitor:v1:worker:sav-v2-effects`) is watched by the monitor and the webhook watchdog.
 */
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now(), deadlineMs = startedAt + 270_000, pulseId = randomUUID(), pulseStartedAt = new Date(startedAt).toISOString();
  await recordSavWorkerPulse(pulseId, pulseStartedAt, undefined, "sav-v2-effects");
  try {
    if (process.env.SAV_V2_ENTRY !== "on" || process.env.SAV_CASE_RECORDING !== "on") {
      await recordSavWorkerPulse(pulseId, pulseStartedAt, false, "sav-v2-effects");
      return Response.json({ caseEffects: { status: "ok", durationMs: 0, data: { skipped: "v2_off" } } });
    }
    const { reconcileCaseV2Effects } = await import("@/lib/sav/cases/v2-effects-binding");
    const data = await reconcileCaseV2Effects({ env: process.env, deadlineMs });
    const durationMs = Date.now() - startedAt;
    console.info("sav_worker_step", { name: "v2_case_effects", status: "ok", durationMs });
    await recordSavWorkerPulse(pulseId, pulseStartedAt, false, "sav-v2-effects");
    return Response.json({ caseEffects: { status: "ok", durationMs, data } });
  } catch (error) {
    const durationMs = Date.now() - startedAt, errorCode = code(error);
    console.error("sav_worker_step", { name: "v2_case_effects", status: "error", durationMs, errorCode });
    await recordSavWorkerPulse(pulseId, pulseStartedAt, true, "sav-v2-effects");
    return Response.json({ caseEffects: { status: "error", durationMs, errorCode } }, { status: 500 });
  }
}
