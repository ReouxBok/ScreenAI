/** Independent qualification — A. Administrative classification and console visibility.
 * Pure marker validation + the real intake console projection on PGlite.
 * [CIBLE] tests assume the patch reuses the existing external-completion marker
 * (markSavDossiersHandledExternally); adapt the entry point if it differs. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { targetIt } from "../../../../test/sav-qualification";
import { auditLogs, savActions, savDecisions, savIntakeConsole, savIntakeExecutions, savMailboxes, savMessages, savSyncState, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { SAV_V0_CUTOVER_KEY } from "../cutover";
import { findSavExternalCompletion, getSavExternalCompletion, markSavDossiersHandledExternally, revertSavExternalCompletionBatch,
  SAV_EXTERNAL_COMPLETION, SAV_EXTERNAL_COMPLETION_REVERTED } from "../external-completion";
import { listIntakeConsole, projectIntakeThread, refreshIntakeConsole } from "./console-store";
import { readIntakeConsoleDetail } from "./console-detail";

describe("marker validation (pure)", () => {
  const message = { id: randomUUID(), threadId: randomUUID(), receivedAt: new Date("2026-10-20T10:00:00Z") };
  const marker = (patch: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({ id: randomUUID(), actorEmail: "ugo@limova.ai", action: SAV_EXTERNAL_COMPLETION,
    entityType: "sav_message", entityId: message.id, createdAt: new Date("2026-10-22T10:00:00Z"),
    technicalMetadata: { version: 1, threadId: message.threadId, batchId: randomUUID(), receivedBefore: "2026-10-21T00:00:00Z", reason: "processed_outside_studio", ...metadata }, ...patch });
  const revert = (completionId: string, patch: Record<string, unknown> = {}) => ({ id: randomUUID(), actorEmail: "ugo@limova.ai", action: SAV_EXTERNAL_COMPLETION_REVERTED,
    entityType: "sav_message", entityId: message.id, createdAt: new Date("2026-10-23T10:00:00Z"), technicalMetadata: { version: 1, batchId: randomUUID(), completionId }, ...patch });

  it("[INV] A1 a well-formed marker by the authorised actor on the exact message/thread/boundary is recognised", () => {
    const m = marker();
    expect(findSavExternalCompletion(message, [m] as never)?.id).toBe(m.id);
    expect(findSavExternalCompletion(message, [marker({ actorEmail: "UGO@LIMOVA.AI" })] as never)).not.toBeNull();
  });

  it.each([
    ["wrong actor", marker({ actorEmail: "agent@limova.ai" })],
    ["wrong message", marker({ entityId: randomUUID() })],
    ["wrong entity type", marker({ entityType: "sav_thread" })],
    ["wrong thread", marker({}, { threadId: randomUUID() })],
    ["invalid boundary date", marker({}, { receivedBefore: "2026-13-40" })],
    ["boundary before receipt", marker({}, { receivedBefore: "2026-10-20T09:59:59Z" })],
    ["boundary equal to receipt", marker({}, { receivedBefore: "2026-10-20T10:00:00Z" })],
    ["wrong reason", marker({}, { reason: "ai_resolved" })],
    ["wrong version", marker({}, { version: 2 })],
    ["batch not uuid", marker({}, { batchId: "batch-1" })],
  ])("[INV] A2 %s is refused", (_name, event) => {
    expect(findSavExternalCompletion(message, [event] as never)).toBeNull();
  });

  const conforming = (m: ReturnType<typeof marker>, patch: Record<string, unknown> = {}) =>
    ({ ...revert(m.id, patch), technicalMetadata: { version: 1, batchId: m.technicalMetadata.batchId, completionId: m.id } });
  it("[INV] A3 only a conforming revocation of that exact completion removes it", () => {
    const m = marker();
    expect(findSavExternalCompletion(message, [m, conforming(m)] as never)).toBeNull();
    expect(findSavExternalCompletion(message, [m, revert(m.id, { actorEmail: "agent@limova.ai" })] as never)?.id).toBe(m.id);
    expect(findSavExternalCompletion(message, [m, revert(randomUUID())] as never)?.id).toBe(m.id);
    expect(findSavExternalCompletion(message, [m, revert(m.id, { entityId: randomUUID() })] as never)?.id).toBe(m.id);
    expect(findSavExternalCompletion(message, [m, conforming(m, { entityId: randomUUID() })] as never)?.id).toBe(m.id);
    expect(findSavExternalCompletion(message, [m, conforming(m, { actorEmail: "agent@limova.ai" })] as never)?.id).toBe(m.id);
  });

  targetIt("[CIBLE] A3b a revocation from another batch or dated before the marker does not remove it", () => {
    const m = marker();
    expect(findSavExternalCompletion(message, [m, revert(m.id)] as never)?.id).toBe(m.id);
    expect(findSavExternalCompletion(message, [m, conforming(m, { createdAt: new Date("2026-10-21T10:00:00Z") })] as never)?.id).toBe(m.id);
  });
});

describe("marking → projection → revocation → refresh", () => {
  let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
  const boundary = () => new Date(Date.now() - 1_000).toISOString();
  async function dossier(receivedAt = new Date(Date.now() - 60_000), analysisStatus = "intake_waiting") {
    const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid", subject: "Dossier synthétique" }).returning();
    const message = await inbound(thread.id, receivedAt, analysisStatus);
    return { thread, message };
  }
  async function inbound(threadId: string, receivedAt: Date, analysisStatus = "intake_waiting") {
    return (await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
      subject: "Dossier synthétique", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: "Demande synthétique.", attachments: [], headers: {} }),
      receivedAt, analysisStatus }).returning())[0];
  }
  const batch = (rows: { thread: { id: string }; message: { id: string } }[], batchId = randomUUID()) => ({ batchId, receivedBefore: boundary(),
    messages: rows.map(r => ({ threadId: r.thread.id, messageId: r.message.id })) });
  const completedIds = async () => (await listIntakeConsole({ view: "completed" })).rows.map(r => r.threadId);

  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
  afterAll(async () => { await f?.client.close(); });
  beforeEach(async () => {
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-admin-qualification-key-32-chars");
    vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
    await f.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE public.audit_logs; DELETE FROM sav.sync_state WHERE key in ('sav-v0-cutover','sav-intake-console-schema-v1')");
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
    await f.db.insert(savSyncState).values([{ key: SAV_V0_CUTOVER_KEY, status: "active", cursor: JSON.stringify({ mailboxEmail: "support@example.invalid", receivedAfter: new Date(Date.now() - 86_400_000).toISOString() }) },
      { key: "sav-intake-console-schema-v1", status: "installed" }]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("[INV] A4 refuses a forged actor and a future boundary before writing anything", async () => {
    const row = await dossier();
    await expect(markSavDossiersHandledExternally(batch([row]), "agent@limova.ai")).rejects.toThrow("FORBIDDEN");
    await expect(markSavDossiersHandledExternally({ ...batch([row]), receivedBefore: new Date(Date.now() + 60_000).toISOString() }, "ugo@limova.ai")).rejects.toThrow("FUTURE_BOUNDARY");
    expect(await f.db.select().from(auditLogs)).toHaveLength(0);
  });

  it("[INV] A5 a newer inbound after classification is never hidden nor covered by the old marker", async () => {
    const row = await dossier();
    expect(await markSavDossiersHandledExternally(batch([row]), "ugo@limova.ai")).toMatchObject({ marked: 1 });
    expect(await getSavExternalCompletion(row.message)).not.toBeNull();
    const fresh = await inbound(row.thread.id, new Date());
    expect(await getSavExternalCompletion(row.message)).toBeNull();
    expect(await getSavExternalCompletion(fresh)).toBeNull();
    await refreshIntakeConsole(50);
    expect(await completedIds()).not.toContain(row.thread.id);
  });

  it("[INV] A6 an administrative marker writes no decision, action, ticket change or execution", async () => {
    const row = await dossier();
    const before = (await f.db.select().from(savThreads).where(eq(savThreads.id, row.thread.id)))[0];
    await markSavDossiersHandledExternally(batch([row]), "ugo@limova.ai");
    expect(await f.db.select().from(savDecisions)).toHaveLength(0);
    expect(await f.db.select().from(savActions)).toHaveLength(0);
    expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
    const after = (await f.db.select().from(savThreads).where(eq(savThreads.id, row.thread.id)))[0];
    expect({ ticket: after.hubspotTicketId, status: after.status, paused: after.aiPaused }).toEqual({ ticket: before.hubspotTicketId, status: before.status, paused: before.aiPaused });
  });

  it("[INV] A7 a pending human command keeps the dossier out of Terminés", async () => {
    const row = await dossier();
    await f.db.insert(savActions).values({ threadId: row.thread.id, messageId: row.message.id, kind: "request_human", actorType: "human", status: "pending", idempotencyKey: `q-${row.message.id}`, payload: {} });
    expect(await markSavDossiersHandledExternally(batch([row]), "ugo@limova.ai")).toMatchObject({ marked: 0, skipped: { unsettled_action: 1 } });
    await refreshIntakeConsole(50);
    expect(await completedIds()).not.toContain(row.thread.id);
  });

  it("[REPRO→NR] A8: base ignores the marker in the intake console; fixed code shows it in Terminés", async () => {
    const row = await dossier();
    await markSavDossiersHandledExternally(batch([row]), "ugo@limova.ai");
    await projectIntakeThread(row.thread.id);
    if (process.env.SAV_QUALIFICATION_TARGET === "1") { expect(await completedIds()).toContain(row.thread.id); return; }
    expect(await completedIds()).not.toContain(row.thread.id);
  });

  targetIt("[CIBLE] A9 marking alone dirties the projection: refresh shows Terminés with consistent counts", async () => {
    const rows = await Promise.all(Array.from({ length: 29 }, () => dossier()));
    const other = await dossier();
    await refreshIntakeConsole(50); await refreshIntakeConsole(50);
    expect(await markSavDossiersHandledExternally(batch(rows), "ugo@limova.ai")).toMatchObject({ marked: 29 });
    // No message/thread/run write after the marker: only the marker can explain a new view.
    await refreshIntakeConsole(50); await refreshIntakeConsole(50);
    const list = await listIntakeConsole({ view: "completed" });
    expect(list.total).toBe(29);
    expect(list.counts.completed).toBe(29);
    expect(list.pages).toBe(2);
    const second = await listIntakeConsole({ view: "completed", page: 2 });
    expect(new Set([...list.rows, ...second.rows].map(r => r.threadId)).size).toBe(29);
    expect([...list.rows, ...second.rows].map(r => r.threadId)).not.toContain(other.thread.id);
    for (const r of [...list.rows, ...second.rows]) {
      expect(r.status).not.toMatch(/summary_finished|confirmed|resolved|learning|closed/i);
      expect(r.reason ?? "").not.toMatch(/résolu par l.IA|ticket fermé\b(?! par ce)/i);
    }
    const detail = await readIntakeConsoleDetail(rows[0].thread.id);
    expect(detail?.projection).toMatchObject({ view: "completed" });
    expect(JSON.stringify(detail?.projection)).not.toMatch(/summary_finished|confirmed|resolved|learning/i);
  });

  targetIt("[CIBLE] A10 revocation then refresh restores the previous view without manual touch", async () => {
    const row = await dossier(), input = batch([row]);
    await markSavDossiersHandledExternally(input, "ugo@limova.ai");
    await refreshIntakeConsole(50);
    expect(await completedIds()).toContain(row.thread.id);
    expect(await revertSavExternalCompletionBatch(input.batchId, "ugo@limova.ai")).toEqual({ reverted: 1 });
    await refreshIntakeConsole(50);
    expect(await completedIds()).not.toContain(row.thread.id);
    // A reverted batch is not silently re-applied on retry.
    expect(await markSavDossiersHandledExternally(input, "ugo@limova.ai")).toMatchObject({ marked: 0, skipped: { previously_applied_batch: 1 } });
  });

  it("[INV] A11 list and counts come from one snapshot and agree before pagination", async () => {
    await Promise.all(Array.from({ length: 30 }, () => dossier()));
    await refreshIntakeConsole(50);
    const page1 = await listIntakeConsole({ view: "processing" }), page2 = await listIntakeConsole({ view: "processing", page: 2 });
    expect(page1.total).toBe(30);
    expect(page1.rows.length + page2.rows.length).toBe(30);
    expect(Object.values(page1.counts).reduce((a, b) => a + b, 0)).toBe((await f.db.select().from(savIntakeConsole)).length);
  });
});

describe("human holds and new entrants (PR158)", () => {
  let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
  afterAll(async () => { await f?.client.close(); });
  beforeEach(async () => {
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-admin-qualification-key-32-chars");
    vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
    await f.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE public.audit_logs; DELETE FROM sav.sync_state WHERE key in ('sav-v0-cutover','sav-intake-console-schema-v1')");
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
    await f.db.insert(savSyncState).values([{ key: SAV_V0_CUTOVER_KEY, status: "active", cursor: JSON.stringify({ mailboxEmail: "support@example.invalid", receivedAfter: new Date(Date.now() - 86_400_000).toISOString() }) },
      { key: "sav-intake-console-schema-v1", status: "installed" }]);
  });
  afterEach(() => vi.unstubAllEnvs());
  async function heldDossier(byHuman = true) {
    const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid", subject: "Dossier équipe", aiPaused: true }).returning();
    const [message] = await f.db.insert(savMessages).values({ mailboxId, threadId: thread.id, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
      subject: "Dossier équipe", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: "Demande synthétique.", attachments: [], headers: {} }),
      receivedAt: new Date(Date.now() - 60_000), analysisStatus: "intake_waiting" }).returning();
    await f.db.insert(savActions).values({ threadId: thread.id, messageId: message.id, kind: "request_human", actorType: byHuman ? "human" : "ai", status: "succeeded", idempotencyKey: `hold-${message.id}`, payload: {} });
    return { thread, message };
  }
  targetIt("[CIBLE] A12 14 team-reserved dossiers appear in À valider with a reason; pause kept; no execution", async () => {
    const rows = await Promise.all(Array.from({ length: 14 }, () => heldDossier()));
    const aiOnly = await heldDossier(false);
    await refreshIntakeConsole(50); await refreshIntakeConsole(50);
    const { releaseLegacyAiPauses } = await import("./legacy-pause");
    await releaseLegacyAiPauses({ mailboxId, receivedAfter: new Date(Date.now() - 3_600_000).toISOString(), createdAfter: new Date(Date.now() - 3_600_000).toISOString() });
    const list = await listIntakeConsole({ view: "to_validate" });
    expect(list.total).toBe(14);
    expect(list.counts.to_validate).toBe(14);
    expect(list.rows.map(r => r.threadId)).not.toContain(aiOnly.thread.id);
    for (const r of list.rows) { expect(r.status).toBe("human_hold"); expect(r.reason).toBeTruthy(); }
    const threads = await f.db.select().from(savThreads);
    for (const r of rows) expect(threads.find(t => t.id === r.thread.id)!.aiPaused).toBe(true);
    expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
    expect((await readIntakeConsoleDetail(rows[0].thread.id))?.projection).toMatchObject({ view: "to_validate" });
  });
  targetIt("[CIBLE] A14 a new message after classification does not inherit the old disposition (list, counts, detail)", async () => {
    const { thread, message } = await heldDossier();
    await f.db.update(savThreads).set({ aiPaused: false }).where(eq(savThreads.id, thread.id));
    await f.db.delete(savActions);
    const batchId = randomUUID();
    await markSavDossiersHandledExternally({ batchId, receivedBefore: new Date(Date.now() - 1_000).toISOString(), messages: [{ threadId: thread.id, messageId: message.id }] }, "ugo@limova.ai");
    await refreshIntakeConsole(50);
    expect((await listIntakeConsole({ view: "completed" })).total).toBe(1);
    await f.db.insert(savMessages).values({ mailboxId, threadId: thread.id, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
      subject: "Relance", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: "Nouvelle demande.", attachments: [], headers: {} }), receivedAt: new Date(), analysisStatus: "intake_waiting" });
    await refreshIntakeConsole(50);
    const completed = await listIntakeConsole({ view: "completed" }), processing = await listIntakeConsole({ view: "processing" });
    expect(completed.total).toBe(0);
    expect(completed.counts.completed ?? 0).toBe(0);
    expect(processing.rows.map(r => r.threadId)).toContain(thread.id);
    expect((await readIntakeConsoleDetail(thread.id))?.projection.view ?? null).not.toBe("completed");
  });
});
