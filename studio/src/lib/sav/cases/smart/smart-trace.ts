import type { CaseDecisionProposal } from "../decision-contract";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import type { SmartKnowledgePort, SmartTurnResult } from "./smart-agent";

/*
 * Trace of one REAL smart turn (Ugo, 22/11: « pour chaque tour réel, pouvoir relire ce que l'agent a compris, cherché, décidé et pourquoi »).
 * Recording only: built AFTER the turn, from what the turn already returned, and given to an injected sink (production: an encrypted row in
 * `sav.sync_state`, `smart-trace-store.ts`). Pure, no database, no network, no log. A recording failure is swallowed by the caller: the turn,
 * its proposal and its usage are never changed by it.
 * It holds customer-derived text (the needs, the proposed reply, the team note): it is stored encrypted with the case, never logged.
 */

export const SAV_SMART_TRACE_REVISION = 1;
export const SAV_SMART_TRACE_TOP = 6;
/** One stored trace stays under this size (the reply and the note are cut first). */
export const SAV_SMART_TRACE_MAX_BYTES = 40 * 1024;

const cut = (value: string | null | undefined, max: number) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cutKeep = (value: string | null | undefined, max: number) => (value ?? "").trim().slice(0, max);

export type SmartTraceCard = Readonly<{ rank: number; id: string; version: string; title: string }>;
export type SmartTraceSearch = Readonly<{
  kind: "initial" | "tool"; status: string; codes: readonly string[];
  /** Per need: the cards the search returned for it, in rank order (1 = first). */
  found: readonly Readonly<{ needId: string; cards: readonly SmartTraceCard[] }>[];
}>;
export type SmartCaseTrace = Readonly<{
  v: typeof SAV_SMART_TRACE_REVISION; caseId: string; inputKey: string; call: number; caseVersion: number; at: string;
  /** `turn`: the brain ran; `refused_twice`: the validator refused twice, no brain ran (the case goes to the team). */
  kind: "turn" | "refused_twice";
  outcome: string | null; sensitiveStop: string | null; reasons: readonly string[];
  needs: readonly Readonly<{ id: string; ask: string; search: string; theme: string | null }>[];
  searches: readonly SmartTraceSearch[];
  decision: Readonly<{ kind: "answer" | "ask" | "handoff" | "technical"; handoffReason: string | null; brainOutcome: string | null; brainHandoffReason: string | null; noteReason: string | null }>;
  cited: readonly Readonly<{ id: string; version: string; title: string }>[];
  replyProposed: string | null; question: string | null; teamNote: string | null;
  checks: Readonly<{ first: readonly string[] | null; second: readonly string[] | null }>;
  verdicts: Readonly<{ first: Readonly<{ verdict: string; problems: readonly string[] }> | null; second: Readonly<{ verdict: string; problems: readonly string[] }> | null }>;
  corrected: boolean;
  /** The validator's refusal codes this call was given (empty on a first call). */
  serverRefusals: readonly string[];
  calls: readonly Readonly<{ kind: string; status: string; problem: string | null; inputBytes: number; sent: boolean; uncertain: boolean; inputTokens: number | null; outputTokens: number | null }>[];
  modelCalls: number;
  tokens: Readonly<{ input: number; output: number }> | null;
  /** Filled by the store from V2's approved prices; null when a usage or the price is unknown. */
  costMicroUsd: number | null;
  tools: readonly Readonly<{ pass: number; tool: string; status: string; code: string | null }>[];
  missing: readonly Readonly<{ needId: string; theme: string | null }>[];
}>;
export type SmartCaseTraceSink = (trace: SmartCaseTrace) => Promise<void> | void;

/**
 * Wraps the knowledge port so each search is recorded (the first one is the initial search, the next ones are `chercher_fiches`). The port's
 * result is returned as is; the recording itself can never throw into the turn.
 */
export function traceSmartKnowledge(port: SmartKnowledgePort, sink: SmartTraceSearch[]): SmartKnowledgePort {
  return async needs => {
    const result = await port(needs);
    try {
      if (sink.length < 6) sink.push({
        kind: sink.length === 0 ? "initial" : "tool", status: result.status, codes: result.codes.slice(0, 12).map(code => cut(code, 60)),
        found: needs.slice(0, 9).map(need => ({ needId: need.id, cards: result.sources.filter(source => source.needIds.includes(need.id)).slice(0, SAV_SMART_TRACE_TOP)
          .map((source, index) => ({ rank: index + 1, id: cut(source.cardId, 80), version: cut(source.version, 80), title: cut(source.title, 160) })) })),
      });
    } catch { /* recording only */ }
    return result;
  };
}

type Request = Pick<CaseInvestigationModelRequest, "caseId" | "inputKey" | "call" | "caseVersion" | "feedback" | "knowledge">;

/** The trace of one turn (or of the second refusal, `result` null). Bounded: lists capped, texts cut, then the reply and note shortened to fit. */
export function buildSmartCaseTrace(input: Readonly<{ request: Request; result: SmartTurnResult | null; proposal: CaseDecisionProposal | null; searches: readonly SmartTraceSearch[]; at: Date }>): SmartCaseTrace {
  const { request, result, proposal } = input;
  const titleOf = (id: string, version: string) => cut(request.knowledge.find(card => card.id === id && card.contentVersionId === version)?.title ?? "", 160);
  const action = proposal?.nextAction ?? null;
  const decision = result?.decision ?? null;
  const verdict = (value: SmartTurnResult["verdicts"]["first"]) => value ? { verdict: value.verdict, problems: value.problems.map(problem => cut(problem.code, 60)).slice(0, 10) } : null;
  const calls = (result?.calls ?? []).slice(0, 8).map(call => ({ kind: call.kind, status: call.status, problem: call.problem ? cut(call.problem, 60) : null, inputBytes: call.inputBytes, sent: call.sent,
    uncertain: call.uncertain, inputTokens: call.usage?.inputTokens ?? null, outputTokens: call.usage?.outputTokens ?? null }));
  const sent = (result?.calls ?? []).filter(call => call.sent);
  const tokens = sent.every(call => call.usage) ? { input: sent.reduce((sum, call) => sum + call.usage!.inputTokens, 0), output: sent.reduce((sum, call) => sum + call.usage!.outputTokens, 0) } : null;
  const cited = proposal?.reply?.citations.length ? proposal.reply.citations : action?.kind === "handoff" ? action.report.knowledge : [];
  const trace: SmartCaseTrace = {
    v: SAV_SMART_TRACE_REVISION, caseId: request.caseId, inputKey: request.inputKey, call: request.call, caseVersion: request.caseVersion, at: input.at.toISOString(),
    kind: result ? "turn" : "refused_twice", outcome: result?.outcome ?? null, sensitiveStop: result?.sensitiveStop ?? null,
    reasons: (result?.reasons ?? []).slice(0, 40).map(reason => cut(reason, 80)),
    needs: (result?.reading?.needs ?? []).slice(0, 9).map(need => ({ id: need.id, ask: cut(need.ask, 300), search: cut(need.search, 240), theme: need.theme ? cut(need.theme, 80) : null })),
    searches: input.searches.slice(0, 6),
    decision: { kind: action ? action.kind === "answer" || action.kind === "ask" || action.kind === "handoff" ? action.kind : "technical" : "technical",
      handoffReason: action?.kind === "handoff" ? action.reason : null, brainOutcome: decision?.outcome ?? null, brainHandoffReason: decision?.handoffReason ?? null,
      noteReason: result?.teamNote?.raison ?? null },
    cited: cited.slice(0, 10).map(ref => ({ id: ref.knowledgeId, version: ref.contentVersionId, title: titleOf(ref.knowledgeId, ref.contentVersionId) })),
    replyProposed: proposal?.reply?.text ? cutKeep(proposal.reply.text, 6000) : null,
    question: action?.kind === "ask" ? cutKeep(action.questions[0]?.text, 600) || null : null,
    teamNote: result?.teamNoteText ? cutKeep(result.teamNoteText, 3000) : action?.kind === "handoff" ? cutKeep(action.report.need, 1000) || null : null,
    checks: { first: result?.checks.first ? [...result.checks.first] : null, second: result?.checks.second ? [...result.checks.second] : null },
    verdicts: { first: verdict(result?.verdicts.first ?? null), second: verdict(result?.verdicts.second ?? null) },
    corrected: result?.corrected ?? false,
    serverRefusals: [...new Set(request.feedback.map(row => cut(row.code, 80)))].slice(0, 20),
    calls, modelCalls: sent.length, tokens: result ? tokens : null, costMicroUsd: null,
    tools: (result?.steps ?? []).filter(step => step.kind === "tool").slice(0, 8).map(step => ({ pass: step.pass, tool: cut(step.tool, 60), status: cut(step.status, 40), code: step.code ? cut(step.code, 60) : null })),
    missing: (result?.missing ?? []).slice(0, 9).map(row => ({ needId: row.needId, theme: row.theme ? cut(row.theme, 80) : null })),
  };
  return fitSmartCaseTrace(trace);
}

/** Keeps a trace under `SAV_SMART_TRACE_MAX_BYTES`: shortens the reply, then the note, then drops the search details. Never throws. */
export function fitSmartCaseTrace(trace: SmartCaseTrace): SmartCaseTrace {
  const size = (value: SmartCaseTrace) => Buffer.byteLength(JSON.stringify(value), "utf8");
  let fitted = trace;
  for (const step of [
    (t: SmartCaseTrace) => ({ ...t, replyProposed: t.replyProposed ? t.replyProposed.slice(0, 2000) : null, teamNote: t.teamNote ? t.teamNote.slice(0, 1000) : null }),
    (t: SmartCaseTrace) => ({ ...t, searches: t.searches.map(search => ({ ...search, found: search.found.map(row => ({ needId: row.needId, cards: row.cards.slice(0, 3) })) })) }),
    (t: SmartCaseTrace) => ({ ...t, searches: [], reasons: t.reasons.slice(0, 10), calls: [] }),
  ]) {
    if (size(fitted) <= SAV_SMART_TRACE_MAX_BYTES) break;
    fitted = step(fitted);
  }
  return fitted;
}

/** A compact summary of a case's traces, without customer text: decision, handoff reason, fiches (ids and titles), check codes, calls, cost. */
export function summarizeSmartCaseTraces(traces: readonly SmartCaseTrace[]) {
  const last = [...traces].sort((a, b) => a.caseVersion - b.caseVersion || a.call - b.call || a.at.localeCompare(b.at)).at(-1);
  if (!last) return null;
  const fiches = new Map<string, { id: string; title: string }>();
  for (const trace of traces) for (const card of [...trace.cited, ...trace.searches.flatMap(search => search.found.flatMap(row => row.cards))]) if (!fiches.has(card.id)) fiches.set(card.id, { id: card.id, title: card.title });
  const known = traces.every(trace => trace.costMicroUsd !== null);
  return {
    turns: traces.length, lastDecision: last.decision.kind, lastOutcome: last.outcome, handoffReason: last.decision.handoffReason,
    cited: last.cited.map(card => ({ id: card.id, title: card.title })), fiches: [...fiches.values()].slice(0, 12),
    checkCodes: [...new Set(traces.flatMap(trace => [...(trace.checks.first ?? []), ...(trace.checks.second ?? []), ...(trace.verdicts.first?.problems ?? []), ...(trace.verdicts.second?.problems ?? [])]))].slice(0, 20),
    modelCalls: traces.reduce((sum, trace) => sum + trace.modelCalls, 0),
    costMicroUsd: known ? traces.reduce((sum, trace) => sum + (trace.costMicroUsd ?? 0), 0) : null,
  };
}
