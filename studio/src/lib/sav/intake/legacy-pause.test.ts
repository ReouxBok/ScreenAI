import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savActions, savDecisions, savIntakeRuns, savMailboxes, savMessages, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, SAV_INTAKE_RUNTIME_REVISION, type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { assertSavIntakeLease, catchupSavIntake, claimSavIntakeRun, enqueueSavIntakeMessage, intakeRecordedSourceHash, intakeSourceMatches,
  pendingSavIntakeRuns, readSavIntakeCurrent, saveSavIntakeResult, savIntakeSourceSnapshot } from "./runtime-store";
import { listLegacyAiPausedIntakeThreads, releaseLegacyAiPauses } from "./legacy-pause";

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, messageId: string, config: IntakeRuntimeConfig;
const original = { text: "La connexion ne marche plus.", attachments: [], headers: { "message-id": "<synthetic@example.invalid>" } };
function env(mailbox: string) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function inbound(options: { receivedAt?: Date; createdAt?: Date; thread?: string } = {}) {
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId: options.thread ?? threadId, direction: "inbound", fromEmail: "synthetic@example.invalid",
    toEmails: ["support@example.invalid"], subject: "Connexion fictive", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload(original),
    receivedAt: options.receivedAt ?? new Date(), createdAt: options.createdAt ?? new Date(), analysisStatus: "pending" }).returning();
  return m;
}
/** What the pre-intake V0 pipeline left behind for a review_required AI decision. */
async function legacyAiPause(thread = threadId) {
  const [old] = await f.db.insert(savMessages).values({ mailboxId, threadId: thread, direction: "inbound", fromEmail: "synthetic@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Ancienne demande", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: "Ancienne demande" }),
    receivedAt: new Date(Date.now() - 7200_000), createdAt: new Date(Date.now() - 7200_000), analysisStatus: "done", processedAt: new Date(Date.now() - 7200_000) }).returning();
  const [decision] = await f.db.insert(savDecisions).values({ messageId: old.id, kind: "human_review_required", reasonCode: "analysis_unverified", explanation: "Relecture humaine requise", confidence: 0, actorType: "ai" }).returning();
  await f.db.insert(savActions).values({ threadId: thread, messageId: old.id, decisionId: decision.id, kind: "request_human", idempotencyKey: `human:request:${old.id}`, actorType: "ai" });
  await f.db.update(savThreads).set({ aiPaused: true, status: "human_requested", humanRequestedAt: new Date(Date.now() - 7200_000) }).where(eq(savThreads.id, thread));
  return old;
}
const observedPayload = (): IntakeRuntimePayload => ({ revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected" as const, reason: "synthetic" });
const thread = async () => (await f.db.select().from(savThreads).where(eq(savThreads.id, threadId)))[0];
const snapshot = async () => {
  const [m] = await f.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  return f.db.transaction(tx => savIntakeSourceSnapshot(tx, m, new Date()));
};

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-runtime-encryption-key");
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning(); mailboxId = mailbox.id;
  const [t] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning(); threadId = t.id;
  config = savIntakeRuntimeConfig(env(mailboxId))!;
});
afterEach(() => vi.unstubAllEnvs());

it("lifts a legacy AI pause for a new customer reply, keeps the legacy status and audits it", async () => {
  await legacyAiPause(); messageId = (await inbound()).id;
  expect(await catchupSavIntake(config)).toBe(1);
  expect(await pendingSavIntakeRuns(config)).toHaveLength(0);
  expect(await releaseLegacyAiPauses(config)).toEqual({ released: 1 });
  const t = await thread();
  expect(t.aiPaused).toBe(false); expect(t.status).toBe("human_requested"); expect(t.humanRequestedAt).not.toBeNull();
  const audit = await f.db.select().from(auditLogs).where(eq(auditLogs.entityId, threadId));
  expect(audit.map(a => [a.action, a.actorEmail])).toEqual([["sav_intake_legacy_ai_pause_released", "system"]]);
  const [run] = await pendingSavIntakeRuns(config);
  const lease = await claimSavIntakeRun(run.id, config);
  expect(lease?.run.attempts).toBe(1);
  expect(await releaseLegacyAiPauses(config)).toEqual({ released: 0 });
});

it("never lifts an explicit human hold", async () => {
  await legacyAiPause(); messageId = (await inbound()).id;
  await f.db.insert(savActions).values({ threadId, kind: "request_human", idempotencyKey: `human:admin-request:${threadId}`, actorType: "human", actorEmail: "agent@example.invalid" });
  expect(await releaseLegacyAiPauses(config)).toEqual({ released: 0 });
  expect((await thread()).aiPaused).toBe(true);
});

it("never lifts a pause confirmed by a human correction", async () => {
  const old = await legacyAiPause(); messageId = (await inbound()).id;
  await f.db.update(savDecisions).set({ isCurrent: false }).where(eq(savDecisions.messageId, old.id));
  await f.db.insert(savDecisions).values({ messageId: old.id, kind: "human_review_required", reasonCode: "human_correction", explanation: "Corrigé par un humain", confidence: 1000, actorType: "human", actorEmail: "agent@example.invalid" });
  expect(await listLegacyAiPausedIntakeThreads(config)).toEqual([]);
  expect((await thread()).aiPaused).toBe(true);
});

it("leaves pre-launch and other-mailbox threads to the legacy flow", async () => {
  await legacyAiPause(); messageId = (await inbound({ createdAt: new Date(Date.parse(config.createdAfter) - 1) })).id;
  const [otherMailbox] = await f.db.insert(savMailboxes).values({ email: "other@example.invalid" }).returning();
  const [otherThread] = await f.db.insert(savThreads).values({ mailboxId: otherMailbox.id, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid", aiPaused: true }).returning();
  await f.db.insert(savMessages).values({ mailboxId: otherMailbox.id, threadId: otherThread.id, direction: "inbound", fromEmail: "synthetic@example.invalid", toEmails: [],
    subject: "Autre boîte", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload(original), receivedAt: new Date(), createdAt: new Date() });
  expect(await releaseLegacyAiPauses(config)).toEqual({ released: 0 });
  expect((await thread()).aiPaused).toBe(true);
});

it("keeps an analysis current when only derived data is re-encrypted or the thread is touched", async () => {
  messageId = (await inbound()).id;
  const id = await enqueueSavIntakeMessage(messageId, config), lease = (await claimSavIntakeRun(id!, config))!;
  await f.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ ...original, supportContext: { version: 1, synthetic: true }, attachmentRead: { synthetic: true } }) }).where(eq(savMessages.id, messageId));
  // updated_at moves with unrelated writes (status, deadlines); a pause or ticket change is fenced separately by sav_intake_thread_context.
  await f.db.update(savThreads).set({ updatedAt: new Date(Date.now() + 5000), status: "ai_processing" }).where(eq(savThreads.id, threadId));
  await expect(assertSavIntakeLease(lease, config)).resolves.not.toThrow();
  await saveSavIntakeResult(lease, config, observedPayload(), "observed");
  const current = await readSavIntakeCurrent(threadId, config);
  expect(current?.sourceMatches).toBe(true); expect(current?.fresh).toBe(true); expect(current?.currentSourceHash).toBe(current?.sourceHash);
});

it("still detects a real change of the exchanged content", async () => {
  messageId = (await inbound()).id;
  const id = await enqueueSavIntakeMessage(messageId, config), lease = (await claimSavIntakeRun(id!, config))!;
  await f.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ ...original, text: "Finalement c'est la facturation." }) }).where(eq(savMessages.id, messageId));
  await expect(assertSavIntakeLease(lease, config)).rejects.toThrow();
  await f.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ ...original, headers: { ...original.headers, "in-reply-to": "<other@example.invalid>" } }) }).where(eq(savMessages.id, messageId));
  expect(intakeSourceMatches(await snapshot(), lease.sourceHash)).toBe(false);
});

it("recognizes and preserves a hash recorded before the v2 upgrade", async () => {
  messageId = (await inbound()).id;
  const id = await enqueueSavIntakeMessage(messageId, config), lease = (await claimSavIntakeRun(id!, config))!;
  await saveSavIntakeResult(lease, config, observedPayload(), "observed");
  const before = await snapshot();
  expect(before.legacySourceHash).not.toBe(before.sourceHash);
  await f.db.update(savIntakeRuns).set({ sourceHash: before.legacySourceHash }).where(eq(savIntakeRuns.id, id!));
  const current = await readSavIntakeCurrent(threadId, config);
  expect(current?.sourceMatches).toBe(true); expect(current?.currentSourceHash).toBe(before.legacySourceHash);
  expect(intakeRecordedSourceHash(before, before.legacySourceHash)).toBe(before.legacySourceHash);
  expect(intakeRecordedSourceHash(before, "f".repeat(64))).toBe(before.sourceHash);
  expect(intakeSourceMatches(before, null)).toBe(false);
});
