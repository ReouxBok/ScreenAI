import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savActions, savAgentRuns, savDecisions, savDraftVerdicts, savLearningCandidates, savMailboxes, savMessages, savObservationCycles, savPilotBatches, savPilotItems, savProposalReviews, savResolutionObservations, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { encryptSavPayload } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import { savDossierSourceHash } from "./review-contract";
import { listSavDossierDashboard } from "./dashboard";
import { recordSavDossierOpened } from "./opened-email";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string;
let sequence = 0;
const network = vi.fn(() => { throw new Error("Unexpected network in dashboard test"); });
const base = savStructuredProposalSchema.parse({ schemaVersion: 1, category: "how_to", urgency: "normal", decision: { kind: "ticket_pending", reasonCode: "fixture", explanation: "Demande synthétique de paramétrage", confidence: 800 }, routing: { kind: "new", reason: "fixture", contactId: "21" }, ticket: { title: "Configurer la téléphonie", description: "Le client cherche les réglages de téléphonie." }, process: [{ kind: "human_review", label: "Relire le dossier", sourceIds: [] }], internalNote: null, replyDraft: "Brouillon synthétique", sources: [], knowledgeRevision: "not_consulted", model: "fixture" });
async function seed(options: { approved?: boolean; noTicket?: boolean; opening?: "opened" | "unknown" | "unopened"; threadId?: string; subject?: string; technical?: boolean } = {}) {
  const i = ++sequence;
  const [thread] = options.threadId ? await fixture.db.select().from(savThreads).where(eq(savThreads.id, options.threadId)) : await fixture.db.insert(savThreads).values({ mailboxId, gmailThreadId: `gmail-${i}`, subject: options.subject ?? `Demande ${i}`, customerEmail: `fixture-${i}@example.invalid` }).returning();
  const proposal = structuredClone(base);
  if (options.noTicket) proposal.decision.kind = "no_ticket_needed";
  if (options.technical) proposal.decision.kind = "spam";
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId, threadId: thread.id, gmailMessageId: `message-${i}`, direction: "inbound", fromEmail: thread.customerEmail, subject: options.subject ?? thread.subject, bodyCiphertext: encryptSavPayload({ text: "Question synthétique sur le réglage de la téléphonie." }), receivedAt: new Date(Date.parse("2026-10-03T10:00:00Z") + i * 60_000), analysisStatus: "done", studioOpenedAt: options.opening === "opened" ? new Date() : null, studioOpeningTracked: options.opening !== "unknown" }).returning();
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId: message.id, runtime: "fixture", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal) }).returning();
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: proposal.decision.kind, reasonCode: "fixture", explanation: "Demande synthétique", confidence: 800 }).returning();
  if (options.approved) await fixture.db.insert(savProposalReviews).values({ messageId: message.id, agentRunId: run.id, decisionId: decision.id, reviewScope: "dossier", dossierSourceHash: savDossierSourceHash(proposal, message), revision: 1, status: "approved", verdict: "correct", dimensions: {}, beforeCiphertext: encryptSavPayload(proposal), afterCiphertext: encryptSavPayload(proposal), commentCiphertext: encryptSavPayload({ text: "Fictif" }), reviewedBy: "ugo@limova.ai" });
  return { thread, message, run, decision, proposal };
}
async function ticket(row: Awaited<ReturnType<typeof seed>>, status: "succeeded" | "pending" | "failed", payload: Record<string, unknown> = {}) {
  await fixture.db.update(savThreads).set({ hubspotTicketId: "123" }).where(eq(savThreads.id, row.thread.id));
  await fixture.db.insert(savActions).values({ threadId: row.thread.id, messageId: row.message.id, kind: "create_ticket", status, actorType: "human", idempotencyKey: `action-${row.message.id}`, payload: { ...(status === "succeeded" ? { hubspotTicketId: "123" } : {}), ...payload } });
}
async function observation(row: Awaited<ReturnType<typeof seed>>, outcome?: string, candidateStatus?: "pending" | "approved" | "rejected") {
  const [verdict] = await fixture.db.insert(savDraftVerdicts).values({ threadId: row.thread.id, messageId: row.message.id, decisionId: row.decision.id, agentRunId: row.run.id, sourceHash: "fixture", status: "rejected", snapshotCiphertext: encryptSavPayload({}), reasonCiphertext: encryptSavPayload({}), reviewedBy: "ugo@limova.ai" }).returning();
  const [obs] = await fixture.db.insert(savResolutionObservations).values({ threadId: row.thread.id, messageId: row.message.id, verdictId: verdict.id, hubspotTicketId: "123", state: "closed_to_analyze", closed: true, closedCatchupUntil: new Date("2026-10-04"), lastSyncAt: new Date("2026-10-05") }).returning();
  const [candidate] = candidateStatus ? await fixture.db.insert(savLearningCandidates).values({ threadId: row.thread.id, sourceRef: `test:${obs.id}`, sourceContentHash: "fixture", proposedPatch: {}, explanation: "Synthétique", status: candidateStatus }).returning() : [];
  const [cycle] = await fixture.db.insert(savObservationCycles).values({ observationId: obs.id, cycle: 1, status: "closed", summaryCiphertext: encryptSavPayload({}), sourceHash: "fixture", qualification: outcome ?? null, qualifiedAt: outcome ? new Date() : null, candidateId: candidate?.id }).returning();
  return { obs, cycle };
}
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  sequence = 0; network.mockClear();
  vi.stubGlobal("fetch", network);
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false"); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning(); mailboxId = mailbox.id;
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
});
describe("SAV-55 dashboard read model", () => {
  it("shows one latest inbound per dossier and does not inherit a prior opening or verdict", async () => {
    const old = await seed({ approved: true, noTicket: true, opening: "opened" });
    const current = await seed({ threadId: old.thread.id });
    const result = await listSavDossierDashboard();
    expect(result.rows.map(r => r.messageId)).toEqual([current.message.id]);
    expect(result.counts).toMatchObject({ to_process: 1, completed: 0, to_validate: 0, learning: 0 });
    expect(network).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(savActions)).toEqual([]);
  });
  it("uses the same disjoint predicates for counts, search, sorting and pagination", async () => {
    await seed({ subject: "Téléphonie Alpha" });
    await seed({ subject: "Téléphonie Beta" });
    await seed({ subject: "Sans correspondance" });
    await seed({ opening: "opened", approved: true, noTicket: true, subject: "Téléphonie Gamma" });
    const first = await listSavDossierDashboard({ query: "Téléphonie", pageSize: 1, sort: "oldest" });
    const second = await listSavDossierDashboard({ query: "Téléphonie", pageSize: 1, page: 2, sort: "oldest" });
    expect(first.counts).toMatchObject({ to_process: 2, completed: 1 });
    expect(second.counts).toEqual(first.counts); expect(first.rows[0].messageId).not.toBe(second.rows[0].messageId);
    expect(first.total).toBe(2); expect(first.totalPages).toBe(2);
    expect(first.rows[0].summary.title).toBe("Téléphonie Alpha");
    expect((await listSavDossierDashboard({ query: "%_" })).total).toBe(0);
  });
  it("distinguishes unknown historical reading, approved no-ticket and a merely linked HubSpot ticket", async () => {
    await seed({ opening: "unknown" });
    await seed({ opening: "unknown", approved: true, noTicket: true });
    const linked = await seed({ opening: "opened", approved: true });
    await fixture.db.update(savThreads).set({ hubspotTicketId: "456" }).where(eq(savThreads.id, linked.thread.id));
    const result = await listSavDossierDashboard({ view: "to_validate" });
    expect(result.counts).toMatchObject({ to_process: 0, to_validate: 2, completed: 1 });
    expect(result.rows.find(r => r.messageId === linked.message.id)).toMatchObject({ ticketProgress: "required", ticket: { id: "456", status: "Statut à actualiser" } });
  });
  it("honors a legacy opening audit emitted after the migration during a rolling release", async () => {
    const row = await seed();
    await fixture.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: "sav_email_opened", entityType: "sav_message", entityId: row.message.id, technicalMetadata: { gmailFilingStatus: "failed" } });
    const result = await listSavDossierDashboard({ view: "to_validate" });
    expect(result.rows[0].opening).toBe("opened"); expect(result.counts.to_process).toBe(0);
  });
  it("does not call failed, pending or dispatched-but-unacknowledged actions confirmed", async () => {
    for (const status of ["pending", "failed", "succeeded"] as const) { const row = await seed({ approved: true, opening: "opened" }); await ticket(row, status); }
    const uncertain = await seed({ approved: true, opening: "opened" }); await ticket(uncertain, "failed", { ticketCreateDispatchedAt: new Date().toISOString() });
    const result = await listSavDossierDashboard({ view: "to_validate" });
    expect(result.counts).toMatchObject({ to_validate: 3, completed: 1, incidents: 2 });
    expect(result.rows.map(r => r.ticketProgress)).toEqual(["uncertain", "failed", "pending"]);
  });
  it("keeps closed summaries and pending candidates under follow-up until qualification completes", async () => {
    const unqualified = await seed({ approved: true, noTicket: true, opening: "opened" }); await observation(unqualified);
    const pending = await seed({ approved: true, noTicket: true, opening: "opened" }); await observation(pending, "resolved", "pending");
    const approved = await seed({ approved: true, noTicket: true, opening: "opened" }); await observation(approved, "resolved", "approved");
    const abandoned = await seed({ approved: true, noTicket: true, opening: "opened" }); await observation(abandoned, "abandoned");
    const incomplete = await seed({ approved: true, noTicket: true, opening: "opened" }); await observation(incomplete, "insufficient_sources");
    const result = await listSavDossierDashboard({ view: "learning" });
    expect(result.counts).toMatchObject({ learning: 3, completed: 2 });
    expect(result.rows.map(r => r.learning)).toEqual(["incomplete", "candidate", "qualification"]);
  });
  it("does not finish a resolved cycle whose expected candidate is missing", async () => {
    const row = await seed({ approved: true, noTicket: true, opening: "opened" });
    await observation(row, "resolved");
    expect((await listSavDossierDashboard({ view: "learning" })).rows[0].learning).toBe("qualification");
  });
  it("keeps the last catch-up in progress even after qualification", async () => {
    const row = await seed({ approved: true, noTicket: true, opening: "opened" });
    const { obs } = await observation(row, "abandoned");
    await fixture.db.update(savResolutionObservations).set({ lastSyncAt: new Date("2026-10-03") }).where(eq(savResolutionObservations.id, obs.id));
    expect((await listSavDossierDashboard({ view: "learning" })).rows[0].learning).toBe("catchup");
  });
  it("excludes pilot messages and technical dossiers from the four primary counts", async () => {
    await seed({ technical: true });
    const row = await seed();
    const [batch] = await fixture.db.insert(savPilotBatches).values({ createdBy: "ugo@limova.ai" }).returning();
    await fixture.db.insert(savPilotItems).values({ batchId: batch.id, messageId: row.message.id });
    expect((await listSavDossierDashboard()).counts).toEqual({ to_process: 0, to_validate: 0, learning: 0, completed: 0, technical: 1, incidents: 0 });
    expect((await listSavDossierDashboard({ view: "technical" })).rows).toHaveLength(1);
  });
  it("does not carry an approval across a changed proposal", async () => {
    const row = await seed({ approved: true, noTicket: true, opening: "opened" });
    await fixture.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload({ ...row.proposal, ticket: { ...row.proposal.ticket, description: "Nouvelle demande différente" } }) }).where(eq(savAgentRuns.id, row.run.id));
    expect((await listSavDossierDashboard({ view: "to_validate" })).rows[0].reviewStatus).toBeNull();
  });
});
describe("Studio direct URL opening", () => {
  it("records the latest message idempotently with no provider or filing action", async () => {
    const row = await seed();
    await recordSavDossierOpened({ threadId: row.thread.id, messageId: row.message.id }, "contact@limova.ai");
    await recordSavDossierOpened({ threadId: row.thread.id, messageId: row.message.id }, "ugo@limova.ai");
    expect((await listSavDossierDashboard({ view: "to_validate" })).rows[0].opening).toBe("opened");
    const audits = await fixture.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_dossier_opened"));
    expect(audits).toHaveLength(1); expect(audits[0].technicalMetadata.gmailFilingStatus).toBe("not_requested");
    expect(network).not.toHaveBeenCalled(); expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("rejects another thread, stale inbound and unauthorized actors before recording", async () => {
    const old = await seed(), other = await seed();
    await expect(recordSavDossierOpened({ threadId: other.thread.id, messageId: old.message.id }, "ugo@limova.ai")).rejects.toThrow("SAV_OPENING_CONTEXT_CHANGED");
    await seed({ threadId: old.thread.id });
    await expect(recordSavDossierOpened({ threadId: old.thread.id, messageId: old.message.id }, "ugo@limova.ai")).rejects.toThrow("SAV_OPENING_CONTEXT_CHANGED");
    await expect(recordSavDossierOpened({ threadId: other.thread.id, messageId: other.message.id }, "other@example.invalid")).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    expect(await fixture.db.select().from(auditLogs).where(eq(auditLogs.action, "sav_dossier_opened"))).toHaveLength(0);
  });
});
