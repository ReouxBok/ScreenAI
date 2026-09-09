import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savActions, savAgentRuns, savDecisions, savLearningCandidates, savMailboxes, savMessages, savPilotBatches, savPilotItems, savThreads } from "@/db/schema";
import { assertSavWriteAllowed } from "./write-guard";
import { invalidateSavReplies } from "./invalidation";
import { processPendingGmailSendActions } from "./gmail";
import { encryptSavPayload } from "./crypto";
import { currentMessageText, loadSavConversation } from "./conversation";
import { processPendingSavMessages, processSavPilotItem, reviewSavPilotItem } from "./service";
import { getSavAutonomyGate } from "./promotion";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let threadId: string;
let messageId: string;

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("SAV_AUTOMATION_MODE", "on");
  vi.stubEnv("SAV_WRITES_DISABLED", "false");
  vi.stubEnv("SAV_TEST_MODE", "false");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters");
  vi.stubEnv("GMAIL_CLIENT_ID", "fixture");
  vi.stubEnv("GMAIL_CLIENT_SECRET", "fixture");
  vi.stubEnv("GMAIL_REFRESH_TOKEN", "fixture");
  await fixture.client.exec('TRUNCATE sav.mailboxes CASCADE');
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "sav@example.com" }).returning();
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "g1", customerEmail: "customer@example.com" }).returning();
  threadId = thread.id;
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, direction: "inbound", fromEmail: "customer@example.com", bodyCiphertext: encryptSavPayload({ text: "Question", headers: { "message-id": "<original@example.com>" } }), receivedAt: new Date(), createdAt: new Date(Date.now() - 10_000) }).returning();
  messageId = message.id;
});

async function action(kind: "send_reply" | "draft_reply" = "send_reply") {
  const [row] = await fixture.db.insert(savActions).values({ threadId, messageId, kind,
    status: kind === "draft_reply" ? "succeeded" : "running", idempotencyKey: crypto.randomUUID(),
  }).returning();
  return row;
}

describe("write guard with migrated database", () => {
  it("reloads human takeover after a reply was claimed", async () => {
    const queued = await action();
    await expect(assertSavWriteAllowed(queued.id)).resolves.toMatchObject({ thread: { id: threadId } });
    await fixture.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
    await expect(assertSavWriteAllowed(queued.id)).rejects.toThrow("SAV_THREAD_PAUSED");
  });
  it("invalidates pending replies and completed drafts atomically", async () => {
    const draft = await action("draft_reply");
    const reply = await action();
    await fixture.db.update(savActions).set({ status: "pending" }).where(eq(savActions.id, reply.id));
    await fixture.db.transaction((tx) => invalidateSavReplies(tx, threadId, "SAV_REPLY_OBSOLETE"));
    const rows = await fixture.db.select().from(savActions);
    expect(rows.filter((row) => [reply.id, draft.id].includes(row.id)).every((row) => row.status === "cancelled")).toBe(true);
    await expect(assertSavWriteAllowed(reply.id)).rejects.toThrow("SAV_ACTION_NO_LONGER_PENDING");
  });
  it("rejects an older message draft after a later inbound", async () => {
    const queued = await action();
    const [original] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
    await fixture.db.insert(savMessages).values({ ...original, id: crypto.randomUUID(), receivedAt: new Date(Date.now() + 1_000), createdAt: new Date() });
    await expect(assertSavWriteAllowed(queued.id)).rejects.toThrow("SAV_REPLY_OBSOLETE");
  });
  it("enforces outbound test recipients on the backend", async () => {
    const queued = await action();
    vi.stubEnv("SAV_TEST_MODE", "true");
    vi.stubEnv("SAV_TEST_OUTBOUND_ALLOWLIST", "tester@example.com");
    await expect(assertSavWriteAllowed(queued.id)).rejects.toThrow("SAV_TEST_OUTBOUND_RECIPIENT_BLOCKED");
  });
  it("the Gmail worker does not send when takeover happens during its sent-message lookup", async () => {
    const queued = await action();
    await fixture.db.update(savActions).set({ status: "pending", payload: { bodyCiphertext: encryptSavPayload({ text: "Proposed response" }) } }).where(eq(savActions.id, queued.id));
    const network = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("oauth2")) return Response.json({ access_token: "fixture", expires_in: 3600 });
      if (path.includes("messages?")) {
        await fixture.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId));
        return Response.json({ messages: [] });
      }
      throw new Error(`Unexpected external write: ${path}`);
    });
    vi.stubGlobal("fetch", network);
    await processPendingGmailSendActions();
    expect(network.mock.calls.some(([url]) => String(url).endsWith("messages/send"))).toBe(false);
    const [row] = await fixture.db.select().from(savActions).where(eq(savActions.id, queued.id));
    expect(row).toMatchObject({ status: "cancelled", errorCode: "SAV_THREAD_PAUSED" });
  });
  it("a successful send is not repeated on the next worker pass", async () => {
    const queued = await action();
    await fixture.db.update(savActions).set({ status: "pending", payload: { bodyCiphertext: encryptSavPayload({ text: "Proposed response" }) } }).where(eq(savActions.id, queued.id));
    let sends = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("oauth2")) return Response.json({ access_token: "fixture", expires_in: 3600 });
      if (path.includes("messages?")) return Response.json({ messages: [] });
      if (path.endsWith("messages/send")) { sends++; return Response.json({ id: "sent-fixture", threadId: "g1" }); }
      throw new Error("Unexpected network call");
    }));
    await processPendingGmailSendActions();
    await processPendingGmailSendActions();
    expect(sends).toBe(1);
    const [row] = await fixture.db.select().from(savActions).where(eq(savActions.id, queued.id));
    expect(row.status).toBe("succeeded");
  });
  it("backs off a transient Gmail failure instead of retrying in a tight loop", async () => {
    const queued = await action();
    await fixture.db.update(savActions).set({ status: "pending", payload: { bodyCiphertext: encryptSavPayload({ text: "Proposed response" }) } }).where(eq(savActions.id, queued.id));
    let sends = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("oauth2")) return Response.json({ access_token: "fixture", expires_in: 3600 });
      if (path.includes("messages?")) return Response.json({ messages: [] });
      if (path.endsWith("messages/send")) { sends++; return new Response("unavailable", { status: 503 }); }
      throw new Error("Unexpected network call");
    }));
    await processPendingGmailSendActions();
    await processPendingGmailSendActions();
    const [row] = await fixture.db.select().from(savActions).where(eq(savActions.id, queued.id));
    expect(sends).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.attemptCount).toBe(1);
    expect(row.scheduledAt!.getTime()).toBeGreaterThan(Date.now());
  });
  it("conversation context includes prior answers but excludes other customers and future mail", async () => {
    const [original] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
    await fixture.db.insert(savMessages).values({ ...original, id: crypto.randomUUID(), direction: "outbound",
      receivedAt: new Date(original.receivedAt.getTime() - 60_000), createdAt: new Date(original.createdAt.getTime() - 60_000),
      bodyCiphertext: encryptSavPayload({ text: "Essayez la procédure A." }),
    });
    await fixture.db.insert(savMessages).values({ ...original, id: crypto.randomUUID(),
      receivedAt: new Date(original.receivedAt.getTime() + 60_000), bodyCiphertext: encryptSavPayload({ text: "Future information" }),
    });
    const [other] = await fixture.db.insert(savThreads).values({ mailboxId: original.mailboxId, gmailThreadId: "other", customerEmail: "other@example.com" }).returning();
    await fixture.db.insert(savMessages).values({ ...original, id: crypto.randomUUID(), threadId: other.id,
      bodyCiphertext: encryptSavPayload({ text: "Another customer's private data" }),
    });
    const context = await loadSavConversation(messageId);
    expect(context.messages.map((message) => message.text)).toEqual(["Essayez la procédure A.", "Question"]);
    expect(context.attachmentNotice).toContain("ne sont pas analysées");
  });
  it("removes obvious quoted text while retaining the customer's latest answer", () => {
    expect(currentMessageText("Cela ne fonctionne toujours pas.\n\nLe mardi, Charly a écrit :\nAncienne procédure")).toBe("Cela ne fonctionne toujours pas.");
    expect(currentMessageText("Merci\n> procédure précédente")).toBe("Merci");
  });
  it("summarizes older conversation turns with message references inside the fixed budget", async () => {
    const [original] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
    for (let index = 1; index <= 14; index++) await fixture.db.insert(savMessages).values({
      ...original, id: crypto.randomUUID(), direction: index % 2 ? "outbound" : "inbound",
      gmailMessageId: `older-${index}`, receivedAt: new Date(original.receivedAt.getTime() - index * 60_000),
      createdAt: new Date(original.createdAt.getTime() - index * 60_000),
      bodyCiphertext: encryptSavPayload({ text: `Échange antérieur ${index} avec une information utile.` }),
    });
    const context = await loadSavConversation(messageId);
    expect(context.messages).toHaveLength(12);
    expect(context.olderSummary.length).toBeGreaterThan(0);
    expect(context.olderSummary.every((item) => item.messageId && item.excerpt)).toBe(true);
    expect(context.messages.reduce((sum, item) => sum + item.text.length, 0) + context.olderSummary.reduce((sum, item) => sum + item.excerpt.length, 0)).toBeLessThanOrEqual(18_000);
  });
  it("turns a corrected pilot response into a reviewable learning candidate without HubSpot", async () => {
    const [batch] = await fixture.db.insert(savPilotBatches).values({ targetSize: 1, createdBy: "reviewer@example.com", status: "reviewing" }).returning();
    const [item] = await fixture.db.insert(savPilotItems).values({ batchId: batch.id, messageId, status: "ready" }).returning();
    await reviewSavPilotItem(item.id, {
      verdict: "incorrect",
      dimensions: { classification: "correct", routing: "incorrect", grounding: "incorrect", tone: "partial", escalation: "correct" },
      feedbackCodes: ["unsupported_claim"], comment: "La procédure n'était pas prouvée.",
      correctedDraft: "La bonne réponse consiste à transmettre le dossier pour vérification humaine.",
    }, "reviewer@example.com");
    const [candidate] = await fixture.db.select().from(savLearningCandidates);
    expect(candidate).toMatchObject({ threadId, hubspotTicketId: null, sourceRef: `thread:${threadId}`, evidenceTicketIds: [], createdBy: "human" });
    const [reviewed] = await fixture.db.select().from(savPilotItems).where(eq(savPilotItems.id, item.id));
    expect(reviewed).toMatchObject({ classificationVerdict: "correct", routingVerdict: "incorrect", groundingVerdict: "incorrect", toneVerdict: "partial", escalationVerdict: "correct" });
  });
  it("links a pilot review to the exact agent run that produced its decision", async () => {
    vi.stubEnv("SAV_PILOT_MODE", "true");
    vi.stubEnv("SAV_ADK_MODE", "pilot");
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    const [batch] = await fixture.db.insert(savPilotBatches).values({ targetSize: 1, createdBy: "reviewer@example.com", status: "processing" }).returning();
    const [item] = await fixture.db.insert(savPilotItems).values({ batchId: batch.id, messageId }).returning();
    await expect(processSavPilotItem(item.id)).resolves.toMatchObject({ status: "ready" });
    const [processed] = await fixture.db.select().from(savPilotItems).where(eq(savPilotItems.id, item.id));
    const [run] = await fixture.db.select().from(savAgentRuns).where(eq(savAgentRuns.id, processed.agentRunId!));
    expect(processed.agentRunId).toBeTruthy();
    expect(run).toMatchObject({ messageId, pilotBatchId: batch.id, promptRevision: "rules-v1" });
    await fixture.db.insert(savAgentRuns).values({
      messageId, pilotBatchId: batch.id, scope: "sav_ticket_analysis", runtime: "google_adk", mode: "pilot",
      status: "succeeded", model: "fixture", promptRevision: "other-version", inputHash: "fixture",
    });
    await fixture.db.update(savPilotItems).set({ status: "reviewed", verdict: "correct", reviewedAt: new Date() }).where(eq(savPilotItems.id, item.id));
    await expect(getSavAutonomyGate("rules-v1")).resolves.toMatchObject({ metrics: { versionReviewed: 1, versionCorrect: 1 } });
    await expect(getSavAutonomyGate("other-version")).resolves.toMatchObject({ metrics: { versionReviewed: 0, versionCorrect: 0 } });
  });
  it("reclaims an interrupted non-pilot analysis and finishes it once", async () => {
    vi.stubEnv("SAV_PILOT_MODE", "false");
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    await fixture.db.update(savMessages).set({ analysisStatus: "processing", analysisAttempts: 1, analysisStartedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(savMessages.id, messageId));
    const first = await processPendingSavMessages(4);
    const second = await processPendingSavMessages(4);
    const [message] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
    const decisions = await fixture.db.select().from(savDecisions).where(eq(savDecisions.messageId, messageId));
    expect(first.processed).toEqual([{ messageId, status: "processed" }]);
    expect(second.processed).toEqual([]);
    expect(message).toMatchObject({ analysisStatus: "done", analysisAttempts: 2 });
    expect(message.processedAt).not.toBeNull();
    expect(decisions).toHaveLength(1);
  });
});
