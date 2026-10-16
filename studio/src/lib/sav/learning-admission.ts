import "server-only";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import {
  auditLogs,
  savLearningAdmissionAttempts,
  savLearningAdmissionReservations,
  savLearningAdmissionSignals,
  savLearningAdmissionStats,
  savLearningModelUsage,
  savSyncState,
} from "@/db/schema";
import { savContentHash } from "./crypto";

export const SAV_LEARNING_CUTOVER_KEY = "sav-learning-admission-cutover";
export const SAV_LEARNING_ADMISSION_LOCK_KEY = "sav-learning-admission-lock";
export const SAV_LEARNING_POLICY_REVISION = "sav-learning-admission-2026-10-16.v4";
export const SAV_LEARNING_COMPARISON_LEASE_MS = 60_000;
export const SAV_LEARNING_COMPARATOR_REVISION = "sav-learning-comparator-2026-10-16.v3";
export const SAV_LEARNING_PROMPT_REVISION = "sav-learning-comparator-prompt-2026-10-15.v2";
export const SAV_LEARNING_OPEN_LIMIT = 10;
export const SAV_LEARNING_WEEKLY_LIMIT = 5;
export const SAV_LEARNING_SIGNAL_LIMIT = 100;
export const SAV_LEARNING_SIGNAL_RETENTION_DAYS = 30;

const cutoverSchema = z.object({
  activatedAt: z.iso.datetime({ offset: true }),
  activatedBy: z.literal("ugo@limova.ai"),
  deploymentSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type SavLearningCutover = z.infer<typeof cutoverSchema>;

type Db = ReturnType<typeof requireDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
function signalSourceRef(value: string) { return /^[a-z0-9:_-]{1,180}$/i.test(value) ? value : `opaque:${savContentHash(value)}`; }
function safeSignalDetails(details: Record<string, unknown> | undefined) {
  const allowed = new Set(["policyRevision", "provenance", "used", "limit", "outcome", "distinctCaseAdded", "caseCount", "weekly", "open"]);
  return Object.fromEntries(Object.entries(details ?? {}).filter(([key, value]) => allowed.has(key) &&
    (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(value))));
}

export async function getSavLearningCutover(db: Db | Tx = requireDb()): Promise<SavLearningCutover | null> {
  const [row] = await db.select().from(savSyncState).where(eq(savSyncState.key, SAV_LEARNING_CUTOVER_KEY)).limit(1);
  if (!row || row.status !== "active" || !row.cursor) return null;
  return cutoverSchema.parse(JSON.parse(row.cursor));
}

/** The cutover is an explicit, immutable Ugo operation; ingestion never activates it. */
export async function activateSavLearningCutover(input: SavLearningCutover, actorEmail: string) {
  const boundary = cutoverSchema.parse(input);
  if (actorEmail.toLowerCase() !== "ugo@limova.ai" || boundary.activatedBy !== "ugo@limova.ai") throw new Error("SAV_CUTOVER_UGO_APPROVAL_REQUIRED");
  if (Date.parse(boundary.activatedAt) > Date.now()) throw new Error("SAV_LEARNING_CUTOVER_IN_FUTURE");
  return requireDb().transaction(async (tx) => {
    const [created] = await tx.insert(savSyncState).values({
      key: SAV_LEARNING_CUTOVER_KEY,
      status: "active",
      cursor: JSON.stringify(boundary),
      startedAt: new Date(boundary.activatedAt),
    }).onConflictDoNothing().returning();
    if (!created) {
      const existing = await getSavLearningCutover(tx);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(boundary)) throw new Error("SAV_LEARNING_CUTOVER_IMMUTABLE");
      return existing;
    }
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "sav_learning_cutover_activated",
      entityType: "sav_learning_cutover",
      entityId: SAV_LEARNING_CUTOVER_KEY,
      technicalMetadata: { ...boundary, policyRevision: SAV_LEARNING_POLICY_REVISION },
    });
    return boundary;
  });
}

/** An old ticket is eligible only when its current resolution cycle began after activation. */
export function isSavLearningCycleEligible(cycleStartedAt: Date | string | null | undefined, cutover: SavLearningCutover | null) {
  if (!cutover || !cycleStartedAt) return false;
  const cycleTime = typeof cycleStartedAt === "string" ? Date.parse(cycleStartedAt) : cycleStartedAt.getTime();
  return Number.isFinite(cycleTime) && cycleTime > Date.parse(cutover.activatedAt);
}

export type SavLearningSignalInput = {
  sourceRef: string;
  sourceHash: string;
  origin: "hubspot" | "observation" | "pilot" | "human" | "chrome";
  reasonCode: string;
  groupKey?: string | null;
  candidateId?: string | null;
  state?: "open" | "signal" | "closed";
  comparatorRevision?: string | null;
  promptRevision?: string | null;
  modelName?: string | null;
  inputHash?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  details?: Record<string, unknown>;
};

async function pruneSignalJournal(tx: Tx, now: Date) {
  const retentionBoundary = new Date(now.getTime() - SAV_LEARNING_SIGNAL_RETENTION_DAYS * 86_400_000).toISOString();
  await tx.execute(sql`delete from sav.learning_admission_signals where created_at < ${retentionBoundary}::timestamptz or id not in (select id from sav.learning_admission_signals order by created_at desc, id desc limit ${SAV_LEARNING_SIGNAL_LIMIT})`);
}
async function aggregateSignal(tx: Tx, origin: string, reasonCode: string, now: Date) {
  await tx.insert(savLearningAdmissionStats).values({ day: now.toISOString().slice(0, 10), origin, reasonCode, count: 1 })
    .onConflictDoUpdate({ target: [savLearningAdmissionStats.day, savLearningAdmissionStats.origin, savLearningAdmissionStats.reasonCode], set: { count: sql`${savLearningAdmissionStats.count} + 1` } });
}

/** The journal can expire; the terminal decision must never become eligible again. */
export async function recordSavLearningSignalTx(tx: Tx, input: SavLearningSignalInput, now = new Date()) {
  const dedupeKey = savContentHash({ sourceRef: input.sourceRef, sourceHash: input.sourceHash });
  const [attempt] = await tx.insert(savLearningAdmissionAttempts).values({ dedupeKey, sourceRef: signalSourceRef(input.sourceRef), sourceHash: input.sourceHash,
    origin: input.origin, reasonCode: input.reasonCode, state: input.state ?? "signal", candidateId: input.candidateId ?? null, createdAt: now, completedAt: now }).onConflictDoNothing().returning();
  if (!attempt) return { inserted: false as const };
  await tx.insert(savLearningAdmissionSignals).values({ ...input, id: attempt.id, dedupeKey, sourceRef: attempt.sourceRef, state: attempt.state,
    details: safeSignalDetails(input.details), createdAt: now });
  await aggregateSignal(tx, input.origin, input.reasonCode, now);
  await pruneSignalJournal(tx, now);
  return { inserted: true as const, signalId: attempt.id };
}

/** A recoverable lease is distinct from a durable terminal decision. No source text is stored here. */
export async function claimSavLearningComparisonTx(tx: Tx, input: { sourceRef: string; sourceHash: string; origin: SavLearningSignalInput["origin"]; inputHash: string; now?: Date }) {
  await lockSavLearningAdmissionTx(tx);
  const now = input.now ?? new Date(), comparisonLeaseToken = randomUUID();
  const comparisonLeaseUntil = new Date(now.getTime() + SAV_LEARNING_COMPARISON_LEASE_MS);
  const dedupeKey = savContentHash({ sourceRef: input.sourceRef, sourceHash: input.sourceHash });
  const [inserted] = await tx.insert(savLearningAdmissionAttempts).values({ dedupeKey, sourceRef: signalSourceRef(input.sourceRef), sourceHash: input.sourceHash,
    origin: input.origin, reasonCode: "comparison_started", state: "comparing", createdAt: now, comparisonLeaseToken, comparisonLeaseUntil }).onConflictDoNothing().returning();
  let attempt = inserted;
  if (!attempt) {
    const [prior] = await tx.select().from(savLearningAdmissionAttempts).where(eq(savLearningAdmissionAttempts.dedupeKey, dedupeKey)).for("update");
    if (!prior || !["comparing", "retryable"].includes(prior.state) || prior.comparisonLeaseUntil && prior.comparisonLeaseUntil > now) return { claimed: false as const };
    [attempt] = await tx.update(savLearningAdmissionAttempts).set({ state: "comparing", reasonCode: "comparison_started", completedAt: null,
      comparisonLeaseToken, comparisonLeaseUntil }).where(eq(savLearningAdmissionAttempts.id, prior.id)).returning();
  }
  const values = { id: attempt.id, dedupeKey, sourceRef: attempt.sourceRef, sourceHash: input.sourceHash, origin: input.origin,
    reasonCode: "comparison_started", state: "comparing", comparatorRevision: SAV_LEARNING_COMPARATOR_REVISION,
    promptRevision: SAV_LEARNING_PROMPT_REVISION, inputHash: input.inputHash, createdAt: now };
  await tx.insert(savLearningAdmissionSignals).values(values).onConflictDoUpdate({ target: savLearningAdmissionSignals.dedupeKey, set: values });
  await pruneSignalJournal(tx, now);
  return { claimed: true as const, signalId: attempt.id, leaseToken: comparisonLeaseToken };
}
export async function assertSavLearningComparisonClaimTx(tx: Tx, signalId: string, leaseToken: string) {
  const [attempt] = await tx.select().from(savLearningAdmissionAttempts).where(eq(savLearningAdmissionAttempts.id, signalId)).for("update");
  if (!attempt || attempt.state !== "comparing" || attempt.comparisonLeaseToken !== leaseToken) throw new Error("SAV_LEARNING_SIGNAL_STALE");
  return attempt;
}
export async function releaseSavLearningComparisonTx(tx: Tx, signalId: string, leaseToken: string) {
  const [released] = await tx.update(savLearningAdmissionAttempts).set({ state: "retryable", reasonCode: "comparison_retryable", comparisonLeaseToken: null, comparisonLeaseUntil: null })
    .where(and(eq(savLearningAdmissionAttempts.id, signalId), eq(savLearningAdmissionAttempts.state, "comparing"), eq(savLearningAdmissionAttempts.comparisonLeaseToken, leaseToken)))
    .returning({ id: savLearningAdmissionAttempts.id });
  if (released) await tx.update(savLearningAdmissionSignals).set({ state: "retryable", reasonCode: "comparison_retryable" }).where(eq(savLearningAdmissionSignals.id, signalId));
}

export async function finishSavLearningComparisonTx(tx: Tx, signalId: string, input: Omit<SavLearningSignalInput, "sourceRef" | "sourceHash" | "origin">, now: Date, leaseToken: string) {
  const prior = await assertSavLearningComparisonClaimTx(tx, signalId, leaseToken);
  await tx.update(savLearningAdmissionAttempts).set({ state: input.state ?? "signal", reasonCode: input.reasonCode, candidateId: input.candidateId ?? null,
    completedAt: now, comparisonLeaseToken: null, comparisonLeaseUntil: null }).where(eq(savLearningAdmissionAttempts.id, signalId));
  const values = { ...input, id: prior.id, dedupeKey: prior.dedupeKey, sourceRef: prior.sourceRef, sourceHash: prior.sourceHash, origin: prior.origin,
    state: input.state ?? "signal", details: safeSignalDetails(input.details), createdAt: now };
  await tx.insert(savLearningAdmissionSignals).values(values).onConflictDoUpdate({ target: savLearningAdmissionSignals.dedupeKey, set: values });
  await aggregateSignal(tx, prior.origin, input.reasonCode, now);
  await pruneSignalJournal(tx, now);
}

export async function recordSavLearningSignal(input: SavLearningSignalInput, now = new Date()) {
  return requireDb().transaction((tx) => recordSavLearningSignalTx(tx, input, now));
}

/** Serializes admission before reservation and candidate creation across DB workers. */
export async function lockSavLearningAdmissionTx(tx: Tx) {
  await tx.insert(savSyncState).values({ key: SAV_LEARNING_ADMISSION_LOCK_KEY, status: "idle" }).onConflictDoNothing();
  await tx.select().from(savSyncState).where(eq(savSyncState.key, SAV_LEARNING_ADMISSION_LOCK_KEY)).for("update");
}

export async function reserveSavLearningCapacityTx(tx: Tx, input: { reservationKey: string; proposalKind: "new" | "amendment"; now?: Date }) {
  const now = input.now ?? new Date();
  await lockSavLearningAdmissionTx(tx);
  const [existing] = await tx.select().from(savLearningAdmissionReservations).where(eq(savLearningAdmissionReservations.reservationKey, input.reservationKey)).limit(1);
  if (existing) return { ok: true as const, duplicate: true as const, reservation: existing };
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const [{ total: weekly }] = await tx.select({ total: count() }).from(savLearningAdmissionReservations)
    .where(and(gte(savLearningAdmissionReservations.createdAt, weekStart), lt(savLearningAdmissionReservations.createdAt, new Date(now.getTime() + 1)), inArray(savLearningAdmissionReservations.proposalKind, ["new", "amendment"])));
  const [{ total: open }] = await tx.select({ total: count() }).from(savLearningAdmissionReservations).where(eq(savLearningAdmissionReservations.state, "open"));
  if (weekly >= SAV_LEARNING_WEEKLY_LIMIT) return { ok: false as const, reasonCode: "weekly_limit" as const, weekly, open };
  if (open >= SAV_LEARNING_OPEN_LIMIT) return { ok: false as const, reasonCode: "open_limit" as const, weekly, open };
  const [reservation] = await tx.insert(savLearningAdmissionReservations).values({
    reservationKey: input.reservationKey,
    proposalKind: input.proposalKind,
    state: "open",
    createdAt: now,
  }).returning();
  return { ok: true as const, duplicate: false as const, reservation };
}

export async function bindSavLearningReservationTx(tx: Tx, reservationId: string, candidateId: string) {
  await tx.update(savLearningAdmissionReservations).set({ candidateId }).where(eq(savLearningAdmissionReservations.id, reservationId));
}

export async function closeSavLearningReservationTx(tx: Tx, candidateId: string, now = new Date()) {
  await tx.update(savLearningAdmissionReservations).set({ state: "closed", closedAt: now })
    .where(and(eq(savLearningAdmissionReservations.candidateId, candidateId), eq(savLearningAdmissionReservations.state, "open")));
}

/** Atomically reserves a daily model call. Retries of a source should reuse its saved decision instead. */
export async function reserveSavLearningModelCallTx(tx: Tx, now = new Date()) {
  await lockSavLearningAdmissionTx(tx);
  const day = now.toISOString().slice(0, 10);
  const [usage] = await tx.select().from(savLearningModelUsage).where(eq(savLearningModelUsage.day, day)).for("update");
  if (usage) await tx.update(savLearningModelUsage).set({ callCount: usage.callCount + 1, updatedAt: now }).where(eq(savLearningModelUsage.day, day));
  else await tx.insert(savLearningModelUsage).values({ day, callCount: 1, updatedAt: now });
  return { ok: true as const, used: (usage?.callCount ?? 0) + 1 };
}

export async function savLearningAdmissionMetrics(since = new Date(Date.now() - 7 * 86_400_000)) {
  const db = requireDb();
  const stats = await db.select({ day: savLearningAdmissionStats.day, origin: savLearningAdmissionStats.origin, reasonCode: savLearningAdmissionStats.reasonCode, count: savLearningAdmissionStats.count })
    .from(savLearningAdmissionStats).where(gte(savLearningAdmissionStats.day, since.toISOString().slice(0, 10)));
  const [{ open }] = await db.select({ open: count() }).from(savLearningAdmissionReservations).where(eq(savLearningAdmissionReservations.state, "open"));
  const today = new Date().toISOString().slice(0, 10);
  const [usage] = await db.select({ callCount: savLearningModelUsage.callCount }).from(savLearningModelUsage).where(eq(savLearningModelUsage.day, today)).limit(1);
  const recentSignals = await db.select({ id: savLearningAdmissionSignals.id, candidateId: savLearningAdmissionSignals.candidateId, createdAt: savLearningAdmissionSignals.createdAt, origin: savLearningAdmissionSignals.origin, reasonCode: savLearningAdmissionSignals.reasonCode, state: savLearningAdmissionSignals.state, errorCode: savLearningAdmissionSignals.errorCode, inputTokens: savLearningAdmissionSignals.inputTokens, outputTokens: savLearningAdmissionSignals.outputTokens, durationMs: savLearningAdmissionSignals.durationMs })
    .from(savLearningAdmissionSignals).where(gte(savLearningAdmissionSignals.createdAt, new Date(Date.now() - SAV_LEARNING_SIGNAL_RETENTION_DAYS * 86_400_000))).orderBy(desc(savLearningAdmissionSignals.createdAt)).limit(SAV_LEARNING_SIGNAL_LIMIT);
  const cutover = await getSavLearningCutover(db);
  return { since: since.toISOString(), windowDays: 7, openAutomaticProposals: open, weeklyLimit: SAV_LEARNING_WEEKLY_LIMIT, openLimit: SAV_LEARNING_OPEN_LIMIT,
    dailyModelCalls: usage?.callCount ?? 0, dailyModelLimit: null, cutover, signals: stats, recentSignals, policyRevision: SAV_LEARNING_POLICY_REVISION };
}
