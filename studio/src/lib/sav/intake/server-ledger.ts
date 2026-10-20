import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { savDerivedCostQuote } from "../derived-budget";
import type { SavGeminiMetadata } from "../gemini-response";
import { EVALUATION_ACTION, EVALUATION_CALL, EVALUATION_CAP, EVALUATION_MAX_CALLS, type ServerEvaluationConfig } from "./server-contract";

type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
type Meta = typeof auditLogs.$inferSelect.technicalMetadata;
const lock = async (tx: Tx) => { await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-evaluation-three-only-v1'))`); };
const quote = () => savDerivedCostQuote("gemini-3.6-flash", 8192);
const bad = (): never => { throw Error("SAV_EVAL_LEDGER_REJECTED"); };
function charge(meta: Meta) {
  const cost = meta.chargedNanoUsd;
  if (meta.reservedNanoUsd !== 817_152_000 || !Number.isSafeInteger(cost) || Number(cost) < 0 || Number(cost) > 817_152_000
    || !["dispatched", "settled", "uncertain"].includes(String(meta.state)) || (meta.state !== "settled" && cost !== meta.reservedNanoUsd)) return bad();
  if (meta.state === "settled") {
    const expected = verifiedCost(meta);
    if (expected === null || expected !== cost) return bad();
  }
  return Number(cost);
}
function verifiedCost(metadata: Record<string, unknown>) {
  const { inputTokens, outputTokens, thoughtTokens, totalTokens } = metadata;
  if (![inputTokens, outputTokens, thoughtTokens, totalTokens].every(n => Number.isSafeInteger(n) && Number(n) >= 0)
    || Number(inputTokens) < 1 || Number(inputTokens) > 1_048_576 || Number(outputTokens) + Number(thoughtTokens) > 8192
    || Number(inputTokens) + Number(outputTokens) + Number(thoughtTokens) !== totalTokens) return null;
  return Number(inputTokens) * 750 + (Number(outputTokens) + Number(thoughtTokens)) * 3750;
}
export async function claimServerEvaluation(config: ServerEvaluationConfig, actorEmail: string) {
  return requireDb().transaction(async tx => {
    await lock(tx);
    const existing = await tx.select().from(auditLogs).where(eq(auditLogs.action, EVALUATION_ACTION));
    if (existing.length) {
      if (existing.length !== 1 || existing[0].entityId !== config.manifestHash || existing[0].technicalMetadata.campaignId !== config.campaignId || existing[0].technicalMetadata.codeRevision !== config.codeRevision) return bad();
      return { claimed: false, id: existing[0].id };
    }
    const [row] = await tx.insert(auditLogs).values({ actorEmail, action: EVALUATION_ACTION, entityType: "private_intake_evaluation", entityId: config.manifestHash,
      technicalMetadata: { state: "running", campaignId: config.campaignId, codeRevision: config.codeRevision, resultCiphertext: encryptSavPayload({ results: [], modelCalls: 0 }), startedAt: new Date().toISOString() } }).returning({ id: auditLogs.id });
    return { claimed: true, id: row.id };
  });
}
export async function reserveServerEvaluationCall(runId: string, requestHash: string, actorEmail: string) {
  return requireDb().transaction(async tx => {
    await lock(tx);
    const price = quote();
    const [run] = await tx.select().from(auditLogs).where(and(eq(auditLogs.id, runId), eq(auditLogs.action, EVALUATION_ACTION))).for("update");
    if (!run || run.technicalMetadata.state !== "running") return bad();
    const calls = await tx.select().from(auditLogs).where(eq(auditLogs.action, EVALUATION_CALL));
    const used = calls.reduce((total, call) => total + charge(call.technicalMetadata), 0);
    if (calls.length >= EVALUATION_MAX_CALLS || used + price.reservedNanoUsd > EVALUATION_CAP) throw Error("SAV_EVAL_BUDGET_EXHAUSTED");
    const [row] = await tx.insert(auditLogs).values({ actorEmail, action: EVALUATION_CALL, entityType: "private_intake_evaluation_call", entityId: runId,
      technicalMetadata: { state: "dispatched", requestHash, reservedNanoUsd: price.reservedNanoUsd, chargedNanoUsd: price.reservedNanoUsd, dispatchedAt: new Date().toISOString() } }).returning({ id: auditLogs.id });
    return row.id;
  });
}
export async function settleServerEvaluationCall(id: string, metadata?: SavGeminiMetadata) {
  return requireDb().transaction(async tx => {
    await lock(tx);
    const [row] = await tx.select().from(auditLogs).where(and(eq(auditLogs.id, id), eq(auditLogs.action, EVALUATION_CALL))).for("update");
    if (!row) return bad();
    if (row.technicalMetadata.state !== "dispatched") return row.technicalMetadata.state === "settled";
    const { inputTokens, outputTokens, thoughtTokens, totalTokens } = metadata ?? {};
    const knownCost = verifiedCost(metadata ?? {}), complete = knownCost !== null;
    const cost = knownCost ?? row.technicalMetadata.reservedNanoUsd;
    await tx.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, state: complete ? "settled" : "uncertain", chargedNanoUsd: cost, settledAt: new Date().toISOString(),
      ...(complete ? { inputTokens: inputTokens!, outputTokens: outputTokens!, thoughtTokens: thoughtTokens!, totalTokens: totalTokens! } : {}) } }).where(eq(auditLogs.id, id));
    return complete;
  });
}
export async function saveServerEvaluationResult(runId: string, value: unknown, state: "running" | "complete" | "uncertain") {
  const ciphertext = encryptSavPayload(value);
  return requireDb().transaction(async tx => {
    await lock(tx);
    const [row] = await tx.select().from(auditLogs).where(and(eq(auditLogs.id, runId), eq(auditLogs.action, EVALUATION_ACTION))).for("update");
    if (!row || row.technicalMetadata.state !== "running") return bad();
    await tx.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, state, resultCiphertext: ciphertext } }).where(eq(auditLogs.id, runId));
  });
}
export async function readServerEvaluation(config: ServerEvaluationConfig) {
  const [row] = await requireDb().select().from(auditLogs).where(and(eq(auditLogs.action, EVALUATION_ACTION), eq(auditLogs.entityId, config.manifestHash)));
  if (!row) return null;
  if (row.technicalMetadata.campaignId !== config.campaignId || row.technicalMetadata.codeRevision !== config.codeRevision) return bad();
  const calls = await requireDb().select().from(auditLogs).where(eq(auditLogs.action, EVALUATION_CALL));
  return { runId: row.id, state: row.technicalMetadata.state, stale: row.technicalMetadata.state === "running" && Date.now() - row.createdAt.getTime() > 180_000,
    chargedNanoUsd: calls.reduce((total, call) => total + charge(call.technicalMetadata), 0), callCount: calls.length,
    evidence: decryptSavPayload<unknown>(String(row.technicalMetadata.resultCiphertext)) };
}
