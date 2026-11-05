import { describe, expect, it } from "vitest";
import { canonicalJson, checkCommonSimulationReport, frozenExpectationHash } from "./simulation-report-common";

// Counter-tests of B's reference check for the common simulated-run report: each sabotage of the independent review, and each old shape of the
// 0510 fixture (run started at the freeze instant, average sends per key, a silently dropped unknown field), must be refused with its own code.
type Expected = { purpose: string | null; final: string; reason: string | null; sends: number; refusals: string[] };
const KEY_A = "reply:case-a:inbound:gm-syn-0001", KEY_B = "reply:case-a:back:evt-2";

function caseOf(caseRef: string, expected: Expected | null, observed: Expected & { byKey?: { replyKey: string; count: number }[] }) {
  const frozen = expected && { caseRef, scenario: `scénario ${caseRef} (synthétique)`, timeline: ["t"], expected };
  const fields = expected ? [["reply.purpose", expected.purpose, observed.purpose], ["effect.final", expected.final, observed.final], ["effect.reason", expected.reason, observed.reason],
    ["sends.total", expected.sends, observed.sends], ["refusals", expected.refusals, observed.refusals]].map(([field, e, p]) => ({ field, expected: e, proposed: p })) : [];
  const diff = fields.some(field => canonicalJson(field.expected) !== canonicalJson(field.proposed));
  const byKey = observed.byKey ?? (observed.sends ? [{ replyKey: KEY_A, count: observed.sends }] : []);
  return {
    caseRef, scenario: `scénario ${caseRef} (synthétique)`, timeline: ["t"], expected: frozen ? { frozenAt: "2026-10-31T00:00:00.000Z", hash: frozenExpectationHash(frozen) } : null,
    proposedAt: "2026-10-31T00:00:01.000Z", fields, declaredVerdict: !expected ? "not_comparable" : diff ? "mismatch" : expected.refusals.length ? "refused_as_expected" : "match",
    refusals: observed.refusals, actions: [{ kind: "reply", simulated: true, outcome: observed.final, reason: observed.reason }],
    proofs: [{ kind: "networkCalls", ref: "0" }], cost: { modelCalls: 1, paidCalls: 0 }, latencyMs: 3,
    executor: { simulated: true, syntheticSends: observed.sends, sendsByReplyKey: byKey, replyKeys: byKey.length }, notComparable: [] as { field: string; reason: string }[],
    expectedMeta: frozen ? { canonicalization: "sorted-keys-json-utf8-sha256", frozenBy: null, b7Policy: "undecided", frozen } : null,
  };
}
const SENT: Expected = { purpose: "answer", final: "would_send", reason: null, sends: 1, refusals: [] };
function report() {
  const cases = [
    caseOf("SYN-T1", SENT, SENT),
    caseOf("SYN-T2", { ...SENT, refusals: ["trigger_already_approved"] }, { ...SENT, refusals: ["trigger_already_approved"] }),
    caseOf("SYN-T3", SENT, { ...SENT, sends: 2, byKey: [{ replyKey: KEY_A, count: 1 }, { replyKey: KEY_B, count: 1 }] }),
    caseOf("SYN-T4", null, SENT),
  ];
  return {
    kind: "sav-v2-simulation-report.proposal-1",
    run: { id: "syn-t", startedAt: "2026-10-31T00:00:00.500Z", expectationsFrozenAt: "2026-10-31T00:00:00.000Z", base: { sha: "1".repeat(40), tree: "2".repeat(40) }, synthetic: true,
      provenance: { contract: "sav-v2-simulation-report.common-1", generator: "test", executor: "simulated", provider: "synthetic-gmail-no-socket", model: "synthetic-double",
        policy: {}, cohort: { id: "syn-t", kind: "synthetic", cases: cases.length, selection: "fixed" } } },
    cases,
  };
}
type Report = ReturnType<typeof report>;
const codesOf = (mutate: (r: Report) => void) => { const r = report(); mutate(r); return checkCommonSimulationReport(r).errors; };
const t = (r: Report, ref: string) => r.cases.find(row => row.caseRef === ref)!;

describe("B's reference check of the common simulated-run report", () => {
  it("accepts a well-formed report and recomputes its verdicts; two keys sent once each is a total mismatch, not a double send per key", () => {
    expect(checkCommonSimulationReport(report())).toEqual({
      errors: [], verdicts: { "SYN-T1": "match", "SYN-T2": "refused_as_expected", "SYN-T3": "mismatch", "SYN-T4": "not_comparable" },
      doubleSendKeys: { "SYN-T1": [], "SYN-T2": [], "SYN-T3": [], "SYN-T4": [] },
    });
  });

  it("R1: an expectation frozen at (or after) run.startedAt is refused; a proposal before the run start too", () => {
    expect(codesOf(r => { r.run.startedAt = "2026-10-31T00:00:00.000Z"; })).toEqual(["SYN-T1:frozen_not_before_run", "SYN-T2:frozen_not_before_run", "SYN-T3:frozen_not_before_run"]);
    expect(codesOf(r => { t(r, "SYN-T1").proposedAt = "2026-10-31T00:00:00.400Z"; })).toEqual(["SYN-T1:proposal_before_run"]);
  });

  it("R2: the old average is refused, and [2,0] is told apart from [1,1]; keys unique, counts whole and non-negative, sum and key count exact", () => {
    expect(codesOf(r => { (t(r, "SYN-T3").executor as Record<string, unknown>).sendsByReplyKey = 1; })).toEqual(["SYN-T3:sends_by_key_not_distribution"]);
    const two = report();
    t(two, "SYN-T3").executor.sendsByReplyKey = [{ replyKey: KEY_A, count: 2 }, { replyKey: KEY_B, count: 0 }];
    expect(checkCommonSimulationReport(two)).toMatchObject({ errors: [], doubleSendKeys: { "SYN-T3": [KEY_A] } });
    expect(codesOf(r => { t(r, "SYN-T3").executor.sendsByReplyKey = [{ replyKey: KEY_A, count: 1 }, { replyKey: KEY_A, count: 1 }]; })).toEqual(["SYN-T3:sends_by_key_duplicate"]);
    expect(codesOf(r => { t(r, "SYN-T3").executor.sendsByReplyKey = [{ replyKey: KEY_A, count: 1.5 }, { replyKey: KEY_B, count: 0.5 }]; })).toEqual(["SYN-T3:sends_by_key_count", "SYN-T3:sends_by_key_sum"]);
    expect(codesOf(r => { t(r, "SYN-T3").executor.sendsByReplyKey = [{ replyKey: KEY_A, count: 3 }, { replyKey: KEY_B, count: -1 }]; })).toEqual(["SYN-T3:sends_by_key_count"]);
    expect(codesOf(r => { t(r, "SYN-T3").executor.sendsByReplyKey = [{ replyKey: KEY_A, count: 1 }, { replyKey: KEY_B, count: 0 }]; })).toEqual(["SYN-T3:sends_by_key_sum"]);
    expect(codesOf(r => { t(r, "SYN-T3").executor.replyKeys = 1; })).toEqual(["SYN-T3:sends_by_key_keys"]);
    // An unknown sent count is null, never a measured zero next to a "not comparable" declaration.
    expect(codesOf(r => { const row = t(r, "SYN-T1"); row.fields = row.fields.filter(field => field.field !== "sends.total");
      row.notComparable = [{ field: "sends.total", reason: "executor_not_run" }]; row.declaredVerdict = "not_comparable";
      row.executor = { ...row.executor, syntheticSends: 0, sendsByReplyKey: [], replyKeys: 0 }; })).toEqual(["SYN-T1:sends_unknown_but_measured"]);
    expect(codesOf(r => { t(r, "SYN-T3").fields[3]!.proposed = 1; })).toEqual(["SYN-T3:sends_total_not_bound", "SYN-T3:verdict_inconsistent"]);
  });

  it("binding: every compared expected value is the frozen one; the five fields are all there once, or explicitly not comparable", () => {
    expect(codesOf(r => { t(r, "SYN-T1").fields[1]!.expected = "cancelled"; })).toEqual(["SYN-T1:field_not_bound", "SYN-T1:verdict_inconsistent"]);
    expect(codesOf(r => { t(r, "SYN-T1").fields = []; })).toEqual(["SYN-T1:field_missing"]);
    expect(codesOf(r => { t(r, "SYN-T1").fields.splice(2, 1); })).toEqual(["SYN-T1:field_missing"]);
    expect(codesOf(r => { t(r, "SYN-T1").fields.push({ ...t(r, "SYN-T1").fields[0]! }); })).toEqual(["SYN-T1:field_duplicate"]);
    expect(codesOf(r => { t(r, "SYN-T1").fields[0]!.field = "reply.text"; })).toEqual(["SYN-T1:field_unknown_name", "SYN-T1:field_missing"]);
    expect(codesOf(r => { t(r, "SYN-T1").notComparable.push({ field: "effect.final", reason: "x" }); t(r, "SYN-T1").declaredVerdict = "not_comparable"; })).toEqual(["SYN-T1:field_duplicate"]);
    expect(codesOf(r => { t(r, "SYN-T1").refusals = ["trigger_already_approved"]; })).toEqual(["SYN-T1:refusals_not_bound"]);
  });

  it("hash: recomputed from the frozen object; a tampered hash, scenario, timeline or a value outside the canonical domain is refused", () => {
    expect(codesOf(r => { t(r, "SYN-T1").expected!.hash = "0".repeat(64); })).toEqual(["SYN-T1:hash_mismatch"]);
    expect(codesOf(r => { t(r, "SYN-T1").scenario = "autre"; })).toEqual(["SYN-T1:frozen_scenario"]);
    expect(codesOf(r => { t(r, "SYN-T1").timeline = []; })).toEqual(["SYN-T1:frozen_timeline"]);
    expect(codesOf(r => { (t(r, "SYN-T1").expectedMeta!.frozen as Record<string, unknown>).weight = 0.5; })).toEqual(["SYN-T1:frozen_not_canonical"]);
    expect(() => canonicalJson({ a: undefined })).toThrow("SAV_CANONICAL_VALUE");
    expect(() => canonicalJson(Number.NaN)).toThrow("SAV_CANONICAL_NUMBER");
    expect(canonicalJson({ b: [1, "é"], a: null })).toBe('{"a":null,"b":[1,"é"]}');
  });

  it("verdict: never trusted; an unknown makes the case not comparable; a refusal outside the frozen expectation is a mismatch", () => {
    expect(codesOf(r => { t(r, "SYN-T1").notComparable.push({ field: "latency", reason: "x" }); })).toEqual(["SYN-T1:field_unknown_name", "SYN-T1:verdict_inconsistent"]);
    const unknown = report(), row = t(unknown, "SYN-T1");
    row.fields = row.fields.filter(field => field.field !== "sends.total"); row.notComparable = [{ field: "sends.total", reason: "executor_not_run" }];
    row.executor = { ...row.executor, syntheticSends: null as never, sendsByReplyKey: null as never, replyKeys: null as never };
    expect(checkCommonSimulationReport(unknown).errors).toEqual(["SYN-T1:verdict_inconsistent"]);
    row.declaredVerdict = "not_comparable";
    expect(checkCommonSimulationReport(unknown)).toMatchObject({ errors: [], verdicts: { "SYN-T1": "not_comparable" } });
    expect(codesOf(r => { t(r, "SYN-T3").declaredVerdict = "match"; })).toEqual(["SYN-T3:verdict_inconsistent"]);
    const surprise = report(), extra = caseOf("SYN-T5", SENT, { ...SENT, refusals: ["trigger_already_approved"] });
    surprise.cases.push(extra); surprise.run.provenance.cohort.cases += 1;
    expect(checkCommonSimulationReport(surprise)).toMatchObject({ errors: [], verdicts: { "SYN-T5": "mismatch" } });
    expect(codesOf(r => { t(r, "SYN-T4").fields = t(r, "SYN-T1").fields; })).toEqual(["SYN-T4:expected_null_with_fields"]);
  });

  it("simulated only: an action or executor not simulated, a network call, a paid call or a non-synthetic provenance is refused", () => {
    expect(codesOf(r => { (t(r, "SYN-T1").actions[0] as Record<string, unknown>).simulated = false; })).toEqual(["SYN-T1:action_not_simulated"]);
    expect(codesOf(r => { (t(r, "SYN-T1").executor as Record<string, unknown>).simulated = false; })).toEqual(["SYN-T1:executor_not_simulated"]);
    expect(codesOf(r => { t(r, "SYN-T1").proofs = [{ kind: "networkCalls", ref: "1" }]; })).toEqual(["SYN-T1:network_calls"]);
    expect(codesOf(r => { t(r, "SYN-T1").cost.paidCalls = 1; })).toEqual(["SYN-T1:paid_calls"]);
    expect(codesOf(r => { r.run.provenance.provider = "gmail"; })).toEqual(["provenance_provider"]);
    expect(codesOf(r => { r.run.provenance.executor = "real"; })).toEqual(["provenance_executor"]);
    expect(codesOf(r => { r.run.provenance.contract = "sav-v2-simulation-report.proposal-1"; })).toEqual(["provenance_contract"]);
    expect(codesOf(r => { (r.run as Record<string, unknown>).synthetic = false; })).toEqual(["run_not_synthetic"]);
    expect(codesOf(r => { r.run.provenance.cohort.cases = 9; })).toEqual(["provenance_cohort"]);
    expect(codesOf(r => { t(r, "SYN-T1").caseRef = "bench-1"; })).toEqual(["case_ref"]);
  });

  it("bounds are checked before reading: 256 KiB, 500 cases, 20 000 characters per string, 50 fields per case", () => {
    expect(codesOf(r => { t(r, "SYN-T1").scenario = "x".repeat(300_000); })).toEqual(["report_too_large"]);
    expect(codesOf(r => { r.cases = Array.from({ length: 501 }, () => ({}) as Report["cases"][number]); })).toEqual(["too_many_cases"]);
    expect(codesOf(r => { t(r, "SYN-T1").refusals = ["x".repeat(20_001)]; })).toContain("string_too_long");
    expect(codesOf(r => { t(r, "SYN-T1").fields = Array.from({ length: 51 }, () => t(r, "SYN-T1").fields[0]!); })).toContain("SYN-T1:too_many_fields");
    const nested: unknown[] = []; let cursor = nested;
    for (let level = 0; level < 20; level += 1) { const next: unknown[] = []; cursor.push(next); cursor = next; }
    expect(codesOf(r => { (r.run as Record<string, unknown>).extra = nested; })).toEqual(["too_deep"]);
    expect(codesOf(r => { (r.run as Record<string, unknown>).extra = [[[["ok"]]]]; })).toEqual([]);
  });
});
