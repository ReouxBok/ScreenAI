import "server-only";

import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { deterministicEmbedding, embedTexts } from "@/lib/embeddings";
import { requireMemoryDb } from "./client";
import { decryptMemory, encryptMemory, memoryFingerprint } from "./crypto";
import { analyzeTurn, summarizeEpisode } from "./intelligence";
import { containsSensitiveMemory, deterministicCandidates, isForgetCommand, sanitizeMemoryCandidate, type MemoryCandidate } from "./policy";
import {
  conversationMessages,
  conversationSessions,
  conversationSummaries,
  copilotGoals,
  copilotMemories,
  copilotRuns,
  copilotUsers,
  memoryAuditEvents,
  memoryTombstones,
} from "./schema";

const SESSION_GAP_MS = 8 * 60 * 60_000;
const MESSAGE_RETENTION_MS = 365 * 24 * 60 * 60_000;

export const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  limovaUserId: z.string().trim().min(1).max(200).optional(),
  locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
}).strict();

type StoredProfile = z.infer<typeof profileSchema>;
type DecryptedMessage = { id: string; role: "user" | "assistant"; source: "text" | "voice"; content: string; createdAt: string };

async function embeddingFor(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY") {
  try {
    const [embedding] = await embedTexts([text], taskType);
    return embedding;
  } catch {
    return deterministicEmbedding(text);
  }
}

async function ensureUser(userKey: string) {
  const db = requireMemoryDb();
  const [user] = await db.insert(copilotUsers).values({ identityKey: userKey })
    .onConflictDoUpdate({ target: copilotUsers.identityKey, set: { lastSeenAt: new Date(), updatedAt: new Date() } })
    .returning();
  return user;
}

async function activeSession(userKey: string, requestedSessionId?: string) {
  const db = requireMemoryDb();
  if (requestedSessionId) {
    const [requested] = await db.select().from(conversationSessions)
      .where(and(
        eq(conversationSessions.id, requestedSessionId),
        eq(conversationSessions.userKey, userKey),
        eq(conversationSessions.status, "active"),
    )).limit(1);
    if (requested) return requested;
    // The extension can briefly retain a session id that has just expired or
    // been closed by another device. Recover with the active session (or a new
    // one) instead of making memory unavailable for the whole turn.
  }
  const cutoff = new Date(Date.now() - SESSION_GAP_MS);
  const [session] = await db.select().from(conversationSessions)
    .where(and(eq(conversationSessions.userKey, userKey), eq(conversationSessions.status, "active"), gt(conversationSessions.lastMessageAt, cutoff)))
    .orderBy(desc(conversationSessions.lastMessageAt)).limit(1);
  if (session) return session;
  await db.update(conversationSessions).set({ status: "closed", closedAt: new Date() })
    .where(and(eq(conversationSessions.userKey, userKey), eq(conversationSessions.status, "active")));
  const [created] = await db.insert(conversationSessions).values({ userKey }).returning();
  return created;
}

type ExplicitSessionInput = {
  sessionId?: string;
  previousSessionId?: string;
  closePrevious?: boolean;
  promptRevision?: string;
  initialState?: Record<string, unknown>;
};

function safeAdkState(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  if (typeof input.onboardingRevision === "string") output.onboardingRevision = input.onboardingRevision.slice(0, 160);
  if (typeof input.onboardingStep === "string") output.onboardingStep = input.onboardingStep.slice(0, 160);
  if (Array.isArray(input.completedOnboardingSteps)) {
    output.completedOnboardingSteps = input.completedOnboardingSteps
      .filter((item): item is string => typeof item === "string")
      .slice(0, 100)
      .map((item) => item.slice(0, 160));
  }
  return output;
}

export async function openExplicitSession(userKey: string, input: ExplicitSessionInput = {}) {
  await ensureUser(userKey);
  const db = requireMemoryDb();
  if (input.closePrevious) {
    await db.update(conversationSessions).set({
      status: "closed",
      closedAt: new Date(),
      closedReason: "new_chat",
    }).where(and(
      eq(conversationSessions.userKey, userKey),
      eq(conversationSessions.status, "active"),
      ...(input.previousSessionId ? [eq(conversationSessions.id, input.previousSessionId)] : []),
    ));
  }
  if (input.sessionId && !input.closePrevious) {
    const [existing] = await db.select().from(conversationSessions).where(and(
      eq(conversationSessions.id, input.sessionId),
      eq(conversationSessions.userKey, userKey),
      eq(conversationSessions.status, "active"),
    )).limit(1);
    if (existing) return existing;
  }
  if (!input.closePrevious && !input.sessionId) {
    const cutoff = new Date(Date.now() - SESSION_GAP_MS);
    const [existing] = await db.select().from(conversationSessions).where(and(
      eq(conversationSessions.userKey, userKey),
      eq(conversationSessions.status, "active"),
      gt(conversationSessions.lastMessageAt, cutoff),
    )).orderBy(desc(conversationSessions.lastMessageAt)).limit(1);
    if (existing) return existing;
  }
  const [created] = await db.insert(conversationSessions).values({
    userKey,
    ...(input.sessionId ? { id: input.sessionId } : {}),
    promptRevision: input.promptRevision?.slice(0, 160),
    adkStateCiphertext: encryptMemory(safeAdkState(input.initialState)),
  }).returning();
  return created;
}

export async function getExplicitSession(userKey: string, sessionId: string) {
  const [session] = await requireMemoryDb().select().from(conversationSessions).where(and(
    eq(conversationSessions.id, sessionId),
    eq(conversationSessions.userKey, userKey),
  )).limit(1);
  if (!session) return null;
  let state: Record<string, unknown> = {};
  if (session.adkStateCiphertext) {
    try { state = decryptMemory<Record<string, unknown>>(session.adkStateCiphertext); } catch { state = {}; }
  }
  return {
    id: session.id,
    status: session.status,
    state,
    promptRevision: session.promptRevision,
    sessionRevision: session.sessionRevision,
    lastUpdateTime: session.lastMessageAt.getTime(),
    messages: await recentMessages(userKey, session.id, 60),
  };
}

export async function updateExplicitSessionState(userKey: string, sessionId: string, rawState: unknown) {
  const state = safeAdkState(rawState);
  const [updated] = await requireMemoryDb().update(conversationSessions).set({
    adkStateCiphertext: encryptMemory(state),
    sessionRevision: sql`${conversationSessions.sessionRevision} + 1`,
    lastMessageAt: new Date(),
  }).where(and(eq(conversationSessions.id, sessionId), eq(conversationSessions.userKey, userKey)))
    .returning({ sessionRevision: conversationSessions.sessionRevision });
  if (!updated) throw new Error("SESSION_NOT_FOUND");
  return { ok: true, sessionRevision: updated.sessionRevision };
}

export async function closeExplicitSession(userKey: string, sessionId: string, reason = "user_closed") {
  await requireMemoryDb().update(conversationSessions).set({
    status: "closed",
    closedAt: new Date(),
    closedReason: reason.slice(0, 80),
  }).where(and(eq(conversationSessions.id, sessionId), eq(conversationSessions.userKey, userKey)));
  return { ok: true };
}

async function recentMessages(userKey: string, sessionId: string, limit = 24): Promise<DecryptedMessage[]> {
  const rows = await requireMemoryDb().select().from(conversationMessages)
    .where(and(eq(conversationMessages.userKey, userKey), eq(conversationMessages.sessionId, sessionId)))
    .orderBy(desc(conversationMessages.createdAt)).limit(Math.max(1, Math.min(60, limit)));
  return rows.reverse().flatMap((row) => {
    try {
      const value = decryptMemory<{ content: string }>(row.ciphertext);
      return [{ id: row.id, role: row.role === "assistant" ? "assistant" as const : "user" as const, source: row.source === "voice" ? "voice" as const : "text" as const, content: value.content, createdAt: row.createdAt.toISOString() }];
    } catch {
      return [];
    }
  });
}

async function latestSummary(userKey: string, sessionId: string) {
  const [row] = await requireMemoryDb().select().from(conversationSummaries)
    .where(and(eq(conversationSummaries.userKey, userKey), eq(conversationSummaries.sessionId, sessionId)))
    .orderBy(desc(conversationSummaries.version)).limit(1);
  if (!row) return { text: "", version: 0 };
  try {
    return { text: decryptMemory<{ text: string }>(row.ciphertext).text, version: row.version };
  } catch {
    return { text: "", version: row.version };
  }
}

async function relevantMemories(userKey: string, query: string, limit = 8) {
  const vector = await embeddingFor(query || "onboarding Limova", "RETRIEVAL_QUERY");
  const vectorLiteral = `[${vector.join(",")}]`;
  const result = await requireMemoryDb().execute(sql`
    SELECT id, type, ciphertext, confidence, importance
    FROM charly_memory.copilot_memories
    WHERE user_key = ${userKey}
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY ((1 - (embedding <=> ${vectorLiteral}::vector)) * 0.62
      + (confidence::float / 1000) * 0.18
      + (importance::float / 1000) * 0.12
      + GREATEST(0, 1 - EXTRACT(EPOCH FROM (now() - last_used_at)) / 31536000) * 0.08) DESC
    LIMIT ${Math.max(1, Math.min(10, limit))}
  `);
  const rows = Array.isArray(result) ? result : (result as unknown as { rows: Record<string, unknown>[] }).rows;
  const parsed = rows.flatMap((row: Record<string, unknown>) => {
    try {
      return [{ id: String(row.id), type: String(row.type), statement: decryptMemory<{ statement: string }>(String(row.ciphertext)).statement, confidence: Number(row.confidence) / 1000 }];
    } catch {
      return [];
    }
  });
  if (parsed.length) await requireMemoryDb().update(copilotMemories).set({ lastUsedAt: new Date() }).where(and(eq(copilotMemories.userKey, userKey), inArray(copilotMemories.id, parsed.map((item) => item.id))));
  return parsed;
}

async function openGoals(userKey: string) {
  const rows = await requireMemoryDb().select().from(copilotGoals)
    .where(and(eq(copilotGoals.userKey, userKey), eq(copilotGoals.status, "open")))
    .orderBy(desc(copilotGoals.lastProgressAt)).limit(5);
  return rows.flatMap((row) => {
    try {
      return [{ id: row.id, title: decryptMemory<{ text: string }>(row.titleCiphertext).text, nextStep: row.nextStepCiphertext ? decryptMemory<{ text: string }>(row.nextStepCiphertext).text : null, confidence: row.confidence / 1000 }];
    } catch {
      return [];
    }
  });
}

function returnGreeting(profile: StoredProfile | null, goals: Awaited<ReturnType<typeof openGoals>>, lastSeenAt: Date) {
  const elapsed = Date.now() - lastSeenAt.getTime();
  if (elapsed < SESSION_GAP_MS || !goals[0]) return null;
  const name = profile?.firstName ? ` ${profile.firstName}` : "";
  if (elapsed <= 7 * 24 * 60 * 60_000) return `Bonjour${name}. La dernière fois, nous avancions sur « ${goals[0].title} ». Tu as pu progresser ?`;
  return `Bonjour${name}. Est-ce que l’objectif « ${goals[0].title} » est toujours d’actualité ?`;
}

async function continuityCapsule(userKey: string, currentSessionId: string) {
  const [previous] = await requireMemoryDb().select().from(conversationSessions)
    .where(and(
      eq(conversationSessions.userKey, userKey),
      sql`${conversationSessions.id} <> ${currentSessionId}`,
    ))
    .orderBy(desc(conversationSessions.lastMessageAt)).limit(1);
  if (!previous) return { text: "", messages: [] as DecryptedMessage[] };
  const messages = await recentMessages(userKey, previous.id, 4);
  const [decision] = await requireMemoryDb().select().from(copilotMemories)
    .where(and(
      eq(copilotMemories.userKey, userKey),
      eq(copilotMemories.type, "decision"),
      eq(copilotMemories.status, "active"),
    )).orderBy(desc(copilotMemories.updatedAt)).limit(1);
  let decisionText = "";
  if (decision) {
    try { decisionText = decryptMemory<{ statement: string }>(decision.ciphertext).statement; } catch { decisionText = ""; }
  }
  const parts = [
    decisionText ? `Dernière décision: ${decisionText}` : "",
    messages.length ? `Derniers échanges utiles:\n${messages.map((message) => `${message.role === "assistant" ? "Charly" : "Utilisateur"}: ${message.content}`).join("\n")}` : "",
  ].filter(Boolean);
  return { text: parts.join("\n").slice(0, 6_000), messages };
}

export async function bootstrapMemory(userKey: string, query = "", sessionId?: string) {
  const [previousUser] = await requireMemoryDb().select().from(copilotUsers).where(eq(copilotUsers.identityKey, userKey)).limit(1);
  const user = await ensureUser(userKey);
  if (!user.memoryEnabled) return { enabled: false, revision: `memory_${user.updatedAt.getTime()}`, profile: null, recentMessages: [], goals: [], memories: [], summary: "", greeting: null, context: "" };
  const session = sessionId
    ? await activeSession(userKey, sessionId)
    : await activeSession(userKey);
  const [messages, summary, memories, goals, continuity] = await Promise.all([
    recentMessages(userKey, session.id, 24), latestSummary(userKey, session.id), relevantMemories(userKey, query, 8), openGoals(userKey),
    continuityCapsule(userKey, session.id),
  ]);
  let profile: StoredProfile | null = null;
  if (user.profileCiphertext) {
    try { profile = decryptMemory<StoredProfile>(user.profileCiphertext); } catch { profile = null; }
  }
  const contextParts = [
    profile ? `PROFIL CONFIRMÉ\n${JSON.stringify(profile)}` : "",
    goals.length ? `OBJECTIFS OUVERTS\n${goals.map((goal) => `- ${goal.title}${goal.nextStep ? ` — prochaine étape: ${goal.nextStep}` : ""}`).join("\n")}` : "",
    memories.length ? `SOUVENIRS PERTINENTS\n${memories.map((memory) => `- ${memory.statement}`).join("\n")}` : "",
    summary.text ? `RÉSUMÉ DE L’ÉPISODE\n${summary.text}` : "",
    messages.length ? `MESSAGES RÉCENTS DE L’ÉPISODE COURANT\n${messages.slice(-12).map((message) => `${message.role === "assistant" ? "Charly" : "Utilisateur"}: ${message.content}`).join("\n")}` : "",
    continuity.text ? `CAPSULE DE CONTINUITÉ INTER-SESSION\n${continuity.text}` : "",
  ].filter(Boolean);
  return {
    enabled: true,
    sessionId: session.id,
    sessionRevision: `session_${session.id}_${session.sessionRevision}`,
    revision: `memory_${user.updatedAt.getTime()}_${summary.version}`,
    profile,
    recentMessages: messages,
    goals,
    memories,
    summary: summary.text,
    greeting: returnGreeting(profile, goals, previousUser?.lastSeenAt ?? user.createdAt),
    continuity: continuity.text,
    context: contextParts.join("\n\n").slice(0, 18_000),
  };
}

export async function upsertProfile(userKey: string, rawProfile: unknown) {
  const profile = profileSchema.parse(rawProfile);
  if (Object.values(profile).some((value) => typeof value === "string" && containsSensitiveMemory(value))) throw new Error("PROFILE_REJECTED");
  await ensureUser(userKey);
  await requireMemoryDb().update(copilotUsers).set({
    profileCiphertext: encryptMemory(profile), locale: profile.locale ?? "fr-FR", timezone: profile.timezone, updatedAt: new Date(), lastSeenAt: new Date(),
  }).where(eq(copilotUsers.identityKey, userKey));
  return { ok: true };
}

export async function setMemoryPreference(userKey: string, enabled: boolean) {
  await ensureUser(userKey);
  await requireMemoryDb().update(copilotUsers).set({ memoryEnabled: enabled, updatedAt: new Date() }).where(eq(copilotUsers.identityKey, userKey));
  return { ok: true, enabled };
}

export async function storeTurn(userKey: string, input: {
  user?: string;
  assistant?: string;
  source: "text" | "voice";
  idempotencyKey: string;
  sessionId?: string;
  adkEventId?: string;
  invocationId?: string;
  finalStatus?: "completed" | "failed" | "interrupted";
}) {
  const user = await ensureUser(userKey);
  if (!user.memoryEnabled) return { ok: true, stored: 0, disabled: true };
  const session = input.sessionId
    ? await activeSession(userKey, input.sessionId)
    : await activeSession(userKey);
  const messages = [
    input.user ? { role: "user", content: input.user } : null,
    input.assistant ? { role: "assistant", content: input.assistant } : null,
  ].filter(Boolean) as Array<{ role: "user" | "assistant"; content: string }>;
  let stored = 0;
  let lastMessageId: string | null = null;
  let userMessageId: string | null = null;
  for (const [index, message] of messages.entries()) {
    const content = message.content.trim().slice(0, 8_000);
    if (!content) continue;
    const [row] = await requireMemoryDb().insert(conversationMessages).values({
      userKey, sessionId: session.id, role: message.role, source: input.source, ciphertext: encryptMemory({ content }), characterCount: content.length,
      idempotencyKey: `${input.idempotencyKey}:${index}`.slice(0, 200),
      adkEventId: input.adkEventId?.slice(0, 200),
      invocationId: input.invocationId?.slice(0, 200),
      finalStatus: input.finalStatus ?? "completed",
    }).onConflictDoNothing().returning({ id: conversationMessages.id });
    if (row) {
      stored += 1;
      lastMessageId = row.id;
      if (message.role === "user") userMessageId = row.id;
    }
  }
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (stored) await requireMemoryDb().update(conversationSessions).set({
    messageCount: sql`${conversationSessions.messageCount} + ${stored}`,
    charactersSinceSummary: sql`${conversationSessions.charactersSinceSummary} + ${chars}`,
    lastMessageAt: new Date(),
  }).where(eq(conversationSessions.id, session.id));
  return { ok: true, stored, sessionId: session.id, lastMessageId, userMessageId };
}

async function upsertMemoryCandidate(userKey: string, rawCandidate: MemoryCandidate, sourceMessageId?: string | null) {
  const candidate = sanitizeMemoryCandidate(rawCandidate);
  if (!candidate) return false;
  const fingerprint = memoryFingerprint(candidate.statement);
  const [tombstone] = await requireMemoryDb().select({ id: memoryTombstones.id }).from(memoryTombstones)
    .where(and(eq(memoryTombstones.userKey, userKey), eq(memoryTombstones.fingerprint, fingerprint), or(isNull(memoryTombstones.expiresAt), gt(memoryTombstones.expiresAt, new Date())))).limit(1);
  if (tombstone) return false;
  const embedding = await embeddingFor(candidate.statement, "RETRIEVAL_DOCUMENT");
  await requireMemoryDb().insert(copilotMemories).values({
    userKey, type: candidate.type, ciphertext: encryptMemory({ statement: candidate.statement }), fingerprint,
    confidence: Math.round(candidate.confidence * 1000), importance: Math.round(candidate.importance * 1000), embedding,
    sourceMessageId: sourceMessageId || undefined, expiresAt: candidate.expiresAt ? new Date(candidate.expiresAt) : undefined,
  }).onConflictDoUpdate({ target: [copilotMemories.userKey, copilotMemories.fingerprint], set: {
    ciphertext: encryptMemory({ statement: candidate.statement }), confidence: Math.round(candidate.confidence * 1000), importance: Math.round(candidate.importance * 1000), embedding, status: "active", updatedAt: new Date(),
  } });
  return true;
}

export async function storeDeterministicMemories(userKey: string, text: string, sourceMessageId?: string | null) {
  let stored = 0;
  for (const candidate of deterministicCandidates(text)) {
    if (await upsertMemoryCandidate(userKey, candidate, sourceMessageId)) stored += 1;
  }
  return { stored };
}

export async function enrichStoredTurn(userKey: string, input: { user?: string; assistant?: string; sessionId: string; sourceMessageId?: string | null }) {
  if (!input.user) return;
  if (isForgetCommand(input.user)) {
    await forgetMemory(userKey, input.user);
    return;
  }
  const intelligence = await analyzeTurn(input.user, input.assistant ?? "");
  for (const rawCandidate of intelligence.memories) {
    await upsertMemoryCandidate(userKey, rawCandidate, input.sourceMessageId);
  }
  for (const goal of intelligence.goals) {
    const title = goal.title.trim().slice(0, 300);
    if (!title || containsSensitiveMemory(title)) continue;
    const fingerprint = memoryFingerprint(title);
    await requireMemoryDb().insert(copilotGoals).values({
      userKey, titleCiphertext: encryptMemory({ text: title }), nextStepCiphertext: goal.nextStep ? encryptMemory({ text: goal.nextStep }) : undefined,
      fingerprint, status: goal.status, confidence: Math.round(goal.confidence * 1000),
    }).onConflictDoUpdate({ target: [copilotGoals.userKey, copilotGoals.fingerprint], set: {
      titleCiphertext: encryptMemory({ text: title }), nextStepCiphertext: goal.nextStep ? encryptMemory({ text: goal.nextStep }) : null,
      status: goal.status, confidence: Math.round(goal.confidence * 1000), lastProgressAt: new Date(), updatedAt: new Date(),
    } });
  }
  await compactIfNeeded(userKey, input.sessionId);
}

export async function compactIfNeeded(userKey: string, sessionId: string) {
  const [session] = await requireMemoryDb().select().from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1);
  if (!session || (session.messageCount < 30 && session.charactersSinceSummary < 50_000)) return;
  const messages = await recentMessages(userKey, sessionId, 60);
  const previous = await latestSummary(userKey, sessionId);
  const text = await summarizeEpisode(previous.text, messages.map((message) => ({ role: message.role, content: message.content })));
  const lastMessage = messages.at(-1);
  await requireMemoryDb().insert(conversationSummaries).values({
    userKey, sessionId, version: previous.version + 1, ciphertext: encryptMemory({ text }), throughMessageId: lastMessage?.id,
  }).onConflictDoNothing();
  await requireMemoryDb().update(conversationSessions).set({ messageCount: 0, charactersSinceSummary: 0 }).where(eq(conversationSessions.id, sessionId));
}

export async function forgetMemory(userKey: string, query: string) {
  await ensureUser(userKey);
  const goalsOnly = /ce n['’]est plus mon objectif|plus mon objectif/i.test(query);
  if (goalsOnly) {
    const [goal] = await requireMemoryDb().select().from(copilotGoals).where(and(eq(copilotGoals.userKey, userKey), eq(copilotGoals.status, "open"))).orderBy(desc(copilotGoals.lastProgressAt)).limit(1);
    if (goal) await requireMemoryDb().update(copilotGoals).set({ status: "abandoned", updatedAt: new Date() }).where(eq(copilotGoals.id, goal.id));
    return { ok: true, forgotten: goal ? 1 : 0 };
  }
  const [memory] = await relevantMemories(userKey, query.replace(/oublie|forget|olvida/gi, " "), 1);
  if (!memory) return { ok: true, forgotten: 0 };
  const [row] = await requireMemoryDb().select().from(copilotMemories).where(eq(copilotMemories.id, memory.id)).limit(1);
  if (!row) return { ok: true, forgotten: 0 };
  await requireMemoryDb().transaction(async (tx) => {
    await tx.update(copilotMemories).set({ status: "forgotten", updatedAt: new Date() }).where(eq(copilotMemories.id, row.id));
    await tx.insert(memoryTombstones).values({ userKey, fingerprint: row.fingerprint }).onConflictDoNothing();
    await tx.insert(memoryAuditEvents).values({ userKey, action: "forgotten", entityType: "memory", entityId: row.id });
  });
  return { ok: true, forgotten: 1 };
}

export async function exportMemory(userKey: string) {
  const context = await bootstrapMemory(userKey, "profil projets préférences décisions");
  return { exportedAt: new Date().toISOString(), profile: context.profile, goals: context.goals, memories: context.memories, recentMessages: context.recentMessages, summary: context.summary };
}

export async function deleteAllMemory(userKey: string) {
  await requireMemoryDb().delete(copilotUsers).where(eq(copilotUsers.identityKey, userKey));
  return { ok: true };
}

type RunMetadataInput = {
  runId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  contextVersion: number;
  actionCount: number;
  recoveryCount?: number;
  promptRevision?: string;
};

export async function createCopilotRun(userKey: string, input: RunMetadataInput) {
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const [run] = await requireMemoryDb().insert(copilotRuns).values({
    id: input.runId,
    userKey,
    sessionId: input.sessionId,
    callId: input.callId.slice(0, 200),
    toolName: input.toolName.slice(0, 100),
    contextVersion: Math.max(0, Math.trunc(input.contextVersion)),
    actionCount: Math.max(0, Math.min(6, Math.trunc(input.actionCount))),
    recoveryCount: Math.max(0, Math.min(1, Math.trunc(input.recoveryCount ?? 0))),
    promptRevision: input.promptRevision?.slice(0, 160),
    stateCiphertext: encryptMemory({ awaitingClientResult: true }),
    expiresAt,
  }).returning({ id: copilotRuns.id, expiresAt: copilotRuns.expiresAt });
  return { ok: true, runId: run.id, expiresAt: run.expiresAt.toISOString() };
}

export async function completeCopilotRun(userKey: string, runId: string, status: "completed" | "failed" | "interrupted", errorCode?: string) {
  await requireMemoryDb().update(copilotRuns).set({
    status,
    errorCode: errorCode?.slice(0, 100),
  }).where(and(eq(copilotRuns.id, runId), eq(copilotRuns.userKey, userKey)));
  return { ok: true };
}

export async function getCopilotRun(userKey: string, runId: string) {
  const [run] = await requireMemoryDb().select({
    id: copilotRuns.id,
    sessionId: copilotRuns.sessionId,
    callId: copilotRuns.callId,
    toolName: copilotRuns.toolName,
    contextVersion: copilotRuns.contextVersion,
    actionCount: copilotRuns.actionCount,
    recoveryCount: copilotRuns.recoveryCount,
    status: copilotRuns.status,
    expiresAt: copilotRuns.expiresAt,
  }).from(copilotRuns).where(and(eq(copilotRuns.id, runId), eq(copilotRuns.userKey, userKey))).limit(1);
  if (!run || run.expiresAt <= new Date()) return null;
  return { ...run, expiresAt: run.expiresAt.toISOString() };
}

export async function getActiveCopilotRun(userKey: string, sessionId: string) {
  const [run] = await requireMemoryDb().select({
    id: copilotRuns.id,
    callId: copilotRuns.callId,
    toolName: copilotRuns.toolName,
    status: copilotRuns.status,
    expiresAt: copilotRuns.expiresAt,
  }).from(copilotRuns).where(and(
    eq(copilotRuns.userKey, userKey),
    eq(copilotRuns.sessionId, sessionId),
    eq(copilotRuns.status, "active"),
    gt(copilotRuns.expiresAt, new Date()),
  )).orderBy(desc(copilotRuns.createdAt)).limit(1);
  return run ? { ...run, expiresAt: run.expiresAt.toISOString() } : null;
}

export async function purgeExpiredMemory() {
  const cutoff = new Date(Date.now() - MESSAGE_RETENTION_MS);
  const now = new Date();
  const db = requireMemoryDb();
  await db.delete(conversationMessages).where(lt(conversationMessages.createdAt, cutoff));
  await db.delete(conversationSummaries).where(lt(conversationSummaries.createdAt, cutoff));
  await db.delete(copilotGoals).where(lt(copilotGoals.lastProgressAt, cutoff));
  await db.delete(copilotMemories).where(or(
    and(lt(copilotMemories.expiresAt, now), sql`${copilotMemories.expiresAt} IS NOT NULL`),
    lt(copilotMemories.lastUsedAt, cutoff),
  ));
  await db.delete(copilotRuns).where(lt(copilotRuns.expiresAt, now));
  await db.delete(memoryTombstones).where(and(lt(memoryTombstones.expiresAt, now), sql`${memoryTombstones.expiresAt} IS NOT NULL`));
  return { ok: true, cutoff: cutoff.toISOString() };
}
