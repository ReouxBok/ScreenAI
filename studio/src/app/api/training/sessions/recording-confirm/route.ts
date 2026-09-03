import { NextResponse } from "next/server";
import { confirmUploadedTrainingRecording } from "@/lib/training-recording";

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  } : {};
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  try {
    const recording = await confirmUploadedTrainingRecording(token, await request.json());
    return NextResponse.json({ ok: true, id: recording?.id }, { headers: corsHeaders(request) });
  } catch (error) {
    console.error("training_recording_confirmation_failed", { code: error instanceof Error ? error.message.slice(0, 100) : "UNKNOWN" });
    return NextResponse.json({ error: "La vidéo envoyée n’a pas pu être vérifiée." }, { status: 400, headers: corsHeaders(request) });
  }
}
