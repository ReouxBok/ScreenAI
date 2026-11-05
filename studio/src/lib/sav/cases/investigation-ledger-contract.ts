import { SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest, type CaseInvestigationModelResult, type CaseInvestigationPorts } from "./investigation-runner";

/*
 * Executable contract of the V2 call ledger behind the runner's `callModel` port. No such ledger exists yet: the intake
 * ledger (`reserveSavIntakeCall`) is bound to an intake run, not to a case input. B's runner relies on these rules for
 * "never paid twice" after a crash, so they are written here as scenarios any adapter must pass (pole A or ROOT runs
 * them against the real one) instead of staying an assumption of B's tests. It checks; it is not a ledger.
 */

export type CaseCallLedgerHarness = {
  /** The adapter under test, wired to a provider double. */
  callModel: CaseInvestigationPorts["callModel"];
  /** Provider dispatches so far: the calls that may have been paid. */
  dispatched(): number;
  /**
   * Makes the next dispatch die after the provider ran and before the ledger stored its result, as a killed process
   * would. Optional: a harness without it reports that scenario `not_run`, never `passed`.
   */
  crashAfterDispatch?(): void;
};

export type CaseCallLedgerScenario =
  | "replay_after_result" | "replay_after_crash" | "concurrent_same_key" | "subject_ceiling" | "subjects_independent";
export type CaseCallLedgerCheck = { scenario: CaseCallLedgerScenario; status: "passed" | "failed" | "not_run"; detail?: string };

/** `base`: any valid request of the runner; the scenarios only change its keys. */
export async function checkCaseCallLedgerContract(make: () => Promise<CaseCallLedgerHarness> | CaseCallLedgerHarness, base: CaseInvestigationModelRequest): Promise<CaseCallLedgerCheck[]> {
  const request = (subject: string, call: number): CaseInvestigationModelRequest => {
    const subjectKey = `${base.caseBudgetKey}:${subject}`;
    return { ...base, inputKey: subject, call, subjectKey, callKey: `${subjectKey}:call${call}` };
  };
  const calm = async (harness: CaseCallLedgerHarness, req: CaseInvestigationModelRequest): Promise<CaseInvestigationModelResult | Error> => {
    try { return await harness.callModel(req); } catch (error) { return error instanceof Error ? error : Error(String(error)); }
  };
  const checks: CaseCallLedgerCheck[] = [];
  const check = (scenario: CaseCallLedgerScenario, failure: string | null) => checks.push(failure ? { scenario, status: "failed", detail: failure } : { scenario, status: "passed" });

  // 1. A known result is given back for the same key: one dispatch, same output.
  {
    const h = await make(), first = await calm(h, request("in:a", 1)), again = await calm(h, request("in:a", 1));
    check("replay_after_result", h.dispatched() !== 1 ? `dispatched ${h.dispatched()} times`
      : first instanceof Error || first.status !== "ok" ? "first call did not succeed"
      : again instanceof Error || again.status !== "ok" || JSON.stringify(again.output) !== JSON.stringify(first.output) ? "replay did not give back the stored result" : null);
  }
  // 2. The process died after the provider ran: the same key is never dispatched again; it is reported uncertain (or
  // given back, if the ledger learnt the result), never as a fresh call.
  {
    const h = await make();
    if (!h.crashAfterDispatch) checks.push({ scenario: "replay_after_crash", status: "not_run", detail: "harness cannot simulate a crash" });
    else {
      h.crashAfterDispatch();
      await calm(h, request("in:b", 1));
      const again = await calm(h, request("in:b", 1));
      check("replay_after_crash", h.dispatched() !== 1 ? `dispatched ${h.dispatched()} times`
        : again instanceof Error ? `replay threw ${again.message}`
        : again.status === "failed" && again.uncertain || again.status === "ok" ? null : `replay answered ${again.status}`);
    }
  }
  // 3. Two workers with the same key at once: one dispatch.
  {
    const h = await make();
    await Promise.all([calm(h, request("in:c", 1)), calm(h, request("in:c", 1))]);
    check("concurrent_same_key", h.dispatched() === 1 ? null : `dispatched ${h.dispatched()} times`);
  }
  // 4. The per-input ceiling holds in the ledger itself, even if the runner lost its count in a crash.
  {
    const h = await make();
    for (let call = 1; call <= SAV_CASE_INVESTIGATION_MAX_CALLS; call++) await calm(h, request("in:d", call));
    const over = await calm(h, request("in:d", SAV_CASE_INVESTIGATION_MAX_CALLS + 1));
    check("subject_ceiling", h.dispatched() !== SAV_CASE_INVESTIGATION_MAX_CALLS ? `dispatched ${h.dispatched()} times`
      : over instanceof Error || over.status !== "subject_exhausted" ? `call ${SAV_CASE_INVESTIGATION_MAX_CALLS + 1} was not refused as subject_exhausted` : null);
  }
  // 5. Another input of the same case has its own calls (the case-wide window is a separate, configured rule).
  {
    const h = await make();
    await calm(h, request("in:e", 1));
    const other = await calm(h, request("in:f", 1));
    check("subjects_independent", h.dispatched() === 2 && !(other instanceof Error) && other.status === "ok" ? null : "another input was not dispatched");
  }
  return checks;
}
