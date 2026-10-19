import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { activeKnowledge, auditLogs, knowledgeRevisions, savActions, savAgentRuns, savDecisions, savDraftVerdicts, savMailboxes, savMessages, savProposalReviews, savReplyDrafts, savThreads } from "@/db/schema";
import { encryptSavPayload } from "./crypto";
import { activateSavV0Cutover } from "./cutover";
import { buildSavStructuredProposal } from "./proposal";
import type { SavAnalysis } from "./intelligence";
import { cancelReanalysis, compareReanalysis, currentReanalysisTarget, executeReanalysis, generateReanalysisCandidate,
  prepareReanalysisItem, prepareReanalysisManifest, readReanalysisBaseline } from "./reanalysis";
import { reanalysisHash, type ReanalysisManifest } from "./reanalysis-contract";
import { savDossierSourceHash } from "./review-contract";

const state = vi.hoisted(() => ({ db: null as unknown, analyze: vi.fn(), collect: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./intelligence", () => ({ analyzeSavMessage: state.analyze }));
vi.mock("./dossier-context", async original => ({ ...await original<typeof import("./dossier-context")>(), collectSavDossierContext: state.collect }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string;
const analysis: SavAnalysis = { category: "how_to", urgency: "normal", proposal: { kind: "ticket_pending", reasonCode: "fixture", explanation: "Réponse synthétique de configuration.", confidence: 800, requiresHumanApproval: true },
  evidence: [], replyDraft: "Bonjour, voici les étapes de configuration. Cordialement, Limova", internalNote: null, model: "fixture" };
const proposal = buildSavStructuredProposal({ subject: "Configuration", body: "Aide de configuration" }, analysis);
const generated = (): SavAnalysis => ({ ...analysis, structuredProposal: proposal });
async function seed(opened = false, threadId?: string) {
  const [thread] = threadId ? await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId)) : await fixture.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "customer@example.invalid",
    aiPaused: true, humanRequestedAt: new Date(), subject: "Configuration" }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId, threadId: thread.id, direction: "inbound", fromEmail: thread.customerEmail,
    subject: thread.subject, bodyCiphertext: encryptSavPayload({ text: "Aide de configuration" }), receivedAt: new Date(), analysisStatus: "done", studioOpenedAt: opened ? new Date() : null }).returning();
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId: message.id, runtime: "fixture", mode: "shadow", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal) }).returning();
  await fixture.db.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: "ticket_pending", reasonCode: "fixture", explanation: "Synthétique", confidence: 800 });
  return { threadId: thread.id, messageId: message.id };
}
async function plan(pairs: { threadId: string; messageId: string }[]) {
  const target = await currentReanalysisTarget({ projectId: "fixture", teamId: "fixture", databaseHash: "a".repeat(64), codeRevision: "b".repeat(40) });
  const result = await prepareReanalysisManifest({ pairs, since: "2026-10-15T22:00:00Z", until: new Date().toISOString(), target });
  expect(result.manifest).not.toBeNull(); return result.manifest!;
}
function approval(m: ReanalysisManifest) {
  return { version: 1 as const, batchId: m.batchId, manifestHash: reanalysisHash(m), actor: "ugo@limova.ai" as const, mode: "candidate_only" as const,
    codeRevision: m.target.codeRevision, expiresAt: m.expiresAt, messageIds: m.items.map(i => i.messageId), stage: "first" as const };
}
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network"); }));
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false"); vi.stubEnv("SAV_OTHER_OBSERVATION_RULES_JSON", "");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "fixture-reanalysis-key-at-least-32-characters");
  vi.stubEnv("SAV_REANALYSIS_EXECUTION_ENABLED", "true");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs; TRUNCATE active_knowledge");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning(); mailboxId = mailbox.id;
  await activateSavV0Cutover({ receivedAfter: "2026-10-15T22:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "b".repeat(40), activatedBy: "ugo@limova.ai" });
});
describe("candidate-only reanalysis executor", () => {
  it("prepares both requested views without writing or lifting protected flags", async () => {
    const a = await seed(), b = await seed(true), before = await readReanalysisBaseline(a.threadId);
    const m = await plan([a, b]);
    expect(m.items.map(i => i.view)).toEqual(["to_process", "to_validate"]);
    expect(await readReanalysisBaseline(a.threadId)).toBe(before);
    expect(await fixture.db.select().from(auditLogs)).toHaveLength(1); // cutover only
    expect(fetch).not.toHaveBeenCalled();
  });
  it("writes only a separate encrypted candidate and claim; preserves the complete original snapshot", async () => {
    const pair = await seed(true);
    const [decision] = await fixture.db.select().from(savDecisions).where(eq(savDecisions.messageId, pair.messageId));
    const [message] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, pair.messageId));
    const [review] = await fixture.db.insert(savProposalReviews).values({ messageId: pair.messageId, decisionId: decision.id, agentRunId: decision.agentRunId!,
      reviewScope: "dossier", dossierSourceHash: savDossierSourceHash(proposal, message), revision: 1, status: "rejected", verdict: "incorrect", dimensions: {},
      beforeCiphertext: encryptSavPayload(proposal), afterCiphertext: encryptSavPayload(proposal), commentCiphertext: encryptSavPayload({ text: "Correction humaine" }), reviewedBy: "ugo@limova.ai" }).returning();
    const [draft] = await fixture.db.insert(savReplyDrafts).values({ threadId: pair.threadId, messageId: pair.messageId, decisionId: decision.id, agentRunId: decision.agentRunId!, reviewId: review.id,
      revision: 1, status: "draft", bodyCiphertext: encryptSavPayload({ text: "Version humaine conservée" }), createdBy: "ugo@limova.ai" }).returning();
    await fixture.db.insert(savDraftVerdicts).values({ threadId: pair.threadId, messageId: pair.messageId, decisionId: decision.id, agentRunId: decision.agentRunId!, draftId: draft.id,
      sourceHash: "fixture", status: "rejected", snapshotCiphertext: encryptSavPayload({}), reasonCiphertext: encryptSavPayload({}), reviewedBy: "ugo@limova.ai" });
    const m = await plan([pair]), generate = vi.fn(async () => generated());
    const result = await executeReanalysis(m, approval(m), m.target, generate);
    expect(result[0].state).toBe("ready"); expect(generate).toHaveBeenCalledOnce();
    expect(await readReanalysisBaseline(pair.threadId)).toBe(m.items[0].baselineHash);
    const runs = await fixture.db.select().from(savAgentRuns);
    expect(runs).toHaveLength(1); // comparisons never become normal runs or learning signals
    expect((await compareReanalysis(m))[0]).toMatchObject({ stillCurrent: true, original: proposal, candidate: proposal });
    expect((await compareReanalysis(m))[0]).toMatchObject({ humanReview: { status: "rejected" }, savedDraft: { body: { text: "Version humaine conservée" } }, draftVerdict: { status: "rejected" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("skips a repeated execution and also deduplicates across fresh batch IDs", async () => {
    const pair = await seed(), m = await plan([pair]), generate = vi.fn(async () => generated());
    await executeReanalysis(m, approval(m), m.target, generate);
    expect((await executeReanalysis(m, approval(m), m.target, generate))[0].state).toBe("already_claimed");
    const next = { ...m, batchId: randomUUID() };
    expect((await executeReanalysis(next, approval(next), next.target, generate))[0].state).toBe("already_claimed");
    expect(generate).toHaveBeenCalledOnce();
  });
  it("rejects stale human edits before calling a model", async () => {
    const pair = await seed(), m = await plan([pair]), generate = vi.fn();
    await fixture.db.update(savThreads).set({ aiPaused: false }).where(eq(savThreads.id, pair.threadId));
    expect((await executeReanalysis(m, approval(m), m.target, generate))[0].state).toBe("stale");
    expect(generate).not.toHaveBeenCalled();
  });
  it("never follows a new latest message or includes a dossier with unsettled real actions", async () => {
    const pair = await seed(); await seed(false, pair.threadId);
    expect(await prepareReanalysisItem(pair)).toBeNull();
    const other = await seed();
    await fixture.db.insert(savActions).values({ threadId: other.threadId, messageId: other.messageId, kind: "send_reply", actorType: "human", status: "pending", idempotencyKey: randomUUID() });
    expect(await prepareReanalysisItem(other)).toBeNull();
  });
  it("quarantines a candidate if a new message arrives during generation and stops the tranche", async () => {
    const pair = await seed(), other = await seed(), m = await plan([pair, other]);
    const generate = vi.fn(async () => { await seed(false, pair.threadId); return generated(); });
    expect((await executeReanalysis(m, approval(m), m.target, generate))[0].state).toBe("stale");
    expect(generate).toHaveBeenCalledOnce();
  });
  it("does not retry failed or degraded calls and never logs raw provider errors", async () => {
    const pair = await seed(), m = await plan([pair]), generate = vi.fn(async () => { throw new Error("secret customer content"); });
    expect((await executeReanalysis(m, approval(m), m.target, generate))[0].state).toBe("failed");
    await executeReanalysis(m, approval(m), m.target, generate);
    expect(generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(await fixture.db.select().from(auditLogs))).not.toContain("secret customer");
  });
  it("stops at the first degraded draft and never tries the next dossier", async () => {
    const m = await plan([await seed(), await seed()]);
    const generate = vi.fn(async () => ({ ...generated(), replyDraft: null, structuredProposal: { ...proposal, replyDraft: null } }));
    expect((await executeReanalysis(m, approval(m), m.target, generate))[0].state).toBe("degraded");
    expect(generate).toHaveBeenCalledOnce();
  });
  it("rejects changed knowledge before any call", async () => {
    const m = await plan([await seed()]), generate = vi.fn();
    await fixture.db.insert(knowledgeRevisions).values({ id: "fixture", actorEmail: "ugo@limova.ai" }).onConflictDoNothing();
    await fixture.db.insert(activeKnowledge).values({ revisionId: "fixture" });
    expect((await executeReanalysis(m, approval(m), m.target, generate))[0].state).toBe("stale");
    expect(generate).not.toHaveBeenCalled();
  });
  it("supports cancellation before a call and quarantines a call already in flight", async () => {
    const pair = await seed(), m = await plan([pair]), generate = vi.fn(async () => generated());
    await cancelReanalysis(m.batchId);
    expect(await executeReanalysis(m, approval(m), m.target, generate)).toEqual([]); expect(generate).not.toHaveBeenCalled();
    const next = { ...m, batchId: randomUUID() };
    const result = await executeReanalysis(next, approval(next), next.target, async () => { await cancelReanalysis(next.batchId); return generated(); });
    expect(result[0].state).toBe("cancelled");
  });
  it("honours the disabled switch and rejects approval before any generation", async () => {
    const m = await plan([await seed()]), generate = vi.fn();
    vi.stubEnv("SAV_REANALYSIS_EXECUTION_ENABLED", "false");
    await expect(executeReanalysis(m, approval(m), m.target, generate)).rejects.toThrow("DISABLED");
    vi.stubEnv("SAV_REANALYSIS_EXECUTION_ENABLED", "true");
    await expect(executeReanalysis(m, { ...approval(m), manifestHash: "f".repeat(64) }, m.target, generate)).rejects.toThrow("REFUSED");
    expect(generate).not.toHaveBeenCalled();
  });
  it("uses read-only context and deliberately omits the normal analysis persistence ID", async () => {
    const pair = await seed(), item = (await plan([pair])).items[0];
    state.collect.mockResolvedValue({ fixture: true }); state.analyze.mockResolvedValue(generated());
    await generateReanalysisCandidate(item);
    expect(state.collect).toHaveBeenCalledWith(pair.messageId, { persist: false });
    expect(state.analyze).toHaveBeenCalledWith(expect.objectContaining({ dossierContext: { fixture: true } }));
    expect(await readReanalysisBaseline(pair.threadId)).toBe(item.baselineHash);
  });
  it.runIf(Boolean(process.env.SAV_TEST_POSTGRES_URL))("serializes independent competing executors without a second generation", async () => {
    const m = await plan([await seed()]);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const generate = vi.fn(async () => { entered(); await hold; return generated(); });
    const first = executeReanalysis(m, approval(m), m.target, generate);
    await started;
    try {
      expect((await executeReanalysis(m, approval(m), m.target, generate))[0].state).toBe("uncertain");
    } finally { release(); }
    expect((await first)[0].state).toBe("ready"); expect(generate).toHaveBeenCalledOnce();
  });
  it.runIf(Boolean(process.env.SAV_TEST_POSTGRES_URL))("serializes separate batches on disjoint dossiers with a global durable claim", async () => {
    const m = await plan([await seed()]), other = await plan([await seed()]);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const firstGenerate = vi.fn(async () => { entered(); await hold; return generated(); });
    const secondGenerate = vi.fn(async () => generated());
    const first = executeReanalysis(m, approval(m), m.target, firstGenerate);
    await started;
    try {
      expect((await executeReanalysis(other, approval(other), other.target, secondGenerate))[0].state).toBe("uncertain");
      expect(secondGenerate).not.toHaveBeenCalled();
    } finally { release(); }
    expect((await first)[0].state).toBe("ready");
  });
});
