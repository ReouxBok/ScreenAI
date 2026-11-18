import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../../crypto";
import { resolveCaseV2GeminiKey, SAV_V2_MODEL_ENV, type CaseV2Network } from "../investigation-v2-providers";
import { assertCaseV2ReservedPolicy, readCaseV2TransportPolicy, releaseCaseV2Spend, reserveCaseV2Spend, settleCaseV2Spend } from "../investigation-v2-spend";
import { SAV_ACCESS_SKILL_REVISION, accessSkillPromptSha256 } from "./access-skill-guidelines";
import { accessSkillTextsOf, decideAccessSkill, runAccessSkillReadings, type AccessSkillCall, type AccessSkillVerdict } from "./access-skill-rule";
import { accessSkillInputHash, accessSkillWireBody, readAccessSkillWireResponse, SAV_ACCESS_SKILL_GEMINI_URL, type AccessSkillCallKind, type AccessSkillInput, type AccessSkillWireResult } from "./access-skill-wire";

/*
 * SAV-97: the DEDICATED V2 call of the Access skill, computed ONCE per mail and stored, then read again by the creation, the relay, the SAV-96
 * owner handover, the investigation's re-evaluation (read only, never paying) and the return requalification.
 *
 * Storage: `sav.sync_state` (no migration), one row per (purpose, mail, skill revision), the readings encrypted. The row is claimed `pending`
 * before any spend: a second caller never pays again; a row left `pending` (a crash, a call in flight) stays unavailable, so the mail stays with
 * the team (never a second automatic spend on an uncertain outcome). Model: V2's own Gemini transport, key resolution, model and transport bounds;
 * each call reserves the V2 `model` budget first and settles it from the reported usage (`investigation-v2-spend.ts`). No retry.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_ACCESS_SKILL_STORE_PREFIX = "sav-v2-access-skill.v1";
export type AccessSkillPurpose = "first_mail" | "return";
export type AccessSkillStored = Readonly<{
  version: 1; revision: string; promptSha256: string; inputHash: string; model: string; startedAt: string; completedAt: string;
  judge: AccessSkillCall | null; counter: AccessSkillCall | null;
}>;
export type AccessSkillDeps = Readonly<{ env: () => Env; now: () => Date; network?: CaseV2Network; timeoutMs?: number }>;
export type AccessSkillReading =
  | Readonly<{ status: "ready"; stored: AccessSkillStored; computed: boolean; verdict: AccessSkillVerdict }>
  | Readonly<{ status: "unavailable"; reason: "absent" | "in_flight" | "input_changed" | "unreadable" | "store_failed" }>;

export const accessSkillStoreKey = (purpose: AccessSkillPurpose, messageId: string, revision = SAV_ACCESS_SKILL_REVISION) => `${SAV_ACCESS_SKILL_STORE_PREFIX}:${purpose}:${messageId}:${revision}`;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,99}$/;

/**
 * One call on V2's Gemini transport, WITHOUT any budget: V2's key resolution, model, transport bounds and wire. `send` is reached only after every check
 * passed; the caller reserves its budget in between (`prepared.send`), so nothing is sent unpaid. Shared by the production judge (V2's `model` budget)
 * and the production self-test (its own capped ledger, `access-skill-selftest.ts`).
 */
export function prepareAccessSkillCall(deps: AccessSkillDeps, kind: AccessSkillCallKind, input: AccessSkillInput):
  | Readonly<{ ok: true; send: () => Promise<AccessSkillWireResult> }> | Readonly<{ ok: false; call: AccessSkillCall }> {
  const env = deps.env(), key = resolveCaseV2GeminiKey(env), model = env[SAV_V2_MODEL_ENV] ?? "";
  const failed = (problem: string) => ({ ok: false as const, call: { status: "failed" as const, problem, uncertain: false } });
  if (!key.ok) return failed("key_unavailable");
  if (!MODEL_ID.test(model)) return failed("model_invalid");
  let bounds: ReturnType<typeof readCaseV2TransportPolicy>;
  try { bounds = readCaseV2TransportPolicy(env, deps.now()); } catch { return failed("policy_invalid"); }
  const body = accessSkillWireBody(kind, input, bounds.maxOutputTokens);
  if (Buffer.byteLength(body, "utf8") > bounds.maxInputBytes) return failed("input_too_large");
  const network = deps.network ?? ((url, init) => fetch(url, init));
  return { ok: true, send: async () => {
    try {
      const response = await network(`${SAV_ACCESS_SKILL_GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: AbortSignal.timeout(deps.timeoutMs ?? 25_000), headers: { "content-type": "application/json", "x-goog-api-key": key.key }, body,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const unprocessed = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
        return { status: "failed", problem: `http_${response.status}`, uncertain: !unprocessed, usage: unprocessed ? { inputTokens: 0, outputTokens: 0 } : null };
      }
      return readAccessSkillWireResponse(await response.json());
    } catch { return { status: "failed", problem: "network_failed", uncertain: true, usage: null }; }
  } };
}
export const accessSkillCallOf = (result: AccessSkillWireResult): AccessSkillCall =>
  result.status === "ok" ? { status: "ok", output: result.output } : { status: "failed", problem: result.problem, uncertain: result.uncertain };

/** One call behind V2's `model` budget: reserved before, settled after; released only when nothing was sent. */
async function callModel(deps: AccessSkillDeps, kind: AccessSkillCallKind, callKey: string, input: AccessSkillInput): Promise<AccessSkillCall> {
  const prepared = prepareAccessSkillCall(deps, kind, input);
  if (!prepared.ok) return prepared.call;
  const env = deps.env();
  const reserved = await reserveCaseV2Spend({ env: deps.env, now: deps.now }, "model", callKey);
  if (reserved.status !== "allowed") return { status: "failed", problem: "spend_refused", uncertain: false };
  try { await assertCaseV2ReservedPolicy(reserved.reservationId, env); } catch { await releaseCaseV2Spend({ reservationId: reserved.reservationId }); return { status: "failed", problem: "spend_policy_changed", uncertain: false }; }
  const result = await prepared.send();
  const uncertain = result.status === "failed" && result.uncertain;
  await settleCaseV2Spend({ env: deps.env, now: deps.now }, { reservationId: reserved.reservationId, usage: result.usage ?? "unknown", uncertain }).catch(() => undefined);
  return accessSkillCallOf(result);
}

const textsOf = accessSkillTextsOf;
const verdictOf = (stored: AccessSkillStored, input: AccessSkillInput) =>
  decideAccessSkill({ texts: textsOf(input), requestIds: input.requests.map(row => row.requestId), judge: stored.judge, counter: stored.counter });

async function readStored(key: string, inputHash: string, input: AccessSkillInput): Promise<AccessSkillReading | null> {
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, key));
  if (!row) return null;
  if (row.status !== "done") return { status: "unavailable", reason: "in_flight" };
  let stored: AccessSkillStored;
  try { stored = decryptSavPayload<AccessSkillStored>(row.cursor ?? ""); } catch { return { status: "unavailable", reason: "unreadable" }; }
  if (stored?.version !== 1 || stored.revision !== SAV_ACCESS_SKILL_REVISION) return { status: "unavailable", reason: "unreadable" };
  if (stored.inputHash !== inputHash) return { status: "unavailable", reason: "input_changed" };
  return { status: "ready", stored, computed: false, verdict: verdictOf(stored, input) };
}

/**
 * The skill's reading of one mail: the stored one, or (only when `compute`) computed now and stored. `compute: false` (the investigation's
 * re-evaluation) never pays: absent stays absent. The verdict is always recomputed from the stored readings by the pure rule.
 */
export async function readOrComputeAccessSkill(deps: AccessSkillDeps, request: Readonly<{ purpose: AccessSkillPurpose; messageId: string; input: AccessSkillInput; compute: boolean }>): Promise<AccessSkillReading> {
  const key = accessSkillStoreKey(request.purpose, request.messageId), inputHash = accessSkillInputHash(request.input);
  try {
    const existing = await readStored(key, inputHash, request.input);
    if (existing) return existing;
    if (!request.compute) return { status: "unavailable", reason: "absent" };
    const startedAt = deps.now().toISOString();
    const claimed = await requireDb().insert(savSyncState).values({ key, status: "pending", cursor: null, startedAt: new Date(startedAt) }).onConflictDoNothing().returning({ key: savSyncState.key });
    if (!claimed.length) return (await readStored(key, inputHash, request.input)) ?? { status: "unavailable", reason: "in_flight" };
    // The kernel first (nothing paid), the judge, then the counter-read only when it can still change the verdict: `runAccessSkillReadings`.
    const callKey = (kind: AccessSkillCallKind) => `access-skill:${request.purpose}:${request.messageId}:${SAV_ACCESS_SKILL_REVISION}:${kind}`;
    const { judge, counter } = await runAccessSkillReadings({ texts: textsOf(request.input), requestIds: request.input.requests.map(row => row.requestId) },
      kind => callModel(deps, kind, callKey(kind), request.input));
    const stored: AccessSkillStored = { version: 1, revision: SAV_ACCESS_SKILL_REVISION, promptSha256: accessSkillPromptSha256(), inputHash,
      model: deps.env()[SAV_V2_MODEL_ENV] ?? "", startedAt, completedAt: deps.now().toISOString(), judge, counter };
    const [written] = await requireDb().update(savSyncState).set({ status: "done", cursor: encryptSavPayload(stored), completedAt: new Date(stored.completedAt), updatedAt: new Date() })
      .where(and(eq(savSyncState.key, key), eq(savSyncState.status, "pending"))).returning({ key: savSyncState.key });
    if (!written) return { status: "unavailable", reason: "store_failed" };
    return { status: "ready", stored, computed: true, verdict: verdictOf(stored, request.input) };
  } catch {
    return { status: "unavailable", reason: "store_failed" };
  }
}

/** Closed codes only (never the customer's or the model's text): what the skill concluded, for the logs and the shadow comparison. */
export function accessSkillLogFields(reading: AccessSkillReading) {
  if (reading.status !== "ready") return { skill: "unavailable", reason: reading.reason };
  const verdict = reading.verdict;
  return verdict.outcome === "admit"
    ? { skill: "admit", requests: Object.values(verdict.requests).join(","), counterRead: verdict.counterRead, computed: reading.computed }
    : { skill: "team", reasons: verdict.reasons.join(","), kernel: verdict.kernel.join(","), computed: reading.computed };
}
