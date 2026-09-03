import "server-only";

import { get, head } from "@vercel/blob";
import { z } from "zod";
import {
  attachTrainingRecording,
  authorizeTrainingRecording,
  TRAINING_RECORDING_MAX_BYTES,
  TRAINING_RECORDING_MAX_DURATION_MS,
} from "./training";

export const recordingClientPayloadSchema = z.object({
  token: z.string().min(24).max(100),
  sessionId: z.string().uuid(),
  durationMs: z.number().int().min(1_000).max(TRAINING_RECORDING_MAX_DURATION_MS),
}).strict();

export const recordingTokenPayloadSchema = recordingClientPayloadSchema.omit({ token: true }).extend({
  version: z.literal(1),
}).strict();

export const recordingConfirmationSchema = z.object({
  sessionId: z.string().uuid(),
  pathname: z.string().min(1).max(700),
  durationMs: z.number().int().min(1_000).max(TRAINING_RECORDING_MAX_DURATION_MS),
}).strict();

export function trainingRecordingPathIsValid(sessionId: string, pathname: string) {
  return pathname.startsWith(`training-recordings/${sessionId}/`)
    && /\.(webm|mp4)$/i.test(pathname)
    && !pathname.includes("..")
    && pathname.length <= 700;
}

export function videoSignatureIsValid(contentType: string, bytes: Uint8Array) {
  if (/^video\/webm$/i.test(contentType)) {
    return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  if (/^video\/mp4$/i.test(contentType)) {
    return bytes.length >= 8 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp";
  }
  return false;
}

async function uploadedBlobHasVideoSignature(pathname: string, contentType: string) {
  const sample = await get(pathname, { access: "private", headers: { Range: "bytes=0-31" } });
  if (!sample || !sample.stream || sample.statusCode < 200 || sample.statusCode >= 300) return false;
  const reader = sample.stream.getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => undefined);
  return videoSignatureIsValid(contentType, value ?? new Uint8Array());
}

export async function approveTrainingRecordingUpload(rawPayload: string | null, pathname: string) {
  const payload = recordingClientPayloadSchema.parse(JSON.parse(rawPayload ?? "{}"));
  if (!trainingRecordingPathIsValid(payload.sessionId, pathname)) throw new Error("INVALID_RECORDING_PATH");
  const session = await authorizeTrainingRecording(payload.token, payload.sessionId);
  if (!session) throw new Error("TRAINING_RECORDING_UNAUTHORIZED");
  return {
    sessionId: payload.sessionId,
    durationMs: payload.durationMs,
    tokenPayload: JSON.stringify({ version: 1, sessionId: payload.sessionId, durationMs: payload.durationMs }),
  };
}

export async function registerCompletedTrainingRecording(input: {
  sessionId: string;
  pathname: string;
  contentType: string;
  size: number;
  durationMs: number;
}) {
  if (!trainingRecordingPathIsValid(input.sessionId, input.pathname)) throw new Error("INVALID_RECORDING_PATH");
  return attachTrainingRecording(input);
}

export async function inspectAndRegisterTrainingRecording(input: { sessionId: string; pathname: string; durationMs: number }) {
  if (!trainingRecordingPathIsValid(input.sessionId, input.pathname)) throw new Error("INVALID_RECORDING_PATH");
  const blob = await head(input.pathname);
  const contentType = String(blob.contentType || "");
  const size = Number(blob.size || 0);
  if (!/^video\/(webm|mp4)$/i.test(contentType) || size < 1 || size > TRAINING_RECORDING_MAX_BYTES) {
    throw new Error("INVALID_RECORDING_BLOB");
  }
  if (!await uploadedBlobHasVideoSignature(blob.pathname, contentType)) throw new Error("INVALID_RECORDING_SIGNATURE");
  return registerCompletedTrainingRecording({ ...input, contentType, size, pathname: blob.pathname });
}

export async function confirmUploadedTrainingRecording(token: string, raw: unknown) {
  const input = recordingConfirmationSchema.parse(raw);
  const session = await authorizeTrainingRecording(token, input.sessionId);
  if (!session || !trainingRecordingPathIsValid(input.sessionId, input.pathname)) throw new Error("TRAINING_RECORDING_UNAUTHORIZED");
  return inspectAndRegisterTrainingRecording(input);
}
