import { runSavReconcilePass } from "@/lib/sav/reconcile-pass";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Primary path, unchanged: the pass itself lives in lib/sav/reconcile-pass.ts, shared with the self-scheduler fallback. */
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { payload, hasStepFailure } = await runSavReconcilePass({ trigger: "vercel_cron" });
  return Response.json(payload, { status: hasStepFailure ? 500 : 200 });
}
