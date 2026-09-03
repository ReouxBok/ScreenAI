import { NextResponse } from "next/server";
import { authorizedMemoryRequest, validUserKey } from "@/memory/internal-auth";
import { upsertProfile } from "@/memory/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!authorizedMemoryRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await request.json();
    if (!validUserKey(body?.userKey)) return NextResponse.json({ error: "invalid_user" }, { status: 400 });
    return NextResponse.json(await upsertProfile(body.userKey, body.profile), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "invalid_profile" }, { status: 400 });
  }
}
