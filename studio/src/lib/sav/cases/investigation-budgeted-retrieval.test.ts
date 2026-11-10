import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
import type { CaseRequestSubject, CaseSnapshot } from "./case-types";
import {
  caseBudgetedKnowledge, caseKnowledgeRequestProblem, caseKnowledgeSubjectKey, createCaseBudgetedRetrieval, SAV_CASE_KNOWLEDGE_EMBEDDING_PURPOSE,
  type CaseEmbeddingSpendPort, type CaseEmbeddingTransport, type CaseKnowledgeVectorSearch,
} from "./investigation-budgeted-retrieval";
import type { CaseCallLedgerPort } from "./investigation-call-ledger";
import type { CaseInvestigationPauseLevel, CaseInvestigationTicketOwner } from "./investigation-runner";

/*
 * Night 31/10, review K-COST1: the knowledge search pays its embedding call only through pole A's ledger and ROOT's spend
 * port, after the pause, the ticket owner and the case version. Synthetic ports only: no key, no SDK, no network; the
 * ledger double keeps pole A's rules (a dispatched key is never reserved again, a settled one is read back).
 */

const now = new Date("2026-10-30T12:00:00Z");
// The runner's canonical input key: `in:` and the case event's UUID.
const CASE = "10000000-0000-4000-8000-000000000001", INPUT = "in:20000000-0000-4000-8000-000000000001";
const card = (id: string, patch: Partial<SavRetrievalCandidate> = {}): SavRetrievalCandidate => ({
  id, contentVersionId: `${id}-v1`, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture", verifiedAt: "2026-10-20T00:00:00Z", semanticScore: null,
  resolution: { steps: ["Étape synthétique"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" }, ...patch,
});
const subject = (text: string): CaseRequestSubject => ({ status: "available", text, provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
  runId: "30000000-0000-4000-8000-000000000001", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: "2026-10-30T08:59:00Z" } });
const row = (id: string, text: string) => ({ id, summary: `Demande « support » relevée par l'analyse V1 du mail ${id}.`, family: "access", status: "open", openedAt: "2026-10-30T09:00:00Z", subject: subject(text) });
const snapshot = (version = 4, rows = [row("r1", "Connexion impossible."), row("r2", "Export des contacts en erreur.")]) =>
  ({ caseId: CASE, version, owner: "agent", body: { openRequests: rows } }) as unknown as CaseSnapshot;

type LedgerRow = { subjectKey: string; purpose: string; state: "reserved" | "dispatched" | "settled" | "released"; token: string; result?: { status: "ok"; output: unknown } | { status: "failed"; uncertain: boolean } };
/** Pole A's ledger rules (case-calls.ts), in memory. */
function ledgerDouble() {
  const rows = new Map<string, LedgerRow>(), log: string[] = [];
  let tokens = 0;
  const ledger: CaseCallLedgerPort = {
    reserve: async input => {
      log.push(`reserve:${input.callKey.split(":").at(-1)}`);
      const row = rows.get(input.callKey);
      if (row && row.purpose !== input.purpose) throw Error("SAV_CASE_CALL_KEY_CONFLICT");
      if (row?.state === "settled") return row.result!.status === "ok" ? { status: "known", result: row.result! } : row.result!.uncertain ? { status: "uncertain" } : { status: "known", result: { status: "failed", uncertain: false } };
      if (row?.state === "dispatched") return { status: "uncertain" };
      if (row?.state === "reserved") return { status: "busy", retryAt: now.toISOString() };
      if ([...rows.values()].filter(other => other.subjectKey === input.subjectKey && other.state !== "released").length >= (input.maxPerSubject ?? 3)) return { status: "subject_exhausted" };
      const token = `t${++tokens}`;
      rows.set(input.callKey, { subjectKey: input.subjectKey, purpose: input.purpose, state: "reserved", token });
      return { status: "reserved", token, leaseUntil: now.toISOString() };
    },
    markDispatched: async input => { log.push("dispatched"); rows.get(input.callKey)!.state = "dispatched"; },
    settle: async input => { log.push(`settle:${input.result.status}${input.result.status === "failed" && input.result.uncertain ? ":uncertain" : ""}`); Object.assign(rows.get(input.callKey)!, { state: "settled", result: input.result }); },
    release: async input => { log.push("release"); rows.get(input.callKey)!.state = "released"; },
  };
  return { ledger, rows, log };
}
function spendDouble(answer: "allowed" | "refused" | "throws" = "allowed") {
  const log: string[] = [], settled: unknown[] = [];
  const spend: CaseEmbeddingSpendPort = {
    reserve: async request => {
      log.push(`spend:${request.texts}/${request.characters}`);
      if (answer === "throws") throw Error("SPEND_DOWN");
      return answer === "allowed" ? { status: "allowed", reservationId: `res-${log.length}` } : { status: "refused", reason: "stop_paid" };
    },
    settle: async input => { settled.push(input); },
    release: async () => { log.push("spend-release"); },
  };
  return { spend, log, settled };
}
const DIM = 4;
function vectorsDouble(options: { cards?: SavRetrievalCandidate[]; available?: boolean | "throws"; revisions?: string[] } = {}) {
  const searched: { queries: string[]; vectors: number[][] }[] = [], revisions = [...(options.revisions ?? [])];
  const vectors: CaseKnowledgeVectorSearch = {
    dimension: DIM,
    readRevision: async () => revisions.length ? revisions.shift()! : "kb-r1",
    available: async () => { if (options.available === "throws") throw Error("INDEX_DOWN"); return options.available ?? true; },
    search: async (queries, given) => { searched.push({ queries: [...queries], vectors: given.map(v => [...v]) }); return queries.map(query => /connexion/i.test(query) ? options.cards ?? [card("k-login")] : []); },
  };
  return { vectors, searched };
}
/** Embedding transport double: a SYN vector per text, or a failure mode. Never a key, never the network. */
function embedDouble(mode: "ok" | "throws" | "hangs" | "bad_dimension" = "ok", usage: unknown = { inputTokens: 12 }) {
  const calls: string[][] = [];
  const embed: CaseEmbeddingTransport = async ({ texts, signal }) => {
    calls.push([...texts]);
    if (mode === "throws") throw Error("EMBEDDING_PROVIDER_DOWN");
    if (mode === "hangs") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Error("ABORTED"))));
    return { vectors: texts.map((_, index) => Array.from({ length: mode === "bad_dimension" ? DIM + 1 : DIM }, (__, j) => (index + 1) / (j + 2))), usage: usage as { inputTokens?: number } | null };
  };
  return { embed, calls };
}

function setup(options: { pause?: CaseInvestigationPauseLevel; owner?: CaseInvestigationTicketOwner | "absent" | "throws"; version?: number; spend?: "allowed" | "refused" | "throws"; embed?: "ok" | "throws" | "hangs" | "bad_dimension"; leaseSeconds?: number;
  vectors?: Parameters<typeof vectorsDouble>[0]; ledger?: ReturnType<typeof ledgerDouble>; usage?: unknown } = {}) {
  const l = options.ledger ?? ledgerDouble(), s = spendDouble(options.spend), v = vectorsDouble(options.vectors), e = embedDouble(options.embed, "usage" in options ? options.usage : { inputTokens: 12 });
  const owner = options.owner ?? "v2", reads: string[] = [];
  const deps = {
    holder: "sav-v2-investigation", leaseSeconds: options.leaseSeconds ?? 60, vectors: v.vectors, embed: e.embed, ledger: l.ledger, spend: s.spend,
    pauseState: async () => { reads.push("pause"); return options.pause ?? "running"; },
    ...(owner === "absent" ? {} : { readTicketOwner: async () => { reads.push("owner"); if (owner === "throws") throw Error("CRM_UNREADABLE"); return owner; } }),
    readCase: async () => { reads.push("case"); return { snapshot: snapshot(options.version ?? 4), events: [] }; },
  };
  // Rebuilt on each call, so that a test may replace a port of `deps` after setup.
  const knowledge: ReturnType<typeof caseBudgetedKnowledge> = (snap, context) => caseBudgetedKnowledge({ ...deps, scope: { locale: "fr-FR", audience: "support" }, now: () => now })(snap, context);
  return { deps, knowledge, l, s, v, e, reads };
}
const ZERO_PAID = (t: ReturnType<typeof setup>) => ({ embeddings: t.e.calls.length, spend: t.s.log.length, ledger: t.l.log.length, searched: t.v.searched.length });

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("budgeted knowledge search: the embedding call is reserved, gated and settled", () => {
  it("one embedding batch for the open requests: ledger reserve → spend → dispatched → transport → settle, then the vector search; coverage per request", async () => {
    const t = setup();
    const read = await t.knowledge(snapshot(), { inputKey: INPUT });
    expect(read).toMatchObject({ status: "ready", selection: { revision: "kb-r1", cards: [{ id: "k-login", contentVersionId: "k-login-v1" }],
      coverage: [{ requestId: "r1", status: "covered", knowledge: [{ knowledgeId: "k-login", contentVersionId: "k-login-v1" }] }, { requestId: "r2", status: "no_applicable_knowledge", knowledge: [] }] } });
    expect(t.e.calls).toEqual([["Connexion impossible.", "Export des contacts en erreur."]]);
    expect(t.l.log).toEqual(["reserve:call1", "dispatched", "settle:ok"]);
    expect(t.s.log).toEqual(["spend:2/51"]);
    expect(t.s.settled).toEqual([{ reservationId: "res-1", usage: { inputTokens: 12 }, uncertain: false }]);
    const [key] = [...t.l.rows.keys()];
    expect(key).toBe(`${caseKnowledgeSubjectKey(CASE, INPUT)}:call1`);
    expect(t.l.rows.get(key!)).toMatchObject({ purpose: SAV_CASE_KNOWLEDGE_EMBEDDING_PURPOSE, subjectKey: `sav-case:${CASE}:${INPUT}.knowledge` });
    // The vectors the index searched are exactly the ones paid for.
    expect(t.v.searched[0]!.vectors).toEqual((t.l.rows.get(key!)!.result as { output: { vectors: number[][] } }).output.vectors);
    expect(t.reads.slice(0, 3)).toEqual(["pause", "owner", "case"]);
  });

  it.each([
    ["the V2 full pause", { pause: "fully_paused" as const }, { reason: "knowledge_paused" }],
    ["a person owning the ticket", { owner: "human" as const }, { reason: "knowledge_owner_stop", owner: { reason: "ticket_owner_human", detail: "human" } }],
    ["no owner read wired", { owner: "absent" as const }, { reason: "knowledge_owner_stop", owner: { reason: "ticket_owner_unverified", detail: "owner_read_unavailable" } }],
    ["a failed owner read", { owner: "throws" as const }, { reason: "knowledge_owner_stop", owner: { reason: "ticket_owner_unverified", detail: "owner_read_failed" } }],
    ["a newer case version", { version: 5 }, { reason: "knowledge_stale", currentVersion: 5 }],
  ])("stops on %s: zero embedding, zero spend, zero ledger key, zero vector search", async (_name, options, stop) => {
    const t = setup(options);
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "stopped", stop });
    expect(ZERO_PAID(t)).toEqual({ embeddings: 0, spend: 0, ledger: 0, searched: 0 });
  });

  it.each([["refused (STOP paid, budget)", "refused" as const, "stop_paid"], ["unreachable", "throws" as const, "spend_unavailable"]])("spend %s: the ledger key is released, zero embedding", async (_name, spend, detail) => {
    const t = setup({ spend });
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "stopped", stop: { reason: "knowledge_budget_deferred", detail } });
    expect(t.e.calls).toEqual([]);
    expect(t.l.log).toEqual(["reserve:call1", "release"]);
    expect(t.v.searched).toEqual([]);
    // Released, so a later allowed search takes the same key without counting it twice.
    const again = setup({ ledger: t.l });
    expect(await again.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready" });
    expect(t.l.log.slice(2)).toEqual(["reserve:call1", "dispatched", "settle:ok"]);
  });

  it.each([["a transport error", "throws" as const, 60], ["a transport past the lease (timeout)", "hangs" as const, 1]])("%s after dispatch is uncertain in both ledgers and never sent again", async (_name, embed, leaseSeconds) => {
    const t = setup({ embed, leaseSeconds });
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "stopped", stop: { reason: "knowledge_usage_uncertain" } });
    expect(t.e.calls).toHaveLength(1);
    expect(t.l.log).toEqual(["reserve:call1", "dispatched", "settle:failed:uncertain"]);
    expect(t.s.settled).toEqual([{ reservationId: "res-1", usage: "unknown", uncertain: true }]);
    expect(t.v.searched).toEqual([]);
    // The next search finds the key uncertain: no transport, no spend, no other key.
    const again = setup({ ledger: t.l });
    expect(await again.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "stopped", stop: { reason: "knowledge_usage_uncertain" } });
    expect({ embeddings: again.e.calls.length, spend: again.s.log.length }).toEqual({ embeddings: 0, spend: 0 });
    expect(t.l.rows.size).toBe(1);
  }, 10_000);

  it.each([
    ["no usage", null], ["an empty usage", {}], ["a zero usage", { inputTokens: 0 }], ["a negative usage", { inputTokens: -3 }], ["a non-numeric usage", { inputTokens: "12" }],
  ])("a successful call with %s is settled unknown (reservation kept, never free); the vectors are used, nothing is sent again", async (_name, usage) => {
    const t = setup({ usage });
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready" });
    expect(t.s.settled).toEqual([{ reservationId: "res-1", usage: "unknown", uncertain: false }]);
    expect(t.s.log).toEqual(["spend:2/51"]);
    const again = setup({ ledger: t.l });
    await again.knowledge(snapshot(), { inputKey: INPUT });
    expect({ embeddings: again.e.calls.length, spend: again.s.log.length, settled: again.s.settled.length }).toEqual({ embeddings: 0, spend: 0, settled: 0 });
  });

  it("a batch already paid for the same queries is reused: no second transport call, no second spend", async () => {
    const t = setup();
    await t.knowledge(snapshot(), { inputKey: INPUT });
    const again = setup({ ledger: t.l });
    expect(await again.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready", selection: { coverage: [{ status: "covered" }, { status: "no_applicable_knowledge" }] } });
    expect({ embeddings: again.e.calls.length, spend: again.s.log.length }).toEqual({ embeddings: 0, spend: 0 });
  });

  it("the knowledge revision moving during the search: the retrieval's second attempt reuses the paid batch (one call counted)", async () => {
    const t = setup({ vectors: { revisions: ["kb-r1", "kb-r2", "kb-r2", "kb-r2"] } });
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready", selection: { revision: "kb-r2" } });
    expect(t.e.calls).toHaveLength(1);
    expect(t.v.searched).toHaveLength(2);
    expect(t.l.log).toEqual(["reserve:call1", "dispatched", "settle:ok", "reserve:call1"]);
  });

  it("other queries for the same input take the next key; past the per-input ceiling nothing is sent", async () => {
    const t = setup();
    await t.knowledge(snapshot(), { inputKey: INPUT });
    const other = setup({ ledger: t.l });
    await other.knowledge(snapshot(4, [row("r3", "Connexion au tableau de bord refusée.")]), { inputKey: INPUT });
    expect(other.e.calls).toHaveLength(1);
    const third = setup({ ledger: t.l });
    await third.knowledge(snapshot(4, [row("r4", "Connexion mobile impossible.")]), { inputKey: INPUT });
    const fourth = setup({ ledger: t.l });
    expect(await fourth.knowledge(snapshot(4, [row("r5", "Connexion bloquée après mise à jour.")]), { inputKey: INPUT })).toEqual({ status: "stopped", stop: { reason: "knowledge_calls_exhausted" } });
    expect({ embeddings: fourth.e.calls.length, spend: fourth.s.log.length }).toEqual({ embeddings: 0, spend: 0 });
    expect([...t.l.rows.keys()].map(key => key.split(":").at(-1))).toEqual(["call1", "call2", "call3"]);
  });

  it("an answer of the wrong size is paid (spend settled with its usage) but unusable: a technical outage, never an absence of knowledge", async () => {
    const t = setup({ embed: "bad_dimension" });
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "unavailable", reason: "search_unavailable" });
    expect(t.s.settled).toEqual([{ reservationId: "res-1", usage: { inputTokens: 12 }, uncertain: false }]);
    expect(t.l.log.slice(0, 3)).toEqual(["reserve:call1", "dispatched", "settle:failed"]);
    expect(t.v.searched).toEqual([]);
  });

  it("no active SAV card: empty batches with no embedding call; an unreadable index is an outage, not an absence", async () => {
    const none = setup({ vectors: { available: false } });
    expect(await none.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready", selection: { coverage: [{ status: "no_applicable_knowledge" }, { status: "no_applicable_knowledge" }] } });
    expect(ZERO_PAID(none)).toEqual({ embeddings: 0, spend: 0, ledger: 0, searched: 0 });
    const down = setup({ vectors: { available: "throws" } });
    expect(await down.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "unavailable", reason: "search_unavailable" });
    expect(ZERO_PAID(down)).toEqual({ embeddings: 0, spend: 0, ledger: 0, searched: 0 });
  });

  it("a card found but too large to be read whole is not « no applicable knowledge »: not searched, with the reason", async () => {
    const t = setup({ vectors: { cards: [card("k-big", { content: "", sourceTooLarge: true })] } });
    const read = await t.knowledge(snapshot(), { inputKey: INPUT });
    expect(read).toMatchObject({ status: "ready", selection: { cards: [], coverage: [
      { requestId: "r1", status: "not_searched", knowledge: [], limitations: expect.arrayContaining(["knowledge_source_incomplete"]) },
      { requestId: "r2", status: "no_applicable_knowledge" }] } });
  });

  it("without the input key there is no ledger subject: nothing is read or paid", async () => {
    const t = setup();
    expect(await t.knowledge(snapshot())).toEqual({ status: "unavailable", reason: "search_unavailable" });
    expect(ZERO_PAID(t)).toEqual({ embeddings: 0, spend: 0, ledger: 0, searched: 0 });
    expect(t.reads).toEqual([]);
  });

  it("a stop is final for the search: the retrieval's retry asks nothing again", async () => {
    const t = setup({ pause: "fully_paused" });
    const retrieval = createCaseBudgetedRetrieval({ ...t.deps, snapshot: snapshot(), inputKey: INPUT });
    await expect(retrieval.backend.search(["Connexion impossible."], 3)).rejects.toThrow("SAV_CASE_KNOWLEDGE_STOPPED");
    await expect(retrieval.backend.search(["Connexion impossible."], 3)).rejects.toThrow("SAV_CASE_KNOWLEDGE_STOPPED");
    expect(t.reads).toEqual(["pause"]);
    expect(retrieval.embeddingCalls()).toBe(0);
  });
});

describe("review BR1/BR2 (31/10): checked again after every wait, cancelled locally before dispatch, never released after it", () => {
  type Change = "human" | "throws" | "fully_paused" | "invalid_pause" | "pause_throws" | "version" | "case_throws";
  /** Applies one change the moment `wait` answers (ledger reservation or spend answer). */
  function changing(wait: "ledger" | "spend", change: Change) {
    const t = setup();
    let owner: CaseInvestigationTicketOwner | "throws" = "v2", pause: unknown = "running", version = 4, caseThrows = false;
    t.deps.readTicketOwner = async () => { if (owner === "throws") throw Error("CRM_UNREADABLE"); return owner; };
    t.deps.pauseState = async () => { if (pause === "throws") throw Error("PAUSE_UNREADABLE"); return pause as CaseInvestigationPauseLevel; };
    t.deps.readCase = async () => { if (caseThrows) throw Error("CASE_UNREADABLE"); return { snapshot: snapshot(version), events: [] }; };
    const apply = () => {
      if (change === "human" || change === "throws") owner = change;
      else if (change === "fully_paused") pause = "fully_paused";
      else if (change === "invalid_pause") pause = "invalid";
      else if (change === "pause_throws") pause = "throws";
      else if (change === "version") version = 5;
      else caseThrows = true;
    };
    if (wait === "ledger") { const reserve = t.l.ledger.reserve; t.l.ledger.reserve = async input => { const answer = await reserve(input); apply(); return answer; }; }
    else { const reserve = t.s.spend.reserve; t.s.spend.reserve = async input => { const answer = await reserve(input); apply(); return answer; }; }
    return t;
  }
  const changes: [Change, unknown][] = [
    ["human", { status: "stopped", stop: { reason: "knowledge_owner_stop", owner: { reason: "ticket_owner_human", detail: "human" } } }],
    ["throws", { status: "stopped", stop: { reason: "knowledge_owner_stop", owner: { reason: "ticket_owner_unverified", detail: "owner_read_failed" } } }],
    ["fully_paused", { status: "stopped", stop: { reason: "knowledge_paused" } }],
    ["invalid_pause", { status: "stopped", stop: { reason: "knowledge_paused" } }],
    ["pause_throws", { status: "stopped", stop: { reason: "knowledge_paused" } }],
    ["version", { status: "stopped", stop: { reason: "knowledge_stale", currentVersion: 5 } }],
    ["case_throws", { status: "unavailable", reason: "search_unavailable" }],
  ];
  it.each(changes)("%s while the ledger reservation waits: zero embedding, no spend asked, the undispatched key released", async (change, read) => {
    const t = changing("ledger", change);
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual(read);
    expect({ embeddings: t.e.calls.length, spend: t.s.log.length, settled: t.s.settled.length }).toEqual({ embeddings: 0, spend: 0, settled: 0 });
    expect(t.l.log).toEqual(["reserve:call1", "release"]);
  });
  it.each(changes)("%s while the spend answer waits: zero embedding, the undispatched key and the spend reservation both released", async (change, read) => {
    const t = changing("spend", change);
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual(read);
    expect({ embeddings: t.e.calls.length, settled: t.s.settled.length }).toEqual({ embeddings: 0, settled: 0 });
    expect(t.l.log).toEqual(["reserve:call1", "release"]);
    expect(t.s.log).toEqual(["spend:2/51", "spend-release"]);
    // Released as never sent: a later allowed search takes the same key, without any uncertain left behind.
    const again = setup({ ledger: t.l });
    expect(await again.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready" });
    expect(again.e.calls).toHaveLength(1);
  });
  it.each([["an unknown level", "invalid"], ["an unreadable level", "throws"]])("%s of the pause before the search stops it (fail closed, as the runner)", async (_name, level) => {
    const t = setup();
    t.deps.pauseState = async () => { if (level === "throws") throw Error("PAUSE_UNREADABLE"); return level as CaseInvestigationPauseLevel; };
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "stopped", stop: { reason: "knowledge_paused" } });
    expect(ZERO_PAID(t)).toEqual({ embeddings: 0, spend: 0, ledger: 0, searched: 0 });
  });
  it("actions paused still lets the analysis search, as the runner does", async () => {
    const t = setup({ pause: "actions_paused" });
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready" });
  });
  it("a failed dispatch mark: no transport, so the money goes back; the key stays held and the next search pays nothing", async () => {
    const t = setup();
    t.l.ledger.markDispatched = async () => { t.l.log.push("mark-failed"); throw Error("MARK_LOST"); };
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "unavailable", reason: "search_unavailable" });
    expect(t.e.calls).toEqual([]);
    expect(t.l.log).toEqual(["reserve:call1", "mark-failed"]);
    expect(t.s.log).toEqual(["spend:2/51", "spend-release"]);
    const again = setup({ ledger: t.l });
    expect(await again.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "stopped", stop: { reason: "knowledge_busy" } });
    expect({ embeddings: again.e.calls.length, spend: again.s.log.length }).toEqual({ embeddings: 0, spend: 0 });
  });
  it("a ledger settlement lost after a paid answer: the key stays dispatched, the next search is uncertain and pays nothing", async () => {
    const t = setup();
    t.l.ledger.settle = async () => { throw Error("SETTLE_LOST"); };
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "unavailable", reason: "search_unavailable" });
    expect(t.e.calls).toHaveLength(1);
    expect(t.s.settled).toEqual([{ reservationId: "res-1", usage: { inputTokens: 12 }, uncertain: false }]);
    const again = setup({ ledger: t.l });
    expect(await again.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "stopped", stop: { reason: "knowledge_usage_uncertain" } });
    expect({ embeddings: again.e.calls.length, spend: again.s.log.length }).toEqual({ embeddings: 0, spend: 0 });
  });
  it("a stored batch that no longer fits (size, value) is an outage: nothing is paid again", async () => {
    const t = setup();
    await t.knowledge(snapshot(), { inputKey: INPUT });
    const row = [...t.l.rows.values()][0]!;
    (row.result as { output: { vectors: unknown[] } }).output.vectors = [[1, 2], [3, Number.NaN]];
    const again = setup({ ledger: t.l });
    expect(await again.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "unavailable", reason: "search_unavailable" });
    expect({ embeddings: again.e.calls.length, spend: again.s.log.length, searched: again.v.searched.length }).toEqual({ embeddings: 0, spend: 0, searched: 0 });
  });
  it("the embedding calls a search sent are reported with its result", async () => {
    const t = setup();
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready", embeddingCalls: 1 });
    const again = setup({ ledger: t.l });
    expect(await again.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready", embeddingCalls: 0 });
  });
});

describe("night 31/10 lot 3: bounds before any cost, and the dispatch mark checked as a wait (review B2 R4/R5, A §5)", () => {
  it.each([
    ["no prefix", "gm-1"], ["another prefix", "out:20000000-0000-4000-8000-000000000001"], ["not a UUID", "in:gm-1"],
    ["a .knowledge suffix", "in:20000000-0000-4000-8000-000000000001.knowledge"], ["an upper-case UUID", "in:20000000-0000-4000-8000-00000000000A"], ["empty", ""],
  ])("the runner port refuses an input key with %s: closed reason, nothing read or paid", async (_name, inputKey) => {
    const t = setup();
    expect(await t.knowledge(snapshot(), { inputKey })).toEqual({ status: "stopped", stop: { reason: "knowledge_request_invalid", problem: "input_key_invalid" } });
    expect(ZERO_PAID(t)).toEqual({ embeddings: 0, spend: 0, ledger: 0, searched: 0 });
    expect(t.reads).toEqual([]);
  });
  it.each([
    ["a dotted key (could end in .knowledge)", { inputKey: "in:gm-1.knowledge" }, "input_key_invalid"],
    ["a non-UUID key", { inputKey: "in:gm-1" }, "input_key_invalid"],
    ["a UUID key with a .knowledge suffix", { inputKey: `${INPUT}.knowledge` }, "input_key_invalid"],
    ["four queries", { queries: ["q1", "q2", "q3", "q4"] }, "query_count_invalid"],
    ["a blank query", { queries: ["  "] }, "query_text_invalid"],
    ["a query past the existing 900 characters", { queries: ["x".repeat(901)] }, "query_text_invalid"],
    ["a limit past the existing 24", { limit: 25 }, "limit_invalid"],
    ["a fractional limit", { limit: 2.5 }, "limit_invalid"],
    ["a vector size past the index's 768", { dimension: 769 }, "vector_dimension_invalid"],
    ["a zero vector size", { dimension: 0 }, "vector_dimension_invalid"],
  ] as const)("the search refuses %s before any read or cost", async (_name, patch, problem) => {
    const t = setup();
    const inputKey = "inputKey" in patch ? patch.inputKey : INPUT, queries = "queries" in patch ? patch.queries : ["Connexion impossible."], limit = "limit" in patch ? patch.limit : 3;
    if ("dimension" in patch) (t.deps.vectors as { dimension: number }).dimension = patch.dimension;
    const retrieval = createCaseBudgetedRetrieval({ ...t.deps, snapshot: snapshot(), inputKey });
    await expect(retrieval.backend.search(queries, limit)).rejects.toThrow("SAV_CASE_KNOWLEDGE_STOPPED");
    expect(retrieval.stop()).toEqual({ reason: "knowledge_request_invalid", problem });
    expect(ZERO_PAID(t)).toEqual({ embeddings: 0, spend: 0, ledger: 0, searched: 0 });
    expect(t.reads).toEqual([]);
  });
  it("in bounds: a canonical key, three queries of 900 characters, the 24 limit, the index's 768 size", () => {
    expect(caseKnowledgeRequestProblem({ inputKey: INPUT, queries: ["x".repeat(900), "y", "z"], limit: 24, dimension: 768 })).toBeNull();
    expect(caseKnowledgeRequestProblem({ inputKey: "back:20000000-0000-4000-8000-000000000002", queries: [], limit: 1, dimension: 1 })).toBeNull();
  });

  type Change = "human" | "throws" | "fully_paused" | "invalid_pause" | "version" | "case_throws";
  it.each([
    ["human", { status: "stopped", stop: { reason: "knowledge_owner_stop", owner: { reason: "ticket_owner_human", detail: "human" } } }],
    ["throws", { status: "stopped", stop: { reason: "knowledge_owner_stop", owner: { reason: "ticket_owner_unverified", detail: "owner_read_failed" } } }],
    ["fully_paused", { status: "stopped", stop: { reason: "knowledge_paused" } }],
    ["invalid_pause", { status: "stopped", stop: { reason: "knowledge_paused" } }],
    ["version", { status: "stopped", stop: { reason: "knowledge_stale", currentVersion: 5 } }],
    ["case_throws", { status: "unavailable", reason: "search_unavailable" }],
  ] as [Change, unknown][])("%s while the dispatch mark is written: no transport; the mark kept, the key uncertain, the spend unknown; nothing released, nothing paid later", async (change, read) => {
    const t = setup();
    let owner: CaseInvestigationTicketOwner | "throws" = "v2", pause: unknown = "running", version = 4, caseThrows = false;
    t.deps.readTicketOwner = async () => { if (owner === "throws") throw Error("CRM_UNREADABLE"); return owner; };
    t.deps.pauseState = async () => pause as CaseInvestigationPauseLevel;
    t.deps.readCase = async () => { if (caseThrows) throw Error("CASE_UNREADABLE"); return { snapshot: snapshot(version), events: [] }; };
    const mark = t.l.ledger.markDispatched;
    t.l.ledger.markDispatched = async input => {
      await mark(input);
      if (change === "human" || change === "throws") owner = change;
      else if (change === "fully_paused") pause = "fully_paused";
      else if (change === "invalid_pause") pause = "invalid";
      else if (change === "version") version = 5;
      else caseThrows = true;
    };
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toEqual(read);
    expect(t.e.calls).toEqual([]);
    expect(t.l.log).toEqual(["reserve:call1", "dispatched", "settle:failed:uncertain"]);
    expect(t.s.log).toEqual(["spend:2/51"]);
    expect(t.s.settled).toEqual([{ reservationId: "res-1", usage: "unknown", uncertain: true }]);
    const again = setup({ ledger: t.l });
    expect(await again.knowledge(snapshot(), { inputKey: INPUT })).toEqual({ status: "stopped", stop: { reason: "knowledge_usage_uncertain" } });
    expect({ embeddings: again.e.calls.length, spend: again.s.log.length }).toEqual({ embeddings: 0, spend: 0 });
  });
  it("witness: nothing changes during the mark, the batch goes and is settled as before", async () => {
    const t = setup();
    expect(await t.knowledge(snapshot(), { inputKey: INPUT })).toMatchObject({ status: "ready", embeddingCalls: 1 });
    expect(t.l.log).toEqual(["reserve:call1", "dispatched", "settle:ok"]);
  });
});
