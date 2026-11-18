import type { CorpusCase, RequestRoute } from "./corpus-contract";

type QualificationCase = Pick<CorpusCase, "id" | "group" | "requests">;

export type QualificationCaseResult = Readonly<{
  caseId: string;
  status: "complete" | "incomplete";
  /** Effective routes, including any already observed on an incomplete case. */
  requests: readonly Readonly<{ requestId: string; route: RequestRoute }>[];
}>;

type Rate = Readonly<{ hits: number; total: number }>;

export type QualificationVerdict = Readonly<{
  status: "pass" | "fail" | "incomplete";
  complete: boolean;
  budgetExhausted: boolean;
  cases: Readonly<{ completed: number; total: number }>;
  sensitive: Readonly<{ admitted: number; total: number; admittedCaseIds: readonly string[] }>;
  neighbourRouting: Rate;
  blockRecall: Rate;
  traps: Rate;
  failedCaseIds: readonly string[];
  incompleteCaseIds: readonly string[];
  unexpectedCaseIds: readonly string[];
}>;

function matchesRoute(actual: RequestRoute | undefined, expected: RequestRoute): boolean {
  return actual?.kind === expected.kind && (expected.kind !== "block" || (actual.kind === "block" && actual.blockId === expected.blockId));
}

/** Neighbours and traps are scored per mail. Recall is scored per expected request for this block. */
export function qualificationVerdict(input: Readonly<{
  blockId: string;
  cases: readonly QualificationCase[];
  results: readonly QualificationCaseResult[];
  budgetExhausted: boolean;
}>): QualificationVerdict {
  const cases = new Map<string, QualificationCase>();
  const incomplete = new Set<string>();
  for (const testCase of input.cases) {
    if (cases.has(testCase.id)) incomplete.add(testCase.id);
    cases.set(testCase.id, testCase);
  }

  const results = new Map<string, QualificationCaseResult>();
  const unexpected = new Set<string>();
  const outsideTeam = new Set<string>();
  for (const result of input.results) {
    if (!cases.has(result.caseId)) {
      unexpected.add(result.caseId);
      continue;
    }
    if (results.has(result.caseId)) incomplete.add(result.caseId);
    results.set(result.caseId, result);
    if (result.requests.some(request => request.route.kind !== "team")) outsideTeam.add(result.caseId);
  }

  const neighbourRouting = { hits: 0, total: 0 };
  const blockRecall = { hits: 0, total: 0 };
  const traps = { hits: 0, total: 0 };
  const failed = new Set<string>();
  const sensitiveAdmitted = new Set<string>();
  let completed = 0;
  let sensitiveTotal = 0;

  for (const { id, group, requests } of cases.values()) {
    const sensitive = group === "sensitive" || requests.some(({ expected }) => expected.kind === "sensitive");
    if (sensitive) {
      sensitiveTotal++;
      if (outsideTeam.has(id)) {
        sensitiveAdmitted.add(id);
        failed.add(id);
      }
    }

    const result = results.get(id);
    const routes = new Map(result?.requests.map(({ requestId, route }) => [requestId, route]));
    const ids = new Set(requests.map(({ requestId }) => requestId));
    if (result?.status !== "complete" || ids.size === 0 || ids.size !== requests.length ||
      routes.size !== result.requests.length || routes.size !== ids.size || requests.some(({ requestId }) => !routes.has(requestId))) {
      incomplete.add(id);
    }
    const caseComplete = !incomplete.has(id);
    if (caseComplete) completed++;

    let correct = caseComplete;
    for (const { requestId, expected } of requests) {
      const matches = matchesRoute(routes.get(requestId), sensitive || expected.kind === "sensitive" ? { kind: "team" } : expected);
      correct &&= matches;
      if (!sensitive && expected.kind === "block" && expected.blockId === input.blockId) {
        blockRecall.total++;
        if (caseComplete && matches) blockRecall.hits++;
      }
    }
    if (caseComplete && !correct) failed.add(id);
    const rate = group === "neighbour" ? neighbourRouting : group === "trap" ? traps : null;
    if (rate) {
      rate.total++;
      if (correct) rate.hits++;
    }
  }

  const complete = !input.budgetExhausted && incomplete.size === 0 && unexpected.size === 0 &&
    sensitiveTotal > 0 && neighbourRouting.total > 0 && blockRecall.total > 0 && traps.total > 0;
  const meetsThresholds = neighbourRouting.hits * 100 >= neighbourRouting.total * 95 &&
    blockRecall.hits * 100 >= blockRecall.total * 90 && traps.hits * 100 >= traps.total * 90;
  // An observed sensitive admission is a hard failure even when the run stopped early.
  const status = sensitiveAdmitted.size > 0 ? "fail" : !complete ? "incomplete" : meetsThresholds ? "pass" : "fail";
  return {
    status, complete, budgetExhausted: input.budgetExhausted,
    cases: { completed, total: cases.size },
    sensitive: { admitted: sensitiveAdmitted.size, total: sensitiveTotal, admittedCaseIds: [...sensitiveAdmitted].sort() },
    neighbourRouting, blockRecall, traps,
    failedCaseIds: [...failed].sort(), incompleteCaseIds: [...incomplete].sort(), unexpectedCaseIds: [...unexpected].sort(),
  };
}
