import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { searchKnowledge } from "@/lib/search";
export const runtime = "nodejs";
function authorized(request: Request) {
  const expected = process.env.STUDIO_SERVICE_TOKEN;
  const provided = request.headers.get("authorization");
  if (!expected || expected.length < 32 || !provided) return false;
  const expectedBuffer=Buffer.from(`Bearer ${expected}`); const providedBuffer=Buffer.from(provided);
  return expectedBuffer.length===providedBuffer.length && timingSafeEqual(expectedBuffer,providedBuffer);
}
export async function POST(request: Request) {
  const started = performance.now();
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const response = await searchKnowledge(await request.json());
    console.info("knowledge_search_ok", { revision: response.revision, articleIds: response.results.map(result => result.id), latencyMs: Math.round(performance.now() - started) });
    return NextResponse.json(response, { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=30" } });
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : null;
    const errorCode = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : error instanceof Error ? error.name : "unknown";
    console.error("knowledge_search_error", { errorCode, latencyMs: Math.round(performance.now() - started) });
    return NextResponse.json({ error: "knowledge_unavailable" }, { status: 503 });
  }
}
