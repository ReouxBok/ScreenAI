import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savActions, savAgentRuns, savAnalysisSnapshots, savDecisions, savDraftVerdicts, savLearningCandidates, savMailboxes, savMessages, savObservationCycles, savPilotBatches, savPilotItems, savProposalReviews, savResolutionObservations, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { encryptSavPayload } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import { savDossierSourceHash } from "./review-contract";
import { listSavDossierDashboard } from "./dashboard";
import { savOtherSubjectHash } from "./other-observation";
import { recordSavDossierOpened } from "./opened-email";
import { findSavExternalCompletion, getSavExternalCompletion, markSavDossiersHandledExternally, revertSavExternalCompletionBatch, SAV_EXTERNAL_COMPLETION } from "./external-completion";

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
  const decisionKind = options.technical ? "spam" : options.noTicket ? "no_ticket_needed" : "ticket_pending";
  proposal.decision.kind = decisionKind;
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId, threadId: thread.id, gmailMessageId: `message-${i}`, direction: "inbound", fromEmail: thread.customerEmail, subject: options.subject ?? thread.subject, bodyCiphertext: encryptSavPayload({ text: "Question synthétique sur le réglage de la téléphonie." }), receivedAt: new Date(Date.parse("2026-10-03T10:00:00Z") + i * 60_000), analysisStatus: "done", studioOpenedAt: options.opening === "opened" ? new Date() : null, studioOpeningTracked: options.opening !== "unknown" }).returning();
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId: message.id, runtime: "fixture", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal) }).returning();
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: decisionKind, reasonCode: "fixture", explanation: "Demande synthétique", confidence: 800 }).returning();
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
  vi.stubEnv("SAV_OTHER_OBSERVATION_RULES_JSON", "");
  vi.stubGlobal("fetch", network);
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_PILOT_MODE", "false"); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning(); mailboxId = mailbox.id;
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
});
describe("SAV-55 dashboard read model", () => {
  it("keeps SAV86 suggestions available without a draft verdict", async () => {
    const row = await seed();
    expect((await listSavDossierDashboard()).rows[0]).toMatchObject({ messageId: row.message.id, draftStatus: "Suggestion disponible" });
    await fixture.db.insert(savDraftVerdicts).values({ threadId: row.thread.id, messageId: row.message.id, decisionId: row.decision.id, agentRunId: row.run.id,
      sourceHash: "fixture", status: "rejected", snapshotCiphertext: encryptSavPayload({}), reasonCiphertext: encryptSavPayload({}), reviewedBy: "ugo@limova.ai" });
    expect((await listSavDossierDashboard()).rows[0].draftStatus).toBe("Suggestion disponible");
  });
  it("invalidates SAV86 snapshot observations with no verdict through qualification and candidate review", async () => {
    const row = await seed({ approved: true, noTicket: true, opening: "opened" });
    expect((await listSavDossierDashboard({ view: "completed" })).total).toBe(1);
    const [snapshot] = await fixture.db.insert(savAnalysisSnapshots).values({ messageId: row.message.id, agentRunId: row.run.id, contentHash: "fixture86", payloadCiphertext: encryptSavPayload({}), codeRevision: "fixture86" }).returning();
    const [obs] = await fixture.db.insert(savResolutionObservations).values({ threadId: row.thread.id, messageId: row.message.id, verdictId: null,
      snapshotId: snapshot.id, trackingOrigin: "analysis_snapshot", hubspotTicketId: "86", state: "closed_to_analyze", closed: true,
      closedCatchupUntil: new Date("2026-10-04"), lastSyncAt: new Date("2026-10-05") }).returning();
    const [cycle] = await fixture.db.insert(savObservationCycles).values({ observationId: obs.id, cycle: 1, status: "closed", summaryCiphertext: encryptSavPayload({}), sourceHash: "fixture86" }).returning();
    expect((await listSavDossierDashboard({ view: "learning" })).rows[0].learning).toBe("qualification");
    const [candidate] = await fixture.db.insert(savLearningCandidates).values({ threadId: row.thread.id, sourceRef: `fixture86:${obs.id}`, sourceContentHash: "fixture86", proposedPatch: {}, explanation: "Synthétique", status: "pending" }).returning();
    await fixture.db.update(savObservationCycles).set({ qualification: "resolved", qualifiedAt: new Date(), candidateId: candidate.id }).where(eq(savObservationCycles.id, cycle.id));
    expect((await listSavDossierDashboard({ view: "learning" })).rows[0].learning).toBe("candidate");
    await fixture.db.update(savLearningCandidates).set({ status: "approved" }).where(eq(savLearningCandidates.id, candidate.id));
    expect((await listSavDossierDashboard({ view: "completed" })).total).toBe(1);
  });
  it("restricts the internal operator selection and its counts to one exact thread", async () => {
    const selected = await seed(); await seed();
    const result = await listSavDossierDashboard({ threadId: selected.thread.id });
    expect(result.rows.map(row => row.messageId)).toEqual([selected.message.id]);
    expect(result.counts.to_process).toBe(1);
    await expect(listSavDossierDashboard({ threadId: "invalid" })).rejects.toThrow("INVALID");
  });
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
  it("keeps a reusable review candidate under follow-up even without an observation cycle", async () => {
    const row = await seed({ approved: true, noTicket: true, opening: "opened" });
    await fixture.db.insert(savLearningCandidates).values({ threadId: row.thread.id, sourceRef: `sav-review:${row.message.id}`, sourceContentHash: "fixture-review", proposedPatch: {}, explanation: "Proposition réutilisable fictive", status: "pending" });
    const result = await listSavDossierDashboard({ view: "learning" });
    expect(result.counts.completed).toBe(0);
    expect(result.rows[0]?.learning).toBe("candidate");
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
    expect((await listSavDossierDashboard()).counts).toEqual({ to_process: 0, to_validate: 0, learning: 0, completed: 0, other: 0, technical: 1, incidents: 0 });
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

describe("SAV-62 external administrative completion", () => {
  const batchId = "10000000-0000-4000-8000-000000000062";
  const boundary = "2026-10-14T16:05:00Z";
  const input = (rows: Array<Awaited<ReturnType<typeof seed>>>, receivedBefore = boundary) => ({ batchId, receivedBefore, messages: rows.map(row => ({ threadId: row.thread.id, messageId: row.message.id })) });
  it.each(["request_human", "schedule_followup", "create_learning_candidate"] as const)("does not mask a pending human %s command", async kind => {
    const row = await seed();
    await fixture.db.insert(savActions).values({ threadId: row.thread.id, messageId: row.message.id, kind, actorType: "human", status: "pending", idempotencyKey: `human-pending:${row.message.id}`, payload: {} });
    expect(await markSavDossiersHandledExternally(input([row]), "ugo@limova.ai")).toMatchObject({ marked: 0, skipped: { unsettled_action: 1 } });
  });
  it("keeps pending ticket learning independent of external handling", async () => {
    const row = await seed();
    await fixture.db.update(savThreads).set({ hubspotTicketId: "62001" }).where(eq(savThreads.id, row.thread.id));
    await fixture.db.insert(savLearningCandidates).values({ hubspotTicketId: "62001", sourceRef: "hubspot:62001", sourceContentHash: "fixture", proposedPatch: {}, explanation: "Apprentissage synthétique sans thread", status: "pending" });
    expect(await markSavDossiersHandledExternally(input([row]), "ugo@limova.ai")).toMatchObject({ marked: 1 });
  });
  it("aligns the detail banner and dashboard when a new human request reopens the dossier", async () => {
    const row = await seed(); await markSavDossiersHandledExternally(input([row]), "ugo@limova.ai");
    expect(await getSavExternalCompletion(row.message)).not.toBeNull();
    await fixture.db.insert(savActions).values({ threadId: row.thread.id, messageId: row.message.id, kind: "request_human", actorType: "human", status: "pending", idempotencyKey: "new-request-human", payload: {} });
    expect(await getSavExternalCompletion(row.message)).toBeNull();
    expect((await listSavDossierDashboard()).counts.completed).toBe(0);
  });
  it("keeps external handling visible when ticket-only learning appears afterward", async () => {
    const row = await seed(); await markSavDossiersHandledExternally(input([row]), "ugo@limova.ai");
    await fixture.db.update(savThreads).set({ hubspotTicketId: "62002" }).where(eq(savThreads.id, row.thread.id));
    await fixture.db.insert(savLearningCandidates).values({ hubspotTicketId: "62002", sourceRef: "hubspot:62002", sourceContentHash: "fixture", proposedPatch: {}, explanation: "Apprentissage synthétique tardif", status: "pending" });
    expect(await getSavExternalCompletion(row.message)).not.toBeNull();
    expect((await listSavDossierDashboard()).counts.completed).toBe(1);
  });
  it("keeps the handling banner while a knowledge candidate awaits separate review", async () => {
    const row = await seed(); await markSavDossiersHandledExternally(input([row]), "ugo@limova.ai");
    await fixture.db.insert(savLearningCandidates).values({ threadId: row.thread.id, sourceRef: "sav-review:fixture62", sourceContentHash: "fixture", proposedPatch: {}, explanation: "Cas synthétique tardif", status: "pending" });
    expect(await getSavExternalCompletion(row.message)).not.toBeNull();
    expect((await listSavDossierDashboard()).counts.completed).toBe(1);
  });
  it("finishes unopened or unreviewed dossiers without approving anything or calling providers", async () => {
    const row = await seed();
    expect((await markSavDossiersHandledExternally(input([row]), "ugo@limova.ai")).marked).toBe(1);
    const result = await listSavDossierDashboard({ view: "completed" });
    expect(result.counts).toMatchObject({ completed: 1, to_process: 0, to_validate: 0 });
    expect(result.rows[0]).toMatchObject({ handledExternally: true, reviewStatus: null, ticketProgress: "required", nextAction: "Traité hors Studio", opening: "unopened" });
    for (const table of [savActions, savProposalReviews, savDraftVerdicts, savLearningCandidates, savResolutionObservations]) expect(await fixture.db.select().from(table)).toHaveLength(0);
    const [thread] = await fixture.db.select().from(savThreads); expect(thread.status).toBe("new"); expect(thread.hubspotTicketId).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });
  it("uses an exclusive received-at boundary, not thread creation or synchronization time", async () => {
    const rows = [await seed(), await seed(), await seed()];
    for (let i = 0; i < rows.length; i++) await fixture.db.update(savMessages).set({ receivedAt: new Date(Date.parse(boundary) + (i - 1)) }).where(eq(savMessages.id, rows[i].message.id));
    expect(await markSavDossiersHandledExternally(input(rows), "ugo@limova.ai")).toMatchObject({ marked: 1, skipped: { after_boundary: 2 } });
    expect((await listSavDossierDashboard()).counts).toMatchObject({ completed: 1, to_process: 2 });
  });
  it("reopens on a new latest inbound and skips a stale preview even before the boundary", async () => {
    const old = await seed(); await markSavDossiersHandledExternally(input([old]), "ugo@limova.ai");
    const current = await seed({ threadId: old.thread.id });
    expect(await getSavExternalCompletion(old.message)).toBeNull();
    expect(await getSavExternalCompletion(current.message)).toBeNull();
    expect((await listSavDossierDashboard()).rows[0]).toMatchObject({ messageId: current.message.id, handledExternally: false });
    expect(await markSavDossiersHandledExternally(input([old]), "ugo@limova.ai")).toMatchObject({ marked: 0, skipped: { new_inbound: 1 } });
  });
  it("does not admit a dossier with a newer inbound after the boundary", async () => {
    const old = await seed(); const current = await seed({ threadId: old.thread.id });
    await fixture.db.update(savMessages).set({ receivedAt: new Date("2026-10-15T08:00:00Z") }).where(eq(savMessages.id, current.message.id));
    expect((await markSavDossiersHandledExternally(input([old]), "ugo@limova.ai")).marked).toBe(0);
    expect((await listSavDossierDashboard()).counts).toMatchObject({ completed: 0, to_process: 1 });
  });
  it("is idempotent, reversible and never silently reapplies a reverted batch", async () => {
    const row = await seed(); const frozen = input([row]);
    await markSavDossiersHandledExternally(frozen, "ugo@limova.ai");
    expect(await markSavDossiersHandledExternally(frozen, "ugo@limova.ai")).toMatchObject({ marked: 0, alreadyCompleted: 1 });
    expect(await revertSavExternalCompletionBatch(batchId, "ugo@limova.ai")).toEqual({ reverted: 1 });
    expect(await revertSavExternalCompletionBatch(batchId, "ugo@limova.ai")).toEqual({ reverted: 0 });
    expect((await listSavDossierDashboard()).counts).toMatchObject({ completed: 0, to_process: 1 });
    expect(await markSavDossiersHandledExternally(frozen, "ugo@limova.ai")).toMatchObject({ marked: 0, skipped: { previously_applied_batch: 1 } });
    expect(await fixture.db.select().from(auditLogs).where(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION))).toHaveLength(1);
  });
  it("preserves human pending/uncertain requests and learning", async () => {
    const pending = await seed(); await ticket(pending, "pending");
    const uncertain = await seed(); await ticket(uncertain, "failed", { ticketCreateDispatchedAt: "2026-10-03T10:10:00Z" });
    const learning = await seed(); await observation(learning);
    expect(await markSavDossiersHandledExternally(input([pending, uncertain, learning]), "ugo@limova.ai")).toMatchObject({ marked: 1, skipped: { unsettled_action: 2 } });
  });
  it("never hides a human action queued after marking, even from another message", async () => {
    const row = await seed(); await markSavDossiersHandledExternally(input([row]), "ugo@limova.ai");
    await ticket(row, "pending");
    expect((await listSavDossierDashboard()).counts.completed).toBe(0);
    expect((await listSavDossierDashboard()).rows[0].handledExternally).toBe(false);
  });
  it("keeps technical exclusions separate and search/pagination counts consistent", async () => {
    const rows = [await seed({ subject: "Alpha fixture" }), await seed({ subject: "Beta fixture" }), await seed({ technical: true })];
    expect(await markSavDossiersHandledExternally(input(rows), "ugo@limova.ai")).toMatchObject({ marked: 2, skipped: { technical_exclusion: 1 } });
    const result = await listSavDossierDashboard({ view: "completed", query: "fixture", pageSize: 1, page: 2 });
    expect(result.counts.completed).toBe(2); expect(result.totalPages).toBe(2); expect(result.rows).toHaveLength(1);
    expect((await listSavDossierDashboard({ view: "technical" })).counts.technical).toBe(1);
  });
  it("rejects another actor, future boundary, duplicates, pilot and historical messages", async () => {
    const row = await seed();
    await expect(markSavDossiersHandledExternally(input([row]), "contact@limova.ai")).rejects.toThrow("FORBIDDEN");
    await expect(markSavDossiersHandledExternally(input([row], "2099-01-01T00:00:00Z"), "ugo@limova.ai")).rejects.toThrow("FUTURE_BOUNDARY");
    await expect(markSavDossiersHandledExternally(input([row, row]), "ugo@limova.ai")).rejects.toThrow("DUPLICATE_INPUT");
    const [batch] = await fixture.db.insert(savPilotBatches).values({ createdBy: "ugo@limova.ai" }).returning();
    await fixture.db.insert(savPilotItems).values({ batchId: batch.id, messageId: row.message.id });
    expect((await markSavDossiersHandledExternally(input([row]), "ugo@limova.ai")).skipped).toEqual({ not_live_eligible: 1 });
    vi.stubEnv("SAV_PILOT_MODE", "true");
    await expect(markSavDossiersHandledExternally(input([row]), "ugo@limova.ai")).rejects.toThrow("V0_ONLY");
  });
  it("ignores malformed, cross-thread and unauthorized audit markers", async () => {
    const row = await seed();
    const [event] = await fixture.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: SAV_EXTERNAL_COMPLETION, entityType: "sav_message", entityId: row.message.id, technicalMetadata: { version: 1, batchId, threadId: row.thread.id, receivedBefore: boundary, reason: "processed_outside_studio" } }).returning();
    expect(findSavExternalCompletion(row.message, [event])?.id).toBe(event.id);
    expect(findSavExternalCompletion(row.message, [{ ...event, actorEmail: "other@example.invalid" }])).toBeNull();
    expect(findSavExternalCompletion(row.message, [{ ...event, technicalMetadata: { ...event.technicalMetadata, threadId: batchId } }])).toBeNull();
    expect(findSavExternalCompletion(row.message, [{ ...event, technicalMetadata: { version: 9 } }])).toBeNull();
  });
});


describe("Autre additive dashboard observation", () => {
  async function candidate(options: Parameters<typeof seed>[0] = {}) {
    const row = await seed({ noTicket: true, subject: "Autre fixture promotion Alpha", ...options });
    const sender = "vistaprint@mail.vistaprint.fr";
    await fixture.db.update(savThreads).set({ customerEmail: sender }).where(eq(savThreads.id, row.thread.id));
    await fixture.db.update(savMessages).set({ fromEmail: sender, bodyCiphertext: encryptSavPayload({ text: "Promotion synthétique à observer uniquement.", headers: { "content-type": "text/plain", "message-id": `<fixture-${row.message.id}@example.invalid>`, references: "", "in-reply-to": "" } }) }).where(eq(savMessages.id, row.message.id));
    await fixture.db.update(savAgentRuns).set({ proposalCiphertext: encryptSavPayload({ ...row.proposal, routing: { kind: "none", reason: "Notification fictive" } }) }).where(eq(savAgentRuns.id, row.run.id));
    return row;
  }
  function configure(...rows: Awaited<ReturnType<typeof seed>>[]) {
    vi.stubEnv("SAV_OTHER_OBSERVATION_RULES_JSON", JSON.stringify({ version: 1, rules: [{ family: "vistaprint_promotions", mailboxId, subjectSha256: [...new Set(rows.map(row => savOtherSubjectHash(row.message.subject)))] }] }));
  }
  it("keeps candidates in their original views and writes no action, review or audit", async () => {
    const row = await candidate();
    const effectTables = [savActions, savProposalReviews, auditLogs] as const;
    const beforeEffects = await Promise.all(effectTables.map(table => fixture.db.select().from(table)));
    const before = await listSavDossierDashboard(); configure(row);
    const other = await listSavDossierDashboard({ view: "other" });
    expect(other.rows.map(r => r.messageId)).toEqual([row.message.id]);
    expect(other.rows[0].otherObservation).toMatchObject({ family: "vistaprint_promotions" });
    expect(other.counts).toEqual({ ...before.counts, other: 1 });
    expect((await listSavDossierDashboard()).rows.map(r => r.messageId)).toEqual([row.message.id]);
    expect(await Promise.all(effectTables.map(table => fixture.db.select().from(table)))).toEqual(beforeEffects);
    expect(network).not.toHaveBeenCalled();
  });
  it("shares search, sorting and pagination, including an out-of-range page", async () => {
    const first = await candidate(), second = await candidate(), unrelated = await candidate({ subject: "Autre fixture autre thème" }); configure(first, second, unrelated);
    const page = await listSavDossierDashboard({ view: "other", query: "Alpha", sort: "oldest", pageSize: 1, page: 2 });
    expect(page).toMatchObject({ total: 2, totalPages: 2, page: 2, counts: { other: 2, to_process: 2 } });
    expect(page.rows[0].messageId).toBe(second.message.id);
    expect((await listSavDossierDashboard({ view: "other", query: "Alpha", sort: "oldest", pageSize: 1, page: 99 })).rows[0].messageId).toBe(second.message.id);
    expect((await listSavDossierDashboard({ view: "other", query: "absent" })).total).toBe(0);
  });
  it("does not carry the prior candidate to a human reply or unknown latest message", async () => {
    const old = await candidate(); configure(old);
    expect((await listSavDossierDashboard({ view: "other" })).total).toBe(1);
    const current = await seed({ threadId: old.thread.id });
    expect((await listSavDossierDashboard({ view: "other" })).total).toBe(0);
    expect((await listSavDossierDashboard()).rows[0].messageId).toBe(current.message.id);
  });
  it.each(["outbound", "other_sender", "historical_review", "ticket", "pause", "human_request", "action"])("keeps a %s context protected", async protection => {
    const old = await candidate({ approved: protection === "historical_review" });
    const current = protection === "historical_review" ? await candidate({ threadId: old.thread.id }) : old;
    if (protection === "outbound" || protection === "other_sender") await fixture.db.insert(savMessages).values({ mailboxId, threadId: old.thread.id, direction: protection === "outbound" ? "outbound" : "inbound", fromEmail: "customer@example.invalid", subject: "Historique fictif", bodyCiphertext: encryptSavPayload({ text: "Historique client synthétique." }), receivedAt: new Date("2026-10-03T09:00:00Z") });
    if (protection === "ticket") await fixture.db.update(savThreads).set({ hubspotTicketId: "fixture-ticket" }).where(eq(savThreads.id, old.thread.id));
    if (protection === "pause") await fixture.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, old.thread.id));
    if (protection === "human_request") await fixture.db.update(savThreads).set({ humanRequestedAt: new Date() }).where(eq(savThreads.id, old.thread.id));
    if (protection === "action") await fixture.db.insert(savActions).values({ threadId: old.thread.id, messageId: old.message.id, kind: "request_human", actorType: "human", status: "pending", idempotencyKey: "fixture-protection", payload: {} });
    configure(current);
    expect((await listSavDossierDashboard({ view: "other" })).total).toBe(0);
    expect((await listSavDossierDashboard()).rows.some(row => row.messageId === current.message.id)).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });
  it("rejects invalid configuration and wrong mailbox without changing primary counts", async () => {
    const row = await candidate();
    for (const configuration of ["", "broken", JSON.stringify({ version: 1, rules: [{ family: "vistaprint_promotions", mailboxId: "10000000-0000-4000-8000-000000000001", subjectSha256: [savOtherSubjectHash(row.message.subject)] }] })]) {
      vi.stubEnv("SAV_OTHER_OBSERVATION_RULES_JSON", configuration);
      expect(await listSavDossierDashboard({ view: "other" })).toMatchObject({ total: 0, counts: { other: 0, to_process: 1 } });
    }
  });
});
