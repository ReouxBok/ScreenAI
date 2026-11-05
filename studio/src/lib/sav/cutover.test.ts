import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savPilotBatches, savPilotItems, savSyncState, savThreads, savWebhookReceipts } from "@/db/schema";
import { activateSavV0Cutover, getSavV0Cutover, isSavMessageEligible, SAV_V0_CUTOVER_KEY } from "./cutover";
import { correctSavDecisionArchived as correctSavDecision, ingestInboundMessage, listSavPilotCandidates, processPendingSavMessages, processPendingSavPilotItems, processSavPilotItem, processStoredSavMessage, recordWebhookReceipt, repairSavProposal, retrySavAnalysis, startSavPilotBatch, updateMailboxWatch, updateMailboxCursor } from "./service";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { parseGmailMessage, processGmailReceipt } from "./gmail";

import { understandingFixture } from "../../../test/sav-understanding-fixtures";

const state = vi.hoisted(() => ({ db: null as unknown, crm: vi.fn(), understand: vi.fn() }));
vi.mock("./understanding-model", async (original) => ({ ...await original<typeof import("./understanding-model")>(), understandSavMessage: state.understand }));
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
  state.understand.mockReset();
  state.understand.mockImplementation(async (...args) => (await vi.importActual<typeof import("./understanding-model")>("./understanding-model")).understandSavMessage(...args as Parameters<typeof import("./understanding-model").understandSavMessage>));
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
  it("renews the watch without advancing a consumed history cursor", async () => {
    await updateMailboxCursor(mailboxId, "90071992547409930");
    await updateMailboxWatch(boundary.mailboxEmail, "90071992547409999", new Date("2030-01-01T00:00:00Z"));
    const [mailbox] = await fixture.db.select().from(savMailboxes).where(eq(savMailboxes.id, mailboxId));
    expect(mailbox.historyId).toBe("90071992547409930"); expect(mailbox.watchStatus).toBe("active");
  });
  it("keeps a null cursor on watch renewal so initial recovery still runs", async () => {
    await updateMailboxWatch(boundary.mailboxEmail, "999999", new Date("2030-01-01T00:00:00Z"));
    const [mailbox] = await fixture.db.select().from(savMailboxes).where(eq(savMailboxes.id, mailboxId));
    expect(mailbox.historyId).toBeNull();
  });
  it("cannot regress the cursor when receipts finish out of order or exceed Number precision", async () => {
    await updateMailboxCursor(mailboxId, "90071992547409931");
    await updateMailboxCursor(mailboxId, "90071992547409930");
    await updateMailboxCursor(mailboxId, "90071992547409931");
    const [mailbox] = await fixture.db.select().from(savMailboxes).where(eq(savMailboxes.id, mailboxId));
    expect(mailbox.historyId).toBe("90071992547409931");
  });
  it("rejects malformed history IDs without changing the cursor", async () => {
    await expect(updateMailboxCursor(mailboxId, "1e9")).rejects.toThrow("GMAIL_HISTORY_ID_INVALID");
    const [mailbox] = await fixture.db.select().from(savMailboxes).where(eq(savMailboxes.id, mailboxId));
    expect(mailbox.historyId).toBeNull();
  });
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
    // The old V0 analysis is retired (SAV-9): eligible mail is recognised but nothing analyses it, however often the worker runs.
    expect(await processPendingSavMessages()).toEqual({ retired: true, processed: [] });
    expect(await processPendingSavMessages()).toEqual({ retired: true, processed: [] });
    expect(await fixture.db.select().from(savDecisions)).toHaveLength(0);
    const [storedOld] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, old.id)); expect(storedOld.processedAt).toBeNull();
    const [storedFresh] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, fresh.id));
    expect(storedFresh).toMatchObject({ processedAt: null, analysisStatus: "pending", analysisAttempts: 0 });
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
  it("persists automation headers and deduplicates the stored message on receipt retry; the retired analysis creates no decision", async () => {
    await activateSavV0Cutover(boundary);
    const input = { mailboxEmail: boundary.mailboxEmail, gmailMessageId: "automated", gmailThreadId: "fixture-thread", from: "customer@example.com", to: ["contact@limova.ai"], subject: "Absence", bodyText: "Je reviens lundi", headers: { "X-Studio-Automation-Headers": "singleton-v1", "x-studio-automation-body": "complete-plain-v1" }, autoSubmitted: "auto-replied", receivedAt: "2026-10-02T12:01:00Z" };
    const first = await ingestInboundMessage(input);
    const second = await ingestInboundMessage(input);
    expect(first).toMatchObject({ v0AnalysisRetired: true });
    expect(second.duplicate).toBe(true);
    expect(await fixture.db.select().from(savDecisions)).toHaveLength(0);
    expect(await fixture.db.select().from(savAgentRuns)).toHaveLength(0);
    expect(state.understand).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(savMessages)).toHaveLength(1);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    const storedHeaders = decryptSavPayload<{ headers: Record<string, string> }>(first.message.bodyCiphertext).headers;
    expect(storedHeaders["auto-submitted"]).toBe("auto-replied");
    expect(storedHeaders).not.toHaveProperty("x-studio-automation-headers");
    expect(storedHeaders).not.toHaveProperty("x-studio-automation-body");
  });
  it("human correction supersedes one decision and cancels its queued actions", async () => {
    await activateSavV0Cutover(boundary);
    const fresh = await message("2026-10-02T12:00:01Z");
    // The retired analysis creates nothing any more: this is a decision and a queued action of the old engine that already exist.
    expect(await processStoredSavMessage(fresh.id)).toBeNull();
    expect(await fixture.db.select().from(savAgentRuns)).toHaveLength(0);
    const [first] = await fixture.db.insert(savDecisions).values({ messageId: fresh.id, kind: "ticket_pending", reasonCode: "new_support_request", explanation: "Nouvelle demande de support.", confidence: 900, model: "rules-v1", actorType: "ai" }).returning();
    await fixture.db.insert(savActions).values({ threadId, messageId: fresh.id, decisionId: first.id, kind: "create_ticket", status: "pending", idempotencyKey: `existing:create_ticket:${fresh.id}`, actorType: "ai" });
    const corrected = await correctSavDecision(first.id, { kind: "no_ticket_needed", reasonCode: "ugo_correction", explanation: "Cet email ne nécessite pas de nouveau ticket." }, "ugo@limova.ai");
    expect(corrected).toMatchObject({ isCurrent: true, actorType: "human", supersedesDecisionId: first.id });
    const decisions = await fixture.db.select().from(savDecisions);
    expect(decisions.filter((row) => row.isCurrent)).toHaveLength(1);
    const actions = await fixture.db.select().from(savActions).where(eq(savActions.kind, "create_ticket"));
    expect(actions).toHaveLength(1); expect(actions[0]).toMatchObject({ status: "cancelled", errorCode: "SAV_DECISION_SUPERSEDED" });
    await expect(correctSavDecision(first.id, { kind: "spam", reasonCode: "old_correction", explanation: "Tentative de correction d’une décision obsolète." }, "ugo@limova.ai")).rejects.toThrow("SAV_DECISION_NOT_CURRENT");
  });
  it("a non-support message does not close a paused or linked customer dossier", async () => {
    const understood = understandingFixture();
    understood.requests[0] = { ...understood.requests[0], nature: "acknowledgement", summary: "Remercier le support." };
    understood.evidence[0].excerpt = "Merci beaucoup !";
    state.understand.mockResolvedValueOnce(understood);
    await activateSavV0Cutover(boundary);
    await fixture.db.update(savThreads).set({ aiPaused: true, status: "human_processing", hubspotTicketId: "fixture-ticket" }).where(eq(savThreads.id, threadId));
    await ingestInboundMessage({ mailboxEmail: boundary.mailboxEmail, gmailMessageId: "thanks", gmailThreadId: "fixture-thread", from: "customer@example.com", subject: "Re: aide", bodyText: "Merci beaucoup !", receivedAt: "2026-10-02T12:01:00Z" });
    const [thread] = await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId));
    expect(thread).toMatchObject({ aiPaused: true, status: "human_processing", hubspotTicketId: "fixture-ticket" });
    // The retired analysis neither understands the mail nor decides anything: the dossier is exactly as the person left it.
    expect(state.understand).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(savDecisions)).toHaveLength(0);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it.each(["human_requested", "human_processing"] as const)("preserves %s and its deadline when a follow-up cannot be understood", async (status) => {
    await activateSavV0Cutover(boundary);
    const requestedAt = new Date("2026-10-02T12:00:00Z"), dueAt = new Date("2026-10-05T12:00:00Z");
    await fixture.db.update(savThreads).set({ aiPaused: true, status, humanRequestedAt: requestedAt, humanDueAt: dueAt, hubspotTicketId: "fixture-ticket" }).where(eq(savThreads.id, threadId));
    await ingestInboundMessage({ mailboxEmail: boundary.mailboxEmail, gmailMessageId: "unavailable-follow-up", gmailThreadId: "fixture-thread", from: "customer@example.com", subject: "Re: aide", bodyText: "Merci beaucoup !", receivedAt: "2026-10-02T12:01:00Z" });
    const [thread] = await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId));
    expect(thread).toMatchObject({ aiPaused: true, status, humanRequestedAt: requestedAt, humanDueAt: dueAt, hubspotTicketId: "fixture-ticket" });
    // The retired analysis does not even try to understand the follow-up: no decision, no action, and the person's state and deadline stand.
    expect(state.understand).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(savDecisions)).toHaveLength(0);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("keeps the cursor and receipt retryable when a full MIME response exceeds its wire envelope", async () => {
    await activateSavV0Cutover(boundary);
    await updateMailboxCursor(mailboxId, "100");
    for (const name of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]) vi.stubEnv(name, "fixture");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "fixture", expires_in: 3600 });
      if (url.pathname.endsWith("/history")) return Response.json({ historyId: "200", history: [{ id: "200", messagesAdded: [{ message: { id: "oversize-fixture" } }] }] });
      if (url.pathname.endsWith("/messages/oversize-fixture")) return new Response("{}", { headers: { "content-length": String(96 * 1024 * 1024 + 1) } });
      throw new Error("Unexpected network call");
    }));
    const { receipt } = await recordWebhookReceipt("gmail", "bounded-full-fixture", { emailAddress: boundary.mailboxEmail, historyId: "200" });
    await expect(processGmailReceipt(receipt.id)).rejects.toThrow("GMAIL_MESSAGE_RESPONSE_TOO_LARGE");
    const [mailbox] = await fixture.db.select().from(savMailboxes).where(eq(savMailboxes.id, mailboxId)); expect(mailbox.historyId).toBe("100");
    const [failed] = await fixture.db.select().from(savWebhookReceipts).where(eq(savWebhookReceipts.id, receipt.id)); expect(failed).toMatchObject({ status: "failed", errorCode: "GMAIL_MESSAGE_RESPONSE_TOO_LARGE" });
    expect(await fixture.db.select().from(savMessages)).toHaveLength(0);
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

describe("the old V0 analysis stays retired (SAV-9)", () => {
  it("every entry point is inert or refuses: a post-cutover mail is stored and recognised, then left untouched", async () => {
    vi.stubEnv("SAV_PILOT_MODE", "true");
    await activateSavV0Cutover(boundary);
    const fresh = await message("2026-10-02T12:00:01Z");
    const [before] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, fresh.id));
    expect(await processStoredSavMessage(fresh.id)).toBeNull();
    expect(await processPendingSavMessages(20)).toEqual({ retired: true, processed: [] });
    expect(await processPendingSavPilotItems(10)).toEqual({ retired: true, processed: [] });
    expect(await processSavPilotItem(crypto.randomUUID())).toBeNull();
    await expect(retrySavAnalysis(fresh.id, "ugo@limova.ai")).rejects.toThrow("SAV_V0_ANALYSIS_RETIRED");
    await expect(repairSavProposal(fresh.id, "ugo@limova.ai")).rejects.toThrow("SAV_V0_ANALYSIS_RETIRED");
    await expect(startSavPilotBatch("ugo@limova.ai", 10)).rejects.toThrow("SAV_V0_ANALYSIS_RETIRED");
    const [after] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, fresh.id));
    expect(after).toEqual(before);
    for (const table of [savDecisions, savActions, savAgentRuns, savPilotItems, savPilotBatches]) expect(await fixture.db.select().from(table)).toHaveLength(0);
    expect(state.understand).not.toHaveBeenCalled();
  });
  it("a mail that reaches the inbound path is left pending for the intake catch-up and the monitor, never analysed", async () => {
    await activateSavV0Cutover(boundary);
    const result = await ingestInboundMessage({ mailboxEmail: boundary.mailboxEmail, gmailMessageId: "fresh-one", gmailThreadId: "fixture-thread", from: "customer@example.com", to: ["contact@limova.ai"], subject: "Aide", bodyText: "Comment retrouver mes factures ?", receivedAt: "2026-10-02T12:01:00Z" });
    expect(result).toMatchObject({ v0AnalysisRetired: true });
    expect(result).not.toHaveProperty("decision");
    const [stored] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, result.message.id));
    expect(stored).toMatchObject({ analysisStatus: "pending", analysisAttempts: 0, analysisStartedAt: null, processedAt: null });
    expect(state.understand).not.toHaveBeenCalled();
  });
});

it("preserves a truncated Gmail inventory in the encrypted inbound body without scheduling old mail", async () => {
  const parsed = parseGmailMessage(boundary.mailboxEmail, { id: "synthetic-inventory", threadId: "synthetic-inventory-thread", internalDate: "1750000000000", payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: "fixture@example.invalid" }], parts: Array.from({ length: 101 }, (_, index) => ({ partId: String(index), filename: `capture-${index}.png`, mimeType: "image/png", body: { size: 10, attachmentId: `synthetic-${index}` } })) } });
  const result = await ingestInboundMessage(parsed);
  const saved = decryptSavPayload<import("./service").SavMessageBody>(result.message.bodyCiphertext);
  expect(saved.attachments).toHaveLength(100);
  expect(saved.attachmentInventory).toEqual({ complete: false, limits: ["reference_limit"] });
  expect(result.message.bodyCiphertext).not.toContain("capture-0.png");
  expect(await fixture.db.select().from(savAgentRuns)).toHaveLength(0);
});
