import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../gmail", () => { throw Error("GMAIL_IMPORTED"); });
import { appendCaseEvent, listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { recordConfirmedCaseReply } from "./case-effect-outcomes";
import { nextJ2Slot } from "./j2-calendar";

// SAV-10 x SAV-8: what the case records once a reply is CONFIRMED. Real SAV-5 store (PGlite); no Gmail, no HubSpot, no model.
let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 9_100_000;
const POLICY = "policy-r1";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000003" };
const AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: staff.staffUserId, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const SENT = new Date("2026-10-28T08:00:00.000Z"); // Wednesday morning, Paris
/** The case version a person saw when the case was opened by the customer's mail: a proposal is prepared on THAT version, not on a constant. */
const seenVersion = new Map<string, number>();
async function opened(gmail: string) {
  const ticketId = String(++ticketSeq);
  const { case: c } = await openCaseEvent({ ticketId, threadId: randomUUID(), admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: "2026-10-28T07:00:00.000Z" });
  seenVersion.set(c.caseId, c.version);
  return { caseId: c.caseId, ticketId, threadId: c.threadIds[0]! };
}
const proposalFor = (caseId: string, purpose: CaseReplyProposal["purpose"], trigger: string): CaseReplyProposal => ({
  caseId, caseVersion: seenVersion.get(caseId) ?? 1, triggerEventId: trigger, inboundMessageId: randomUUID(), purpose, recipient: "customer@example.invalid", subject: "Synthetic", text: "SYNTHETIC text.",
  ...(purpose === "question" ? { question: { id: "q1", text: "SYNTHETIC question?", factKeys: [] } } : {}),
});
const confirmed = (proposal: CaseReplyProposal, effectId: string, gmailMessageId: string) => ({ proposal, effectId, gmailMessageId, gmailThreadId: "gmail-thread", sentAt: SENT, currentPolicyRevision: POLICY });

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-fixture-key-only-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("a CONFIRMED question schedules the case's wait and its J2 exactly once", () => {
  it("records the outbound mail, the question against the sending effect, then one J2 at the first slot 24 h later", async () => {
    const { caseId } = await opened("gm-out-1");
    const proposal = proposalFor(caseId, "question", "inbound:gm-out-1");
    expect(caseReplyPayloadHash(proposal)).toMatch(/^[a-f0-9]{64}$/);
    const outcome = await recordConfirmedCaseReply(confirmed(proposal, "effect-q-1", "sent-1"));
    expect(outcome).toEqual({ event: "appended", question: "recorded", j2: "scheduled" });
    const snapshot = (await readCase(caseId))!;
    expect(snapshot).toMatchObject({ owner: "agent", phase: "awaiting_customer" });
    expect(snapshot.body.questions).toMatchObject([{ id: "q1", askedInEffect: "effect-q-1", askedAt: SENT.toISOString() }]);
    expect(await listCaseTimers(caseId)).toMatchObject([{ state: "scheduled", questionEffectId: "effect-q-1", sentAt: SENT.toISOString(), dueAt: nextJ2Slot(SENT).toISOString() }]);
    expect((await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed")).toMatchObject([{ direction: "agent_outbound", dedupeKey: "outbound:sent-1" }]);
  });

  it("a second wake, a retry or a recovery of the same confirmed reply changes nothing: one event, one question, one timer", async () => {
    const { caseId } = await opened("gm-out-2");
    const proposal = proposalFor(caseId, "question", "inbound:gm-out-2");
    await recordConfirmedCaseReply(confirmed(proposal, "effect-q-2", "sent-2"));
    const version = (await readCase(caseId))!.version;
    for (let i = 0; i < 3; i += 1) {
      expect(await recordConfirmedCaseReply(confirmed(proposal, "effect-q-2", "sent-2"))).toEqual({ event: "already_recorded", question: "already_recorded", j2: "already_scheduled" });
    }
    expect((await readCase(caseId))!.version).toBe(version);
    expect(await listCaseTimers(caseId)).toHaveLength(1);
    expect((await readCase(caseId))!.body.questions).toHaveLength(1);
  });

  it("a crash after the journal entry (or after the question) is completed by the next pass, never repeated", async () => {
    const { caseId } = await opened("gm-out-3");
    const proposal = proposalFor(caseId, "question", "inbound:gm-out-3");
    await appendCaseEvent({ caseId, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: "outbound:sent-3", sourceRef: { type: "email", id: "sent-3" }, occurredAt: SENT.toISOString() });
    expect(await recordConfirmedCaseReply(confirmed(proposal, "effect-q-3", "sent-3"))).toEqual({ event: "already_recorded", question: "recorded", j2: "scheduled" });
    expect((await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed")).toHaveLength(1);
    expect(await listCaseTimers(caseId)).toHaveLength(1);
  });

  it("an outbound agent mail neither cancels the wait of an earlier question nor stales the admission", async () => {
    const { caseId } = await opened("gm-out-4");
    await recordConfirmedCaseReply(confirmed(proposalFor(caseId, "question", "inbound:gm-out-4"), "effect-q-4", "sent-4"));
    const before = (await readCase(caseId))!;
    await recordConfirmedCaseReply(confirmed(proposalFor(caseId, "answer", "inbound:gm-out-4b"), "effect-a-4", "sent-4b"));
    const after = (await readCase(caseId))!;
    expect(after.admissionInputVersion).toBe(before.admissionInputVersion);
    expect((await listCaseTimers(caseId)).map(timer => timer.state)).toEqual(["scheduled"]);
  });
});

describe("what a confirmed reply does NOT do", () => {
  it("an answer records the mail and nothing else: no question, no wait, no J2", async () => {
    const { caseId } = await opened("gm-ans-1");
    expect(await recordConfirmedCaseReply(confirmed(proposalFor(caseId, "answer", "inbound:gm-ans-1"), "effect-a-1", "sent-a1"))).toEqual({ event: "appended", question: "not_applicable", j2: "not_applicable" });
    expect(await listCaseTimers(caseId)).toEqual([]);
    expect((await readCase(caseId))!.body.questions).toEqual([]);
  });

  it("a J2 reminder records the mail and schedules no second J2 (one reminder per question)", async () => {
    const { caseId } = await opened("gm-rem-1");
    await recordConfirmedCaseReply(confirmed(proposalFor(caseId, "question", "inbound:gm-rem-1"), "effect-q-5", "sent-5"));
    const timers = await listCaseTimers(caseId);
    expect(await recordConfirmedCaseReply(confirmed(proposalFor(caseId, "reminder", `timer:${timers[0]!.id}`), "effect-r-5", "sent-r5"))).toEqual({ event: "appended", question: "not_applicable", j2: "not_applicable" });
    expect(await listCaseTimers(caseId)).toHaveLength(1);
  });

  it("a customer message recorded after the version the question was prepared on means no J2 even when Gmail dated it BEFORE the mail left; the question and the mail stay on record", async () => {
    const { caseId, ticketId, threadId } = await opened("gm-late-0");
    // dated before the question left (`confirmed` sends at 08:00 on the 28th), but recorded after the version the person saw
    await openCaseEvent({ ticketId, threadId, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("gm-late-0b"), sourceRef: { type: "email", id: "gm-late-0b" }, occurredAt: "2026-10-28T07:59:00.000Z" });
    const outcome = await recordConfirmedCaseReply(confirmed(proposalFor(caseId, "question", "inbound:gm-late-0"), "effect-q-6b", "sent-6b"));
    expect(outcome.event).toBe("appended");
    expect(outcome.question).toBe("recorded");
    expect(outcome.j2).toMatchObject({ refused: expect.stringMatching(/^(input_newer|inbound_after_question)$/) });
    expect(await listCaseTimers(caseId)).toEqual([]);
  });

  it("a customer reply that arrived after the question left means no J2, while the question and the mail stay on record", async () => {
    const { caseId, ticketId, threadId } = await opened("gm-late-1");
    await openCaseEvent({ ticketId, threadId, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("gm-late-1b"), sourceRef: { type: "email", id: "gm-late-1b" }, occurredAt: "2026-10-28T08:30:00.000Z" });
    const outcome = await recordConfirmedCaseReply(confirmed(proposalFor(caseId, "question", "inbound:gm-late-1"), "effect-q-6", "sent-6"));
    expect(outcome.event).toBe("appended");
    expect(outcome.question).toBe("recorded");
    expect(outcome.j2).toMatchObject({ refused: expect.stringMatching(/^(input_newer|inbound_after_question)$/) });
    expect(await listCaseTimers(caseId)).toEqual([]);
  });

  it("a person took the case after the send left: the mail stays in the journal, the agent writes nothing more, no J2", async () => {
    const { caseId } = await opened("gm-owner-1");
    await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "human_takeover", actor: staff, commandKey: "cmd-takeover-1", reason: "fixture" });
    const outcome = await recordConfirmedCaseReply(confirmed(proposalFor(caseId, "question", "inbound:gm-owner-1"), "effect-q-7", "sent-7"));
    expect(outcome).toEqual({ event: "appended", question: { refused: "owner_not_agent" }, j2: { refused: "owner_not_agent" } });
    expect((await readCase(caseId))!.body.questions).toEqual([]);
    expect(await listCaseTimers(caseId)).toEqual([]);
  });

  it("a question reply without the question it asked is refused, so no J2 can exist without a recorded question", async () => {
    const { caseId } = await opened("gm-noq-1");
    const withoutQuestion: CaseReplyProposal = { ...proposalFor(caseId, "question", "inbound:gm-noq-1"), question: undefined };
    await expect(recordConfirmedCaseReply(confirmed(withoutQuestion, "effect-q-8", "sent-8"))).rejects.toThrow("SAV_CASE_EFFECT_QUESTION_MISSING");
    expect(await listCaseTimers(caseId)).toEqual([]);
  });
});
