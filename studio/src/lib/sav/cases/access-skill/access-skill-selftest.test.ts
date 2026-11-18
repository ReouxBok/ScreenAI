import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import { savCases, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { SAV_ACCESS_SKILL_CORPUS, type AccessSkillCorpusCase } from "./access-skill-corpus.fixture";
import { accessSkillLabelledAnswer, type AccessSkillDoubleStrategy } from "./access-skill-eval";
import { readAccessSkillSelfTestAggregate, readAccessSkillSelfTestConfig, runAccessSkillSelfTestPass, type AccessSkillSelfTestAggregate } from "./access-skill-selftest";
import { accessSkillWireAnswer } from "./access-skill-wire";

/*
 * SAV-97 production self-test, on the real store (PGlite) with the model doubled at the network boundary (the double answers from the corpus labels).
 * Fictional corpus only; nothing but the model endpoint may be reached (the global fetch throws), and no case is ever created.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>, runSeq = 0;
const at = new Date("2026-11-19T02:00:00.000Z");
const env = (extra: Record<string, string> = {}) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_ACCESS_SKILL_SELFTEST: "run", SAV_V2_ACCESS_SKILL_SELFTEST_ID: `run-${++runSeq}`, ...extra });
function model(strategy: AccessSkillDoubleStrategy | ((row: AccessSkillCorpusCase) => AccessSkillDoubleStrategy) = "honest") {
  const calls: string[] = [];
  const network = async (url: string, init: RequestInit) => {
    if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw Error("UNEXPECTED_HOST");
    const body = JSON.parse(String(init.body)), payload = JSON.parse(body.contents[0].parts[0].text) as { subject: string; text: string };
    const kind = body.systemInstruction.parts[0].text.startsWith("CONTRE-LECTURE") ? "counter" as const : "judge" as const;
    const row = SAV_ACCESS_SKILL_CORPUS.find(item => item.subject === payload.subject && item.text === payload.text)!;
    calls.push(`${kind}:${row.id}`);
    const answer = accessSkillLabelledAnswer(row, kind, typeof strategy === "function" ? strategy(row) : strategy);
    return answer.status === "ok" ? new Response(JSON.stringify(accessSkillWireAnswer(answer.output, { inputTokens: 4_000, outputTokens: 300 })), { status: 200 }) : new Response("{}", { status: 503 });
  };
  return { network, calls };
}
const pass = (e: Record<string, string>, m: ReturnType<typeof model>, extra: { cases?: readonly AccessSkillCorpusCase[]; log?: (event: string, fields: unknown) => void } = {}) =>
  runAccessSkillSelfTestPass({ env: () => e, now: () => at, network: m.network, ...extra });
const keysOf = async (runId: string) => (await f.db.select().from(savSyncState).where(like(savSyncState.key, `sav-v2-access-skill-selftest.v1:${runId}:%`))).map(row => row.key);
const pick = (...ids: string[]) => ids.map(id => SAV_ACCESS_SKILL_CORPUS.find(row => row.id === id)!);
let fetches: ReturnType<typeof vi.fn>;

beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "access-skill-selftest-fixture-key-32chars!"); f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "access-skill-selftest-fixture-key-32chars!");
  fetches = vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); });
  vi.stubGlobal("fetch", fetches);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("interrupteur et paramètres", () => {
  it("off par défaut (absent, vide, autre valeur) : rien ne tourne, rien n'est écrit ni appelé", async () => {
    const m = model(), before = (await f.db.select().from(savSyncState)).length;
    for (const value of [undefined, "", "off", "on", "RUN", "true"]) {
      const e = { ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_ACCESS_SKILL_SELFTEST_ID: "x", ...(value === undefined ? {} : { SAV_V2_ACCESS_SKILL_SELFTEST: value }) };
      expect(await pass(e, m)).toEqual({ skipped: "off" });
    }
    expect(m.calls).toEqual([]);
    expect((await f.db.select().from(savSyncState)).length).toBe(before);
  });
  it("plafond par défaut 10 000 000 µUSD seulement si absent et run ; jamais au-dessus ; id, passes et lot vérifiés ; indépendant de SAV_V2_ACCESS_SKILL", () => {
    expect(readAccessSkillSelfTestConfig({ SAV_V2_ACCESS_SKILL_SELFTEST: "run", SAV_V2_ACCESS_SKILL_SELFTEST_ID: "nuit-19" }))
      .toEqual({ mode: "run", runId: "nuit-19", capMicroUsd: 10_000_000, passes: 3, batch: 20 });
    expect(readAccessSkillSelfTestConfig({ SAV_V2_ACCESS_SKILL_SELFTEST: "off", SAV_V2_ACCESS_SKILL_SELFTEST_MAX_MICRO_USD: "5" })).toEqual({ mode: "off" });
    const run = (extra: Record<string, string>) => readAccessSkillSelfTestConfig({ SAV_V2_ACCESS_SKILL_SELFTEST: "run", SAV_V2_ACCESS_SKILL_SELFTEST_ID: "r", ...extra });
    expect(run({ SAV_V2_ACCESS_SKILL_SELFTEST_MAX_MICRO_USD: "10000001" })).toEqual({ mode: "refused", reason: "cap_invalid" });
    expect(run({ SAV_V2_ACCESS_SKILL_SELFTEST_MAX_MICRO_USD: "0" })).toEqual({ mode: "refused", reason: "cap_invalid" });
    expect(run({ SAV_V2_ACCESS_SKILL_SELFTEST_MAX_MICRO_USD: "2e6" })).toEqual({ mode: "refused", reason: "cap_invalid" });
    expect(run({ SAV_V2_ACCESS_SKILL_SELFTEST_MAX_MICRO_USD: "2000000" })).toMatchObject({ mode: "run", capMicroUsd: 2_000_000 });
    expect(run({ SAV_V2_ACCESS_SKILL_SELFTEST_PASSES: "4" })).toEqual({ mode: "refused", reason: "passes_invalid" });
    expect(run({ SAV_V2_ACCESS_SKILL_SELFTEST_BATCH: "500" })).toEqual({ mode: "refused", reason: "batch_invalid" });
    expect(readAccessSkillSelfTestConfig({ SAV_V2_ACCESS_SKILL_SELFTEST: "run", SAV_V2_ACCESS_SKILL_SELFTEST_ID: "a:b" })).toEqual({ mode: "refused", reason: "id_invalid" });
    expect(readAccessSkillSelfTestConfig({ SAV_V2_ACCESS_SKILL_SELFTEST: "run" })).toEqual({ mode: "refused", reason: "id_invalid" });
  });
  it("le pas de rapprochement existant ne charge rien quand off (aucune nouvelle route)", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url)), source = readFileSync(path.join(dir, "../../reconcile-pass.ts"), "utf8");
    expect(source).toContain('process.env.SAV_V2_ACCESS_SKILL_SELFTEST === "run" ? await runStep("v2_access_skill_selftest"');
    expect(source).toContain("...(accessSkillSelfTest ? { accessSkillSelfTest } : {})");
  });
});

describe("lots, reprise, arrêts et journal agrégé", () => {
  it("par lots de 2, reprise d'un passage à l'autre, jamais payé deux fois ; puis rien de plus", async () => {
    const cases = pick("acc-001", "cap-001", "oth-001", "can-001", "sub-001"), e = env({ SAV_V2_ACCESS_SKILL_SELFTEST_BATCH: "2", SAV_V2_ACCESS_SKILL_SELFTEST_PASSES: "2" }), m = model();
    const logs: unknown[] = [];
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await pass(e, m, { cases, log: (event, fields) => logs.push([event, fields]) }));
    expect(results.map(r => "ran" in r ? `${r.ran}:${r.status}` : r.skipped)).toEqual(["2:running", "2:running", "2:running", "2:running", "2:done", "finished"]);
    expect(await keysOf(e.SAV_V2_ACCESS_SKILL_SELFTEST_ID)).toHaveLength(11); // 10 case rows + the run row (the lease is released)
    // Each mail's calls once per pass: no case paid twice (can-001 holds a kernel phrase: no call at all).
    expect(new Set(m.calls).size).toBe(m.calls.length / 2);
    expect(m.calls.filter(call => call.endsWith("can-001"))).toEqual([]);
    expect(logs).toHaveLength(1);
  });
  it("journal agrégé correct (corpus complet, 3 passes, double honnête) : PASS, comptes par groupe, coût", async () => {
    const e = env({ SAV_V2_ACCESS_SKILL_SELFTEST_BATCH: "50" }), m = model(), logs: Array<[string, AccessSkillSelfTestAggregate]> = [];
    let last;
    for (let i = 0; i < 40 && !(last && "status" in last && last.status === "done"); i += 1) last = await pass(e, m, { log: (event, fields) => logs.push([event, fields as AccessSkillSelfTestAggregate]) });
    expect(last).toMatchObject({ status: "done" });
    expect(logs).toHaveLength(1);
    const [event, aggregate] = logs[0]!;
    expect(event).toBe("sav_access_skill_selftest");
    expect(aggregate).toMatchObject({ runId: e.SAV_V2_ACCESS_SKILL_SELFTEST_ID, status: "done", stopReason: null, passesPlanned: 3, casesPerPass: 600, casesDone: 1800, unfinished: 0,
      sensitiveAdmitted: 0, failingCaseCount: 0, failingCaseIds: [], capMicroUsd: 10_000_000, verdict: "PASS",
      thresholds: { zeroSensitiveAdmitted: "PASS", accessRecallAtLeast90: "PASS", capcarRecallAtLeast90: "PASS", complete: "PASS" } });
    for (const row of aggregate.perPass) expect(row).toMatchObject({ groups: { sensitive: 300, access: 200, other: 100 }, sensitiveAdmitted: 0, accessRecall: 1, capcarRecall: 1, calls: { judge: 485, counter: 191 } });
    // 110 kernel mails never reach the model; the counter-read is paid only for the 191 admissible mails. At the test prices: 1 µUSD per call.
    expect(aggregate.costMicroUsd).toBe(3 * 676);
    expect(m.calls).toHaveLength(3 * 676);
    expect(await readAccessSkillSelfTestAggregate(e.SAV_V2_ACCESS_SKILL_SELFTEST_ID)).toEqual(aggregate);
  }, 120_000);
  it("s'arrête au premier sensible admis : plus aucun appel, FAIL, l'id du mail fautif", async () => {
    const cases = pick("acc-001", "sub-001", "oth-001", "acc-002"), m = model(row => row.id === "sub-001" ? "both_lie" : "honest"), logs: Array<[string, AccessSkillSelfTestAggregate]> = [];
    const e = env({ SAV_V2_ACCESS_SKILL_SELFTEST_BATCH: "10" });
    expect(await pass(e, m, { cases, log: (event, fields) => logs.push([event, fields as AccessSkillSelfTestAggregate]) })).toMatchObject({ ran: 2, status: "stopped" });
    expect(m.calls).toEqual(["judge:acc-001", "counter:acc-001", "judge:sub-001", "counter:sub-001"]);
    expect(logs[0]![1]).toMatchObject({ status: "stopped", stopReason: "sensitive_admitted", stopCaseId: "sub-001", sensitiveAdmitted: 1, failingCaseIds: ["p1:sub-001"], verdict: "FAIL",
      thresholds: { zeroSensitiveAdmitted: "FAIL" } });
    expect(await pass(e, m, { cases })).toMatchObject({ skipped: "finished" });
    expect(m.calls).toHaveLength(4);
  });
  it("plafond atteint : le mail qui le dépasserait n'est pas commencé, FAIL (incomplet)", async () => {
    // Worst case reserved per mail: 2 calls × 1 µUSD. A cap of 5 allows two mails (2 + 2), not a third (6 > 5).
    const cases = pick("acc-001", "acc-002", "acc-003", "acc-004"), m = model(), logs: Array<[string, AccessSkillSelfTestAggregate]> = [];
    const e = env({ SAV_V2_ACCESS_SKILL_SELFTEST_MAX_MICRO_USD: "5", SAV_V2_ACCESS_SKILL_SELFTEST_BATCH: "10" });
    expect(await pass(e, m, { cases, log: (event, fields) => logs.push([event, fields as AccessSkillSelfTestAggregate]) })).toMatchObject({ ran: 2, status: "stopped" });
    expect(m.calls).toHaveLength(4);
    expect(logs[0]![1]).toMatchObject({ stopReason: "cap_reached", stopCaseId: "acc-003", casesDone: 2, costMicroUsd: 4, capMicroUsd: 5, verdict: "FAIL", thresholds: { complete: "FAIL" } });
  });
  it("aucun effet de bord : 0 dossier, 0 envoi, 0 appel HubSpot ou Gmail (le seul hôte appelé est le modèle) ; aucune dépense V2 du jour", async () => {
    const m = model(), e = env({ SAV_V2_ACCESS_SKILL_SELFTEST_BATCH: "20" });
    const others = async () => (await f.db.select().from(savSyncState)).filter(row => !row.key.startsWith("sav-v2-access-skill-selftest.v1:")).map(row => [row.key, row.status, row.cursor]);
    const before = await others();
    await pass(e, m, { cases: SAV_ACCESS_SKILL_CORPUS.filter((_, index) => index % 30 === 0) });
    expect(m.calls.length).toBeGreaterThan(0);
    expect(fetches).not.toHaveBeenCalled();
    expect((await f.db.select({ n: sql<number>`count(*)::int` }).from(savCases))[0]!.n).toBe(0);
    expect(await f.db.select().from(savSyncState).where(like(savSyncState.key, "sav-v2-spend.v1:%"))).toEqual([]);
    // Nothing else in the shared state table changed: only the self-test's own rows were written.
    expect(await others()).toEqual(before);
  });
  it("une panne du modèle est enregistrée sur le mail (équipe) sans arrêter le test ; un passage concurrent attend son tour", async () => {
    const m = model("judge_down"), e = env({ SAV_V2_ACCESS_SKILL_SELFTEST_BATCH: "1", SAV_V2_ACCESS_SKILL_SELFTEST_PASSES: "1" });
    expect(await pass(e, m, { cases: pick("acc-001", "acc-002") })).toMatchObject({ ran: 1, status: "running" });
    await f.db.insert(savSyncState).values({ key: `sav-v2-access-skill-selftest.v1:${e.SAV_V2_ACCESS_SKILL_SELFTEST_ID}:lease`, status: "held", startedAt: at });
    expect(await pass(e, m, { cases: pick("acc-001", "acc-002") })).toEqual({ skipped: "busy" });
  });
});
