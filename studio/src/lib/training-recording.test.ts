import { describe, expect, it } from "vitest";
import {
  recordingClientPayloadSchema,
  recordingConfirmationSchema,
  recordingTokenPayloadSchema,
  trainingRecordingPathIsValid,
  videoSignatureIsValid,
} from "./training-recording";

const sessionId = "28d988f0-71e3-4893-b3b0-ed0388e41be4";

describe("training recording validation", () => {
  it("accepts only a video owned by the exact training session", () => {
    expect(trainingRecordingPathIsValid(sessionId, `training-recordings/${sessionId}/flow.webm`)).toBe(true);
    expect(trainingRecordingPathIsValid(sessionId, `training-recordings/${sessionId}/flow.mp4`)).toBe(true);
    expect(trainingRecordingPathIsValid(sessionId, "training-recordings/other/flow.webm")).toBe(false);
    expect(trainingRecordingPathIsValid(sessionId, `training-recordings/${sessionId}/../flow.webm`)).toBe(false);
    expect(trainingRecordingPathIsValid(sessionId, `training-recordings/${sessionId}/flow.txt`)).toBe(false);
  });

  it("rejects extra or malformed client metadata", () => {
    const valid = { token: "a".repeat(24), sessionId, durationMs: 12_000 };
    expect(recordingClientPayloadSchema.parse(valid)).toEqual(valid);
    expect(() => recordingClientPayloadSchema.parse({ ...valid, email: "trainer@limova.ai" })).toThrow();
    expect(() => recordingClientPayloadSchema.parse({ ...valid, durationMs: 999 })).toThrow();
    expect(recordingTokenPayloadSchema.parse({ version: 1, sessionId, durationMs: 12_000 })).toBeTruthy();
  });

  it("accepts only the minimal confirmation contract", () => {
    const valid = { sessionId, pathname: `training-recordings/${sessionId}/flow.webm`, durationMs: 12_000 };
    expect(recordingConfirmationSchema.parse(valid)).toEqual(valid);
    expect(() => recordingConfirmationSchema.parse({ ...valid, rawScreen: "forbidden" })).toThrow();
  });

  it("checks the container signature instead of trusting the MIME type", () => {
    expect(videoSignatureIsValid("video/webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
    expect(videoSignatureIsValid("video/webm", new TextEncoder().encode("not a video"))).toBe(false);
    expect(videoSignatureIsValid("video/mp4", new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]))).toBe(true);
    expect(videoSignatureIsValid("video/mp4", new Uint8Array([0, 0, 0, 20, 0x6d, 0x6f, 0x6f, 0x76]))).toBe(false);
  });
});
