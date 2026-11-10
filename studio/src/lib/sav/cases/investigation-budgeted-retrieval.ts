import { createHash } from "node:crypto";
import { SAV_RETRIEVAL_LIMITS, type SavRetrievalBackend, type SavRetrievalCandidate } from "../request-retrieval";
import type { CaseSnapshot } from "./case-types";
import type { CaseCallLedgerPort } from "./investigation-call-ledger";
import { selectCaseKnowledge, type CaseKnowledgeRead, type CaseKnowledgeRequestProblem, type CaseKnowledgeStop } from "./investigation-knowledge";
import { caseInvestigationAnalysisAllowed, SAV_CASE_INVESTIGATION_MAX_CALLS, ticketOwnerStop, type CaseInvestigationPorts } from "./investigation-runner";

/*
 * SAV-7/SAV-19, review K-COST1 (31/10): the knowledge search of a V2 investigation, with its embedding call paid only
 * through a budget. The SAV database backend (request-retrieval-db.ts) embeds the queries itself before any reservation,
 * so it is not used here: this adapter takes the vector search and the embedding transport as separate ports, and puts
 * the pause, the ticket owner, the case version, pole A's call ledger and ROOT's spend port BEFORE the transport, then
 * settles both after it. Local and OFF: nothing wires it; no transport, price or cap is defined here.
 *
 * Bounds first, before any read or cost, here in the search that may pay as well as at the runner port: the input key
 * is the runner's canonical `in|back:<event UUID>` (so no key can end in `.knowledge`), 1..3 queries of at most the
 * existing query size, the existing candidate limit, and a vector size within the index's. Out of bounds: a closed
 * reason, zero cost.
 *
 * The pause (positive allowlist, as the runner), the owner and the version are read before the search, then again after
 * each wait that may last: the ledger reservation, the spend answer, and the dispatch mark itself, the last time just
 * before the transport. A stop before the mark is a local cancellation: nothing was sent, so the ledger key and the spend
 * reservation are released. A stop after the mark (closed protocol): the transport is not called, the key is settled
 * uncertain and the spend settled unknown and uncertain; the mark stays as proof, nothing is released or reset, and the
 * input is verify-only from then on. A change after that last read is not seen (declared limit, not a compare-and-set).
 *
 * One embedding batch per search. Its call key lives under its own ledger subject next to the model's
 * (`sav-case:<caseId>:<inputKey>.knowledge`, purpose `knowledge_embedding`) so it never eats the model's calls, with
 * the same per-input ceiling. A settled batch for the same queries is reused at no cost; a dispatched batch whose
 * result is unknown is never sent again (verify-only), and nothing is released blindly.
 */

export const SAV_CASE_KNOWLEDGE_EMBEDDING_PURPOSE = "knowledge_embedding";
/** The index's vector size (SAV_RETRIEVAL_EMBEDDING_DIMENSION, request-retrieval-db.ts): no port may ask for more. */
export const SAV_CASE_KNOWLEDGE_MAX_DIMENSION = 768;
/** The input keys the runner makes: `in:` or `back:` and the case event's UUID. The only ones a paid search accepts. */
export const SAV_CASE_INPUT_KEY = /^(in|back):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The first bound a search breaks, or null. Pure: no read, no cost. */
export function caseKnowledgeRequestProblem(input: { inputKey: string; queries: readonly unknown[]; limit: number; dimension: number }): CaseKnowledgeRequestProblem | null {
  if (typeof input.inputKey !== "string" || !SAV_CASE_INPUT_KEY.test(input.inputKey)) return "input_key_invalid";
  if (input.queries.length > SAV_RETRIEVAL_LIMITS.queriesPerAttempt) return "query_count_invalid";
  if (input.queries.some(query => typeof query !== "string" || !query.trim() || query.length > SAV_RETRIEVAL_LIMITS.queryCharacters)) return "query_text_invalid";
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > SAV_RETRIEVAL_LIMITS.candidatesPerQuery) return "limit_invalid";
  if (!Number.isInteger(input.dimension) || input.dimension < 1 || input.dimension > SAV_CASE_KNOWLEDGE_MAX_DIMENSION) return "vector_dimension_invalid";
  return null;
}

/** What the embedding provider reports it billed. `null` (or nothing usable) when it reports nothing. */
export type CaseEmbeddingUsage = { inputTokens?: number; billableCharacters?: number };
export type CaseEmbeddingTransport = (input: { texts: readonly string[]; signal: AbortSignal; reservationId?: string }) => Promise<{ vectors: number[][]; usage: CaseEmbeddingUsage | null }>;
/**
 * How a dispatched embedding call is settled with ROOT. `usage`: what the provider reported, or `"unknown"` when it
 * reported nothing usable; `uncertain`: the call's result is unknown (timeout or error after dispatch). An unknown
 * usage keeps the reservation held as it was: never settled as free, never released, and the call is never resent.
 */
export type CaseEmbeddingSettlement = { reservationId: string; usage: CaseEmbeddingUsage | "unknown"; uncertain: boolean };
export type CaseEmbeddingSpendRequest = { purpose: typeof SAV_CASE_KNOWLEDGE_EMBEDDING_PURPOSE; callKey: string; caseId: string; caseVersion: number; texts: number; characters: number };
/**
 * ROOT's spend port for embedding calls (contract proposed in B's INTERFACE.md; none exists yet). `reserve` answers
 * before any call; `settle` once the call was dispatched (see CaseEmbeddingSettlement); `release` only when nothing
 * was sent. No price, cap or usage is defined here.
 */
export type CaseEmbeddingSpendPort = {
  reserve(request: CaseEmbeddingSpendRequest): Promise<{ status: "allowed"; reservationId: string } | { status: "refused"; reason: string }>;
  settle(input: CaseEmbeddingSettlement): Promise<void>;
  release(input: { reservationId: string }): Promise<void>;
};
/** The SAV vector search without its embedding: the same published, active, applicable cards, given the query vectors. */
export type CaseKnowledgeVectorSearch = {
  readRevision(): Promise<string>;
  /** Whether any SAV card is active at all: none means empty batches and no embedding call. */
  available(): Promise<boolean>;
  /** The vector size the index expects. */
  dimension: number;
  search(queries: readonly string[], vectors: readonly number[][], limit: number): Promise<SavRetrievalCandidate[][]>;
};

export type CaseBudgetedRetrievalDeps = {
  snapshot: CaseSnapshot;
  inputKey: string;
  holder: string;
  /** Lease of the ledger key, and the longest the transport may take before the call is held uncertain. */
  leaseSeconds: number;
  vectors: CaseKnowledgeVectorSearch;
  embed: CaseEmbeddingTransport;
  ledger: CaseCallLedgerPort;
  spend: CaseEmbeddingSpendPort;
} & Pick<CaseInvestigationPorts, "pauseState" | "readTicketOwner" | "readCase">;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A usage counts as reported only with at least one positive count and no invalid one; zero or nothing is not free. */
function reportedUsage(usage: unknown): CaseEmbeddingUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const counts = (["inputTokens", "billableCharacters"] as const).map(name => (usage as Record<string, unknown>)[name]).filter(value => value !== undefined);
  if (!counts.length || counts.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0) || !counts.some(value => (value as number) > 0)) return null;
  const { inputTokens, billableCharacters } = usage as CaseEmbeddingUsage;
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(billableCharacters === undefined ? {} : { billableCharacters }) };
}

/** The embedding subject of one input, beside the model's `sav-case:<caseId>:<inputKey>`. */
export const caseKnowledgeSubjectKey = (caseId: string, inputKey: string) => `sav-case:${caseId}:${inputKey}.knowledge`;

const usableVectors = (vectors: unknown, count: number, dimension: number): vectors is number[][] =>
  Array.isArray(vectors) && vectors.length === count
  && vectors.every(vector => Array.isArray(vector) && vector.length === dimension && vector.every(value => typeof value === "number" && Number.isFinite(value)));

class KnowledgeStopped extends Error {
  constructor() { super("SAV_CASE_KNOWLEDGE_STOPPED"); }
}

export function createCaseBudgetedRetrieval(deps: CaseBudgetedRetrievalDeps) {
  const { snapshot } = deps, caseId = snapshot.caseId, subjectKey = caseKnowledgeSubjectKey(caseId, deps.inputKey);
  let stopped: CaseKnowledgeStop | null = null, embeddingCalls = 0;
  // A stop is final for this search: the retrieval's own retry gets the same refusal, and nothing is asked again.
  const stop = (reason: CaseKnowledgeStop): never => { stopped ??= reason; throw new KnowledgeStopped(); };

  /** Pause, owner, version: the first reason to stop, or null. An unreadable or unknown pause level stops (fail closed). */
  async function check(): Promise<CaseKnowledgeStop | null> {
    let level: unknown = null;
    try { level = await deps.pauseState(); } catch { level = null; }
    if (typeof level !== "string" || !caseInvestigationAnalysisAllowed(level)) return { reason: "knowledge_paused" };
    const owner = await ticketOwnerStop(deps, snapshot);
    if (owner) return { reason: "knowledge_owner_stop", owner };
    const current = await deps.readCase(caseId);
    if (current?.snapshot.version !== snapshot.version) return { reason: "knowledge_stale", currentVersion: current?.snapshot.version ?? null };
    return null;
  }
  async function guard() {
    if (stopped) throw new KnowledgeStopped();
    const reason = await check();
    if (reason) stop(reason);
  }
  /**
   * The same check after the dispatch mark, just before the transport (closed protocol). Nothing is released: the key is
   * settled uncertain and the spend unknown and uncertain, and the transport is not called.
   */
  async function guardAfterMark(held: { callKey: string; token: string }, reservationId: string) {
    const keep = async () => {
      await deps.ledger.settle({ ...held, result: { status: "failed", uncertain: true } });
      await deps.spend.settle({ reservationId, usage: "unknown", uncertain: true });
    };
    let reason: CaseKnowledgeStop | null;
    try { reason = await check(); } catch (error) { await keep(); throw error; }
    if (reason) { await keep(); stop(reason); }
  }
  /**
   * The same check after a wait, before anything is sent. On a stop, or if the check itself fails, the call is cancelled
   * locally: nothing was dispatched, so the ledger key and, when granted, the spend reservation are released.
   */
  async function guardBeforeDispatch(held: { callKey: string; token: string }, reservationId: string | null) {
    const cancel = async () => {
      await deps.ledger.release(held);
      if (reservationId) await deps.spend.release({ reservationId });
    };
    let reason: CaseKnowledgeStop | null;
    try { reason = await check(); } catch (error) { await cancel(); throw error; }
    if (reason) { await cancel(); stop(reason); }
  }

  async function embedOnce(queries: readonly string[]): Promise<number[][]> {
    const queriesHash = hash(queries);
    for (let n = 1; n <= SAV_CASE_INVESTIGATION_MAX_CALLS; n++) {
      const callKey = `${subjectKey}:call${n}`;
      const reservation = await deps.ledger.reserve({ callKey, subjectKey, caseId, caseVersion: snapshot.version, purpose: SAV_CASE_KNOWLEDGE_EMBEDDING_PURPOSE,
        holder: deps.holder, leaseSeconds: deps.leaseSeconds, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS });
      if (reservation.status === "uncertain") return stop({ reason: "knowledge_usage_uncertain" });
      if (reservation.status === "busy") return stop({ reason: "knowledge_busy" });
      if (reservation.status === "subject_exhausted") return stop({ reason: "knowledge_calls_exhausted" });
      if (reservation.status === "known") {
        const output = reservation.result.status === "ok" ? reservation.result.output as { queriesHash?: unknown; vectors?: unknown } : null;
        // Paid already for these very queries: reused, after the same checks as a fresh answer; a stored batch that no
        // longer fits is an outage, never paid again. Another query set or a failed batch takes the next key.
        if (output?.queriesHash === queriesHash) {
          if (!usableVectors(output.vectors, queries.length, deps.vectors.dimension)) throw Error("SAV_CASE_EMBEDDING_STORED_INVALID");
          return output.vectors;
        }
        continue;
      }
      const held = { callKey, token: reservation.token };
      // The ledger reservation may have waited: checked again before asking for money.
      await guardBeforeDispatch(held, null);
      let allowed: Awaited<ReturnType<CaseEmbeddingSpendPort["reserve"]>> | null = null;
      try {
        allowed = await deps.spend.reserve({ purpose: SAV_CASE_KNOWLEDGE_EMBEDDING_PURPOSE, callKey, caseId, caseVersion: snapshot.version, texts: queries.length,
          characters: queries.reduce((sum, text) => sum + text.length, 0) });
      } catch { allowed = null; }
      if (allowed?.status !== "allowed") {
        await deps.ledger.release(held);
        return stop({ reason: "knowledge_budget_deferred", detail: allowed?.status === "refused" ? allowed.reason : "spend_unavailable" });
      }
      const reservationId = allowed.reservationId;
      // The spend answer may have waited: checked again, as close to the dispatch as this side can.
      await guardBeforeDispatch(held, reservationId);
      // From here the ledger key is never released: a mark that may have been stored stays. The transport is not called on a failed mark, so nothing can be billed: the money goes back.
      try { await deps.ledger.markDispatched(held); } catch (error) {
        try { await deps.spend.release({ reservationId }); } catch { /* stays held: conservative, and the mark's failure is what is reported */ }
        throw error;
      }
      // The mark is an awaited write too: checked again, immediately before the transport.
      await guardAfterMark(held, reservationId);
      embeddingCalls++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sent: Awaited<ReturnType<CaseEmbeddingTransport>> | null = null;
      try {
        sent = await Promise.race([
          deps.embed({ texts: queries, signal: controller.signal, reservationId }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("SAV_CASE_EMBEDDING_TIMEOUT")); }, deps.leaseSeconds * 1000); }),
        ]);
      } catch { sent = null; } finally { clearTimeout(timer); }
      if (!sent) {
        // Unknown result after dispatch: it may have been paid. Kept uncertain in both ledgers, never sent again.
        await deps.ledger.settle({ ...held, result: { status: "failed", uncertain: true } });
        await deps.spend.settle({ reservationId, usage: "unknown", uncertain: true });
        return stop({ reason: "knowledge_usage_uncertain" });
      }
      const vectors = sent.vectors;
      await deps.spend.settle({ reservationId, usage: reportedUsage(sent.usage) ?? "unknown", uncertain: false });
      if (!usableVectors(vectors, queries.length, deps.vectors.dimension)) {
        // Answered and paid, but unusable: a known failure, so the next search takes a new key within the ceiling.
        await deps.ledger.settle({ ...held, result: { status: "failed", uncertain: false } });
        throw Error("SAV_CASE_EMBEDDING_INVALID");
      }
      await deps.ledger.settle({ ...held, result: { status: "ok", output: { queriesHash, vectors } } });
      return vectors;
    }
    return stop({ reason: "knowledge_calls_exhausted" });
  }

  const backend: SavRetrievalBackend = {
    readRevision: () => deps.vectors.readRevision(),
    async search(queries, limit) {
      if (stopped) throw new KnowledgeStopped();
      const problem = caseKnowledgeRequestProblem({ inputKey: deps.inputKey, queries, limit, dimension: deps.vectors.dimension });
      if (problem) stop({ reason: "knowledge_request_invalid", problem });
      await guard();
      if (!queries.length) return [];
      // No active SAV card: nothing to search, nothing to pay. A failed check throws: an outage, never an absence.
      if (!(await deps.vectors.available())) return queries.map(() => []);
      const vectors = await embedOnce(queries);
      return deps.vectors.search(queries, vectors, limit);
    },
  };
  return { backend, stop: () => stopped, embeddingCalls: () => embeddingCalls };
}

/** The runner's `knowledge` port on the budgeted search: one budgeted backend per run, its stop surfaced as such. */
export function caseBudgetedKnowledge(deps: Omit<CaseBudgetedRetrievalDeps, "snapshot" | "inputKey"> & { scope: { locale: string; audience: "support" | "lead" }; now: () => Date }) {
  return async (snapshot: CaseSnapshot, context?: { inputKey: string }): Promise<CaseKnowledgeRead> => {
    // Without the input there is no ledger subject: nothing may be paid. Only the runner's canonical keys are accepted here.
    if (!context) return { status: "unavailable", reason: "search_unavailable" };
    if (!SAV_CASE_INPUT_KEY.test(context.inputKey)) return { status: "stopped", stop: { reason: "knowledge_request_invalid", problem: "input_key_invalid" } };
    const retrieval = createCaseBudgetedRetrieval({ ...deps, snapshot, inputKey: context.inputKey });
    const read = await selectCaseKnowledge(snapshot, retrieval.backend, { locale: deps.scope.locale, audience: deps.scope.audience, now: deps.now() });
    const stopped = retrieval.stop();
    if (stopped) return { status: "stopped", stop: stopped };
    // The embedding calls this search sent, so that a later stop of the run never reads as « no call ».
    return read.status === "ready" ? { ...read, embeddingCalls: retrieval.embeddingCalls() } : read;
  };
}
