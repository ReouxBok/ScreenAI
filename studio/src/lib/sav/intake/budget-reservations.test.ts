import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savIntakeJournal, savActions, auditLogs } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { assertSavIntakeCallPlan, claimSavIntakeRun, enqueueSavIntakeMessage, readSavIntakeBudget, reserveSavIntakeCall, settleSavIntakeCall } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";

/** SAV budget reservations (28/10): one reservation per request, sized from the exact body.
 * Synthetic fixtures only. Amounts in nanoUSD: input 750/token, output and thinking 3750/token. */
const FULL = 817_152_000, OUTPUT = 8192 * 3750, FRAMING = 16_384;
const sized = (textBytes: number, mediaTokens = 0) => ({ textBytes, mediaTokens, maxOutputTokens: 8192 });
const expected = (textBytes: number, mediaTokens = 0) => (textBytes + mediaTokens + FRAMING) * 750 + OUTPUT;
const usage = { inputTokens: 100, outputTokens: 50, thoughtTokens: 0, totalTokens: 150 };
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, messageId: string;
let config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
function env(mailbox: string, pins: Record<string, unknown> = {}) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30, ...pins }) };
}
function operational(maxNanoUsd = 3_000_000_000, maxRollingNanoUsd = 90_000_000_000) {
  environment = env(mailboxId, { budgetProfile: "operational_utc_v1", maxNanoUsd, maxRollingNanoUsd, maxCalls: 300, expiresAt: new Date(Date.now() + 29 * 86400000).toISOString() });
  config = savIntakeRuntimeConfig(environment)!;
}
async function thread(customer = "synthetic@example.invalid") {
  const [t] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: customer }).returning(); threadId = t.id;
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: customer, toEmails: ["support@example.invalid"],
    subject: "Connexion fictive", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: "La connexion ne marche plus.", attachments: [], headers: {} }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning(); messageId = m.id;
}
async function lease() { const id = await enqueueSavIntakeMessage(messageId, config); return (await claimSavIntakeRun(id!, config))!; }
/** Ledger rows of other dossiers, as an old deployment wrote them (no descriptor, full quote). */
const legacy = (n: number, state: "settled" | "uncertain", createdAt = new Date()) => Array.from({ length: n }, (_, i) => ({ messageKey: intakeRuntimeHash(`other-${state}-${createdAt.getTime()}-${i}`),
  requestHash: intakeRuntimeHash(`other-req-${state}-${createdAt.getTime()}-${i}`), state, reservedNanoUsd: FULL, chargedNanoUsd: state === "settled" ? 262_500 : FULL,
  payloadCiphertext: encryptSavPayload(state === "settled" ? { metadata: usage } : {}), createdAt }));
/** Settled rows of other dossiers that cost a full quote each (maximal input and output). */
const fullSettled = (n: number, createdAt = new Date()) => legacy(n, "settled", createdAt).map(r => ({ ...r, chargedNanoUsd: FULL,
  payloadCiphertext: encryptSavPayload({ metadata: { inputTokens: 1_048_576, outputTokens: 8192, thoughtTokens: 0, totalTokens: 1_056_768 } }) }));
const providerAnswer = (json: unknown, usageMetadata: Record<string, number> = { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 }) =>
  Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(json) }] } }], usageMetadata });
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-runtime-encryption-key");
  await f.client.exec("TRUNCATE sav.intake_effect_journal, sav.intake_effects, sav.intake_occupations, sav.intake_executions, sav.intake_execution_policies, sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning(); mailboxId = mailbox.id;
  await thread(); environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
});
afterEach(() => vi.unstubAllEnvs());

it("BUDGET-RES a small context reserves its own bounded cost, not the whole model window", async () => {
  const l = await lease(), call = await reserveSavIntakeCall(l, config, "a".repeat(64), new Date(), sized(2048));
  const [row] = await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id, call.id));
  expect(row.reservedNanoUsd).toBe(expected(2048)); expect(row.reservedNanoUsd).toBe(44_544_000);
  expect(row.chargedNanoUsd).toBe(row.reservedNanoUsd);
});
it("BUDGET-RES a large context reserves more, up to the enforced wire limit, never above the old full quote", async () => {
  const l = await lease(), big = SAV_INTAKE_MODEL_LIMITS.wireTextBytes;
  const call = await reserveSavIntakeCall(l, config, "b".repeat(64), new Date(), sized(big));
  const [row] = await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id, call.id));
  expect(row.reservedNanoUsd).toBe(expected(big)); expect(row.reservedNanoUsd).toBe(632_832_000); expect(row.reservedNanoUsd).toBeLessThan(FULL);
  await expect(reserveSavIntakeCall(l, config, "c".repeat(64), new Date(), sized(big + 1))).rejects.toThrow("REQUEST_REJECTED");
});
it("BUDGET-RES media tokens and maximal output plus thinking are part of every reservation", async () => {
  const l = await lease(), call = await reserveSavIntakeCall(l, config, "d".repeat(64), new Date(), sized(1000, 3 * 4096));
  const [row] = await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id, call.id));
  expect(row.reservedNanoUsd).toBe((1000 + 3 * 4096 + FRAMING) * 750 + 8192 * 3750);
  // Thinking is billed as output: a settled call charges output and thoughts at 3750 each.
  const heavy = { inputTokens: 900, outputTokens: 4000, thoughtTokens: 4192, totalTokens: 9092 };
  expect(await settleSavIntakeCall(call.id, heavy, { json: {}, metadata: heavy })).toBe(true);
  expect((await f.db.select().from(savIntakeModelCalls))[0].chargedNanoUsd).toBe(900 * 750 + 8192 * 3750);
});
it("BUDGET-RES monetary amounts stay integer and malformed sizes are refused before any row", async () => {
  const l = await lease();
  for (const size of [sized(0), sized(1.5), sized(-1), { ...sized(10), mediaTokens: -1 }, { ...sized(10), maxOutputTokens: 8193 }, { ...sized(10), maxOutputTokens: 0 }])
    await expect(reserveSavIntakeCall(l, config, randomUUID(), new Date(), size)).rejects.toThrow();
  expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(0);
  const one = await reserveSavIntakeCall(l, config, "e".repeat(64), new Date(), sized(1));
  const [row] = await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id, one.id));
  expect(Number.isSafeInteger(row.reservedNanoUsd)).toBe(true); expect(row.reservedNanoUsd).toBe((1 + FRAMING) * 750 + OUTPUT);
});
it("BUDGET-RES a caller without a measured body still reserves the full window", async () => {
  const l = await lease(), call = await reserveSavIntakeCall(l, config, "f".repeat(64));
  expect((await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id, call.id)))[0].reservedNanoUsd).toBe(FULL);
});
it("BUDGET-RES two concurrent small reservations fit a margin that two full quotes would not", async () => {
  // Daily cap 3 USD; once both analyses started, 1.634 USD spent elsewhere today: 1.366 USD left.
  operational(3_000_000_000);
  const a = await lease(); await thread("second@example.invalid"); const b = await lease();
  await f.db.insert(savIntakeModelCalls).values(fullSettled(2));
  const left = (await readSavIntakeBudget(config)).remainingNanoUsd;
  expect(left).toBeGreaterThan(2 * expected(4096)); expect(left).toBeLessThan(2 * FULL);
  const results = await Promise.allSettled([reserveSavIntakeCall(a, config, "1".repeat(64), new Date(), sized(4096)), reserveSavIntakeCall(b, config, "2".repeat(64), new Date(), sized(4096))]);
  expect(results.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
  expect((await readSavIntakeBudget(config)).remainingNanoUsd).toBe(left - 2 * expected(4096));
});
it("BUDGET-RES concurrent reservations are serialized: the second one is refused when only one fits", async () => {
  operational(1_000_000_000);
  const a = await lease(); await thread("second@example.invalid"); const b = await lease();
  const big = sized(SAV_INTAKE_MODEL_LIMITS.wireTextBytes);
  const results = await Promise.allSettled([reserveSavIntakeCall(a, config, "3".repeat(64), new Date(), big), reserveSavIntakeCall(b, config, "4".repeat(64), new Date(), big)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason)).toContain("BUDGET_EXHAUSTED");
  expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(1);
});
it("BUDGET-RES a cached answer is returned without a new reservation", async () => {
  const l = await lease(), first = await reserveSavIntakeCall(l, config, "5".repeat(64), new Date(), sized(3000));
  await settleSavIntakeCall(first.id, usage, { json: { cached: true }, metadata: usage });
  expect((await reserveSavIntakeCall(l, config, "5".repeat(64), new Date(), sized(3000))).cached?.json).toEqual({ cached: true });
  expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(1);
});
it("BUDGET-RES a complete usage settles at its exact cost and keeps the reservation descriptor", async () => {
  const id = await enqueueSavIntakeMessage(messageId, config);
  const network = vi.fn(async () => providerAnswer({ messageId, requests: [] }));
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  const [call] = await f.db.select().from(savIntakeModelCalls);
  expect(call).toMatchObject({ state: "settled", chargedNanoUsd: 262_500 }); expect(call.reservedNanoUsd).toBeLessThan(100_000_000);
  expect(decryptSavPayload<{ reservation: { inputTokenBound: number }; reservationExceeded?: boolean }>(call.payloadCiphertext)).toMatchObject({ reservation: { inputTokenBound: expect.any(Number) } });
  expect(decryptSavPayload<{ reservationExceeded?: boolean }>(call.payloadCiphertext).reservationExceeded).toBeUndefined();
});
it.each([
  ["missing usage", async () => providerAnswer({ requests: [] }, { promptTokenCount: 100, candidatesTokenCount: 50 })],
  ["inconsistent usage", async () => providerAnswer({ requests: [] }, { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 999 })],
  ["lost answer after sending", async () => { throw new TypeError("fetch failed"); }],
  ["unreadable answer body", async () => new Response("{truncated", { status: 200, headers: { "content-type": "application/json" } })],
])("BUDGET-RES %s stays uncertain at the request's own reservation, never zero and never resent", async (_name, answer) => {
  const id = await enqueueSavIntakeMessage(messageId, config), network = vi.fn(answer);
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  const [call] = await f.db.select().from(savIntakeModelCalls);
  expect(call.state).toBe("uncertain"); expect(call.chargedNanoUsd).toBe(call.reservedNanoUsd);
  expect(call.reservedNanoUsd).toBeGreaterThan(OUTPUT); expect(call.reservedNanoUsd).toBeLessThan(FULL);
  expect(await claimSavIntakeRun(id!, config)).toBeNull(); expect(network).toHaveBeenCalledTimes(1);
  expect(await f.db.select().from(savActions)).toHaveLength(0);
});
it.each([[400, "settled", 0], [429, "settled", 0], [503, "settled", 0], [401, "uncertain", null], [403, "uncertain", null], [404, "uncertain", null]] as const)(
  "BUDGET-RES a received HTTP %s follows the documented billing contract (%s)", async (status, expectedState, charged) => {
  const id = await enqueueSavIntakeMessage(messageId, config), network = vi.fn(async () => new Response("{}", { status }));
  await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
  const [call] = await f.db.select().from(savIntakeModelCalls);
  expect(call.state).toBe(expectedState); expect(call.chargedNanoUsd).toBe(charged ?? call.reservedNanoUsd);
  if (expectedState === "settled") expect(decryptSavPayload(call.payloadCiphertext)).toMatchObject({ usageReconciliation: "provider_http_error_unbilled.v1", providerStatus: status });
  expect(network).toHaveBeenCalledTimes(1);
});
it("BUDGET-RES uncertain reservations that alone block the next analysis are named in the deferral, never released", async () => {
  operational(3_000_000_000);
  // Three old unknown costs of other dossiers: 2.45 USD of a 3 USD daily cap.
  await f.db.insert(savIntakeModelCalls).values(legacy(3, "uncertain", new Date(Date.now() - 5 * 86400000)));
  const id = (await enqueueSavIntakeMessage(messageId, config))!;
  expect(await claimSavIntakeRun(id, config)).toBeNull();
  const budget = await readSavIntakeBudget(config);
  expect(budget).toMatchObject({ uncertainCallCount: 3, uncertainNanoUsd: 3 * FULL, inFlightCallCount: 0, settledNanoUsd: 0, blockedByUnsettled: true, reservationBoundRevoked: false });
  expect(budget.requiredNanoUsd).toBe(expected(SAV_INTAKE_MODEL_LIMITS.wireTextBytes, 3 * 4096));
  expect(budget.oldestUnsettledAt).not.toBeNull();
  const [deferral] = await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.kind, "budget_deferred_before_attempt"));
  expect(decryptSavPayload(deferral.payloadCiphertext)).toMatchObject({ reason: "SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED", attemptsUnchanged: true, blockedByUnsettled: true, unsettledCalls: 3, unsettledNanoUsd: 3 * FULL });
  expect((await f.db.select().from(savIntakeModelCalls)).every(r => r.state === "uncertain" && r.chargedNanoUsd === FULL)).toBe(true);
});
it("BUDGET-RES with margin for one maximal call an analysis starts although a full quote would not fit", async () => {
  operational(3_000_000_000);
  // 2.30 USD of old unknown costs leaves 0.70 USD: below 0.817152, above the largest admissible call.
  await f.db.insert(savIntakeModelCalls).values(legacy(2, "uncertain"));
  await f.db.insert(savIntakeModelCalls).values({ ...legacy(1, "settled")[0], chargedNanoUsd: 665_220_000,
    payloadCiphertext: encryptSavPayload({ metadata: { inputTokens: 846_000, outputTokens: 8192, thoughtTokens: 0, totalTokens: 854_192 } }) });
  const left = (await readSavIntakeBudget(config)).remainingNanoUsd;
  expect(left).toBeLessThan(FULL); expect(left).toBeGreaterThanOrEqual(expected(SAV_INTAKE_MODEL_LIMITS.wireTextBytes, 3 * 4096));
  const id = (await enqueueSavIntakeMessage(messageId, config))!;
  expect((await claimSavIntakeRun(id, config))?.run.attempts).toBe(1);
});
it("BUDGET-RES the daily cap still refuses a small reservation", async () => {
  operational(850_000_000); const l = await lease();
  // 0.817152 USD spent today of 0.85: 0.0328 USD left, below the smallest reservation (0.043 USD).
  await f.db.insert(savIntakeModelCalls).values(fullSettled(1));
  await expect(reserveSavIntakeCall(l, config, "6".repeat(64), new Date(), sized(10))).rejects.toThrow("BUDGET_EXHAUSTED");
});
it("BUDGET-RES the rolling cap still refuses a small reservation with the daily cap free", async () => {
  operational(850_000_000, 850_000_000); const l = await lease();
  await f.db.insert(savIntakeModelCalls).values(fullSettled(1, new Date(Date.now() - 2 * 86400000)));
  expect(await readSavIntakeBudget(config)).toMatchObject({ remainingNanoUsd: 850_000_000, remainingRollingNanoUsd: 32_848_000 });
  await expect(reserveSavIntakeCall(l, config, "7".repeat(64), new Date(), sized(10))).rejects.toThrow("BUDGET_EXHAUSTED");
});
it("BUDGET-RES the daily call count still refuses a small reservation", async () => {
  operational(5_000_000_000); const l = await lease();
  await f.db.insert(savIntakeModelCalls).values(legacy(300, "settled"));
  await expect(reserveSavIntakeCall(l, config, "8".repeat(64), new Date(), sized(10))).rejects.toThrow("BUDGET_EXHAUSTED");
});
it("BUDGET-RES a grouped plan is checked at the sizes it will reserve", async () => {
  await f.db.insert(savIntakeModelCalls).values(fullSettled(3));
  // Lifetime 3 USD, 2.451 USD used: three small requests fit, three unsized (full) ones do not.
  const hashes = ["a", "b", "c"].map(c => c.repeat(64));
  await expect(assertSavIntakeCallPlan(messageId, config, hashes, hashes.map(() => sized(1000)))).resolves.toBeUndefined();
  await expect(assertSavIntakeCallPlan(messageId, config, hashes)).rejects.toThrow("BUDGET_EXHAUSTED");
  await expect(assertSavIntakeCallPlan(messageId, config, hashes, [sized(1000)])).rejects.toThrow("DISPATCH_REJECTED");
});
it("BUDGET-RES a new version never erases the reservations of the previous one", async () => {
  operational(); const first = await lease(), old = await reserveSavIntakeCall(first, config, "9".repeat(64), new Date(), sized(5000));
  await f.db.update(savIntakeModelCalls).set({ state: "uncertain" }).where(eq(savIntakeModelCalls.id, old.id));
  const before = await readSavIntakeBudget(config);
  await f.db.update(savIntakeRuns).set({ isCurrent: false, state: "superseded" }).where(eq(savIntakeRuns.id, first.run.id));
  await thread("next@example.invalid"); const next = await lease();
  await reserveSavIntakeCall(next, config, "0".repeat(64), new Date(), sized(5000));
  const after = await readSavIntakeBudget(config);
  expect(after.uncertainNanoUsd).toBe(before.uncertainNanoUsd); expect(after.uncertainCallCount).toBe(1);
  expect(after.chargedNanoUsd).toBe(before.chargedNanoUsd + expected(5000));
});
it("BUDGET-RES a provider input above the reserved bound is charged in full and revokes the bound for later calls", async () => {
  const l = await lease(), call = await reserveSavIntakeCall(l, config, "ab".repeat(32), new Date(), sized(1000));
  const over = { inputTokens: 1000 + FRAMING + 1, outputTokens: 10, thoughtTokens: 0, totalTokens: 1000 + FRAMING + 11 };
  expect(await settleSavIntakeCall(call.id, over, { json: {}, metadata: over })).toBe(true);
  const [row] = await f.db.select().from(savIntakeModelCalls);
  expect(row.chargedNanoUsd).toBe(over.inputTokens * 750 + 10 * 3750); expect(row.chargedNanoUsd).toBeGreaterThan(expected(1000) - OUTPUT);
  expect(decryptSavPayload(row.payloadCiphertext)).toMatchObject({ reservationExceeded: true });
  expect(await readSavIntakeBudget(config)).toMatchObject({ reservationBoundRevoked: true, requiredNanoUsd: FULL });
  const next = await reserveSavIntakeCall(l, config, "cd".repeat(32), new Date(), sized(1000));
  expect((await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id, next.id)))[0].reservedNanoUsd).toBe(FULL);
});
it("BUDGET-RES a forged descriptor or a dropped exceedance marker is refused, legacy rows stay readable", async () => {
  await f.db.insert(savIntakeModelCalls).values(legacy(2, "settled"));
  expect((await readSavIntakeBudget(config)).lifetimeCallCount).toBe(2);
  const l = await lease(), call = await reserveSavIntakeCall(l, config, "ef".repeat(32), new Date(), sized(1000));
  await f.db.update(savIntakeModelCalls).set({ reservedNanoUsd: 1_000_000, chargedNanoUsd: 1_000_000 }).where(eq(savIntakeModelCalls.id, call.id));
  await expect(readSavIntakeBudget(config)).rejects.toThrow("LEDGER_REJECTED");
  await f.db.update(savIntakeModelCalls).set({ reservedNanoUsd: expected(1000), chargedNanoUsd: expected(1000) }).where(eq(savIntakeModelCalls.id, call.id));
  const over = { inputTokens: 1000 + FRAMING + 1, outputTokens: 10, thoughtTokens: 0, totalTokens: 1000 + FRAMING + 11 };
  await settleSavIntakeCall(call.id, over, { json: {}, metadata: over });
  const [row] = await f.db.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id, call.id));
  const rest = decryptSavPayload<Record<string, unknown>>(row.payloadCiphertext); delete rest.reservationExceeded;
  await f.db.update(savIntakeModelCalls).set({ payloadCiphertext: encryptSavPayload(rest) }).where(eq(savIntakeModelCalls.id, call.id));
  await expect(readSavIntakeBudget(config)).rejects.toThrow("LEDGER_REJECTED");
  expect(await f.db.select().from(auditLogs)).toHaveLength(0);
});
