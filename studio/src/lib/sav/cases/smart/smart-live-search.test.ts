import { describe, expect, it } from "vitest";
import type { SavRetrievalCandidate } from "../../request-retrieval";
import type { CaseSnapshot } from "../case-types";
import type { CaseEmbeddingSpendPort, CaseKnowledgeVectorSearch } from "../investigation-budgeted-retrieval";
import type { CaseCallLedgerPort } from "../investigation-call-ledger";
import type { CaseCustomerContext } from "../investigation-customer-context";
import type { SmartSource } from "./smart-checks";
import { smartCaseLiveSearch } from "./smart-knowledge";
import {
  createSmartLiveFoundRegistry, savV2SmartLiveSearchOn, smartContinuationSearchText, smartLiveKnowledge, type SmartLiveSearch, type SmartLiveSearchResult,
} from "./smart-live-search";

/*
 * Live search (26/11): `chercher_fiches` really searches in production (behind `SAV_V2_SMART_LIVE_SEARCH=on`). Fictional cards and words only: no database, no key,
 * no network. The end-to-end scenario through the real runner and validator is `smart-live-search.flow.test.ts`.
 */

const candidate = (id: string, version = "v1", content = "Procédure fictive."): SavRetrievalCandidate => ({
  id, contentVersionId: version, title: `Fiche ${id}`, content, source: "fixture", verifiedAt: "2026-11-20T00:00:00Z", semanticScore: null, resolution: { steps: ["Étape fictive"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
const sourceOf = (card: SavRetrievalCandidate, needIds = ["n1"]): SmartSource => ({ cardId: card.id, version: card.contentVersionId, title: card.title, content: card.content, steps: [], needIds, validUntil: null });
const CIRCUIT = candidate("fiche-migration-l3"), AGENT = candidate("fiche-agent-telephonique"), CHATBOT = candidate("fiche-chatbot");
const circuit = async (needs: readonly { id: string }[]) => ({ status: "ok" as const, sources: [{ ...sourceOf(CIRCUIT), needIds: needs.map(need => need.id) }], codes: ["circuit_cards"] });
const need = (query: string) => [{ id: "n1", ask: query, alreadyDone: [], theme: null, search: query }];
const found = (cards: SavRetrievalCandidate[]): SmartLiveSearchResult => ({ status: "ok", sources: cards.map(card => sourceOf(card)), cards, codes: ["n1:candidates"] });

describe("Live search: the switch", () => {
  it("only SAV_V2_SMART_LIVE_SEARCH=on (exactly) turns it on", () => {
    expect(savV2SmartLiveSearchOn({ SAV_V2_SMART_LIVE_SEARCH: "on" })).toBe(true);
    for (const value of [undefined, "", "ON", "true", "1", "shadow"]) expect(savV2SmartLiveSearchOn({ SAV_V2_SMART_LIVE_SEARCH: value })).toBe(false);
  });
});

describe("Live search, smartLiveKnowledge: the brain's port with live search", () => {
  it("the first call (initial search) gives the circuit's cards and never searches; a tool call searches with the model's words", async () => {
    const queries: string[] = [];
    const live = smartLiveKnowledge({ circuit, circuitCards: [CIRCUIT], search: async needs => { queries.push(needs[0]!.search!); return found([AGENT]); } });
    expect(await live.port(need("agents disparus"))).toMatchObject({ status: "ok", sources: [{ cardId: "fiche-migration-l3" }], codes: ["circuit_cards"] });
    expect(queries).toEqual([]);
    const tool = await live.port(need("recréer agent téléphonique Limova 3"));
    expect(queries).toEqual(["recréer agent téléphonique Limova 3"]);
    expect(tool).toMatchObject({ status: "ok", sources: [{ cardId: "fiche-agent-telephonique", needIds: ["n1"] }] });
    expect(tool.codes).toContain("live_search");
    expect(live.found().map(card => card.id)).toEqual(["fiche-agent-telephonique"]);
  });

  it("a card already in hand is never given twice (circuit card or earlier live card), and at most 3 new cards per search", async () => {
    const extra = [candidate("f-a"), candidate("f-b"), candidate("f-c"), candidate("f-d")];
    const answers = [found([CIRCUIT, AGENT]), found([AGENT, ...extra])];
    const live = smartLiveKnowledge({ circuit, circuitCards: [CIRCUIT], search: async () => answers.shift()! });
    await live.port(need("initial"));
    const first = await live.port(need("agent téléphonique"));
    expect(first.sources.map(row => row.cardId)).toEqual(["fiche-agent-telephonique"]);
    expect(first.codes).toContain("live_search_known_cards");
    const second = await live.port(need("autre recherche"));
    expect(second.sources.map(row => row.cardId)).toEqual(["f-a", "f-b", "f-c"]);
    expect(live.found().map(card => card.id)).toEqual(["fiche-agent-telephonique", "f-a", "f-b", "f-c"]);
  });

  it("bound: at most 2 live searches per turn; the next tool call gets the circuit's cards with `live_search_limit`, nothing searched", async () => {
    let searches = 0;
    const live = smartLiveKnowledge({ circuit, circuitCards: [CIRCUIT], search: async () => { searches += 1; return found([candidate(`f-${searches}`)]); } });
    await live.port(need("initial"));
    await live.port(need("recherche un"));
    await live.port(need("recherche deux"));
    const third = await live.port(need("recherche trois"));
    expect(searches).toBe(2);
    expect(third).toMatchObject({ status: "ok", sources: [{ cardId: "fiche-migration-l3" }] });
    expect(third.codes).toEqual(expect.arrayContaining(["circuit_cards", "live_search_limit"]));
  });

  it("timeout, failure and unavailable search: clean degradation to the circuit's cards (the old behaviour) with a closed code", async () => {
    const hanging: SmartLiveSearch = () => new Promise(() => undefined);
    const slow = smartLiveKnowledge({ circuit, circuitCards: [CIRCUIT], search: hanging, limits: { timeoutMs: 20 } });
    await slow.port(need("initial"));
    const timedOut = await slow.port(need("agent téléphonique"));
    expect(timedOut).toMatchObject({ status: "ok", sources: [{ cardId: "fiche-migration-l3" }] });
    expect(timedOut.codes).toContain("live_search_timeout");
    expect(slow.found()).toEqual([]);

    const failing = smartLiveKnowledge({ circuit, circuitCards: [CIRCUIT], search: async () => { throw Error("DOWN"); } });
    await failing.port(need("initial"));
    expect((await failing.port(need("agent téléphonique"))).codes).toContain("live_search_failed");

    const closed = smartLiveKnowledge({ circuit, circuitCards: [CIRCUIT], search: async () => ({ status: "unavailable", sources: [], cards: [], codes: ["live_knowledge_paused"] }) });
    await closed.port(need("initial"));
    const paused = await closed.port(need("agent téléphonique"));
    expect(paused.sources.map(row => row.cardId)).toEqual(["fiche-migration-l3"]);
    expect(paused.codes).toEqual(expect.arrayContaining(["live_search_unavailable", "live_knowledge_paused"]));
  });

  it("parallel tool calls are searched one at a time (one ledger subject per input)", async () => {
    let running = 0, peak = 0;
    const live = smartLiveKnowledge({ circuit, circuitCards: [CIRCUIT], search: async needs => {
      running += 1; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      return found([candidate(`f-${needs[0]!.search}`)]);
    } });
    await live.port(need("initial"));
    const results = await Promise.all([live.port(need("a-a")), live.port(need("b-b"))]);
    expect(peak).toBe(1);
    expect(results.map(row => row.sources[0]!.cardId)).toEqual(["f-a-a", "f-b-b"]);
  });
});

describe("Live search: the provider → runner registry", () => {
  it("gives each call's refs once, and stays bounded", () => {
    const registry = createSmartLiveFoundRegistry(2);
    registry.put("k1", [{ knowledgeId: "a", contentVersionId: "v1" }]);
    registry.put("k-empty", []);
    expect(registry.take("k1")).toEqual([{ knowledgeId: "a", contentVersionId: "v1" }]);
    expect(registry.take("k1")).toEqual([]);
    expect(registry.take("k-empty")).toEqual([]);
    for (const key of ["x", "y", "z"]) registry.put(key, [{ knowledgeId: key, contentVersionId: "v1" }]);
    expect(registry.take("x")).toEqual([]);
    expect(registry.take("z")).toEqual([{ knowledgeId: "z", contentVersionId: "v1" }]);
  });
});

describe("Live search: the first search of a continuation reads the exchange before the reply", () => {
  const context = (thread: Array<{ from: "customer" | "support"; text: string }>, latest = "Oui, les agents que j'avais créés.") => ({
    latestMessage: { at: "2026-11-26T09:00:00Z", from: "customer", text: latest, truncated: false, subject: "Re: Agents introuvables", instructionLikeText: false },
    thread: thread.map((row, index) => ({ at: `2026-11-2${index}T09:00:00Z`, truncated: false, ...row })),
  }) as unknown as CaseCustomerContext;

  it("latest reply, then our question, then the customer's message before it", () => {
    const words = smartContinuationSearchText(context([
      { from: "customer", text: "On ne retrouve plus nos agents créés depuis le passage à Limova 3." },
      { from: "support", text: "S'agit-il d'un agent téléphonique ou d'un chatbot ?" },
    ]))!;
    expect(words).toBe("Re: Agents introuvables Oui, les agents que j'avais créés. — S'agit-il d'un agent téléphonique ou d'un chatbot ? — On ne retrouve plus nos agents créés depuis le passage à Limova 3.");
  });

  it("no message of ours before the reply (a first mail): null, the circuit keeps its usual words; bounded to 600 characters, masked parts removed", () => {
    expect(smartContinuationSearchText(context([{ from: "customer", text: "Premier message." }]))).toBeNull();
    expect(smartContinuationSearchText(null)).toBeNull();
    const long = smartContinuationSearchText(context([{ from: "customer", text: "mot ".repeat(400) }, { from: "support", text: "question [email masqué] ".repeat(60) }], "réponse ".repeat(100)))!;
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long).not.toContain("masqué");
  });
});

describe("Live search, smartCaseLiveSearch: the same engine on the circuit's budgeted search", () => {
  const CASE = "10000000-0000-4000-8000-000000000001", INPUT = "in:20000000-0000-4000-8000-000000000001";
  const snapshot = { caseId: CASE, version: 4, owner: "agent", body: { openRequests: [] } } as unknown as CaseSnapshot;
  function doubles(options: { pause?: string; cards?: SavRetrievalCandidate[] } = {}) {
    const rows = new Map<string, { subjectKey: string; state: string; result?: { status: "ok"; output: unknown } | { status: "failed"; uncertain: boolean } }>();
    const keys: string[] = [], embedded: string[][] = [], spent: string[] = [];
    const ledger: CaseCallLedgerPort = {
      reserve: async input => {
        keys.push(input.callKey);
        const row = rows.get(input.callKey);
        if (row?.state === "settled") return row.result!.status === "ok" ? { status: "known", result: row.result! } : { status: "known", result: { status: "failed", uncertain: false } };
        if ([...rows.values()].filter(other => other.subjectKey === input.subjectKey).length >= (input.maxPerSubject ?? 3)) return { status: "subject_exhausted" };
        rows.set(input.callKey, { subjectKey: input.subjectKey, state: "reserved" });
        return { status: "reserved", token: "t", leaseUntil: "2026-11-26T10:00:00Z" };
      },
      markDispatched: async input => { rows.get(input.callKey)!.state = "dispatched"; },
      settle: async input => { Object.assign(rows.get(input.callKey)!, { state: "settled", result: input.result }); },
      release: async input => { rows.delete(input.callKey); },
    };
    const spend: CaseEmbeddingSpendPort = { reserve: async request => { spent.push(request.callKey); return { status: "allowed", reservationId: `r-${spent.length}` }; }, settle: async () => {}, release: async () => {} };
    const vectors: CaseKnowledgeVectorSearch = { dimension: 4, readRevision: async () => "kb-1", available: async () => true,
      search: async queries => queries.map(() => options.cards ?? [AGENT, CHATBOT]) };
    const search = smartCaseLiveSearch({ holder: "test", leaseSeconds: 5, vectors, ledger, spend, scope: { locale: "fr-FR", audience: "support" }, now: () => new Date("2026-11-26T09:00:00Z"),
      embed: async input => { embedded.push([...input.texts]); return { vectors: input.texts.map(() => [0.1, 0.2, 0.3, 0.4]), usage: { inputTokens: 8 } }; },
      pauseState: async () => (options.pause ?? "running") as never, readTicketOwner: async () => "v2", readCase: async () => ({ snapshot, events: [] }) });
    return { search: search({ snapshot, inputKey: INPUT }), keys, embedded, spent, rows };
  }

  it("embeds the model's words on the input's knowledge subject (V2 embedding budget), returns the original cards, and reuses a query already paid", async () => {
    const run = doubles();
    const result = await run.search(need("recréer agent téléphonique Limova 3"));
    expect(result.status).toBe("ok");
    expect(result.cards.map(card => card.id)).toEqual(expect.arrayContaining(["fiche-agent-telephonique"]));
    expect(result.cards.every(card => card.availability.published)).toBe(true);
    expect(run.embedded).toEqual([["recréer agent téléphonique Limova 3"]]);
    expect(run.keys[0]).toBe(`sav-case:${CASE}:${INPUT}.knowledge:call1`);
    expect(run.spent).toHaveLength(1);
    await run.search(need("recréer agent téléphonique Limova 3"));
    expect(run.embedded).toHaveLength(1);
  });

  it("at most 3 embeddings per input in all (the circuit's included): past it, unavailable with a closed code, nothing paid", async () => {
    const run = doubles();
    for (const query of ["un un", "deux deux", "trois trois"]) await run.search(need(query));
    const fourth = await run.search(need("quatre quatre"));
    expect(fourth).toMatchObject({ status: "unavailable", sources: [], codes: ["live_knowledge_calls_exhausted"] });
    expect(run.spent).toHaveLength(3);
  });

  it("the V2 pause is read before any embedding: nothing paid, a closed code", async () => {
    const run = doubles({ pause: "fully_paused" });
    expect(await run.search(need("agent téléphonique"))).toMatchObject({ status: "unavailable", codes: ["live_knowledge_paused"] });
    expect(run.embedded).toEqual([]);
    expect(run.spent).toEqual([]);
  });
});
