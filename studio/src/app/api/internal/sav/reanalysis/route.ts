import { currentUser } from "@clerk/nextjs/server";
import { getStaffDirectoryEntry, hasRole, normalizeStaffEmail } from "@/lib/access";
import { withReanalysisDatabase } from "@/lib/sav/reanalysis-database";
import { reanalysisServerRequest, runSavReanalysisServer } from "@/lib/sav/reanalysis-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request) {
  try {
    const user = await currentUser();
    const email = normalizeStaffEmail(user?.primaryEmailAddress?.emailAddress, "");
    const staff = getStaffDirectoryEntry(email);
    if (!user || email !== "ugo@limova.ai" || user.primaryEmailAddress?.verification?.status !== "verified" || !staff || !hasRole(staff.role, "admin"))
      return Response.json({ error: "forbidden" }, { status: 403, headers });
    if (request.headers.get("origin") !== new URL(request.url).origin || !request.headers.get("content-type")?.startsWith("application/json"))
      return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 131_072) { await reader.cancel(); return Response.json({ error: "too_large" }, { status: 413, headers }); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const parsed = reanalysisServerRequest.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const result = await withReanalysisDatabase(() => runSavReanalysisServer(parsed.data));
    return Response.json(result, { headers });
  } catch {
    // No provider errors, secrets or customer content in request logs.
    console.warn("sav_reanalysis_server_request_refused");
    return Response.json({ error: "reanalysis_refused_or_failed" }, { status: 409, headers });
  }
}
