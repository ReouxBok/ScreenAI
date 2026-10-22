import { runSavServerMonitor } from "@/lib/sav/monitor";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return Response.json({ error: "unauthorized" }, { status: 401 });
  try { return Response.json(await runSavServerMonitor()); }
  catch { console.error("sav_monitor_failed"); return Response.json({ error: "SAV_MONITOR_FAILED" }, { status: 500 }); }
}
