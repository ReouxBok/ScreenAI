import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { approveTrainingRecordingUpload, inspectAndRegisterTrainingRecording, recordingTokenPayloadSchema } from "@/lib/training-recording";
import { TRAINING_RECORDING_MAX_BYTES } from "@/lib/training";

export const runtime = "nodejs";

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  } : {};
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as HandleUploadBody;
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const approved = await approveTrainingRecordingUpload(clientPayload, pathname);
        return {
          allowedContentTypes: ["video/webm", "video/mp4"],
          maximumSizeInBytes: TRAINING_RECORDING_MAX_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + 2 * 60 * 60 * 1_000,
          tokenPayload: approved.tokenPayload,
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = recordingTokenPayloadSchema.parse(JSON.parse(tokenPayload ?? "{}"));
        await inspectAndRegisterTrainingRecording({
          sessionId: payload.sessionId,
          pathname: blob.pathname,
          durationMs: payload.durationMs,
        });
      },
    });
    return NextResponse.json(result, { headers: corsHeaders(request) });
  } catch (error) {
    console.error("training_recording_upload_failed", { code: error instanceof Error ? error.message.slice(0, 100) : "UNKNOWN" });
    return NextResponse.json({ error: "Envoi vidéo refusé." }, { status: 400, headers: corsHeaders(request) });
  }
}
