import type { SavRetrievalCandidate } from "../../request-retrieval";
import type { KnowledgeRef } from "../case-types";
import type { CaseCustomerContext } from "../investigation-customer-context";
import type { SmartKnowledgePort, SmartKnowledgeResult } from "./smart-agent";

/*
 * Live search (26/11, behind `SAV_V2_SMART_LIVE_SEARCH=on`): in production, `chercher_fiches` really searches with the words the model wrote.
 * Before, the production port (`smartCaseKnowledge`) gave back the circuit's first cards whatever the query (real case 26/11: « agents créés
 * depuis Limova 3 », the agent could not reach the card « agent téléphonique ou chatbot » and asked its question again).
 *
 * Same engine as the shadow and the bench (`retrieveSavKnowledgeByRequest`, `smartSourcesOf`: `smartCaseLiveSearch`, investigation-smart-live-search.ts), on the circuit's OWN search ports: the V2 vector
 * index (published, AI enabled, support audience, valid, not expired: the same filters as the first search), the V2 embedding budget and the call
 * ledger of the input (`createCaseBudgetedRetrieval`: pause, owner and case version read before every embedding, at most 3 embeddings per input in
 * all, a query already paid is reused at no cost). Never the model's reservation: no `reservationExceeded` from a search.
 * Bounds of one turn: 2 live searches, 3 new cards each, 8 s each (past it the turn goes on). A card already in hand is not given twice.
 * A failure, a timeout or the bound: the circuit's cards, as before, with a closed code in the trace (`live_search_*`).
 * The cards found are proven again by the runner at their exact version (`readScopeCards`) before the validator reads them.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_V2_SMART_LIVE_SEARCH_ENV = "SAV_V2_SMART_LIVE_SEARCH";
export const savV2SmartLiveSearchOn = (env: Env) => env[SAV_V2_SMART_LIVE_SEARCH_ENV] === "on";
export const SAV_SMART_LIVE_SEARCH_LIMITS = Object.freeze({ searchesPerTurn: 2, cardsPerSearch: 3, timeoutMs: 8_000, foundPerTurn: 6 });
/** The coverage limitation the runner adds when it adopts a card found by a live search. */
export const SAV_SMART_LIVE_SEARCH_LIMITATION = "smart_live_search";

export type SmartLiveSearchResult = SmartKnowledgeResult & Readonly<{ cards: readonly SavRetrievalCandidate[] }>;
export type SmartLiveSearch = (needs: Parameters<SmartKnowledgePort>[0]) => Promise<SmartLiveSearchResult>;

/**
 * The brain's knowledge port with live search: its first call (the turn's initial search) gives the circuit's cards, unchanged; each later call
 * (`chercher_fiches`) runs the live search within the turn's bounds. Live searches run one at a time (one ledger subject per input).
 */
export function smartLiveKnowledge(input: Readonly<{
  circuit: SmartKnowledgePort; circuitCards: readonly SavRetrievalCandidate[]; search: SmartLiveSearch;
  limits?: Partial<Readonly<Record<keyof typeof SAV_SMART_LIVE_SEARCH_LIMITS, number>>>;
}>): Readonly<{ port: SmartKnowledgePort; found: () => SavRetrievalCandidate[] }> {
  const limits = { ...SAV_SMART_LIVE_SEARCH_LIMITS, ...input.limits };
  const found: SavRetrievalCandidate[] = [];
  const held = (id: string, version: string) => [...input.circuitCards, ...found].some(card => card.id === id && card.contentVersionId === version);
  let calls = 0, searches = 0, queue: Promise<unknown> = Promise.resolve();
  const fallback = async (needs: Parameters<SmartKnowledgePort>[0], codes: readonly string[]): Promise<SmartKnowledgeResult> => {
    const base = await input.circuit(needs);
    return { ...base, codes: [...new Set([...base.codes, ...codes])] };
  };
  const live = async (needs: Parameters<SmartKnowledgePort>[0]): Promise<SmartKnowledgeResult> => {
    if (searches >= limits.searchesPerTurn) return fallback(needs, ["live_search_limit"]);
    searches += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: SmartLiveSearchResult | "timeout";
    try {
      result = await Promise.race([input.search(needs), new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), limits.timeoutMs); })]);
    } catch { return fallback(needs, ["live_search_failed"]); } finally { if (timer) clearTimeout(timer); }
    if (result === "timeout") return fallback(needs, ["live_search_timeout"]);
    if (result.status !== "ok") return fallback(needs, ["live_search_unavailable", ...result.codes]);
    const fresh = result.sources.filter(source => !held(source.cardId, source.version)).slice(0, limits.cardsPerSearch);
    for (const source of fresh) {
      const card = result.cards.find(row => row.id === source.cardId && row.contentVersionId === source.version);
      if (card && found.length < limits.foundPerTurn) found.push(card);
    }
    const kept = fresh.filter(source => found.some(card => card.id === source.cardId && card.contentVersionId === source.version));
    return { status: "ok", sources: kept, codes: [...new Set(["live_search", ...result.codes, ...(kept.length < result.sources.length ? ["live_search_known_cards"] : [])])] };
  };
  const port: SmartKnowledgePort = needs => {
    calls += 1;
    if (calls === 1) return input.circuit(needs);
    const next = queue.then(() => live(needs));
    queue = next.catch(() => undefined);
    return next;
  };
  return { port, found: () => [...found] };
}

/**
 * The live cards of each model call, from the provider to the runner of the SAME run (the provider writes, the runner takes once after the call).
 * Process memory only, bounded: a call whose runner never takes its entry is dropped first.
 */
export function createSmartLiveFoundRegistry(max = 32) {
  const entries = new Map<string, KnowledgeRef[]>();
  return {
    put: (callKey: string, refs: readonly KnowledgeRef[]) => {
      if (!refs.length) return;
      entries.delete(callKey);
      entries.set(callKey, refs.map(ref => ({ knowledgeId: ref.knowledgeId, contentVersionId: ref.contentVersionId })));
      while (entries.size > max) entries.delete(entries.keys().next().value!);
    },
    take: (callKey: string): KnowledgeRef[] => {
      const refs = entries.get(callKey) ?? [];
      entries.delete(callKey);
      return refs;
    },
  };
}

const clean = (value: string) => value.replace(/\[[^\]]{0,40}masqu[ée]e?s?\]/g, " ").replace(/\s+/g, " ").trim();
const SEARCH_CHARS = 600, PART_CHARS = 280;

/**
 * The circuit's « customer words » query on a continuation (a customer reply after our message): the latest mail, then our last message
 * (the question asked) and the customer's message before it, bounded to the search's 600 characters. No exchange before: null (the caller keeps
 * `caseCustomerSearchText`). The model still reads the whole thread; this only lets the first search find what the reply refers to.
 */
export function smartContinuationSearchText(context: CaseCustomerContext | null | undefined): string | null {
  const latest = context?.latestMessage, thread = context?.thread ?? [];
  if (!latest) return null;
  const lastSupport = thread.map(row => row.from).lastIndexOf("support");
  if (lastSupport < 0) return null;
  const before = thread.slice(0, lastSupport).filter(row => row.from === "customer").at(-1);
  const parts = [clean(`${latest.subject} ${latest.text}`).slice(0, PART_CHARS), clean(thread[lastSupport]!.text).slice(0, PART_CHARS),
    before ? clean(before.text).slice(0, PART_CHARS) : ""].filter(Boolean);
  const text = parts.join(" — ");
  const words = text.length <= SEARCH_CHARS ? text : text.slice(0, SEARCH_CHARS).replace(/\s+\S*$/, "");
  return words.length >= 3 ? words : null;
}
