import { describe, expect, it } from "vitest";
import { SAV_CASE_ADMISSION_EXIT_CATEGORIES, SAV_CASE_EXIT_REASONS, classifyCaseExit } from "./case-outcomes";
import { SAV_CASE_ADMISSION_REASONS, SAV_CASE_EVENT_KINDS } from "./case-types";

const moved = (detail: Record<string, unknown>) => ({ kind: "owner_changed" as const, detail: { from: "agent", to: "human", ...detail } });
const staff = { type: "human", staffUserId: "20000000-0000-4000-8000-000000000001" };

describe("exit categories for the Q11 measure (decision Ugo 28/10)", () => {
  it("classifies every admission reason that withdraws a case, exhaustively", () => {
    const withdrawing = SAV_CASE_ADMISSION_REASONS.filter(reason => reason !== "admitted");
    expect(Object.keys(SAV_CASE_ADMISSION_EXIT_CATEGORIES).sort()).toEqual([...withdrawing].sort());
    for (const reason of withdrawing) expect(classifyCaseExit(moved({ transition: "admission_withdrawn", reasons: [reason] }))).toBe(SAV_CASE_ADMISSION_EXIT_CATEGORIES[reason]);
    expect(classifyCaseExit(moved({ transition: "admission_withdrawn", reasons: ["context_incomplete"] }))).toBe("technical_block");
    expect(classifyCaseExit(moved({ transition: "admission_withdrawn", reasons: ["sensitive_family"] }))).toBe("business_transfer");
  });
  it("classifies the agent's handoff and the system takeover by their declared code, Q5 included", () => {
    for (const [code, category] of Object.entries(SAV_CASE_EXIT_REASONS)) {
      expect(classifyCaseExit(moved({ transition: "handoff", actor: { type: "agent" }, reason: code }))).toBe(category);
      expect(classifyCaseExit(moved({ transition: "human_takeover", actor: { type: "system" }, reason: code }))).toBe(category);
    }
    expect(classifyCaseExit(moved({ transition: "human_takeover", actor: { type: "system" }, reason: "body_limit_reached" }))).toBe("technical_block");
  });
  it("counts a human's own initiative apart, never as a transfer by the agent", () => {
    expect(classifyCaseExit(moved({ transition: "human_takeover", actor: staff, reason: "body_limit_reached" }))).toBe("human_initiative");
    expect(classifyCaseExit(moved({ transition: "handoff", actor: staff, reason: "out_of_scope" }))).toBe("human_initiative");
    // An agent case held, then released to the team.
    expect(classifyCaseExit({ kind: "owner_changed", detail: { transition: "hold_release", from: "system_hold", to: "human", fromPhase: "awaiting_customer", actor: staff } })).toBe("human_initiative");
  });
  it("keeps an unknown code, transition or actor visible as unclassified instead of guessing", () => {
    expect(classifyCaseExit(moved({ transition: "handoff", actor: { type: "agent" }, reason: "not_a_known_code" }))).toBe("unclassified");
    expect(classifyCaseExit(moved({ transition: "handoff", actor: { type: "agent" }, reason: "toString" }))).toBe("unclassified");
    expect(classifyCaseExit(moved({ transition: "admission_withdrawn", reasons: ["admitted"] }))).toBe("unclassified");
    expect(classifyCaseExit(moved({ transition: "admission_withdrawn" }))).toBe("unclassified");
    expect(classifyCaseExit(moved({ transition: "something_new", actor: staff }))).toBe("unclassified");
    expect(classifyCaseExit(moved({ transition: "human_takeover" }))).toBe("unclassified");
  });
  it("is not an exit when the case does not leave the agent for a human", () => {
    for (const kind of SAV_CASE_EVENT_KINDS.filter(kind => kind !== "owner_changed")) expect(classifyCaseExit({ kind, detail: null })).toBeNull();
    expect(classifyCaseExit({ kind: "owner_changed", detail: { transition: "technical_hold", from: "agent", to: "system_hold", actor: staff } })).toBeNull();
    expect(classifyCaseExit({ kind: "owner_changed", detail: { transition: "hand_back", from: "human", to: "agent", actor: staff } })).toBeNull();
    expect(classifyCaseExit({ kind: "owner_changed", detail: { transition: "hold_release", from: "system_hold", to: "human", fromPhase: "human_owned", actor: staff } })).toBeNull();
    expect(classifyCaseExit({ kind: "owner_changed", detail: { transition: "hold_release", from: "system_hold", to: "agent", fromPhase: "acting", actor: staff } })).toBeNull();
    expect(classifyCaseExit({ kind: "owner_changed", detail: null })).toBeNull();
  });
});
