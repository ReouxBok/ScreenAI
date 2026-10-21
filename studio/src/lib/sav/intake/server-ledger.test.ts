import { beforeAll, beforeEach, afterAll, afterEach, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { evaluationEnvironment } from "../../../../test/sav-intake-evaluation";
import { auditLogs, staffUsers, savMessages, savActions } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
import { evaluationConfig, EVALUATION_ACTION, EVALUATION_CALL, type ServerEvaluationConfig } from "./server-contract";
import { claimServerEvaluation, reserveServerEvaluationCall, settleServerEvaluationCall, saveServerEvaluationResult, readServerEvaluation } from "./server-ledger";
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
const admin = "ugo@limova.ai", usage = { inputTokens: 100, outputTokens: 50, thoughtTokens: 0, totalTokens: 150 };
const config = () => evaluationConfig(evaluationEnvironment());
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30000);
afterAll(async () => { await fixture?.client.close(); });
beforeEach(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-server-ledger-encryption-key"); await fixture.client.exec("TRUNCATE public.audit_logs"); });
afterEach(() => vi.unstubAllEnvs());
it("claims once and never restarts an incomplete or completed campaign", async () => {
  const first = await claimServerEvaluation(config(), admin);
  expect(first.claimed).toBe(true); expect(await claimServerEvaluation(config(), admin)).toEqual({ claimed: false, id: first.id });
  await saveServerEvaluationResult(first.id, { results: [] }, "complete");
  expect((await claimServerEvaluation(config(), admin)).claimed).toBe(false);
});
it("does not reset the campaign by changing the pinned hash or campaign name", async () => {
  await claimServerEvaluation(config(), admin);
  await expect(claimServerEvaluation({ ...config(), campaignId: "another" }, admin)).rejects.toThrow();
  await expect(claimServerEvaluation({ ...config(), manifestHash: "b".repeat(64) }, admin)).rejects.toThrow();
});
it("serializes concurrent claims", async () => {
  const claims = await Promise.all([claimServerEvaluation(config(), admin), claimServerEvaluation(config(), admin)]);
  expect(claims.filter(x => x.claimed)).toHaveLength(1); expect(claims[0].id).toBe(claims[1].id);
});
it("admits only three full-window uncertain reservations under3USD", async () => {
  const run = await claimServerEvaluation(config(), admin);
  const attempts = await Promise.allSettled([1, 2, 3, 4].map(n => reserveServerEvaluationCall(run.id, String(n).repeat(64), admin)));
  expect(attempts.filter(x => x.status === "fulfilled")).toHaveLength(3);
  const result = await readServerEvaluation(config()); expect(result?.chargedNanoUsd).toBe(2_451_456_000);
});
it("settles proven usage idempotently and keeps unknown usage fully reserved", async () => {
  const run = await claimServerEvaluation(config(), admin), id = await reserveServerEvaluationCall(run.id, "a".repeat(64), admin);
  expect(await settleServerEvaluationCall(id, usage)).toBe(true);
  expect(await settleServerEvaluationCall(id, { ...usage, inputTokens: 1 })).toBe(true);
  expect((await readServerEvaluation(config()))?.chargedNanoUsd).toBe(262_500);
  const unknown = await reserveServerEvaluationCall(run.id, "b".repeat(64), admin);
  expect(await settleServerEvaluationCall(unknown, { inputTokens: 100, outputTokens: 50, totalTokens: 150 })).toBe(false);
  expect(await settleServerEvaluationCall(unknown, usage)).toBe(false);
  expect((await readServerEvaluation(config()))?.chargedNanoUsd).toBe(817_414_500);
});
it.each([{ ...usage, totalTokens: 999 }, { ...usage, thoughtTokens: -1 }, { ...usage, inputTokens: 2_000_000 }, { ...usage, outputTokens: 9000 }])("retains the reserve for incoherent/over-limit usage", async metadata => {
  const run = await claimServerEvaluation(config(), admin), id = await reserveServerEvaluationCall(run.id, "a".repeat(64), admin);
  expect(await settleServerEvaluationCall(id, metadata)).toBe(false); expect((await readServerEvaluation(config()))?.chargedNanoUsd).toBe(817_152_000);
});
it("caps the campaign at nine generations even after cheap settlements", async () => {
  const run = await claimServerEvaluation(config(), admin);
  for (let n = 0; n < 9; n++) await settleServerEvaluationCall(await reserveServerEvaluationCall(run.id, String(n).repeat(64), admin), usage);
  await expect(reserveServerEvaluationCall(run.id, "f".repeat(64), admin)).rejects.toThrow("SAV_EVAL_BUDGET_EXHAUSTED");
});
it("rejects malformed historical charge metadata", async () => {
  const run = await claimServerEvaluation(config(), admin), id = await reserveServerEvaluationCall(run.id, "a".repeat(64), admin);
  await fixture.db.update(auditLogs).set({ technicalMetadata: { reservedNanoUsd: 817_152_000, chargedNanoUsd: 0, state: "settled" } }).where(eq(auditLogs.id, id));
  await expect(reserveServerEvaluationCall(run.id, "b".repeat(64), admin)).rejects.toThrow("SAV_EVAL_LEDGER_REJECTED");
});
it("encrypts outputs, reads stale status without writes, and leaves operational tables unchanged", async () => {
  const before = { staff: await fixture.db.select().from(staffUsers), messages: await fixture.db.select().from(savMessages), actions: await fixture.db.select().from(savActions) };
  const run = await claimServerEvaluation(config(), admin);
  await saveServerEvaluationResult(run.id, { synthetic: "private customer-like sample" }, "running");
  await fixture.db.update(auditLogs).set({ createdAt: new Date(Date.now() - 200_000) }).where(eq(auditLogs.id, run.id));
  const rows = await fixture.db.select().from(auditLogs); expect(JSON.stringify(rows)).not.toContain("private customer-like sample");
  const result = await readServerEvaluation(config()); expect(result?.stale).toBe(true); expect(result?.evidence).toEqual({ synthetic: "private customer-like sample" });
  expect(await fixture.db.select().from(auditLogs)).toEqual(rows);
  expect(await fixture.db.select().from(staffUsers)).toEqual(before.staff); expect(await fixture.db.select().from(savMessages)).toEqual(before.messages); expect(await fixture.db.select().from(savActions)).toEqual(before.actions);
  expect(await fixture.db.select().from(auditLogs).where(eq(auditLogs.action, EVALUATION_CALL))).toHaveLength(0);
});
async function completedBaseline() {
  const prior = config(), first = await claimServerEvaluation(prior, admin);
  await settleServerEvaluationCall(await reserveServerEvaluationCall(first.id, "a".repeat(64), admin), usage);
  await saveServerEvaluationResult(first.id, { results: ["immutable baseline"] }, "complete");
  const next: ServerEvaluationConfig = { ...prior, campaignId: "synthetic-second", manifestHash: "b".repeat(64), codeRevision: "b".repeat(40),
    continuation: { runId: first.id, campaignId: prior.campaignId, manifestHash: prior.manifestHash, codeRevision: prior.codeRevision } };
  return { prior, first, next };
}
it("allows one pinned continuation, serializes its claims and preserves the original row byte-for-byte", async () => {
  const { prior, first, next } = await completedBaseline();
  const [baseline] = await fixture.db.select().from(auditLogs).where(eq(auditLogs.id, first.id));
  const claims = await Promise.all([claimServerEvaluation(next, admin, prior.manifestHash), claimServerEvaluation(next, admin, prior.manifestHash)]);
  expect(claims.filter(c => c.claimed)).toHaveLength(1); expect(claims[0].id).toBe(claims[1].id);
  await saveServerEvaluationResult(claims[0].id, { results: [] }, "complete");
  expect((await claimServerEvaluation(next, admin, prior.manifestHash)).claimed).toBe(false);
  expect((await fixture.db.select().from(auditLogs).where(eq(auditLogs.id, first.id)))[0]).toEqual(baseline);
  await expect(claimServerEvaluation({ ...next, campaignId: "third", manifestHash: "c".repeat(64), codeRevision: "c".repeat(40) }, admin, prior.manifestHash)).rejects.toThrow("SAV_EVAL_LEDGER_REJECTED");
  await expect(claimServerEvaluation(prior, admin)).rejects.toThrow("SAV_EVAL_LEDGER_REJECTED");
  expect(await fixture.db.select().from(auditLogs).where(eq(auditLogs.action, EVALUATION_ACTION))).toHaveLength(2);
});
it("does not enable a continuation by merely changing a name/hash or omitting proof", async () => {
  const { prior, next } = await completedBaseline();
  const { continuation, ...unpinned } = next; void continuation;
  await expect(claimServerEvaluation(unpinned, admin)).rejects.toThrow();
  await expect(claimServerEvaluation(next, admin)).rejects.toThrow();
  await expect(claimServerEvaluation(next, admin, "f".repeat(64))).rejects.toThrow();
  await expect(claimServerEvaluation(next, "other@example.invalid", prior.manifestHash)).rejects.toThrow();
});
it("refuses a missing/mismatched baseline and every non-complete or uncertain first run", async () => {
  const { prior, first, next } = await completedBaseline();
  for (const patch of [{ runId: "30000000-0000-4000-8000-000000000001" }, { campaignId: "wrong" }, { codeRevision: "c".repeat(40) }]) {
    await expect(claimServerEvaluation({ ...next, continuation: { ...next.continuation!, ...patch } }, admin, prior.manifestHash)).rejects.toThrow();
  }
  const [baseline] = await fixture.db.select().from(auditLogs).where(eq(auditLogs.id, first.id));
  for (const state of ["running", "uncertain"]) {
    await fixture.db.update(auditLogs).set({ technicalMetadata: { ...baseline.technicalMetadata, state } }).where(eq(auditLogs.id, first.id));
    await expect(claimServerEvaluation(next, admin, prior.manifestHash)).rejects.toThrow();
  }
  await fixture.db.update(auditLogs).set({ technicalMetadata: baseline.technicalMetadata }).where(eq(auditLogs.id, first.id));
  await fixture.db.insert(auditLogs).values({ actorEmail: admin, action: EVALUATION_CALL, entityType: "private_intake_evaluation_call", entityId: first.id,
    technicalMetadata: { state: "uncertain", reservedNanoUsd: 817_152_000, chargedNanoUsd: 817_152_000 } });
  await expect(claimServerEvaluation(next, admin, prior.manifestHash)).rejects.toThrow();
});
it("retains the global nine-call cap across both runs after cheap settlements", async () => {
  const { prior, next } = await completedBaseline();
  const second = await claimServerEvaluation(next, admin, prior.manifestHash);
  for (let n = 0; n < 8; n++) await settleServerEvaluationCall(await reserveServerEvaluationCall(second.id, String(n).repeat(64), admin), usage);
  await expect(reserveServerEvaluationCall(second.id, "f".repeat(64), admin)).rejects.toThrow("SAV_EVAL_BUDGET_EXHAUSTED");
  const result = await readServerEvaluation(next); expect(result?.callCount).toBe(9); expect(result?.chargedNanoUsd).toBe(9 * 262_500);
});
it("retains the global dollar cap and never restarts an uncertain second run", async () => {
  const { prior, next } = await completedBaseline(), second = await claimServerEvaluation(next, admin, prior.manifestHash);
  for (let n = 0; n < 3; n++) await reserveServerEvaluationCall(second.id, String(n).repeat(64), admin);
  await expect(reserveServerEvaluationCall(second.id, "f".repeat(64), admin)).rejects.toThrow("SAV_EVAL_BUDGET_EXHAUSTED");
  await saveServerEvaluationResult(second.id, {}, "uncertain");
  expect((await claimServerEvaluation(next, admin, prior.manifestHash)).claimed).toBe(false);
  expect((await readServerEvaluation(next))?.chargedNanoUsd).toBe(262_500 + 3 * 817_152_000);
});
