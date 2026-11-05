import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown, beforeFire: null as null | ((timerId: string) => Promise<void>) }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../gmail", () => { throw Error("GMAIL_IMPORTED"); });
// The real store, with one hook: something can happen to the case between the due read and the firing, the exact window of a race.
vi.mock("./case-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("./case-store")>();
  return { ...original, fireCaseTimer: async (input: Parameters<typeof original.fireCaseTimer>[0]) => { await state.beforeFire?.(input.timerId); return original.fireCaseTimer(input); } };
});
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner, updateCaseRecord } from "./case-store";
import { caseDedupeKey } from "./case-types";
import type { J2Ports } from "./timer-store";
import { runDueJ2Pass, scheduleJ2ForConfirmedQuestion } from "./timer-store";

// SAV-8 races against the real SAV-5 store (contract v7) on PGlite. Simulated reminder only: nothing is sent.
let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_300_000;
const POLICY = "policy-r1";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000002" };
const AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: staff.staffUserId, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const SENT = new Date("2026-10-28T08:00:00.000Z"), DUE = "2026-10-29T08:00:00.000Z", NOW = "2026-10-29T08:30:00.000Z";
async function timered(gmail: string) {
  const ticketId = String(++ticketSeq);
  const { case: c } = await openCaseEvent({ ticketId, threadId: randomUUID(), admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: "2026-10-28T07:00:00.000Z" });
  const asked = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, questions: [{ id: "q1", text: "Question fictive", factKeys: [], askedAt: SENT.toISOString(), askedInEffect: "effect-race" }] } });
  const timerId = randomUUID();
  const scheduled = await scheduleJ2ForConfirmedQuestion({ caseId: c.caseId, expectedVersion: asked.version, currentPolicyRevision: POLICY, questionEffectId: "effect-race", timerId, sentAt: SENT });
  if (!scheduled.scheduled) throw Error("not scheduled");
  return { caseId: c.caseId, timerId };
}
function simulated() {
  const planned: string[] = [];
  const ports: J2Ports = { reminderEffect: async () => "none", budgetAvailable: async () => true, onConditionsMet: async ({ timer }) => { planned.push(timer.id); } };
  return { ports, planned };
}
const pass = (ports: J2Ports, now = NOW) => runDueJ2Pass({ now: new Date(now), maxEvents: 10, currentPolicyRevision: POLICY, ports });

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-fixture-key-only-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(async () => { state.beforeFire = null; vi.unstubAllEnvs(); await f.client.exec("UPDATE sav.case_timers SET state='cancelled', cancel_reason='new_question', cancelled_at=now() WHERE state='scheduled'"); });

describe("races between the due read and the firing", () => {
  it("a hold that lands in that window fires nothing, keeps the timer, plans nothing; the next pass after the release fires it once", async () => {
    const { caseId, timerId } = await timered("gm-race-hold");
    const sim = simulated();
    state.beforeFire = async (id) => {
      if (id !== timerId) return;
      state.beforeFire = null;
      await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "technical_hold", actor: { type: "system" }, commandKey: "cmd-race-hold", reason: "incident" });
    };
    const first = await pass(sim.ports);
    expect(first.outcomes.filter(o => o.timerId === timerId)).toMatchObject([{ fired: false, revalidation: { status: "deferred", reasons: ["organizational_hold"], notBefore: null } }]);
    expect((await listCaseTimers(caseId))[0]).toMatchObject({ state: "scheduled", dueAt: DUE });
    expect(sim.planned).toEqual([]);
    expect((await listCaseEvents(caseId)).some(e => e.kind === "timer_fired")).toBe(false);
    await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "hold_release", to: "agent", actor: staff, commandKey: "cmd-race-rel", reason: "fixture", admission: ADMITTED });
    const second = await pass(sim.ports, "2026-10-29T09:00:00.000Z");
    expect(second.outcomes.filter(o => o.timerId === timerId)).toMatchObject([{ fired: true, revalidation: { status: "timer_conditions_met" } }]);
    expect(sim.planned).toEqual([timerId]);
  });

  it("a customer reply that lands in that window wins: the timer is cancelled, nothing is fired or planned", async () => {
    const { caseId, timerId } = await timered("gm-race-reply");
    const sim = simulated();
    state.beforeFire = async (id) => {
      if (id !== timerId) return;
      state.beforeFire = null;
      const c = (await readCase(caseId))!;
      await openCaseEvent({ ticketId: c.ticketId, threadId: c.threadIds[0]!, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("gm-race-reply-2"), sourceRef: { type: "email", id: "gm-race-reply-2" }, occurredAt: "2026-10-29T08:10:00.000Z" });
    };
    const result = await pass(sim.ports);
    expect(result.outcomes.filter(o => o.timerId === timerId)).toMatchObject([{ fired: false, revalidation: { status: "not_fired" } }]);
    expect((await listCaseTimers(caseId))[0]).toMatchObject({ state: "cancelled", cancelReason: "customer_inbound" });
    expect(sim.planned).toEqual([]);
    expect((await listCaseEvents(caseId)).filter(e => e.kind === "timer_fired")).toHaveLength(0);
  });

  it("two passes at the same time fire the timer once: one timer_fired event, one planned reminder", async () => {
    const { caseId, timerId } = await timered("gm-race-double");
    const sim = simulated();
    const [a, b] = await Promise.all([pass(sim.ports), pass(sim.ports)]);
    const mine = [...a.outcomes, ...b.outcomes].filter(o => o.timerId === timerId);
    expect(mine.filter(o => o.fired)).toHaveLength(1);
    expect((await listCaseEvents(caseId)).filter(e => e.kind === "timer_fired")).toHaveLength(1);
    expect(sim.planned.filter(id => id === timerId)).toHaveLength(1);
  });
});
