import "server-only";

import { asc, eq, sql } from "drizzle-orm";
import { requireMemoryDb } from "./client";
import { decryptMemory } from "./crypto";
import { validUserKey } from "./internal-auth";
import {
  copilotUsers, conversationSessions, conversationMessages, conversationSummaries,
  copilotMemories, copilotGoals, memoryTombstones, copilotRuns, memoryAuditEvents,
} from "./schema";

function decode(row: Record<string, unknown>, fields: Record<string, string>) {
  const result = { ...row };
  for (const [ciphertext, name] of Object.entries(fields)) {
    const value = result[ciphertext];
    result[name] = value === null ? null : decryptMemory(String(value));
    delete result[ciphertext];
  }
  return result;
}

/** An archive of retained records, never a prompt context or a replayable run. */
export async function exportMemory(userKey: string) {
  if (!validUserKey(userKey)) throw new Error("INVALID_MEMORY_EXPORT_IDENTITY");
  return requireMemoryDb().transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    const [user] = await tx.select().from(copilotUsers).where(eq(copilotUsers.identityKey, userKey));
    const sessions = await tx.select().from(conversationSessions).where(eq(conversationSessions.userKey, userKey)).orderBy(asc(conversationSessions.startedAt), asc(conversationSessions.id));
    const messages = await tx.select().from(conversationMessages).where(eq(conversationMessages.userKey, userKey)).orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id));
    const summaries = await tx.select().from(conversationSummaries).where(eq(conversationSummaries.userKey, userKey)).orderBy(asc(conversationSummaries.createdAt), asc(conversationSummaries.id));
    const memories = await tx.select().from(copilotMemories).where(eq(copilotMemories.userKey, userKey)).orderBy(asc(copilotMemories.createdAt), asc(copilotMemories.id));
    const goals = await tx.select().from(copilotGoals).where(eq(copilotGoals.userKey, userKey)).orderBy(asc(copilotGoals.createdAt), asc(copilotGoals.id));
    const tombstones = await tx.select().from(memoryTombstones).where(eq(memoryTombstones.userKey, userKey)).orderBy(asc(memoryTombstones.createdAt), asc(memoryTombstones.id));
    const runs = await tx.select().from(copilotRuns).where(eq(copilotRuns.userKey, userKey)).orderBy(asc(copilotRuns.createdAt), asc(copilotRuns.id));
    const auditEvents = await tx.select().from(memoryAuditEvents).where(eq(memoryAuditEvents.userKey, userKey)).orderBy(asc(memoryAuditEvents.createdAt), asc(memoryAuditEvents.id));
    return {
      schemaVersion: 2, exportedAt: new Date().toISOString(), complete: true,
      scope: "retained_legacy_memory_records", identityMapping: "unverified", replayAllowed: false,
      user: user ? decode(user, { profileCiphertext: "profile" }) : null,
      sessions: sessions.map(row => decode(row, { adkStateCiphertext: "adkState" })),
      messages: messages.map(row => decode(row, { ciphertext: "content" })),
      summaries: summaries.map(row => decode(row, { ciphertext: "content" })),
      memories: memories.map(row => decode(row, { ciphertext: "content" })),
      goals: goals.map(row => decode(row, { titleCiphertext: "title", nextStepCiphertext: "nextStep", blockerCiphertext: "blocker" })),
      tombstones,
      runs: runs.map(row => decode(row, { stateCiphertext: "state" })),
      auditEvents,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
