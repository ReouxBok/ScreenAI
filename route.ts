import { requireApiStaff } from "@/lib/auth";
import { manualQualification, manualQualificationRequest } from "@/lib/sav/cases/manual-qualification";
import { manualQualificationPorts } from "@/lib/sav/cases/manual-qualification-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

/** No GET mutation, no cron secret, no user-supplied model/config/owner, no batch. */
export async function POST(request: Request) {
  let staff;
  try { staff = await requireApiStaff("admin"); }
  catch { return Response.json({ error: "forbidden" }, { status: 403, headers }); }
  if (staff.email !== "ugo@limova.ai") return Response.json({ error: "forbidden" }, { status: 403, headers });
  if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("content-type")?.split(";")[0] !== "application/json") return Response.json({ error: "invalid_request" }, { status: 400, headers });
  let input;
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 2048) { await reader.cancel(); return Response.json({ error: "too_large" }, { status: 413, headers }); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    input = manualQualificationRequest.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!input.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
  } catch { return Response.json({ error: "invalid_request" }, { status: 400, headers }); }
  try {
    const result = await manualQualification(input.data, process.env, manualQualificationPorts(process.env));
    return Response.json(result, { status: result.status === "refused" ? 409 : 200, headers });
  } catch {
    // An interrupted request is not proof of non-effect. Never retry automatically or expose provider/client text.
    return Response.json({ error: "manual_pass_unconfirmed", next: "inspect_case_before_retry" }, { status: 409, headers });
  }
}
