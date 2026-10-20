import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
const state = vi.hoisted(() => ({ db: null as unknown, opened: vi.fn(), start: vi.fn(), auth: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./opened-email", () => ({ recordSavEmailOpened: state.opened }));
vi.mock("./auth", () => ({ requireSavApiStaff: state.auth }));
vi.mock("workflow/api", () => ({ start: state.start }));
vi.mock("@/workflows/sav-commands", () => ({ executeSavEmailOpeningWorkflow: vi.fn(), refreshSavContextWorkflow: vi.fn(), executeSavTicketCommandWorkflow: vi.fn() }));
import { GET } from "../../app/api/internal/sav/dossiers/[id]/status/route";
import { executeSavEmailOpening, requestSavEmailOpening } from "./email-opening-command";
import { dispatchPendingSavEmailOpenings, dispatchSavEmailOpening, enqueueSavContextRefresh, processPendingSavContextRefreshes } from "./dispatch";
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let input: { threadId: string; messageId: string };
const actor = "ugo@limova.ai";
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => fixture?.client.close());
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
  state.opened.mockReset(); state.start.mockReset(); state.auth.mockReset(); state.auth.mockResolvedValue({ email: actor, role: "admin" });
  state.opened.mockImplementation(async (_input, _actor, command) => { await command.beforeModify(); return { notice: "filed" }; });
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: actor });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "fixture-navigation", customerEmail: "fixture@example.invalid" }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, gmailMessageId: "fixture-message", direction: "inbound", fromEmail: thread.customerEmail, bodyCiphertext: "fixture", receivedAt: new Date("2026-10-03") }).returning();
  input = { threadId: thread.id, messageId: message.id };
});
async function command(id: string) { return (await fixture.db.select().from(auditLogs).where(eq(auditLogs.id, id)))[0]; }
async function expire(id: string, metadata: Record<string, unknown>) {
  await fixture.db.update(auditLogs).set({ technicalMetadata: { version: 1, threadId: input.threadId, state: "running", leaseUntil: "2000-01-01T00:00:00Z", ...metadata } }).where(eq(auditLogs.id, id));
}
describe("durable opening command", () => {
  it("commits one intent and consultation without calling providers, and deduplicates repeated clicks", async () => {
    const first = await requestSavEmailOpening(input, actor), second = await requestSavEmailOpening(input, actor);
    expect(second.commandId).toBe(first.commandId); expect(state.opened).not.toHaveBeenCalled();
    expect((await command(first.commandId)).technicalMetadata.state).toBe("pending");
    expect((await fixture.db.select().from(savMessages))[0].studioOpenedAt).not.toBeNull();
  });
  it("serializes simultaneous clicks and worker claims", async () => {
    const commands = await Promise.all(Array.from({ length: 3 }, () => requestSavEmailOpening(input, actor)));
    expect(new Set(commands.map(row => row.commandId)).size).toBe(1);
    await Promise.all(commands.map(row => executeSavEmailOpening(row.commandId)));
    expect(state.opened).toHaveBeenCalledTimes(1);
  });
  it("authenticates and binds the exact source before committing", async () => {
    await expect(requestSavEmailOpening(input, "unknown@example.invalid")).rejects.toThrow("FORBIDDEN");
    await expect(requestSavEmailOpening({ ...input, threadId: "10000000-0000-4000-8000-000000000001" }, actor)).rejects.toThrow("SOURCE_INVALID");
    expect(await fixture.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_email_opening_requested"))).toHaveLength(0);
  });
  it("persists dispatch before the effect, preserves its proof and never replays a completed command", async () => {
    const { commandId } = await requestSavEmailOpening(input, actor);
    expect(await executeSavEmailOpening(commandId)).toEqual({ notice: "filed" });
    const row = await command(commandId);
    expect(row.technicalMetadata).toMatchObject({ state: "completed", notice: "filed" });
    expect(row.technicalMetadata.dispatchedAt).toBeTruthy();
    await executeSavEmailOpening(commandId); expect(state.opened).toHaveBeenCalledTimes(1);
    expect(state.opened.mock.calls[0].slice(0, 2)).toEqual([input, actor]);
  });
  it("keeps a live lease pending and resumes an expired pre-dispatch claim", async () => {
    const { commandId } = await requestSavEmailOpening(input, actor);
    await expire(commandId, { leaseUntil: "2099-01-01T00:00:00Z" });
    expect(await executeSavEmailOpening(commandId)).toEqual({ notice: "pending" }); expect(state.opened).not.toHaveBeenCalled();
    await expire(commandId, {}); expect(await executeSavEmailOpening(commandId)).toEqual({ notice: "filed" });
  });
  it("does not replay an expired dispatched effect without a final receipt", async () => {
    const { commandId } = await requestSavEmailOpening(input, actor);
    await expire(commandId, { state: "dispatching", dispatchedAt: "2026-10-19T10:00:00Z" });
    expect(await executeSavEmailOpening(commandId)).toEqual({ notice: "SAV_GMAIL_FILING_UNCERTAIN" });
    expect(state.opened).not.toHaveBeenCalled(); expect((await command(commandId)).technicalMetadata.state).toBe("uncertain");
  });
  it("recovers a committed receipt if the outer acknowledgment was lost", async () => {
    const { commandId } = await requestSavEmailOpening(input, actor);
    await expire(commandId, { dispatchedAt: "2026-10-19T10:00:00Z" });
    await fixture.db.insert(auditLogs).values({ actorEmail: actor, entityType: "sav_message", entityId: input.messageId, action: "sav_email_opened", technicalMetadata: { openingCommandId: commandId, gmailFilingStatus: "succeeded", alreadyFiled: true } });
    expect(await executeSavEmailOpening(commandId)).toEqual({ notice: "already_filed" }); expect(state.opened).not.toHaveBeenCalled();
  });
  it("fences a stale worker before its provider effect", async () => {
    const { commandId } = await requestSavEmailOpening(input, actor);
    state.opened.mockImplementation(async (_input, _actor, worker) => {
      await expire(commandId, { leaseToken: "replacement" });
      await worker.beforeModify(); throw new Error("effect must not be reached");
    });
    expect(await executeSavEmailOpening(commandId)).toEqual({ notice: "pending" });
    expect((await command(commandId)).technicalMetadata.leaseToken).toBe("replacement");
  });
  it("recovers a lost SDK dispatch, without doing provider work in cron", async () => {
    const { commandId } = await requestSavEmailOpening(input, actor);
    await dispatchPendingSavEmailOpenings(); await dispatchSavEmailOpening(commandId);
    expect(state.start).toHaveBeenCalledTimes(1); expect(state.opened).not.toHaveBeenCalled();
  });
});
describe("durable read-only context refresh", () => {
  it("persists before scheduling and deduplicates in-flight work for the same source", async () => {
    const schedule = vi.fn();
    const id = await enqueueSavContextRefresh(input.threadId, actor, schedule);
    expect(state.start).not.toHaveBeenCalled(); expect(schedule).toHaveBeenCalledTimes(1);
    expect(await enqueueSavContextRefresh(input.threadId, actor, schedule)).toBe(id); expect(schedule).toHaveBeenCalledTimes(1);
    expect((await fixture.db.select().from(auditLogs)).filter(r => r.action === "sav_context_refresh_requested")).toHaveLength(1);
    await schedule.mock.calls[0][0](); expect(state.start).toHaveBeenCalledTimes(1);
  });
  it("leaves a failed SDK dispatch recoverable and respects terminal receipts", async () => {
    state.start.mockRejectedValue(new Error("fixture SDK unavailable"));
    const id = await enqueueSavContextRefresh(input.threadId, actor);
    const [request] = await fixture.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_context_refresh_requested"));
    await fixture.db.update(auditLogs).set({ createdAt: new Date(Date.now() - 600_000) }).where(eq(auditLogs.id, request.id));
    state.start.mockResolvedValue({});
    expect(await processPendingSavContextRefreshes()).toEqual({ dispatched: 1 });
    expect(await processPendingSavContextRefreshes()).toEqual({ dispatched: 0 });
    await fixture.db.insert(auditLogs).values({ actorEmail: actor, action: "sav_context_refresh_completed", entityType: "sav_context_refresh", entityId: id, technicalMetadata: { threadId: input.threadId } });
    expect(await processPendingSavContextRefreshes()).toEqual({ dispatched: 0 });
    expect(await enqueueSavContextRefresh(input.threadId, actor)).not.toBe(id);
  });
});

it("exposes private no-store command status and prioritizes terminal context receipts", async () => {
  const { commandId } = await requestSavEmailOpening(input, actor);
  const refreshId = await enqueueSavContextRefresh(input.threadId, actor, () => {});
  await fixture.db.insert(auditLogs).values([
    { actorEmail: actor, action: "sav_context_refresh_completed", entityType: "sav_context_refresh", entityId: refreshId, technicalMetadata: { threadId: input.threadId }, createdAt: new Date("2026-10-18") },
    { actorEmail: actor, action: "sav_context_refresh_redispatched", entityType: "sav_context_refresh", entityId: refreshId, technicalMetadata: { threadId: input.threadId } },
  ]);
  const response = await GET(new Request(`http://localhost/api/status?filingId=${commandId}&refreshId=${refreshId}`), { params: Promise.resolve({ id: input.threadId }) });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ context: "completed", filing: { state: "pending", notice: "pending" } });
  await executeSavEmailOpening(commandId);
  const completed = await GET(new Request(`http://localhost/api/status?filingId=${commandId}`), { params: Promise.resolve({ id: input.threadId }) });
  expect(await completed.json()).toMatchObject({ filing: { state: "completed", notice: "filed" } });
});
it("authenticates status reads and rejects malformed command IDs", async () => {
  state.auth.mockRejectedValueOnce(new Error("SAV_ACCESS_FORBIDDEN"));
  await expect(GET(new Request("http://localhost/api/status"), { params: Promise.resolve({ id: input.threadId }) })).rejects.toThrow("FORBIDDEN");
  const invalid = await GET(new Request("http://localhost/api/status?filingId=invalid"), { params: Promise.resolve({ id: input.threadId }) });
  expect(invalid.status).toBe(400);
});
