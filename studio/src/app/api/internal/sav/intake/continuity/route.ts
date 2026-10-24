import { z } from "zod";
import { executionAdministrator, intakeExecutionConfig, readIntakeExecutionAuthority } from "@/lib/sav/intake/execution-policy";
import { savIntakeRuntimeConfig } from "@/lib/sav/intake/runtime-contract";
import { createIntakeExecutorAdapters } from "@/lib/sav/intake/execution-adapters";
import { previewIntakeExecutionContinuity, approveIntakeExecutionContinuity } from "@/lib/sav/intake/execution-continuity";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const selection = z.object({ sourcePolicyId: z.uuid(), executionIds: z.array(z.uuid()).min(1).max(100).refine(ids => new Set(ids).size === ids.length) }).strict();
const command = selection.extend({ expectedHash: z.string().regex(/^[a-f0-9]{64}$/), oldDeploymentFencedAndDrained: z.literal(true) }).strict();
async function options() {
  const env = () => process.env, config = intakeExecutionConfig(env()), runtime = savIntakeRuntimeConfig(env());
  if (!config || !runtime) throw Error("SAV_INTAKE_EXECUTION_DISABLED");
  const { policy } = await readIntakeExecutionAuthority(config);
  // Construction only: preview/approval never invokes the provider adapters.
  return { config, runtime, policy, env, signal: AbortSignal.timeout(20_000), adapters: createIntakeExecutorAdapters({ env }) };
}
async function admin() {
  try { await executionAdministrator(); return true; } catch { return false; }
}
function error(error: unknown) {
  const reason = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "invalid_request";
  return Response.json({ error: reason }, { status: 409, headers });
}
/** Exact read-only preview; no source status, execution or receipt is changed. */
export async function GET(request: Request) {
  if (!await admin()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  const url = new URL(request.url);
  const parsed = selection.safeParse({ sourcePolicyId: url.searchParams.get("sourcePolicyId"), executionIds: (url.searchParams.get("executionIds") ?? "").split(",") });
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
  try { return Response.json({ preview: await previewIntakeExecutionContinuity(parsed.data.sourcePolicyId, await options(), parsed.data.executionIds),
    requires: "Old deployment fenced and drained; source remains approved. No provider action is executed by this endpoint." }, { headers }); }
  catch (e) { return error(e); }
}
/** Local, audited authority transfer only. No dispatch, wake, model or replay. */
export async function POST(request: Request) {
  if (!await admin()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "invalid_origin" }, { status: 403, headers });
  if (!request.headers.get("content-type")?.startsWith("application/json") || Number(request.headers.get("content-length") ?? "0") > 8192)
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 8192) return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const parsed = command.safeParse(JSON.parse(body));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const receipt = await approveIntakeExecutionContinuity(parsed.data.sourcePolicyId, parsed.data.expectedHash, await options(), parsed.data.executionIds);
    return Response.json({ receipt, providerActions: 0, modelCalls: 0 }, { headers });
  } catch (e) { return error(e); }
}
