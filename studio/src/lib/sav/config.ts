import { z } from "zod";

export const savAutomationModeSchema = z.enum(["shadow", "assist", "semi", "on"]);
export type SavAutomationMode = z.infer<typeof savAutomationModeSchema>;
export const savHarnessModeSchema = z.enum(["off", "shadow", "pilot", "on"]);
export type SavHarnessMode = z.infer<typeof savHarnessModeSchema>;

export const SAV_AGENT_ID = "sav-ticket-analyst";
export const SAV_AGENT_SCOPE = "sav_ticket_analysis";
export const SAV_PROMPT_REVISION = "sav-adk-2026-09-09.1";
export const SAV_LEGACY_PROMPT_REVISION = "sav-legacy-2026-09-09.1";

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
  return ["semi", "on"].includes(savAutomationMode());
}

export function canSendRepliesAutomatically() {
  return savAutomationMode() === "on";
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
