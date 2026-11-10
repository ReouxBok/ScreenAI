import type { CaseModelTransportDiagnostic } from "./investigation-transport-diagnostic";
import type { CaseInvestigationModelRequest, CaseInvestigationPorts } from "./investigation-runner";

/*
 * The runner's `callModel` on pole A's V2 call ledger (`reserveSavCaseCall`, contract v9 §6). Local and OFF: nothing
 * wires it, and the provider is a port (no model is called here). The ledger functions are passed in, so the same
 * adapter runs on A's real store in tests and on doubles in the ledger contract kit; this file imports no database.
 *
 * Order, which is the contract: reserve the key (A) → money gate (ROOT's dollar budget, distinct from the per-input
 * ceiling) → mark dispatched (A) → provider → settle (A). A gate refusal or failure releases the key: nothing was sent.
 * Once marked dispatched, a key is never dispatched again: a crash before settle leaves it `uncertain` for good.
 */

type Reservation =
  | { status: "reserved"; token: string; leaseUntil: string }
  | { status: "known"; result: { status: "ok"; output: unknown } | { status: "failed"; uncertain: false } }
  | { status: "uncertain" }
  | { status: "busy"; retryAt: string }
  | { status: "subject_exhausted" };
type ProviderResult = { status: "ok"; output: unknown } | { status: "failed"; uncertain: boolean; diagnostic?: CaseModelTransportDiagnostic };

/** Pole A's `case-calls.ts` functions, by shape. */
export type CaseCallLedgerPort = {
  reserve(input: { callKey: string; subjectKey: string; caseId: string; caseVersion: number; purpose: string; holder: string; leaseSeconds: number; maxPerSubject?: number }): Promise<Reservation>;
  markDispatched(input: { callKey: string; token: string }): Promise<unknown>;
  settle(input: { callKey: string; token: string; result: ProviderResult }): Promise<unknown>;
  release(input: { callKey: string; token: string }): Promise<unknown>;
};

/**
 * The money gate, checked between reservation and dispatch. Distinct from the per-input ceiling (the ledger's) and from
 * the case signal: it answers whether spending is allowed now. Anything but `allowed`, or a failure, defers the call.
 */
export type CaseCallMoneyGate = (request: CaseInvestigationModelRequest) => Promise<{ status: "allowed" } | { status: "refused"; reason: string }>;

export type CaseCallLedgerAdapterOptions = {
  ledger: CaseCallLedgerPort;
  money: CaseCallMoneyGate;
  preflight?(request: CaseInvestigationModelRequest): CaseModelTransportDiagnostic | null;
  /** Gives back what `money` reserved when the provider was proven not called. Absent: the reservation stays held. */
  releaseMoney?(request: CaseInvestigationModelRequest): Promise<unknown>;
  /** The provider adapter; a thrown error after dispatch is an uncertain call. */
  provider(request: CaseInvestigationModelRequest): Promise<ProviderResult>;
  holder: string;
  leaseSeconds: number;
  maxPerSubject: number;
};

export function caseCallLedgerAdapter(options: CaseCallLedgerAdapterOptions): CaseInvestigationPorts["callModel"] {
  return async request => {
    const reservation = await options.ledger.reserve({ callKey: request.callKey, subjectKey: request.subjectKey, caseId: request.caseId,
      caseVersion: request.caseVersion, purpose: request.purpose, holder: options.holder, leaseSeconds: options.leaseSeconds, maxPerSubject: options.maxPerSubject });
    switch (reservation.status) {
      case "known": return reservation.result;
      case "uncertain": return { status: "failed", uncertain: true };
      // Another holder has the key under a live lease: nothing was sent by this run, which tries again later.
      case "busy": return { status: "deferred" };
      case "subject_exhausted": return { status: "subject_exhausted" };
    }
    const held = { callKey: request.callKey, token: reservation.token };
    if (options.preflight) {
      let diagnostic: CaseModelTransportDiagnostic | null;
      try { diagnostic = options.preflight(request); }
      catch { diagnostic = { stage: "preflight", code: "preflight_failed", networkAttempted: false }; }
      if (diagnostic) {
        await options.ledger.release(held);
        return { status: "input_rejected", diagnostic };
      }
    }
    let gate: Awaited<ReturnType<CaseCallMoneyGate>> | null = null;
    try { gate = await options.money(request); } catch { gate = null; }
    if (gate?.status !== "allowed") {
      await options.ledger.release(held);
      return { status: "deferred" };
    }
    // The mark failed, so the provider is not called: nothing can be billed, whatever the ledger stored. The key keeps its own rule; only the money goes back.
    try { await options.ledger.markDispatched(held); } catch (error) {
      try { await options.releaseMoney?.(request); } catch { /* the reservation stays held: conservative, and the mark's failure is what is reported */ }
      throw error;
    }
    let result: ProviderResult;
    try { result = await options.provider(request); } catch { result = { status: "failed", uncertain: true }; }
    await options.ledger.settle({ ...held, result });
    return result;
  };
}
