import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Nothing here may reach HubSpot or Gmail: importing either module from the J2 coupling fails the file.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../gmail", () => { throw Error("GMAIL_IMPORTED"); });
import { appendCaseEvent, fireCaseTimer, listCaseEvents, listCaseTimers, openCaseEvent, readCase, readCaseDiagnostics, scheduleCaseTimer, transitionCaseOwner, updateCaseRecord } from "./case-store";
import { encryptSavPayload } from "../crypto";
import { SAV_CASE_TIMER_CANCEL_REASONS, caseDedupeKey, caseTimerKey, type CaseEvent, type CaseSnapshot, type CaseTimer } from "./case-types";
import { nextJ2Slot } from "./j2-calendar";
import { applyJ2Signal, type J2CaseEventView, type J2CaseView, type J2ReminderEffect, type J2Timer } from "./timer-lifecycle";
import { j2PausesFromAgentPause, listDueScheduledJ2Timers, recoverFiredJ2Timers, revalidateJ2Timer, runDueJ2Pass, scheduleJ2ForConfirmedQuestion, type J2Ports } from "./timer-store";

// SAV-8 coupling to the real SAV-5 store (contract v6) on PGlite. The email and the note are SIMULATED: an in-memory ledger stands for the
// SAV-10 effect ledger, and nothing leaves the process.

// The pure views are structural supertypes of the storage types, and the timer record is the storage type itself. tsc checks these lines.
const _snapshot = (value: CaseSnapshot): J2CaseView => value;
const _event = (value: CaseEvent): J2CaseEventView => value;
const _timerIn = (value: CaseTimer): J2Timer => value;
const _timerOut = (value: J2Timer): CaseTimer => value;
void [_snapshot, _event, _timerIn, _timerOut];

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_200_000;
const ticket = () => String(++ticketSeq);
const POLICY = "policy-r1";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000001" };
const AT = "2026-10-27T09:00:00.000Z";
const RECEIVED = "2026-10-27T08:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: staff.staffUserId, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const inbound = (ticketId: string, gmailId: string, occurredAt = RECEIVED) => openCaseEvent({
  ticketId, threadId: randomUUID(), admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailId), sourceRef: { type: "email", id: gmailId }, occurredAt,
});
const setV2Pause = async (level: "running" | "actions_paused" | "fully_paused" | null, raw?: string) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (raw !== undefined) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed", cursor: raw });
  else if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "release fictive" }) });
};

// Wed 28 Oct 2026 09:00 Paris (CET since Oct 25). J2 = Thu 29 Oct 09:00 Paris = 08:00Z.
const SENT = new Date("2026-10-28T08:00:00.000Z");
const DUE = "2026-10-29T08:00:00.000Z";
async function asked(gmail: string, sentAt = SENT, effect = "effect-j2") {
  const ticketId = ticket(), { case: c } = await inbound(ticketId, gmail);
  const question = { id: `q-${effect}`, text: "Question fictive", factKeys: [], askedAt: sentAt.toISOString(), askedInEffect: effect };
  const withQuestion = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, questions: [...c.body.questions, question] } });
  return { ticketId, c: withQuestion };
}
async function timered(gmail: string, sentAt = SENT, effect = "effect-j2") {
  const { c } = await asked(gmail, sentAt, effect);
  const timerId = randomUUID();
  const result = await scheduleJ2ForConfirmedQuestion({ caseId: c.caseId, expectedVersion: c.version, currentPolicyRevision: POLICY, questionEffectId: effect, timerId, sentAt });
  if (!result.scheduled) throw Error(`not scheduled: ${result.reason}`);
  return { caseId: c.caseId, timerId, timer: result.timer, version: result.case.version };
}

// Simulated effect ledger + planner. Records what WOULD be planned; the real ledger and every send belong to SAV-10.
function simulated(overrides: Partial<J2Ports> = {}) {
  const ledger = new Map<string, J2ReminderEffect>(), planned: { timerId: string; email: string; note: string; caseVersion: number }[] = [];
  const ports: J2Ports = {
    reminderEffect: async (timer) => ledger.get(timer.id) ?? "none",
    budgetAvailable: async () => true,
    onConditionsMet: async ({ timer, caseVersion }) => { planned.push({ timerId: timer.id, email: "simulated reminder email", note: "simulated CRM note", caseVersion }); ledger.set(timer.id, "planned"); },
    ...overrides,
  };
  return { ports, ledger, planned };
}
const pass = (now: string, ports: J2Ports, maxEvents = 10) => runDueJ2Pass({ now: new Date(now), maxEvents, currentPolicyRevision: POLICY, ports });
const timerOf = async (caseId: string) => (await listCaseTimers(caseId))[0]!;

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-fixture-key-only-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(async () => { vi.unstubAllEnvs(); await setV2Pause(null); await f.client.exec("UPDATE sav.case_timers SET state='cancelled', cancel_reason='new_question', cancelled_at=now() WHERE state='scheduled'"); });

describe("types and calendar come from one place", () => {
  it("uses the storage cancellation reasons and key format, with no second definition", () => {
    const signals = ["customer_inbound", "owner_changed", "human_outbound", "admission_withdrawn", "new_question"] as const;
    for (const reason of signals) expect(SAV_CASE_TIMER_CANCEL_REASONS).toContain(reason);
    expect(SAV_CASE_TIMER_CANCEL_REASONS).not.toContain("pause");
    expect(caseTimerKey("c", "e")).toBe("timer:j2:c:e");
  });
  it("schedules at nextJ2Slot(sentAt), links the case waiting block, and never recomputes the due date", async () => {
    const { caseId, timerId, timer } = await timered("gm-ts-sched");
    expect(nextJ2Slot(SENT).toISOString()).toBe(DUE);
    expect(timer).toMatchObject({ id: timerId, dueAt: DUE, sentAt: SENT.toISOString(), state: "scheduled", key: caseTimerKey(caseId, "effect-j2") });
    expect((await readCase(caseId))!).toMatchObject({ phase: "awaiting_customer", body: { waiting: { kind: "customer", timerId, dueAt: DUE } } });
  });
  it("a question sent on Friday afternoon is due on Monday at 09:00 Paris, not on the Saturday", async () => {
    const friday = new Date("2026-10-30T14:00:00.000Z"); // Fri 15:00 Paris
    const { timer } = await timered("gm-ts-fri", friday);
    expect(timer.dueAt).toBe("2026-11-02T08:00:00.000Z"); // Mon 09:00 Paris
  });
  it("an unconfirmed send schedules nothing: the caller only reaches the store with a confirmed question", async () => {
    const { c } = await asked("gm-ts-unconfirmed");
    expect(await listCaseTimers(c.caseId)).toEqual([]);
  });
});

describe("the pure signals and the SQL store agree (no divergent copy)", () => {
  async function storeReason(signal: "customer_inbound" | "human_outbound" | "owner_changed" | "new_question") {
    const { c } = await asked(`gm-diff-${signal}`);
    const timerId = randomUUID();
    await scheduleJ2ForConfirmedQuestion({ caseId: c.caseId, expectedVersion: c.version, currentPolicyRevision: POLICY, questionEffectId: "effect-j2", timerId, sentAt: SENT });
    const before = await timerOf(c.caseId);
    const afterAsk = (await readCase(c.caseId))!;
    if (signal === "customer_inbound") await openCaseEvent({ ticketId: c.ticketId, threadId: c.threadIds[0]!, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("gm-diff-reply"), sourceRef: { type: "email", id: "gm-diff-reply" }, occurredAt: "2026-10-28T12:00:00.000Z" });
    if (signal === "human_outbound") await appendCaseEvent({ caseId: c.caseId, kind: "outbound_observed", direction: "human_outbound", dedupeKey: caseDedupeKey.outbound("gm-diff-out"), sourceRef: { type: "email", id: "gm-diff-out" }, occurredAt: "2026-10-28T12:00:00.000Z" });
    if (signal === "owner_changed") await transitionCaseOwner({ caseId: c.caseId, expectedVersion: afterAsk.version, transition: "human_takeover", actor: staff, commandKey: "cmd-diff-owner", reason: "manual" });
    if (signal === "new_question") {
      const second = await updateCaseRecord({ caseId: c.caseId, expectedVersion: afterAsk.version, actor: { type: "agent" }, body: { ...afterAsk.body, questions: [...afterAsk.body.questions, { id: "q2", text: "Autre", factKeys: [], askedAt: "2026-10-28T12:00:00.000Z", askedInEffect: "effect-2" }] } });
      await scheduleJ2ForConfirmedQuestion({ caseId: c.caseId, expectedVersion: second.version, currentPolicyRevision: POLICY, questionEffectId: "effect-2", timerId: randomUUID(), sentAt: new Date("2026-10-28T12:00:00.000Z") });
    }
    const stored = (await listCaseTimers(c.caseId)).find(t => t.id === timerId)!;
    const pure = applyJ2Signal([before], signal === "new_question" ? { kind: "new_question", caseId: c.caseId, questionEffectId: "effect-2" } : { kind: signal, caseId: c.caseId }, new Date("2026-10-28T12:00:00.000Z"));
    return { stored, pure: pure.timers[0]! };
  }
  for (const signal of ["customer_inbound", "human_outbound", "owner_changed", "new_question"] as const) {
    it(`${signal}: same final state, same reason, due date untouched`, async () => {
      const { stored, pure } = await storeReason(signal);
      expect(stored).toMatchObject({ state: "cancelled", cancelReason: pure.cancelReason, dueAt: pure.dueAt });
      expect(pure.cancelReason).toBe(signal);
    });
  }
});

describe("the due pass (pause, business slot, no burst, simulated reminder)", () => {
  it("does nothing before the due date, then fires once and plans one simulated email + note on the exact case version", async () => {
    const { caseId, timerId } = await timered("gm-pass-1");
    const sim = simulated();
    expect((await pass("2026-10-29T07:59:59.000Z", sim.ports)).outcomes).toEqual([]);
    expect((await timerOf(caseId)).state).toBe("scheduled");
    const first = await pass("2026-10-29T08:30:00.000Z", sim.ports);
    expect(first.outcomes).toHaveLength(1);
    const fired = await timerOf(caseId), events = await listCaseEvents(caseId);
    expect(fired).toMatchObject({ state: "fired", firedAt: "2026-10-29T08:30:00.000Z", dueAt: DUE });
    expect(events.filter(e => e.kind === "timer_fired")).toHaveLength(1);
    expect(first.outcomes[0]).toMatchObject({ timerId, fired: true, revalidation: { status: "timer_conditions_met", caseVersion: (await readCase(caseId))!.version } });
    expect(sim.planned).toEqual([{ timerId, email: "simulated reminder email", note: "simulated CRM note", caseVersion: (await readCase(caseId))!.version }]);
    // A second pass finds nothing to fire and plans nothing again.
    expect((await pass("2026-10-29T09:30:00.000Z", sim.ports)).outcomes).toEqual([]);
    expect(sim.planned).toHaveLength(1);
  });
  it("a technical pause keeps question, timer and due date; the follow-up resumes at the first business slot, once", async () => {
    const { caseId, timerId } = await timered("gm-pass-pause");
    const sim = simulated();
    await setV2Pause("fully_paused");
    const during = await pass("2026-10-29T12:00:00.000Z", sim.ports);
    expect(during).toEqual({ outcomes: [], paused: true });
    expect(await timerOf(caseId)).toMatchObject({ id: timerId, state: "scheduled", dueAt: DUE, cancelReason: null });
    expect((await readCase(caseId))!.body.questions.map(q => q.askedInEffect)).toEqual(["effect-j2"]);
    await setV2Pause("running");
    expect((await pass("2026-10-31T10:00:00.000Z", sim.ports)).outcomes).toEqual([]); // Saturday: no business slot
    expect(await timerOf(caseId)).toMatchObject({ state: "scheduled", dueAt: DUE });
    const monday = await pass("2026-11-02T08:00:00.000Z", sim.ports); // Monday 09:00 Paris
    expect(monday.outcomes).toHaveLength(1);
    expect(await timerOf(caseId)).toMatchObject({ state: "fired", dueAt: DUE });
    expect(sim.planned.map(p => p.timerId)).toEqual([timerId]);
  });
  it("actions_paused and an unreadable pause state also suspend; neither cancels", async () => {
    const { caseId } = await timered("gm-pass-modes");
    const sim = simulated();
    await setV2Pause("actions_paused");
    expect((await pass("2026-10-29T12:00:00.000Z", sim.ports)).outcomes).toEqual([]);
    await setV2Pause(null, "not-a-valid-encrypted-payload");
    expect(await pass("2026-10-29T12:00:00.000Z", sim.ports)).toEqual({ outcomes: [], paused: true });
    expect(await timerOf(caseId)).toMatchObject({ state: "scheduled", cancelReason: null });
    expect(j2PausesFromAgentPause({ level: "fully_paused", invalid: true })).toEqual([{ from: new Date(0).toISOString(), to: null, cause: "unknown" }]);
    expect(j2PausesFromAgentPause({ level: "running", invalid: false })).toEqual([]);
  });
  it("a backlog after a pause is released in bounded batches, oldest first, each timer once", async () => {
    const made: Awaited<ReturnType<typeof timered>>[] = [];
    for (let i = 0; i < 5; i += 1) made.push(await timered(`gm-pass-burst-${i}`, SENT, `effect-burst-${i}`));
    const sim = simulated();
    const batches = [] as number[];
    for (let i = 0; i < 4; i += 1) batches.push((await pass("2026-10-29T09:00:00.000Z", sim.ports, 2)).outcomes.filter(o => made.some(m => m.timerId === o.timerId)).length);
    expect(batches).toEqual([2, 2, 1, 0]);
    expect(new Set(sim.planned.map(p => p.timerId)).size).toBe(5);
    expect(sim.planned).toHaveLength(5);
  });
  it("a customer reply before the pass cancels the timer: nothing fires, nothing is planned", async () => {
    const { caseId, timerId } = await timered("gm-pass-reply");
    const c = (await readCase(caseId))!;
    await openCaseEvent({ ticketId: c.ticketId, threadId: c.threadIds[0]!, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("gm-pass-reply-2"), sourceRef: { type: "email", id: "gm-pass-reply-2" }, occurredAt: "2026-10-29T07:00:00.000Z" });
    const sim = simulated();
    expect((await pass("2026-10-29T08:30:00.000Z", sim.ports)).outcomes).toEqual([]);
    expect(await timerOf(caseId)).toMatchObject({ id: timerId, state: "cancelled", cancelReason: "customer_inbound", dueAt: DUE });
    expect(sim.planned).toEqual([]);
    expect(await fireCaseTimer({ timerId, now: new Date("2026-10-29T08:30:00.000Z") })).toMatchObject({ fired: false });
  });
  it("only a due, scheduled timer is listed", async () => {
    const { timerId } = await timered("gm-pass-list");
    expect((await listDueScheduledJ2Timers(new Date("2026-10-29T07:59:59.000Z"), 10)).some(t => t.id === timerId)).toBe(false);
    expect((await listDueScheduledJ2Timers(new Date("2026-10-29T08:00:00.000Z"), 10)).some(t => t.id === timerId)).toBe(true);
    await expect(listDueScheduledJ2Timers(new Date(), 0)).rejects.toThrow("limit");
  });
});

describe("revalidation and recovery after the timer has fired", () => {
  const fireOnly = async (timerId: string) => fireCaseTimer({ timerId, now: new Date("2026-10-29T08:30:00.000Z") });
  it("a crash between the firing and the planning loses nothing: recovery plans once and never refires", async () => {
    const { caseId, timerId } = await timered("gm-rec-crash");
    expect(await fireOnly(timerId)).toMatchObject({ fired: true });
    const sim = simulated();
    const args = { now: new Date("2026-10-29T09:00:00.000Z"), firedSince: new Date("2026-10-29T00:00:00.000Z"), limit: 50, currentPolicyRevision: POLICY, ports: sim.ports };
    const first = (await recoverFiredJ2Timers(args)).filter(o => o.timerId === timerId);
    expect(first).toMatchObject([{ revalidation: { status: "timer_conditions_met" } }]);
    await recoverFiredJ2Timers(args);
    expect(sim.planned.filter(p => p.timerId === timerId)).toHaveLength(1);
    expect((await listCaseEvents(caseId)).filter(e => e.kind === "timer_fired")).toHaveLength(1);
    expect((await recoverFiredJ2Timers({ ...args, firedSince: new Date("2026-10-30T00:00:00.000Z") })).filter(o => o.timerId === timerId)).toEqual([]);
  });
  for (const effect of ["dispatched", "uncertain", "failed"] as const) {
    it(`a reminder effect that is ${effect} is verify-only: never planned again`, async () => {
      const { caseId, timerId } = await timered(`gm-rec-${effect}`);
      await fireOnly(timerId);
      const sim = simulated(); sim.ledger.set(timerId, effect);
      const result = await revalidateJ2Timer({ timerId, caseId, currentPolicyRevision: POLICY, now: new Date("2026-10-29T09:00:00.000Z"), ports: sim.ports });
      expect(result).toMatchObject({ status: "verify_only", effect });
      expect(sim.planned).toEqual([]);
    });
  }
  it("a confirmed reminder makes the timer obsolete, and an unknown ledger value is treated as uncertain", async () => {
    const { caseId, timerId } = await timered("gm-rec-confirmed");
    await fireOnly(timerId);
    const confirmed = simulated(); confirmed.ledger.set(timerId, "confirmed");
    const now = new Date("2026-10-29T09:00:00.000Z");
    expect(await revalidateJ2Timer({ timerId, caseId, currentPolicyRevision: POLICY, now, ports: confirmed.ports })).toMatchObject({ status: "obsolete", reasons: ["reminder_already_sent"] });
    const unknown = simulated({ reminderEffect: async () => "mystery" as J2ReminderEffect });
    expect(await revalidateJ2Timer({ timerId, caseId, currentPolicyRevision: POLICY, now, ports: unknown.ports })).toMatchObject({ status: "verify_only", effect: "uncertain" });
    expect(unknown.planned).toEqual([]);
  });
  it("a budget that is not available defers without cancelling; the same timer is planned once when it comes back", async () => {
    const { caseId, timerId } = await timered("gm-rec-budget");
    await fireOnly(timerId);
    let available = false;
    const sim = simulated({ budgetAvailable: async () => available });
    const now = new Date("2026-10-29T09:00:00.000Z");
    expect(await revalidateJ2Timer({ timerId, caseId, currentPolicyRevision: POLICY, now, ports: sim.ports })).toMatchObject({ status: "deferred", reasons: ["budget_unavailable"] });
    expect(sim.planned).toEqual([]);
    available = true;
    expect(await revalidateJ2Timer({ timerId, caseId, currentPolicyRevision: POLICY, now, ports: sim.ports })).toMatchObject({ status: "timer_conditions_met" });
    expect(sim.planned).toHaveLength(1);
  });
  it("a rotated admission policy postpones; a missing admission is a final withdrawal; neither plans", async () => {
    const { caseId, timerId } = await timered("gm-rec-policy");
    await fireOnly(timerId);
    const sim = simulated(), now = new Date("2026-10-29T09:00:00.000Z");
    expect(await revalidateJ2Timer({ timerId, caseId, currentPolicyRevision: "policy-r2", now, ports: sim.ports })).toMatchObject({ status: "deferred", reasons: ["admission_unavailable"] });
    expect(await revalidateJ2Timer({ timerId, caseId, currentPolicyRevision: null, now, ports: sim.ports })).toMatchObject({ status: "deferred", reasons: ["admission_unavailable"] });
    expect(sim.planned).toEqual([]);
  });
  it("a human taking the case over after the firing makes the follow-up obsolete", async () => {
    const { caseId, timerId, version } = await timered("gm-rec-takeover");
    await fireOnly(timerId);
    const current = (await readCase(caseId))!;
    expect(current.version).toBeGreaterThan(version);
    await transitionCaseOwner({ caseId, expectedVersion: current.version, transition: "human_takeover", actor: staff, commandKey: "cmd-rec-takeover", reason: "manual" });
    const sim = simulated();
    expect(await revalidateJ2Timer({ timerId, caseId, currentPolicyRevision: POLICY, now: new Date("2026-10-29T09:00:00.000Z"), ports: sim.ports }))
      .toMatchObject({ status: "obsolete", reasons: expect.arrayContaining(["owner_not_agent"]) });
    expect(sim.planned).toEqual([]);
  });
  it("revalidating a timer that has not fired answers not_fired and plans nothing", async () => {
    const { caseId, timerId } = await timered("gm-rec-notfired");
    const sim = simulated();
    expect(await revalidateJ2Timer({ timerId, caseId, currentPolicyRevision: POLICY, now: new Date("2026-10-29T09:00:00.000Z"), ports: sim.ports })).toEqual({ status: "not_fired" });
    expect(sim.planned).toEqual([]);
  });
});

describe("Q9 on contract v7 (Ugo, 2026-10-28): a technical or organisational hold keeps the J2, a person taking over cancels it", () => {
  const owner = (caseId: string, version: number, transition: "technical_hold" | "organisational_hold" | "admin_hold", key: string, actor: typeof staff | { type: "system" } = staff) =>
    transitionCaseOwner({ caseId, expectedVersion: version, transition, actor, commandKey: key, reason: "fixture" });
  const release = async (caseId: string, key: string, to: "agent" | "human" = "agent") =>
    transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "hold_release", to, actor: staff, commandKey: key, reason: "fixture", ...(to === "agent" ? { admission: ADMITTED } : {}) });
  const holdNow = async (caseId: string, key: string, transition: "technical_hold" | "organisational_hold" = "technical_hold") =>
    owner(caseId, (await readCase(caseId))!.version, transition, key, transition === "technical_hold" ? { type: "system" } : staff);

  it("a hold keeps timer and due date; the pass skips the held case and the held backlog cannot starve a case that can fire", async () => {
    const held = await timered("gm-q9-held");
    const other = await timered("gm-q9-other", new Date("2026-10-28T09:00:00.000Z"), "effect-other"); // due Thu 10:00 Paris, later than the held one
    await holdNow(held.caseId, "cmd-q9-held");
    expect(await timerOf(held.caseId)).toMatchObject({ state: "scheduled", dueAt: DUE, cancelReason: null });
    expect(await fireCaseTimer({ timerId: held.timerId, now: new Date("2026-10-29T08:30:00.000Z") })).toMatchObject({ fired: false, reason: "case_on_hold", timer: { state: "scheduled" } });
    const listed = (await listDueScheduledJ2Timers(new Date("2026-10-29T09:30:00.000Z"), 1)).map(t => t.id);
    expect(listed).toEqual([other.timerId]); // the older held timer would have filled the whole batch
    const sim = simulated();
    const result = await pass("2026-10-29T09:30:00.000Z", sim.ports, 1);
    expect(result.outcomes.map(o => o.timerId)).toEqual([other.timerId]);
    expect(await timerOf(held.caseId)).toMatchObject({ state: "scheduled", dueAt: DUE });
    expect(sim.planned.map(p => p.timerId)).toEqual([other.timerId]);
  });

  it("an organisational hold is the same: kept, never fired, never planned while held", async () => {
    const { caseId, timerId } = await timered("gm-q9-org");
    await holdNow(caseId, "cmd-q9-org", "organisational_hold");
    const sim = simulated();
    expect((await pass("2026-10-29T08:30:00.000Z", sim.ports)).outcomes.filter(o => o.timerId === timerId)).toEqual([]);
    expect(await timerOf(caseId)).toMatchObject({ state: "scheduled", dueAt: DUE });
    expect(sim.planned).toEqual([]);
  });

  it("released to the agent: the same follow-up resumes at the first business slot, once, with its original due date", async () => {
    const { caseId, timerId } = await timered("gm-q9-resume");
    await holdNow(caseId, "cmd-q9-resume-hold");
    const released = await release(caseId, "cmd-q9-resume-rel");
    // Contract v8 (A cfa2c37): the released case is back in its wait, with the same J2 (waiting block and due date unchanged).
    expect(released.case.phase).toBe("awaiting_customer");
    expect(released.case.owner).toBe("agent");
    const sim = simulated();
    expect((await pass("2026-10-31T10:00:00.000Z", sim.ports)).outcomes.filter(o => o.timerId === timerId)).toEqual([]); // Saturday
    const monday = await pass("2026-11-02T08:00:00.000Z", sim.ports); // Monday 09:00 Paris
    const mine = monday.outcomes.filter(o => o.timerId === timerId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ fired: true, revalidation: { status: "timer_conditions_met", caseVersion: (await readCase(caseId))!.version } });
    expect(await timerOf(caseId)).toMatchObject({ state: "fired", dueAt: DUE });
    expect(sim.planned.filter(p => p.timerId === timerId)).toHaveLength(1);
    expect((await pass("2026-11-02T08:05:00.000Z", sim.ports)).outcomes.filter(o => o.timerId === timerId)).toEqual([]);
    expect(sim.planned.filter(p => p.timerId === timerId)).toHaveLength(1);
  });

  it("many cases released together do not produce a burst: bounded batches, each timer once", async () => {
    const cases = [] as Awaited<ReturnType<typeof timered>>[];
    for (let i = 0; i < 3; i += 1) cases.push(await timered(`gm-q9-burst-${i}`, SENT, `effect-q9-burst-${i}`));
    for (const [i, c] of cases.entries()) await holdNow(c.caseId, `cmd-q9-burst-hold-${i}`);
    for (const [i, c] of cases.entries()) await release(c.caseId, `cmd-q9-burst-rel-${i}`);
    const sim = simulated();
    const mine = (r: Awaited<ReturnType<typeof pass>>) => r.outcomes.filter(o => cases.some(c => c.timerId === o.timerId)).length;
    expect([mine(await pass("2026-11-02T08:00:00.000Z", sim.ports, 2)), mine(await pass("2026-11-02T08:00:00.000Z", sim.ports, 2)), mine(await pass("2026-11-02T08:00:00.000Z", sim.ports, 2))]).toEqual([2, 1, 0]);
    expect(new Set(sim.planned.map(p => p.timerId)).size).toBe(3);
    expect(sim.planned).toHaveLength(3);
  });

  it("a customer reply during the hold still ends the follow-up: nothing fires after the release", async () => {
    const { caseId, timerId } = await timered("gm-q9-reply");
    await holdNow(caseId, "cmd-q9-reply-hold");
    const c = (await readCase(caseId))!;
    await openCaseEvent({ ticketId: c.ticketId, threadId: c.threadIds[0]!, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("gm-q9-reply-2"), sourceRef: { type: "email", id: "gm-q9-reply-2" }, occurredAt: "2026-10-29T07:00:00.000Z" });
    expect(await timerOf(caseId)).toMatchObject({ id: timerId, state: "cancelled", cancelReason: "customer_inbound", dueAt: DUE });
    await release(caseId, "cmd-q9-reply-rel");
    const sim = simulated();
    expect((await pass("2026-11-02T08:00:00.000Z", sim.ports)).outcomes.filter(o => o.timerId === timerId)).toEqual([]);
    expect(sim.planned.filter(p => p.timerId === timerId)).toEqual([]);
  });

  it("released to a person (a personal takeover) cancels the old follow-up for good", async () => {
    const { caseId, timerId } = await timered("gm-q9-person");
    await holdNow(caseId, "cmd-q9-person-hold", "organisational_hold");
    await release(caseId, "cmd-q9-person-rel", "human");
    expect(await timerOf(caseId)).toMatchObject({ id: timerId, state: "cancelled", cancelReason: "owner_changed", dueAt: DUE });
    const sim = simulated();
    expect((await pass("2026-11-02T08:00:00.000Z", sim.ports)).outcomes.filter(o => o.timerId === timerId)).toEqual([]);
    expect(sim.planned).toEqual([]);
  });

  it("admin_hold, which mixed both causes, is refused as a new command and cancels nothing", async () => {
    const { caseId, timerId } = await timered("gm-q9-admin");
    await expect(owner(caseId, (await readCase(caseId))!.version, "admin_hold", "cmd-q9-admin")).rejects.toThrow("SAV_CASE_TRANSITION_RETIRED");
    expect(await timerOf(caseId)).toMatchObject({ id: timerId, state: "scheduled", cancelReason: null });
  });

  it("diagnostics say the follow-up is suspended by the hold, and not by the pause", async () => {
    const { caseId } = await timered("gm-q9-diag");
    const c = (await readCase(caseId))!;
    await holdNow(caseId, "cmd-q9-diag-hold");
    expect(await readCaseDiagnostics(c.ticketId)).toMatchObject({ followUp: { state: "scheduled", dueAt: DUE, suspendedByHold: true, suspendedByPause: false } });
  });
});

describe("what this coupling does not do", () => {
  it("the case store has no way to create a timer the pure model would not schedule", async () => {
    const { c } = await asked("gm-no-1");
    await expect(scheduleCaseTimer({ caseId: c.caseId, expectedVersion: c.version, currentPolicyRevision: POLICY, reasonCode: "j2_question",
      timer: { id: randomUUID(), questionEffectId: "effect-j2", sentAt: SENT.toISOString(), dueAt: SENT.toISOString() } })).rejects.toThrow("TIMER_INVALID");
  });
});
