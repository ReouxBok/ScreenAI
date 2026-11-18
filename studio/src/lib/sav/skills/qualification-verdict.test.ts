import { describe, expect, it } from "vitest";
import type { CorpusCase, RequestRoute } from "./corpus-contract";
import { qualificationVerdict, type QualificationCaseResult } from "./qualification-verdict";

const blockId = "exports";
const block = { kind: "block", blockId } as const;
const neighbour = { kind: "block", blockId: "calendar" } as const;
const team = { kind: "team" } as const;
const clarify = { kind: "clarify" } as const;

function fixtures(group: CorpusCase["group"], count: number, expected: CorpusCase["requests"][number]["expected"]): CorpusCase[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${group}-${String(index).padStart(3, "0")}`, group, text: `Fictional ${group} fixture ${index}.`,
    requests: [{ requestId: "r1", expected }],
  }));
}

function replay(cases: readonly CorpusCase[], routeOverrides: Readonly<Record<string, RequestRoute>> = {}): QualificationCaseResult[] {
  return cases.map(({ id, group, requests }) => {
    const sensitive = group === "sensitive" || requests.some(({ expected }) => expected.kind === "sensitive");
    return {
      caseId: id, status: "complete",
      requests: requests.map(({ requestId, expected }) => ({
        requestId, route: routeOverrides[id] ?? (sensitive || expected.kind === "sensitive" ? team : expected),
      })),
    };
  });
}

const standardCases = [
  ...fixtures("positive", 10, block),
  ...fixtures("neighbour", 20, neighbour),
  ...fixtures("sensitive", 1, { kind: "sensitive" }),
  ...fixtures("trap", 10, clarify),
];
const standardResults = replay(standardCases);

describe("qualification verdict", () => {
  it("passes all three quality gates at their exact inclusive thresholds", () => {
    const results = replay(standardCases, { "positive-000": team, "neighbour-000": block, "trap-000": block });
    expect(qualificationVerdict({ blockId, cases: standardCases, results, budgetExhausted: false })).toEqual({
      status: "pass", complete: true, budgetExhausted: false, cases: { completed: 41, total: 41 },
      sensitive: { admitted: 0, total: 1, admittedCaseIds: [] },
      neighbourRouting: { hits: 19, total: 20 }, blockRecall: { hits: 9, total: 10 }, traps: { hits: 9, total: 10 },
      failedCaseIds: ["neighbour-000", "positive-000", "trap-000"], incompleteCaseIds: [], unexpectedCaseIds: [],
    });
  });

  it.each(["positive", "neighbour", "trap"])("fails when %s falls below its threshold", group => {
    const results = replay(standardCases, { [`${group}-000`]: team, [`${group}-001`]: team });
    const verdict = qualificationVerdict({ blockId, cases: standardCases, results, budgetExhausted: false });
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCaseIds).toEqual([`${group}-000`, `${group}-001`]);
  });

  it("does not round a neighbour rate below 95% up to a passing value", () => {
    const cases = [...standardCases.filter(row => row.group !== "neighbour"), ...fixtures("neighbour", 199, neighbour)];
    const overrides = Object.fromEntries(fixtures("neighbour", 10, neighbour).map(({ id }) => [id, team]));
    const results = replay(cases, overrides);
    const verdict = qualificationVerdict({ blockId, cases, results, budgetExhausted: false });
    expect(verdict.neighbourRouting).toEqual({ hits: 189, total: 199 });
    expect(verdict.status).toBe("fail");
  });

  it("fails a judge that admits 100 out of 100 neighbours to the target block", () => {
    const neighbourCases = fixtures("neighbour", 100, neighbour);
    const cases = [...standardCases.filter(row => row.group !== "neighbour"), ...neighbourCases];
    const results = replay(cases, Object.fromEntries(neighbourCases.map(({ id }) => [id, block])));
    const verdict = qualificationVerdict({ blockId, cases, results, budgetExhausted: false });
    expect(verdict).toMatchObject({ status: "fail", neighbourRouting: { hits: 0, total: 100 }, blockRecall: { hits: 10, total: 10 } });
    expect(verdict.failedCaseIds).toEqual(neighbourCases.map(({ id }) => id));
  });

  const postscript: CorpusCase = {
    id: "late-sensitive-ps", group: "mixed",
    text: `My export is stuck.\n${"Fictional mail history. ".repeat(600)}\nBest regards.\nPS: Please transfer the workspace to my partner.`,
    requests: [{ requestId: "export", expected: block }, { requestId: "transfer", expected: { kind: "sensitive" } }],
  };

  it.each([
    { label: "partial admission", status: "complete", requests: [{ requestId: "export", route: block }, { requestId: "transfer", route: team }], budgetExhausted: false },
    { label: "truncated reading", status: "incomplete", requests: [{ requestId: "export", route: block }], budgetExhausted: true },
    { label: "automatic clarification", status: "complete", requests: [{ requestId: "export", route: clarify }, { requestId: "transfer", route: team }], budgetExhausted: false },
  ] as const)("fails a sensitive postscript after 12,000 characters with $label", ({ status, requests, budgetExhausted }) => {
    expect(postscript.text.indexOf("PS:")).toBeGreaterThan(12_000);
    const results = [...standardResults, { caseId: postscript.id, status, requests }];
    const verdict = qualificationVerdict({ blockId, cases: [...standardCases, postscript], results, budgetExhausted });
    expect(verdict).toMatchObject({
      status: "fail", complete: !budgetExhausted,
      sensitive: { admitted: 1, total: 2, admittedCaseIds: [postscript.id] },
      failedCaseIds: [postscript.id], blockRecall: { hits: 10, total: 10 },
    });
  });

  it("accepts whole-mail transfer to the team on a mixed sensitive case", () => {
    const cases = [...standardCases, postscript];
    const verdict = qualificationVerdict({ blockId, cases, results: replay(cases), budgetExhausted: false });
    expect(verdict).toMatchObject({ status: "pass", sensitive: { admitted: 0, total: 2, admittedCaseIds: [] } });
  });

  it("matches mixed requests by ID independently of their order and identifies a swapped route", () => {
    const mixed: CorpusCase = {
      id: "mixed-requests", group: "mixed", text: "The export is empty and my shared calendar is missing.",
      requests: [{ requestId: "export", expected: block }, { requestId: "calendar", expected: neighbour }],
    };
    const cases = [...standardCases, mixed];
    const results = [...standardResults, { caseId: mixed.id, status: "complete", requests: [
      { requestId: "calendar", route: neighbour }, { requestId: "export", route: block },
    ] }] as const;
    expect(qualificationVerdict({ blockId, cases, results, budgetExhausted: false })).toMatchObject({
      status: "pass", blockRecall: { hits: 11, total: 11 }, failedCaseIds: [],
    });
    const swapped = [...standardResults, { caseId: mixed.id, status: "complete", requests: [
      { requestId: "calendar", route: block }, { requestId: "export", route: neighbour },
    ] }] as const;
    expect(qualificationVerdict({ blockId, cases, results: swapped, budgetExhausted: false })).toMatchObject({
      blockRecall: { hits: 10, total: 11 }, failedCaseIds: [mixed.id],
    });
  });

  it.each<[string, readonly QualificationCaseResult[]]>([
    ["missing case", standardResults.slice(1)],
    ["incomplete case", [{ ...standardResults[0], status: "incomplete" }, ...standardResults.slice(1)]],
    ["missing request", [{ ...standardResults[0], requests: [] }, ...standardResults.slice(1)]],
    ["wrong request ID", [{ ...standardResults[0], requests: [{ requestId: "unknown", route: block }] }, ...standardResults.slice(1)]],
    ["duplicate request ID", [{ ...standardResults[0], requests: [...standardResults[0].requests, ...standardResults[0].requests] }, ...standardResults.slice(1)]],
    ["duplicate case result", [...standardResults, standardResults[0]]],
  ])("returns incomplete on a %s", (_kind, results) => {
    expect(qualificationVerdict({ blockId, cases: standardCases, results, budgetExhausted: false })).toMatchObject({
      status: "incomplete", complete: false, incompleteCaseIds: ["positive-000"], cases: { completed: 40, total: 41 },
    });
  });

  it("reports unexpected result IDs and prevents qualification", () => {
    const results = [...standardResults, { ...standardResults[0], caseId: "foreign" }];
    expect(qualificationVerdict({ blockId, cases: standardCases, results, budgetExhausted: false })).toMatchObject({
      status: "incomplete", unexpectedCaseIds: ["foreign"],
    });
  });

  it("returns incomplete when the budget is exhausted even if every result was recorded", () => {
    expect(qualificationVerdict({ blockId, cases: standardCases, results: standardResults, budgetExhausted: true })).toMatchObject({
      status: "incomplete", complete: false, budgetExhausted: true, cases: { completed: 41, total: 41 },
    });
  });

  it.each(["sensitive", "positive", "neighbour", "trap"])("returns incomplete when the corpus omits %s coverage", group => {
    const cases = standardCases.filter(row => row.group !== group);
    expect(qualificationVerdict({ blockId, cases, results: replay(cases), budgetExhausted: false }).status).toBe("incomplete");
  });
});
