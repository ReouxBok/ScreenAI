import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { activeKnowledge, knowledgeRevisions, savActions, savAgentRuns, savDecisions, savFollowups, savMailboxes, savMessages, savReplyDrafts, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { renderSavOutboundReply, SAV_REPLY_FORMAT_REVISION, savReplyFooter } from "./reply-format";
import { saveSavReplyDraft } from "./drafts";
import { assertSavCurrentManualReply, queueSavManualReply } from "./manual-replies";
import { processPendingGmailSendActions } from "./gmail";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let input: Record<string, unknown> & { text: string };
let threadId: string;
let messageId: string;
let draftId: string;
let nextInbound = false;
let uncertainDelivery = false;
let foundSent = false;
let wrongThread = false;
let rawReply: { raw: string; threadId: string } | null;
const network = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const address = String(url);
  if (address.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture-only", expires_in: 3600 });
  if (address.includes("/threads/")) return Response.json({ messages: [{ id: nextInbound ? "newer-inbound" : "original-gmail-id", internalDate: "1790942460000", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "fiction@example.invalid" }] } }] });
  if (address.includes("/messages?")) return Response.json({ messages: foundSent ? [{ id: "sent-fixture", threadId: "original-thread" }] : [] });
  if (address.endsWith("/messages/send")) {
    rawReply = JSON.parse(String(init?.body));
    if (uncertainDelivery) throw new Error("fixture-network-timeout-after-dispatch");
    return Response.json({ id: "sent-fixture", threadId: wrongThread ? "wrong-thread" : "original-thread" });
  }
  throw new Error(`Unexpected fixture request: ${address}`);
});

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-manual-replies-encryption-key-32-characters");
  vi.stubEnv("GMAIL_CLIENT_ID", "fixture"); vi.stubEnv("GMAIL_CLIENT_SECRET", "fixture"); vi.stubEnv("GMAIL_REFRESH_TOKEN", "fixture"); vi.stubEnv("GMAIL_REPLY_FROM_ADDRESS", "contact@limova.ai");
  vi.stubGlobal("__savGmailToken", undefined); vi.stubGlobal("fetch", network); network.mockClear();
  nextInbound = false; uncertainDelivery = false; foundSent = false; wrongThread = false; rawReply = null;
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "original-thread", subject: "Ancien objet du fil", customerEmail: "fiction@example.invalid", hubspotTicketId: "123" }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, gmailMessageId: "original-gmail-id", subject: "Mes factures", direction: "inbound", fromEmail: thread.customerEmail,
    bodyCiphertext: encryptSavPayload({ text: "Cas fictif", headers: { "message-id": "<original@example.invalid>", references: "<earlier@example.invalid>" } }), receivedAt: new Date("2026-10-02T12:01:00Z") }).returning();
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId: message.id, runtime: "local_fixture", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload({ knowledgeRevision: "not_consulted" }) }).returning();
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: "human_review_required", reasonCode: "identity_unknown", explanation: "Demander le mail d’inscription", confidence: 800 }).returning();
  threadId = thread.id; messageId = message.id;
  input = { threadId, messageId, decisionId: decision.id, agentRunId: run.id, reviewId: null, knowledgeRevision: null, expectedDraftId: null, status: "draft", text: "Bonjour, quelle adresse email avez-vous utilisée pour votre inscription Limova ?" };
  draftId = (await saveSavReplyDraft(input, "ugo@limova.ai")).id;
});

describe("V0 human-only reply in the original Gmail thread", () => {
  it("lets the human owner reply on a paused dossier without resuming the agent or adding automatic actions", async () => {
    await fixture.db.update(savThreads).set({ aiPaused: true, status: "human_requested" }).where(eq(savThreads.id, threadId));
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "succeeded" });
    expect((await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId)))[0]).toMatchObject({ aiPaused: true, status: "human_requested" });
    expect(await fixture.db.select().from(savActions)).toHaveLength(1);
    expect(await fixture.db.select().from(savFollowups)).toHaveLength(0);
    expect(network.mock.calls.filter(([url]) => String(url).endsWith("/messages/send"))).toHaveLength(1);
  });
  it("queues only a distinct human send request, independently of process approval and CRM identity", async () => {
    const first = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    const duplicate = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    expect(duplicate.id).toBe(first.id);
    expect(await fixture.db.select().from(savActions)).toHaveLength(1);
    expect(first).toMatchObject({ kind: "send_reply", actorType: "human", payload: { manualReplyConfirmed: true, studioDraftId: draftId } });
    expect(network).not.toHaveBeenCalled();
  });
  it("sends the captured draft plus send-only footer in the original thread, without editing the draft or adding followups/CRM writes", async () => {
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "succeeded" });
    expect(rawReply!.threadId).toBe("original-thread");
    const email = Buffer.from(rawReply!.raw, "base64url").toString("utf8");
    expect(email).toContain("In-Reply-To: <original@example.invalid>");
    expect(email).toContain("References: <earlier@example.invalid> <original@example.invalid>");
    expect(email).toContain(`Subject: =?UTF-8?B?${Buffer.from("Re: Mes factures").toString("base64")}?=`);
    expect(email.split("\r\n\r\n")[1]).toBe(renderSavOutboundReply(input.text));
    expect(decryptSavPayload<{ text: string }>((await fixture.db.select().from(savReplyDrafts))[0].bodyCiphertext).text).toBe(input.text);
    const sentMessage = (await fixture.db.select().from(savMessages)).find(message => message.direction === "outbound")!;
    expect(decryptSavPayload<{ text: string }>(sentMessage.bodyCiphertext).text).toBe(renderSavOutboundReply(input.text));
    expect(network.mock.calls.some(([url]) => new URL(String(url)).searchParams.get("q")?.startsWith("in:sent rfc822msgid:"))).toBe(true);
    expect(await fixture.db.select().from(savFollowups)).toHaveLength(0);
    expect(await fixture.db.select().from(savActions)).toHaveLength(1);
    await processPendingGmailSendActions();
    expect(network.mock.calls.filter(([url]) => String(url).endsWith("/messages/send"))).toHaveLength(1);
  });
  it("captures the English send rule from the current inbound, not the inherited subject", async () => {
    await fixture.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: "Hello, I need help with my account.", headers: { "message-id": "<original@example.invalid>" } }) }).where(eq(savMessages.id, messageId));
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    expect(decryptSavPayload<{ text: string }>(String(action.payload.outboundBodyCiphertext)).text).toBe(renderSavOutboundReply(input.text, "en"));
    expect(action.payload.replyFormatRevision).toBe(SAV_REPLY_FORMAT_REVISION);
    expect(network).not.toHaveBeenCalled();
  });
  it("rejects an altered final body even if its hash was replaced too", async () => {
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    const forged = "An unapproved replacement";
    await fixture.db.update(savActions).set({ payload: { ...action.payload, outboundBodyCiphertext: encryptSavPayload({ text: forged }), outboundBodyHash: savContentHash(forged) } }).where(eq(savActions.id, action.id));
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_REPLY_MANUAL_OUTBOUND_CHANGED" });
    expect(network).not.toHaveBeenCalled();
  });
  it("does not silently upgrade an old queued approval and requires a new human confirmation", async () => {
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    const oldPayload = { manualReplyConfirmed: true, studioDraftId: draftId, bodyCiphertext: action.payload.bodyCiphertext };
    await fixture.db.update(savActions).set({ payload: oldPayload }).where(eq(savActions.id, action.id));
    await expect(assertSavCurrentManualReply({ ...action, payload: oldPayload })).rejects.toThrow("SAV_REPLY_MANUAL_FORMAT_RECONFIRM_REQUIRED");
    expect(network).not.toHaveBeenCalled();
    const confirmed = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    expect(confirmed.id).toBe(action.id);
    expect(confirmed.payload.replyFormatRevision).toBe(SAV_REPLY_FORMAT_REVISION);
    await expect(assertSavCurrentManualReply(confirmed)).resolves.toHaveProperty("outboundText", `${input.text}\n\n${savReplyFooter()}`);
    expect(network).not.toHaveBeenCalled();
  });
  it("blocks old-format queued actions in the worker before network access", async () => {
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    await fixture.db.update(savActions).set({ payload: { ...action.payload, replyFormatRevision: "old-rule" } }).where(eq(savActions.id, action.id));
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_REPLY_MANUAL_FORMAT_RECONFIRM_REQUIRED" });
    expect(network).not.toHaveBeenCalled();
  });
  it("blocks in preview/kill-switch mode without creating a send action or calling Gmail", async () => {
    vi.stubEnv("SAV_WRITES_DISABLED", "true");
    await expect(queueSavManualReply({ threadId, draftId }, "ugo@limova.ai")).rejects.toThrow("SAV_WRITES_DISABLED");
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    expect(network).not.toHaveBeenCalled();
  });
  it("does not permit unauthorized senders or forged bodies", async () => {
    await expect(queueSavManualReply({ threadId, draftId }, "other@limova.ai")).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    await expect(assertSavCurrentManualReply({ ...action, payload: { ...action.payload, bodyCiphertext: encryptSavPayload({ text: "Forged" }) } })).rejects.toThrow("SAV_REPLY_MANUAL_DRAFT_CHANGED");
    expect(network).not.toHaveBeenCalled();
  });
  it("fails closed when RFC Message-ID is missing", async () => {
    await fixture.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: "Missing headers" }) }).where(eq(savMessages.id, messageId));
    await expect(queueSavManualReply({ threadId, draftId }, "ugo@limova.ai")).rejects.toThrow("SAV_REPLY_MANUAL_THREAD_HEADERS_MISSING");
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    expect(network).not.toHaveBeenCalled();
  });
  it("blocks a queued reply when knowledge changes before sending", async () => {
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    const [revision] = await fixture.db.insert(knowledgeRevisions).values({ id: crypto.randomUUID(), actorEmail: "ugo@limova.ai" }).returning();
    await fixture.db.insert(activeKnowledge).values({ revisionId: revision.id });
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_REPLY_MANUAL_CONTEXT_CHANGED" });
    expect(network).not.toHaveBeenCalled();
  });
  it("checks Gmail for a new inbound even if the local database has not synced it", async () => {
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    nextInbound = true;
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_GMAIL_THREAD_CHANGED" });
    expect(rawReply).toBeNull();
  });
  it("never automatically resends after an uncertain POST or a manual retry", async () => {
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    uncertainDelivery = true;
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_REPLY_MANUAL_RECONCILIATION_REQUIRED" });
    await expect(queueSavManualReply({ threadId, draftId }, "ugo@limova.ai")).rejects.toThrow("SAV_REPLY_MANUAL_RECONCILIATION_REQUIRED");
    await fixture.db.update(savActions).set({ status: "pending" }).where(eq(savActions.id, action.id));
    await processPendingGmailSendActions(1, action.id);
    expect(network.mock.calls.filter(([url]) => String(url).endsWith("/messages/send"))).toHaveLength(1);
  });
  it("can reconcile a found RFC message after an uncertain result without another POST", async () => {
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    await fixture.db.update(savActions).set({ payload: { ...action.payload, replySendDispatchedAt: new Date().toISOString() } }).where(eq(savActions.id, action.id));
    foundSent = true;
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "succeeded" });
    expect(rawReply).toBeNull();
  });
  it("does not call an unexpected Gmail thread a successful reply", async () => {
    const action = await queueSavManualReply({ threadId, draftId }, "ugo@limova.ai");
    wrongThread = true;
    expect((await processPendingGmailSendActions(1, action.id)).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_REPLY_MANUAL_RECONCILIATION_REQUIRED" });
  });
});
