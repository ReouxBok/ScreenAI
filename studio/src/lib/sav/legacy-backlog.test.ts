import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hasV0DispatchMarker, summarizeV0Backlog, triageV0Action, triageV0Followup, V0_DISPATCH_MARKERS,
  type V0BacklogRow,
} from "./legacy-backlog";

const row = (overrides: Partial<V0BacklogRow> = {}): V0BacklogRow => ({
  id: "a1", kind: "send_reply", actorType: "ai", status: "pending", attemptCount: 0, pilotBatchId: null, payload: {}, ...overrides,
});

describe("triage of the old V0 queue (synthetic rows, nothing is executed)", () => {
  it("a machine action that never reached a provider is held, not sent and not cleaned", () => {
    for (const status of ["pending", "running"]) {
      for (const actorType of ["ai", "system"]) {
        expect(triageV0Action(row({ status, actorType }))).toMatchObject({ class: "held_not_sent", disposition: "hold_for_audited_decision", mayExecute: false });
      }
    }
  });
  it.each(V0_DISPATCH_MARKERS)("a %s marker means the outcome may be unknown: verify read-only, whatever the status", (marker) => {
    for (const status of ["pending", "running", "failed", "cancelled"]) {
      expect(triageV0Action(row({ status, payload: { [marker]: "2026-10-27T10:00:00.000Z" } })))
        .toMatchObject({ class: "engaged_unverified", disposition: "verify_read_only", mayExecute: false });
    }
  });
  it("a marker on a human command is still unverified: a human path does not make the provider outcome known", () => {
    expect(triageV0Action(row({ actorType: "human", status: "running", payload: { replySendDispatchedAt: "2026-10-27T10:00:00.000Z" } })).class).toBe("engaged_unverified");
  });
  it("a confirmed effect is evidence: kept, never repeated, even with a marker", () => {
    expect(triageV0Action(row({ status: "succeeded" }))).toMatchObject({ class: "confirmed", disposition: "keep_unchanged" });
    expect(triageV0Action(row({ status: "succeeded", payload: { replySendDispatchedAt: "x" } })).class).toBe("confirmed");
  });
  it("a human command stays with the human path; closed rows without a marker are closed", () => {
    expect(triageV0Action(row({ actorType: "human", status: "pending" }))).toMatchObject({ class: "human_command", disposition: "keep_unchanged" });
    for (const status of ["failed", "cancelled"]) expect(triageV0Action(row({ status })).class).toBe("closed_without_effect");
  });
  it("drafts are data and pilot rows are simulations", () => {
    expect(triageV0Action(row({ kind: "draft_reply", status: "succeeded" })).class).toBe("data_not_effect");
    expect(triageV0Action(row({ pilotBatchId: "batch-1" })).class).toBe("pilot_simulation");
    expect(triageV0Action(row({ pilotBatchId: "batch-1", payload: { replySendDispatchedAt: "x" } })).class).toBe("pilot_simulation");
  });
  it("unknown kinds and statuses are never read as harmless", () => {
    expect(triageV0Action(row({ kind: "wire_money" })).class).toBe("engaged_unverified");
    expect(triageV0Action(row({ status: "weird" })).class).toBe("engaged_unverified");
    expect(triageV0Action(row({ status: "weird", actorType: "human" })).class).toBe("human_command");
  });
  it("empty or null marker values are not a dispatch", () => {
    expect(hasV0DispatchMarker({ replySendDispatchedAt: null })).toBe(false);
    expect(hasV0DispatchMarker({ replySendDispatchedAt: "" })).toBe(false);
    expect(hasV0DispatchMarker({})).toBe(false);
    expect(hasV0DispatchMarker({ replySendDispatchedAt: "2026-10-27T10:00:00Z" })).toBe(true);
  });
  it("no verdict can ever say it may execute, and no disposition names an execution", () => {
    const kinds = ["send_reply", "request_human", "create_ticket", "link_ticket", "create_note", "log_email", "update_ticket_status", "draft_reply", "x"];
    for (const kind of kinds) for (const actorType of ["ai", "system", "human"]) for (const status of ["pending", "running", "succeeded", "failed", "cancelled", "x"]) {
      for (const payload of [{}, { replySendDispatchedAt: "x" }]) {
        const result = triageV0Action(row({ kind, actorType, status, payload }));
        expect(result.mayExecute).toBe(false);
        expect(["keep_unchanged", "verify_read_only", "hold_for_audited_decision"]).toContain(result.disposition);
      }
    }
  });
});

describe("follow-ups", () => {
  it("a scheduled follow-up that was never queued is held", () => {
    expect(triageV0Followup({ id: "f1", status: "scheduled", actionId: null }, null)).toMatchObject({ class: "held_not_sent", disposition: "hold_for_audited_decision" });
  });
  it("a queued follow-up follows its action, including a dispatch marker", () => {
    expect(triageV0Followup({ id: "f1", status: "queued", actionId: "a1" }, row()).class).toBe("held_not_sent");
    expect(triageV0Followup({ id: "f1", status: "queued", actionId: "a1" }, row({ payload: { replySendDispatchedAt: "x" } })).class).toBe("engaged_unverified");
    expect(triageV0Followup({ id: "f1", status: "queued", actionId: "a1" }, row({ status: "succeeded" })).class).toBe("confirmed");
  });
  it("a queued follow-up without its action, or an unknown state, is not assumed harmless", () => {
    expect(triageV0Followup({ id: "f1", status: "queued", actionId: "a1" }, null).class).toBe("engaged_unverified");
    expect(triageV0Followup({ id: "f1", status: "mystery", actionId: null }, null).class).toBe("engaged_unverified");
  });
  it("a cancelled follow-up is closed", () => {
    expect(triageV0Followup({ id: "f1", status: "cancelled", actionId: null }, null).class).toBe("closed_without_effect");
  });
});

describe("before/after summary", () => {
  it("counts every class once, lists rows to verify and to hold sorted, and is stable", () => {
    const rows = [
      row({ id: "z-held" }), row({ id: "a-held", status: "running" }), row({ id: "m-engaged", payload: { forwardDispatchedAt: "x" } }),
      row({ id: "c-ok", status: "succeeded" }), row({ id: "h", actorType: "human" }),
    ].map((entry) => ({ id: entry.id, verdict: triageV0Action(entry) }));
    const summary = summarizeV0Backlog(rows);
    expect(summary).toEqual({
      total: 5,
      byClass: { data_not_effect: 0, human_command: 1, confirmed: 1, closed_without_effect: 0, engaged_unverified: 1, held_not_sent: 2, pilot_simulation: 0 },
      byDisposition: { keep_unchanged: 2, verify_read_only: 1, hold_for_audited_decision: 2 },
      toVerify: ["m-engaged"], toHold: ["a-held", "z-held"],
    });
    expect(summarizeV0Backlog([...rows].reverse())).toEqual(summary);
  });
  it("an empty queue is an empty summary", () => {
    expect(summarizeV0Backlog([])).toMatchObject({ total: 0, toVerify: [], toHold: [] });
  });
});

describe("purity", () => {
  it("reads no clock, environment, database, provider, and has no function that sends, cancels or deletes", () => {
    const source = readFileSync(new URL("./legacy-backlog.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Date\.now\(|new Date\(|process\.env|Math\.random|randomUUID/);
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/\b(fetch|requireDb|drizzle|insert|update|delete)\(/);
    expect(source).not.toMatch(/export (async )?function (send|execute|replay|cancel|delete|acknowledge|clean)/i);
  });
});
