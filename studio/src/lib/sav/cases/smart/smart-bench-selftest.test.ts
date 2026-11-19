import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import { savCaseEffectExecutions, savCases, savIntakeEffects, savMessages, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSavBenchScriptedJudge } from "../../bench/bench-doubles";
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { savBenchGeminiEnvelope } from "../../bench/bench-wire";
import type { SavBenchAgent } from "../../bench/bench-types";
import { accessSkillWireAnswer } from "../access-skill/access-skill-wire";
import { createSavBenchAgent, smartBenchTurn } from "./smart-bench-agent";
import {
  readSmartBenchSelfTestConfig, readSmartBenchSelfTestReport, runSmartBenchSelfTestPass, SAV_SMART_BENCH_NEW_CALLS, SAV_SMART_BENCH_SELFTEST_PREFIX, type SmartBenchSelfTestDeps,
} from "./smart-bench-selftest";
import { readSmartLedger } from "./smart-ledger";
import { SAV_SMART_SHADOW_MODEL_CALLS } from "./smart-shadow";
import { SMART_CONFORME, smartGoodDecision, smartReading } from "./smart-test-doubles";

/*
 * Lot F' (20/11): the bench self-test on PGlite with the FICTIONAL corpus, the model doubled at the network (no key, no money).
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const AT = new Date("2026-11-20T10:00:00.000Z");
const ENV = (extra: Record<string, string> = {}) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_SMART_BENCH_SELFTEST: "run", SAV_V2_SMART_BENCH_SELFTEST_ID: "run-1", ...extra });
const CORPUS = SAV_BENCH_CORPUS.filter(conversation => !conversation.risky).slice(0, 3);

/** The model at the network: the new agent's calls (by system prompt) and the judge's, all answered; counts every call. */
function network() {
  const calls: string[] = [];
  const fn = async (url: string, init: RequestInit) => {
    if (!url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/")) throw Error(`UNEXPECTED_HOST ${url}`);
    const body = JSON.parse(String(init.body)), system: string = body.systemInstruction?.parts?.[0]?.text ?? "";
    const kind = system.startsWith("Tu lis un mail") ? "understand" : system.startsWith("RELECTURE") ? "verify" : system ? "decide" : "judge";
    calls.push(kind);
    if (kind === "judge") return Response.json(savBenchGeminiEnvelope(Object.fromEntries(["issue", "faits_sources", "pas_de_promesse", "jamais_autre_plateforme", "pas_de_mot_de_passe",
      "pas_de_repetition", "fait_avancer"].map(c => [c, { verdict: "ok", justification: "ok" }])), { promptTokenCount: 1_000, candidatesTokenCount: 100 }));
    const output = kind === "understand" ? smartReading() : kind === "verify" ? SMART_CONFORME
      : { outcome: "handoff", reply: null, teamNote: "note", handoffReason: "no_source", coverage: [{ needId: "n1", status: "handed" }], facts: [] };
    return Response.json(accessSkillWireAnswer(output, { inputTokens: 1_000, outputTokens: 200 }));
  };
  return { fn, calls };
}
const deps = (env: Record<string, string>, net: ReturnType<typeof network>, extra: Partial<SmartBenchSelfTestDeps> = {}): SmartBenchSelfTestDeps => ({
  env: () => env, now: () => AT, network: net.fn, corpus: CORPUS, log: () => undefined,
  judge: judgeNet => ({ ...createSavBenchScriptedJudge("honest"), judge: async input => {
    await judgeNet("https://generativelanguage.googleapis.com/v1beta/models/synthetic-model:generateContent", { method: "POST", body: "{}" });
    return createSavBenchScriptedJudge("honest").judge(input);
  } }),
  ...extra,
});
let fetches: ReturnType<typeof vi.fn>;

beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-bench-fixture-key-32-chars!!!!!"); f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-bench-fixture-key-32-chars!!!!!");
  fetches = vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); });
  vi.stubGlobal("fetch", fetches);
  state.db = f.db;
  await f.db.delete(savSyncState).where(like(savSyncState.key, `${SAV_SMART_BENCH_SELFTEST_PREFIX}:%`));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("interrupteurs", () => {
  it("absent ou autre que « run » : 0 lecture, 0 appel", async () => {
    state.db = null;
    const net = network();
    for (const value of [undefined, "", "off", "on", "RUN"]) {
      const env = { ...ACCESS_SKILL_TEST_PROVIDER_ENV, ...(value === undefined ? {} : { SAV_V2_SMART_BENCH_SELFTEST: value }) };
      expect(await runSmartBenchSelfTestPass(deps(env, net))).toEqual({ skipped: "off" });
    }
    expect(net.calls).toEqual([]);
    expect(fetches).not.toHaveBeenCalled();
  });
  it("valeurs bornées : identifiant, agent, lot ≤ 20, plafond ≤ 10 000 000 µUSD", () => {
    expect(readSmartBenchSelfTestConfig(ENV())).toEqual({ mode: "run", runId: "run-1", agents: ["current", "new"], batch: 6, capMicroUsd: 10_000_000 });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new" }))).toMatchObject({ agents: ["new"] });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "a b" }))).toEqual({ mode: "refused", reason: "id_invalid" });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "tous" }))).toEqual({ mode: "refused", reason: "agent_invalid" });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_BATCH: "21" }))).toEqual({ mode: "refused", reason: "batch_invalid" });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD: "10000001" }))).toEqual({ mode: "refused", reason: "cap_invalid" });
    expect(SAV_SMART_BENCH_NEW_CALLS).toBe(SAV_SMART_SHADOW_MODEL_CALLS);
  });
  it("le pas de rapprochement ne charge le module que sur « run », avec le saut sous 90 s", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../reconcile-pass.ts"), "utf8");
    expect(source).toContain('process.env.SAV_V2_SMART_BENCH_SELFTEST === "run" ? await runStep("v2_smart_bench_selftest"');
    expect(source).toContain('if (Date.now() + 90_000 > derivedDeadline) return { skipped: "deadline" };\n    const { runSmartBenchSelfTestPass }');
  });
});

describe("allumé : un paiement par conversation, 0 effet", () => {
  it("deux passes : chaque conversation payée une fois ; le rapport agrège par famille et critère ; 0 dossier, 0 effet, 0 message", async () => {
    const net = network(), env = ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new" });
    const first = await runSmartBenchSelfTestPass(deps(env, net));
    expect(first).toMatchObject({ ran: 3, stoppedBy: "done", remaining: 0 });
    const callsAfterFirst = net.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(await runSmartBenchSelfTestPass(deps(env, net))).toMatchObject({ ran: 0, stoppedBy: "done" });
    expect(net.calls).toHaveLength(callsAfterFirst);
    const ledger = await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "run-1");
    expect(ledger).toMatchObject({ items: 3, open: {} });
    const report = await readSmartBenchSelfTestReport("run-1");
    expect(report.new.conversationsStored).toBe(3);
    expect(report.new.metrics.conversations).toBe(3);
    expect(report.new.metrics.strict.sensitiveAdmitted).toBe(0);
    expect(report.current.conversationsStored).toBe(0);
    for (const table of [savCases, savCaseEffectExecutions, savIntakeEffects, savMessages]) expect(await f.db.select().from(table)).toEqual([]);
    expect(fetches).not.toHaveBeenCalled();
  });
  it("deux passes qui se chevauchent : chaque conversation n'est payée qu'une fois", async () => {
    const net = network(), env = ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new", SAV_V2_SMART_BENCH_SELFTEST_ID: "run-2" });
    await Promise.all([runSmartBenchSelfTestPass(deps(env, net)), runSmartBenchSelfTestPass(deps(env, net))]);
    expect((await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "run-2")).items).toBe(3);
    expect((await readSmartBenchSelfTestReport("run-2")).new.conversationsStored).toBe(3);
  });
  it("les deux agents : comparaison current/new sur les mêmes conversations", async () => {
    const net = network(), env = ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "run-3" });
    const scripted = (name: string): SavBenchAgent => ({ name, revision: "x", respond: async () => ({ outcome: "passer_la_main", reply: null, citations: [], codes: [] }) });
    await runSmartBenchSelfTestPass(deps(env, net, { agents: (name, meter) => name === "new" ? createSavBenchAgent({ dryRun: false, network: meter, env }) : scripted(name) }));
    const report = await readSmartBenchSelfTestReport("run-3");
    expect(report.current.conversationsStored + report.new.conversationsStored).toBe(6);
    expect(report.comparison.paired).toBe(3);
  });
});

describe("plafonds et temps", () => {
  it("plafond atteint : arrêt avant tout appel", async () => {
    const net = network();
    expect(await runSmartBenchSelfTestPass(deps(ENV({ SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD: "3" }), net))).toMatchObject({ ran: 0, stoppedBy: "money_cap" });
    expect(net.calls).toEqual([]);
  });
  it("moins de 90 s : rien ; moins de 150 s : aucune conversation commencée", async () => {
    const net = network(), t = 1_000_000;
    expect(await runSmartBenchSelfTestPass(deps(ENV(), net, { clock: () => t, deadlineMs: t + 89_000 }))).toEqual({ skipped: "deadline" });
    expect(await runSmartBenchSelfTestPass(deps(ENV(), net, { clock: () => t, deadlineMs: t + 120_000 }))).toMatchObject({ ran: 0, stoppedBy: "deadline" });
    expect(net.calls).toEqual([]);
  });
});

describe("adaptateur du banc (--agent=new)", () => {
  it("à blanc : aucun appel réel, chaque corps mesuré par le fil du banc ; issue codée", async () => {
    const seen: string[] = [];
    const agent = createSavBenchAgent({ dryRun: true, env: ACCESS_SKILL_TEST_PROVIDER_ENV, network: async url => { seen.push(url); return new Response(null, { status: 503 }); } });
    const conversation = CORPUS[0]!;
    const turn = await agent.respond({ conversationId: conversation.id, turn: 1, family: conversation.family, subject: conversation.subject, customer: conversation.customer,
      messages: [{ from: "client", text: conversation.turns[0]!.text, at: "2026-11-20T09:00:00.000Z" }], knowledge: [], now: "2026-11-20T09:05:00.000Z" });
    expect(turn.outcome).toMatch(/passer_la_main|equipe_sensible/);
    expect(turn.reply).toBeNull();
    expect(seen.every(url => url.startsWith("https://dry-run.invalid/"))).toBe(true);
  });
  it("issues : sensible → équipe sans réponse, échec jamais une réponse, réponse avec mention IA", () => {
    const base = { reasons: ["x"], sensitiveStop: null, reading: null, decision: null, replyWithFooter: null, checks: { first: null, second: null }, verdicts: { first: null, second: null },
      corrected: false, calls: [], sources: [], missing: [] };
    expect(smartBenchTurn({ ...base, outcome: "team_sensitive" })).toMatchObject({ outcome: "equipe_sensible", reply: null });
    expect(smartBenchTurn({ ...base, outcome: "failed" })).toMatchObject({ outcome: "passer_la_main", reply: null, failure: "failed:x" });
    expect(smartBenchTurn({ ...base, outcome: "reply", replyWithFooter: "Bonjour\n—\nCharly", decision: smartGoodDecision() as never })).toMatchObject({ outcome: "repondre", citations: ["fiche-connexion"] });
  });
});
