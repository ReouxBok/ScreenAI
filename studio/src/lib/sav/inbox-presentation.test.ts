import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { v0Proposal } from "../../../test/sav-v0-review-fixture";
import { understandingFixture } from "../../../test/sav-understanding-fixtures";
import { savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savProposalReviews, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { encryptSavPayload } from "./crypto";
import { getSavProposalReview, reviewSavProposal } from "./review";
import { listSavInbox } from "./service";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let messageId: string, threadId: string, runId: string, decisionId: string;
let proposal = { ...v0Proposal(), understanding: understandingFixture() };
const denyNetwork = vi.fn(() => { throw new Error("UNEXPECTED_NETWORK_REQUEST"); });

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => fixture.client.close());
afterEach(() => { expect(denyNetwork).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "sav53-synthetic-only-encryption-key-32-characters");
  vi.stubGlobal("fetch", denyNetwork); denyNetwork.mockClear();
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs");
  proposal = { ...v0Proposal(), understanding: understandingFixture() };
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "synthetic-inbox-thread", subject: "Re: Re: Ancien sujet", customerEmail: "synthetic@example.invalid" }).returning(); threadId = thread.id;
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, gmailMessageId: "synthetic-inbox-message", direction: "inbound", fromEmail: thread.customerEmail, subject: thread.subject, bodyCiphertext: encryptSavPayload({ text: "L’agent téléphone cesse de répondre." }), receivedAt: new Date("2026-10-13T10:00:00Z"), analysisStatus: "done" }).returning(); messageId = message.id;
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId, runtime: "local_fixture", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal) }).returning(); runId = run.id;
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId, agentRunId: runId, kind: "ticket_pending", reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, confidence: 800 }).returning(); decisionId = decision.id;
});

function reviewInput() {
  return { reviewScope: "dossier", messageId, decisionId, agentRunId: runId, expectedReviewId: null,
    status: "approved", verdict: "partial", dimensions: { classification: "partial", routing: "correct", grounding: "correct", tone: "correct", escalation: "correct" },
    comment: "Correction synthétique vérifiée pour la liste.", reusability: "none",
    correction: { category: "acknowledgement", urgency: proposal.urgency, decisionKind: "no_ticket_needed", reasonCode: "human_confirmation", explanation: "Le message confirme simplement la réception de la réponse.",
      title: "Confirmation de réception", description: "Le client confirme la réception ; aucune demande nouvelle.", process: proposal.process, internalNote: "", replyDraft: "" } };
}

it("uses the same current human correction as the detail without changing the stored subject", async () => {
  const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
  const [row] = await listSavInbox(10);
  const detail = await getSavProposalReview(messageId);
  expect(row.reviewId).toBe(review.id); expect(row.summary.title).toBe(detail?.proposal.ticket.title);
  expect(row.summary.problem).toBe(detail?.proposal.ticket.description); expect(row.summary.nextAction).toBe("Vérifier qu’aucune suite n’est nécessaire.");
  expect(row.subject).toBe("Re: Re: Ancien sujet");
  expect((await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0].subject).toBe(row.subject);
});

it("ignores obsolete human corrections and does not retain a reviewed filter slot", async () => {
  await reviewSavProposal(reviewInput(), "ugo@limova.ai");
  const changed = { ...proposal, understanding: { ...proposal.understanding, requests: [{ ...proposal.understanding.requests[0], feature: "export PDF", summary: "L’export PDF ne fonctionne plus." }] } };
  await fixture.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload(changed) }).where(eq(savAgentRuns.id, runId));
  const [row] = await listSavInbox(10);
  expect(row.reviewId).toBeNull(); expect(row.summary.title).toContain("export PDF");
  expect(row.summary.problem).toBe("L’export PDF ne fonctionne plus."); expect(row.summary.title).not.toBe("Confirmation de réception");
  expect(await listSavInbox(10, { view: "reviewed" })).toHaveLength(0);
  expect(await listSavInbox(10, { view: "pending" })).toHaveLength(1);
});

it("falls back safely if the current encrypted proposal is unreadable", async () => {
  await fixture.db.update(savAgentRuns).set({ proposalCiphertext: "unreadable-synthetic-payload" }).where(eq(savAgentRuns.id, runId));
  const [row] = await listSavInbox(10);
  expect(row.reviewId).toBeNull(); expect(row.summary).toMatchObject({ title: "Ancien sujet", sourceLabel: "Objet de l’email" });
  expect(row.summary.problem).toContain("Aucun résumé fiable");
});

it("does not let an unreadable correction keep a verdict or replace the current meaning", async () => {
  const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
  await fixture.db.update(savProposalReviews).set({ afterCiphertext: "unreadable-synthetic-correction" }).where(eq(savProposalReviews.id, review.id));
  const [row] = await listSavInbox(10);
  expect(row.reviewId).toBeNull(); expect(row.summary.problem).toBe("L’agent téléphone cesse de répondre.");
});

it("separates a degraded composition diagnostic from the understood problem", async () => {
  await fixture.db.update(savAgentRuns).set({ status: "fallback", errorCode: "SAV_REPLY_COHERENCE_REJECTED" }).where(eq(savAgentRuns.id, runId));
  const [row] = await listSavInbox(10, { view: "errors" });
  expect(row.analysisErrorCode).toBe("SAV_REPLY_COHERENCE_REJECTED");
  expect(row.summary.problem).toBe("L’agent téléphone cesse de répondre.");
  expect(row.summary.nextAction).toContain("vérifier la proposition");
});

async function partnershipProposal() {
  proposal.understanding.requests[0].nature = "partnership";
  proposal.understanding.requests[0].summary = "Propose un partenariat fictif.";
  await fixture.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload(proposal) }).where(eq(savAgentRuns.id, runId));
}

it.each([
  ["succeeded", true, "Déjà transféré à Nathan."],
  ["failed", true, "Résultat du transfert à Nathan incertain."],
  ["running", true, "Résultat du transfert à Nathan incertain."],
  ["pending", false, "Transfert à Nathan en attente."],
  ["running", false, "Transfert à Nathan en attente."],
  ["failed", false, "Transfert à Nathan non confirmé."],
  ["cancelled", false, "Transfert à Nathan non confirmé."],
] as const)("reads transfer journal %s / dispatched=%s without duplicating inbox rows", async (status, dispatched, expected) => {
  await partnershipProposal();
  await fixture.db.insert(savActions).values({ threadId, messageId, decisionId, kind: "send_reply", actorType: "human", actorEmail: "ugo@limova.ai", status,
    idempotencyKey: `gmail:partnership-forward:${messageId}`, payload: { purpose: "partnership_forward", ...(dispatched ? { forwardDispatchedAt: new Date().toISOString() } : {}) } });
  const rows = await listSavInbox(10);
  expect(rows).toHaveLength(1); expect(rows[0].summary.nextAction).toContain(expected);
  expect(rows[0].summary.nextAction).not.toContain("Relire la demande de partenariat et préparer");
});

it("does not confuse a customer reply or a prior email transfer with the current request", async () => {
  await partnershipProposal();
  const [current] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  const [old] = await fixture.db.insert(savMessages).values({ threadId, mailboxId: current.mailboxId, gmailMessageId: "older-partnership-message", direction: "inbound", fromEmail: current.fromEmail, subject: current.subject, bodyCiphertext: current.bodyCiphertext, receivedAt: new Date("2026-10-12T10:00:00Z") }).returning();
  await fixture.db.insert(savActions).values([
    { threadId, messageId: old.id, kind: "send_reply", actorType: "human", actorEmail: "ugo@limova.ai", status: "succeeded", idempotencyKey: `gmail:partnership-forward:${old.id}`, payload: { purpose: "partnership_forward", forwardDispatchedAt: new Date().toISOString() } },
    { threadId, messageId, decisionId, kind: "send_reply", actorType: "human", actorEmail: "ugo@limova.ai", status: "succeeded", idempotencyKey: `gmail:manual-reply:${messageId}`, payload: { manualReplyConfirmed: true, replySendDispatchedAt: new Date().toISOString() } },
  ]);
  const row = (await listSavInbox(10)).find(row => row.messageId === messageId)!;
  expect(row.summary.nextAction).toBe("Relire la demande de partenariat et préparer le transfert à Nathan.");
});

it("keeps a financial request actionable after the partnership journal confirms delivery", async () => {
  await partnershipProposal();
  proposal.understanding.requests.push({ ...proposal.understanding.requests[0], id: "finance", nature: "financial_data", financialScope: "support_account", summary: "Demande aussi sa facture." });
  await fixture.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload(proposal) }).where(eq(savAgentRuns.id, runId));
  await fixture.db.insert(savActions).values({ threadId, messageId, decisionId, kind: "send_reply", actorType: "human", actorEmail: "ugo@limova.ai", status: "succeeded", idempotencyKey: `gmail:partnership-forward:${messageId}`, payload: { purpose: "partnership_forward" } });
  const [row] = await listSavInbox(10);
  expect(row.summary.problem).toContain("sa facture");
  expect(row.summary.nextAction).toBe("Valider le dossier pour une prise en charge humaine. Déjà transféré à Nathan.");
});
