import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSavTestDb } from "../../../test/sav-db";
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { encryptSavPayload } from "./crypto";
import { listSavDossierDashboardReference } from "./dashboard-source";
import { listSavDossierDashboardSql, readSavDossierDashboardSqlReadOnly, refreshSavDashboardProjection } from "./dashboard-projection";
import { listSavDossierDashboardReadOnly } from "./dashboard";
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

// SAV-60 / UX-Q6 option A: opening the list must write nothing. The cron step `dashboard_projection` stays the only writer of the cache.
const projection = async () => (await fixture.client.query<{ n: string; v: string }>("select count(*)::text n, coalesce(sum(version + indexed_version), 0)::text v from sav.dashboard_projection")).rows[0];
const refreshAll = async () => { for (let i = 0; i < 10 && (await refreshSavDashboardProjection(100)).refreshed; i++); };
it("a stale or missing projection answers pending and writes nothing, in one read-only repeatable-read transaction", async () => {
  await seed(); await seed();
  const before = await projection();
  const transaction = vi.spyOn(fixture.db, "transaction");
  expect(await readSavDossierDashboardSqlReadOnly({ view: "to_process" })).toEqual({ pending: true });
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(transaction.mock.calls[0]![1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
  expect(await projection()).toEqual(before);
});
it("negative control: the repairing reader DOES write the cache on the same state, so the check above can see a write", async () => {
  await seed();
  const before = await projection();
  await listSavDossierDashboardSql({ view: "to_process" });
  expect(await projection()).not.toEqual(before);
});
it("once the cron step has refreshed the cache, the read-only reader returns the same page as the repairing reader and the reference", async () => {
  await seed(); await seed("Autre sujet");
  expect(await readSavDossierDashboardSqlReadOnly()).toEqual({ pending: true });
  await refreshAll();
  const after = await projection();
  for (const view of ["to_process", "to_validate", "learning", "completed", "technical", "incidents", "other"]) {
    const result = await readSavDossierDashboardSqlReadOnly({ view });
    expect(result).toEqual({ pending: false, data: await listSavDossierDashboardReference({ view }) });
    expect(result).toEqual({ pending: false, data: await listSavDossierDashboardSql({ view }) });
  }
  expect(await projection()).toEqual(after);
});
it("a source change makes the cache stale again: pending, still no write, until the next refresh", async () => {
  const row = await seed(); await refreshAll();
  await fixture.db.update(savThreads).set({ hubspotTicketId: "73" }).where(eq(savThreads.id, row.thread.id));
  const before = await projection();
  expect(await readSavDossierDashboardSqlReadOnly()).toEqual({ pending: true });
  expect(await projection()).toEqual(before);
  await refreshAll();
  expect((await readSavDossierDashboardSqlReadOnly()).pending).toBe(false);
});
it("the switch follows SAV_DASHBOARD_SQL: SQL path pending without repair, reference path one read-only read; both log their status and write nothing", async () => {
  await seed();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const before = await projection();
  vi.stubEnv("SAV_DASHBOARD_SQL", "true");
  expect(await listSavDossierDashboardReadOnly()).toEqual({ pending: true });
  vi.stubEnv("SAV_DASHBOARD_SQL", "false");
  expect(await listSavDossierDashboardReadOnly({ view: "to_process" })).toEqual({ pending: false, data: await listSavDossierDashboardReference({ view: "to_process" }) });
  expect(await projection()).toEqual(before);
  const reads = log.mock.calls.filter(args => args[0] === "sav_dashboard_read").map(args => [args[1].mode, args[1].status]);
  expect(reads).toEqual([["sql", "pending"], ["reference", "ok"]]);
});
