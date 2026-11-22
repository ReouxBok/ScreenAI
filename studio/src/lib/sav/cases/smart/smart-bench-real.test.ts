import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import { savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { accessSkillWireAnswer } from "../access-skill/access-skill-wire";
import { SAV_RETRIEVAL_EMBEDDING_DIMENSION } from "../../request-retrieval-db";
import { SAV_SMART_MAX_EMBED_CALLS } from "./smart-agent";
import { smartBenchRealJudgeFittedBody, smartBenchRealJudgePrompt, SMART_BENCH_REAL_GRID, type SmartBenchRealVerdict } from "./smart-bench-real-judge";
import {
  aggregateSmartBenchSelfTest, readSmartBenchSelfTestConfig, readSmartBenchSelfTestRows, runSmartBenchSelfTestPass, SAV_SMART_BENCH_NEW_CALLS, SAV_SMART_BENCH_SELFTEST_PREFIX,
  smartBenchCallsPerTurn, smartBenchEmbedsPerTurn, smartBenchRealTurnLine, SMART_BENCH_TURN_DETAIL_MAX_BYTES, type SmartBenchSelfTestDeps, type SmartBenchStored,
} from "./smart-bench-selftest";
import { readSmartLedger, smartLedgerSpent } from "./smart-ledger";
import { smartPrices } from "./smart-model";
import { SMART_CONFORME, SMART_TEST_CARD, smartGoodDecision, smartReading } from "./smart-test-doubles";
import type { SmartSource } from "./smart-checks";

/*
 * Mode `real` (22/11) of the bench self-test: the new agent on the (doubled) real search, each turn judged by the real judge on the real cards
 * returned. PGlite, the model, the embedding and the judge doubled at the network. The card contents here are FICTIONAL markers.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const AT = new Date("2026-11-22T10:00:00.000Z");
const ENV = (extra: Record<string, string> = {}) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_SMART_BENCH_SELFTEST: "run", SAV_V2_SMART_BENCH_SELFTEST_ID: "real-1",
  SAV_V2_SMART_BENCH_SELFTEST_AGENT: "real", ...extra });
const CORPUS = SAV_BENCH_CORPUS.filter(conversation => !conversation.risky && conversation.turns.length === 1).slice(0, 2);
const CONTENT_MARKER = "CONTENU-FICHE-FICTIF-7f3a";
const card = (id: string, title: string, needIds: string[]): SmartSource =>
  ({ cardId: id, version: "v1", title, content: `${CONTENT_MARKER} ${title} : ouvrez Réglages puis Connexion.`, steps: [`${CONTENT_MARKER} étape`], needIds, validUntil: null });

type Verdicts = Record<string, { verdict: SmartBenchRealVerdict; reason: string }>;
const OK_VERDICTS: Verdicts = { decision: { verdict: "ok", reason: "Issue attendue." }, grounded: { verdict: "ok", reason: "Appuyé par la fiche « Se connecter »." },
  answers_need: { verdict: "ok", reason: "Répond à la demande." }, no_competitor_redirect: { verdict: "ok", reason: "Aucun concurrent." }, safe: { verdict: "ok", reason: "Rien de risqué." } };

function network(options: Readonly<{ verdicts?: Verdicts; decision?: unknown }> = {}) {
  const calls: string[] = [], judgeBodies: string[] = [];
  const fn = async (url: string, init: RequestInit) => {
    if (!url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/")) throw Error(`UNEXPECTED_HOST ${url}`);
    const body = JSON.parse(String(init.body));
    if (url.endsWith(":batchEmbedContents")) {
      calls.push("embed");
      return Response.json({ embeddings: body.requests.map(() => ({ values: Array.from({ length: SAV_RETRIEVAL_EMBEDDING_DIMENSION }, () => 0.01) })) });
    }
    const system: string = body.systemInstruction?.parts?.[0]?.text ?? "";
    const kind = system.startsWith("Tu es le juge") ? "judge" : system.startsWith("Tu lis un mail") ? "understand" : system.startsWith("RELECTURE") ? "verify" : "decide";
    calls.push(kind);
    if (kind === "judge") { judgeBodies.push(String(init.body)); return Response.json(accessSkillWireAnswer(options.verdicts ?? OK_VERDICTS, { inputTokens: 3_000, outputTokens: 300 })); }
    const output = kind === "understand" ? smartReading() : kind === "verify" ? SMART_CONFORME : { action: "final", calls: [], decision: options.decision ?? smartGoodDecision() };
    return Response.json(accessSkillWireAnswer(output, { inputTokens: 1_000, outputTokens: 200 }));
  };
  return { fn, calls, judgeBodies };
}
const searchKnowledge: SmartBenchSelfTestDeps["searchKnowledge"] = embed => async needs => {
  const embedded = await embed(needs.map(need => need.search ?? need.ask));
  if (embedded.status !== "ok") return { status: "unavailable", sources: [], codes: ["embed_failed"] };
  const ids = needs.map(need => need.id);
  // The agent's good decision cites `fiche-connexion`: the first real card is that one, its content marked (fictional).
  return { status: "ok", sources: [{ ...SMART_TEST_CARD, content: `${SMART_TEST_CARD.content}\n${CONTENT_MARKER}`, needIds: ids }, card("22222222-bbbb-4bbb-8bbb-222222222222", "Code non reçu", ids)], codes: [] };
};
const catalogue = async () => [{ id: "11111111-aaaa-4aaa-8aaa-111111111111", title: "Se connecter à Limova", slug: "se-connecter" }];

beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-bench-fixture-key-32-chars!!!!!"); f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-bench-fixture-key-32-chars!!!!!");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); }));
  state.db = f.db;
  await f.db.delete(savSyncState).where(like(savSyncState.key, `${SAV_SMART_BENCH_SELFTEST_PREFIX}:%`));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("mode real : configuration", () => {
  it("l'interrupteur accepte real, seul ; both reste current+new ; search et new inchangés", () => {
    expect(readSmartBenchSelfTestConfig(ENV())).toMatchObject({ mode: "run", agents: ["real"] });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "both" }))).toMatchObject({ agents: ["current", "new"] });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "search" }))).toMatchObject({ agents: ["search"] });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "reel" }))).toEqual({ mode: "refused", reason: "agent_invalid" });
    // Worst case per turn: the new agent's calls, plus ONE judge call; the query embeddings as in search.
    expect(smartBenchCallsPerTurn("real")).toBe(SAV_SMART_BENCH_NEW_CALLS + 1);
    expect(smartBenchEmbedsPerTurn("real")).toBe(SAV_SMART_MAX_EMBED_CALLS);
    expect(smartBenchEmbedsPerTurn("new")).toBe(0);
  });
});

describe("mode real : passe complète", () => {
  it("le juge reçoit le titre et le contenu des vraies fiches ; une ligne par tour sans contenu de fiche ; rapport par critère et famille", async () => {
    const net = network(), logs: Array<[string, Record<string, unknown>]> = [];
    const result = await runSmartBenchSelfTestPass({ env: () => ENV(), now: () => AT, network: net.fn, corpus: CORPUS, searchKnowledge, searchCatalogue: catalogue,
      log: (event, fields) => logs.push([event, fields]) });
    expect(result).toMatchObject({ ran: CORPUS.length, stoppedBy: "done" });
    if (!("ran" in result)) throw Error("not run");

    // One judge call per turn, carrying the real cards' title AND content.
    expect(net.calls.filter(kind => kind === "judge")).toHaveLength(CORPUS.length);
    const judgePayload = JSON.parse(JSON.parse(net.judgeBodies[0]!).contents[0].parts[0].text);
    expect(judgePayload.fiches).toEqual([
      { titre: "Se connecter à Limova", contenu: expect.stringContaining(CONTENT_MARKER) },
      { titre: "Code non reçu", contenu: expect.stringContaining(CONTENT_MARKER) },
    ]);
    expect(judgePayload.attendu.issues).toEqual(expect.arrayContaining(["repondre"]));
    expect(judgePayload).not.toHaveProperty("attendu.faitsCles");

    // Logs: the search record kept, one real line per turn (every turn), the real cards by short id and title, NEVER their content.
    expect(logs.filter(([event]) => event === "sav_smart_bench_search")).toHaveLength(CORPUS.length);
    expect(logs.filter(([event]) => event === "sav_smart_bench_turn_detail")).toHaveLength(0);
    const lines = logs.filter(([event]) => event === "sav_smart_bench_real_turn").map(([, fields]) => fields);
    expect(lines.map(line => line.conversationId)).toEqual(CORPUS.map(row => row.id));
    expect(lines[0]).toMatchObject({ agent: "real", turn: 1, outcome: "repondre", passed: true, reply: expect.any(String),
      customerMessage: expect.any(String),
      judge: { status: "ok", verdicts: { decision: { verdict: "ok", reason: "Issue attendue." }, safe: { verdict: "ok" } } },
      cards: [{ id: "fiche-co", title: "Se connecter à Limova" }, { id: "22222222", title: "Code non reçu" }] });
    for (const line of lines) expect(Buffer.byteLength(JSON.stringify(line), "utf8")).toBeLessThanOrEqual(SMART_BENCH_TURN_DETAIL_MAX_BYTES);
    expect(JSON.stringify(logs)).not.toContain(CONTENT_MARKER);
    // Nor stored (the encrypted rows hold short ids and titles only).
    const rows = await readSmartBenchSelfTestRows("real-1");
    expect(rows).toHaveLength(CORPUS.length);
    expect(JSON.stringify(rows)).not.toContain(CONTENT_MARKER);

    // The report: rates per criterion and per family, no_card count.
    const report = logs.find(([event]) => event === "sav_smart_bench_report")?.[1] as { real: Record<string, unknown> } | undefined;
    expect(report?.real).toMatchObject({ conversationsStored: CORPUS.length, conversationsPassed: CORPUS.length, noCard: 0, turns: CORPUS.length, passRate: 1,
      byCriterion: { grounded: { ok: CORPUS.length, echec: 0, rate: 1 }, decision: { no_card: 0 } }, failuresCount: 0 });
    expect(Object.keys(report!.real.byFamily as object).sort()).toEqual([...new Set(CORPUS.map(row => row.family))].sort());

    // Money: the run's own ledger, judge included.
    const spent = smartLedgerSpent(await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "real-1"));
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBe(result.spentMicroUsd);
  });

  it("no_card : une réponse attendue, aucune fiche ne couvre le besoin, l'agent passe la main → verdict no_card, tour réussi, compté", async () => {
    const verdicts: Verdicts = { ...OK_VERDICTS, decision: { verdict: "no_card", reason: "Aucune fiche ne couvre la demande, passer la main est correct." },
      grounded: { verdict: "sans_objet", reason: "Pas de réponse." }, answers_need: { verdict: "sans_objet", reason: "Pas de réponse." }, no_competitor_redirect: { verdict: "sans_objet", reason: "Pas de réponse." } };
    const decision = { outcome: "handoff", reply: null, teamNote: { raison: "no_source", besoin: "Aucune fiche sur ce point." }, handoffReason: "no_source", coverage: [{ needId: "n1", status: "handed" }], facts: [] };
    const net = network({ verdicts, decision }), logs: Array<[string, Record<string, unknown>]> = [];
    const result = await runSmartBenchSelfTestPass({ env: () => ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "real-nc" }), now: () => AT, network: net.fn, corpus: CORPUS.slice(0, 1),
      searchKnowledge, searchCatalogue: catalogue, log: (event, fields) => logs.push([event, fields]) });
    expect(result).toMatchObject({ ran: 1 });
    // The handoff turn is judged too (every turn, not only replies).
    expect(net.calls.filter(kind => kind === "judge")).toHaveLength(1);
    const line = logs.find(([event]) => event === "sav_smart_bench_real_turn")![1];
    expect(line).toMatchObject({ outcome: "passer_la_main", passed: true, judge: { verdicts: { decision: { verdict: "no_card" } } } });
    const report = aggregateSmartBenchSelfTest(await readSmartBenchSelfTestRows("real-nc"));
    expect(report.real).toMatchObject({ noCard: 1, passed: 1, failed: 0, byCriterion: { decision: { no_card: 1, ok: 0, echec: 0, rate: null } } });
  });

  it("un verdict echec fait échouer le tour et apparaît dans les échecs du rapport (codes seulement)", async () => {
    const verdicts: Verdicts = { ...OK_VERDICTS, grounded: { verdict: "echec", reason: "Le menu « Paramètres avancés » n'est dans aucune fiche." } };
    const net = network({ verdicts }), logs: Array<[string, Record<string, unknown>]> = [];
    await runSmartBenchSelfTestPass({ env: () => ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "real-ko" }), now: () => AT, network: net.fn, corpus: CORPUS.slice(0, 1),
      searchKnowledge, searchCatalogue: catalogue, log: (event, fields) => logs.push([event, fields]) });
    const report = aggregateSmartBenchSelfTest(await readSmartBenchSelfTestRows("real-ko"));
    expect(report.real).toMatchObject({ passed: 0, failed: 1, conversationsPassed: 0, byCriterion: { grounded: { echec: 1, rate: 0 } },
      failures: [{ conversationId: CORPUS[0]!.id, failed: ["grounded"], judgeProblem: null }] });
  });

  it("juge hors schéma : indéterminé (passed null), jamais ok", async () => {
    const net = network({ verdicts: { decision: { verdict: "ok", reason: "x" } } as Verdicts });
    await runSmartBenchSelfTestPass({ env: () => ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "real-off" }), now: () => AT, network: net.fn, corpus: CORPUS.slice(0, 1),
      searchKnowledge, searchCatalogue: catalogue, log: () => undefined });
    const rows = await readSmartBenchSelfTestRows("real-off");
    expect(rows[0]!.real).toMatchObject([{ passed: null, judge: { status: "failed", problem: "judge_off_schema" } }]);
    expect(aggregateSmartBenchSelfTest(rows).real).toMatchObject({ judgeFailures: 1, passed: 0, failed: 0 });
  });
});

describe("mode real : argent", () => {
  it("le claim couvre le pire cas juge compris : plafond = pire cas → joue ; pire cas − 1 → money_cap sans appel", async () => {
    const prices = smartPrices(ENV())!;
    const turns = CORPUS[0]!.turns.length;
    const worst = turns * (SAV_SMART_BENCH_NEW_CALLS + 1) * prices.modelReserve + turns * SAV_SMART_MAX_EMBED_CALLS * prices.embeddingReserve;
    const refused = network();
    expect(await runSmartBenchSelfTestPass({ env: () => ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "real-cap1", SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD: String(worst - 1) }), now: () => AT,
      network: refused.fn, corpus: CORPUS.slice(0, 1), searchKnowledge, searchCatalogue: catalogue, log: () => undefined })).toMatchObject({ ran: 0, stoppedBy: "money_cap" });
    expect(refused.calls).toEqual([]);
    const net = network();
    const result = await runSmartBenchSelfTestPass({ env: () => ENV({ SAV_V2_SMART_BENCH_SELFTEST_ID: "real-cap2", SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD: String(worst) }), now: () => AT,
      network: net.fn, corpus: CORPUS, searchKnowledge, searchCatalogue: catalogue, log: () => undefined });
    // The first conversation fits exactly; the second's claim would pass the cap with the first's reservation counted.
    expect(result).toMatchObject({ ran: 1 });
    if (!("ran" in result)) throw Error("not run");
    expect(net.calls).toContain("judge");
    expect(result.spentMicroUsd).toBeLessThanOrEqual(worst);
  });
});

describe("juge real : invite et garde des journaux", () => {
  it("la règle des concurrents : citer une autre application est permis, seule la redirection ou la concession est un échec", () => {
    const { instruction } = smartBenchRealJudgePrompt({ messages: [], agent: { outcome: "repondre", reply: "", handoffNote: null }, expected: ["repondre"], cards: [], now: "" });
    expect(SMART_BENCH_REAL_GRID.no_competitor_redirect).toContain("est PERMIS et n'est PAS un échec");
    expect(instruction).toContain("UNIQUEMENT de rediriger le client vers un concurrent");
    expect(instruction).toContain("concéder qu'un concurrent est meilleur (ex. « oui, GPT est meilleur »)");
    expect(instruction).toContain("no_card");
    expect(instruction).toContain("Ne recopie jamais le contenu d'une fiche");
  });

  it("le corps du juge reste sous la borne d'entrée : le contenu des fiches rétrécit, puis moins de fiches", () => {
    const cards = Array.from({ length: 8 }, (_, index) => ({ ...card(`c${index}-0000000000`, `Fiche ${index}`, ["n1"]), content: "x".repeat(5_000) }));
    const input = { messages: [{ from: "client" as const, text: "Bonjour", at: "" }], agent: { outcome: "repondre" as const, reply: "Voici.", handoffNote: null }, expected: ["repondre" as const], cards, now: "" };
    const full = smartBenchRealJudgeFittedBody(input, 1_000, undefined)!;
    const payload = JSON.parse(JSON.parse(full).contents[0].parts[0].text);
    expect(payload.fiches).toHaveLength(6);
    expect(payload.fiches[0].contenu.length).toBeLessThanOrEqual(2_000);
    const bounded = smartBenchRealJudgeFittedBody(input, 1_000, 8_000)!;
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(8_000);
    expect(smartBenchRealJudgeFittedBody(input, 1_000, 100)).toBeNull();
  });

  it("ligne par tour : jamais pour une conversation hors corpus fictif, et toujours sous 6 000 octets", () => {
    const conversation = CORPUS[0]!;
    const realTurn = { turn: 1, expected: ["repondre"], outcome: "repondre", failure: null, passed: true,
      judge: { status: "ok" as const, verdicts: Object.fromEntries(Object.entries(OK_VERDICTS).map(([key, value]) => [key, { ...value, reason: "r".repeat(400) }])) as never },
      cards: [{ id: "11111111", title: "Se connecter à Limova" }] };
    const stored = { runId: "x", agent: "real", agentRevision: "r", judgeRevision: "j", corpusRevision: "c", model: "m", codeSha: null, conversationId: conversation.id,
      costMicroUsd: 0, calls: 0, durationMs: 0, stopped: null, conversation: null,
      turns: [{ pass: 1, conversationId: conversation.id, family: conversation.family, turn: 1, expected: ["repondre"], sensitive: false, outcome: "repondre", reply: "é".repeat(6_000),
        codes: [], failure: null, checks: [], judge: null, verdict: { criteria: {}, passed: true, judgeContradicted: [] } }], real: [realTurn] } as unknown as SmartBenchStored;
    const capture = { customerMessage: "m".repeat(3_000), citations: [], handoffNote: "n".repeat(3_000) };
    expect(smartBenchRealTurnLine(stored, realTurn, { ...conversation }, capture)).toBeNull();
    const line = smartBenchRealTurnLine(stored, realTurn, conversation, capture)!;
    expect(Buffer.byteLength(JSON.stringify(line), "utf8")).toBeLessThanOrEqual(SMART_BENCH_TURN_DETAIL_MAX_BYTES);
    expect(line.cards).toEqual([{ id: "11111111", title: "Se connecter à Limova" }]);
  });

  it("sans ligne real, le rapport des autres modes n'a pas de clé real", () => {
    expect(aggregateSmartBenchSelfTest([])).not.toHaveProperty("real");
  });
});
