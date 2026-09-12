import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { syncCurriculumBatch } from "@/lib/curriculum-sync";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(request: Request) {
  const expected = process.env.STUDIO_SERVICE_TOKEN;
  const provided = request.headers.get("authorization");
  if (!expected || expected.length < 32 || !provided) return false;
  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

const inputSchema = z.object({
  offset: z.number().int().min(0).max(1_000).default(0),
  limit: z.number().int().min(1).max(10).default(5),
  publishNow: z.boolean().default(false),
});

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = inputSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const result = await syncCurriculumBatch(parsed.data);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
