import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// No provider, CRM or network behind the ledger: importing one fails the file.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
import { markSavCaseCallDispatched, releaseSavCaseCall, reserveSavCaseCall, settleSavCaseCall } from "./case-calls";
import { openCaseEvent } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { caseCallLedgerAdapter, type CaseCallLedgerPort, type CaseCallMoneyGate } from "./investigation-call-ledger";
import { checkCaseCallLedgerContract, type CaseCallLedgerHarness } from "./investigation-ledger-contract";
import { SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest } from "./investigation-runner";

/*
 * B's `callModel` adapter on pole A's REAL ledger (`reserveSavCaseCall`, sav.case_calls 0049). Locally on PGlite: one
 * connection, so "concurrent" calls are interleaved, not truly parallel. The same file runs on native Postgres (pool of
 * 4) when SAV_TEST_POSTGRES_URL is set, as in the CI `sav-native` job; only that run proves concurrency.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 7_700_000;
const native = Boolean(process.env.SAV_TEST_POSTGRES_URL);
async function newCase() {
  const gmail = `gm-ledger-${randomUUID()}`;
  const qualification = { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000001", at: "2026-10-30T09:00:00.000Z" } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] };
  const { case: c } = await openCaseEvent({ ticketId: String(++ticketSeq), threadId: randomUUID(), admission: { policy: null, qualification },
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: "2026-10-30T09:00:00.000Z" });
  return c.caseId;
}
const realLedger: CaseCallLedgerPort = { reserve: reserveSavCaseCall, markDispatched: markSavCaseCallDispatched, settle: settleSavCaseCall, release: releaseSavCaseCall };
const request = (caseId: string, input: string, call: number): CaseInvestigationModelRequest => {
  const subjectKey = `sav-case:${caseId}:${input}`;
  return { purpose: "decision", caseId, caseVersion: 1, inputKey: input, call, subjectKey, callKey: `${subjectKey}:call${call}`, caseBudgetKey: `sav-case:${caseId}`,
    snapshot: {} as never, events: [], knowledge: [], coverage: null, feedback: [], closure: [] };
};
const allow: CaseCallMoneyGate = async () => ({ status: "allowed" });

/** A provider double that counts dispatches; `kill` makes the next one die as a process would, before anything is written back. */
function harness(money: CaseCallMoneyGate = allow): CaseCallLedgerHarness & { provider: ReturnType<typeof vi.fn> } {
  let killed = false;
  const provider = vi.fn(async (req: CaseInvestigationModelRequest) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (killed) throw Error("PROCESS_KILLED_FIXTURE");
    return { status: "ok" as const, output: { answeredFor: req.callKey } };
  });
  // A dead process writes nothing: once killed, the settle never reaches the ledger.
  const ledger: CaseCallLedgerPort = { ...realLedger, settle: async input => { if (killed) { killed = false; throw Error("PROCESS_KILLED_FIXTURE"); } return realLedger.settle(input); } };
  const callModel = caseCallLedgerAdapter({ ledger, money, provider, holder: "pole-b-runner", leaseSeconds: 60, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS });
  return { callModel, dispatched: () => provider.mock.calls.length, crashAfterDispatch: () => { killed = true; }, provider };
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "ledger-adapter-fixture-key-32-chars!"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); })); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe(`B's callModel on pole A's real ledger (${native ? "native Postgres" : "PGlite: concurrency interleaved, not parallel"})`, () => {
  it("passes the five scenarios of the ledger contract, the crash one included", async () => {
    const caseId = await newCase();
    const checks = await checkCaseCallLedgerContract(() => harness(), request(caseId, "in:base", 1));
    expect(checks).toEqual([
      { scenario: "replay_after_result", status: "passed" }, { scenario: "replay_after_crash", status: "passed" },
      { scenario: "concurrent_same_key", status: "passed" }, { scenario: "subject_ceiling", status: "passed" }, { scenario: "subjects_independent", status: "passed" },
    ]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("the money gate is distinct: a refusal or a failure of the gate sends nothing, releases the key, and does not use the input's ceiling", async () => {
    const caseId = await newCase();
    for (const money of [async () => ({ status: "refused" as const, reason: "daily_budget" }), async () => { throw Error("BUDGET_UNREADABLE"); }] as CaseCallMoneyGate[]) {
      const h = harness(money);
      expect(await h.callModel(request(caseId, "in:gate", 1))).toEqual({ status: "deferred" });
      expect(h.dispatched()).toBe(0);
    }
    // Released twice, so the same key and the whole ceiling are still available once the gate allows.
    const h = harness();
    for (let call = 1; call <= SAV_CASE_INVESTIGATION_MAX_CALLS; call++) expect(await h.callModel(request(caseId, "in:gate", call))).toMatchObject({ status: "ok" });
    expect(h.dispatched()).toBe(SAV_CASE_INVESTIGATION_MAX_CALLS);
  });

  it("an uncertain provider answer is stored and never dispatched again, whoever asks next", async () => {
    const caseId = await newCase(), h = harness();
    h.provider.mockImplementationOnce(async () => { throw Error("PROVIDER_TIMEOUT_FIXTURE"); });
    expect(await h.callModel(request(caseId, "in:unc", 1))).toEqual({ status: "failed", uncertain: true });
    expect(await h.callModel(request(caseId, "in:unc", 1))).toEqual({ status: "failed", uncertain: true });
    expect(await harness().callModel(request(caseId, "in:unc", 1))).toEqual({ status: "failed", uncertain: true });
    expect(h.dispatched()).toBe(1);
  });

  it("a key held by a live lease elsewhere is deferred, never dispatched in parallel", async () => {
    const caseId = await newCase(), req = request(caseId, "in:busy", 1);
    expect(await reserveSavCaseCall({ callKey: req.callKey, subjectKey: req.subjectKey, caseId, caseVersion: 1, purpose: "decision", holder: "other-runner", leaseSeconds: 60 })).toMatchObject({ status: "reserved" });
    const h = harness();
    expect(await h.callModel(req)).toEqual({ status: "deferred" });
    expect(h.dispatched()).toBe(0);
  });
});
