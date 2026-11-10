import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// The decision reads the case only: importing a HubSpot module from it fails the file.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
import type { SavIntakeDecision } from "../intake/contract";
import { caseAdmissionStatus, type CaseAdmissionInput } from "./admission-policy";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCaseByTicket, scheduleCaseTimer, transitionCaseOwner, updateCaseRecord } from "./case-store";
import { caseDedupeKey, type CaseAdmissionQualification } from "./case-types";
import { decideHumanRequeueWindow, decideV2OwnerAttribution, observeTicketCrmChange, observeTicketOwner, v2HubspotOwnerId, v2OwnerAttributionPort, type HumanRequeueWindow } from "./owner-attribution";

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 7_400_000;
const ticket = () => String(++ticketSeq);
const V2 = "90000001", HUMAN = "70000001", AT = "2026-10-28T09:00:00.000Z";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000001" };
const POLICY = { revision: "policy-r1", admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT };
const qualified = (family: "access" | "finance" | "unknown"): CaseAdmissionQualification => ({
  requests: [{ requestId: "r1", family, provenance: { kind: "human", staffUserId: staff.staffUserId, at: AT } }],
  identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [],
});
const ADMITTED: CaseAdmissionInput = { policy: POLICY, qualification: qualified("access") };
const NO_POLICY: CaseAdmissionInput = { policy: null, qualification: qualified("access") };
const support = { classification: "support", requests: [{ kind: "support" }] } as unknown as Pick<SavIntakeDecision, "classification" | "requests">;
const mixed = { classification: "support", requests: [{ kind: "support" }, { kind: "finance" }] } as unknown as Pick<SavIntakeDecision, "classification" | "requests">;
const cancellation = { classification: "cancellation", requests: [{ kind: "cancellation" }] } as unknown as Pick<SavIntakeDecision, "classification" | "requests">;
const env = { SAV_V2_HUBSPOT_OWNER_ID: V2 };
const open = (ticketId: string, gmail: string, admission: CaseAdmissionInput = ADMITTED) => openCaseEvent({
  ticketId, threadId: randomUUID(), admission, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: AT,
});

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-fixture-key-only-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("V2 HubSpot owner attribution, decided by the server only (contract v9 §4)", () => {
  const ADMIT = { target: "agent" as const, reasons: ["admitted" as const] }, QUALIFY = { target: "qualification" as const, reasons: ["identity_unconfirmed" as const] };
  const decide = (patch: Partial<Parameters<typeof decideV2OwnerAttribution>[0]> = {}) =>
    decideV2OwnerAttribution({ v2OwnerId: V2, currentOwnerId: null, decision: support, case: null, admission: ADMIT, ...patch });
  it("reads the V2 owner id as a parameter: absent or malformed means no attribution at all", async () => {
    expect(v2HubspotOwnerId({})).toBeNull();
    expect(v2HubspotOwnerId({ SAV_V2_HUBSPOT_OWNER_ID: "agent-v2" })).toBeNull();
    expect(v2HubspotOwnerId(env)).toBe(V2);
    const signal = new AbortController().signal, readTicketOwner = vi.fn(async () => null);
    expect(await v2OwnerAttributionPort({ messageId: randomUUID(), deps: { env: { SAV_CASE_RECORDING: "on" }, readTicketOwner } })({ ticketId: ticket(), decision: support, signal }))
      .toEqual({ assign: false, reason: "no_v2_owner_configured" });
    expect(await v2OwnerAttributionPort({ messageId: randomUUID(), deps: { env: { ...env, SAV_CASE_RECORDING: "off" }, readTicketOwner } })({ ticketId: ticket(), decision: support, signal }))
      .toEqual({ assign: false, reason: "recording_off" });
    expect(readTicketOwner).not.toHaveBeenCalled();
    expect(await v2OwnerAttributionPort({ messageId: randomUUID(), deps: { env: { ...env, SAV_CASE_RECORDING: "on" }, readTicketOwner } })({ ticketId: ticket(), decision: support, signal }))
      .toEqual({ assign: false, reason: "source_missing" });
  });
  it("assigns an unowned ticket with no case yet, or one whose case still waits, on an admission decided now", async () => {
    expect(decide()).toEqual({ assign: true, ownerId: V2 });
    const { case: waiting } = await openCaseEvent({ ticketId: ticket(), threadId: randomUUID(), admission: ADMITTED, attribution: "pending", kind: "inbound_confirmed",
      dedupeKey: caseDedupeKey.inbound("gm-own-wait"), sourceRef: { type: "email", id: "gm-own-wait" }, occurredAt: AT });
    expect(waiting).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "awaiting_v2_attribution" } } });
    expect(decide({ case: waiting })).toEqual({ assign: true, ownerId: V2 });
    expect(decide({ admission: QUALIFY })).toEqual({ assign: false, reason: "not_admitted", admission: "identity_unconfirmed" });
  });
  it("never captures a human owner, a sensitive or mixed mail, an agent case a person unassigned, or a team case", async () => {
    const { case: agent } = await open(ticket(), "gm-own-agent");
    const { case: team } = await open(ticket(), "gm-own-team", NO_POLICY);
    const ticketId = ticket();
    const { case: waiting } = await openCaseEvent({ ticketId, threadId: randomUUID(), admission: ADMITTED, attribution: "pending", kind: "inbound_confirmed",
      dedupeKey: caseDedupeKey.inbound("gm-own-taken"), sourceRef: { type: "email", id: "gm-own-taken" }, occurredAt: AT });
    const taken = await transitionCaseOwner({ caseId: waiting.caseId, expectedVersion: waiting.version, transition: "human_takeover", actor: staff, commandKey: "own-taken", reason: "manual" });
    const refusals = [
      [{ currentOwnerId: HUMAN }, "human_owner_present"],
      [{ currentOwnerId: V2 }, "already_v2_owner"],
      [{ currentOwnerId: undefined }, "owner_unknown"],
      [{ decision: mixed }, "sensitive"],
      [{ decision: cancellation }, "sensitive"],
      [{ case: agent }, "case_not_pending"],
      [{ case: team }, "case_with_team"],
      [{ case: taken.case }, "case_with_team"],
      [{ v2OwnerId: null }, "no_v2_owner_configured"],
    ] as const;
    for (const [patch, reason] of refusals) expect([reason, decide(patch)]).toMatchObject([reason, { assign: false, reason }]);
    // The human owner wins over everything else, « Nouveau » included (the status is no input).
    expect(decide({ currentOwnerId: HUMAN, case: waiting })).toMatchObject({ reason: "human_owner_present" });
  });
  it("refuses the v2_attribution transition as a command: only V1's verified effect, through the relay, attributes", async () => {
    const { case: waiting } = await openCaseEvent({ ticketId: ticket(), threadId: randomUUID(), admission: ADMITTED, attribution: "pending", kind: "inbound_confirmed",
      dedupeKey: caseDedupeKey.inbound("gm-own-cmd"), sourceRef: { type: "email", id: "gm-own-cmd" }, occurredAt: AT });
    await expect(transitionCaseOwner({ caseId: waiting.caseId, expectedVersion: waiting.version, transition: "v2_attribution", actor: { type: "system" }, commandKey: "forged", reason: "forged", admission: ADMITTED }))
      .rejects.toThrow("SAV_CASE_TRANSITION_FORBIDDEN");
    // A made-up proof (no such V1 effect) attributes nothing either.
    const forged = { kind: "hubspot_owner_verified" as const, executionId: randomUUID(), effectId: randomUUID(), ticketId: waiting.ticketId, ownerId: V2 };
    const replay = await openCaseEvent({ ticketId: waiting.ticketId, threadId: randomUUID(), admission: ADMITTED, attribution: forged, kind: "inbound_confirmed",
      dedupeKey: caseDedupeKey.inbound("gm-own-cmd-2"), sourceRef: { type: "email", id: "gm-own-cmd-2" }, occurredAt: AT });
    expect(replay.case).toMatchObject({ owner: "human", body: { handoff: { reason: "awaiting_v2_attribution" } } });
  });
});

describe("HubSpot owner or stage changed without a mail (contract v9 §5)", () => {
  it("turns a human owner on an agent case into a takeover once, cancelling its J2 timer, and never hands back on seeing the V2 owner", async () => {
    const ticketId = ticket(), { case: c } = await open(ticketId, "gm-take");
    const SENT = "2026-10-28T09:30:00.000Z", question = { id: "q1", text: "Question fictive", factKeys: [], askedAt: SENT, askedInEffect: "effect-1" };
    const asked = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, questions: [question] } });
    const timerId = randomUUID();
    expect(await scheduleCaseTimer({ caseId: c.caseId, expectedVersion: asked.version, currentPolicyRevision: "policy-r1", reasonCode: "j2_question", timer: { id: timerId, questionEffectId: "effect-1", sentAt: SENT, dueAt: "2026-10-30T09:00:00.000Z" } })).toMatchObject({ scheduled: true });
    const own = await observeTicketOwner({ ticketId, observedOwnerId: V2, hubspotUpdatedAt: "2026-10-28T10:00:00.000Z", env });
    expect(own).toMatchObject({ recorded: true, takeover: false, case: { owner: "agent" } });
    const taken = await observeTicketOwner({ ticketId, observedOwnerId: HUMAN, hubspotUpdatedAt: "2026-10-28T11:00:00.000Z", env });
    expect(taken).toMatchObject({ recorded: true, takeover: true, case: { owner: "human", phase: "human_owned" } });
    expect(await observeTicketOwner({ ticketId, observedOwnerId: HUMAN, hubspotUpdatedAt: "2026-10-28T11:00:00.000Z", env })).toMatchObject({ recorded: false, takeover: false });
    expect(await listCaseTimers(c.caseId)).toMatchObject([{ id: timerId, state: "cancelled", cancelReason: "owner_changed" }]);
    // The V2 owner seen again later gives nothing back: hand_back needs a human and a fresh admission.
    const back = await observeTicketOwner({ ticketId, observedOwnerId: V2, hubspotUpdatedAt: "2026-10-28T12:00:00.000Z", env });
    expect(back).toMatchObject({ takeover: false, case: { owner: "human" } });
    const human = (await readCaseByTicket(ticketId))!;
    await expect(transitionCaseOwner({ caseId: human.caseId, expectedVersion: human.version, transition: "hand_back", actor: staff, commandKey: "back-none", reason: "manual" })).rejects.toThrow("SAV_CASE_ADMISSION_REQUIRED");
    const handed = await transitionCaseOwner({ caseId: human.caseId, expectedVersion: human.version, transition: "hand_back", actor: staff, commandKey: "back-ok", reason: "manual", admission: ADMITTED });
    expect(caseAdmissionStatus(handed.case, "policy-r1")).toEqual({ admitted: true });
    expect((await listCaseEvents(c.caseId)).filter(e => e.kind === "crm_observed").map(e => e.detail)).toEqual([
      { crmChange: "owner_changed", owner: "v2", outOfOrder: false }, { crmChange: "owner_changed", owner: "human", outOfOrder: false }, { crmChange: "owner_changed", owner: "v2", outOfOrder: false },
    ]);
  });
  it("takes the case from the agent when a person removes the V2 owner, and from a waiting case when a person takes the ticket", async () => {
    const ticketId = ticket();
    await open(ticketId, "gm-removed");
    expect(await observeTicketCrmChange({ ticketId, ownerId: null, hubspotUpdatedAt: "2026-10-28T10:00:00.000Z", env })).toMatchObject({ takeover: true, case: { owner: "human", phase: "human_owned" } });
    const owner = (await listCaseEvents((await readCaseByTicket(ticketId))!.caseId)).filter(e => e.kind === "owner_changed").at(-1);
    expect(owner?.detail).toMatchObject({ transition: "human_takeover", reason: "hubspot_owner_removed", actor: { type: "system" } });
    const waitingTicket = ticket();
    await openCaseEvent({ ticketId: waitingTicket, threadId: randomUUID(), admission: ADMITTED, attribution: "pending", kind: "inbound_confirmed",
      dedupeKey: caseDedupeKey.inbound("gm-wait-take"), sourceRef: { type: "email", id: "gm-wait-take" }, occurredAt: AT });
    const taken = await observeTicketCrmChange({ ticketId: waitingTicket, ownerId: HUMAN, hubspotUpdatedAt: "2026-10-28T10:00:00.000Z", env });
    expect(taken).toMatchObject({ takeover: true, case: { owner: "human", phase: "human_owned", body: { handoff: { reason: "awaiting_v2_attribution", humanSince: expect.any(String) } } } });
    expect(decideV2OwnerAttribution({ v2OwnerId: V2, currentOwnerId: null, decision: support, case: (await readCaseByTicket(waitingTicket))!, admission: { target: "agent", reasons: ["admitted"] } }))
      .toMatchObject({ assign: false, reason: "case_with_team" });
  });
  it("keeps a late, older change and a duplicate without moving the case, and replays no mail on a stage change", async () => {
    const ticketId = ticket(), { case: c } = await open(ticketId, "gm-order");
    const requestsBefore = c.body.openRequests;
    expect(await observeTicketCrmChange({ ticketId, ownerId: V2, stage: "1", hubspotUpdatedAt: "2026-10-28T12:00:00.000Z", env })).toMatchObject({ recorded: true, outOfOrder: false, takeover: false });
    // Delivered late: a human owner older than the V2 owner already seen. Kept, moves nothing.
    expect(await observeTicketCrmChange({ ticketId, ownerId: HUMAN, hubspotUpdatedAt: "2026-10-28T11:00:00.000Z", env })).toMatchObject({ recorded: true, outOfOrder: true, takeover: false, case: { owner: "agent" } });
    expect(await observeTicketCrmChange({ ticketId, ownerId: V2, stage: "1", hubspotUpdatedAt: "2026-10-28T12:00:00.000Z", env })).toMatchObject({ recorded: false, takeover: false });
    const status = await observeTicketCrmChange({ ticketId, stage: "1", hubspotUpdatedAt: "2026-10-28T13:00:00.000Z", env });
    expect(status).toMatchObject({ recorded: true, takeover: false, case: { owner: "agent" } });
    const events = await listCaseEvents(c.caseId);
    expect(events.filter(e => e.kind === "inbound_confirmed")).toHaveLength(1);
    expect(events.filter(e => e.kind === "crm_observed").map(e => [e.dedupeKey, e.detail])).toEqual([
      [`crm:${ticketId}:${Date.parse("2026-10-28T12:00:00.000Z")}`, { crmChange: "owner_changed", owner: "v2", stage: "1", outOfOrder: false }],
      [`crm:${ticketId}:${Date.parse("2026-10-28T11:00:00.000Z")}`, { crmChange: "owner_changed", owner: "human", outOfOrder: true }],
      [`crm:${ticketId}:${Date.parse("2026-10-28T13:00:00.000Z")}`, { crmChange: "status_changed", owner: "unknown", stage: "1", outOfOrder: false }],
    ]);
    expect((await readCaseByTicket(ticketId))!.body.openRequests).toEqual(requestsBefore);
    await expect(observeTicketCrmChange({ ticketId, stage: "Nouveau ticket client", hubspotUpdatedAt: "2026-10-28T14:00:00.000Z", env })).rejects.toThrow("SAV_CASE_CRM_STAGE_INVALID");
  });
  it("keeps a human case human and records nothing without a case or while recording is off", async () => {
    const ticketId = ticket();
    expect(await observeTicketOwner({ ticketId, observedOwnerId: HUMAN, hubspotUpdatedAt: AT, env })).toEqual({ recorded: false, reason: "no_case" });
    await open(ticketId, "gm-take-team", NO_POLICY);
    expect(await observeTicketOwner({ ticketId, observedOwnerId: HUMAN, hubspotUpdatedAt: AT, env })).toMatchObject({ takeover: false, case: { owner: "human" } });
    vi.stubEnv("SAV_CASE_RECORDING", "off");
    expect(await observeTicketOwner({ ticketId, observedOwnerId: HUMAN, hubspotUpdatedAt: "2026-10-28T13:00:00.000Z", env })).toEqual({ recorded: false, reason: "recording_off" });
  });
});

describe("Friday noon to Sunday evening: central decision point, inactive until specified", () => {
  // Hypothetical window for the tests only; Sunday's end hour is Ugo's to give.
  const WINDOW: HumanRequeueWindow = { timeZone: "Europe/Paris", start: { isoDay: 5, time: "12:00" }, end: { isoDay: 7, time: "20:00" } };
  const human = { operation: "requeue_new" as const, ticketOwner: "human" as const };
  it("defers nothing without a configured window", () => {
    expect(decideHumanRequeueWindow({ now: new Date("2026-10-31T10:00:00.000Z"), window: null, ...human })).toEqual({ defer: false, reason: "window_unconfigured" });
  });
  it("defers only a human ticket's return to « Nouveau » inside the window, in Paris time across the clock change", () => {
    // Friday 30/10 11:59 and 12:00 Paris (UTC+1 after the 25/10 change).
    expect(decideHumanRequeueWindow({ now: new Date("2026-10-30T10:59:00.000Z"), window: WINDOW, ...human })).toMatchObject({ defer: false, reason: "outside_window" });
    expect(decideHumanRequeueWindow({ now: new Date("2026-10-30T11:00:00.000Z"), window: WINDOW, ...human })).toEqual({ defer: true, reason: "inside_window" });
    expect(decideHumanRequeueWindow({ now: new Date("2026-11-01T18:59:00.000Z"), window: WINDOW, ...human })).toMatchObject({ defer: true });
    expect(decideHumanRequeueWindow({ now: new Date("2026-11-01T19:00:00.000Z"), window: WINDOW, ...human })).toMatchObject({ defer: false, reason: "outside_window" });
    for (const operation of ["receive", "attach", "create"] as const)
      expect(decideHumanRequeueWindow({ now: new Date("2026-10-31T10:00:00.000Z"), window: WINDOW, operation, ticketOwner: "human" })).toEqual({ defer: false, reason: "operation_not_deferrable" });
    for (const ticketOwner of ["v2", "none"] as const)
      expect(decideHumanRequeueWindow({ now: new Date("2026-10-31T10:00:00.000Z"), window: WINDOW, operation: "requeue_new", ticketOwner })).toEqual({ defer: false, reason: "not_human_ticket" });
    expect(() => decideHumanRequeueWindow({ now: new Date(), window: { ...WINDOW, end: { isoDay: 8, time: "20:00" } }, ...human })).toThrow("SAV_REQUEUE_WINDOW_INVALID");
  });
});
