import { readSavBlockSwitchPanel, setSavBlockSwitch } from "@/lib/sav/cases/block-switch-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const forbidden = () => Response.json({ error: "forbidden" }, { status: 403, headers });
const unauthorized = (error: unknown) => error instanceof Error && error.message === "SAV_BLOCK_SWITCH_UNAUTHORIZED";

/** Per-block switch (12/11): administrators only (same authority as the agent pause). Read-only GET, no budget amount. */
export async function GET() {
  try { return Response.json(await readSavBlockSwitchPanel(), { headers }); }
  catch (error) { return unauthorized(error) ? forbidden() : Response.json({ error: "unavailable" }, { status: 503, headers }); }
}

/** One block, one change, a mandatory reason; same origin and JSON only. It can only restrict what the configuration allows. */
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  let input: unknown;
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
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return Response.json({ error: "invalid_request" }, { status: 400, headers }); }
  try {
    return Response.json({ ok: true, setting: await setSavBlockSwitch(input) }, { headers });
  } catch (error) {
    return unauthorized(error) ? forbidden() : Response.json({ error: "invalid_request" }, { status: 400, headers });
  }
}
