import { describe, expect, it } from "vitest";
import type { CaseInvestigationProgress } from "./investigation-runner";
import {
  caseInvestigationObservationRecord, readCaseInvestigationProgress, SAV_CASE_INVESTIGATION_RECORD_KIND, type CaseInvestigationJournalEvent,
} from "./investigation-record";
import { caseInvestigationWaitLabels } from "./investigation-waits";

// Synthetic progress only: no customer content.
const progress = (patch: Partial<CaseInvestigationProgress> = {}): CaseInvestigationProgress => ({
  modelCalls: 2, attempts: [{ call: 1, result: "validated", outcome: "needs_review", kinds: ["forbidden_action"], codes: ["credential_requested"] }, { call: 2, result: "failed", purpose: "decision", uncertain: false }],
  waiting: { reason: "technical_wait", since: "2026-10-28T10:00:00.000Z", caseVersion: 4 }, proposal: { output: { caseVersion: 4 }, proposedOn: 4 }, last: null, closure: null, recordedOn: null, ...patch,
});
const observed = (caseVersion: number, record: unknown): CaseInvestigationJournalEvent => ({ kind: "observation_recorded", caseVersion, detail: { applied: false, reason: null, record } });

describe("SAV-7 investigation record in the pole A journal", () => {
  it("round-trips progress and decision through an observation record, under the store's size limit", () => {
    const record = caseInvestigationObservationRecord("in:e3", progress(), null);
    expect(record).toMatchObject({ kind: SAV_CASE_INVESTIGATION_RECORD_KIND, inputKey: "in:e3" });
    expect(readCaseInvestigationProgress([observed(5, structuredClone(record))], "in:e3")).toEqual({ state: "found", caseVersion: 5, record });
  });
  it("stores every wait the console knows, including the case-wide budget ceiling", () => {
    for (const reason of Object.keys(caseInvestigationWaitLabels) as Array<keyof typeof caseInvestigationWaitLabels>) {
      const record = caseInvestigationObservationRecord("in:e3", progress({ waiting: { reason, since: "2026-10-28T10:00:00.000Z", caseVersion: 4 } }), null);
      expect(readCaseInvestigationProgress([observed(5, record)], "in:e3")).toMatchObject({ state: "found", record: { progress: { waiting: { reason } } } });
    }
  });
  it("reads the latest record of this input, ignoring other inputs, other events and other owners' records", () => {
    const old = caseInvestigationObservationRecord("in:e3", progress({ modelCalls: 1 }), null);
    const latest = caseInvestigationObservationRecord("in:e3", progress({ modelCalls: 3, waiting: null }), null);
    const other = caseInvestigationObservationRecord("back:o9", progress({ modelCalls: 0 }), null);
    const events = [observed(6, latest), observed(4, old), observed(7, other), observed(8, { kind: "someone-else.v1" }),
      { kind: "inbound_confirmed", caseVersion: 9, detail: null }];
    expect(readCaseInvestigationProgress(events, "in:e3")).toMatchObject({ state: "found", caseVersion: 6, record: { progress: { modelCalls: 3 } } });
    expect(readCaseInvestigationProgress(events, "in:e10")).toEqual({ state: "none" });
  });
  it("never falls back to an older record when the latest one is unreadable", () => {
    const good = caseInvestigationObservationRecord("in:e3", progress(), null);
    const broken = { ...good, progress: { ...good.progress as object, modelCalls: 7 } };
    expect(readCaseInvestigationProgress([observed(4, good), observed(6, broken)], "in:e3")).toEqual({ state: "unreadable", caseVersion: 6 });
    expect(readCaseInvestigationProgress([observed(4, good), observed(6, { kind: SAV_CASE_INVESTIGATION_RECORD_KIND })], "in:e3")).toEqual({ state: "unreadable", caseVersion: 6 });
  });
  it("refuses an invalid or oversized record instead of storing it", () => {
    expect(() => caseInvestigationObservationRecord("note:x", progress(), null)).toThrow("SAV_CASE_INVESTIGATION_RECORD_INVALID");
    expect(() => caseInvestigationObservationRecord("in:e3", progress({ modelCalls: 4 }), null)).toThrow("SAV_CASE_INVESTIGATION_RECORD_INVALID");
    expect(() => caseInvestigationObservationRecord("in:e3", progress({ proposal: { output: "x".repeat(70_000), proposedOn: 4 } }), null)).toThrow("SAV_CASE_INVESTIGATION_RECORD_TOO_LARGE");
  });
});

describe("B5 (night 01/11): the knowledge_changed wait and its closed codes", () => {
  const at = "2026-10-28T10:00:00.000Z";
  it.each(["revision_moved", "revision_unreadable"] as const)("stores knowledge_changed / %s", problem => {
    const record = caseInvestigationObservationRecord("in:e3", progress({ waiting: { reason: "knowledge_changed", since: at, caseVersion: 4, problem } }), null);
    expect(readCaseInvestigationProgress([observed(5, record)], "in:e3")).toMatchObject({ state: "found", record: { progress: { waiting: { reason: "knowledge_changed", problem } } } });
  });
  it.each([
    ["a context code on knowledge_changed", { reason: "knowledge_changed", problem: "body_invalid" }],
    ["a revision code on context_invalid", { reason: "context_invalid", problem: "revision_moved" }],
    ["a revision code on another wait", { reason: "technical_wait", problem: "revision_moved" }],
    ["a raw revision id as problem", { reason: "knowledge_changed", problem: "kb-r2" }],
  ])("refuses %s", (_name, wait) => {
    expect(() => caseInvestigationObservationRecord("in:e3", progress({ waiting: { since: at, caseVersion: 4, ...wait } as never }), null)).toThrow("SAV_CASE_INVESTIGATION_RECORD_INVALID");
  });
});


it("round-trips closed transport diagnostics durably and reads old records without them", () => {
  const diagnostic = { stage: "http" as const, code: "http_rejected" as const, networkAttempted: true, httpStatus: 403 };
  const value = progress({ attempts: [{ call: 1, result: "failed", purpose: "decision", uncertain: false, diagnostic }], waiting: { reason: "technical_wait", since: "2026-11-10T00:00:00Z", caseVersion: 4, diagnostic } });
  const stored = caseInvestigationObservationRecord("in:e3", value, null);
  expect(readCaseInvestigationProgress([observed(5, structuredClone(stored))], "in:e3")).toMatchObject({ state: "found", record: { progress: { attempts: [{ diagnostic }], waiting: { diagnostic } } } });
  expect(readCaseInvestigationProgress([observed(4, caseInvestigationObservationRecord("in:e3", progress(), null))], "in:e3").state).toBe("found");
  expect(() => caseInvestigationObservationRecord("in:e3", { ...value, waiting: { ...value.waiting!, diagnostic: { ...diagnostic, secret: "forbidden" } } } as never, null)).toThrow("SAV_CASE_INVESTIGATION_RECORD_INVALID");
});
