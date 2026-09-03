import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const staffRole = pgEnum("staff_role", ["contributor", "reviewer", "admin", "member", "owner"]);
export const contentType = pgEnum("content_type", ["article", "onboarding"]);
export const contentStatus = pgEnum("content_status", ["draft", "in_review", "published", "archived"]);
export const visibility = pgEnum("content_visibility", ["charly_only", "charly_and_help"]);
export const reviewAction = pgEnum("review_action", ["submitted", "approved", "rejected", "emergency_published", "rolled_back", "archived"]);
export const trainingStatus = pgEnum("training_status", ["draft", "recording", "ready", "converted", "archived"]);
export const trainingEventKind = pgEnum("training_event_kind", ["navigation", "click", "input", "voice_note", "page_context", "network"]);

export const staffUsers = pgTable("staff_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default("Membre Limova"),
  role: staffRole("role").notNull().default("member"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contentItems = pgTable("content_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull(),
  type: contentType("type").notNull(),
  locale: text("locale").notNull().default("fr-FR"),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  visibility: visibility("visibility").notNull().default("charly_only"),
  status: contentStatus("status").notNull().default("draft"),
  ownerEmail: text("owner_email").notNull(),
  agentKey: text("agent_key").notNull().default("common"),
  aiEnabled: boolean("ai_enabled").notNull().default(false),
  sourcePath: text("source_path"),
  currentDraftVersionId: uuid("current_draft_version_id"),
  publishedVersionId: uuid("published_version_id"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("content_items_slug_locale_idx").on(table.slug, table.locale),
  index("content_items_status_idx").on(table.status),
]);

export type ArticleMetadata = {
  intents: string[];
  limovaPaths: string[];
  prerequisites: string[];
  expectedResult: string;
  troubleshooting: string;
  sourceMetadata?: Record<string, unknown>;
};

export type OnboardingMetadata = {
  objective: string;
  proposalSignals: string[];
  qualificationQuestions: string[];
  expectedPages: string[];
  successCriteria: string[];
  branches: Array<{ condition: string; next: string }>;
  fallbacks: string[];
  actionSteps?: Array<{
    order: number;
    action: "click" | "input" | "external_popup";
    path: string;
    label: string;
    confidence: "strong" | "medium" | "weak";
    target?: Record<string, string | number | undefined>;
    preconditions: string[];
    expected: { path?: string; popup?: "opened_then_closed"; pageMarkers: string[]; network: string[]; fieldFilled?: boolean };
  }>;
};

export type OnboardingTemplateNode = {
  id: string;
  contentItemId: string;
  depth: 0 | 1 | 2;
  trigger: string;
  optional: boolean;
};

export type OnboardingTemplateDefinition = {
  name: string;
  openingPrompt: string;
  fallbackPrompt: string;
  nodes: OnboardingTemplateNode[];
};

export const contentVersions = pgTable("content_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  bodyMarkdown: text("body_markdown").notNull(),
  metadata: jsonb("metadata").$type<ArticleMetadata | OnboardingMetadata>().notNull(),
  changeNote: text("change_note").notNull(),
  authorEmail: text("author_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("content_versions_item_version_idx").on(table.itemId, table.version)]);

export const contentChunks = pgTable("content_chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  versionId: uuid("version_id").notNull().references(() => contentVersions.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  heading: text("heading").notNull().default(""),
  content: text("content").notNull(),
  intents: text("intents").array().notNull().default([]),
  limovaPaths: text("limova_paths").array().notNull().default([]),
  embedding: vector("embedding", { dimensions: 768 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("content_chunks_item_idx").on(table.itemId),
  index("content_chunks_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
]);

export const reviewEvents = pgTable("review_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  versionId: uuid("version_id").references(() => contentVersions.id, { onDelete: "set null" }),
  action: reviewAction("action").notNull(),
  actorEmail: text("actor_email").notNull(),
  comment: text("comment").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const testCases = pgTable("test_cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  query: text("query").notNull(),
  path: text("path"),
  locale: text("locale").notNull().default("fr-FR"),
  expectedItemId: uuid("expected_item_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  lastStatus: text("last_status").notNull().default("not_run"),
  lastResult: jsonb("last_result").$type<{ rank: number | null; resultIds: string[]; error?: string }>(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const trainingSessions = pgTable("training_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  goal: text("goal").notNull(),
  agentKey: text("agent_key").notNull().default("charly"),
  startPath: text("start_path").notNull().default("/"),
  tokenHash: text("token_hash").notNull().unique(),
  status: trainingStatus("status").notNull().default("draft"),
  createdBy: text("created_by").notNull(),
  contentItemId: uuid("content_item_id").references(() => contentItems.id, { onDelete: "set null" }),
  recordingStatus: text("recording_status").notNull().default("missing"),
  recordingPathname: text("recording_pathname"),
  recordingContentType: text("recording_content_type"),
  recordingSizeBytes: integer("recording_size_bytes"),
  recordingDurationMs: integer("recording_duration_ms"),
  recordingUploadedAt: timestamp("recording_uploaded_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const trainingEvents = pgTable("training_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => trainingSessions.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  kind: trainingEventKind("kind").notNull(),
  path: text("path").notNull().default("/"),
  label: text("label").notNull().default(""),
  payload: jsonb("payload").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("training_events_session_ordinal_idx").on(table.sessionId, table.ordinal),
  index("training_events_session_idx").on(table.sessionId),
]);

export type EvaluationExpectation = {
  startPath: string;
  objective: string;
  expectedPages: string[];
  successCriteria: string[];
  requiredTools: string[];
};

export const evaluationSuites = pgTable("evaluation_suites", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  versionId: uuid("version_id").notNull().references(() => contentVersions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("draft"),
  threshold: integer("threshold").notNull().default(80),
  score: integer("score"),
  createdBy: text("created_by").notNull(),
  passedAt: timestamp("passed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("evaluation_suites_version_idx").on(table.versionId),
  index("evaluation_suites_item_idx").on(table.itemId),
]);

export const evaluationCases = pgTable("evaluation_cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  suiteId: uuid("suite_id").notNull().references(() => evaluationSuites.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  kind: text("kind").notNull().default("live_action"),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  critical: boolean("critical").notNull().default(true),
  expectation: jsonb("expectation").$type<EvaluationExpectation>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("evaluation_cases_suite_ordinal_idx").on(table.suiteId, table.ordinal)]);

export const evaluationRuns = pgTable("evaluation_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  suiteId: uuid("suite_id").notNull().references(() => evaluationSuites.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => evaluationCases.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull().default("ready"),
  score: integer("score"),
  extensionVersion: text("extension_version"),
  promptRevision: text("prompt_revision"),
  knowledgeRevision: text("knowledge_revision"),
  contributorVerdict: text("contributor_verdict"),
  failureCode: text("failure_code"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("evaluation_runs_suite_idx").on(table.suiteId),
  index("evaluation_runs_case_idx").on(table.caseId),
]);

export const evaluationEvents = pgTable("evaluation_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => evaluationRuns.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  kind: text("kind").notNull(),
  toolName: text("tool_name"),
  status: text("status"),
  path: text("path"),
  targetLabel: text("target_label"),
  technicalMetadata: jsonb("technical_metadata").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("evaluation_events_run_ordinal_idx").on(table.runId, table.ordinal),
  index("evaluation_events_run_idx").on(table.runId),
]);

export const knowledgeRevisions = pgTable("knowledge_revisions", {
  id: text("id").primaryKey(),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  actorEmail: text("actor_email").notNull(),
});

export const activeKnowledge = pgTable("active_knowledge", {
  singleton: boolean("singleton").notNull().default(true),
  revisionId: text("revision_id").notNull().references(() => knowledgeRevisions.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.singleton] })]);

export const onboardingTemplateVersions = pgTable("onboarding_template_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  version: integer("version").notNull().unique(),
  definition: jsonb("definition").$type<OnboardingTemplateDefinition>().notNull(),
  changeNote: text("change_note").notNull(),
  authorEmail: text("author_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const activeOnboardingTemplate = pgTable("active_onboarding_template", {
  singleton: boolean("singleton").notNull().default(true),
  draftVersionId: uuid("draft_version_id").references(() => onboardingTemplateVersions.id, { onDelete: "set null" }),
  publishedVersionId: uuid("published_version_id").references(() => onboardingTemplateVersions.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.singleton] })]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  technicalMetadata: jsonb("technical_metadata").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The support inbox contains customer communications and therefore lives in
// its own PostgreSQL namespace. Message bodies are encrypted by the service;
// the rows below only expose the minimum metadata required by the admin UI.
export const sav = pgSchema("sav");

export const savThreadStatus = sav.enum("thread_status", [
  "new",
  "ai_processing",
  "awaiting_customer",
  "followup_due",
  "human_requested",
  "human_processing",
  "resolved",
  "closed_no_action",
  "error",
]);
export const savMessageDirection = sav.enum("message_direction", ["inbound", "outbound"]);
export const savDecisionKind = sav.enum("decision_kind", [
  "ticket_pending",
  "ticket_created",
  "attached_to_existing_ticket",
  "no_ticket_needed",
  "spam",
  "internal_notification",
  "automatic_reply",
  "bounce",
  "duplicate",
  "human_review_required",
]);
export const savActorType = sav.enum("actor_type", ["ai", "human", "system"]);
export const savActionKind = sav.enum("action_kind", [
  "create_ticket",
  "link_ticket",
  "log_email",
  "create_note",
  "draft_reply",
  "send_reply",
  "update_ticket_status",
  "schedule_followup",
  "cancel_followup",
  "request_human",
  "create_learning_candidate",
]);
export const savActionStatus = sav.enum("action_status", ["pending", "running", "succeeded", "failed", "cancelled"]);
export const savLearningStatus = sav.enum("learning_status", ["pending", "approved", "rejected"]);
export const savPilotBatchStatus = sav.enum("pilot_batch_status", ["processing", "reviewing", "completed", "cancelled"]);
export const savPilotItemStatus = sav.enum("pilot_item_status", ["pending", "processing", "ready", "reviewed", "error"]);
export const savPilotVerdict = sav.enum("pilot_verdict", ["correct", "partial", "incorrect", "critical"]);

export type SavDecisionEvidence = {
  sourceType: "knowledge" | "hubspot_ticket" | "gmail_thread" | "rule";
  sourceId: string;
  title: string;
  score?: number;
};

export type SavAgentToolTrace = {
  sequence: number;
  name: string;
  status: "succeeded" | "failed" | "blocked";
  inputHash?: string;
  resultSummary?: Record<string, unknown>;
  errorCode?: string;
  durationMs: number;
};

export const savMailboxes = sav.table("mailboxes", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  historyId: text("history_id"),
  watchExpiration: timestamp("watch_expiration", { withTimezone: true }),
  watchStatus: text("watch_status").notNull().default("disconnected"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const savSyncState = sav.table("sync_state", {
  key: text("key").primaryKey(),
  cursor: text("cursor"),
  status: text("status").notNull().default("idle"),
  processedCount: integer("processed_count").notNull().default(0),
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const savWebhookReceipts = sav.table("webhook_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  errorCode: text("error_code"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("sav_webhook_provider_external_idx").on(table.provider, table.externalId),
  index("sav_webhook_status_received_idx").on(table.status, table.receivedAt),
]);

export const savGmailQuarantine = sav.table("gmail_quarantine", {
  id: uuid("id").defaultRandom().primaryKey(),
  mailboxId: uuid("mailbox_id").notNull().references(() => savMailboxes.id, { onDelete: "cascade" }),
  receiptId: uuid("receipt_id").references(() => savWebhookReceipts.id, { onDelete: "set null" }),
  gmailMessageId: text("gmail_message_id").notNull(),
  cause: text("cause").notNull(),
  attempts: integer("attempts").notNull().default(1),
  status: text("status").notNull().default("quarantined"),
  firstFailedAt: timestamp("first_failed_at", { withTimezone: true }).notNull().defaultNow(),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("sav_gmail_quarantine_mailbox_message_idx").on(table.mailboxId, table.gmailMessageId),
  index("sav_gmail_quarantine_status_failed_idx").on(table.status, table.lastFailedAt),
]);

export const savThreads = sav.table("threads", {
  id: uuid("id").defaultRandom().primaryKey(),
  mailboxId: uuid("mailbox_id").notNull().references(() => savMailboxes.id, { onDelete: "cascade" }),
  gmailThreadId: text("gmail_thread_id").notNull(),
  hubspotTicketId: text("hubspot_ticket_id"),
  subject: text("subject").notNull().default("Sans objet"),
  customerEmail: text("customer_email").notNull(),
  status: savThreadStatus("status").notNull().default("new"),
  aiPaused: boolean("ai_paused").notNull().default(false),
  humanRequestedAt: timestamp("human_requested_at", { withTimezone: true }),
  humanDueAt: timestamp("human_due_at", { withTimezone: true }),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sav_threads_mailbox_gmail_idx").on(table.mailboxId, table.gmailThreadId),
  index("sav_threads_status_message_idx").on(table.status, table.lastMessageAt),
  index("sav_threads_hubspot_idx").on(table.hubspotTicketId),
]);

export const savMessages = sav.table("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  mailboxId: uuid("mailbox_id").notNull().references(() => savMailboxes.id, { onDelete: "cascade" }),
  threadId: uuid("thread_id").notNull().references(() => savThreads.id, { onDelete: "cascade" }),
  gmailMessageId: text("gmail_message_id"),
  hubspotEmailId: text("hubspot_email_id"),
  direction: savMessageDirection("direction").notNull(),
  fromEmail: text("from_email").notNull(),
  toEmails: text("to_emails").array().notNull().default([]),
  subject: text("subject").notNull().default("Sans objet"),
  preview: text("preview").notNull().default(""),
  bodyCiphertext: text("body_ciphertext").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sav_messages_mailbox_gmail_idx").on(table.mailboxId, table.gmailMessageId),
  index("sav_messages_thread_received_idx").on(table.threadId, table.receivedAt),
]);

export const savPilotBatches = sav.table("pilot_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  targetSize: integer("target_size").notNull().default(10),
  status: savPilotBatchStatus("status").notNull().default("processing"),
  createdBy: text("created_by").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("sav_pilot_batches_status_created_idx").on(table.status, table.createdAt)]);

export const savDecisions = sav.table("decisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => savMessages.id, { onDelete: "cascade" }),
  kind: savDecisionKind("kind").notNull(),
  reasonCode: text("reason_code").notNull(),
  explanation: text("explanation").notNull(),
  confidence: integer("confidence").notNull(),
  evidence: jsonb("evidence").$type<SavDecisionEvidence[]>().notNull().default([]),
  model: text("model").notNull().default("rules"),
  actorType: savActorType("actor_type").notNull().default("ai"),
  actorEmail: text("actor_email"),
  supersedesDecisionId: uuid("supersedes_decision_id"),
  isCurrent: boolean("is_current").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sav_decisions_message_current_idx").on(table.messageId, table.isCurrent),
  index("sav_decisions_kind_created_idx").on(table.kind, table.createdAt),
]);

export const savAgentRuns = sav.table("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => savMessages.id, { onDelete: "cascade" }),
  pilotBatchId: uuid("pilot_batch_id").references(() => savPilotBatches.id, { onDelete: "set null" }),
  scope: text("scope").notNull().default("sav_ticket_analysis"),
  runtime: text("runtime").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  model: text("model").notNull(),
  promptRevision: text("prompt_revision").notNull(),
  inputHash: text("input_hash").notNull(),
  outputHash: text("output_hash"),
  decisionKind: text("decision_kind"),
  confidence: integer("confidence"),
  evidence: jsonb("evidence").$type<SavDecisionEvidence[]>().notNull().default([]),
  toolTrace: jsonb("tool_trace").$type<SavAgentToolTrace[]>().notNull().default([]),
  fallbackRuntime: text("fallback_runtime"),
  errorCode: text("error_code"),
  durationMs: integer("duration_ms").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sav_agent_runs_message_created_idx").on(table.messageId, table.createdAt),
  index("sav_agent_runs_batch_created_idx").on(table.pilotBatchId, table.createdAt),
  index("sav_agent_runs_status_created_idx").on(table.status, table.createdAt),
]);

export const savPilotItems = sav.table("pilot_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  batchId: uuid("batch_id").notNull().references(() => savPilotBatches.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => savMessages.id, { onDelete: "cascade" }),
  decisionId: uuid("decision_id").references(() => savDecisions.id, { onDelete: "set null" }),
  status: savPilotItemStatus("status").notNull().default("pending"),
  verdict: savPilotVerdict("verdict"),
  feedbackCodes: text("feedback_codes").array().notNull().default([]),
  reviewerComment: text("reviewer_comment").notNull().default(""),
  correctedDraftCiphertext: text("corrected_draft_ciphertext"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sav_pilot_items_message_idx").on(table.messageId),
  index("sav_pilot_items_batch_status_idx").on(table.batchId, table.status),
]);

export const savActions = sav.table("actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id").notNull().references(() => savThreads.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").references(() => savMessages.id, { onDelete: "set null" }),
  decisionId: uuid("decision_id").references(() => savDecisions.id, { onDelete: "set null" }),
  pilotBatchId: uuid("pilot_batch_id").references(() => savPilotBatches.id, { onDelete: "set null" }),
  kind: savActionKind("kind").notNull(),
  status: savActionStatus("status").notNull().default("pending"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  actorType: savActorType("actor_type").notNull().default("system"),
  actorEmail: text("actor_email"),
  errorCode: text("error_code"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sav_actions_status_scheduled_idx").on(table.status, table.scheduledAt),
  index("sav_actions_thread_created_idx").on(table.threadId, table.createdAt),
  index("sav_actions_pilot_batch_idx").on(table.pilotBatchId, table.status),
]);

export const savFollowups = sav.table("followups", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id").notNull().references(() => savThreads.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("scheduled"),
  actionId: uuid("action_id").references(() => savActions.id, { onDelete: "set null" }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sav_followups_thread_sequence_idx").on(table.threadId, table.sequence),
  index("sav_followups_status_due_idx").on(table.status, table.dueAt),
]);

export const savTicketSnapshots = sav.table("ticket_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  hubspotTicketId: text("hubspot_ticket_id").notNull().unique(),
  pipelineId: text("pipeline_id"),
  stageId: text("stage_id"),
  status: text("status").notNull(),
  subject: text("subject").notNull().default("Sans objet"),
  transcriptCiphertext: text("transcript_ciphertext").notNull(),
  contentHash: text("content_hash").notNull(),
  humanIntervened: boolean("human_intervened").notNull().default(false),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  hubspotUpdatedAt: timestamp("hubspot_updated_at", { withTimezone: true }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("sav_ticket_snapshots_processed_idx").on(table.processedAt, table.hubspotUpdatedAt)]);

export const savResolutionEvidence = sav.table("resolution_evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  versionId: uuid("version_id").notNull().references(() => contentVersions.id, { onDelete: "cascade" }),
  hubspotTicketId: text("hubspot_ticket_id").notNull(),
  weight: integer("weight").notNull().default(500),
  outcome: text("outcome").notNull(),
  summary: text("summary").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sav_resolution_evidence_version_ticket_idx").on(table.versionId, table.hubspotTicketId),
  index("sav_resolution_evidence_item_idx").on(table.itemId),
]);

export const savLearningCandidates = sav.table("learning_candidates", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id").references(() => savThreads.id, { onDelete: "set null" }),
  hubspotTicketId: text("hubspot_ticket_id").notNull(),
  contentItemId: uuid("content_item_id").references(() => contentItems.id, { onDelete: "set null" }),
  status: savLearningStatus("status").notNull().default("pending"),
  proposedPatch: jsonb("proposed_patch").$type<Record<string, unknown>>().notNull(),
  explanation: text("explanation").notNull(),
  sourceContentHash: text("source_content_hash").notNull(),
  evidenceTicketIds: text("evidence_ticket_ids").array().notNull().default([]),
  createdBy: savActorType("created_by").notNull().default("system"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sav_learning_ticket_content_idx").on(table.hubspotTicketId, table.sourceContentHash),
  index("sav_learning_status_created_idx").on(table.status, table.createdAt),
  index("sav_learning_ticket_idx").on(table.hubspotTicketId),
]);
