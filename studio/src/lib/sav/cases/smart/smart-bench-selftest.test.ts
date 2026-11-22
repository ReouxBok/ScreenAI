import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_POLICY, ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import { savCaseEffectExecutions, savCases, savIntakeEffects, savMessages, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSavBenchScriptedAgent, createSavBenchScriptedJudge } from "../../bench/bench-doubles";
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { createSavBenchGeminiJudge } from "../../bench/bench-judge";
import { savBenchGeminiEnvelope } from "../../bench/bench-wire";
import type { SavBenchAgent } from "../../bench/bench-types";
import { accessSkillWireAnswer } from "../access-skill/access-skill-wire";
import { createSavBenchAgent, smartBenchTurn, smartBenchTurnCodes } from "./smart-bench-agent";
import { runSmartTurn } from "./smart-agent";
import { smartEmptyMemory } from "./smart-memory";
import {
  readSmartBenchSelfTestConcurrency, readSmartBenchSelfTestConfig, readSmartBenchSelfTestReport, readSmartBenchSelfTestRows, runSmartBenchSelfTestPass, smartBenchConversationLine, smartBenchTurnDetailLine, SMART_BENCH_TURN_DETAIL_MAX_BYTES, smartBenchItem, smartBenchReportLine, smartBenchRisky, smartBenchRunPattern, smartBenchSelfTestSet,
  aggregateSmartBenchSelfTest, SAV_SMART_BENCH_NEW_CALLS, SAV_SMART_BENCH_SELFTEST_CORPUS, SAV_SMART_BENCH_SELFTEST_PREFIX, SAV_SMART_BENCH_SELFTEST_VARIANTS, type SmartBenchSelfTestDeps,
} from "./smart-bench-selftest";
import { readSmartLedger, smartItemKey } from "./smart-ledger";
import { SAV_SMART_SHADOW_MODEL_CALLS } from "./smart-shadow";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge } from "./smart-test-doubles";

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
      : { action: "final", calls: [], decision: { outcome: "handoff", reply: null, teamNote: "note", handoffReason: "no_source", coverage: [{ needId: "n1", status: "handed" }], facts: [] } };
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
  it("valeurs bornées : identifiant, agent, lot ≤ 20, plafond par défaut 10 000 000 µUSD et ≤ 15 000 000, jeu, passes", () => {
    expect(readSmartBenchSelfTestConfig(ENV())).toEqual({ mode: "run", runId: "run-1", agents: ["current", "new"], batch: 6, capMicroUsd: 10_000_000, set: "base", passes: 1 });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD: "15000000" }))).toMatchObject({ mode: "run", capMicroUsd: 15_000_000 });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD: "15000001" }))).toEqual({ mode: "refused", reason: "cap_invalid" });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD: "0" }))).toEqual({ mode: "refused", reason: "cap_invalid" });
    for (const set of ["base", "variants", "all", "risky"]) expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_SET: set }))).toMatchObject({ mode: "run", set });
    for (const set of ["", "ALL", "tout", "base,risky"]) expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_SET: set }))).toEqual({ mode: "refused", reason: "set_invalid" });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_PASSES: "2" }))).toMatchObject({ mode: "run", passes: 2 });
    for (const passes of ["0", "3", "", "deux", "1.5"]) expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_PASSES: passes }))).toEqual({ mode: "refused", reason: "passes_invalid" });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new" }))).toMatchObject({ agents: ["new"] });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "a b" }))).toEqual({ mode: "refused", reason: "id_invalid" });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "tous" }))).toEqual({ mode: "refused", reason: "agent_invalid" });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_BATCH: "21" }))).toEqual({ mode: "refused", reason: "batch_invalid" });
    expect(SAV_SMART_BENCH_NEW_CALLS).toBe(SAV_SMART_SHADOW_MODEL_CALLS);
    // v2: understand + 3 decide passes + verify + correct + reverify; the corpus is the 120 conversations plus the 12 multi-turn ones.
    expect(SAV_SMART_BENCH_NEW_CALLS).toBe(7);
    expect(SAV_SMART_BENCH_SELFTEST_CORPUS).toHaveLength(132);
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
  it("journal : une ligne par conversation et le rapport final, codes et nombres seulement (jamais le texte d'une réponse)", async () => {
    const net = network(), env = ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new", SAV_V2_SMART_BENCH_SELFTEST_ID: "run-log" }), logs: [string, Record<string, unknown>][] = [];
    await runSmartBenchSelfTestPass(deps(env, net, { log: (event, fields) => logs.push([event, fields]) }));
    const lines = logs.filter(([event]) => event === "sav_smart_bench_conversation").map(([, fields]) => fields);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatchObject({ runId: "run-log", agent: "new", passed: expect.any(Boolean), costMicroUsd: expect.any(Number) });
      expect(Object.keys(line).sort()).toEqual(["agent", "calls", "conversationId", "costMicroUsd", "endedBy", "failedTurns", "family", "pass", "passed", "runId", "stopped", "turnsPlayed"]);
      expect(line.pass).toBe(1);
    }
    const reports = logs.filter(([event]) => event === "sav_smart_bench_report").map(([, fields]) => fields);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ runId: "run-log", new: { conversationsStored: 3, metrics: { conversations: 3 } }, current: { conversationsStored: 0 } });
    // Every line but the failed turns' detail (fictional texts, `sav_smart_bench_turn_detail`): codes and numbers only.
    const coded = logs.filter(([event]) => event !== "sav_smart_bench_turn_detail");
    expect(JSON.stringify(coded)).not.toContain("teamNote");
    expect(JSON.stringify(coded)).not.toMatch(/"reply":/);
    // A pass with nothing left to run logs the report again, and no conversation line.
    logs.length = 0;
    await runSmartBenchSelfTestPass(deps(env, net, { log: (event, fields) => logs.push([event, fields]) }));
    expect(logs.map(([event]) => event)).toEqual(["sav_smart_bench_selftest", "sav_smart_bench_report"]);
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

describe("jeux de conversations et seconde passe (coût maîtrisé)", () => {
  it("base = les 132 inchangées ; variants = 3 par conversation ; all = les deux ; risky = sensibles + pièges, base et variantes", () => {
    expect(smartBenchSelfTestSet("base")).toBe(SAV_SMART_BENCH_SELFTEST_CORPUS);
    expect(smartBenchSelfTestSet("variants")).toHaveLength(3 * SAV_SMART_BENCH_SELFTEST_CORPUS.length);
    const all = smartBenchSelfTestSet("all"), risky = smartBenchSelfTestSet("risky");
    expect(all).toHaveLength(4 * SAV_SMART_BENCH_SELFTEST_CORPUS.length);
    expect(new Set(all.map(row => row.id)).size).toBe(all.length);
    expect(risky.length).toBeGreaterThan(0);
    expect(risky.every(smartBenchRisky)).toBe(true);
    expect(risky).toEqual(all.filter(smartBenchRisky));
    // Every trap and every sensitive conversation is in it, from the base and from the variants.
    for (const row of all.filter(row => row.family.startsWith("piege_") || row.turns.some(turn => [turn.expect.outcome].flat().includes("equipe_sensible"))))
      expect(risky.map(r => r.id), row.id).toContain(row.id);
    expect(risky.some(row => SAV_SMART_BENCH_SELFTEST_VARIANTS.includes(row))).toBe(true);
    expect(risky.some(row => SAV_SMART_BENCH_SELFTEST_CORPUS.includes(row))).toBe(true);
  });
  it("clé de la passe 2 distincte, passe 1 inchangée", () => {
    expect(smartBenchItem("r", "new", "nylas-01")).toBe("r:new:nylas-01");
    expect(smartBenchItem("r", "new", "nylas-01", 1)).toBe("r:new:nylas-01");
    expect(smartBenchItem("r", "new", "nylas-01", 2)).toBe("r:new:nylas-01:p2");
  });
  it("_PASSES=2 : chaque conversation réservée et payée une fois par passe, journal et rapport portent la passe, liste de stabilité", async () => {
    const net = network(), logs: [string, Record<string, unknown>][] = [];
    const env = ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new", SAV_V2_SMART_BENCH_SELFTEST_ID: "run-p2", SAV_V2_SMART_BENCH_SELFTEST_PASSES: "2" });
    expect(await runSmartBenchSelfTestPass(deps(env, net, { log: (event, fields) => logs.push([event, fields]) }))).toMatchObject({ ran: 6, stoppedBy: "done", remaining: 0 });
    const callsAfter = net.calls.length;
    expect(await runSmartBenchSelfTestPass(deps(env, net))).toMatchObject({ ran: 0, stoppedBy: "done" });
    expect(net.calls).toHaveLength(callsAfter);
    expect(await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "run-p2")).toMatchObject({ items: 6, open: {} });
    const keys = (await f.db.select({ key: savSyncState.key }).from(savSyncState).where(like(savSyncState.key, smartBenchRunPattern("run-p2")))).map(row => row.key).sort();
    expect(keys).toEqual(CORPUS.flatMap(row => [1, 2].map(pass => smartItemKey(SAV_SMART_BENCH_SELFTEST_PREFIX, smartBenchItem("run-p2", "new", row.id, pass as 1 | 2)))).sort());
    const lines = logs.filter(([event]) => event === "sav_smart_bench_conversation").map(([, fields]) => fields);
    expect(lines.map(line => line.pass)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(logs.find(([event]) => event === "sav_smart_bench_selftest")?.[1]).toMatchObject({ set: "base", passes: 2 });
    const rows = await readSmartBenchSelfTestRows("run-p2");
    expect(rows.map(row => row.pass).sort()).toEqual([1, 1, 1, 2, 2, 2]);
    const report = aggregateSmartBenchSelfTest(rows);
    expect(report.new.conversationsStored).toBe(3);
    expect(report.pass2?.new.conversationsStored).toBe(3);
    expect(report.pass2?.stability.new).toEqual({ compared: 3, unstable: [] });
    // A pass 2 row that changed verdict is listed as unstable.
    const flipped = rows.map(row => row.pass === 2 && row.conversationId === CORPUS[0]!.id && row.conversation ? { ...row, conversation: { ...row.conversation, passed: !row.conversation.passed } } : row);
    const unstable = aggregateSmartBenchSelfTest(flipped).pass2!.stability.new;
    expect(unstable.unstable.map(row => row.conversationId)).toEqual([CORPUS[0]!.id]);
    expect(smartBenchReportLine("run-p2", aggregateSmartBenchSelfTest(flipped)).pass2?.stability.new).toMatchObject({ compared: 3, unstableCount: 1 });
    // Rows stored before passes existed count as pass 1.
    expect(aggregateSmartBenchSelfTest(rows.filter(row => row.pass === 1).map(row => ({ ...row, pass: undefined }))).new.conversationsStored).toBe(3);
  });
  it("_PASSES=2 sous plafond : la passe 2 est réservée avec son pire cas comme la passe 1, arrêt au plafond avant tout appel", async () => {
    const net = network();
    expect(await runSmartBenchSelfTestPass(deps(ENV({ SAV_V2_SMART_BENCH_SELFTEST_PASSES: "2", SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD: "3" }), net))).toMatchObject({ ran: 0, stoppedBy: "money_cap" });
    expect(net.calls).toEqual([]);
  });
  it("jeu refusé ou passes refusées : rien n'est lu ni appelé, raison fermée journalisée", async () => {
    state.db = null;
    const net = network(), logs: [string, Record<string, unknown>][] = [];
    expect(await runSmartBenchSelfTestPass(deps(ENV({ SAV_V2_SMART_BENCH_SELFTEST_SET: "tout" }), net, { log: (event, fields) => logs.push([event, fields]) }))).toEqual({ skipped: "refused", reason: "set_invalid" });
    expect(await runSmartBenchSelfTestPass(deps(ENV({ SAV_V2_SMART_BENCH_SELFTEST_PASSES: "3" }), net, { log: (event, fields) => logs.push([event, fields]) }))).toEqual({ skipped: "refused", reason: "passes_invalid" });
    expect(logs).toEqual([["sav_smart_bench_selftest_refused", { reason: "set_invalid" }], ["sav_smart_bench_selftest_refused", { reason: "passes_invalid" }]]);
    expect(net.calls).toEqual([]);
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
      corrected: false, calls: [], sources: [], missing: [], steps: [], teamNote: null, teamNoteText: null, memory: smartEmptyMemory(), progressed: true };
    expect(smartBenchTurn({ ...base, outcome: "team_sensitive" })).toMatchObject({ outcome: "equipe_sensible", reply: null });
    expect(smartBenchTurn({ ...base, outcome: "failed" })).toMatchObject({ outcome: "passer_la_main", reply: null, failure: "failed:x" });
    expect(smartBenchTurn({ ...base, outcome: "reply", replyWithFooter: "Bonjour\n—\nCharly", decision: smartGoodDecision() as never })).toMatchObject({ outcome: "repondre", citations: ["fiche-connexion"] });
  });
});

describe("diagnostic SAV-122 : pourquoi le cerveau a transféré, en codes fermés seulement", () => {
  it("tour à 4 appels (relecture refuse, la correction transfère) : codes du premier contrôle, de la relecture, correction et séquence d'appels ; aucun texte", async () => {
    const secret = "PHRASE-CLIENT-SECRETE";
    const scripted = smartScriptedModel({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() },
      verify: { output: { verdict: "non_conforme", problems: [{ code: "other_platform", sentence: secret }] } },
      correct: { output: smartGoodDecision({ outcome: "handoff", reply: null, handoffReason: "unsure", coverage: [{ needId: "n1", status: "handed" }], facts: [],
        teamNote: { raison: "unsure", besoin: secret, compris: secret, verifie: [], essaye: [], hypotheses: [], prochaineVerification: secret, ditAuClient: null } }) } });
    const result = await runSmartTurn({ subject: "Connexion", body: `Bonjour ${secret}`, thread: [] },
      { model: scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-21" });
    expect(result.outcome).toBe("handoff");
    const codes = smartBenchTurnCodes(result);
    expect(codes).toEqual(expect.arrayContaining(["first:verdict:non_conforme", "first:verify:other_platform", "corrected", "handoff_reason:unsure", "note:unsure", "calls:understand>decide>verify>correct"]));
    expect(smartBenchTurn(result).codes).toEqual(codes);
    expect(JSON.stringify(codes)).not.toContain(secret);
    expect(codes.every(code => /^[a-z0-9_:.>-]{1,80}$/.test(code))).toBe(true);
  });
  it("la ligne de journal porte ces codes dans failedTurns[].codes, filtrés (un texte libre n'y passe jamais)", () => {
    const turn = { turn: 1, expected: ["repondre"], outcome: "passer_la_main", reply: "texte de réponse", codes: ["first:check:sensitive_commitment", "Texte libre du client !"], failure: null,
      checks: [{ code: "outcome_mismatch", criterion: "issue", detail: "x" }], judge: null, verdict: { passed: false, criteria: { issue: { final: "echec" } } } };
    const line = smartBenchConversationLine({ runId: "r", agent: "new", conversationId: "mdp-01", conversation: null, turns: [turn], stopped: null, costMicroUsd: 0, calls: 4 } as never);
    expect(line.failedTurns[0]).toMatchObject({ codes: ["first:check:sensitive_commitment"], checks: ["outcome_mismatch"], failed: ["issue"] });
    expect(JSON.stringify(line)).not.toMatch(/texte de réponse|Texte libre/);
  });
});

describe("détail des tours en échec (sav_smart_bench_turn_detail, corpus fictif seulement)", () => {
  const NYLAS = SAV_BENCH_CORPUS.filter(conversation => conversation.id === "nylas-01");
  const run = async (strategy: "labelled" | "password", id: string) => {
    const net = network(), logs: [string, Record<string, unknown>][] = [];
    const env = ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new", SAV_V2_SMART_BENCH_SELFTEST_ID: id });
    await runSmartBenchSelfTestPass(deps(env, net, { corpus: NYLAS, agents: () => createSavBenchScriptedAgent(NYLAS, strategy), log: (event, fields) => logs.push([event, fields]) }));
    const conversation = logs.find(([event]) => event === "sav_smart_bench_conversation")![1] as { failedTurns: unknown[]; turnsPlayed: number };
    return { conversation, details: logs.filter(([event]) => event === "sav_smart_bench_turn_detail").map(([, fields]) => fields) };
  };
  it("tour réussi : aucune ligne de détail", async () => {
    const { conversation, details } = await run("labelled", "run-detail-ok");
    expect(conversation.turnsPlayed).toBeGreaterThan(0);
    expect(conversation.failedTurns).toEqual([]);
    expect(details).toEqual([]);
  });
  it("tour en échec (mot de passe demandé) : une ligne par tour en échec, avec la réponse, le message client, le juge et l'extrait du motif interdit", async () => {
    const { conversation, details } = await run("password", "run-detail-ko");
    expect(details.length).toBe(conversation.failedTurns.length);
    expect(details.length).toBeGreaterThan(0);
    const first = details[0] as unknown as NonNullable<ReturnType<typeof smartBenchTurnDetailLine>>;
    expect(first).toMatchObject({ runId: "run-detail-ko", pass: 1, agent: "new", conversationId: "nylas-01", family: "nylas_imap_smtp", turn: 1, expectedOutcomes: ["repondre", "demander"], outcome: "repondre" });
    expect(first.failed).toContain("pas_de_mot_de_passe");
    expect(first.customerMessage).toContain("ma boîte mail est chez OVH");
    expect(first.reply).toContain("Pouvez-vous nous envoyer votre mot de passe ?");
    expect(first.judge).toMatchObject({ status: "ok", verdicts: { issue: "ok", pas_de_mot_de_passe: "ok" } });
    expect(first.forbiddenMatches).toContainEqual({ pattern: "forbidden_pattern:1", source: expect.stringContaining("envoy"), snippet: expect.stringContaining("envoyer votre mot de passe") });
    expect(first.forbiddenMatches.every(match => (match.snippet ?? "").length <= 160)).toBe(true);
    expect(first.checks.map(hit => hit.code)).toEqual(expect.arrayContaining(["password_requested", "forbidden_pattern"]));
    expect(first.citedCards).toEqual([{ id: "mail-imap-parametres", title: expect.any(String) }]);
    for (const line of details) expect(Buffer.byteLength(JSON.stringify(line), "utf8")).toBeLessThanOrEqual(SMART_BENCH_TURN_DETAIL_MAX_BYTES);
  });
  const conversation = SAV_BENCH_CORPUS.find(row => row.id === "nylas-01")!;
  const justification = "j".repeat(400);
  const row = (reply: string) => ({ pass: 1, conversationId: "nylas-01", family: "nylas_imap_smtp", turn: 1, expected: ["repondre"], sensitive: false, outcome: "demander", reply,
    codes: Array.from({ length: 30 }, (_, index) => `code_${index}`), failure: null,
    checks: [{ code: "forbidden_pattern", criterion: "pas_de_mot_de_passe", detail: conversation.turns[0]!.expect.mustNotMatch[1]!, label: "forbidden_pattern:1" }],
    judge: { status: "ok", verdicts: Object.fromEntries(["issue", "faits_sources", "pas_de_promesse", "jamais_autre_plateforme", "pas_de_mot_de_passe", "pas_de_repetition", "fait_avancer"]
      .map(criterion => [criterion, { verdict: "echec", justification }])) },
    verdict: { passed: false, criteria: Object.fromEntries(["issue", "faits_sources", "pas_de_promesse", "jamais_autre_plateforme", "pas_de_mot_de_passe", "pas_de_repetition", "fait_avancer"]
      .map(criterion => [criterion, { final: "echec" }])) } }) as never;
  const stored = { runId: "r", pass: 1, agent: "new" } as never;
  it("champs tronqués et ligne sous 6 000 octets", () => {
    const reply = `${"é".repeat(5_000)}. Pouvez-vous nous envoyer votre mot de passe ? ${"à".repeat(5_000)}`;
    const line = smartBenchTurnDetailLine(stored, row(reply), conversation, { customerMessage: "c".repeat(5_000), citations: ["mail-imap-parametres", "inconnue"], handoffNote: "n".repeat(5_000) })!;
    expect(Buffer.byteLength(JSON.stringify(line), "utf8")).toBeLessThanOrEqual(SMART_BENCH_TURN_DETAIL_MAX_BYTES);
    expect(line.reply!.length).toBeLessThanOrEqual(2_500);
    expect(line.customerMessage!.length).toBeLessThanOrEqual(800);
    expect(line.handoffNote!.length).toBeLessThanOrEqual(800);
    expect(line.question!.length).toBeLessThanOrEqual(600);
    expect(line.question).toContain("mot de passe ?");
    expect(line.judge.status === "ok" && line.judge.explanation!.length).toBeLessThanOrEqual(1_200);
    expect(line.codes).toHaveLength(20);
    expect(line.forbiddenMatches[0]!.snippet).toContain("envoyer votre mot de passe");
    expect(line.forbiddenMatches[0]!.snippet!.length).toBeLessThanOrEqual(160);
    expect(line.citedCards).toEqual([{ id: "mail-imap-parametres", title: expect.any(String) }, { id: "inconnue", title: null }]);
  });
  it("garde : une conversation qui n'est pas un objet du corpus fictif embarqué (même identifiant) ne produit rien", () => {
    expect(smartBenchTurnDetailLine(stored, row("Bonjour"), { ...conversation }, undefined)).toBeNull();
    expect(smartBenchTurnDetailLine(stored, row("Bonjour"), conversation, undefined)).not.toBeNull();
  });
});

describe("plafond de dépense garanti", () => {
  /** A policy whose reservation (1 000 µUSD per call) is far above a normal measured cost (1 µUSD), to tell the two apart. */
  const RESERVE = 1_000;
  const POLICY_ENV = (extra: Record<string, string> = {}) => ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new",
    SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...ACCESS_SKILL_TEST_POLICY, model: { ...ACCESS_SKILL_TEST_POLICY.model, reserveMicroUsdPerCall: RESERVE } }), ...extra });
  /** `perTurn` scripted agent calls per turn through the meter, each with a body of `bytes` bytes; never a reply (so no judge call). */
  const scripted = (bytes = 100, perTurn = 1) => (_name: string, meter: (url: string, init: RequestInit) => Promise<Response>): SavBenchAgent => ({ name: "scripted", revision: "x", respond: async () => {
    for (let call = 0; call < perTurn; call += 1)
      await meter("https://generativelanguage.googleapis.com/v1beta/models/synthetic-model:generateContent", { method: "POST", body: "x".repeat(bytes) });
    return { outcome: "passer_la_main", reply: null, citations: [], codes: [] };
  } });
  const answering = (usageMetadata: unknown) => {
    const seen: string[] = [];
    return { seen, fn: async (url: string) => { seen.push(url); return Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata }); } };
  };

  it("sortie absente ou usage illisible : chaque appel compté au prix de la réservation, jamais gratuit", async () => {
    for (const [runId, usage] of [["miss-out", { promptTokenCount: 1_000 }], ["unreadable", "illisible"], ["absent", undefined], ["negative", { promptTokenCount: 1_000, candidatesTokenCount: -1 }]] as const) {
      const net = answering(usage);
      const result = await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: runId }), network(), { network: net.fn, corpus: CORPUS.slice(0, 1), agents: scripted() }));
      expect(result).toMatchObject({ ran: 1 });
      expect(net.seen.length).toBeGreaterThan(0);
      expect(await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, runId)).toMatchObject({ settledMicroUsd: RESERVE * net.seen.length, open: {} });
    }
  });
  it("usage complet : coût mesuré (1 µUSD), pas la réservation", async () => {
    const net = answering({ promptTokenCount: 1_000, candidatesTokenCount: 200 });
    await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "measured" }), network(), { network: net.fn, corpus: CORPUS.slice(0, 1), agents: scripted() }));
    expect((await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "measured")).settledMicroUsd).toBe(net.seen.length);
  });
  it("coût mesuré au-dessus de la réservation : coût réel compté, puis l'appel suivant et la conversation suivante sont refusés", async () => {
    // 10^13 input tokens at 1 µUSD per million = 10 000 000 µUSD: the whole cap, far above the conversation's reservation.
    const net = answering({ promptTokenCount: 10_000_000_000_000, candidatesTokenCount: 0 });
    const corpus = CORPUS.slice(0, 2);
    const result = await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "over" }), network(), { network: net.fn, corpus, agents: scripted(100, 2) }));
    expect(net.seen).toHaveLength(1);
    expect(result).toMatchObject({ ran: 1, stoppedBy: "money_cap", spentMicroUsd: 10_000_000 });
    expect(await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "over")).toMatchObject({ items: 1, settledMicroUsd: 10_000_000, open: {} });
    const [row] = await readSmartBenchSelfTestRows("over");
    expect(row).toMatchObject({ costMicroUsd: 10_000_000, calls: 1, stopped: "money_budget" });
    // A later pass on the same run: the real spend has reached the cap, nothing is authorised.
    expect(await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "over" }), network(), { network: net.fn, corpus, agents: scripted(100, 2) })))
      .toMatchObject({ ran: 0, stoppedBy: "money_cap" });
    expect(net.seen).toHaveLength(1);
  });
  it("corps au-dessus de la limite d'entrée de la réservation : refusé sans envoi (agent et juge)", async () => {
    const net = answering({ promptTokenCount: 1_000, candidatesTokenCount: 200 });
    await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "big" }), network(), { network: net.fn, corpus: CORPUS.slice(0, 1), agents: scripted(100_001) }));
    expect(net.seen).toEqual([]);
    expect((await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "big")).settledMicroUsd).toBe(0);
    const sent = vi.fn(async () => Response.json({}));
    const judge = createSavBenchGeminiJudge({ network: sent, model: "synthetic-model", key: "k", maxOutputTokens: 100, maxInputBytes: 500 });
    expect(await judge.judge({ conversationId: "c", turn: 1, messages: [{ from: "client", text: "x".repeat(600), at: "2026-11-20T09:00:00.000Z" }],
      agent: { outcome: "repondre", reply: "ok", citations: [], codes: [] }, expect: { outcomes: [], keyFacts: [], forbidden: [] }, cards: [], previousReplies: [], now: "2026-11-20T09:05:00.000Z" }))
      .toEqual({ status: "failed", problem: "judge_input_too_large" });
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("pannes contenues : le cron de prod ne passe jamais en erreur à cause du banc", () => {
  const failingStore = (code: string) => new Proxy(f.db as unknown as Record<string | symbol, unknown>, { get(target, prop) {
    if (prop === "transaction") return async () => { throw Object.assign(new Error("synthetic failure, message never logged"), { code }); };
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  it("erreur SQL à la réservation : résultat codé, rien n'est levé, 0 appel", async () => {
    const net = network(), logs: unknown[] = [];
    state.db = failingStore("XX000");
    expect(await runSmartBenchSelfTestPass(deps(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new" }), net, { log: (event, fields) => logs.push([event, fields]) })))
      .toEqual({ skipped: "error_contained", code: "sql_XX000" });
    expect(net.calls).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain("synthetic failure");
  });
  it("verrou tenu trop longtemps (55P03) : sortie propre et codée", async () => {
    state.db = failingStore("55P03");
    expect(await runSmartBenchSelfTestPass(deps(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new" }), network()))).toEqual({ skipped: "error_contained", code: "sql_55P03" });
  });
});

describe("rapport d'un run", () => {
  it("`_` et `%` de l'identifiant pris à la lettre : le rapport de lot_1 n'inclut pas lotA1", async () => {
    expect(smartBenchRunPattern("lot_1")).toBe("sav-v2-smart-bench-selftest.v1:item:lot\\_1:%");
    expect(smartBenchRunPattern("a%b")).toBe("sav-v2-smart-bench-selftest.v1:item:a\\%b:%");
    const net = network();
    for (const runId of ["lot_1", "lotA1"])
      await runSmartBenchSelfTestPass(deps(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new", SAV_V2_SMART_BENCH_SELFTEST_ID: runId }), net, { corpus: CORPUS.slice(0, 1) }));
    expect((await readSmartBenchSelfTestRows("lot_1")).map(row => row.runId)).toEqual(["lot_1"]);
    expect((await readSmartBenchSelfTestRows("lotA1")).map(row => row.runId)).toEqual(["lotA1"]);
  });
});

describe("concurrence (21/11) : N conversations en parallèle dans une passe", () => {
  const RESERVE = 1_000, CALLS_PER_TURN = SAV_SMART_BENCH_NEW_CALLS + 1;
  const POLICY_ENV = (extra: Record<string, string> = {}) => ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "new", SAV_V2_SMART_BENCH_SELFTEST_BATCH: "20",
    SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...ACCESS_SKILL_TEST_POLICY, model: { ...ACCESS_SKILL_TEST_POLICY.model, reserveMicroUsdPerCall: RESERVE } }), ...extra });
  /** Eight one-turn conversations: the same worst case each (CALLS_PER_TURN × RESERVE). */
  const ONE_TURN = SAV_BENCH_CORPUS.filter(row => !row.risky && row.turns.length === 1).slice(0, 8);
  const WORST = CALLS_PER_TURN * RESERVE;
  /** The slow model: each call waits `delayMs`, counts the calls in flight, optionally advances a fake clock; usage unreadable → costs the reservation. */
  const slow = (delayMs: number, onCall: () => void = () => undefined) => {
    const state = { inFlight: 0, maxInFlight: 0, sent: 0 };
    const fn = async () => {
      onCall();
      state.sent += 1; state.inFlight += 1; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      state.inFlight -= 1;
      return Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] });
    };
    return { state, fn };
  };
  /** A scripted agent making `perTurn` calls per turn through the meter; counts the turns played per conversation. */
  const scripted = (played: Map<string, number>, perTurn = 1) => (_name: string, meter: (url: string, init: RequestInit) => Promise<Response>): SavBenchAgent => ({ name: "scripted", revision: "x",
    respond: async input => {
      played.set(input.conversationId, (played.get(input.conversationId) ?? 0) + 1);
      for (let call = 0; call < perTurn; call += 1)
        await meter("https://generativelanguage.googleapis.com/v1beta/models/synthetic-model:generateContent", { method: "POST", body: "x" });
      return { outcome: "passer_la_main", reply: null, citations: [], codes: [] };
    } });

  it("réglage : absent → 1 (comportement d'avant) ; 1 à 8 ; sinon refusé avant toute lecture", async () => {
    expect(ONE_TURN).toHaveLength(8);
    expect(readSmartBenchSelfTestConcurrency(ENV())).toBe(1);
    for (const value of ["1", "4", "8"]) expect(readSmartBenchSelfTestConcurrency(ENV({ SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: value }))).toBe(Number(value));
    for (const value of ["0", "9", "", "quatre", "2.5", "-1"]) {
      expect(readSmartBenchSelfTestConcurrency(ENV({ SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: value }))).toBeNull();
      expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: value }))).toEqual({ mode: "refused", reason: "concurrency_invalid" });
    }
    state.db = null;
    expect(await runSmartBenchSelfTestPass(deps(ENV({ SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: "9" }), network()))).toEqual({ skipped: "refused", reason: "concurrency_invalid" });
  });

  it("concurrence 4, modèle lent : 4 conversations en même temps, chacune jouée, réservée, réglée et journalisée une fois", async () => {
    const net = slow(30), played = new Map<string, number>(), logs: [string, Record<string, unknown>][] = [];
    const result = await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "par-4", SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: "4" }), network(),
      { network: net.fn, corpus: ONE_TURN, agents: scripted(played), log: (event, fields) => logs.push([event, fields]) }));
    expect(net.state.maxInFlight).toBe(4);
    expect(result).toMatchObject({ ran: 8, stoppedBy: "done", remaining: 0, spentMicroUsd: RESERVE * net.state.sent });
    expect([...played.values()]).toEqual(Array(8).fill(1));
    expect(await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "par-4")).toMatchObject({ items: 8, open: {}, settledMicroUsd: RESERVE * net.state.sent });
    const lines = logs.filter(([event]) => event === "sav_smart_bench_conversation").map(([, fields]) => fields.conversationId);
    expect([...lines].sort()).toEqual(ONE_TURN.map(row => row.id).sort());
    expect(logs.filter(([event]) => event === "sav_smart_bench_selftest")).toHaveLength(1);
  });

  it("concurrence 4 et lot de 6 : jamais plus de 6 conversations commencées", async () => {
    const net = slow(20), played = new Map<string, number>();
    const result = await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "par-batch", SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: "4", SAV_V2_SMART_BENCH_SELFTEST_BATCH: "6" }), network(),
      { network: net.fn, corpus: ONE_TURN, agents: scripted(played) }));
    expect(result).toMatchObject({ ran: 6, stoppedBy: "batch", remaining: 2 });
    expect(played.size).toBe(6);
    expect((await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "par-batch")).items).toBe(6);
  });

  it("concurrence 4, plafond de 2,5 conversations : les réservations en vol comptent, arrêt net sans dépassement", async () => {
    const net = slow(30), played = new Map<string, number>();
    const cap = Math.floor(2.5 * WORST);
    const result = await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "par-cap", SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: "4", SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD: String(cap) }), network(),
      { network: net.fn, corpus: ONE_TURN, agents: scripted(played) }));
    // Two worst cases fit, the third claim (made while the first two are still in flight) is refused: 2 played, money cap.
    expect(result).toMatchObject({ ran: 2, stoppedBy: "money_cap", remaining: 6 });
    expect(played.size).toBe(2);
    expect(net.state.maxInFlight).toBeLessThanOrEqual(2);
    const ledger = await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "par-cap");
    expect(ledger).toMatchObject({ items: 2, open: {} });
    expect(ledger.settledMicroUsd).toBe(RESERVE * net.state.sent);
    expect(ledger.settledMicroUsd).toBeLessThanOrEqual(cap);
    expect((result as { spentMicroUsd: number }).spentMicroUsd).toBeLessThanOrEqual(cap);
  });

  it("concurrence 4, un appel mesuré au-dessus de la réservation : les autres conversations en vol n'envoient plus d'appel", async () => {
    let sent = 0;
    const fn = async () => {
      sent += 1;
      const first = sent === 1;
      await new Promise(resolve => setTimeout(resolve, first ? 5 : 40));
      return Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: { promptTokenCount: first ? 10_000_000_000_000 : 1_000, candidatesTokenCount: 0 } });
    };
    const played = new Map<string, number>();
    const result = await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "par-over", SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: "4" }), network(),
      { network: fn, corpus: ONE_TURN, agents: scripted(played, 3) }));
    // The 4 first calls were already in flight; after the overrun no call is sent and no conversation starts.
    expect(sent).toBe(4);
    expect(result).toMatchObject({ ran: 4, stoppedBy: "money_cap", remaining: 4 });
    expect((await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "par-over")).open).toEqual({});
  });

  it("concurrence 4, deadline : aucune conversation commencée sous 150 s, aucun appel envoyé sous la limite par appel", async () => {
    const t0 = 1_000_000, deadlineMs = t0 + 170_000;
    let t = t0;
    const leftAtSend: number[] = [], leftAtStart: number[] = [];
    const net = slow(10, () => { leftAtSend.push(deadlineMs - t); t += 20_000; });
    const played = new Map<string, number>();
    const agents = (name: SmartBenchAgentNameForTest, meter: (url: string, init: RequestInit) => Promise<Response>) => {
      const inner = scripted(played, 3)(name, meter);
      return { ...inner, respond: async (input: Parameters<SavBenchAgent["respond"]>[0]) => { if (input.turn === 1) leftAtStart.push(deadlineMs - t); return inner.respond(input); } };
    };
    const result = await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "par-deadline", SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: "4" }), network(),
      { network: net.fn, corpus: ONE_TURN, agents, clock: () => t, deadlineMs }));
    expect(result).toMatchObject({ ran: 4, stoppedBy: "deadline", remaining: 4 });
    // The four starts are decided at t0 (170 s left), before the claim, as in the serial loop; once the in-flight calls brought the time left
    // under 150 s, no fifth conversation starts although four remain.
    expect(leftAtStart).toHaveLength(4);
    expect(Math.max(...leftAtSend)).toBe(170_000);
    expect(deadlineMs - t).toBeLessThan(150_000);
    expect(leftAtSend.length).toBeGreaterThan(0);
    expect(leftAtSend.every(left => left >= 8_000 + 3_000)).toBe(true);
    const rows = await readSmartBenchSelfTestRows("par-deadline");
    expect(rows.some(row => row.stopped === "deadline")).toBe(true);
    expect((await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "par-deadline")).open).toEqual({});
  });

  it("deux passes de concurrence 4 qui se chevauchent : `already_claimed` jamais joué deux fois", async () => {
    const net = slow(15), played = new Map<string, number>(), logs: string[] = [];
    const run = () => runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "par-overlap", SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: "4" }), network(),
      { network: net.fn, corpus: ONE_TURN, agents: scripted(played), log: (event, fields) => { if (event === "sav_smart_bench_conversation") logs.push(String(fields.conversationId)); } }));
    const [a, b] = await Promise.all([run(), run()]);
    expect([...played.values()]).toEqual(Array(8).fill(1));
    expect(played.size).toBe(8);
    expect([...logs].sort()).toEqual(ONE_TURN.map(row => row.id).sort());
    expect((a as { ran: number }).ran + (b as { ran: number }).ran).toBe(8);
    expect(await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "par-overlap")).toMatchObject({ items: 8, open: {} });
    expect(await readSmartBenchSelfTestRows("par-overlap")).toHaveLength(8);
  });

  it("concurrence 4, erreur SQL à la réservation : résultat codé, rien n'est levé, 0 appel", async () => {
    const net = slow(5);
    state.db = new Proxy(f.db as unknown as Record<string | symbol, unknown>, { get(target, prop) {
      if (prop === "transaction") return async () => { throw Object.assign(new Error("synthetic"), { code: "XX000" }); };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await runSmartBenchSelfTestPass(deps(POLICY_ENV({ SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY: "4" }), network(), { network: net.fn, corpus: ONE_TURN, agents: scripted(new Map()) })))
      .toEqual({ skipped: "error_contained", code: "sql_XX000" });
    expect(net.state.sent).toBe(0);
  });
});
type SmartBenchAgentNameForTest = Parameters<NonNullable<SmartBenchSelfTestDeps["agents"]>>[0];
