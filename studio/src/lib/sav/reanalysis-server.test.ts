import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savAgentRuns, savDecisions, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { encryptSavPayload } from "./crypto";
import { activateSavV0Cutover } from "./cutover";
import { buildSavStructuredProposal } from "./proposal";
import { guardReanalysisDatabase, reanalysisServerIdentity } from "./reanalysis-database";
import { runSavReanalysisServer } from "./reanalysis-server";
import { readReanalysisBaseline } from "./reanalysis";
import { reanalysisHash, type ReanalysisManifest } from "./reanalysis-contract";
import type { SavAnalysis } from "./intelligence";

const state = vi.hoisted(() => ({ db: null as unknown, analyze: vi.fn(), collect: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./intelligence", () => ({ analyzeSavMessage: state.analyze }));
vi.mock("./dossier-context", async original => ({ ...await original<typeof import("./dossier-context")>(), collectSavDossierContext: state.collect }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string;
const analysis: SavAnalysis = { category: "how_to", urgency: "normal", proposal: { kind: "ticket_pending", reasonCode: "fixture", explanation: "Configuration synthétique.", confidence: 800, requiresHumanApproval: true }, evidence: [], replyDraft: "Bonjour, voici les étapes. Cordialement, Limova", internalNote: null, model: "fixture" };
const proposal = buildSavStructuredProposal({ subject: "Configuration", body: "Aide de configuration" }, analysis);
async function seed() {
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "customer@example.invalid", aiPaused: true, humanRequestedAt: new Date(), subject: "Configuration" }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId, threadId: thread.id, direction: "inbound", fromEmail: thread.customerEmail, subject: thread.subject, bodyCiphertext: encryptSavPayload({ text: "Aide de configuration" }), receivedAt: new Date(), analysisStatus: "done" }).returning();
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId: message.id, runtime: "fixture", mode: "shadow", status: "succeeded", model: "fixture", promptRevision: "fixture", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal) }).returning();
  await fixture.db.insert(savDecisions).values({ messageId: message.id, agentRunId: run.id, kind: "ticket_pending", reasonCode: "fixture", explanation: "Synthétique", confidence: 800 });
  return { threadId: thread.id, messageId: message.id };
}
async function authorize(pair: Awaited<ReturnType<typeof seed>>) {
  return await runSavReanalysisServer({ op: "authorize", expectedIdentity: reanalysisServerIdentity(), selection: { since: "2026-10-15T22:00:00Z", until: new Date().toISOString(), pairs: [pair] }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) as { operationId: string };
}
async function plan() {
  const pair = await seed(), grant = await authorize(pair);
  const planned = await runSavReanalysisServer({ op: "plan", operationId: grant.operationId, messageIds: [pair.messageId] }) as { manifest: ReanalysisManifest; seal: string };
  expect(planned.manifest).not.toBeNull();
  const m = planned.manifest;
  const approval = { version: 1, batchId: m.batchId, manifestHash: reanalysisHash(m), actor: "ugo@limova.ai", mode: "candidate_only", codeRevision: m.target.codeRevision, expiresAt: m.expiresAt, messageIds: [pair.messageId], stage: "first" };
  return { pair, operationId: grant.operationId, ...planned, approval };
}
beforeAll(async () => { fixture = await createSavTestDb(); state.db = guardReanalysisDatabase(fixture.db); }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network"); }));
  for (const [name, value] of Object.entries({ NODE_ENV: "production", VERCEL_ENV: "production", SAV_RELEASE_STAGE: "v0", SAV_PILOT_MODE: "false", SAV_TEST_MODE: "false", VERCEL_PROJECT_ID: "prj_uVRT3wH5tI3cfHtTktG15pG2IzQz", VERCEL_ORG_ID: "", VERCEL_GIT_COMMIT_SHA: "a".repeat(40), SAV_CODE_REVISION: "", DATABASE_URL: "postgres://fixture:private@test.neon.tech/db?sslmode=require", SAV_ENCRYPTION_KEY_V1: "fixture-reanalysis-key-at-least-32-characters", SAV_GEMINI_API_KEY: "fixture", SAV_REANALYSIS_EXECUTION_ENABLED: "false", SAV_OTHER_OBSERVATION_RULES_JSON: "" })) vi.stubEnv(name, value);
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs; TRUNCATE active_knowledge");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning(); mailboxId = mailbox.id;
  // Fixture setup is outside the production write boundary.
  state.db = fixture.db;
  await activateSavV0Cutover({ receivedAfter: "2026-10-15T22:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  state.db = guardReanalysisDatabase(fixture.db);
  state.collect.mockResolvedValue({ fixture: true }); state.analyze.mockResolvedValue({ ...analysis, structuredProposal: proposal });
});
describe("authenticated server reanalysis with the actual guarded executor", () => {
  it("cannot overwrite an ordinary audit even with its exact ID, or escape via upsert", async () => {
    const [ordinary] = await fixture.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: "human_review", entityType: "sav_message", entityId: randomUUID(), technicalMetadata: { protected: true } }).returning();
    const guarded = guardReanalysisDatabase(fixture.db);
    await guarded.update(auditLogs).set({ technicalMetadata: {} }).where(eq(auditLogs.id, ordinary.id));
    expect((await fixture.db.select().from(auditLogs).where(eq(auditLogs.id, ordinary.id)))[0].technicalMetadata).toEqual({ protected: true });
    expect(() => guarded.insert(auditLogs).values({ id: ordinary.id, actorEmail: "ugo@limova.ai", action: "sav_reanalysis_claim", entityType: "sav_reanalysis_message", entityId: randomUUID() }).onConflictDoUpdate({ target: auditLogs.id, set: { technicalMetadata: {} } })).toThrow("AUDIT_REFUSED");
  });
  it("authorizes, seals, executes and compares without changing the original dossier or creating normal runs", async () => {
    const p = await plan(), baseline = await readReanalysisBaseline(p.pair.threadId);
    const result = await runSavReanalysisServer({ op: "execute", operationId: p.operationId, manifest: p.manifest, seal: p.seal, approval: p.approval });
    expect(result).toMatchObject({ results: [{ state: "ready" }] });
    expect(await readReanalysisBaseline(p.pair.threadId)).toBe(baseline);
    expect(await fixture.db.select().from(savAgentRuns)).toHaveLength(1);
    expect(state.collect).toHaveBeenCalledWith(p.pair.messageId, { persist: false });
    expect(state.analyze).toHaveBeenCalledOnce();
    const compared = await runSavReanalysisServer({ op: "compare", operationId: p.operationId, manifest: p.manifest, seal: p.seal });
    expect(compared).toMatchObject({ comparisons: [{ original: proposal, candidate: proposal, stillCurrent: true }] });
    const rows = await fixture.db.select().from(auditLogs);
    expect(rows.filter(r => r.action.startsWith("sav_reanalysis_")).every(r => r.actorEmail === "ugo@limova.ai")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses unselected messages, modified seals and changed deployment identity before a model call", async () => {
    const p = await plan();
    await expect(runSavReanalysisServer({ op: "plan", operationId: p.operationId, messageIds: [randomUUID()] })).rejects.toThrow("SELECTION_REFUSED");
    await expect(runSavReanalysisServer({ op: "execute", operationId: p.operationId, manifest: { ...p.manifest, batchId: randomUUID() }, seal: p.seal, approval: p.approval })).rejects.toThrow("SEAL_REFUSED");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "b".repeat(40));
    await expect(runSavReanalysisServer({ op: "plan", operationId: p.operationId, messageIds: [p.pair.messageId] })).rejects.toThrow("GRANT_REFUSED");
    expect(state.analyze).not.toHaveBeenCalled();
  });
  it("revokes an issued operation and its batches without any generation", async () => {
    const p = await plan();
    expect(await runSavReanalysisServer({ op: "revoke", operationId: p.operationId })).toEqual({ revoked: true });
    await expect(runSavReanalysisServer({ op: "execute", operationId: p.operationId, manifest: p.manifest, seal: p.seal, approval: p.approval })).rejects.toThrow("GRANT_REFUSED");
    expect(state.analyze).not.toHaveBeenCalled();
  });
  it("refuses a dispatch paused before admission when revocation commits meanwhile", async () => {
    const p = await plan(), guarded = guardReanalysisDatabase(fixture.db);
    let reached!: () => void, resume!: () => void, intercept = true;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    state.db = new Proxy(guarded, { get(db, key) {
      if (key === "transaction") return async (...args: Parameters<typeof db.transaction>) => {
        if (intercept) { intercept = false; reached(); await resumed; }
        return Reflect.apply(db.transaction, db, args);
      };
      const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
    } });
    const execution = runSavReanalysisServer({ op: "execute", operationId: p.operationId, manifest: p.manifest, seal: p.seal, approval: p.approval });
    const rejected = expect(execution).rejects.toThrow("GRANT_REFUSED");
    await waiting;
    await runSavReanalysisServer({ op: "revoke", operationId: p.operationId });
    resume(); await rejected;
    expect(state.analyze).not.toHaveBeenCalled();
  });
  it("rejects an expired or excessive authorization window", async () => {
    const pair = await seed();
    await expect(runSavReanalysisServer({ op: "authorize", expectedIdentity: reanalysisServerIdentity(), selection: { since: "2026-10-15T22:00:00Z", until: new Date().toISOString(), pairs: [pair] }, expiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString() })).rejects.toThrow("AUTHORIZATION_REFUSED");
    expect(state.analyze).not.toHaveBeenCalled();
  });
});
