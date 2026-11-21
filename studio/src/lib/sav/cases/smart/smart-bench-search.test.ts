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
import type { SmartKnowledgePort } from "./smart-agent";
import { recordSmartKnowledge, type SmartBenchSearchCall } from "./smart-bench-search";
import { readSmartBenchSelfTestConfig, runSmartBenchSelfTestPass, SAV_SMART_BENCH_SELFTEST_PREFIX, type SmartBenchSelfTestDeps } from "./smart-bench-selftest";
import { readSmartLedger, smartLedgerSpent } from "./smart-ledger";
import { SMART_CONFORME, smartGoodDecision, smartReading } from "./smart-test-doubles";
import type { SmartSource } from "./smart-checks";

/*
 * Retrieval measurement (21/11): the « search only » mode of the bench self-test, on PGlite, the model and the embedding doubled at the network.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const AT = new Date("2026-11-21T10:00:00.000Z");
const ENV = (extra: Record<string, string> = {}) => ({ ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_SMART_BENCH_SELFTEST: "run", SAV_V2_SMART_BENCH_SELFTEST_ID: "search-1",
  SAV_V2_SMART_BENCH_SELFTEST_AGENT: "search", ...extra });
const CORPUS = SAV_BENCH_CORPUS.filter(conversation => !conversation.risky && conversation.turns.length === 1).slice(0, 2);
const card = (id: string, title: string, needIds: string[]): SmartSource => ({ cardId: id, version: "v1", title, content: `${title} : contenu.`, steps: [], needIds, validUntil: null });

function network() {
  const calls: string[] = [];
  const fn = async (url: string, init: RequestInit) => {
    if (!url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/")) throw Error(`UNEXPECTED_HOST ${url}`);
    const body = JSON.parse(String(init.body));
    if (url.endsWith(":batchEmbedContents")) {
      calls.push("embed");
      return Response.json({ embeddings: body.requests.map(() => ({ values: Array.from({ length: SAV_RETRIEVAL_EMBEDDING_DIMENSION }, () => 0.01) })) });
    }
    const system: string = body.systemInstruction?.parts?.[0]?.text ?? "";
    const kind = system.startsWith("Tu lis un mail") ? "understand" : system.startsWith("RELECTURE") ? "verify" : system ? "decide" : "judge";
    calls.push(kind);
    const output = kind === "understand" ? smartReading() : kind === "verify" ? SMART_CONFORME : { action: "final", calls: [], decision: smartGoodDecision() };
    return Response.json(accessSkillWireAnswer(output, { inputTokens: 1_000, outputTokens: 200 }));
  };
  return { fn, calls };
}
/** The « real » search doubled: it pays one embedding through the meter, then returns two cards for every need. */
const searchKnowledge: SmartBenchSelfTestDeps["searchKnowledge"] = embed => async needs => {
  const embedded = await embed(needs.map(need => need.search ?? need.ask));
  if (embedded.status !== "ok") return { status: "unavailable", sources: [], codes: ["embed_failed"] };
  const ids = needs.map(need => need.id);
  return { status: "ok", sources: [card("11111111-aaaa-4aaa-8aaa-111111111111", "Se connecter à Limova", ids), card("22222222-bbbb-4bbb-8bbb-222222222222", "Code non reçu", ids)], codes: [] };
};

beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-bench-fixture-key-32-chars!!!!!"); f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-bench-fixture-key-32-chars!!!!!");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("GLOBAL_NETWORK_FORBIDDEN"); }));
  state.db = f.db;
  await f.db.delete(savSyncState).where(like(savSyncState.key, `${SAV_SMART_BENCH_SELFTEST_PREFIX}:%`));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("mode « recherche seule » du banc", () => {
  it("l'interrupteur accepte search, jamais dans both", () => {
    const config = readSmartBenchSelfTestConfig(ENV());
    expect(config).toMatchObject({ mode: "run", agents: ["search"] });
    expect(readSmartBenchSelfTestConfig(ENV({ SAV_V2_SMART_BENCH_SELFTEST_AGENT: "both" }))).toMatchObject({ agents: ["current", "new"] });
  });

  it("vraie recherche (doublée) : catalogue une fois, chaque recherche notée par besoin et par rang, aucun juge, embeddings au tarif embedding", async () => {
    const net = network(), logs: Array<[string, Record<string, unknown>]> = [];
    const result = await runSmartBenchSelfTestPass({ env: () => ENV(), now: () => AT, network: net.fn, corpus: CORPUS, searchKnowledge,
      searchCatalogue: async () => [{ id: "11111111-aaaa-4aaa-8aaa-111111111111", title: "Se connecter à Limova", slug: "se-connecter" }],
      log: (event, fields) => logs.push([event, fields]) });
    expect(result).toMatchObject({ ran: CORPUS.length, stoppedBy: "done" });
    if (!("ran" in result)) throw Error("not run");
    expect(net.calls).not.toContain("judge");
    expect(net.calls.filter(kind => kind === "embed").length).toBeGreaterThanOrEqual(CORPUS.length);

    const catalogue = logs.filter(([event]) => event === "sav_smart_bench_search_catalogue");
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]![1]).toMatchObject({ runId: "search-1", count: 1, cards: [{ id: "11111111", title: "Se connecter à Limova", slug: "se-connecter" }] });

    const records = logs.filter(([event]) => event === "sav_smart_bench_search").map(([, fields]) => fields);
    expect(records.map(row => row.conversationId)).toEqual(CORPUS.map(row => row.id));
    const first = records[0] as { family: string; expected: string[]; turns: Array<{ turn: number; searches: SmartBenchSearchCall[] }> };
    expect(first.family).toBe(CORPUS[0]!.family);
    expect(first.expected).toEqual([...CORPUS[0]!.knowledge]);
    expect(first.turns[0]!.searches[0]).toMatchObject({ kind: "initial", status: "ok",
      needs: [{ id: "n1", ask: "se connecter à son espace", search: "connexion code non reçu" }],
      found: [{ needId: "n1", cards: [{ rank: 1, id: "11111111", title: "Se connecter à Limova" }, { rank: 2, id: "22222222", title: "Code non reçu" }] }] });

    // Money: the run's own ledger, nothing above the cap; model calls at their measured cost, embeddings at the embedding reservation.
    const spent = smartLedgerSpent(await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, "search-1"));
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBe(result.spentMicroUsd);
  });

  it("catalogue illisible : la passe continue et le dit", async () => {
    const net = network(), logs: Array<[string, Record<string, unknown>]> = [];
    const result = await runSmartBenchSelfTestPass({ env: () => ENV(), now: () => AT, network: net.fn, corpus: CORPUS.slice(0, 1), searchKnowledge,
      searchCatalogue: async () => { throw Error("db down"); }, log: (event, fields) => logs.push([event, fields]) });
    expect(result).toMatchObject({ ran: 1 });
    expect(logs.find(([event]) => event === "sav_smart_bench_search_catalogue")?.[1]).toEqual({ runId: "search-1", count: null, error: "catalogue_unreadable" });
  });
});

describe("enregistrement d'une recherche", () => {
  it("la première recherche d'un tour est « initial », les suivantes « tool » ; les fiches d'un besoin restent les siennes", async () => {
    const sink: SmartBenchSearchCall[] = [];
    const port: SmartKnowledgePort = async () => ({ status: "ok", codes: ["n1:found"], sources: [card("aaaaaaaa-1", "A", ["n1"]), card("bbbbbbbb-2", "B", ["n2"]), card("cccccccc-3", "C", ["n1", "n2"])] });
    const recorded = recordSmartKnowledge(port, sink);
    const needs = [{ id: "n1", ask: "a", alreadyDone: [], theme: null, search: "mots a" }, { id: "n2", ask: "b", alreadyDone: [], theme: null, search: "" }] as Parameters<SmartKnowledgePort>[0];
    await recorded(needs);
    await recorded(needs.slice(0, 1));
    expect(sink.map(call => call.kind)).toEqual(["initial", "tool"]);
    expect(sink[0]!.found).toEqual([
      { needId: "n1", cards: [{ rank: 1, id: "aaaaaaaa", title: "A" }, { rank: 2, id: "cccccccc", title: "C" }] },
      { needId: "n2", cards: [{ rank: 1, id: "bbbbbbbb", title: "B" }, { rank: 2, id: "cccccccc", title: "C" }] },
    ]);
  });
});
