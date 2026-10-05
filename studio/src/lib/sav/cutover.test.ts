import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savSyncState, savThreads, savWebhookReceipts } from "@/db/schema";
import { activateSavV0Cutover, getSavV0Cutover, isSavMessageEligible, SAV_V0_CUTOVER_KEY } from "./cutover";
import { correctSavDecision, ingestInboundMessage, listSavPilotCandidates, processPendingSavMessages, processStoredSavMessage, recordWebhookReceipt } from "./service";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { processGmailReceipt } from "./gmail";

const state = vi.hoisted(() => ({ db: null as unknown, crm: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./hubspot", async (importOriginal) => ({ ...await importOriginal<typeof import("./hubspot")>(), readSavHubspotContext: state.crm }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string;
let threadId: string;
const boundary = { receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: "contact@limova.ai", intakeRecipient: "contact@limova.ai" as const, deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" };
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  state.crm.mockResolvedValue({ contactFound: true, contactId: "contact-fixture", tickets: [], routing: { kind: "new", reason: "no_open_ticket", candidateIds: [] } });
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false"); vi.stubEnv("SAV_AI_ANALYSIS", "false");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters");
  await fixture.client.exec('TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE sav.webhook_receipts CASCADE; TRUNCATE audit_logs');
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: boundary.mailboxEmail }).returning(); mailboxId = mailbox.id;
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId, gmailThreadId: "fixture-thread", customerEmail: "customer@example.com" }).returning(); threadId = thread.id;
});
async function message(receivedAt: string, selectedMailboxId = mailboxId, selectedThreadId = threadId) {
  const [row] = await fixture.db.insert(savMessages).values({ mailboxId: selectedMailboxId, threadId: selectedThreadId, gmailMessageId: crypto.randomUUID(), direction: "inbound", fromEmail: "customer@example.com", receivedAt: new Date(receivedAt), bodyCiphertext: encryptSavPayload({ text: "Comment retrouver mes factures ?" }) }).returning();
  return row;
}
describe("immutable post-deployment SAV V0 cutover", () => {
  it("fails closed before activation without marking old messages processed", async () => {
    const old = await message("2026-10-02T11:59:59Z");
    expect(await isSavMessageEligible(old.id)).toBe(false);
    expect(await processStoredSavMessage(old.id)).toBeNull();
    expect((await processPendingSavMessages()).processed).toEqual([]);
    const [stored] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, old.id));
    expect(stored).toMatchObject({ processedAt: null, analysisAttempts: 0 });
  });
  it("audits one activation, is retry-safe and cannot move its boundary", async () => {
    await activateSavV0Cutover(boundary); await activateSavV0Cutover(boundary);
    expect(await getSavV0Cutover()).toEqual(boundary);
    expect(await fixture.db.select().from(auditLogs)).toHaveLength(1);
    await expect(activateSavV0Cutover({ ...boundary, receivedAfter: "2026-10-02T11:00:00Z" })).rejects.toThrow("SAV_CUTOVER_IMMUTABLE");
    await expect(activateSavV0Cutover({ ...boundary, activatedBy: "someone@example.com" })).rejects.toThrow("SAV_CUTOVER_UGO_APPROVAL_REQUIRED");
  });
  it("uses received time, not sync time, and recovers only post-boundary mail", async () => {
    await activateSavV0Cutover(boundary);
    const old = await message("2026-10-02T11:59:59Z");
    const exact = await message(boundary.receivedAfter);
    const fresh = await message("2026-10-02T12:00:01Z");
    expect(await isSavMessageEligible(old.id)).toBe(false); expect(await isSavMessageEligible(exact.id)).toBe(false);
    expect(await isSavMessageEligible(fresh.id)).toBe(true);
    expect((await listSavPilotCandidates()).map((row) => row.id)).toEqual([fresh.id]);
    const pass = await processPendingSavMessages(); expect(pass.processed).toHaveLength(1);
    expect((await processPendingSavMessages()).processed).toHaveLength(0);
    expect(await fixture.db.select().from(savDecisions)).toHaveLength(1);
    const [storedOld] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, old.id)); expect(storedOld.processedAt).toBeNull();
  });
  it("does not opt another mailbox into the support flow", async () => {
    await activateSavV0Cutover(boundary);
    const [other] = await fixture.db.insert(savMailboxes).values({ email: "personal@example.com" }).returning();
    const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: other.id, gmailThreadId: "other", customerEmail: "other@example.com" }).returning();
    const row = await message("2026-10-02T12:00:01Z", other.id, thread.id);
    expect(await isSavMessageEligible(row.id)).toBe(false);
  });
  it("a delayed historical arrival preserves the current draft and human state", async () => {
    await activateSavV0Cutover(boundary);
    const fresh = await message("2026-10-02T12:00:01Z");
    const [draft] = await fixture.db.insert(savActions).values({ threadId, messageId: fresh.id, kind: "draft_reply", status: "succeeded", idempotencyKey: "current-draft" }).returning();
    const result = await ingestInboundMessage({ mailboxEmail: boundary.mailboxEmail, gmailMessageId: "old-delayed", gmailThreadId: "fixture-thread", from: "customer@example.com", to: ["contact@limova.ai"], bodyText: "Je veux un humain", receivedAt: "2026-10-02T11:00:00Z" });
    expect(result).toMatchObject({ excludedFromProposals: true, proposalSkipReason: "before_cutover" });
    const [stored] = await fixture.db.select().from(savActions).where(eq(savActions.id, draft.id)); expect(stored.status).toBe("succeeded");
    const [thread] = await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId)); expect(thread.aiPaused).toBe(false);
  });
  it("does not reset activation when the runtime restarts or variables change", async () => {
    await activateSavV0Cutover(boundary);
    vi.stubEnv("SAV_V0_DEPLOYED_AT", "2030-01-01T00:00:00Z");
    expect(await getSavV0Cutover()).toEqual(boundary);
    const [persisted] = await fixture.db.select().from(savSyncState).where(eq(savSyncState.key, SAV_V0_CUTOVER_KEY)); expect(persisted.status).toBe("active");
  });
  it("persists automation headers and deduplicates classification on receipt retry", async () => {
    await activateSavV0Cutover(boundary);
    const input = { mailboxEmail: boundary.mailboxEmail, gmailMessageId: "automated", gmailThreadId: "fixture-thread", from: "customer@example.com", to: ["contact@limova.ai"], subject: "Absence", bodyText: "Je reviens lundi", autoSubmitted: "auto-replied", receivedAt: "2026-10-02T12:01:00Z" };
    const first = await ingestInboundMessage(input);
    const second = await ingestInboundMessage(input);
    expect(second.duplicate).toBe(true);
    const [decision] = await fixture.db.select().from(savDecisions);
    expect(decision).toMatchObject({ kind: "automatic_reply", reasonCode: "automated_sender_reply" });
    expect(await fixture.db.select().from(savDecisions)).toHaveLength(1);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    expect(decryptSavPayload<{ headers: Record<string, string> }>(first.message.bodyCiphertext).headers["auto-submitted"]).toBe("auto-replied");
  });
  it("human correction supersedes one decision and cancels its queued actions", async () => {
    await activateSavV0Cutover(boundary);
    const fresh = await message("2026-10-02T12:00:01Z");
    const first = await processStoredSavMessage(fresh.id);
    const [run] = await fixture.db.select().from(savAgentRuns);
    expect(run.knowledgeRevision).toBe("not_consulted");
    expect(run.proposalCiphertext).toBeTruthy();
    expect(decryptSavPayload<{ routing: { kind: string }; ticket: { description: string } }>(run.proposalCiphertext!)).toMatchObject({ routing: { kind: "new" }, ticket: { description: "Comment retrouver mes factures ?" } });
    expect(first).not.toBeNull();
    const corrected = await correctSavDecision(first!.id, { kind: "no_ticket_needed", reasonCode: "ugo_correction", explanation: "Cet email ne nécessite pas de nouveau ticket." }, "ugo@limova.ai");
    expect(corrected).toMatchObject({ isCurrent: true, actorType: "human", supersedesDecisionId: first!.id });
    const decisions = await fixture.db.select().from(savDecisions);
    expect(decisions.filter((row) => row.isCurrent)).toHaveLength(1);
    const actions = await fixture.db.select().from(savActions).where(eq(savActions.kind, "create_ticket"));
    expect(actions).toHaveLength(1); expect(actions[0]).toMatchObject({ status: "cancelled", errorCode: "SAV_DECISION_SUPERSEDED" });
    await expect(correctSavDecision(first!.id, { kind: "spam", reasonCode: "old_correction", explanation: "Tentative de correction d’une décision obsolète." }, "ugo@limova.ai")).rejects.toThrow("SAV_DECISION_NOT_CURRENT");
  });
  it("a non-support message does not close a paused or linked customer dossier", async () => {
    await activateSavV0Cutover(boundary);
    await fixture.db.update(savThreads).set({ aiPaused: true, status: "human_processing", hubspotTicketId: "fixture-ticket" }).where(eq(savThreads.id, threadId));
    await ingestInboundMessage({ mailboxEmail: boundary.mailboxEmail, gmailMessageId: "thanks", gmailThreadId: "fixture-thread", from: "customer@example.com", subject: "Re: aide", bodyText: "Merci beaucoup !", receivedAt: "2026-10-02T12:01:00Z" });
    const [thread] = await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId));
    expect(thread).toMatchObject({ aiPaused: true, status: "human_processing", hubspotTicketId: "fixture-ticket" });
    const [decision] = await fixture.db.select().from(savDecisions); expect(decision.kind).toBe("no_ticket_needed");
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("persists recovery pagination and only advances history after the complete scan", async () => {
    await activateSavV0Cutover(boundary);
    for (const name of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]) vi.stubEnv(name, "fixture");
    const pages: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "fixture", expires_in: 3600 });
      if (url.pathname.endsWith("/messages")) {
        pages.push(url);
        return Response.json(pages.length === 1 ? { messages: [], nextPageToken: "page-2" } : { messages: [] });
      }
      throw new Error("Unexpected network call");
    }));
    const { receipt } = await recordWebhookReceipt("gmail", "recovery", { emailAddress: boundary.mailboxEmail, historyId: "12345" });
    await processGmailReceipt(receipt.id);
    const [first] = await fixture.db.select().from(savMailboxes).where(eq(savMailboxes.id, mailboxId)); expect(first.historyId).toBeNull();
    const [pending] = await fixture.db.select().from(savWebhookReceipts).where(eq(savWebhookReceipts.id, receipt.id)); expect(pending).toMatchObject({ status: "pending", errorCode: null });
    await processGmailReceipt(receipt.id);
    const [finished] = await fixture.db.select().from(savMailboxes).where(eq(savMailboxes.id, mailboxId)); expect(finished.historyId).toBe("12345");
    expect(pages[0].searchParams.get("q")).toContain(`after:${Date.parse(boundary.receivedAfter) / 1_000}`);
    expect(pages[0].searchParams.has("labelIds")).toBe(false);
    expect(pages[1].searchParams.get("pageToken")).toBe("page-2");
    expect(pages[1].searchParams.get("q")).toBe(pages[0].searchParams.get("q"));
  });
});
