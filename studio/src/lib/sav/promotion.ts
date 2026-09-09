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
    ...(metrics.globalReviewed < 100 ? ["SAV_PROMOTION_NEEDS_100_GLOBAL_REVIEWS"] : []),
    ...(metrics.failedActions > 0 ? ["SAV_PROMOTION_HAS_FAILED_ACTION"] : []),
  ];
  return { eligible: reasons.length === 0, acceptanceRate: Math.round(acceptanceRate * 10) / 10, reasons, metrics };
}

/** Reviews are counted only on the primary successful ADK run for this exact prompt revision. */
export async function getSavAutonomyGate(promptRevision = SAV_PROMPT_REVISION) {
  const db = requireDb();
  const [version] = await db.select({
    reviewed: sql<number>`count(distinct ${savPilotItems.id}) filter (where ${savPilotItems.reviewedAt} is not null)::int`,
    correct: sql<number>`count(distinct ${savPilotItems.id}) filter (where ${savPilotItems.verdict} = 'correct')::int`,
    partial: sql<number>`count(distinct ${savPilotItems.id}) filter (where ${savPilotItems.verdict} = 'partial')::int`,
    critical: sql<number>`count(distinct ${savPilotItems.id}) filter (where ${savPilotItems.verdict} = 'critical')::int`,
    degraded: sql<number>`count(distinct ${savAgentRuns.id}) filter (where ${savAgentRuns.status} in ('failed', 'fallback'))::int`,
  }).from(savAgentRuns).leftJoin(savPilotItems, eq(savPilotItems.agentRunId, savAgentRuns.id)).where(and(
    eq(savAgentRuns.promptRevision, promptRevision),
    inArray(savAgentRuns.status, ["succeeded", "failed", "fallback"]),
  ));
  const [global] = await db.select({ count: sql<number>`count(*)::int` }).from(savPilotItems).where(isNotNull(savPilotItems.reviewedAt));
  const [failed] = await db.select({ count: sql<number>`count(*)::int` }).from(savActions).where(eq(savActions.status, "failed"));
  return evaluateSavPromotion({
    versionReviewed: version?.reviewed ?? 0, versionCorrect: version?.correct ?? 0,
    versionPartial: version?.partial ?? 0, versionCritical: version?.critical ?? 0,
    versionDegraded: version?.degraded ?? 0, globalReviewed: global?.count ?? 0, failedActions: failed?.count ?? 0,
  });
}
