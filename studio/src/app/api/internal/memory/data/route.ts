import { NextResponse } from "next/server";
import { authorizedMemoryRequest, validUserKey } from "@/memory/internal-auth";
import { deleteAllMemory } from "@/memory/service";

export const runtime = "nodejs";

export async function DELETE(request: Request) {
  if (!authorizedMemoryRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!validUserKey(body?.userKey)) return NextResponse.json({ error: "invalid_user" }, { status: 400 });
  try {
    return NextResponse.json(await deleteAllMemory(body.userKey), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "memory_unavailable" }, { status: 503 });
  }
}
