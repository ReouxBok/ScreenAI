import { NextResponse } from "next/server";
import { authorizedMemoryRequest, validUserKey } from "@/memory/internal-auth";
import { forgetMemory } from "@/memory/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!authorizedMemoryRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const query = String(body?.query || "").trim().slice(0, 1_000);
  if (!validUserKey(body?.userKey) || query.length < 3) return NextResponse.json({ error: "invalid_forget_request" }, { status: 400 });
  try {
    return NextResponse.json(await forgetMemory(body.userKey, query), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "memory_unavailable" }, { status: 503 });
  }
}
