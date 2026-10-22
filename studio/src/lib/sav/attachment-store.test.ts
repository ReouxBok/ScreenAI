import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createSavTestDb } from "../../../test/sav-db";
import { attachmentMetadata, syntheticImage } from "../../../test/sav-attachments";
import { geminiFixture } from "../../../test/sav-understanding-fixtures";
import { savMailboxes, savThreads, savMessages, savAgentRuns, savDecisions, savProposalReviews } from "@/db/schema";
import { acquireSavAttachmentRead } from "./attachment-store";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import type { SavMessageBody } from "./service";
const state = vi.hoisted(() => ({ db: null as unknown, download: vi.fn(), eligible: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./gmail", () => ({ createSavGmailAttachmentDownloader: () => state.download }));
vi.mock("./cutover", () => ({ isSavMessageEligible: state.eligible }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>, messageId: string, mailboxId: string, threadId: string;
const visual = () => geminiFixture({ images: [{ index: 0, readability: "readable", text: "Erreur E42.", uncertainties: [], regions: [] }] });
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-sav83-key-never-production"); vi.stubEnv("SAV_AI_MODEL", "gemini-3.6-flash"); vi.stubEnv("SAV_AI_ANALYSIS", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("UNEXPECTED_REAL_NETWORK"); }));
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE");
  const bytes = await syntheticImage(); state.download.mockReset().mockResolvedValue(bytes); state.eligible.mockReset().mockResolvedValue(true);
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning(); mailboxId = mailbox.id;
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId, gmailThreadId: "thread-fixture", subject: "Capture fictive", customerEmail: "fixture@example.invalid" }).returning(); threadId = thread.id;
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId, threadId, gmailMessageId: "gmail-fixture", direction: "inbound", fromEmail: thread.customerEmail,
    analysisStatus: "processing", analysisStartedAt: new Date(), bodyCiphertext: encryptSavPayload({ text: "Le produit ne fonctionne pas.", attachments: [attachmentMetadata(bytes.length)] }), receivedAt: new Date("2026-10-19T10:00:00Z") }).returning(); messageId = message.id;
});
async function body() { const [row] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId)); return decryptSavPayload<SavMessageBody>(row.bodyCiphertext); }
async function change(update: (body: SavMessageBody) => SavMessageBody) {
  await fixture.db.transaction(async tx => {
    const [row] = await tx.select().from(savMessages).where(eq(savMessages.id, messageId)).for("update");
    await tx.update(savMessages).set({ bodyCiphertext: encryptSavPayload(update(decryptSavPayload<SavMessageBody>(row.bodyCiphertext))) }).where(eq(savMessages.id, messageId));
  });
}
it("persists only derived encrypted observations and reuses them on retry without another Gmail/model read", async () => {
  const attachmentInventory = { complete: false, limits: ["depth_limit"] as ["depth_limit"] };
  await change(value => ({ ...value, attachmentInventory }));
  const network = vi.fn<typeof fetch>(async () => visual());
  const first = await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect(first?.observations[0]).toMatchObject({ status: "analyzed", text: "Erreur E42." });
  await fixture.db.update(savMessages).set({ processedAt: new Date(), analysisStatus: "done" }).where(eq(savMessages.id, messageId));
  expect(await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network })).toEqual(first);
  expect(network).toHaveBeenCalledOnce(); expect(state.download).toHaveBeenCalledOnce();
  expect((await body()).attachmentInventory).toEqual(attachmentInventory);
  const [row] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  expect(row.bodyCiphertext).not.toContain("Erreur E42"); expect(JSON.stringify((await body()).attachmentRead)).not.toContain((await syntheticImage()).toString("base64"));
});
it("serializes claims so overlapping analyses dispatch one visual request", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const bytes = await syntheticImage(); state.download.mockImplementation(async () => { await gate; return bytes; });
  const network = vi.fn<typeof fetch>(async () => visual()), first = acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  await vi.waitFor(() => expect(state.download).toHaveBeenCalledOnce());
  const second = await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect(second?.observations[0].reason).toBe("in_progress"); release();
  expect((await first)?.observations[0].status).toBe("analyzed"); expect(network).toHaveBeenCalledOnce();
});
it("locks simultaneous transactions before claiming the same message", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const bytes = await syntheticImage(); state.download.mockImplementation(async () => { await gate; return bytes; });
  const network = vi.fn<typeof fetch>(async () => visual());
  let completed = 0;
  const pending = [1, 2].map(() => acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network }).then(value => { completed++; return value; }));
  try {
    await vi.waitFor(() => expect(completed).toBe(1));
    expect(state.download).toHaveBeenCalledOnce();
  } finally { release(); }
  const results = await Promise.all(pending);
  expect(results.map(value => value?.observations[0].reason).sort()).toEqual(["in_progress", "observed"]);
  expect(network).toHaveBeenCalledOnce();
});
it("merges a concurrent supportContext update without losing either field", async () => {
  const network = vi.fn<typeof fetch>(async () => {
    await change(value => ({ ...value, supportContext: { version: 1, messageId, collectedAt: new Date().toISOString(), customerIdentity: { kind: "sender", email: "fixture@example.invalid" }, crm: { status: "error", data: null, errorCode: "synthetic-updated-context" }, conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null } }));
    return visual();
  });
  await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect((await body()).supportContext?.crm.errorCode).toBe("synthetic-updated-context");
  expect((await body()).attachmentRead?.observations[0].status).toBe("analyzed");
});
it("does not dispatch after losing ownership during download and never overwrites a new owner", async () => {
  const other = randomUUID(), bytes = await syntheticImage();
  state.download.mockImplementation(async () => { await change(value => ({ ...value, attachmentRead: { ...value.attachmentRead!, claimId: other } })); return bytes; });
  const network = vi.fn(); const result = await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect(result?.observations[0].reason).toBe("context_changed"); expect(network).not.toHaveBeenCalled(); expect((await body()).attachmentRead?.claimId).toBe(other);
});
it("does not adopt or redispatch a visual result after losing its claim during the call", async () => {
  const other = randomUUID();
  const network = vi.fn<typeof fetch>(async () => { await change(value => ({ ...value, attachmentRead: { ...value.attachmentRead!, claimId: other } })); return visual(); });
  const result = await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect(result?.observations[0]).toMatchObject({ reason: "context_changed", text: "" });
  expect((await body()).attachmentRead?.claimId).toBe(other);
  expect((await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network }))?.observations[0].reason).toBe("in_progress");
  expect(network).toHaveBeenCalledOnce();
});
it.each(["ineligible", "ai_disabled", "key_missing"])("does not download or call the provider when %s", async condition => {
  if (condition === "ineligible") state.eligible.mockResolvedValue(false);
  if (condition === "ai_disabled") vi.stubEnv("SAV_AI_ANALYSIS", "false");
  const network = vi.fn();
  const result = await acquireSavAttachmentRead(messageId, { apiKey: condition === "key_missing" ? "" : "fixture", fetch: network });
  expect(result?.observations[0]).toMatchObject({ status: "not_read", reason: "reader_disabled" });
  expect(network).not.toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled();
});
it.each(["ai_disabled", "cutover_revoked"])("rechecks %s after download and before the provider dispatch", async condition => {
  const bytes = await syntheticImage();
  state.download.mockImplementation(async () => {
    if (condition === "ai_disabled") vi.stubEnv("SAV_AI_ANALYSIS", "false");
    else state.eligible.mockResolvedValue(false);
    return bytes;
  });
  const network = vi.fn();
  const result = await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect(result?.observations[0]).toMatchObject({ status: "not_read", reason: "reader_disabled", text: "" });
  expect(network).not.toHaveBeenCalled();
});
it("exposes expired uncertain claims without a blind retry", async () => {
  const bytes = await syntheticImage(); state.download.mockImplementation(async () => { await change(value => ({ ...value, attachmentRead: { ...value.attachmentRead!, startedAt: new Date(0).toISOString() } })); throw new Error("synthetic-crash"); });
  await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: vi.fn() });
  await change(value => ({ ...value, attachmentRead: { ...value.attachmentRead!, state: "reading", completedAt: null, startedAt: new Date(0).toISOString() } }));
  state.download.mockResolvedValue(bytes); const network = vi.fn();
  expect((await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network }))?.observations[0].reason).toBe("outcome_uncertain"); expect(network).not.toHaveBeenCalled();
});
it("does not use image observations after the original text or attachment selection changes", async () => {
  const bytes = await syntheticImage();
  state.download.mockImplementation(async () => { await change(value => ({ ...value, text: "Texte source corrigé synthétiquement." })); return bytes; });
  const network = vi.fn(); const result = await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect(result?.observations[0]).toMatchObject({ reason: "context_changed", text: "" });
  expect((await body()).text).toBe("Texte source corrigé synthétiquement."); expect(network).not.toHaveBeenCalled();
});
it("does not adopt an observation after a new inbound arrives during the provider call", async () => {
  const network = vi.fn<typeof fetch>(async () => {
    await fixture.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "fixture@example.invalid", bodyCiphertext: encryptSavPayload({ text: "Nouveau sujet fictif" }), receivedAt: new Date("2026-10-19T10:01:00Z") });
    return visual();
  });
  const result = await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect(result?.observations[0]).toMatchObject({ status: "not_read", reason: "context_changed", text: "" });
});
it("preserves a human review created during reading and does not attach a fresh diagnosis to it", async () => {
  let reviewId = "";
  let reviewedCiphertext = "";
  const network = vi.fn<typeof fetch>(async () => {
    const [run] = await fixture.db.insert(savAgentRuns).values({ messageId, runtime: "synthetic", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture" }).returning();
    const [decision] = await fixture.db.insert(savDecisions).values({ messageId, agentRunId: run.id, kind: "human_review_required", reasonCode: "fixture", explanation: "Fixture", confidence: 0 }).returning();
    const [review] = await fixture.db.insert(savProposalReviews).values({ messageId, decisionId: decision.id, agentRunId: run.id, revision: 1, status: "approved", verdict: "correct", dimensions: {}, beforeCiphertext: encryptSavPayload({ fixture: true }), afterCiphertext: encryptSavPayload({ human: true }), commentCiphertext: encryptSavPayload({ text: "Revue synthétique" }), reviewedBy: "ugo@limova.ai" }).returning(); reviewId = review.id;
    const [source] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId)); reviewedCiphertext = source.bodyCiphertext;
    return visual();
  });
  const result = await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect(result?.observations[0].reason).toBe("context_changed");
  const [review] = await fixture.db.select().from(savProposalReviews).where(eq(savProposalReviews.id, reviewId)); expect(review.status).toBe("approved");
  const [source] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId)); expect(source.bodyCiphertext).toBe(reviewedCiphertext);
});
it("does not newly read historical messages and retains compatibility with old metadata", async () => {
  await change(value => ({ ...value, attachments: [{ filename: "old.png", mimeType: "image/png", size: 10 }] }));
  await fixture.db.update(savMessages).set({ processedAt: new Date(), analysisStatus: "done" }).where(eq(savMessages.id, messageId));
  const network = vi.fn(); const result = await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: network });
  expect(result?.observations[0].status).toBe("not_read"); expect(network).not.toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled();
});
it("shares the message retention lifecycle without adding a binary store or orphan audit corpus", async () => {
  await acquireSavAttachmentRead(messageId, { apiKey: "fixture", fetch: vi.fn<typeof fetch>(async () => visual()) });
  await fixture.db.delete(savThreads).where(eq(savThreads.id, threadId));
  expect(await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId))).toHaveLength(0);
});
