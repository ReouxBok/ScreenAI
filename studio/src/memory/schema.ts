import {
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const charlyMemory = pgSchema("charly_memory");

export const copilotUsers = charlyMemory.table("copilot_users", {
  identityKey: text("identity_key").primaryKey(),
  profileCiphertext: text("profile_ciphertext"),
  locale: text("locale").notNull().default("fr-FR"),
  timezone: text("timezone"),
  memoryEnabled: boolean("memory_enabled").notNull().default(true),
  profilePromptedAt: timestamp("profile_prompted_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationSessions = charlyMemory.table("conversation_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userKey: text("user_key").notNull().references(() => copilotUsers.identityKey, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"),
  messageCount: integer("message_count").notNull().default(0),
  charactersSinceSummary: integer("characters_since_summary").notNull().default(0),
  adkStateCiphertext: text("adk_state_ciphertext"),
  promptRevision: text("prompt_revision"),
  sessionRevision: integer("session_revision").notNull().default(1),
  closedReason: text("closed_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (table) => [
  index("conversation_sessions_user_last_idx").on(table.userKey, table.lastMessageAt),
]);

export const conversationMessages = charlyMemory.table("conversation_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  userKey: text("user_key").notNull().references(() => copilotUsers.identityKey, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => conversationSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  source: text("source").notNull(),
  ciphertext: text("ciphertext").notNull(),
  characterCount: integer("character_count").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  adkEventId: text("adk_event_id"),
  invocationId: text("invocation_id"),
  finalStatus: text("final_status").notNull().default("completed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("conversation_messages_user_idempotency_idx").on(table.userKey, table.idempotencyKey),
  index("conversation_messages_session_created_idx").on(table.sessionId, table.createdAt),
]);

export const conversationSummaries = charlyMemory.table("conversation_summaries", {
  id: uuid("id").defaultRandom().primaryKey(),
  userKey: text("user_key").notNull().references(() => copilotUsers.identityKey, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => conversationSessions.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  ciphertext: text("ciphertext").notNull(),
  throughMessageId: uuid("through_message_id").references(() => conversationMessages.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("conversation_summaries_session_version_idx").on(table.sessionId, table.version),
]);

export const copilotMemories = charlyMemory.table("copilot_memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  userKey: text("user_key").notNull().references(() => copilotUsers.identityKey, { onDelete: "cascade" }),
  type: text("type").notNull(),
  ciphertext: text("ciphertext").notNull(),
  fingerprint: text("fingerprint").notNull(),
  confidence: integer("confidence").notNull(),
  importance: integer("importance").notNull(),
  embedding: vector("embedding", { dimensions: 768 }).notNull(),
  status: text("status").notNull().default("active"),
  sourceMessageId: uuid("source_message_id").references(() => conversationMessages.id, { onDelete: "set null" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("copilot_memories_user_fingerprint_idx").on(table.userKey, table.fingerprint),
  index("copilot_memories_user_status_idx").on(table.userKey, table.status),
  index("copilot_memories_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
]);

export const copilotGoals = charlyMemory.table("copilot_goals", {
  id: uuid("id").defaultRandom().primaryKey(),
  userKey: text("user_key").notNull().references(() => copilotUsers.identityKey, { onDelete: "cascade" }),
  titleCiphertext: text("title_ciphertext").notNull(),
  nextStepCiphertext: text("next_step_ciphertext"),
  blockerCiphertext: text("blocker_ciphertext"),
  fingerprint: text("fingerprint").notNull(),
  status: text("status").notNull().default("open"),
  confidence: integer("confidence").notNull().default(850),
  lastProgressAt: timestamp("last_progress_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("copilot_goals_user_fingerprint_idx").on(table.userKey, table.fingerprint),
  index("copilot_goals_user_status_idx").on(table.userKey, table.status),
]);

export const memoryTombstones = charlyMemory.table("memory_tombstones", {
  id: uuid("id").defaultRandom().primaryKey(),
  userKey: text("user_key").notNull().references(() => copilotUsers.identityKey, { onDelete: "cascade" }),
  fingerprint: text("fingerprint").notNull(),
  reason: text("reason").notNull().default("user_request"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (table) => [uniqueIndex("memory_tombstones_user_fingerprint_idx").on(table.userKey, table.fingerprint)]);

export const copilotRuns = charlyMemory.table("copilot_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userKey: text("user_key").notNull().references(() => copilotUsers.identityKey, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => conversationSessions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"),
  stateCiphertext: text("state_ciphertext").notNull(),
  callId: text("call_id").notNull(),
  toolName: text("tool_name").notNull(),
  contextVersion: integer("context_version").notNull(),
  recoveryCount: integer("recovery_count").notNull().default(0),
  actionCount: integer("action_count").notNull().default(0),
  promptRevision: text("prompt_revision"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("copilot_runs_call_id_idx").on(table.callId),
  index("copilot_runs_user_session_idx").on(table.userKey, table.sessionId),
]);

export const memoryAuditEvents = charlyMemory.table("memory_audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  userKey: text("user_key").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("memory_audit_user_created_idx").on(table.userKey, table.createdAt)]);
