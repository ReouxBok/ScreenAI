import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, lt, max, ne } from "drizzle-orm";
import { requireDb } from "@/db";
import {
  auditLogs,
  contentItems,
  contentVersions,
  evaluationCases,
  evaluationEvents,
  evaluationRuns,
  evaluationSuites,
  type EvaluationExpectation,
  type OnboardingMetadata,
} from "@/db/schema";

const RUN_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const safeText = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export type EvaluationScoreInput = {
  isLive: boolean;
  delivered: boolean;
  actionSucceeded: boolean;
  verified: boolean;
  failed: boolean;
  manual: boolean;
  verdict: "correct" | "problem";
  threshold: number;
};

export function scoreEvaluation(input: EvaluationScoreInput) {
  const score = Math.max(0, Math.min(100,
    (input.delivered ? 25 : 0)
    + (!input.isLive || input.actionSucceeded ? 30 : 0)
    + (!input.isLive || input.verified ? 30 : 0)
    + (input.verdict === "correct" ? 15 : 0)
    - (input.failed ? 30 : 0)
    - (input.manual ? 30 : 0)
  ));
  return {
    score,
    passed: input.verdict === "correct" && !input.failed && !input.manual && score >= input.threshold,
    failureCode: input.manual ? "manual_intervention" : input.failed ? "tool_failure" : score < input.threshold || input.verdict !== "correct" ? "criteria_not_met" : null,
  };
}

function expectationFor(item: typeof contentItems.$inferSelect, version: typeof contentVersions.$inferSelect): EvaluationExpectation {
  const metadata = version.metadata as OnboardingMetadata;
  const actionSteps = Array.isArray(metadata.actionSteps) ? metadata.actionSteps : [];
  const requiredTools = [...new Set(actionSteps.flatMap((step) => {
    if (step.action === "click") return ["click_element"];
    if (step.action === "input") return ["fill_field"];
    if (step.action === "external_popup") return ["click_element", "verify_expected_result"];
    return [];
  }))];
  return {
    startPath: metadata.expectedPages?.[0] || "/",
    objective: metadata.objective || item.summary || item.title,
    expectedPages: (metadata.expectedPages || []).slice(0, 20),
    successCriteria: (metadata.successCriteria || ["Le résultat demandé est visible dans Limova"]).slice(0, 20),
    requiredTools: requiredTools.length ? requiredTools : ["inspect_current_page", "verify_expected_result"],
  };
}

export async function ensureEvaluationSuite(itemId: string, actorEmail: string) {
  const db = requireDb();
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, itemId)).limit(1);
  if (!item?.currentDraftVersionId || item.type !== "onboarding") throw new Error("EVALUATION_REQUIRES_ONBOARDING_DRAFT");
  const [version] = await db.select().from(contentVersions).where(eq(contentVersions.id, item.currentDraftVersionId)).limit(1);
  if (!version) throw new Error("DRAFT_NOT_FOUND");
  const expectation = expectationFor(item, version);
  const [existing] = await db.select().from(evaluationSuites).where(eq(evaluationSuites.versionId, version.id)).limit(1);
  if (existing) {
    return db.transaction(async (tx) => {
      const [flowCase] = await tx.select().from(evaluationCases)
        .where(and(eq(evaluationCases.suiteId, existing.id), eq(evaluationCases.kind, "live_action")))
        .orderBy(asc(evaluationCases.ordinal)).limit(1);
      const values = {
        suiteId: existing.id,
        ordinal: 1,
        kind: "live_action",
        title: "Tester le flow complet dans Limova",
        prompt: `Aide-moi à ${item.title.toLocaleLowerCase("fr")}.`,
        critical: true,
        expectation,
      } as const;
      if (flowCase) {
        await tx.update(evaluationCases).set(values).where(eq(evaluationCases.id, flowCase.id));
      } else {
        await tx.insert(evaluationCases).values(values);
      }
      await tx.delete(evaluationCases).where(and(
        eq(evaluationCases.suiteId, existing.id),
        ne(evaluationCases.kind, "live_action"),
      ));
      return existing;
    });
  }
  return db.transaction(async (tx) => {
    const [suite] = await tx.insert(evaluationSuites).values({ itemId, versionId: version.id, createdBy: actorEmail }).returning();
    await tx.insert(evaluationCases).values({
      suiteId: suite.id,
      ordinal: 1,
      kind: "live_action",
      title: "Tester le flow complet dans Limova",
      prompt: `Aide-moi à ${item.title.toLocaleLowerCase("fr")}.`,
      critical: true,
      expectation,
    });
    await tx.insert(auditLogs).values({ actorEmail, action: "evaluation_suite_created", entityType: "content", entityId: itemId, technicalMetadata: { versionId: version.id } });
    return suite;
  });
}

export async function createEvaluationRun(itemId: string, caseId: string, actorEmail: string) {
  const db = requireDb();
  const suite = await ensureEvaluationSuite(itemId, actorEmail);
  const [testCase] = await db.select().from(evaluationCases).where(and(eq(evaluationCases.id, caseId), eq(evaluationCases.suiteId, suite.id))).limit(1);
  if (!testCase) throw new Error("EVALUATION_CASE_NOT_FOUND");
  const token = randomBytes(24).toString("base64url");
  const [run] = await db.insert(evaluationRuns).values({
    suiteId: suite.id,
    caseId: testCase.id,
    tokenHash: tokenHash(token),
    createdBy: actorEmail,
    expiresAt: new Date(Date.now() + RUN_LIFETIME_MS),
  }).returning();
  return { run, token };
}

export async function getEvaluationForContent(itemId: string) {
  const db = requireDb();
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, itemId)).limit(1);
  if (!item?.currentDraftVersionId) return null;
  const [suite] = await db.select().from(evaluationSuites).where(eq(evaluationSuites.versionId, item.currentDraftVersionId)).limit(1);
  if (!suite) return null;
  const cases = await db.select().from(evaluationCases).where(and(
    eq(evaluationCases.suiteId, suite.id),
    eq(evaluationCases.kind, "live_action"),
  )).orderBy(asc(evaluationCases.ordinal));
  const runs = await db.select().from(evaluationRuns).where(eq(evaluationRuns.suiteId, suite.id)).orderBy(desc(evaluationRuns.createdAt));
  return { suite, cases, runs };
}

export async function findEvaluationByToken(token: string) {
  if (token.length < 24 || token.length > 100) return null;
  const db = requireDb();
  const [row] = await db.select({ run: evaluationRuns, suite: evaluationSuites, testCase: evaluationCases, item: contentItems, version: contentVersions })
    .from(evaluationRuns)
    .innerJoin(evaluationSuites, eq(evaluationRuns.suiteId, evaluationSuites.id))
    .innerJoin(evaluationCases, eq(evaluationRuns.caseId, evaluationCases.id))
    .innerJoin(contentItems, eq(evaluationSuites.itemId, contentItems.id))
    .innerJoin(contentVersions, eq(evaluationSuites.versionId, contentVersions.id))
    .where(eq(evaluationRuns.tokenHash, tokenHash(token))).limit(1);
  if (!row || row.run.expiresAt.getTime() <= Date.now() || row.item.currentDraftVersionId !== row.version.id) return null;
  return row;
}

export async function connectEvaluation(token: string, extensionVersion: string) {
  const detail = await findEvaluationByToken(token);
  if (!detail || !["ready", "running"].includes(detail.run.status)) return null;
  const [run] = await requireDb().update(evaluationRuns).set({
    status: "running",
    extensionVersion: safeText(extensionVersion, 40),
    startedAt: detail.run.startedAt ?? new Date(),
  }).where(eq(evaluationRuns.id, detail.run.id)).returning();
  return {
    run,
    suite: detail.suite,
    case: detail.testCase,
    content: {
      id: detail.item.id,
      title: detail.item.title,
      summary: detail.item.summary,
      bodyMarkdown: detail.version.bodyMarkdown,
      metadata: detail.version.metadata,
      versionId: detail.version.id,
    },
  };
}

export async function appendEvaluationEvent(token: string, raw: Record<string, unknown>) {
  const detail = await findEvaluationByToken(token);
  if (!detail || detail.run.status !== "running") return null;
  const allowedStatus = ["ok", "not_found", "ambiguous", "blocked", "unexpected", "failed"];
  const db = requireDb();
  return db.transaction(async (tx) => {
    const [{ lastOrdinal }] = await tx.select({ lastOrdinal: max(evaluationEvents.ordinal) }).from(evaluationEvents).where(eq(evaluationEvents.runId, detail.run.id));
    const [event] = await tx.insert(evaluationEvents).values({
      runId: detail.run.id,
      ordinal: (lastOrdinal ?? 0) + 1,
      kind: safeText(raw.kind, 40) || "technical",
      toolName: safeText(raw.toolName, 80) || null,
      status: allowedStatus.includes(String(raw.status)) ? String(raw.status) : null,
      path: safeText(raw.path, 500) || null,
      targetLabel: safeText(raw.targetLabel, 300) || null,
      technicalMetadata: {
        contextVersion: Math.max(0, Number(raw.contextVersion) || 0),
        manualIntervention: raw.manualIntervention === true,
      },
    }).returning();
    return event;
  });
}

async function refreshSuite(suiteId: string) {
  const db = requireDb();
  const cases = await db.select().from(evaluationCases).where(eq(evaluationCases.suiteId, suiteId));
  const runs = await db.select().from(evaluationRuns).where(eq(evaluationRuns.suiteId, suiteId)).orderBy(desc(evaluationRuns.completedAt));
  const latestByCase = new Map<string, typeof evaluationRuns.$inferSelect>();
  for (const run of runs) if (!latestByCase.has(run.caseId) && run.completedAt) latestByCase.set(run.caseId, run);
  const critical = cases.filter((testCase) => testCase.critical);
  const passed = critical.length > 0 && critical.every((testCase) => latestByCase.get(testCase.id)?.status === "passed");
  const scores = [...latestByCase.values()].map((run) => run.score).filter((score): score is number => score !== null);
  const score = scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null;
  const [suite] = await db.update(evaluationSuites).set({
    status: passed ? "passed" : runs.some((run) => run.completedAt) ? "failed" : "draft",
    score,
    passedAt: passed ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(evaluationSuites.id, suiteId)).returning();
  return suite;
}

export async function completeEvaluation(token: string, verdict: "correct" | "problem", promptRevision = "", knowledgeRevision = "") {
  const detail = await findEvaluationByToken(token);
  if (!detail || detail.run.status !== "running") return null;
  const db = requireDb();
  const events = await db.select().from(evaluationEvents).where(eq(evaluationEvents.runId, detail.run.id)).orderBy(asc(evaluationEvents.ordinal));
  const failed = events.some((event) => ["failed", "blocked", "unexpected"].includes(event.status ?? ""));
  const manual = events.some((event) => event.technicalMetadata.manualIntervention === true);
  const delivered = events.some((event) => event.kind === "response" && event.status === "ok");
  const actionSucceeded = events.some((event) => ["click_element", "fill_field", "navigate_internal", "scroll_page"].includes(event.toolName ?? "") && event.status === "ok");
  const verified = events.some((event) => event.toolName === "verify_expected_result" && event.status === "ok");
  const isLive = detail.testCase.kind === "live_action";
  const result = scoreEvaluation({ isLive, delivered, actionSucceeded, verified, failed, manual, verdict, threshold: detail.suite.threshold });
  const [run] = await db.update(evaluationRuns).set({
    status: result.passed ? "passed" : "failed",
    score: result.score,
    contributorVerdict: verdict,
    failureCode: result.failureCode,
    promptRevision: safeText(promptRevision, 160),
    knowledgeRevision: safeText(knowledgeRevision, 160),
    completedAt: new Date(),
  }).where(eq(evaluationRuns.id, detail.run.id)).returning();
  const suite = await refreshSuite(detail.suite.id);
  return { run, suite };
}

export async function hasPassingEvaluation(itemId: string, versionId: string) {
  const [suite] = await requireDb().select().from(evaluationSuites).where(and(eq(evaluationSuites.itemId, itemId), eq(evaluationSuites.versionId, versionId))).limit(1);
  return suite?.status === "passed" && Boolean(suite.passedAt);
}

export async function expireStaleEvaluationRuns(now = new Date()) {
  const db = requireDb();
  const staleRuns = await db.select({ id: evaluationRuns.id }).from(evaluationRuns).where(and(
    eq(evaluationRuns.status, "running"),
    lt(evaluationRuns.expiresAt, now),
  ));
  if (!staleRuns.length) return { expired: [] as string[] };
  const expired: string[] = [];
  for (const stale of staleRuns) {
    const [updated] = await db.update(evaluationRuns).set({
      status: "failed",
      failureCode: "expired",
      completedAt: now,
    }).where(and(
      eq(evaluationRuns.id, stale.id),
      eq(evaluationRuns.status, "running"),
      lt(evaluationRuns.expiresAt, now),
    )).returning({ id: evaluationRuns.id, suiteId: evaluationRuns.suiteId });
    if (!updated) continue;
    expired.push(updated.id);
    await db.insert(auditLogs).values({
      actorEmail: "studio-reconciler@limova.ai",
      action: "evaluation_expired",
      entityType: "evaluation_run",
      entityId: updated.id,
      technicalMetadata: { reason: "run_expired_while_running" },
    });
    await refreshSuite(updated.suiteId);
  }
  return { expired };
}
