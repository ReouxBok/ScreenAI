import { z } from "zod";

export const savAutomationModeSchema = z.enum(["shadow", "assist", "semi", "on"]);
export type SavAutomationMode = z.infer<typeof savAutomationModeSchema>;
export const savReleaseStageSchema = z.enum(["v0", "v1", "v2", "v3", "v4"]);
export type SavReleaseStage = z.infer<typeof savReleaseStageSchema>;

/** Missing or malformed configuration must never enable future autonomy. */
export function savReleaseStage(): SavReleaseStage {
  return savReleaseStageSchema.catch("v0").parse(process.env.SAV_RELEASE_STAGE);
}
export const savHarnessModeSchema = z.enum(["off", "shadow", "pilot", "on"]);
export type SavHarnessMode = z.infer<typeof savHarnessModeSchema>;

export const SAV_AGENT_ID = "sav-ticket-analyst";
export const SAV_AGENT_SCOPE = "sav_ticket_analysis";
export const SAV_PROMPT_REVISION = "sav-adk-2026-10-06.v0.3";
export const SAV_LEGACY_PROMPT_REVISION = "sav-legacy-2026-10-06.v0.3";
export const SAV_RULES_REVISION = "sav-rules-2026-10-06.v3";

export function savRunProvenance(simulation = false) {
  const revision = process.env.SAV_CODE_REVISION || process.env.VERCEL_GIT_COMMIT_SHA || "unknown";
  return { codeRevision: /^[a-f0-9]{40}$/.test(revision) ? revision : "unknown",
    dataOrigin: simulation ? "simulation" : process.env.SAV_TEST_MODE === "true" ? "test" : process.env.NODE_ENV === "production" ? "real" : "unknown" };
}

export function savAutomationMode(): SavAutomationMode {
  return savAutomationModeSchema.catch("shadow").parse(process.env.SAV_AUTOMATION_MODE);
}

export function isSavPilotMode() {
  return process.env.SAV_PILOT_MODE === "true";
}

export function savHarnessMode(): SavHarnessMode {
  return savHarnessModeSchema.catch("shadow").parse(process.env.SAV_ADK_MODE);
}

export function savGeminiApiKey() {
  return process.env.SAV_GEMINI_API_KEY || "";
}

export function savAdkTimeoutMs() {
  const configured = Number(process.env.SAV_ADK_TIMEOUT_MS ?? 45_000);
  return Number.isFinite(configured)
    ? Math.min(90_000, Math.max(10_000, Math.round(configured)))
    : 45_000;
}

export function canWriteHubspotAutomatically() {
  return savReleaseStage() !== "v0" && ["semi", "on"].includes(savAutomationMode());
}

export function canSendRepliesAutomatically() {
  return ["v2", "v3", "v4"].includes(savReleaseStage()) && savAutomationMode() === "on";
}

export function autoReplyMinConfidence() {
  const configured = Number(process.env.SAV_AUTO_REPLY_MIN_CONFIDENCE ?? 920);
  return Number.isFinite(configured) ? Math.min(990, Math.max(850, Math.round(configured))) : 920;
}

export function savAutoReplyCategories() {
  const allowed = new Set(["technical", "integration", "how_to", "acknowledgement"]);
  return new Set(String(process.env.SAV_AUTO_REPLY_CATEGORIES ?? "technical,how_to")
    .split(",").map((value) => value.trim()).filter((value) => allowed.has(value)));
}

export function savAutoReplyRolloutPercent() {
  const value = Number(process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT ?? 0);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
}

export function savAutoReplyDailyLimit() {
  const value = Number(process.env.SAV_AUTO_REPLY_DAILY_LIMIT ?? 10);
  return Number.isFinite(value) ? Math.min(500, Math.max(1, Math.round(value))) : 10;
}

export function savThreadInAutoReplyRollout(threadId: string, percent = savAutoReplyRolloutPercent()) {
  let hash = 2166136261;
  for (const char of threadId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash % 100) < percent;
}
