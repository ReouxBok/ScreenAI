import { z } from "zod";
import { executionAdministrator } from "@/lib/sav/intake/execution-policy";
import { readSelfSchedulerState, setSelfSchedulerSwitch } from "@/lib/sav/self-scheduler-store";
import { ensureSavHeartbeat } from "@/lib/sav/self-scheduler-heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const command = z.object({ action: z.enum(["enable", "disable", "start_heartbeat"]), reason: z.string().trim().min(3).max(300) }).strict();
async function admin() {
  try { return await executionAdministrator(); } catch { return null; }
}
/** Administrator read of the fallback's own rows: switch (OFF when absent), leases, last runs, heartbeat. Nothing runs. */
export async function GET() {
  if (!await admin()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  try { return Response.json({ state: await readSelfSchedulerState() }, { headers }); }
  catch { return Response.json({ error: "self_scheduler_unavailable" }, { status: 503, headers }); }
}
/** Administrator switch of the opt-in fallback, with actor and reason recorded (row and audit log).
 * enable: switch ON, then the heartbeat is started if none is alive. disable: switch OFF; every claim refuses at once and
 * every heartbeat, old deployments included, stops at its next tick without continuing. start_heartbeat: start only.
 * No pass runs inside this request. */
export async function POST(request: Request) {
  const staff = await admin();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403, headers });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "invalid_origin" }, { status: 403, headers });
  if (!request.headers.get("content-type")?.startsWith("application/json") || Number(request.headers.get("content-length") ?? "0") > 8192)
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  let parsed: ReturnType<typeof command.safeParse>;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 8192) return Response.json({ error: "invalid_request" }, { status: 400, headers });
    parsed = command.safeParse(JSON.parse(body));
  } catch { return Response.json({ error: "invalid_request" }, { status: 400, headers }); }
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
  const { action, reason } = parsed.data;
  try {
    const selfScheduler = action === "start_heartbeat" ? undefined : await setSelfSchedulerSwitch({ enabled: action === "enable", actor: staff.email, reason, now: new Date() });
    const heartbeat = action === "disable" ? undefined : await ensureSavHeartbeat({ trigger: "administrator" });
    return Response.json({ switch: selfScheduler, heartbeat }, { headers });
  } catch { return Response.json({ error: "self_scheduler_unavailable" }, { status: 503, headers }); }
}
