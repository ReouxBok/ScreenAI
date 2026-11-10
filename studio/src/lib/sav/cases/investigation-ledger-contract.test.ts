import { describe, expect, it } from "vitest";
import { checkCaseCallLedgerContract, type CaseCallLedgerHarness } from "./investigation-ledger-contract";
import { SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest, type CaseInvestigationModelResult } from "./investigation-runner";

/*
 * The V2 call ledger contract run against ledger doubles: a correct one passes every scenario, and each flaw a real
 * ledger could have is caught by at least one scenario. The real ledger does not exist yet (see the contract file).
 */

const base = { purpose: "decision", caseId: "case-1", caseVersion: 1, inputKey: "in:x", call: 1, subjectKey: "", callKey: "", caseBudgetKey: "sav-case:case-1",
  snapshot: {}, events: [], knowledge: [], coverage: null, feedback: [], closure: [] } as unknown as CaseInvestigationModelRequest;

type Flaw = "pays_twice" | "reserves_after_dispatch" | "no_ceiling" | "wrong_refusal";
function ledger(flaw?: Flaw, options: { crash?: boolean } = { crash: true }): CaseCallLedgerHarness {
  const results = new Map<string, CaseInvestigationModelResult | "unknown">(), subjects = new Map<string, Set<string>>();
  let dispatched = 0, crash = false;
  const harness: CaseCallLedgerHarness = {
    dispatched: () => dispatched,
    callModel: async request => {
      const known = results.get(request.callKey);
      if (known && flaw !== "pays_twice") return known === "unknown" ? { status: "failed", uncertain: true } : known;
      const keys = subjects.get(request.subjectKey) ?? new Set<string>();
      // `wrong_refusal`: refuses without paying, but as a technical failure the runner would wait on, not as the end of the input.
      if (flaw !== "no_ceiling" && !keys.has(request.callKey) && keys.size >= SAV_CASE_INVESTIGATION_MAX_CALLS) return flaw === "wrong_refusal" ? { status: "failed", uncertain: false } : { status: "subject_exhausted" };
      subjects.set(request.subjectKey, keys.add(request.callKey));
      // Reserved before the provider runs, so a crash or a second worker finds the key taken.
      if (flaw !== "reserves_after_dispatch") results.set(request.callKey, "unknown");
      dispatched += 1;
      await Promise.resolve();
      if (crash) { crash = false; throw Error("PROCESS_KILLED_FIXTURE"); }
      const result: CaseInvestigationModelResult = { status: "ok", output: { answeredFor: request.callKey } };
      results.set(request.callKey, result);
      return result;
    },
  };
  return options.crash ? { ...harness, crashAfterDispatch: () => { crash = true; } } : harness;
}
const failed = (checks: Awaited<ReturnType<typeof checkCaseCallLedgerContract>>) => checks.filter(row => row.status !== "passed").map(row => `${row.scenario}:${row.status}`);

describe("V2 call ledger contract (to be run by pole A or ROOT on the real ledger)", () => {
  it("a ledger that reserves the key before dispatch and caps each input passes every scenario", async () => {
    expect(await checkCaseCallLedgerContract(() => ledger(), base)).toEqual([
      { scenario: "replay_after_result", status: "passed" }, { scenario: "replay_after_crash", status: "passed" },
      { scenario: "concurrent_same_key", status: "passed" }, { scenario: "subject_ceiling", status: "passed" }, { scenario: "subjects_independent", status: "passed" },
    ]);
  });
  it("catches a ledger that pays the same key twice", async () => {
    expect(failed(await checkCaseCallLedgerContract(() => ledger("pays_twice"), base))).toEqual(["replay_after_result:failed", "replay_after_crash:failed", "concurrent_same_key:failed"]);
  });
  it("catches a ledger that reserves only after the provider ran (crash and concurrency)", async () => {
    expect(failed(await checkCaseCallLedgerContract(() => ledger("reserves_after_dispatch"), base))).toEqual(["replay_after_crash:failed", "concurrent_same_key:failed"]);
  });
  it("catches a ledger without the per-input ceiling", async () => {
    expect(failed(await checkCaseCallLedgerContract(() => ledger("no_ceiling"), base))).toEqual(["subject_ceiling:failed"]);
  });
  it("catches a ledger that stops the input without saying it is exhausted", async () => {
    expect(failed(await checkCaseCallLedgerContract(() => ledger("wrong_refusal"), base))).toEqual(["subject_ceiling:failed"]);
  });
  it("a harness that cannot simulate a crash reports that scenario as not run, never as passed", async () => {
    expect(failed(await checkCaseCallLedgerContract(() => ledger(undefined, { crash: false }), base))).toEqual(["replay_after_crash:not_run"]);
  });
});
