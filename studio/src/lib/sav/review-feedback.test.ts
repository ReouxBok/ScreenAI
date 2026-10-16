import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { v0Proposal } from "../../../test/sav-v0-review-fixture";
import { sav44Understanding } from "../../../test/sav44-understanding-fixture";
import { savActions, savAgentRuns, savDecisions, savDraftVerdicts, savLearningCandidates, savMailboxes, savMessages, savProposalReviews, savResolutionObservations, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { getSavProposalReview, reviewSavProposal } from "./review";
import { loadSavDraftContext, reviewSavDraft } from "./draft-verdicts";
import { savDossierSourceHash, savDraftSourceHash, savReviewReasonsSchema } from "./review-contract";
import { getSavReviewFeedback } from "./metrics";
import { queueSavManualTicket } from "./manual-tickets";
import { getSavObservations, syncSavObservation } from "./observations";
import type { SavStructuredProposal } from "./proposal";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let f: Awaited<ReturnType<typeof createSavTestDb>>, threadId: string, messageId: string, decisionId: string, runId: string;
let proposal: SavStructuredProposal;
const denyNetwork = vi.fn(() => { throw new Error("Unexpected live request"); });
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => f.client.close());
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "sav44-synthetic-encryption-key-only-for-tests");
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false");
  vi.stubGlobal("fetch", denyNetwork); denyNetwork.mockClear();
  await f.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs; TRUNCATE sav.learning_candidates CASCADE; TRUNCATE sav.ticket_snapshots CASCADE");
  proposal = { ...v0Proposal(), category: "billing", understanding: sav44Understanding() };
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await f.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "synthetic-sav44", subject: "Export fictif", customerEmail: "synthetic@example.invalid" }).returning(); threadId = thread.id;
  const [message] = await f.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, direction: "inbound", gmailMessageId: "synthetic-sav44", subject: thread.subject, fromEmail: thread.customerEmail, bodyCiphertext: encryptSavPayload({ text: "L’export PDF échoue encore après une nouvelle tentative." }), receivedAt: new Date("2026-10-08T10:00:00Z") }).returning(); messageId = message.id;
  const [run] = await f.db.insert(savAgentRuns).values({ messageId, runtime: "local_fixture", mode: "off", status: "succeeded", model: "synthetic", promptRevision: "synthetic-v1", inputHash: "synthetic", codeRevision: "a".repeat(40), proposalCiphertext: encryptSavPayload(proposal) }).returning(); runId = run.id;
  const [decision] = await f.db.insert(savDecisions).values({ messageId, agentRunId: runId, kind: "ticket_pending", reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, confidence: 800 }).returning(); decisionId = decision.id;
});
function dossier() { return { reviewScope: "dossier", messageId, decisionId, agentRunId: runId, expectedReviewId: null, status: "approved", verdict: "partial", dimensions: { classification: "partial", routing: "correct", grounding: "correct", tone: "correct", escalation: "correct" }, comment: "Catégorie d’origine corrigée humainement.", reusability: "none", reasons: ["wrong_category"], correction: { category: "technical", urgency: proposal.urgency, decisionKind: proposal.decision.kind, reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, title: proposal.ticket.title, description: proposal.ticket.description, process: proposal.process, internalNote: "", replyDraft: "" } }; }
async function draft(reasons: string[] = [], status = "rejected") {
  const context = await loadSavDraftContext(messageId);
  const [current] = await f.db.select().from(savDraftVerdicts).where(eq(savDraftVerdicts.isCurrent, true));
  return reviewSavDraft({ threadId, messageId, decisionId, agentRunId: runId, sourceHash: context.sourceHash, expectedVerdictId: current?.id ?? null, status, reason: "", reasons }, "ugo@limova.ai");
}
it("persists independent structured feedback as versioned evaluation cases without knowledge or dispatch", async () => {
  const reviewed = await reviewSavProposal(dossier(), "ugo@limova.ai");
  const rejected = await draft(["off_topic", "misunderstanding"]);
  const detail = await getSavProposalReview(messageId);
  expect(detail?.review?.reasons).toEqual(["wrong_category"]);
  expect(detail?.draftVerdict?.reasons).toEqual(["misunderstanding", "off_topic"]);
  expect(detail?.before.category).toBe(proposal.category); expect(detail?.proposal.category).toBe("technical");
  const feedback = await getSavReviewFeedback();
  expect(feedback.entries).toHaveLength(2);
  expect(feedback.entries.find(entry => entry.id === reviewed.id)).toMatchObject({ scope: "dossier", agentRunId: runId, promptRevision: "synthetic-v1", originalCategory: proposal.category, correctedCategory: "technical", reasons: ["wrong_category"] });
  expect(feedback.entries.find(entry => entry.id === rejected.id)).toMatchObject({ scope: "draft", status: "rejected", reasons: ["misunderstanding", "off_topic"] });
  expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0);
  expect((await queueSavManualTicket({ threadId, reviewId: reviewed.id, kind: "create_ticket" }, "ugo@limova.ai")).kind).toBe("create_ticket");
  expect(denyNetwork).not.toHaveBeenCalled();
});
it("normalizes reason order for repeated clicks but versions a changed reason", async () => {
  const first = await draft(["off_topic", "misunderstanding"]);
  expect((await draft(["misunderstanding", "off_topic", "off_topic"])).id).toBe(first.id);
  const second = await draft(["missing_knowledge"]); expect(second.id).not.toBe(first.id);
  expect(await f.db.select().from(savDraftVerdicts)).toHaveLength(2);
  expect((await getSavReviewFeedback()).entries.find(entry => entry.id === first.id)?.isCurrent).toBe(false);
  expect(await f.db.select().from(savResolutionObservations)).toHaveLength(2);
});
it("preserves legacy encrypted feedback with no reason field", async () => {
  const reviewed = await reviewSavProposal(dossier(), "ugo@limova.ai"); const rejected = await draft();
  await f.db.update(savProposalReviews).set({ commentCiphertext: encryptSavPayload({ text: "Revue historique fictive" }) }).where(eq(savProposalReviews.id, reviewed.id));
  await f.db.update(savDraftVerdicts).set({ reasonCiphertext: encryptSavPayload({ text: "" }) }).where(eq(savDraftVerdicts.id, rejected.id));
  expect((await getSavProposalReview(messageId))?.review?.reasons).toEqual([]);
  expect((await getSavProposalReview(messageId))?.draftVerdict?.reasons).toEqual([]);
  expect((await getSavReviewFeedback()).entries.every(entry => entry.reasons.length === 0)).toBe(true);
  expect((await draft()).id).toBe(rejected.id);
});
it("carries refusal reasons into sourced observation without preparing a candidate", async () => {
  await f.db.update(savThreads).set({ hubspotTicketId: "123" }).where(eq(savThreads.id, threadId));
  await draft(["incorrect_answer"]); const [observation] = await f.db.select().from(savResolutionObservations);
  await syncSavObservation(observation.id, async () => ({ ticketId: "123", status: "closed", updatedAt: "2026-10-08T12:00:00Z", subject: "Synthétique", events: [], errors: [] }));
  expect((await getSavObservations(threadId))[0].cycles[0].summary.refusalReasons).toEqual(["incorrect_answer"]);
  expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0); expect(denyNetwork).not.toHaveBeenCalled();
});
it("invalidates both verdicts on changed understanding but keeps them when only trace changes", async () => {
  await reviewSavProposal(dossier(), "ugo@limova.ai"); await draft([], "accepted");
  const withTrace = { ...proposal, understanding: { ...proposal.understanding!, trace: { ...proposal.understanding!.trace, model: "new-model", durationMs: 900 } } };
  await f.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload(withTrace) }).where(eq(savAgentRuns.id, runId));
  expect((await getSavProposalReview(messageId))?.review?.status).toBe("approved");
  expect((await getSavProposalReview(messageId))?.draftVerdict?.stale).toBe(false);
  await f.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload({ ...withTrace, understanding: { ...withTrace.understanding, requests: [{ ...withTrace.understanding.requests[0], summary: "Une demande différente a été comprise." }] } }) }).where(eq(savAgentRuns.id, runId));
  expect((await getSavProposalReview(messageId))?.review).toBeNull(); expect((await getSavProposalReview(messageId))?.draftVerdict?.stale).toBe(true);
});
it("keeps dossier hashes independent of draft assessment and trace metadata", () => {
  const revised = { ...proposal, replyDraft: "Nouveau texte", replyAssessment: { kind: "human_handoff" as const, coverage: [], errorCode: null } };
  expect(savDossierSourceHash(revised)).toBe(savDossierSourceHash(proposal));
  expect(savDraftSourceHash(revised)).not.toBe(savDraftSourceHash(proposal));
  const diagnostic = { ...revised, replyAssessment: { ...revised.replyAssessment, errorCode: "DIAGNOSTIC_CHANGED" } };
  expect(savDraftSourceHash(diagnostic)).toBe(savDraftSourceHash(revised));
});
it("reads the current draft assessment after retained dossier approval and invalidates draft acceptance", async () => {
  await reviewSavProposal(dossier(), "ugo@limova.ai"); await draft([], "accepted");
  await f.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload({ ...proposal, replyAssessment: { kind: "human_handoff", coverage: [], errorCode: null } }) }).where(eq(savAgentRuns.id, runId));
  const detail = await getSavProposalReview(messageId);
  expect(detail?.review?.status).toBe("approved"); expect(detail?.proposal.replyAssessment?.kind).toBe("human_handoff");
  expect(detail?.draftVerdict?.stale).toBe(true); expect((await loadSavDraftContext(messageId)).proposal.replyAssessment?.kind).toBe("human_handoff");
});
it("requires a fresh draft verdict after a human category correction while preserving the reviewed dossier", async () => {
  await draft([], "accepted"); const reviewed = await reviewSavProposal(dossier(), "ugo@limova.ai");
  const detail = await getSavProposalReview(messageId);
  expect(detail?.review?.id).toBe(reviewed.id); expect(detail?.proposal.category).toBe("technical");
  expect(detail?.draftVerdict?.stale).toBe(true);
});
it("rejects unknown structured reasons rather than storing arbitrary labels", () => {
  expect(savReviewReasonsSchema.safeParse(["autopublish_knowledge"]).success).toBe(false);
});
it("stores the original understanding in encrypted before and after snapshots", async () => {
  await reviewSavProposal(dossier(), "ugo@limova.ai"); const [saved] = await f.db.select().from(savProposalReviews);
  expect(saved.beforeCiphertext).not.toContain("export");
  expect(decryptSavPayload<SavStructuredProposal>(saved.beforeCiphertext).understanding).toEqual(proposal.understanding);
  expect(decryptSavPayload<SavStructuredProposal>(saved.afterCiphertext).understanding).toEqual(proposal.understanding);
});

it("retains verdicts when model-local IDs and coverage links are consistently renamed", async () => {
  for (const fact of [...proposal.understanding!.knownFacts, ...proposal.understanding!.attemptedSteps]) fact.requestIds = ["request-1"];
  proposal.understanding!.customerRelationship = { kind: "existing_customer", evidenceIds: ["evidence-1"] };
  proposal.understanding!.uncertainties = [{ code: "missing_context", requestIds: ["request-1"] }];
  proposal.replyAssessment = { kind: "contextualized", errorCode: null, coverage: [{ requestId: "request-1", text: proposal.replyDraft!, kind: "clarification", sourceIds: ["persistent-kb-source"], missingInformationIds: ["missing-1"], repeatedAttemptIds: ["attempt-1"], repeatJustification: "Une preuve nouvelle fictive." }] };
  await f.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload(proposal) }).where(eq(savAgentRuns.id, runId));
  const approved = await reviewSavProposal(dossier(), "ugo@limova.ai"); await draft([], "accepted");
  const renamed = JSON.parse(JSON.stringify(proposal).replace(/(?:request|evidence|fact|attempt|missing)-1/g, value => `renamed-${value}`)) as SavStructuredProposal;
  expect(savDossierSourceHash(renamed)).toBe(savDossierSourceHash(proposal));
  expect(savDraftSourceHash(renamed)).toBe(savDraftSourceHash(proposal));
  await f.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload(renamed) }).where(eq(savAgentRuns.id, runId));
  const detail = await getSavProposalReview(messageId);
  expect(detail?.review?.id).toBe(approved.id); expect(detail?.draftVerdict?.stale).toBe(false);
  renamed.understanding!.evidence[0].sourceId = "different-source";
  expect(savDossierSourceHash(renamed)).not.toBe(savDossierSourceHash(proposal));
  expect(savDraftSourceHash(renamed)).not.toBe(savDraftSourceHash(proposal));
});
