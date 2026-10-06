import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { collectSavDossierContext, type SavDossierContext } from "./dossier-context";
import { activateSavV0Cutover } from "./cutover";
import { processStoredSavMessage, repairSavProposal } from "./service";
import { buildSavStructuredProposal } from "./proposal";

const state = vi.hoisted(() => ({ db: null as unknown, crm: vi.fn(), analyze: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./hubspot", () => ({ readSavHubspotContext: state.crm }));
vi.mock("./intelligence", () => ({ analyzeSavMessage: state.analyze }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string;
const customer = "customer@example.invalid";
const at = new Date("2026-10-06T12:00:00Z");
async function seed(from = customer, receivedAt = at, mailbox = mailboxId) {
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox, gmailThreadId: crypto.randomUUID(), subject: "Aide produit", customerEmail: "old@example.invalid", lastMessageAt: receivedAt }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox, threadId: thread.id, direction: "inbound", fromEmail: from,
    subject: thread.subject, receivedAt, bodyCiphertext: encryptSavPayload({ text: `Message de ${from}`, html: "<p>Original</p>", headers: { "message-id": "<fixture>" }, attachments: [] }) }).returning();
  return message;
}
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture.client.close(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-dossier-encryption-key-at-least-32");
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false");
  await fixture.client.exec("TRUNCATE sav.mailboxes, sav.sync_state CASCADE");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning(); mailboxId = mailbox.id;
  await activateSavV0Cutover({ receivedAfter: "2026-10-05T00:00:00Z", mailboxEmail: "contact@limova.ai", intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  state.crm.mockResolvedValue({ contactFound: true, contactId: "42", identityCandidates: [], tickets: [], errorCode: null, routing: { kind: "new", reason: "no_candidates" } });
  state.analyze.mockImplementation(async (input, context) => {
    const [stored] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, context.messageId));
    expect(decryptSavPayload<{ supportContext: SavDossierContext }>(stored.bodyCiphertext).supportContext).toEqual(input.dossierContext);
    const analysis = { category: "other" as const, urgency: "normal" as const, proposal: { kind: "human_review_required" as const, reasonCode: "fixture", explanation: "Vérification humaine nécessaire", confidence: 900, requiresHumanApproval: true },
      evidence: [], replyDraft: "Brouillon de test", internalNote: null, model: "fixture" };
    const [run] = await fixture.db.insert(savAgentRuns).values({ messageId: context.messageId, scope: "sav", runtime: "rules", mode: "pilot", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(buildSavStructuredProposal(input, analysis)) }).returning();
    return { ...analysis, agentRunId: run.id };
  });
});

describe("persisted dossier enrichment", () => {
  it("uses the actual sender and persists context before reasoning without changing the source email", async () => {
    const message = await seed();
    await processStoredSavMessage(message.id);
    expect(state.analyze).toHaveBeenCalledOnce();
    expect(state.crm).toHaveBeenCalledWith(expect.objectContaining({ email: customer, toleratePartial: true }));
    const [stored] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, message.id));
    expect(decryptSavPayload(stored.bodyCiphertext)).toMatchObject({ text: `Message de ${customer}`, html: "<p>Original</p>", supportContext: { crm: { status: "ready", data: { contactId: "42" } } } });
  });
  it("retains a found contact during partial ticket lookup failure", async () => {
    state.crm.mockResolvedValue({ contactFound: true, contactId: "42", identityCandidates: [], tickets: [], errorCode: "SAV_HUBSPOT_TICKETS_UNAVAILABLE", routing: { kind: "ambiguous", reason: "hubspot_context_unavailable", candidateIds: [] } });
    const message = await seed();
    expect((await collectSavDossierContext(message.id)).crm).toMatchObject({ status: "partial", data: { contactId: "42" } });
    expect(state.analyze).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("records an unavailable CRM independently of readable email history", async () => {
    state.crm.mockRejectedValue(new Error("private credential"));
    const message = await seed(); const context = await collectSavDossierContext(message.id);
    expect(context.crm).toEqual({ status: "error", data: null, errorCode: "SAV_HUBSPOT_CONTACT_UNAVAILABLE" });
    expect(context.conversation?.messages).toHaveLength(1);
    expect(JSON.stringify(context)).not.toContain("private credential");
  });
  it("includes prior exchanges with the actual sender, never another customer, mailbox or future message", async () => {
    const prior = await seed(customer, new Date("2026-10-06T10:00:00Z"));
    await seed("other@example.invalid", new Date("2026-10-06T10:00:00Z"));
    await seed(customer, new Date("2026-10-06T13:00:00Z"));
    const [otherMailbox] = await fixture.db.insert(savMailboxes).values({ email: "other@limova.ai" }).returning();
    await seed(customer, new Date("2026-10-06T10:00:00Z"), otherMailbox.id);
    const message = await seed(); const context = await collectSavDossierContext(message.id);
    expect(context.otherConversations.map(thread => thread.id)).toEqual([prior.threadId]);
    expect(context.otherConversations[0].relation).toContain("sujet à vérifier");
  });
});

describe("targeted missing-proposal repair", () => {
  async function incomplete() {
    const message = await seed();
    await fixture.db.update(savMessages).set({ processedAt: at, analysisStatus: "done" }).where(eq(savMessages.id, message.id));
    const [decision] = await fixture.db.insert(savDecisions).values({ messageId: message.id, kind: "human_review_required", reasonCode: "old", explanation: "Ancienne analyse sans snapshot", confidence: 0, model: "rules-v1", actorType: "ai" }).returning();
    return { message, decision };
  }
  it("preserves the old decision, links a new proposal and queues no external action", async () => {
    const { message, decision } = await incomplete();
    await repairSavProposal(message.id, "ugo@limova.ai");
    const rows = await fixture.db.select().from(savDecisions);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === decision.id)?.isCurrent).toBe(false);
    expect(rows.find(row => row.isCurrent)).toMatchObject({ supersedesDecisionId: decision.id, agentRunId: expect.any(String) });
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    await expect(repairSavProposal(message.id, "ugo@limova.ai")).rejects.toThrow("SAV_PROPOSAL_ALREADY_AVAILABLE");
    expect(await fixture.db.select().from(savDecisions)).toHaveLength(2);
  });
  it("never replaces a human correction", async () => {
    const { message, decision } = await incomplete();
    await fixture.db.update(savDecisions).set({ actorType: "human" }).where(eq(savDecisions.id, decision.id));
    await expect(repairSavProposal(message.id, "ugo@limova.ai")).rejects.toThrow("SAV_REPAIR_CONTEXT_CHANGED");
    expect(await fixture.db.select().from(savDecisions)).toHaveLength(1);
  });
  it("never repairs historical mail or allows unauthorized staff", async () => {
    const message = await seed(customer, new Date("2026-10-01T12:00:00Z"));
    await expect(repairSavProposal(message.id, "ugo@limova.ai")).rejects.toThrow("SAV_MESSAGE_BEFORE_CUTOVER");
    await expect(repairSavProposal(message.id, "other@limova.ai")).rejects.toThrow();
    expect(state.analyze).not.toHaveBeenCalled();
  });
});
