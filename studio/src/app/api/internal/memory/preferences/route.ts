import { NextResponse } from "next/server";
import { authorizedMemoryRequest, validUserKey } from "@/memory/internal-auth";
import { setMemoryPreference } from "@/memory/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!authorizedMemoryRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!validUserKey(body?.userKey) || typeof body?.enabled !== "boolean") return NextResponse.json({ error: "invalid_preference" }, { status: 400 });
  try {
    return NextResponse.json(await setMemoryPreference(body.userKey, body.enabled), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "memory_unavailable" }, { status: 503 });
  }
}
