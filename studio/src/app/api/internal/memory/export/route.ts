import { NextResponse } from "next/server";
import { authorizedMemoryRequest, validUserKey } from "@/memory/internal-auth";
import { exportMemory } from "@/memory/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!authorizedMemoryRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!validUserKey(body?.userKey)) return NextResponse.json({ error: "invalid_user" }, { status: 400 });
  try {
    return NextResponse.json(await exportMemory(body.userKey), { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "memory_unavailable" }, { status: 503 });
  }
}
