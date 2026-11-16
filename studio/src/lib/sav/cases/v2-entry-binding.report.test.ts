import { describe, expect, it } from "vitest";
import { caseContinuationReport } from "./v2-entry-binding";

describe("caseContinuationReport", () => {
  it("keeps the closed skip reason and detail of a stopped investigation", () => {
    expect(caseContinuationReport("skipped", { reason: "access_scope_missing", detail: "scope_policy_mismatch" })).toEqual({ status: "skipped", reason: "access_scope_missing", detail: "scope_policy_mismatch" });
    expect(caseContinuationReport("context_invalid", { problem: "temporary_incident_conflict" })).toEqual({ status: "context_invalid", reason: "temporary_incident_conflict" });
  });
  it("drops anything that is not a closed code", () => {
    expect(caseContinuationReport("skipped", { reason: "Bonjour, je n'arrive pas", detail: "x@y.fr" })).toEqual({ status: "skipped" });
    expect(caseContinuationReport("queued", {})).toEqual({ status: "queued" });
  });
  it("keeps the settle window's retryAt of a refused claim only, and only as an ISO date (SAV-92)", () => {
    expect(caseContinuationReport("claim_refused", { reason: "settling", retryAt: "2026-11-16T11:26:40.123Z" })).toEqual({ status: "claim_refused", reason: "settling", retryAt: "2026-11-16T11:26:40.123Z" });
    expect(caseContinuationReport("claim_refused", { reason: "settling", retryAt: "demain 11h" })).toEqual({ status: "claim_refused", reason: "settling" });
    expect(caseContinuationReport("queued", { retryAt: "2026-11-16T11:26:40.123Z" })).toEqual({ status: "queued" });
  });
});
