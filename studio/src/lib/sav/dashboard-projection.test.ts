import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savActions, savDecisions, savLearningCandidates, savMailboxes, savMessages, savPilotBatches, savPilotItems, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { encryptSavPayload } from "./crypto";
import { listSavDossierDashboardReference } from "./dashboard-source";
import { listSavDossierDashboardSql, refreshSavDashboardProjection, SavDashboardProjectionPending } from "./dashboard-projection";
import { measureSavDashboardRead } from "./read-metrics";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
let sequence = 0;
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => fixture?.client.close());
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
beforeEach(async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false"); vi.stubEnv("SAV_OTHER_OBSERVATION_RULES_JSON", "");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning(); mailboxId = mailbox.id;
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
});
async function seed(subject = "Été 😃 ababa %_ Téléphonie") {
  const i = ++sequence;
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId, gmailThreadId: `fixture-${i}`, subject, customerEmail: "synthetic@example.invalid" }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId, threadId: thread.id, gmailMessageId: `fixture-message-${i}`, direction: "inbound", fromEmail: thread.customerEmail, subject, bodyCiphertext: encryptSavPayload({ text: "Question privée synthétique" }), receivedAt: new Date(Date.parse("2026-10-03") + i * 1000) }).returning();
  return { thread, message };
}
async function equivalent() {
  for (const view of ["to_process", "to_validate", "learning", "completed", "technical", "incidents", "other"]) {
    expect(await listSavDossierDashboardSql({ view })).toEqual(await listSavDossierDashboardReference({ view }));
  }
}
it("repairs only affected rows after warmed source changes and preserves all views", async () => {
  const row = await seed(); await seed(); await equivalent();
  await fixture.db.update(savMessages).set({ studioOpenedAt: new Date() }).where(eq(savMessages.id, row.message.id)); await equivalent();
  await fixture.db.update(savThreads).set({ hubspotTicketId: "73" }).where(eq(savThreads.id, row.thread.id)); await equivalent();
  const [candidate] = await fixture.db.insert(savLearningCandidates).values({ hubspotTicketId: "73", sourceRef: "fixture:projection", sourceContentHash: "fixture", proposedPatch: {}, explanation: "Synthétique", status: "pending" }).returning(); await equivalent();
  await fixture.db.update(savLearningCandidates).set({ status: "rejected" }).where(eq(savLearningCandidates.id, candidate.id)); await equivalent();
  await fixture.db.insert(savActions).values({ threadId: row.thread.id, messageId: row.message.id, kind: "create_ticket", actorType: "human", status: "failed", idempotencyKey: "fixture-projection", payload: { ticketCreateDispatchedAt: new Date().toISOString() } }); await equivalent();
  await fixture.db.delete(savMessages).where(eq(savMessages.id, row.message.id)); await equivalent();
});
it("invalidates a warmed latest inbound and pilot membership on insert/delete", async () => {
  const row = await seed(); await equivalent();
  await fixture.db.insert(savMessages).values({ mailboxId, threadId: row.thread.id, gmailMessageId: "fixture-latest", direction: "inbound", fromEmail: row.thread.customerEmail, bodyCiphertext: encryptSavPayload({ text: "Nouveau message" }), receivedAt: new Date("2026-10-10") }); await equivalent();
  const [batch] = await fixture.db.insert(savPilotBatches).values({ createdBy: "ugo@limova.ai" }).returning();
  const [latest] = await fixture.db.select().from(savMessages).where(eq(savMessages.gmailMessageId, "fixture-latest"));
  const [pilot] = await fixture.db.insert(savPilotItems).values({ batchId: batch.id, messageId: latest.id }).returning(); await equivalent();
  await fixture.db.delete(savPilotItems).where(eq(savPilotItems.id, pilot.id)); await equivalent();
});
it("ignores unrelated audit noise and invalidates legacy opening proofs transactionally", async () => {
  const row = await seed(); await equivalent();
  const version = async () => (await fixture.client.query<{ version: string }>("select version::text from sav.dashboard_projection where thread_id=$1", [row.thread.id])).rows[0].version;
  const before = await version();
  await fixture.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: "sav_reanalysis_candidate_ready", entityType: "sav_message", entityId: row.message.id, technicalMetadata: {} }); expect(await version()).toBe(before);
  await fixture.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: "sav_email_opened", entityType: "sav_message", entityId: row.message.id, technicalMetadata: {} }); expect(await version()).not.toBe(before); await equivalent();
  const stable = await version();
  await expect(fixture.db.transaction(async tx => { await tx.update(savMessages).set({ subject: "never committed" }).where(eq(savMessages.id, row.message.id)); throw new Error("rollback"); })).rejects.toThrow();
  expect(await version()).toBe(stable); await equivalent();
});
it("matches literal substring search, including Unicode, repeats and SQL special characters", async () => {
  await seed(); await seed("abcdef bcab something else"); await equivalent();
  for (const query of ["É", "ÉTÉ", "😃", "ababa", "ababc", "%_", "'", "téléphonie", "a", "bcab", "ZZZ"]) {
    expect(await listSavDossierDashboardSql({ query, pageSize: 1, sort: "oldest", page: 200 })).toEqual(await listSavDossierDashboardReference({ query, pageSize: 1, sort: "oldest", page: 200 }));
  }
});
it("bounds repairs and reports pending without stale counters or a full-stock fallback", async () => {
  for (let i = 0; i < 26; i++) await seed(`Fixture ${i}`);
  await expect(listSavDossierDashboardSql()).rejects.toBeInstanceOf(SavDashboardProjectionPending);
  expect((await listSavDossierDashboardSql()).total).toBe(26);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  await measureSavDashboardRead("sql", () => listSavDossierDashboardSql({ pageSize: 5, page: 2 }));
  const metrics = log.mock.calls.find(args => args[0] === "sav_dashboard_read")?.[1];
  expect(metrics).toMatchObject({ status: "ok", sourceRows: 5, classifiedRows: 5, decryptions: 5 });
  expect(metrics.queries).toBeLessThan(20);
});
it("detects global cutover and registry changes, and supports explicit bounded warmup", async () => {
  await seed(); await equivalent();
  await fixture.client.exec("update sav.sync_state set status='disabled' where key='sav-v0-cutover'"); await equivalent();
  await fixture.client.exec("update sav.sync_state set status='active' where key='sav-v0-cutover'");
  expect(await refreshSavDashboardProjection(100)).toEqual({ refreshed: 1 }); await equivalent();
});

it("invalidates cutover membership when the source mailbox changes", async () => {
  await seed(); await equivalent();
  await fixture.db.update(savMailboxes).set({ email: "synthetic-other@example.invalid" }).where(eq(savMailboxes.id, mailboxId));
  await equivalent(); expect((await listSavDossierDashboardSql()).total).toBe(0);
  await fixture.db.update(savMailboxes).set({ email: "contact@limova.ai" }).where(eq(savMailboxes.id, mailboxId));
  await equivalent(); expect((await listSavDossierDashboardSql()).total).toBe(1);
});

it("refuses ambiguous current decisions rather than silently collapsing duplicate source rows", async () => {
  const row = await seed();
  await fixture.db.insert(savDecisions).values([
    { messageId: row.message.id, kind: "human_review_required", reasonCode: "fixture", explanation: "Synthetic first current decision", confidence: 0 },
    { messageId: row.message.id, kind: "spam", reasonCode: "fixture", explanation: "Synthetic conflicting current decision", confidence: 0 },
  ]);
  await expect(listSavDossierDashboardSql()).rejects.toThrow("SAV_DASHBOARD_SOURCE_AMBIGUOUS");
});

it("repairs missing cache coverage instead of showing false empty counts", async () => {
  await seed(); await seed(); await equivalent();
  await fixture.client.exec("TRUNCATE sav.dashboard_projection");
  expect((await listSavDossierDashboardSql()).total).toBe(2);
  await equivalent();
});

it("preserves PostgreSQL timestamp precision when ordering page boundaries", async () => {
  const rows = [await seed(), await seed()].sort((a,b) => b.message.id.localeCompare(a.message.id));
  await fixture.client.query("update sav.messages set received_at='2026-10-03T00:00:00.000001Z' where id=$1", [rows[0].message.id]);
  await fixture.client.query("update sav.messages set received_at='2026-10-03T00:00:00.000002Z' where id=$1", [rows[1].message.id]);
  for (const sort of ["oldest", "newest"]) {
    const reference = await listSavDossierDashboardReference({ sort, pageSize: 1 });
    const projected = await listSavDossierDashboardSql({ sort, pageSize: 1 });
    expect(projected).toEqual(reference);
    expect(projected.rows[0].messageId).toBe(rows[sort === "oldest" ? 0 : 1].message.id);
  }
});
