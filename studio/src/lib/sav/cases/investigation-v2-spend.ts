import type { CaseModelTransportDiagnostic } from "./investigation-transport-diagnostic";
import { createHash } from "node:crypto";
import { assertSavSharedSpend, lockSavSharedSpend } from "../shared-spend";
import "server-only";
import { eq, like } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import type { CaseEmbeddingSpendPort, CaseEmbeddingUsage } from "./investigation-budgeted-retrieval";
import type { CaseCallMoneyGate } from "./investigation-call-ledger";
import type { CaseInvestigationModelRequest } from "./investigation-runner";

/*
 * V2 keeps its model/embedding sub-budgets and canonical receipts. An additional shared gate reads the existing V1 monetary
 * ledgers under the same reservation lock; no copied ledger or reset. Every V2 amount comes from the spend
 * policy Ugo approves (`SAV_V2_SPEND_POLICY_JSON`, integers in micro-dollars); absent or malformed, nothing is reserved, so nothing is sent.
 * Order: reserve before the call (the policy's per-call amount, refused past the daily cap), settle after it from the reported usage, release
 * only when nothing was sent. An unknown or uncertain usage keeps the reserved amount: never settled as free, never released.
 * Stored in `sav.sync_state` (one row per purpose and UTC day, locked for each change): no migration.
 */

export const SAV_V2_SPEND_POLICY_ENV = "SAV_V2_SPEND_POLICY_JSON";
export const SAV_V2_SPEND_KEY_PREFIX = "sav-v2-spend.v1";
export type CaseV2SpendPurpose = "embedding" | "model";

const microUsd = z.number().int().nonnegative().max(1_000_000_000_000);
const positive = z.number().int().positive().max(1_000_000_000_000);
const spendPolicySchema = z.object({
  revision: z.string().trim().min(1).max(200),
  approvedBy: z.string().uuid(),
  approvedAt: z.string().datetime({ offset: true }),
  // Operator-approved exact model/tariff envelope. Required by live adapters;
  // old accounting rows/policies remain readable without inventing new prices.
  transport: z.object({ model: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,99}$/), embeddingModel: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,99}$/),
    priceExpiresAt: z.string().datetime({ offset: true }), maxInputTokens: positive.max(1_048_576), maxOutputTokens: positive.max(8192),
    maxInputBytes: positive.max(1_000_000), embeddingMaxInputTokens: positive.max(8192), embeddingMaxTexts: positive.max(3), embeddingMaxTextBytes: positive.max(16_000),
  }).strict().optional(),
  embedding: z.object({ dailyCapMicroUsd: positive, reserveMicroUsdPerCall: positive, microUsdPerMillionInputTokens: microUsd }).strict(),
  model: z.object({ dailyCapMicroUsd: positive, reserveMicroUsdPerCall: positive, microUsdPerMillionInputTokens: microUsd, microUsdPerMillionOutputTokens: microUsd }).strict(),
}).strict().refine(policy => policy.embedding.reserveMicroUsdPerCall <= policy.embedding.dailyCapMicroUsd && policy.model.reserveMicroUsdPerCall <= policy.model.dailyCapMicroUsd);
export type CaseV2SpendPolicy = z.infer<typeof spendPolicySchema>;
export type CaseV2SpendPolicyRead = { ok: true; policy: CaseV2SpendPolicy } | { ok: false; reason: "v2_spend_policy_absent" | "v2_spend_policy_invalid" };

/** The approved V2 spend policy, read from the environment at each call; absent or malformed is no budget. */
export function readCaseV2SpendPolicy(env: Readonly<Record<string, string | undefined>>): CaseV2SpendPolicyRead {
  const raw = env[SAV_V2_SPEND_POLICY_ENV];
  if (raw === undefined || raw.trim() === "") return { ok: false, reason: "v2_spend_policy_absent" };
  if (raw.length > 8_192) return { ok: false, reason: "v2_spend_policy_invalid" };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, reason: "v2_spend_policy_invalid" }; }
  const parsed = spendPolicySchema.safeParse(value);
  return parsed.success ? { ok: true, policy: parsed.data } : { ok: false, reason: "v2_spend_policy_invalid" };
}

/** Full approved input window + bounded output (including thoughts), not an
 * optimistic average token estimate. Input bytes + framing use the existing V1
 * conservative assumption, not a mathematical tokenizer guarantee. Provider limits/tariffs are explicit operator pins,
 * not discovered by a paid call. They must be qualified before activation. */
export function readCaseV2TransportPolicy(env: Readonly<Record<string,string|undefined>>, now = new Date()) {
  const read = readCaseV2SpendPolicy(env);
  if (!read.ok) throw Error("SAV_V2_TRANSPORT_POLICY_REQUIRED");
  const { transport: t, model, embedding } = read.policy;
  if (!t || t.model !== env.SAV_V2_MODEL || t.embeddingModel !== env.SAV_V2_EMBEDDING_MODEL
    || !Number.isFinite(now.getTime()) || Date.parse(t.priceExpiresAt)<=now.getTime()
    || t.maxInputTokens < t.maxInputBytes + 16_384 || t.embeddingMaxInputTokens < t.embeddingMaxTextBytes + 256
    || model.microUsdPerMillionInputTokens<=0 || model.microUsdPerMillionOutputTokens<=0 || embedding.microUsdPerMillionInputTokens<=0)
    throw Error("SAV_V2_TRANSPORT_POLICY_INVALID");
  const ceiling = (value:bigint) => Number((value+BigInt(999_999))/BigInt(1_000_000));
  const modelReserve = ceiling(BigInt(t.maxInputTokens)*BigInt(model.microUsdPerMillionInputTokens)+BigInt(t.maxOutputTokens)*BigInt(model.microUsdPerMillionOutputTokens));
  const embeddingReserve = ceiling(BigInt(t.embeddingMaxInputTokens)*BigInt(t.embeddingMaxTexts)*BigInt(embedding.microUsdPerMillionInputTokens));
  if (![modelReserve,embeddingReserve].every(Number.isSafeInteger) || model.reserveMicroUsdPerCall<modelReserve || embedding.reserveMicroUsdPerCall<embeddingReserve)
    throw Error("SAV_V2_TRANSPORT_RESERVATION_TOO_SMALL");
  return t;
}

const policyFingerprint = (env: Readonly<Record<string,string|undefined>>) => createHash("sha256").update(JSON.stringify([env[SAV_V2_SPEND_POLICY_ENV],env.SAV_V2_MODEL,env.SAV_V2_EMBEDDING_MODEL])).digest("hex");
type Held = { amount: number; revision: string; policyHash?: string };
type DayState = { purpose: CaseV2SpendPurpose; day: string; settledMicroUsd: number; open: Record<string, Held>; done: Record<string, number>; verifiedUsage?: string[]; reservationExceeded?: boolean };
export type CaseV2SpendDeps = Readonly<{ env: () => Readonly<Record<string, string | undefined>>; now: () => Date }>;
export type CaseV2SpendUsage = Readonly<{ inputTokens?: number; outputTokens?: number }>;

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const keyOf = (purpose: CaseV2SpendPurpose, day: string) => `${SAV_V2_SPEND_KEY_PREFIX}:${purpose}:${day}`;
const reservationIdOf = (purpose: CaseV2SpendPurpose, day: string, callKey: string) => `${purpose}:${day}:${callKey}`;
function parseReservationId(id: string): { purpose: CaseV2SpendPurpose; day: string; callKey: string } | null {
  const match = /^(embedding|model):(\d{4}-\d{2}-\d{2}):(.+)$/.exec(id);
  return match ? { purpose: match[1] as CaseV2SpendPurpose, day: match[2]!, callKey: match[3]! } : null;
}

/** One purpose-day row, locked for the change; created empty on first use. */
async function withDay<T>(purpose: CaseV2SpendPurpose, day: string, change: (state: DayState, tx: Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0]) => { state: DayState | null; result: T } | Promise<{ state: DayState | null; result: T }>): Promise<T> {
  const key = keyOf(purpose, day);
  return requireDb().transaction(async tx => {
    await lockSavSharedSpend(tx);
    await tx.insert(savSyncState).values({ key, cursor: JSON.stringify({ purpose, day, settledMicroUsd: 0, open: {}, done: {} } satisfies DayState), status: "open" }).onConflictDoNothing();
    const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key)).for("update");
    const state = JSON.parse(row!.cursor ?? "null") as DayState;
    const { state: next, result } = await change(state, tx);
    if (next) await tx.update(savSyncState).set({ cursor: JSON.stringify(next), processedCount: Object.keys(next.done).length, updatedAt: new Date() }).where(eq(savSyncState.key, key));
    return result;
  });
}

export type CaseV2SpendReservation = { status: "allowed"; reservationId: string; amountMicroUsd: number } | { status: "refused"; reason: string };

/** Reserves the policy's per-call amount for this call key, or refuses (no policy, cap reached, call already settled). Idempotent per call key and day. */
export async function reserveCaseV2Spend(deps: CaseV2SpendDeps, purpose: CaseV2SpendPurpose, callKey: string): Promise<CaseV2SpendReservation> {
  const reservedPolicyHash = policyFingerprint(deps.env());
  const read = readCaseV2SpendPolicy(deps.env());
  if (!read.ok) return { status: "refused", reason: read.reason };
  if (typeof callKey !== "string" || !callKey.trim() || callKey.length > 500) return { status: "refused", reason: "v2_spend_call_key_invalid" };
  const section = read.policy[purpose], amount = section.reserveMicroUsdPerCall, day = dayOf(deps.now()), reservationId = reservationIdOf(purpose, day, callKey);
  return withDay<CaseV2SpendReservation>(purpose, day, async (state, tx) => {
    for (const row of await tx.select().from(savSyncState).where(like(savSyncState.key,`${SAV_V2_SPEND_KEY_PREFIX}:${purpose}:%`))) {
      if (row.key===keyOf(purpose,day)) continue;
      const prior = JSON.parse(row.cursor ?? "null") as DayState | null;
      if (prior?.reservationExceeded) return {state:null,result:{status:"refused" as const,reason:"v2_spend_reservation_bound_exceeded"}};
      if (!prior || Object.hasOwn(prior.open,callKey) || Object.hasOwn(prior.done,callKey)) return {state:null,result:{status:"refused" as const,reason:"v2_spend_call_previously_reserved"}};
    }
    if (state.reservationExceeded) return {state:null,result:{status:"refused" as const,reason:"v2_spend_reservation_bound_exceeded"}};
    if (state.open[callKey]) return { state: null, result: { status: "allowed" as const, reservationId, amountMicroUsd: state.open[callKey]!.amount } };
    if (state.done[callKey] !== undefined) return { state: null, result: { status: "refused" as const, reason: "v2_spend_call_already_settled" } };
    const committed = state.settledMicroUsd + Object.values(state.open).reduce((sum, held) => sum + held.amount, 0);
    if (committed + amount > section.dailyCapMicroUsd) return { state: null, result: { status: "refused" as const, reason: `v2_spend_${purpose}_daily_cap_reached` } };
    try { await assertSavSharedSpend(tx, amount * 1000, deps.now()); }
    catch (error) { return { state: null, result: { status: "refused" as const, reason: error instanceof Error && error.message.startsWith("SAV_SHARED_SPEND_") ? error.message : "SAV_SHARED_SPEND_UNAVAILABLE" } }; }
    return { state: { ...state, open: { ...state.open, [callKey]: { amount, revision: read.policy.revision, policyHash: reservedPolicyHash } } }, result: { status: "allowed" as const, reservationId, amountMicroUsd: amount } };
  });
}

function costOf(policy: CaseV2SpendPolicy, purpose: CaseV2SpendPurpose, usage: CaseV2SpendUsage): number | null {
  const tokens = (value: number | undefined) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const input = tokens(usage.inputTokens);
  if (input === null) return null;
  const ceil = (n:bigint) => { const cost=Number((n+BigInt(999_999))/BigInt(1_000_000));return Number.isSafeInteger(cost) ? cost : null; };
  if (purpose === "embedding") return ceil(BigInt(input) * BigInt(policy.embedding.microUsdPerMillionInputTokens));
  const output = tokens(usage.outputTokens);
  if (output === null) return null;
  return ceil(BigInt(input) * BigInt(policy.model.microUsdPerMillionInputTokens) + BigInt(output) * BigInt(policy.model.microUsdPerMillionOutputTokens));
}

/**
 * Settles a dispatched call: the cost of the reported usage under the SAME policy revision it was reserved under; otherwise (usage unknown,
 * call uncertain, policy changed or unreadable) the reserved amount, never less. A second settle is a no-op.
 */
export type CaseV2SpendSettle = { settled: true; costMicroUsd: number; fromUsage: boolean } | { settled: false; reason: string };
export async function settleCaseV2Spend(deps: CaseV2SpendDeps, input: Readonly<{ reservationId: string; usage: CaseV2SpendUsage | "unknown"; uncertain: boolean }>): Promise<CaseV2SpendSettle> {
  const id = parseReservationId(input.reservationId);
  if (!id) return { settled: false, reason: "v2_spend_reservation_invalid" };
  const read = readCaseV2SpendPolicy(deps.env());
  return withDay<CaseV2SpendSettle>(id.purpose, id.day, state => {
    const held = state.open[id.callKey];
    if (!held) return { state: null, result: { settled: false as const, reason: state.done[id.callKey] !== undefined ? "already_settled" : "v2_spend_reservation_unknown" } };
    const computed = input.usage !== "unknown" && !input.uncertain && read.ok && read.policy.revision === held.revision && held.policyHash === policyFingerprint(deps.env()) ? costOf(read.policy, id.purpose, input.usage) : null;
    const cost = computed ?? held.amount;
    const open = { ...state.open };
    delete open[id.callKey];
    return { state: { ...state, open, ...(cost>held.amount ? {reservationExceeded:true} : {}), verifiedUsage: computed !== null ? [...(state.verifiedUsage ?? []), id.callKey] : (state.verifiedUsage ?? []), settledMicroUsd: state.settledMicroUsd + cost, done: { ...state.done, [id.callKey]: cost } }, result: { settled: true as const, costMicroUsd: cost, fromUsage: computed !== null } };
  });
}

/** Releases a reservation whose call was never sent. Only an open reservation is released; a settled one never is. */
export async function releaseCaseV2Spend(input: Readonly<{ reservationId: string }>): Promise<{ released: boolean }> {
  const id = parseReservationId(input.reservationId);
  if (!id) return { released: false };
  return withDay<{ released: boolean }>(id.purpose, id.day, state => {
    if (!state.open[id.callKey]) return { state: null, result: { released: false } };
    const open = { ...state.open };
    delete open[id.callKey];
    return { state: { ...state, open }, result: { released: true } };
  });
}

/** What a purpose-day has committed (settled plus held), for diagnostics and tests. */
export async function readCaseV2SpendDay(purpose: CaseV2SpendPurpose, day: string) {
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, keyOf(purpose, day)));
  if (!row?.cursor) return null;
  const state = JSON.parse(row.cursor) as DayState;
  return { settledMicroUsd: state.settledMicroUsd, heldMicroUsd: Object.values(state.open).reduce((sum, held) => sum + held.amount, 0), open: Object.keys(state.open).length, settled: Object.keys(state.done).length };
}

/** Read-only fence for the live embedding transport after every awaited guard.
 * A policy/model change cannot spend an old, smaller reservation. */
export async function assertCaseV2ReservedPolicy(reservationId:string, env:Readonly<Record<string,string|undefined>>) {
  const id=parseReservationId(reservationId);
  if (!id) throw Error("SAV_V2_SPEND_RESERVATION_INVALID");
  const [row]=await requireDb().select().from(savSyncState).where(eq(savSyncState.key,keyOf(id.purpose,id.day)));
  const state=row?.cursor ? JSON.parse(row.cursor) as DayState : null;
  if (!state?.open[id.callKey] || state.open[id.callKey]!.policyHash!==policyFingerprint(env)) throw Error("SAV_V2_SPEND_POLICY_CHANGED");
}

/** `CaseEmbeddingSpendPort` on the V2 `embedding` budget. */
export function caseV2EmbeddingSpend(deps: CaseV2SpendDeps): CaseEmbeddingSpendPort {
  return {
    reserve: async request => {
      const reserved = await reserveCaseV2Spend(deps, "embedding", request.callKey);
      return reserved.status === "allowed" ? { status: "allowed", reservationId: reserved.reservationId } : reserved;
    },
    settle: async input => {
      const usage: CaseEmbeddingUsage | "unknown" = input.usage;
      await settleCaseV2Spend(deps, { reservationId: input.reservationId, usage: usage === "unknown" ? "unknown" : { ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }) }, uncertain: input.uncertain });
    },
    release: async input => { await releaseCaseV2Spend(input); },
  };
}

type ProviderResult = { status: "ok"; output: unknown } | { status: "failed"; uncertain: boolean; diagnostic?: CaseModelTransportDiagnostic };
/** A model transport that reports what the provider said it used (null when it said nothing usable). */
export type CaseV2ModelTransport = (request: CaseInvestigationModelRequest) => Promise<{ result: ProviderResult; usage: CaseV2SpendUsage | null }>;

/**
 * The V2 `model` budget around the ledger adapter: `money` reserves before dispatch (a refusal defers, nothing sent); `provider` settles
 * after the call from the reported usage, or the reserved amount when it is unknown or the call is uncertain (a thrown transport included).
 */
export function caseV2ModelSpend(deps: CaseV2SpendDeps) {
  const held = new Map<string, string>();
  const policies = new Map<string,string>();
  const fingerprint = () => JSON.stringify([deps.env()[SAV_V2_SPEND_POLICY_ENV],deps.env().SAV_V2_MODEL,deps.env().SAV_V2_EMBEDDING_MODEL]);
  const money: CaseCallMoneyGate = async request => {
    const reserved = await reserveCaseV2Spend(deps, "model", request.callKey);
    if (reserved.status !== "allowed") return { status: "refused", reason: reserved.reason };
    held.set(request.callKey, reserved.reservationId);
    policies.set(request.callKey,fingerprint());
    return { status: "allowed" };
  };
  const provider = (transport: CaseV2ModelTransport) => async (request: CaseInvestigationModelRequest): Promise<ProviderResult> => {
    // The reservation made for this call, on the day it was made, even if midnight has passed since. None: not sent, since nothing could account for it.
    const reservationId = held.get(request.callKey);
    if (!reservationId) return { status: "failed", uncertain: false, diagnostic: { stage: "reservation", code: "reservation_missing", networkAttempted: false } };
    held.delete(request.callKey);
    const policy = policies.get(request.callKey); policies.delete(request.callKey);
    let matches = policy === fingerprint();
    try { await assertCaseV2ReservedPolicy(reservationId,deps.env()); } catch { matches=false; }
    if (!matches) {
      await releaseCaseV2Spend({reservationId});
      return {status:"failed",uncertain:false,diagnostic:{stage:"reservation",code:"reservation_policy_changed",networkAttempted:false}};
    }
    let sent: Awaited<ReturnType<CaseV2ModelTransport>>;
    try { sent = await transport(request); } catch (error) {
      await settleCaseV2Spend(deps, { reservationId, usage: "unknown", uncertain: true });
      throw error;
    }
    const uncertain = sent.result.status === "failed" && sent.result.uncertain;
    await settleCaseV2Spend(deps, { reservationId, usage: sent.usage ?? "unknown", uncertain });
    return sent.result;
  };
  /** Nothing was sent for this call: its reservation goes back to the day it was made on, never to today's. */
  const release = async (request: Pick<CaseInvestigationModelRequest, "callKey">) => {
    const reservationId = held.get(request.callKey);
    if (!reservationId) return;
    held.delete(request.callKey); policies.delete(request.callKey);
    await releaseCaseV2Spend({ reservationId });
  };
  return { money, provider, release };
}
