import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import type { CaseEmbeddingSpendPort, CaseEmbeddingUsage } from "./investigation-budgeted-retrieval";
import type { CaseCallMoneyGate } from "./investigation-call-ledger";
import type { CaseInvestigationModelRequest } from "./investigation-runner";

/*
 * B (4/11, LOCAL and OFF): V2's own spend register, two budgets that never mix — `embedding` (knowledge search) and `model` (decision) —
 * and never V1's (`SAV_AI_BUDGET`, derived reservations, intake budget tables are not read nor written). Every amount comes from the spend
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

type Held = { amount: number; revision: string };
type DayState = { purpose: CaseV2SpendPurpose; day: string; settledMicroUsd: number; open: Record<string, Held>; done: Record<string, number> };
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
async function withDay<T>(purpose: CaseV2SpendPurpose, day: string, change: (state: DayState) => { state: DayState | null; result: T }): Promise<T> {
  const key = keyOf(purpose, day);
  return requireDb().transaction(async tx => {
    await tx.insert(savSyncState).values({ key, cursor: JSON.stringify({ purpose, day, settledMicroUsd: 0, open: {}, done: {} } satisfies DayState), status: "open" }).onConflictDoNothing();
    const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key)).for("update");
    const state = JSON.parse(row!.cursor ?? "null") as DayState;
    const { state: next, result } = change(state);
    if (next) await tx.update(savSyncState).set({ cursor: JSON.stringify(next), processedCount: Object.keys(next.done).length, updatedAt: new Date() }).where(eq(savSyncState.key, key));
    return result;
  });
}

export type CaseV2SpendReservation = { status: "allowed"; reservationId: string; amountMicroUsd: number } | { status: "refused"; reason: string };

/** Reserves the policy's per-call amount for this call key, or refuses (no policy, cap reached, call already settled). Idempotent per call key and day. */
export async function reserveCaseV2Spend(deps: CaseV2SpendDeps, purpose: CaseV2SpendPurpose, callKey: string): Promise<CaseV2SpendReservation> {
  const read = readCaseV2SpendPolicy(deps.env());
  if (!read.ok) return { status: "refused", reason: read.reason };
  if (typeof callKey !== "string" || !callKey.trim() || callKey.length > 500) return { status: "refused", reason: "v2_spend_call_key_invalid" };
  const section = read.policy[purpose], amount = section.reserveMicroUsdPerCall, day = dayOf(deps.now()), reservationId = reservationIdOf(purpose, day, callKey);
  return withDay<CaseV2SpendReservation>(purpose, day, state => {
    if (state.open[callKey]) return { state: null, result: { status: "allowed" as const, reservationId, amountMicroUsd: state.open[callKey]!.amount } };
    if (state.done[callKey] !== undefined) return { state: null, result: { status: "refused" as const, reason: "v2_spend_call_already_settled" } };
    const committed = state.settledMicroUsd + Object.values(state.open).reduce((sum, held) => sum + held.amount, 0);
    if (committed + amount > section.dailyCapMicroUsd) return { state: null, result: { status: "refused" as const, reason: `v2_spend_${purpose}_daily_cap_reached` } };
    return { state: { ...state, open: { ...state.open, [callKey]: { amount, revision: read.policy.revision } } }, result: { status: "allowed" as const, reservationId, amountMicroUsd: amount } };
  });
}

function costOf(policy: CaseV2SpendPolicy, purpose: CaseV2SpendPurpose, usage: CaseV2SpendUsage): number | null {
  const tokens = (value: number | undefined) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  const input = tokens(usage.inputTokens);
  if (input === null) return null;
  if (purpose === "embedding") return Math.ceil(input * policy.embedding.microUsdPerMillionInputTokens / 1_000_000);
  const output = tokens(usage.outputTokens);
  if (output === null) return null;
  return Math.ceil((input * policy.model.microUsdPerMillionInputTokens + output * policy.model.microUsdPerMillionOutputTokens) / 1_000_000);
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
    const computed = input.usage !== "unknown" && !input.uncertain && read.ok && read.policy.revision === held.revision ? costOf(read.policy, id.purpose, input.usage) : null;
    const cost = computed ?? held.amount;
    const open = { ...state.open };
    delete open[id.callKey];
    return { state: { ...state, open, settledMicroUsd: state.settledMicroUsd + cost, done: { ...state.done, [id.callKey]: cost } }, result: { settled: true as const, costMicroUsd: cost, fromUsage: computed !== null } };
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

type ProviderResult = { status: "ok"; output: unknown } | { status: "failed"; uncertain: boolean };
/** A model transport that reports what the provider said it used (null when it said nothing usable). */
export type CaseV2ModelTransport = (request: CaseInvestigationModelRequest) => Promise<{ result: ProviderResult; usage: CaseV2SpendUsage | null }>;

/**
 * The V2 `model` budget around the ledger adapter: `money` reserves before dispatch (a refusal defers, nothing sent); `provider` settles
 * after the call from the reported usage, or the reserved amount when it is unknown or the call is uncertain (a thrown transport included).
 */
export function caseV2ModelSpend(deps: CaseV2SpendDeps) {
  const held = new Map<string, string>();
  const money: CaseCallMoneyGate = async request => {
    const reserved = await reserveCaseV2Spend(deps, "model", request.callKey);
    if (reserved.status !== "allowed") return { status: "refused", reason: reserved.reason };
    held.set(request.callKey, reserved.reservationId);
    return { status: "allowed" };
  };
  const provider = (transport: CaseV2ModelTransport) => async (request: CaseInvestigationModelRequest): Promise<ProviderResult> => {
    // The reservation made for this call, on the day it was made, even if midnight has passed since. None: not sent, since nothing could account for it.
    const reservationId = held.get(request.callKey);
    if (!reservationId) return { status: "failed", uncertain: false };
    held.delete(request.callKey);
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
    held.delete(request.callKey);
    await releaseCaseV2Spend({ reservationId });
  };
  return { money, provider, release };
}
