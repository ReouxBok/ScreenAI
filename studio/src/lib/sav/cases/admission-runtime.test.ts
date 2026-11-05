import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAV_INTAKE_CONTRACT_REVISION, savIntakeDecisionSchema, type SavIntakeDecision } from "../intake/contract";
import { decideCaseAdmission } from "./admission-policy";
import {
  admissionPolicyPort, admissionPolicyRevisionPort, caseOwnerAtCreationProofSchema, decideSafeV2Attribution, qualificationFromConfirmedV1,
  ticketOwnerPort, v1QualificationPort, v2OwnerConfiguration,
  type ConfirmedV1Context, type TicketCreateReceipt, type V1AdmissionAdapterPolicy,
} from "./admission-runtime";
import { v1IntentHash } from "./case-store";
import { SAV_CASE_AWAITING_V2_ATTRIBUTION, emptyCaseBody, type CaseAdmissionQualification } from "./case-types";
import { admissionQualificationFromIntake, caseRequestsOpenedByIntake, relayQualification, v2HubspotOwnerId } from "./intake-boundary";

/*
 * SYN only: synthetic ids, no database, no HubSpot, no model. Every network access fails the test
 * (fetch is stubbed to throw), and no function under test is given anything that can write.
 */

const MESSAGE = "10000000-0000-4000-8000-000000000001", GMAIL = "gm-synthetic-1", EXECUTION = "30000000-0000-4000-8000-000000000001", RUN = "40000000-0000-4000-8000-000000000001";
const EFFECT = "50000000-0000-4000-8000-000000000001", STAFF = "20000000-0000-4000-8000-000000000003";
const V2_OWNER = "90000001", TEAM_OWNER = "80000001", HUMAN = "70000001";
const ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, HUBSPOT_SAV_OWNER_ID: TEAM_OWNER };
const SENDER_RULE: V1AdmissionAdapterPolicy = { revision: "synthetic-adapter-r1", decidedBy: "synthetic-decision", identity: "sender_unique_crm_match" };
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: "2026-10-30T09:00:00.000Z" };

const evidence = (id: string, source: "current_message" | "crm_contact" | "crm_ticket", sourceId: string) => ({ id, source, sourceId, observedAt: "2026-10-20T09:00:00.000Z", contentHash: "a".repeat(43) });
/** A V1 ticket decision the real contract accepts (parsed in the first test). */
function ticketDecision(kinds: Array<"support" | "finance" | "cancellation"> = ["support"]): SavIntakeDecision {
  const requests = kinds.map((kind, index) => ({ id: `request-${index + 1}`, kind, evidenceIds: ["current"] }));
  const sensitive = kinds.find(kind => kind !== "support");
  return {
    revision: SAV_INTAKE_CONTRACT_REVISION, messageId: MESSAGE, latestInboundMessageId: MESSAGE,
    threadId: "20000000-0000-4000-8000-000000000001", receivedAt: "2026-10-20T09:00:00.000Z",
    classification: sensitive ?? "support", requests,
    evidence: [evidence("current", "current_message", MESSAGE), evidence("contact", "crm_contact", "101"), evidence("ticket", "crm_ticket", "201"),
      { ...evidence("ticket-contact", "crm_ticket", "synthetic-association-201-101"), source: "ticket_contact_association" as const, ticketId: "201", contactId: "101", direction: "ticket_to_contact" as const }],
    disposition: {
      kind: "ticket", target: { operation: "link", contactId: "101", ticketId: "201", alreadyNew: false, ticketEvidenceId: "ticket", contactAssociationEvidenceId: "ticket-contact" },
      requestIds: requests.map(request => request.id),
      contactScope: { primaryContactId: "101", contacts: [{ origin: "email_lookup", addressOrigin: "sender", contactId: "101", evidenceIds: ["contact"] }], complete: true },
      search: "complete", history: "complete",
      identity: { kind: "unique_crm_match_for_intake", addressOrigin: "sender", scope: "intake_only", evidenceIds: ["current", "contact"] },
      sameIssueEvidenceIds: ["current", "ticket"], requiredPermissions: ["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"],
      multiTicketNote: { openTicketIdsOnTargetContact: ["201"] },
      note: { kind: "existing_return_summary", version: 2, previousState: "open", warningPrefix: null, sourceMessageId: MESSAGE, sourceEvidenceIds: ["current"], renderedContentHash: "a".repeat(43), deduplication: "source_message_and_final_ticket" },
      learning: sensitive ? "excluded" : "eligible_after_confirmed_effect", evidenceIds: ["current", "contact", "ticket", "ticket-contact"],
    },
  };
}
function context(decision = ticketDecision(), over: { source?: Partial<ConfirmedV1Context["source"]>; freshness?: Partial<ConfirmedV1Context["freshness"]> } = {}): ConfirmedV1Context {
  return { decision, source: { messageId: MESSAGE, gmailMessageId: GMAIL, executionId: EXECUTION, executionState: "confirmed", runId: RUN, runVersion: 2, ticketId: "201", ...over.source },
    freshness: { latestRunVersion: 2, humanRefused: false, ...over.freshness } };
}
const ticket = (decision: SavIntakeDecision) => { if (decision.disposition.kind !== "ticket") throw Error("INVALID_TEST_FIXTURE"); return decision.disposition; };

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); })); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("V1 confirmed context → V2 qualification (conservative adapter)", () => {
  it("the SYN V1 decision is one the real V1 contract accepts", () => {
    expect(savIntakeDecisionSchema.safeParse(ticketDecision()).success).toBe(true);
    expect(savIntakeDecisionSchema.safeParse(ticketDecision(["support", "finance"])).success).toBe(true);
  });

  it("without an adapter policy (today) identity and CRM context stay unknown, and nothing else is added", () => {
    const { qualification, trace } = qualificationFromConfirmedV1(context(), null);
    expect(qualification).toEqual({ requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] });
    expect(trace).toEqual({ identity: "adapter_policy_absent", crmContext: "adapter_policy_absent" });
  });

  it("an adapter that accepts no V1 identity gives CRM completeness only", () => {
    const { qualification, trace } = qualificationFromConfirmedV1(context(), { ...SENDER_RULE, identity: "none" });
    expect(qualification.identity).toEqual({ status: "unknown" });
    expect(qualification.crmContext).toBe("complete");
    expect(trace.identity).toBe("adapter_identity_none");
  });

  it("the sender's unique CRM match is confirmed only under an explicit adapter decision, with the contact as source", () => {
    const { qualification, trace } = qualificationFromConfirmedV1(context(), SENDER_RULE);
    expect(qualification.identity).toEqual({ status: "confirmed", source: { type: "hubspot_object", id: "101" } });
    expect(qualification.crmContext).toBe("complete");
    expect(qualification.requests).toEqual([]);
    expect(qualification.teamSignals).toEqual([]);
    expect(trace.identity).toBe("confirmed_sender_unique_crm_match");
  });

  it("contacts a person chose as equivalent are ambiguous, an address the customer declared is unknown", () => {
    const equivalent = ticketDecision();
    ticket(equivalent).identity = { ...ticket(equivalent).identity, kind: "human_equivalent_contacts", choiceEvidenceId: "choice" };
    expect(qualificationFromConfirmedV1(context(equivalent), SENDER_RULE).qualification.identity).toEqual({ status: "ambiguous" });
    const declared = ticketDecision();
    ticket(declared).identity = { ...ticket(declared).identity, addressOrigin: "customer_declared_registration" };
    expect(qualificationFromConfirmedV1(context(declared), SENDER_RULE)).toMatchObject({ qualification: { identity: { status: "unknown" } }, trace: { identity: "customer_declared_address" } });
  });

  it.each([
    ["an older V1 contract revision", (d: SavIntakeDecision) => context({ ...d, revision: "sav-intake-2026-10-01.v1" as never })],
    ["a newer V1 run of the message", (d: SavIntakeDecision) => context(d, { freshness: { latestRunVersion: 3 } })],
    ["an operator who refused the analysis", (d: SavIntakeDecision) => context(d, { freshness: { humanRefused: true } })],
    ["an execution that is not confirmed", (d: SavIntakeDecision) => context(d, { source: { executionState: "uncertain" } })],
    ["a decision of another message", (d: SavIntakeDecision) => context({ ...d, messageId: "10000000-0000-4000-8000-000000000009" })],
    ["a decision that is not a ticket", (d: SavIntakeDecision) => context({ ...d, disposition: { kind: "collect_context" } as never })],
  ])("%s gives unknown identity and unknown CRM context", (_name, make) => {
    const { qualification } = qualificationFromConfirmedV1(make(ticketDecision()), SENDER_RULE);
    expect(qualification.identity).toEqual({ status: "unknown" });
    expect(qualification.crmContext).toBe("unknown");
  });

  it("an incomplete CRM scope is unknown, not incomplete-but-usable", () => {
    const partial = ticketDecision();
    ticket(partial).contactScope = { ...ticket(partial).contactScope, complete: false };
    expect(qualificationFromConfirmedV1(context(partial), SENDER_RULE)).toMatchObject({ qualification: { crmContext: "unknown" }, trace: { crmContext: "search_incomplete" } });
  });

  it("a malformed adapter policy throws instead of defaulting", () => {
    expect(() => qualificationFromConfirmedV1(context(), { revision: "", decidedBy: "x", identity: "everyone" } as never)).toThrow();
  });
});

describe("readQualification port: unavailable is not absent", () => {
  const port = (read: () => Promise<ConfirmedV1Context | null>, policy: V1AdmissionAdapterPolicy | null = SENDER_RULE) =>
    v1QualificationPort({ readConfirmedContext: read, adapterPolicy: async () => policy });
  // The relay's target for the synthetic execution: the port compares it with the context before anything else.
  const TARGET = { ticketId: "201", executionId: EXECUTION, runId: RUN, runVersion: 2 };
  const call = (p: ReturnType<typeof port>) => p({ messageId: MESSAGE, gmailMessageId: GMAIL, requests: [], target: TARGET });

  it("a failed read throws, so the relay does not advance", async () => {
    await expect(call(port(async () => { throw Error("SYNTHETIC_DB_DOWN"); }))).rejects.toThrow("SYNTHETIC_DB_DOWN");
  });
  it("no confirmed V1 context gives null: V1 hints only, which never admit", async () => {
    expect(await call(port(async () => null))).toBeNull();
  });
  it("no target throws before the context is read", async () => {
    const read = vi.fn(async () => context());
    await expect(port(read)({ messageId: MESSAGE, gmailMessageId: GMAIL, requests: [] })).rejects.toThrow("SAV_V1_QUALIFICATION_TARGET_MISSING");
    expect(read).not.toHaveBeenCalled();
  });
  it("a context of another message throws", async () => {
    await expect(call(port(async () => context(ticketDecision(), { source: { gmailMessageId: "gm-other" } })))).rejects.toThrow("SAV_V1_QUALIFICATION_SOURCE_MISMATCH");
  });

  // The relay's own composition: hints from V1, the port's proof, the server admission.
  async function admit(decision: SavIntakeDecision, policy: unknown, adapter: V1AdmissionAdapterPolicy | null, extraProven: CaseAdmissionQualification["requests"] = []) {
    const requests = caseRequestsOpenedByIntake(decision, GMAIL, true);
    const proven = await port(async () => context(decision), adapter)({ messageId: MESSAGE, gmailMessageId: GMAIL, requests, target: TARGET });
    const merged = relayQualification(admissionQualificationFromIntake(decision, GMAIL), proven && { ...proven, requests: extraProven }, requests);
    return decideCaseAdmission({ policy, qualification: merged, caseSensitivity: "none" });
  }
  const humanProven = (decision: SavIntakeDecision) => caseRequestsOpenedByIntake(decision, GMAIL, true)
    .map(request => ({ requestId: request.requestId, family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: "2026-10-30T09:00:00.000Z" } }));

  it("policy missing or identity unknown keep the case off the agent", async () => {
    expect(await admit(ticketDecision(), null, SENDER_RULE)).toMatchObject({ target: "qualification", reasons: expect.arrayContaining(["policy_missing"]) });
    expect((await admit(ticketDecision(), POLICY, null)).reasons).toEqual(expect.arrayContaining(["identity_unconfirmed", "context_incomplete"]));
  });
  it("a confirmed identity alone proves no family: still not the agent", async () => {
    const decision = await admit(ticketDecision(), POLICY, SENDER_RULE);
    expect(decision.target).not.toBe("agent");
    expect(decision.reasons).toContain("family_unknown");
    expect(decision.reasons).not.toContain("identity_unconfirmed");
  });
  it("finance alone, or finance mixed with support, goes to the team even with a confirmed identity and a proven family", async () => {
    const finance = ticketDecision(["finance"]);
    expect(await admit(finance, POLICY, SENDER_RULE)).toMatchObject({ target: "team", reasons: expect.arrayContaining(["sensitive_family"]) });
    const mixed = ticketDecision(["support", "finance"]);
    const decision = await admit(mixed, POLICY, SENDER_RULE, humanProven(mixed));
    expect(decision.target).toBe("team");
    expect(decision.reasons).toEqual(expect.arrayContaining(["sensitive_family", "mixed_sensitive"]));
  });
  it("only every positive condition together admits: valid policy, explicit adapter decision, family proven by a person", async () => {
    const decision = ticketDecision();
    expect(await admit(decision, POLICY, SENDER_RULE, humanProven(decision))).toMatchObject({ target: "agent", reasons: ["admitted"] });
    expect((await admit(decision, POLICY, null, humanProven(decision))).target).not.toBe("agent");
  });
});

describe("admission policy port: absent, expired or not yet valid admits nobody", () => {
  const NOW = new Date("2026-10-31T12:00:00.000Z");
  const record = (validFrom: string, validUntil: string, policy: unknown = POLICY) => ({ policy, validFrom, validUntil });
  const read = (value: ReturnType<typeof record> | null) => ({ read: async () => value, now: () => NOW });

  it.each([
    ["absent", null],
    ["expired", record("2026-10-01T00:00:00.000Z", "2026-10-31T11:59:59.999Z")],
    ["not yet valid", record("2026-10-31T12:00:00.001Z", "2026-11-30T00:00:00.000Z")],
    ["with an unreadable window", record("not-a-date", "2026-11-30T00:00:00.000Z")],
    ["with an inverted window", record("2026-11-30T00:00:00.000Z", "2026-10-01T00:00:00.000Z")],
  ])("%s gives null, recorded as policy_missing", async (_name, value) => {
    expect(await admissionPolicyPort(read(value))()).toBeNull();
    expect(await admissionPolicyRevisionPort(read(value))()).toBeNull();
  });
  it("a current policy is returned with its revision", async () => {
    const valid = record("2026-10-01T00:00:00.000Z", "2026-11-30T00:00:00.000Z");
    expect(await admissionPolicyPort(read(valid))()).toEqual(POLICY);
    expect(await admissionPolicyRevisionPort(read(valid))()).toBe("policy-r1");
  });
  it("a malformed current policy is passed on as policy_invalid and has no revision", async () => {
    const malformed = record("2026-10-01T00:00:00.000Z", "2026-11-30T00:00:00.000Z", { revision: "x" });
    const policy = await admissionPolicyPort(read(malformed))();
    expect(decideCaseAdmission({ policy, qualification: { requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] }, caseSensitivity: "none" }).reasons).toContain("policy_invalid");
    expect(await admissionPolicyRevisionPort(read(malformed))()).toBeNull();
  });
  it("a failed read throws", async () => {
    await expect(admissionPolicyPort({ read: async () => { throw Error("SYNTHETIC_POLICY_STORE_DOWN"); }, now: () => NOW })()).rejects.toThrow("SYNTHETIC_POLICY_STORE_DOWN");
  });
});

describe("V2 owner configuration: explicit, never invented, never the team owner", () => {
  it.each([
    ["absent", {}, "not_configured"],
    ["malformed", { SAV_V2_HUBSPOT_OWNER_ID: "owner-v2" }, "malformed"],
    ["equal to the V1 team owner", { SAV_V2_HUBSPOT_OWNER_ID: TEAM_OWNER, HUBSPOT_SAV_OWNER_ID: TEAM_OWNER }, "same_as_v1_owner"],
  ])("%s is refused", (_name, env, reason) => {
    expect(v2OwnerConfiguration(env)).toEqual({ ok: false, reason });
    expect(v2HubspotOwnerId(env)).toBeNull();
  });
  it("a distinct numeric owner is accepted", () => {
    expect(v2OwnerConfiguration(ENV)).toEqual({ ok: true, ownerId: V2_OWNER });
    expect(v2HubspotOwnerId(ENV)).toBe(V2_OWNER);
  });
});

describe("readTicketOwner port for B: unknown is never none", () => {
  const read = (owner: string | null | undefined, env: Record<string, string | undefined> = ENV) =>
    ticketOwnerPort({ readHubspotTicketOwner: async () => owner, env })({ ticketId: "201" });
  it.each([
    [undefined, "unknown"], ["not-an-id", "unknown"], [null, "none"], [V2_OWNER, "v2"], [HUMAN, "human"], [TEAM_OWNER, "human"],
  ] as const)("owner %s reads %s", async (owner, expected) => { expect(await read(owner)).toBe(expected); });
  it("without a valid V2 owner configured, nobody reads as V2", async () => {
    expect(await read(V2_OWNER, {})).toBe("human");
    expect(await read(V2_OWNER, { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, HUBSPOT_SAV_OWNER_ID: V2_OWNER })).toBe("human");
  });
  it("a failed read throws (B stops with owner_read_failed)", async () => {
    await expect(ticketOwnerPort({ readHubspotTicketOwner: async () => { throw Error("SYNTHETIC_HUBSPOT_DOWN"); }, env: ENV })({ ticketId: "201" })).rejects.toThrow("SYNTHETIC_HUBSPOT_DOWN");
  });
});

describe("safe V2 attribution: no write, a human is never taken, an existing unowned ticket stays with the team", () => {
  const waiting = { owner: "human" as const, phase: "handoff_pending" as const, sensitivity: "none" as const, body: { ...emptyCaseBody(), handoff: { reason: SAV_CASE_AWAITING_V2_ATTRIBUTION } } };
  const admitted = { target: "agent" as const, policyRevision: "policy-r1" };
  const intent = { kind: "ticket_create", properties: { subject: "Synthétique", hubspot_owner_id: V2_OWNER } };
  const receipt = (over: Partial<TicketCreateReceipt> = {}): TicketCreateReceipt => {
    const value = { executionId: EXECUTION, effectId: EFFECT, kind: "ticket_create", state: "confirmed", intent, intentHash: v1IntentHash(intent), createdTicketId: "201", verifiedOwnerId: V2_OWNER, ...over };
    return over.intent && !over.intentHash ? { ...value, intentHash: v1IntentHash(over.intent) } : value;
  };
  const base = { env: ENV, ticketId: "201", case: waiting, messageSensitivity: "none" as const, admission: admitted, currentPolicyRevision: "policy-r1" };
  const existing = (currentOwnerId: string | null | undefined, over: Partial<Parameters<typeof decideSafeV2Attribution>[0]> = {}) =>
    decideSafeV2Attribution({ ...base, route: "existing_ticket", currentOwnerId, ...over });
  const created = (value: TicketCreateReceipt | null, over: Partial<Parameters<typeof decideSafeV2Attribution>[0]> = {}) =>
    decideSafeV2Attribution({ ...base, route: "created_with_owner", currentOwnerId: V2_OWNER, receipt: value, ...over });

  it("a human owner is refused before anything else is looked at, on both routes", () => {
    expect(existing(HUMAN)).toEqual({ attribute: false, reason: "human_owner_present" });
    expect(existing(HUMAN, { admission: { target: "team", policyRevision: null } })).toEqual({ attribute: false, reason: "human_owner_present" });
  });
  it("a person taking the ticket between creation and V1's verification is a human owner (race)", () => {
    expect(created(receipt({ verifiedOwnerId: HUMAN }))).toEqual({ attribute: false, reason: "human_owner_present" });
  });
  it("an existing unowned ticket is refused: no provider conditional write is proven", () => {
    expect(existing(null)).toEqual({ attribute: false, reason: "existing_unowned_no_conditional_write" });
  });
  it.each([
    ["owner not read", undefined, "owner_unknown"], ["owner unreadable", "owner?", "owner_unknown"], ["already the V2 owner", V2_OWNER, "already_v2_owner"],
  ] as const)("existing ticket, %s: refused", (_name, owner, reason) => { expect(existing(owner)).toEqual({ attribute: false, reason }); });
  it.each([
    ["no V2 owner configured", { env: {} }, "no_v2_owner_configured"],
    ["V2 owner equal to the team owner", { env: { SAV_V2_HUBSPOT_OWNER_ID: TEAM_OWNER, HUBSPOT_SAV_OWNER_ID: TEAM_OWNER } }, "no_v2_owner_configured"],
    ["a finance or cancellation message", { messageSensitivity: "finance" as const }, "sensitive"],
    ["a sensitive case", { case: { ...waiting, sensitivity: "cancellation" as const } }, "sensitive"],
    ["a case already with the agent", { case: { ...waiting, owner: "agent" as const, phase: "queued" as const } }, "case_not_pending"],
    ["a case a person took", { case: { ...waiting, body: { ...emptyCaseBody(), handoff: { reason: "identity_unconfirmed" } } } }, "case_with_team"],
    ["an admission that is not the agent", { admission: { target: "qualification" as const, policyRevision: "policy-r1" } }, "not_admitted"],
    ["an admission on an older policy", { currentPolicyRevision: "policy-r2" }, "policy_stale"],
    ["no current policy", { currentPolicyRevision: null }, "policy_stale"],
  ])("ticket created with the V2 owner, %s: refused", (_name, over, reason) => {
    expect(created(receipt(), over)).toEqual({ attribute: false, reason });
  });
  it.each([
    ["no receipt", null, "receipt_missing"],
    ["a receipt of another effect kind", receipt({ kind: "note_create" }), "receipt_not_ticket_create"],
    ["an intent of another kind", receipt({ intent: { kind: "owner_assign", properties: { hubspot_owner_id: V2_OWNER } } }), "receipt_not_ticket_create"],
    ["an unconfirmed creation", receipt({ state: "uncertain" }), "receipt_not_confirmed"],
    ["an intent whose hash does not match", receipt({ intentHash: "f".repeat(64) }), "receipt_hash_mismatch"],
    ["a creation without the owner in it", receipt({ intent: { kind: "ticket_create", properties: {} } }), "receipt_owner_mismatch"],
    ["a creation with another owner", receipt({ intent: { kind: "ticket_create", properties: { hubspot_owner_id: TEAM_OWNER } } }), "receipt_owner_mismatch"],
    ["a receipt of another ticket", receipt({ createdTicketId: "202" }), "receipt_ticket_mismatch"],
    ["an owner HubSpot dropped (seen empty at verification)", receipt({ verifiedOwnerId: null }), "receipt_owner_not_observed"],
    ["an owner not read at verification", receipt({ verifiedOwnerId: undefined }), "owner_unknown"],
    ["a malformed execution id", receipt({ executionId: "not-a-uuid" }), "receipt_invalid"],
  ])("incoherent owner-at-creation proof, %s: refused", (_name, value, reason) => {
    expect(created(value)).toEqual({ attribute: false, reason });
  });
  it("REVIEW-A1 a human taking ownership AFTER V1 verification overrides an old creation receipt", () => {
    expect(created(receipt(), { currentOwnerId: HUMAN })).toEqual({ attribute: false, reason: "human_owner_present" });
  });
  it("REVIEW-A1 an unread current owner cannot be replaced by the historical creation owner", () => {
    expect(created(receipt(), { currentOwnerId: undefined }).attribute).toBe(false);
  });
  it("REVIEW witness current V2 owner and a consistent creation receipt still permit the pure decision", () => {
    expect(created(receipt(), { currentOwnerId: V2_OWNER }).attribute).toBe(true);
  });
  it.each([
    ["the current owner unreadable", { currentOwnerId: "owner?" }, "owner_unknown"],
    ["an unread current owner", { currentOwnerId: undefined }, "owner_unknown"],
    ["the ticket left without owner since the verification", { currentOwnerId: null }, "current_owner_not_v2"],
    ["the team owner set since the verification", { currentOwnerId: TEAM_OWNER }, "human_owner_present"],
  ])("ticket created with the V2 owner, current owner: %s: refused", (_name, over, reason) => {
    expect(created(receipt(), over)).toEqual({ attribute: false, reason });
  });
  it("only an explicit synthetic receipt, coherent end to end, is accepted", () => {
    const decision = created(receipt());
    expect(decision).toEqual({ attribute: true, proof: { kind: "hubspot_owner_at_creation", executionId: EXECUTION, effectId: EFFECT, ticketId: "201", ownerId: V2_OWNER, intentHash: v1IntentHash(intent) } });
    expect(caseOwnerAtCreationProofSchema.safeParse(decision.attribute && decision.proof).success).toBe(true);
  });
  it("nothing here touches the network", () => {
    existing(null); created(receipt());
    expect(fetch).not.toHaveBeenCalled();
  });
});
