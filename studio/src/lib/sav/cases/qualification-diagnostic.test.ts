import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ requireDb: () => { throw Error("NO_DB_ALLOWED"); } }));
import { SAV_CASE_INPUT_KEY } from "./investigation-budgeted-retrieval";
import { latestInvestigationInput } from "./investigation-runner";
import {
  SAV_CASE_JOURNAL_QUALIFICATION_BLOCKS, SAV_CASE_QUALIFICATION_BLOCKS, SAV_CASE_QUALIFICATION_BLOCK_NATURES, type CaseEvent,
} from "./case-types";
import {
  CaseQualificationUnavailableError, SAV_CASE_QUALIFICATION_CAUSE_CODES, SAV_CASE_QUALIFICATION_INPUT_KEY, caseQualificationBlockedError, caseQualificationCauseCode,
  caseQualificationPrecheck, caseQualificationUnavailableSchema, isCaseQualificationUnavailable, serializeCaseQualificationUnavailable,
} from "./qualification-diagnostic";

/* Lot A6 (OBS1 phase 1), pure: no database (any access throws), synthetic ids only. */

const KEY = `in:${randomUUID()}`;
const typed = (overrides: Partial<ConstructorParameters<typeof CaseQualificationUnavailableError>[0]> = {}) =>
  new CaseQualificationUnavailableError({ code: "v1_context_unavailable", inputKey: KEY, inputVersion: 4, causeCode: "SAV_V1_CONTEXT_RUN_MISSING", ...overrides });

describe("closed codes, stable for B and UX", () => {
  it("the code list, natures and journal subset are fixed", () => {
    expect(SAV_CASE_QUALIFICATION_BLOCKS).toEqual(["handback_unproven", "acknowledgement_input", "relay_proof_invalid", "v1_source_mismatch", "v1_requests_mismatch", "rule_invalid",
      "v1_context_unavailable", "rule_unavailable", "policy_unavailable"]);
    expect(Object.keys(SAV_CASE_QUALIFICATION_BLOCK_NATURES).sort()).toEqual([...SAV_CASE_QUALIFICATION_BLOCKS].sort());
    expect(SAV_CASE_QUALIFICATION_BLOCKS.filter(code => SAV_CASE_QUALIFICATION_BLOCK_NATURES[code] === "technical")).toEqual(["v1_context_unavailable", "rule_unavailable", "policy_unavailable"]);
    expect(SAV_CASE_JOURNAL_QUALIFICATION_BLOCKS).toEqual(["handback_unproven", "acknowledgement_input", "relay_proof_invalid"]);
    expect(SAV_CASE_QUALIFICATION_CAUSE_CODES.every(code => /^SAV_[A-Z0-9_]+$/.test(code))).toBe(true);
  });
  it("the input key pattern is B's", () => expect(SAV_CASE_QUALIFICATION_INPUT_KEY.source).toBe(SAV_CASE_INPUT_KEY.source));
});

describe("CaseQualificationUnavailableError: closed fields, no raw text", () => {
  it("builds its message from constants and derives the nature", () => {
    const error = typed();
    expect(error).toMatchObject({ name: "CaseQualificationUnavailableError", code: "v1_context_unavailable", nature: "technical", inputKey: KEY, inputVersion: 4, causeCode: "SAV_V1_CONTEXT_RUN_MISSING",
      message: "SAV_CASE_QUALIFICATION_UNAVAILABLE:v1_context_unavailable:SAV_V1_CONTEXT_RUN_MISSING" });
    expect(error.cause).toBeUndefined();
    expect(typed({ code: "handback_unproven", causeCode: null, inputKey: `back:${randomUUID()}` }).message).toBe("SAV_CASE_QUALIFICATION_UNAVAILABLE:handback_unproven");
  });
  it.each([
    ["an unknown code", { code: "unknown" as never }],
    ["a non-canonical input key", { inputKey: "in:not-a-key" }],
    ["an upper-case uuid", { inputKey: `in:${randomUUID().toUpperCase()}` }],
    ["a negative input version", { inputVersion: -1 }],
    ["a fractional input version", { inputVersion: 1.5 }],
    ["a free cause code", { causeCode: "SAV_FREE_TEXT client@example.invalid" as never }],
  ])("refuses %s at construction", (_label, overrides) => expect(() => typed(overrides)).toThrow());
  it("the cause filter keeps exact constants only", () => {
    expect(caseQualificationCauseCode(Error("SAV_V1_CONTEXT_RUN_MISSING"))).toBe("SAV_V1_CONTEXT_RUN_MISSING");
    for (const raw of [Error("SAV_V1_CONTEXT_RUN_MISSING client@example.invalid"), Error("contact client@example.invalid unreachable"), Error("SAV_UNKNOWN_CODE"), "SAV_V1_CONTEXT_RUN_MISSING", null, undefined, { message: "SAV_V1_CONTEXT_RUN_MISSING" }])
      expect(caseQualificationCauseCode(raw)).toBeNull();
  });
});

describe("strict guard and serialiser for B", () => {
  it("a built error passes and serialises to exactly the closed fields", () => {
    const error = typed();
    expect(isCaseQualificationUnavailable(error)).toBe(true);
    const serialized = serializeCaseQualificationUnavailable(error);
    expect(serialized).toEqual({ code: "v1_context_unavailable", nature: "technical", inputKey: KEY, inputVersion: 4, causeCode: "SAV_V1_CONTEXT_RUN_MISSING" });
    expect(Object.keys(JSON.parse(JSON.stringify(serialized))).sort()).toEqual(["causeCode", "code", "inputKey", "inputVersion", "nature"]);
  });
  it("look-alikes are not typed refusals: plain object, prototype forgery, plain Error, subclass", () => {
    const fields = { name: "CaseQualificationUnavailableError", message: "SAV_CASE_QUALIFICATION_UNAVAILABLE:v1_context_unavailable", code: "v1_context_unavailable", nature: "technical", inputKey: KEY, inputVersion: 4, causeCode: null };
    const forged = Object.assign(Object.create(CaseQualificationUnavailableError.prototype), fields);
    class Sub extends CaseQualificationUnavailableError {}
    for (const value of [fields, forged, Object.assign(Error(fields.message), fields), new Sub({ code: "v1_context_unavailable", inputKey: KEY, inputVersion: 4 }), null, "x"]) {
      expect(isCaseQualificationUnavailable(value)).toBe(false);
      expect(() => serializeCaseQualificationUnavailable(value)).toThrow("SAV_CASE_QUALIFICATION_UNAVAILABLE_INVALID");
    }
  });
  it("a built error mutated afterwards is no longer one", () => {
    for (const mutate of [(e: Record<string, unknown>) => { e.code = "unknown"; }, (e: Record<string, unknown>) => { e.nature = "contract_blocked"; },
      (e: Record<string, unknown>) => { e.causeCode = "client@example.invalid"; }, (e: Record<string, unknown>) => { e.message = "raw client@example.invalid"; },
      (e: Record<string, unknown>) => { e.extra = "x"; }]) {
      const error = typed();
      mutate(error as unknown as Record<string, unknown>);
      const kept = (error as unknown as Record<string, unknown>).extra === undefined;
      // An extra own property is not one of the closed fields, so it is never serialised; the other mutations break the guard.
      if (kept) expect(isCaseQualificationUnavailable(error)).toBe(false);
      else expect(serializeCaseQualificationUnavailable(error)).not.toHaveProperty("extra");
    }
  });
  it("the wire schema refuses unknown keys, __proto__ included, and a nature that does not match the code", () => {
    const ok = { code: "handback_unproven", nature: "contract_blocked", inputKey: `back:${randomUUID()}`, inputVersion: 2, causeCode: "SAV_CASE_QUALIFY_HANDBACK_UNPROVEN" };
    expect(caseQualificationUnavailableSchema.safeParse(ok).success).toBe(true);
    expect(caseQualificationUnavailableSchema.safeParse(JSON.parse(JSON.stringify(ok).replace("{", '{"__proto__":{"polluted":true},'))).success).toBe(false);
    expect(caseQualificationUnavailableSchema.safeParse({ ...ok, message: "raw" }).success).toBe(false);
    expect(caseQualificationUnavailableSchema.safeParse({ ...ok, nature: "technical" }).success).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("caseQualificationPrecheck: the journal check shared by qualify and the diagnostic", () => {
  const messageId = randomUUID(), executionId = randomUUID(), runId = randomUUID();
  const relay = { kind: "intake_effects_confirmed", messageId, executionId, intakeRunId: runId, intakeRunVersion: 1 };
  const ev = (caseVersion: number, extra: Partial<CaseEvent>): CaseEvent => ({ id: randomUUID(), caseId: randomUUID(), kind: "inbound_confirmed", dedupeKey: `inbound:gm-${caseVersion}`, caseVersion,
    direction: "customer_inbound", occurredAt: "2026-11-01T01:00:00.000Z", sourceRef: { type: "email", id: `gm-${caseVersion}` }, detail: { messageId, relay }, createdAt: "2026-11-01T01:00:00.000Z", ...extra } as CaseEvent);
  const mail = ev(3, {});
  const cases: Array<[string, CaseEvent[], number, unknown]> = [
    ["no customer input", [ev(1, { kind: "crm_observed", direction: "internal", detail: null, sourceRef: { type: "hubspot_object", id: "1" } })], 1, { outcome: "null", state: "no_customer_input", inputKey: null }],
    ["a canonical relayed mail at the input version", [mail], 3, { outcome: "eligible", inputKey: `in:${mail.id}`, gmailMessageId: "gm-3" }],
    ["a newer non-mail input", [mail, ev(4, { kind: "crm_observed", direction: "internal", detail: { crmChange: "unknown" }, sourceRef: { type: "hubspot_object", id: "1" } })], 4, { outcome: "null", state: "input_not_current", inputKey: `in:${mail.id}` }],
    ["a hand-back", [mail, ev(4, { kind: "owner_changed", direction: "internal", detail: { transition: "hand_back", from: "human", to: "agent" }, sourceRef: { type: "studio_command", id: "c" } })], 3, { outcome: "blocked", block: "handback_unproven" }],
    ["an unreadable relay proof", [ev(3, { detail: { messageId, relay: { kind: "invented" } } })], 3, { outcome: "blocked", block: "relay_proof_invalid" }],
    ["a proof of another message", [ev(3, { detail: { messageId: randomUUID(), relay } })], 3, { outcome: "blocked", block: "relay_proof_invalid" }],
    ["a source that is not an email", [ev(3, { sourceRef: { type: "studio_command", id: "c" } })], 3, { outcome: "blocked", block: "relay_proof_invalid" }],
    ["an acknowledgement", [ev(3, { detail: { messageId, relay: { kind: "acknowledgement_on_case_thread", messageId, intakeRunId: runId, intakeRunVersion: 2, sourceHash: "syn" } } })], 3, { outcome: "blocked", block: "acknowledgement_input" }],
  ];
  it.each(cases)("%s", (_label, events, inputVersion, expected) => {
    const result = caseQualificationPrecheck({ admissionInputVersion: inputVersion }, events);
    expect(result).toMatchObject({ ...(expected as object), inputVersion });
    // The input it names is always the runner's own.
    expect(result.inputKey).toBe(latestInvestigationInput(events));
    if (result.outcome === "blocked") {
      const error = caseQualificationBlockedError(result);
      expect(serializeCaseQualificationUnavailable(error)).toMatchObject({ code: result.block, nature: "contract_blocked", inputKey: result.inputKey, inputVersion });
    }
  });
});
