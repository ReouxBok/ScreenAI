import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { activeKnowledge, knowledgeRevisions, savActions, savAgentRuns, savDecisions, savDraftVerdicts,
  savLearningCandidates, savMailboxes, savMessages, savReplyDrafts, savResolutionObservations, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { analyzeSavMessage } from "./intelligence";
import { loadSavDraftContext, reviewSavDraft } from "./draft-verdicts";
import { queueSavManualReply } from "./manual-replies";
import { getSavProposalReview, reviewSavProposal } from "./review";
import { syncSavObservation } from "./observations";
import type { SavStructuredProposal } from "./proposal";
import { decisionKindSchema } from "./policy";
import { renderSavOutboundReply } from "./reply-format";

import { understandingFixture } from "../../../test/sav-understanding-fixtures";

const state = vi.hoisted(() => ({ db: null as unknown, search: vi.fn(), crm: vi.fn(), agent: vi.fn(), understand: vi.fn() }));
vi.mock("./understanding-model", () => ({ understandSavMessage: state.understand }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("@/lib/search", () => ({ searchKnowledge: state.search }));
vi.mock("./hubspot", () => ({ readSavHubspotContext: state.crm }));
vi.mock("./agent/orchestrator", () => ({ runSavAdkAgent: state.agent }));

const actor = "ugo@limova.ai";
const template = "Bonjour, voici un formulaire entièrement fictif : https://example.invalid/demo.";
const inbound = { from: "lead@example.invalid", subject: "Découverte Limova", body: "Je souhaite des informations sur un produit Limova avant achat." };
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let threadId: string, messageId: string, decisionId: string, runId: string;
let proposal: SavStructuredProposal;
const denyNetwork = vi.fn(() => { throw new Error("Unexpected provider request in local composition test"); });

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
beforeEach(async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist");
  vi.stubEnv("SAV_WRITES_DISABLED", "false"); vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_ADK_MODE", "off");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "sav-combination-fictitious-key-not-production");
  vi.stubGlobal("fetch", denyNetwork);
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE knowledge_revisions CASCADE; TRUNCATE audit_logs; TRUNCATE sav.learning_candidates CASCADE");
  const [revision] = await fixture.db.insert(knowledgeRevisions).values({ id: crypto.randomUUID(), actorEmail: actor }).returning();
  await fixture.db.insert(activeKnowledge).values({ revisionId: revision.id });
  state.search.mockResolvedValue({ revision: revision.id, results: [{ id: "fictitious-lead-card", contentVersionId: "fictitious-v1", title: "Modèle fictif",
    content: template, score: 0.9, verifiedAt: new Date().toISOString().slice(0, 10), resolution: { audience: "lead", responseTemplate: template,
      symptoms: ["Découverte avant achat"], steps: ["Formulaire fictif"], escalation: "Qualification humaine" } }] });
  const understood = understandingFixture({ customerRelationship: { kind: "prospect", evidenceIds: ["evidence-1"] } });
  understood.requests[0] = { ...understood.requests[0], nature: "commercial", summary: "Découvrir Limova avant achat." };
  understood.evidence[0].excerpt = inbound.body;
  state.understand.mockResolvedValue(understood);
  state.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "no_open_ticket", candidateIds: [] } });
  const analysis = await analyzeSavMessage(inbound);
  proposal = analysis.structuredProposal!;
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai",
    deploymentSha: "a".repeat(40), activatedBy: actor });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "fixture-lead-thread", subject: inbound.subject, customerEmail: inbound.from }).returning();
  threadId = thread.id;
  const [message] = await fixture.db.insert(savMessages).values({ threadId, mailboxId: mailbox.id, direction: "inbound", gmailMessageId: "fixture-lead-message",
    subject: inbound.subject, fromEmail: inbound.from, bodyCiphertext: encryptSavPayload({ text: inbound.body, headers: { "message-id": "<fixture-lead@example.invalid>" } }),
    receivedAt: new Date("2026-10-09T12:00:00Z") }).returning();
  messageId = message.id;
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId, runtime: "local_fixture", mode: "off", status: "succeeded", model: "fixture",
    promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal) }).returning();
  runId = run.id;
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId, agentRunId: runId, kind: decisionKindSchema.parse(proposal.decision.kind),
    reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, confidence: proposal.decision.confidence }).returning();
  decisionId = decision.id;
});

async function dossier() {
  return reviewSavProposal({ reviewScope: "dossier", messageId, decisionId, agentRunId: runId, expectedReviewId: null, status: "approved", verdict: "correct",
    dimensions: { classification: "correct", routing: "correct", grounding: "correct", tone: "correct", escalation: "correct" },
    comment: "Dossier lead fictif vérifié, sans création de ticket.", reusability: "none", correction: { category: proposal.category, urgency: proposal.urgency,
      decisionKind: proposal.decision.kind, reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation,
      title: proposal.ticket.title, description: proposal.ticket.description, process: proposal.process, internalNote: proposal.internalNote ?? "",
      replyDraft: "Cette falsification doit être ignorée par la revue du dossier." } }, actor);
}
async function verdict(status: "accepted" | "rejected") {
  const c = await loadSavDraftContext(messageId);
  const [current] = await fixture.db.select().from(savDraftVerdicts).where(eq(savDraftVerdicts.isCurrent, true));
  return reviewSavDraft({ threadId, messageId, decisionId, agentRunId: runId, sourceHash: c.sourceHash, expectedVerdictId: current?.id ?? null, status }, actor);
}

describe("Combined SAV-38/39/40 V0 contracts with a sourced fictitious lead draft", () => {
  it("validates the dossier without editing, accepting or sending the lead draft", async () => {
    await dossier();
    expect((await getSavProposalReview(messageId))?.proposal.replyDraft).toBe(template);
    expect(proposal.routing.kind).toBe("none");
    expect(proposal.process.some(step => ["create_ticket", "link_ticket"].includes(step.kind))).toBe(false);
    expect(await fixture.db.select().from(savDraftVerdicts)).toHaveLength(0);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    expect(await fixture.db.select().from(savLearningCandidates)).toHaveLength(0);
  });
  it("accepts without sending, then queues exactly one explicitly confirmed unsigned source with a single footer", async () => {
    await dossier(); const accepted = await verdict("accepted");
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    const action = await queueSavManualReply({ threadId, draftId: accepted.draftId }, actor);
    expect((await queueSavManualReply({ threadId, draftId: accepted.draftId }, actor)).id).toBe(action.id);
    const draftText = decryptSavPayload<{ text: string }>(String(action.payload.bodyCiphertext)).text;
    const outbound = decryptSavPayload<{ text: string }>(String(action.payload.outboundBodyCiphertext)).text;
    expect(draftText).toBe(template); expect(outbound.startsWith(template)).toBe(true);
    expect(outbound).toBe(renderSavOutboundReply(template, "fr", "manual_reviewed"));
    expect(outbound.match(/L’équipe Limova/g)).toHaveLength(1);
    expect(await fixture.db.select().from(savActions)).toHaveLength(1);
    expect(action).toMatchObject({ kind: "send_reply", actorType: "human", status: "pending" });
    expect(denyNetwork).not.toHaveBeenCalled();
  });
  it("refuses without rewriting or creating a ticket and waits for a reliable ticket before observation", async () => {
    const approved = await dossier(); await verdict("rejected");
    expect((await getSavProposalReview(messageId))?.review?.id).toBe(approved.id);
    expect((await getSavProposalReview(messageId))?.proposal.replyDraft).toBe(template);
    const [observation] = await fixture.db.select().from(savResolutionObservations);
    expect(observation).toMatchObject({ state: "waiting_ticket", hubspotTicketId: null });
    const collect = vi.fn(); await syncSavObservation(observation.id, collect, new Date());
    expect(collect).not.toHaveBeenCalled(); expect(state.crm).toHaveBeenCalledTimes(1);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    expect(await fixture.db.select().from(savLearningCandidates)).toHaveLength(0);
    expect(denyNetwork).not.toHaveBeenCalled();
  });
  it("requires a new review before sending after the active knowledge revision changes", async () => {
    const accepted = await verdict("accepted");
    const [revision] = await fixture.db.insert(knowledgeRevisions).values({ id: crypto.randomUUID(), actorEmail: actor }).returning();
    await fixture.db.update(activeKnowledge).set({ revisionId: revision.id });
    await expect(queueSavManualReply({ threadId, draftId: accepted.draftId }, actor)).rejects.toThrow("SAV_KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED");
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    expect(decryptSavPayload<{ text: string }>((await fixture.db.select().from(savReplyDrafts))[0].bodyCiphertext).text).toBe(template);
  });
});
