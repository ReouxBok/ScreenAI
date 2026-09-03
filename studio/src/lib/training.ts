import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { del } from "@vercel/blob";
import { and, asc, desc, eq, inArray, isNotNull, lt, max, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, contentItems, trainingEvents, trainingSessions } from "@/db/schema";
import { saveDraft } from "./workflow";
import { compactTrainingEvents } from "./training-events";
import { canManageTraining, normalizeStaffEmail, type StaffRole } from "./access";
import { compileLearnedActionSteps, learnedActionsMarkdown } from "./action-trace";

export const TRAINING_EVENT_KINDS = ["navigation", "click", "input", "voice_note", "page_context", "network"] as const;
export type TrainingEventKind = typeof TRAINING_EVENT_KINDS[number];
export const TRAINING_RECORDING_MAX_BYTES = 500 * 1024 * 1024;
export const TRAINING_RECORDING_MAX_DURATION_MS = 60 * 60 * 1000;
export const TRAINING_READY_RECOVERY_DELAY_MS = 10 * 60 * 1_000;
export const TRAINING_INCOMPLETE_ARCHIVE_DELAY_MS = 75 * 60 * 1_000;

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const safeText = (value: unknown, maxLength: number) => String(value ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, maxLength);
export const isTrainingRecordingConfigured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());

export async function createTraining(input: { title: string; goal: string; agentKey: string; startPath: string }, actorEmail: string) {
  const token = randomBytes(24).toString("base64url");
  const db = requireDb();
  const [session] = await db.insert(trainingSessions).values({
    title: safeText(input.title, 160),
    goal: safeText(input.goal, 1000),
    agentKey: safeText(input.agentKey, 30),
    startPath: safeText(input.startPath, 300) || "/",
    tokenHash: tokenHash(token),
    createdBy: actorEmail,
  }).returning();
  return { session, token };
}

export async function findTrainingByToken(token: string) {
  if (token.length < 24 || token.length > 100) return null;
  const db = requireDb();
  const [session] = await db.select().from(trainingSessions).where(eq(trainingSessions.tokenHash, tokenHash(token))).limit(1);
  return session ?? null;
}

export async function connectTraining(token: string) {
  const session = await findTrainingByToken(token);
  if (!session || !["draft", "recording"].includes(session.status)) return null;
  if (session.status === "recording") return session;
  const db = requireDb();
  const [connected] = await db.update(trainingSessions).set({
    status: "recording",
    recordingStatus: isTrainingRecordingConfigured() ? "awaiting" : session.recordingStatus,
    startedAt: session.startedAt ?? new Date(),
    updatedAt: new Date(),
  }).where(eq(trainingSessions.id, session.id)).returning();
  return connected;
}

export async function authorizeTrainingRecording(token: string, sessionId: string) {
  const session = await findTrainingByToken(token);
  if (!session || session.id !== sessionId || session.status !== "recording") return null;
  if (["uploading", "ready"].includes(session.recordingStatus)) return session;
  await requireDb().update(trainingSessions).set({ recordingStatus: "uploading", updatedAt: new Date() })
    .where(and(eq(trainingSessions.id, sessionId), eq(trainingSessions.status, "recording")));
  return session;
}

export async function attachTrainingRecording(input: {
  sessionId: string;
  pathname: string;
  contentType: string;
  size: number;
  durationMs: number;
}) {
  if (!input.pathname.startsWith(`training-recordings/${input.sessionId}/`)) throw new Error("INVALID_RECORDING_PATH");
  if (!/^video\/(webm|mp4)$/i.test(input.contentType)) throw new Error("INVALID_RECORDING_TYPE");
  if (!Number.isInteger(input.size) || input.size < 1 || input.size > TRAINING_RECORDING_MAX_BYTES) throw new Error("INVALID_RECORDING_SIZE");
  if (!Number.isInteger(input.durationMs) || input.durationMs < 1_000 || input.durationMs > TRAINING_RECORDING_MAX_DURATION_MS) throw new Error("INVALID_RECORDING_DURATION");
  const db = requireDb();
  const [previous] = await db.select()
    .from(trainingSessions).where(eq(trainingSessions.id, input.sessionId)).limit(1);
  if (!previous) throw new Error("TRAINING_NOT_FOUND");

  // Vercel Blob's completion callback may arrive after the extension has
  // already confirmed this exact upload and completed the session. Keep that
  // callback idempotent, without allowing a finished flow to replace its film.
  if (previous.status !== "recording") {
    if (previous.recordingPathname === input.pathname) return previous;
    throw new Error("TRAINING_NOT_RECORDING");
  }
  const [updated] = await db.update(trainingSessions).set({
    recordingStatus: "ready",
    recordingPathname: safeText(input.pathname, 700),
    recordingContentType: safeText(input.contentType, 100),
    recordingSizeBytes: input.size,
    recordingDurationMs: input.durationMs,
    recordingUploadedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(trainingSessions.id, input.sessionId), eq(trainingSessions.status, "recording"))).returning();
  if (previous.recordingPathname && previous.recordingPathname !== input.pathname) await del(previous.recordingPathname).catch(() => undefined);
  return updated;
}

export async function appendTrainingEvent(token: string, raw: { kind: string; path?: string; label?: string; payload?: Record<string, unknown> }) {
  const session = await findTrainingByToken(token);
  if (!session || session.status !== "recording" || !TRAINING_EVENT_KINDS.includes(raw.kind as TrainingEventKind)) return null;
  const payload = Object.fromEntries(Object.entries(raw.payload ?? {}).slice(0, 20).flatMap(([key, value]) => {
    if (!["string", "number", "boolean"].includes(typeof value) && value !== null) return [];
    return [[safeText(key, 60), typeof value === "string" ? safeText(value, 8000) : value]];
  })) as Record<string, string | number | boolean | null>;
  const db = requireDb();
  return db.transaction(async (tx) => {
    // Browser signals can arrive concurrently. Lock the session row so ordinal
    // allocation stays strictly sequential and no event is rejected.
    await tx.execute(sql`select ${trainingSessions.id} from ${trainingSessions} where ${trainingSessions.id} = ${session.id} for update`);
    const [{ lastOrdinal }] = await tx.select({ lastOrdinal: max(trainingEvents.ordinal) }).from(trainingEvents).where(eq(trainingEvents.sessionId, session.id));
    const [event] = await tx.insert(trainingEvents).values({ sessionId: session.id, ordinal: (lastOrdinal ?? 0) + 1, kind: raw.kind as TrainingEventKind, path: safeText(raw.path, 300) || "/", label: safeText(raw.label, 500), payload }).returning();
    await tx.update(trainingSessions).set({ updatedAt: new Date() }).where(eq(trainingSessions.id, session.id));
    return event;
  });
}

export async function completeTraining(token: string) {
  const session = await findTrainingByToken(token);
  if (!session) return null;
  // The extension can retry when Chrome suspends its MV3 service worker or
  // when the first successful response is lost. Completion is idempotent.
  if (session.status === "ready") return { session };
  if (session.status !== "recording") return null;
  if (isTrainingRecordingConfigured() && session.recordingStatus !== "ready") {
    return { error: "recording_required" as const, session };
  }
  const db = requireDb();
  const [completed] = await db.update(trainingSessions).set({ status: "ready", completedAt: new Date(), updatedAt: new Date() }).where(eq(trainingSessions.id, session.id)).returning();
  return { session: completed };
}

export async function abandonTraining(token: string) {
  const session = await findTrainingByToken(token);
  if (!session) return null;

  // A recording already uploaded is still recoverable from the Studio. Keep it
  // in that state so an accidental side-panel reload cannot discard a valid
  // film. Every other interrupted capture is archived immediately, instead of
  // leaving a permanently active "recording" session behind.
  if (session.status !== "recording") {
    return session;
  }

  if (session.recordingStatus === "ready" && session.recordingPathname) {
    return recoverUploadedTraining(session.id, "extension-recovery@limova.ai");
  }

  return requireDb().transaction(async (tx) => {
    const [archived] = await tx.update(trainingSessions).set({
      status: "archived",
      updatedAt: new Date(),
    }).where(and(
      eq(trainingSessions.id, session.id),
      eq(trainingSessions.status, "recording"),
    )).returning();
    if (!archived) return session;
    await tx.insert(auditLogs).values({
      actorEmail: "extension-recovery@limova.ai",
      action: "training_interrupted_archived",
      entityType: "training",
      entityId: archived.id,
      technicalMetadata: { reason: "extension_session_without_complete_recording", recordingStatus: session.recordingStatus },
    });
    return archived;
  });
}

export async function getTrainingReconciliationCandidates(now = new Date()) {
  const db = requireDb();
  const readyBefore = new Date(now.getTime() - TRAINING_READY_RECOVERY_DELAY_MS);
  const incompleteBefore = new Date(now.getTime() - TRAINING_INCOMPLETE_ARCHIVE_DELAY_MS);
  const [recoverable, incomplete] = await Promise.all([
    db.select().from(trainingSessions).where(and(
      eq(trainingSessions.status, "recording"),
      eq(trainingSessions.recordingStatus, "ready"),
      isNotNull(trainingSessions.recordingPathname),
      lt(trainingSessions.updatedAt, readyBefore),
    )),
    db.select().from(trainingSessions).where(and(
      eq(trainingSessions.status, "recording"),
      inArray(trainingSessions.recordingStatus, ["awaiting", "uploading"]),
      lt(trainingSessions.updatedAt, incompleteBefore),
    )),
  ]);
  return { recoverable, incomplete };
}

export async function reconcileStaleTrainings(options: {
  now?: Date;
  dryRun?: boolean;
  actorEmail?: string;
} = {}) {
  const now = options.now ?? new Date();
  const actorEmail = options.actorEmail ?? "studio-reconciler@limova.ai";
  const candidates = await getTrainingReconciliationCandidates(now);
  if (options.dryRun) return {
    dryRun: true,
    recovered: candidates.recoverable.map(({ id }) => id),
    archived: candidates.incomplete.map(({ id }) => id),
  };

  const recovered: string[] = [];
  const archived: string[] = [];
  const db = requireDb();
  for (const candidate of candidates.recoverable) {
    const recoveredId = await db.transaction(async (tx) => {
      const [updated] = await tx.update(trainingSessions).set({
        status: "ready",
        completedAt: candidate.completedAt ?? now,
        updatedAt: now,
      }).where(and(
        eq(trainingSessions.id, candidate.id),
        eq(trainingSessions.status, "recording"),
        eq(trainingSessions.recordingStatus, "ready"),
      )).returning({ id: trainingSessions.id });
      if (!updated) return null;
      await tx.insert(auditLogs).values({
        actorEmail,
        action: "training_auto_recovered",
        entityType: "training",
        entityId: updated.id,
        technicalMetadata: { reason: "recording_ready_over_10_minutes" },
      });
      return updated.id;
    });
    if (recoveredId) recovered.push(recoveredId);
  }
  for (const candidate of candidates.incomplete) {
    const archivedId = await db.transaction(async (tx) => {
      const [updated] = await tx.update(trainingSessions).set({
        status: "archived",
        updatedAt: now,
      }).where(and(
        eq(trainingSessions.id, candidate.id),
        eq(trainingSessions.status, "recording"),
        inArray(trainingSessions.recordingStatus, ["awaiting", "uploading"]),
      )).returning({ id: trainingSessions.id });
      if (!updated) return null;
      await tx.insert(auditLogs).values({
        actorEmail,
        action: "training_auto_archived",
        entityType: "training",
        entityId: updated.id,
        technicalMetadata: { reason: "recording_incomplete_over_75_minutes", recordingStatus: candidate.recordingStatus },
      });
      return updated.id;
    });
    if (archivedId) archived.push(archivedId);
  }
  return { dryRun: false, recovered, archived };
}

export async function recoverUploadedTraining(id: string, actorEmail: string) {
  const db = requireDb();
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(trainingSessions)
      .where(eq(trainingSessions.id, id)).limit(1);
    if (!session) throw new Error("TRAINING_NOT_FOUND");
    if (session.status === "ready") return session;
    if (session.status !== "recording" || session.recordingStatus !== "ready" || !session.recordingPathname) {
      throw new Error("TRAINING_NOT_RECOVERABLE");
    }
    const [recovered] = await tx.update(trainingSessions).set({
      status: "ready",
      completedAt: session.completedAt ?? new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(trainingSessions.id, id),
      eq(trainingSessions.status, "recording"),
    )).returning();
    if (!recovered) throw new Error("TRAINING_RECOVERY_CONFLICT");
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "training_recovered",
      entityType: "training",
      entityId: id,
      technicalMetadata: { recordingStatus: session.recordingStatus },
    });
    return recovered;
  });
}

export async function listTrainings() {
  return requireDb().select().from(trainingSessions).orderBy(desc(trainingSessions.updatedAt));
}

export async function listTrainingSummaries(actor?: { email: string; role: StaffRole }) {
  const query = requireDb().select({
    session: trainingSessions,
    contentStatus: contentItems.status,
  }).from(trainingSessions)
    .leftJoin(contentItems, eq(trainingSessions.contentItemId, contentItems.id));
  return actor && actor.role === "member"
    ? query.where(eq(trainingSessions.createdBy, normalizeStaffEmail(actor.email))).orderBy(desc(trainingSessions.createdAt))
    : query.orderBy(desc(trainingSessions.createdAt));
}

export async function getTraining(id: string) {
  const db = requireDb();
  const [session] = await db.select().from(trainingSessions).where(eq(trainingSessions.id, id)).limit(1);
  if (!session) return null;
  const events = await db.select().from(trainingEvents).where(eq(trainingEvents.sessionId, id)).orderBy(asc(trainingEvents.ordinal));
  return { session, events };
}

export async function getManageableTraining(id: string, actor: { email: string; role: StaffRole }) {
  const detail = await getTraining(id);
  if (!detail || !canManageTraining(actor.role, actor.email, detail.session.createdBy)) return null;
  return detail;
}

export async function assertManageableTraining(id: string, actor: { email: string; role: StaffRole }) {
  const detail = await getManageableTraining(id, actor);
  if (!detail) throw new Error("TRAINING_NOT_FOUND");
  return detail;
}

export async function getTrainingByContentItemId(contentItemId: string) {
  const [session] = await requireDb().select().from(trainingSessions)
    .where(eq(trainingSessions.contentItemId, contentItemId)).orderBy(desc(trainingSessions.updatedAt)).limit(1);
  return session ?? null;
}

export async function restartTraining(id: string, actorEmail: string) {
  const detail = await getTraining(id);
  if (!detail) throw new Error("TRAINING_NOT_FOUND");

  const result = await createTraining({
    title: detail.session.title,
    goal: detail.session.goal,
    agentKey: detail.session.agentKey,
    startPath: detail.session.startPath,
  }, actorEmail);

  const db = requireDb();
  await db.transaction(async (tx) => {
    // An unfinished token must stop working when a new attempt replaces it.
    if (["draft", "recording"].includes(detail.session.status)) {
      await tx.update(trainingSessions).set({ status: "archived", updatedAt: new Date() }).where(eq(trainingSessions.id, id));
    }
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "training_restarted",
      entityType: "training",
      entityId: result.session.id,
      technicalMetadata: { sourceSessionId: id },
    });
  });

  return result;
}

export async function updateTraining(
  id: string,
  input: { title: string; goal: string; agentKey: string; startPath: string },
  actorEmail: string,
) {
  const title = safeText(input.title, 160);
  const goal = safeText(input.goal, 1000);
  const agentKey = safeText(input.agentKey, 30).toLowerCase();
  const startPath = safeText(input.startPath, 300) || "/";
  if (!title || !goal) throw new Error("INVALID_TRAINING_CONTENT");
  if (!/^[a-z0-9-]{2,30}$/.test(agentKey)) throw new Error("INVALID_TRAINING_AGENT");
  if (!/^\/(?!\/)/.test(startPath)) throw new Error("INVALID_TRAINING_PATH");

  const db = requireDb();
  return db.transaction(async (tx) => {
    const [previous] = await tx.select().from(trainingSessions)
      .where(eq(trainingSessions.id, id)).limit(1);
    if (!previous) throw new Error("TRAINING_NOT_FOUND");
    if (previous.status === "recording") throw new Error("TRAINING_RECORDING_ACTIVE");

    const [updated] = await tx.update(trainingSessions).set({
      title,
      goal,
      agentKey,
      startPath,
      updatedAt: new Date(),
    }).where(eq(trainingSessions.id, id)).returning();
    const changedFields = (["title", "goal", "agentKey", "startPath"] as const)
      .filter((field) => previous[field] !== updated[field]);
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "training_updated",
      entityType: "training",
      entityId: id,
      technicalMetadata: { changedFields: changedFields.join(",") || "none" },
    });
    return updated;
  });
}

export async function deleteTraining(id: string, actorEmail: string) {
  const db = requireDb();
  const session = await db.transaction(async (tx) => {
    const [selected] = await tx.select({
      id: trainingSessions.id,
      contentItemId: trainingSessions.contentItemId,
      recordingPathname: trainingSessions.recordingPathname,
    })
      .from(trainingSessions)
      .where(eq(trainingSessions.id, id))
      .limit(1);
    if (!selected) throw new Error("TRAINING_NOT_FOUND");

    await tx.insert(auditLogs).values({
      actorEmail,
      action: "training_deleted",
      entityType: "training",
      entityId: id,
      technicalMetadata: { contentItemPreserved: Boolean(selected.contentItemId) },
    });
    await tx.delete(trainingSessions).where(eq(trainingSessions.id, id));
    return selected;
  });
  // Blob cleanup must never prevent the Studio record from being deleted.
  if (session.recordingPathname && isTrainingRecordingConfigured()) {
    await del(session.recordingPathname).catch((error) => {
      console.error("training_recording_cleanup_failed", {
        sessionId: session.id,
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
    });
  }
  return session;
}

function slugify(value: string, suffix: string) {
  const base = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "parcours";
  return `${base}-${suffix.slice(0, 6)}`;
}

export async function convertTrainingToContent(id: string, actorEmail: string) {
  const detail = await getTraining(id);
  if (!detail || detail.session.status !== "ready") throw new Error("TRAINING_NOT_READY");
  const normalizedActorEmail = normalizeStaffEmail(actorEmail);
  const steps = compactTrainingEvents(detail.events);
  const actionSteps = compileLearnedActionSteps(detail.events);
  const technicalTrace = learnedActionsMarkdown(actionSteps);
  const body = ["## Objectif", "", detail.session.goal, "", "## Démonstration", "", ...steps.map((event, index) => {
    if (event.kind === "voice_note") return `${index + 1}. Explication : ${event.label}`;
    if (event.kind === "page_context") return `${index + 1}. ${event.label}`;
    if (event.kind === "click") {
      const targetType = typeof event.payload.controlType === "string" ? ` (${event.payload.controlType})` : "";
      return `${index + 1}. Cliquez sur « ${event.label || "le contrôle indiqué"} »${targetType} — \`${event.path}\``;
    }
    return `${index + 1}. ${event.label || event.kind} — \`${event.path}\``;
  }), ...(technicalTrace ? ["", technicalTrace] : [])].join("\n");
  const result = await saveDraft({
    type: "onboarding",
    slug: slugify(detail.session.title, detail.session.id),
    locale: "fr-FR",
    title: detail.session.title,
    summary: detail.session.goal.slice(0, 900),
    categorySlug: "bien-demarrer",
    visibility: "charly_only",
    agentKey: detail.session.agentKey,
    ownerEmail: normalizedActorEmail,
    bodyMarkdown: body,
    changeNote: "Créé depuis une démonstration enregistrée",
    metadata: {
      objective: detail.session.goal.slice(0, 500),
      proposalSignals: [detail.session.title, detail.session.goal.slice(0, 300)],
      qualificationQuestions: [],
      expectedPages: [...new Set([
        ...steps.map((event) => event.path),
        ...actionSteps.flatMap((step) => [step.path, step.expected.path].filter((path): path is string => Boolean(path))),
      ])].slice(0, 50),
      successCriteria: ["Le parcours démontré est terminé"],
      branches: [],
      fallbacks: ["Demander une précision au membre Limova"],
      actionSteps,
    },
  }, normalizedActorEmail);
  await requireDb().update(trainingSessions).set({ status: "converted", contentItemId: result.item.id, updatedAt: new Date() }).where(eq(trainingSessions.id, id));
  return result.item.id;
}
