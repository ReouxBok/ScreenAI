import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savActions, savAgentRuns, savDecisions, savFollowups, savLearningCandidates, savMailboxes, savMessages, savPilotBatches, savPilotItems, savThreads } from "@/db/schema";
import { assertSavWriteAllowed } from "./write-guard";
import { invalidateSavReplies } from "./invalidation";
import { processPendingGmailSendActions } from "./gmail";
import { processPendingHubspotActions } from "./hubspot";
import { processDueFollowups } from "./followups";
import { encryptSavPayload } from "./crypto";
import { currentMessageText, loadSavConversation } from "./conversation";
import { processPendingSavMessages, processSavPilotItem, reviewSavPilotItemArchived as reviewSavPilotItem } from "./service";
import { getSavAutonomyGate } from "./promotion";
import { activateSavV0Cutover } from "./cutover";
import { SAV_UNDERSTANDING_PROMPT_REVISION } from "./understanding";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let threadId: string;
let messageId: string;

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v4");
  vi.stubEnv("SAV_AUTOMATION_MODE", "on");
  vi.stubEnv("SAV_WRITES_DISABLED", "false");
  vi.stubEnv("SAV_TEST_MODE", "false");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters");
  vi.stubEnv("GMAIL_CLIENT_ID", "fixture");
  vi.stubEnv("GMAIL_CLIENT_SECRET", "fixture");
  vi.stubEnv("GMAIL_REFRESH_TOKEN", "fixture");
  await fixture.client.exec('TRUNCATE sav.mailboxes CASCADE');
  await fixture.client.exec('TRUNCATE sav.sync_state');
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "sav@example.com" }).returning();
  await activateSavV0Cutover({ receivedAfter: new Date(Date.now() - 86_400_000).toISOString(), mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "g1", customerEmail: "customer@example.com" }).returning();
  threadId = thread.id;
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, direction: "inbound", fromEmail: "customer@example.com", bodyCiphertext: encryptSavPayload({ text: "Question", headers: { "message-id": "<original@example.com>" } }), receivedAt: new Date(), createdAt: new Date(Date.now() - 10_000) }).returning();
  messageId = message.id;
});

// A person's command: the only author the legacy workers still execute (SAV-9). The guards below are the ones a person's command meets.
async function action(kind: "send_reply" | "draft_reply" = "send_reply", actorType: "human" | "ai" | "system" = "human") {
  const [row] = await fixture.db.insert(savActions).values({ threadId, messageId, kind, actorType,
    status: kind === "draft_reply" ? "succeeded" : "running", idempotencyKey: crypto.randomUUID(),
  }).returning();
  return row;
}

describe("write guard with migrated database", () => {
  it("V0 blocks old approved email actions before any network request", async () => {
    vi.stubEnv("SAV_RELEASE_STAGE", "v0");
    const queued = await action();
    await fixture.db.update(savActions).set({ status: "pending", actorType: "human" }).where(eq(savActions.id, queued.id));
    const network = vi.fn(() => { throw new Error("No network allowed"); });
    vi.stubGlobal("fetch", network);
    await expect(assertSavWriteAllowed(queued.id)).rejects.toThrow("SAV_REPLY_MANUAL_APPROVAL_REQUIRED");
    await processPendingGmailSendActions();
    expect(network).not.toHaveBeenCalled();
  });
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
  it("keeps an unqualified pilot correction as evaluation, not reusable knowledge", async () => {
    const [batch] = await fixture.db.insert(savPilotBatches).values({ targetSize: 1, createdBy: "reviewer@example.com", status: "reviewing" }).returning();
    const [item] = await fixture.db.insert(savPilotItems).values({ batchId: batch.id, messageId, status: "ready" }).returning();
    await reviewSavPilotItem(item.id, {
      verdict: "incorrect",
      dimensions: { classification: "correct", routing: "incorrect", grounding: "incorrect", tone: "partial", escalation: "correct" },
      feedbackCodes: ["unsupported_claim"], comment: "La procédure n'était pas prouvée.",
      correctedDraft: "La bonne réponse consiste à transmettre le dossier pour vérification humaine.",
    }, "reviewer@example.com");
    expect(await fixture.db.select().from(savLearningCandidates)).toHaveLength(0);
    const [reviewed] = await fixture.db.select().from(savPilotItems).where(eq(savPilotItems.id, item.id));
    expect(reviewed).toMatchObject({ classificationVerdict: "correct", routingVerdict: "incorrect", groundingVerdict: "incorrect", toneVerdict: "partial", escalationVerdict: "correct" });
  });
  it("links a pilot review to the exact prompt and model that produced its decision", async () => {
    vi.stubEnv("SAV_PILOT_MODE", "true");
    vi.stubEnv("SAV_ADK_MODE", "pilot");
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    const [batch] = await fixture.db.insert(savPilotBatches).values({ targetSize: 1, createdBy: "reviewer@example.com", status: "processing" }).returning();
    const [item] = await fixture.db.insert(savPilotItems).values({ batchId: batch.id, messageId }).returning();
    // The old V0 analysis is retired (SAV-9): a pilot item is never claimed or analysed any more, so the run below is an existing one
    // (a review of past pilot data still links to the prompt and model that produced it).
    await expect(processSavPilotItem(item.id)).resolves.toBeNull();
    const [untouched] = await fixture.db.select().from(savPilotItems).where(eq(savPilotItems.id, item.id));
    expect(untouched).toMatchObject({ status: "pending", attemptCount: 0, agentRunId: null });
    expect(await fixture.db.select().from(savAgentRuns).where(eq(savAgentRuns.messageId, messageId))).toHaveLength(0);
    const [existing] = await fixture.db.insert(savAgentRuns).values({
      messageId, pilotBatchId: batch.id, scope: "sav_ticket_analysis", runtime: "google_adk", mode: "pilot", status: "succeeded",
      model: "fixture-model", promptRevision: SAV_UNDERSTANDING_PROMPT_REVISION, inputHash: "fixture",
    }).returning();
    await fixture.db.update(savPilotItems).set({ status: "ready", agentRunId: existing.id }).where(eq(savPilotItems.id, item.id));
    const [processed] = await fixture.db.select().from(savPilotItems).where(eq(savPilotItems.id, item.id));
    const [run] = await fixture.db.select().from(savAgentRuns).where(eq(savAgentRuns.id, processed.agentRunId!));
    expect(processed.agentRunId).toBeTruthy();
    expect(run).toMatchObject({ messageId, pilotBatchId: batch.id, promptRevision: SAV_UNDERSTANDING_PROMPT_REVISION });
    await fixture.db.insert(savAgentRuns).values({
      messageId, pilotBatchId: batch.id, scope: "sav_ticket_analysis", runtime: "google_adk", mode: "pilot",
      status: "succeeded", model: "fixture", promptRevision: "other-version", inputHash: "fixture",
    });
    await fixture.db.update(savPilotItems).set({ status: "reviewed", verdict: "correct", reviewedAt: new Date() }).where(eq(savPilotItems.id, item.id));
    await expect(getSavAutonomyGate(run.promptRevision, run.model)).resolves.toMatchObject({ metrics: { versionReviewed: 1, versionCorrect: 1 } });
    await expect(getSavAutonomyGate("other-version", "fixture")).resolves.toMatchObject({ metrics: { versionReviewed: 0, versionCorrect: 0 } });
    await expect(getSavAutonomyGate("rules-v1", "different-model")).resolves.toMatchObject({ metrics: { versionReviewed: 0, versionCorrect: 0 } });
  });
  it("never reclaims an interrupted analysis any more: the retired V0 analysis leaves the message untouched, however often it runs", async () => {
    vi.stubEnv("SAV_PILOT_MODE", "false");
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    await fixture.db.update(savMessages).set({ analysisStatus: "processing", analysisAttempts: 1, analysisStartedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(savMessages.id, messageId));
    const [before] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
    const first = await processPendingSavMessages(4);
    const second = await processPendingSavMessages(4);
    const [message] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
    const decisions = await fixture.db.select().from(savDecisions).where(eq(savDecisions.messageId, messageId));
    expect(first).toEqual({ retired: true, processed: [] });
    expect(second).toEqual({ retired: true, processed: [] });
    expect(message).toEqual(before);
    expect(message).toMatchObject({ analysisStatus: "processing", analysisAttempts: 1, processedAt: null });
    expect(decisions).toHaveLength(0);
  });
});

describe("retired V0 engine with migrated database (SAV-9)", () => {
  const stages = ["v0", "v1", "v2", "v3", "v4"] as const;
  const modes = ["assist", "semi", "on"] as const;
  const gmailKinds = ["send_reply", "request_human"] as const;
  const hubspotKinds = ["create_ticket", "link_ticket", "log_email", "update_ticket_status"] as const;
  const marker = { replySendDispatchedAt: "2026-10-27T10:00:00.000Z", ticketCreateDispatchedAt: "2026-10-27T10:00:00.000Z" };
  const noNetwork = () => { const network = vi.fn(() => { throw new Error("No network allowed"); }); vi.stubGlobal("fetch", network); return network; };

  async function machineRows() {
    const staleAt = new Date(Date.now() - 3_600_000);
    const created = [];
    for (const actorType of ["ai", "system"] as const) for (const kind of [...gmailKinds, ...hubspotKinds]) {
      // never sent, and "engaged": a stale running row whose payload says a provider call may have happened
      for (const [status, payload] of [["pending", { bodyCiphertext: encryptSavPayload({ text: "Proposed response" }) }], ["running", { ...marker, bodyCiphertext: encryptSavPayload({ text: "Proposed response" }) }]] as const) {
        const [row] = await fixture.db.insert(savActions).values({
          threadId, messageId, kind, actorType, status, payload, idempotencyKey: crypto.randomUUID(), updatedAt: staleAt,
        }).returning();
        created.push(row);
      }
    }
    return created;
  }

  it("machine-authored actions are never claimed, sent, retried or recovered in any stage or mode; their rows stay untouched", async () => {
    const rows = await machineRows();
    const network = noNetwork();
    for (const stage of stages) for (const mode of modes) {
      vi.stubEnv("SAV_RELEASE_STAGE", stage);
      vi.stubEnv("SAV_AUTOMATION_MODE", mode);
      await processPendingGmailSendActions(100);
      await processPendingHubspotActions(100);
    }
    expect(network).not.toHaveBeenCalled();
    const after = await fixture.db.select().from(savActions);
    expect(after).toHaveLength(rows.length);
    for (const before of rows) expect(after.find((row) => row.id === before.id)).toEqual(before);
    expect(rows.every((row) => row.attemptCount === 0)).toBe(true);
  });
  it("a machine-authored row does not starve a person's command waiting in the same pass", async () => {
    await machineRows();
    const human = await action("send_reply", "human");
    await fixture.db.update(savActions).set({ status: "pending", payload: { bodyCiphertext: encryptSavPayload({ text: "Proposed response" }) } }).where(eq(savActions.id, human.id));
    let sends = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("oauth2")) return Response.json({ access_token: "fixture", expires_in: 3600 });
      if (path.includes("messages?")) return Response.json({ messages: [] });
      if (path.endsWith("messages/send")) { sends++; return Response.json({ id: "sent-human", threadId: "g1" }); }
      throw new Error("Unexpected network call");
    }));
    await processPendingGmailSendActions(1);
    expect(sends).toBe(1);
    expect((await fixture.db.select().from(savActions).where(eq(savActions.id, human.id)))[0].status).toBe("succeeded");
  });
  it("the old follow-up trigger, run late or twice, queues nothing and leaves the scheduled rows as they were", async () => {
    vi.stubEnv("SAV_RELEASE_STAGE", "v4");
    vi.stubEnv("SAV_AUTOMATION_MODE", "on");
    await fixture.db.update(savThreads).set({ status: "awaiting_customer", aiPaused: false }).where(eq(savThreads.id, threadId));
    await fixture.db.insert(savFollowups).values([1, 2, 3].map((sequence) => ({ threadId, sequence, dueAt: new Date(Date.now() - 86_400_000) })));
    const before = await fixture.db.select().from(savFollowups);
    const actionsBefore = await fixture.db.select().from(savActions);
    noNetwork();
    expect(await processDueFollowups(50)).toEqual({ retired: true, processed: [] });
    expect(await processDueFollowups(50, new Date(Date.now() + 30 * 86_400_000))).toEqual({ retired: true, processed: [] });
    expect(await fixture.db.select().from(savFollowups)).toEqual(before);
    expect(await fixture.db.select().from(savActions)).toEqual(actionsBefore);
    await processPendingGmailSendActions(100);
    expect(await fixture.db.select().from(savActions)).toEqual(actionsBefore);
  });
  it("a person's reply is sent and recorded without scheduling follow-ups or any CRM log/status row", async () => {
    vi.stubEnv("SAV_RELEASE_STAGE", "v4");
    vi.stubEnv("SAV_AUTOMATION_MODE", "on");
    await fixture.db.update(savThreads).set({ hubspotTicketId: "9001" }).where(eq(savThreads.id, threadId));
    const human = await action("send_reply", "human");
    await fixture.db.update(savActions).set({ status: "pending", payload: { bodyCiphertext: encryptSavPayload({ text: "Proposed response" }) } }).where(eq(savActions.id, human.id));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("oauth2")) return Response.json({ access_token: "fixture", expires_in: 3600 });
      if (path.includes("messages?")) return Response.json({ messages: [] });
      if (path.endsWith("messages/send")) return Response.json({ id: "sent-human", threadId: "g1" });
      throw new Error("Unexpected network call");
    }));
    await processPendingGmailSendActions(1);
    expect((await fixture.db.select().from(savActions).where(eq(savActions.id, human.id)))[0].status).toBe("succeeded");
    expect(await fixture.db.select().from(savFollowups)).toHaveLength(0);
    expect((await fixture.db.select().from(savActions)).map((row) => row.kind)).toEqual(["send_reply"]);
    expect((await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId)))[0].status).toBe("awaiting_customer");
    const outbound = await fixture.db.select().from(savMessages).where(eq(savMessages.direction, "outbound"));
    expect(outbound).toHaveLength(1);
  });
});
