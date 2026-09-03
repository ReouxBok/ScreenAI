import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { embeddingFailureDiagnostic, GEMINI_EMBEDDING_MODEL, probeEmbedding } from "@/lib/embeddings";

export const runtime = "nodejs";

function authorized(request: Request) {
  const expected = process.env.STUDIO_SERVICE_TOKEN;
  const provided = request.headers.get("authorization");
  if (!expected || expected.length < 32 || !provided) return false;
  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const startedAt = performance.now();
  try {
    const result = await probeEmbedding("extension");
    console.info("embedding_probe_ok", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const diagnostic = embeddingFailureDiagnostic(error, performance.now() - startedAt, GEMINI_EMBEDDING_MODEL);
    console.error("embedding_probe_failed", diagnostic);
    return NextResponse.json({ ok: false, ...diagnostic }, { status: 503 });
  }
}
