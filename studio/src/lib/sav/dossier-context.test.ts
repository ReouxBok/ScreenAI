import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { collectLatestSavDossierContext, collectSavDossierContext, type SavDossierContext } from "./dossier-context";
import { activateSavV0Cutover } from "./cutover";
import { processStoredSavMessage, repairSavProposal } from "./service";
import { buildSavStructuredProposal, type SavStructuredProposal } from "./proposal";
import { savDossierSourceHash, savReviewMatchesProposal } from "./review-contract";

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

describe("forwarded customer enrichment", () => {
  it("replaces old colleague enrichment with the original customer without changing the Gmail envelope", async () => {
    const priorClient = await seed(customer, new Date("2026-10-06T10:00:00Z"));
    await seed("colleague@limova.ai", new Date("2026-10-06T10:00:00Z"));
    const message = await seed("colleague@limova.ai");
    await fixture.db.update(savMessages).set({ subject: "À traiter", bodyCiphertext: encryptSavPayload({
      text: `---------- Forwarded message ---------\nFrom: ${customer}\nSubject: Connexion impossible\n\nLe produit ne fonctionne pas.`,
      supportContext: { version: 1, messageId: message.id, crm: { status: "ready", data: { contactId: "old-colleague" } } },
    }) }).where(eq(savMessages.id, message.id));
    const context = await collectSavDossierContext(message.id);
    expect(context.customerIdentity).toEqual({ kind: "forwarded", email: customer });
    expect(state.crm).toHaveBeenCalledWith(expect.objectContaining({ email: customer, subject: "Connexion impossible", currentTicketId: undefined, identityHints: undefined }));
    expect(context.otherConversations.map(thread => thread.id)).toEqual([priorClient.threadId]);
    expect(context.conversation?.messages).toMatchObject([{ from: customer, text: "Le produit ne fonctionne pas." }]);
    const [stored] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, message.id));
    expect(stored.fromEmail).toBe("colleague@limova.ai");
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("blocks ambiguous forwarding without looking up or leaking the colleague's CRM/history", async () => {
    await seed("colleague@limova.ai", new Date("2026-10-06T10:00:00Z"));
    const message = await seed("colleague@limova.ai");
    await fixture.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: "---------- Forwarded message ---------\nFrom: alice@example.com\nFrom: bob@example.com\nSubject: Support\n\nDemande" }) }).where(eq(savMessages.id, message.id));
    const context = await collectSavDossierContext(message.id);
    expect(context.customerIdentity).toEqual({ kind: "unresolved_forward", email: null });
    expect(context.crm).toEqual({ status: "error", data: null, errorCode: "SAV_FORWARDED_CUSTOMER_UNRESOLVED" });
    expect(context.conversation?.messages).toEqual([]);
    expect(context.otherConversations).toEqual([]);
    expect(state.crm).not.toHaveBeenCalled();
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

it("refreshes the latest inbound message instead of an older inbox row or an outbound reply", async () => {
  const older = await seed();
  const [latest] = await fixture.db.insert(savMessages).values({ mailboxId, threadId: older.threadId,
    direction: "inbound", fromEmail: customer, subject: "Dernière demande", receivedAt: new Date(at.getTime() + 1_000),
    bodyCiphertext: encryptSavPayload({ text: "Latest incoming message" }) }).returning();
  await fixture.db.insert(savMessages).values({ mailboxId, threadId: older.threadId, direction: "outbound", fromEmail: "contact@limova.ai",
    subject: "Réponse", receivedAt: new Date(at.getTime() + 2_000), bodyCiphertext: encryptSavPayload({ text: "Outgoing reply" }) });
  expect((await collectLatestSavDossierContext(older.threadId)).messageId).toBe(latest.id);
  const [unchanged] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, older.id));
  expect(decryptSavPayload(unchanged.bodyCiphertext)).not.toHaveProperty("supportContext");
  expect(await fixture.db.select().from(savActions)).toHaveLength(0);
});

it("preserves a review on an unchanged refresh but invalidates it when CRM facts change", async () => {
  const message = await seed(); await processStoredSavMessage(message.id);
  // Opening the dossier refreshes the thread state produced by analysis before review.
  await collectLatestSavDossierContext(message.threadId);
  const [stored] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, message.id));
  const [run] = await fixture.db.select().from(savAgentRuns).where(eq(savAgentRuns.messageId, message.id));
  const [decision] = await fixture.db.select().from(savDecisions).where(eq(savDecisions.messageId, message.id));
  const proposal = decryptSavPayload<SavStructuredProposal>(run.proposalCiphertext!);
  const review = { reviewScope: "dossier", dossierSourceHash: savDossierSourceHash(proposal, stored), decisionId: decision.id, agentRunId: run.id };
  await collectLatestSavDossierContext(message.threadId);
  const [refreshed] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, message.id));
  expect(savReviewMatchesProposal(review, { decisionId: decision.id, agentRunId: run.id, proposal, message: refreshed })).toBe(true);
  state.crm.mockResolvedValue({ contactFound: true, contactId: "43", identityCandidates: [], tickets: [], errorCode: null, routing: { kind: "new", reason: "no_candidates" } });
  await collectLatestSavDossierContext(message.threadId);
  const [changed] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, message.id));
  expect(savReviewMatchesProposal(review, { decisionId: decision.id, agentRunId: run.id, proposal, message: changed })).toBe(false);
});

// Independent review probe: UI and refresher must select the same inbound on a receivedAt tie.
it("independent: refreshes the inbound actually selected for the displayed dossier on tied timestamps", async () => {
 const { getSavThreadDetail } = await import("./service");
 const first = await seed();
 await fixture.db.update(savMessages).set({createdAt: new Date("2026-10-06T14:00:00Z")}).where(eq(savMessages.id, first.id));
 await fixture.db.insert(savMessages).values({mailboxId, threadId:first.threadId, direction:"inbound", fromEmail: customer, id:"00000000-0000-4000-8000-000000000001", subject:"Same-time second import", receivedAt:at, createdAt:new Date("2026-10-06T14:00:00Z"), bodyCiphertext:encryptSavPayload({text:"Second inserted, same timestamps, lower ID"})}).returning();
 const context = await collectLatestSavDossierContext(first.threadId);
 const detail = await getSavThreadDetail(first.threadId);
 const shown = [...detail!.messages].reverse().find(m=>m.direction==="inbound")!;
 expect(context.messageId).toBe(shown.id);
});

it("independent: refresh covers the latest inbound arriving while CRM lookup is in flight", async () => {
 const {getSavThreadDetail} = await import("./service");
 const first=await seed(); let arrivedId="";
 state.crm.mockImplementationOnce(async () => {
  const [arrived]=await fixture.db.insert(savMessages).values({mailboxId,threadId:first.threadId,direction:"inbound",fromEmail:customer,subject:"New incoming message",receivedAt:new Date(at.getTime()+1_000),bodyCiphertext:encryptSavPayload({text:"A new issue"})}).returning(); arrivedId=arrived.id;
  return {contactFound:true, contactId:"42",identityCandidates:[],tickets:[],errorCode:null,routing:{kind:"new",reason:"no_candidates"}};
 });
 const context=await collectLatestSavDossierContext(first.threadId);
 const detail=await getSavThreadDetail(first.threadId);
 const shown=[...detail!.messages].reverse().find(m=>m.direction==="inbound")!;
 expect(shown.id).toBe(arrivedId);
 expect(context.messageId).toBe(shown.id);
});

it("stops with an explicit error if arrivals keep invalidating the refresh", async () => {
  const first = await seed(); let arrivals = 0;
  state.crm.mockImplementation(async () => {
    arrivals++;
    await fixture.db.insert(savMessages).values({ mailboxId, threadId: first.threadId, direction: "inbound", fromEmail: customer,
      subject: "Concurrent message", receivedAt: new Date(at.getTime() + arrivals * 1_000), bodyCiphertext: encryptSavPayload({ text: "New inbound" }) });
    return { contactFound: true, contactId: "42", identityCandidates: [], tickets: [], errorCode: null, routing: { kind: "new", reason: "no_candidates" } };
  });
  await expect(collectLatestSavDossierContext(first.threadId)).rejects.toThrow("SAV_CONTEXT_CHANGED_DURING_REFRESH");
  expect(state.crm).toHaveBeenCalledTimes(3);
  expect(await fixture.db.select().from(savActions)).toHaveLength(0);
});
