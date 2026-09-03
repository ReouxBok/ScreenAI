import { NextResponse } from "next/server";
import { authorizedMemoryRequest, validUserKey } from "@/memory/internal-auth";
import { bootstrapMemory } from "@/memory/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!authorizedMemoryRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await request.json();
    if (!validUserKey(body?.userKey)) return NextResponse.json({ error: "invalid_user" }, { status: 400 });
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const result = await bootstrapMemory(body.userKey, String(body.query || "").slice(0, 2_000), sessionId);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("memory_bootstrap_error", { errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
    return NextResponse.json({ error: "memory_unavailable" }, { status: 503 });
  }
}
