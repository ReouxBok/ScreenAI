import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savActions, savAgentRuns, savPilotItems } from "@/db/schema";
import { SAV_PROMPT_REVISION } from "./config";

export type SavPromotionMetrics = {
  versionReviewed: number;
  versionCorrect: number;
  versionPartial: number;
  versionCritical: number;
  versionDegraded: number;
  versionCalibrationError: number;
  globalReviewed: number;
  failedActions: number;
};

export function evaluateSavPromotion(metrics: SavPromotionMetrics) {
  const acceptanceRate = metrics.versionReviewed
    ? ((metrics.versionCorrect + metrics.versionPartial * 0.5) / metrics.versionReviewed) * 100
    : 0;
  const reasons = [
    ...(metrics.versionReviewed < 30 ? ["SAV_PROMOTION_NEEDS_30_VERSION_REVIEWS"] : []),
    ...(acceptanceRate < 90 ? ["SAV_PROMOTION_ACCEPTANCE_BELOW_90"] : []),
    ...(metrics.versionCritical > 0 ? ["SAV_PROMOTION_HAS_CRITICAL_REVIEW"] : []),
    ...(metrics.versionDegraded > 0 ? ["SAV_PROMOTION_HAS_DEGRADED_RUN"] : []),
    ...(metrics.versionCalibrationError > 15 ? ["SAV_PROMOTION_CONFIDENCE_NOT_CALIBRATED"] : []),
    ...(metrics.globalReviewed < 100 ? ["SAV_PROMOTION_NEEDS_100_GLOBAL_REVIEWS"] : []),
    ...(metrics.failedActions > 0 ? ["SAV_PROMOTION_HAS_FAILED_ACTION"] : []),
  ];
  return { eligible: reasons.length === 0, acceptanceRate: Math.round(acceptanceRate * 10) / 10, reasons, metrics };
}

export function savConfidenceCalibrationError(rows: Array<{ confidence: number | null; verdict: string | null }>) {
  const reviewed = rows.filter((row) => row.confidence !== null && row.verdict);
  if (!reviewed.length) return 100;
  const bins = new Map<number, { confidence: number; observed: number; count: number }>();
  for (const row of reviewed) {
    const confidence = Math.min(1, Math.max(0, (row.confidence ?? 0) / 1_000));
    const observed = row.verdict === "correct" ? 1 : row.verdict === "partial" ? 0.5 : 0;
    const key = Math.min(9, Math.floor(confidence * 10));
    const bin = bins.get(key) ?? { confidence: 0, observed: 0, count: 0 };
    bin.confidence += confidence;
    bin.observed += observed;
    bin.count += 1;
    bins.set(key, bin);
  }
  const error = [...bins.values()].reduce((sum, bin) => sum
    + Math.abs(bin.confidence / bin.count - bin.observed / bin.count) * bin.count / reviewed.length, 0);
  return Math.round(error * 1_000) / 10;
}

/** Reviews are counted only on the producing run for this exact prompt and model pair. */
export async function getSavAutonomyGate(
  promptRevision = SAV_PROMPT_REVISION,
  model = process.env.SAV_AI_MODEL ?? "gemini-3.6-flash",
) {
  const db = requireDb();
  const [version] = await db.select({
    reviewed: sql<number>`count(distinct ${savPilotItems.id}) filter (where ${savPilotItems.reviewedAt} is not null)::int`,
    correct: sql<number>`count(distinct ${savPilotItems.id}) filter (where ${savPilotItems.verdict} = 'correct')::int`,
    partial: sql<number>`count(distinct ${savPilotItems.id}) filter (where ${savPilotItems.verdict} = 'partial')::int`,
    critical: sql<number>`count(distinct ${savPilotItems.id}) filter (where ${savPilotItems.verdict} = 'critical')::int`,
    degraded: sql<number>`count(distinct ${savAgentRuns.id}) filter (where ${savAgentRuns.status} in ('failed', 'fallback'))::int`,
  }).from(savAgentRuns).leftJoin(savPilotItems, eq(savPilotItems.agentRunId, savAgentRuns.id)).where(and(
    eq(savAgentRuns.promptRevision, promptRevision),
    eq(savAgentRuns.model, model),
    inArray(savAgentRuns.status, ["succeeded", "failed", "fallback"]),
  ));
  const [global] = await db.select({ count: sql<number>`count(*)::int` }).from(savPilotItems).where(isNotNull(savPilotItems.reviewedAt));
  const calibrationRows = await db.select({ confidence: savAgentRuns.confidence, verdict: savPilotItems.verdict })
    .from(savAgentRuns).innerJoin(savPilotItems, eq(savPilotItems.agentRunId, savAgentRuns.id)).where(and(
      eq(savAgentRuns.promptRevision, promptRevision), eq(savAgentRuns.model, model),
      isNotNull(savPilotItems.reviewedAt), eq(savAgentRuns.status, "succeeded"),
    ));
  const [failed] = await db.select({ count: sql<number>`count(*)::int` }).from(savActions).where(eq(savActions.status, "failed"));
  return evaluateSavPromotion({
    versionReviewed: version?.reviewed ?? 0, versionCorrect: version?.correct ?? 0,
    versionPartial: version?.partial ?? 0, versionCritical: version?.critical ?? 0,
    versionDegraded: version?.degraded ?? 0, globalReviewed: global?.count ?? 0, failedActions: failed?.count ?? 0,
    versionCalibrationError: savConfidenceCalibrationError(calibrationRows),
  });
}
