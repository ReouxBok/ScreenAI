import { z } from "zod";

export const savAutomationModeSchema = z.enum(["shadow", "assist", "semi", "on"]);
export type SavAutomationMode = z.infer<typeof savAutomationModeSchema>;
export const savHarnessModeSchema = z.enum(["off", "shadow", "pilot", "on"]);
export type SavHarnessMode = z.infer<typeof savHarnessModeSchema>;

export const SAV_AGENT_ID = "sav-ticket-analyst";
export const SAV_AGENT_SCOPE = "sav_ticket_analysis";
export const SAV_PROMPT_REVISION = "sav-adk-2026-09-01.1";

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
