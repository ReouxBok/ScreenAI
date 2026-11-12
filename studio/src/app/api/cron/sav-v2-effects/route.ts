import { runSavV2EffectsPass } from "@/lib/sav/v2-effects-pass";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * V2 effects catch-up (11/11), moved out of `sav-reconcile`: every 10 minutes, the same `reconcileCaseV2Effects` with the same switches and guards.
 * A reply is normally sent at once when it is queued by a caller with time left (`sendQueuedCaseReplyNow`); this worker sends what that left (a shared
 * worker, a short budget, a closed guard, a failure, a crash), verifies engaged sends, and is the ONLY runner of the handoff notices, ticket stages and
 * proven closures (they wait up to 10 minutes). Its own pulse (`sav-monitor:v1:worker:sav-v2-effects`) is watched by the monitor and the webhook watchdog.
 * The pass itself lives in lib/sav/v2-effects-pass.ts, shared with the self-scheduler fallback.
 */
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { payload, hasStepFailure } = await runSavV2EffectsPass({ trigger: "vercel_cron" });
  return Response.json(payload, { status: hasStepFailure ? 500 : 200 });
}
