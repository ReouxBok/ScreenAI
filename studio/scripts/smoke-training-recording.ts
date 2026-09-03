import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { get } from "@vercel/blob";
import { upload } from "@vercel/blob/client";
import { connectTraining, createTraining, deleteTraining, getTraining } from "../src/lib/training";

const baseUrl = "https://studio.limova.ai";
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "charly-recording-smoke-"));
let sessionId = "";

try {
  const created = await createTraining({
    title: `Smoke vidéo ${Date.now()}`,
    goal: "Vérifier l’enregistrement vidéo privé de bout en bout.",
    agentKey: "charly",
    startPath: "/",
  }, "smoke@limova.ai");
  sessionId = created.session.id;
  const token = created.token;
  const connected = await connectTraining(token);
  if (connected?.recordingStatus !== "awaiting") throw new Error("Production recording requirement is inactive");

  const videoPath = path.join(temporaryDirectory, "smoke.webm");
  const ffmpeg = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1.2",
    "-an", "-c:v", "libvpx-vp9", "-deadline", "realtime", videoPath,
  ]);
  if (ffmpeg.status !== 0) throw new Error("Smoke video generation failed");
  const bytes = await readFile(videoPath);
  const pathname = `training-recordings/${sessionId}/${crypto.randomUUID()}.webm`;
  const blob = await upload(pathname, new Blob([bytes], { type: "video/webm" }), {
    access: "private",
    contentType: "video/webm",
    handleUploadUrl: `${baseUrl}/api/training/sessions/recording-upload`,
    clientPayload: JSON.stringify({ token, sessionId, durationMs: 1_200 }),
  });
  const confirmed = await fetch(`${baseUrl}/api/training/sessions/recording-confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, pathname: blob.pathname, durationMs: 1_200 }),
  });
  if (!confirmed.ok) throw new Error("Production recording confirmation failed");
  const completed = await fetch(`${baseUrl}/api/training/sessions/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!completed.ok) throw new Error("Production training completion failed");

  const detail = await getTraining(sessionId);
  if (detail?.session.recordingStatus !== "ready" || detail.session.status !== "ready") throw new Error("Production recording metadata is incomplete");
  const playback = await get(blob.pathname, { access: "private", headers: { Range: "bytes=0-31" } });
  if (!playback?.stream || playback.blob.contentType !== "video/webm") throw new Error("Private Blob playback failed");
  await playback.stream.cancel();
  console.log("Production training recording smoke: passed");
} finally {
  if (sessionId) {
    await deleteTraining(sessionId, "smoke@limova.ai");
    if (await getTraining(sessionId)) throw new Error("Smoke training cleanup failed");
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
