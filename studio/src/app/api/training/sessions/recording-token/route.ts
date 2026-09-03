import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { authorizeTrainingRecording, TRAINING_RECORDING_MAX_BYTES } from "@/lib/training";
import { trainingRecordingPathIsValid } from "@/lib/training-recording";

export const runtime = "nodejs";
const cors = (request: Request): Record<string, string> => {
  const origin = request.headers.get("origin") ?? "";
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" } : {};
};
export async function OPTIONS(request: Request) { return new Response(null, { status: 204, headers: cors(request) }); }
export async function POST(request: Request) {
  const trainingToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const body = await request.json().catch(() => ({})) as { sessionId?: string; pathname?: string; contentType?: string };
  const sessionId = String(body.sessionId ?? "");
  const pathname = String(body.pathname ?? "");
  const contentType = /^video\/(webm|mp4)$/i.test(String(body.contentType)) ? String(body.contentType) : "video/webm";
  if (!trainingRecordingPathIsValid(sessionId, pathname) || !await authorizeTrainingRecording(trainingToken, sessionId)) {
    return NextResponse.json({ error: "Envoi non autorisé." }, { status: 403, headers: cors(request) });
  }
  const clientToken = await generateClientTokenFromReadWriteToken({
    pathname,
    allowedContentTypes: [contentType],
    maximumSizeInBytes: TRAINING_RECORDING_MAX_BYTES,
    validUntil: Date.now() + 3 * 60 * 60 * 1_000,
    addRandomSuffix: false,
  });
  return NextResponse.json({ clientToken, pathname }, { headers: { ...cors(request), "Cache-Control": "no-store" } });
}
