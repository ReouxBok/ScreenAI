import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { activeKnowledge, knowledgeRevisions, savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savProposalReviews, savReplyDrafts, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { encryptSavPayload } from "./crypto";
import { getSavReplyDrafts, saveSavReplyDraft } from "./drafts";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let input: { threadId: string; messageId: string; decisionId: string; agentRunId: string; reviewId: string | null; knowledgeRevision: null; expectedDraftId: string | null; status: string; text: string };
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture.client.close(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-studio-drafts-encryption-key-32-characters");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "draft-fixture", subject: "Facture", customerEmail: "fiction@example.invalid" }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, direction: "inbound", fromEmail: thread.customerEmail, bodyCiphertext: encryptSavPayload({ text: "Cas fictif" }), receivedAt: new Date("2026-10-02T12:01:00Z") }).returning();
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId: message.id, runtime: "local_fixture", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload({ knowledgeRevision: "not_consulted" }) }).returning();
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: "ticket_pending", reasonCode: "fixture", explanation: "Fixture", confidence: 800 }).returning();
  input = { threadId: thread.id, messageId: message.id, decisionId: decision.id, agentRunId: run.id, reviewId: null, knowledgeRevision: null, expectedDraftId: null, status: "draft", text: "Réponse fictive à conserver localement" };
});
describe("Studio-only versioned reply drafts", () => {
  it("encrypts and versions edits without enqueueing any external action", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    try {
      const first = await saveSavReplyDraft(input, "ugo@limova.ai");
      await saveSavReplyDraft({ ...input, expectedDraftId: first.id, text: "Réponse corrigée" }, "ugo@limova.ai");
      const data = await getSavReplyDrafts(input.threadId);
      expect(data.versions).toHaveLength(2);
      expect(data.versions[0]).toMatchObject({ revision: 2, text: "Réponse corrigée", isCurrent: true, stale: false });
      expect(data.versions[1].isCurrent).toBe(false);
      expect((await fixture.db.select().from(savReplyDrafts))[0].bodyCiphertext).not.toContain("Réponse");
      expect(await fixture.db.select().from(savActions)).toHaveLength(0);
      expect(network).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects stale double clicks and validation without an approved process", async () => {
    await saveSavReplyDraft(input, "ugo@limova.ai");
    await expect(saveSavReplyDraft(input, "ugo@limova.ai")).rejects.toThrow("SAV_DRAFT_VERSION_CHANGED");
    await expect(saveSavReplyDraft({ ...input, status: "validated" }, "ugo@limova.ai")).rejects.toThrow("SAV_DRAFT_PROCESS_APPROVAL_REQUIRED");
  });
  it("invalidates previous drafts when the proposal review changes, then validates a refreshed version internally", async () => {
    const first = await saveSavReplyDraft(input, "ugo@limova.ai");
    const [review] = await fixture.db.insert(savProposalReviews).values({ messageId: input.messageId, decisionId: input.decisionId, agentRunId: input.agentRunId, revision: 1, status: "approved", verdict: "partial", dimensions: {}, beforeCiphertext: encryptSavPayload({}), afterCiphertext: encryptSavPayload({}), commentCiphertext: encryptSavPayload({}), reviewedBy: "ugo@limova.ai" }).returning();
    expect((await getSavReplyDrafts(input.threadId)).versions[0].stale).toBe(true);
    await expect(saveSavReplyDraft({ ...input, expectedDraftId: first.id }, "ugo@limova.ai")).rejects.toThrow("SAV_DRAFT_CONTEXT_CHANGED");
    await saveSavReplyDraft({ ...input, reviewId: review.id, expectedDraftId: first.id, status: "validated" }, "ugo@limova.ai");
    expect((await getSavReplyDrafts(input.threadId)).versions[0]).toMatchObject({ stale: false, status: "validated" });
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("blocks old drafts after a new incoming message", async () => {
    const first = await saveSavReplyDraft(input, "ugo@limova.ai");
    const [message] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, input.messageId));
    await fixture.db.insert(savMessages).values({ ...message, id: crypto.randomUUID(), receivedAt: new Date("2026-10-02T12:02:00Z") });
    expect((await getSavReplyDrafts(input.threadId)).versions[0].stale).toBe(true);
    await expect(saveSavReplyDraft({ ...input, expectedDraftId: first.id, status: "abandoned" }, "ugo@limova.ai")).rejects.toThrow("SAV_DRAFT_CONTEXT_CHANGED");
  });
  it("keeps abandoned text in auditable history and rejects unauthorized actors", async () => {
    const first = await saveSavReplyDraft(input, "contact@limova.ai");
    await saveSavReplyDraft({ ...input, expectedDraftId: first.id, status: "abandoned" }, "contact@limova.ai");
    expect((await getSavReplyDrafts(input.threadId)).versions[0].status).toBe("abandoned");
    await expect(saveSavReplyDraft(input, "other@limova.ai")).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
  });
  it("invalidates the draft when the active knowledge changes", async () => {
    const first = await saveSavReplyDraft(input, "ugo@limova.ai");
    const revision = crypto.randomUUID();
    await fixture.db.insert(knowledgeRevisions).values({ id: revision, actorEmail: "ugo@limova.ai" });
    await fixture.db.insert(activeKnowledge).values({ revisionId: revision });
    expect((await getSavReplyDrafts(input.threadId)).versions[0].stale).toBe(true);
    await expect(saveSavReplyDraft({ ...input, expectedDraftId: first.id }, "ugo@limova.ai")).rejects.toThrow("SAV_DRAFT_CONTEXT_CHANGED");
  });
});
