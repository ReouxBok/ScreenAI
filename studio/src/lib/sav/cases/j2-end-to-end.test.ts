import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../gmail", () => { throw Error("GMAIL_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner, updateCaseRecord } from "./case-store";
import { SAV_CASE_INBOUND_SETTLE_SECONDS, caseDedupeKey } from "./case-types";
import { caseInvestigationStorePorts } from "./investigation-store-ports";
import { recoverFiredJ2Timers, runDueJ2Pass, scheduleJ2ForConfirmedQuestion, type J2Ports } from "./timer-store";
import type { J2ReminderEffect } from "./timer-lifecycle";

// SAV-8 x SAV-6/7 bench: real SAV-5 store (contract v7, PGlite) + C timers + B's REAL store ports (claim / release) + a SIMULATED effect ledger.
// No model is called (the model port throws if touched), no email or CRM note is sent, and the reminder TEXT is a fixture: no pole owns it yet
// (PRODUCT_QUESTIONS.md). The hand-over under test: C revalidates and returns `caseVersion`; B claims the case on exactly that version.
let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_400_000;
const POLICY = "policy-r1";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000003" };
const AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: staff.staffUserId, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const REMINDER_FIXTURE = "FIXTURE ONLY - not a approved reminder text"; // explicit placeholder, never shipped
const SENT = new Date("2026-10-28T08:00:00.000Z"), DUE = "2026-10-29T08:00:00.000Z";
const setV2Pause = async (level: "running" | "actions_paused" | "fully_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "release fictive" }) });
};
async function timered(gmail: string) {
  const ticketId = String(++ticketSeq);
  const { case: c } = await openCaseEvent({ ticketId, threadId: randomUUID(), admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: "2026-10-28T07:00:00.000Z" });
  const asked = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: { ...c.body, questions: [{ id: "q1", text: "Question fictive", factKeys: [], askedAt: SENT.toISOString(), askedInEffect: "effect-e2e" }] } });
  const timerId = randomUUID();
  const scheduled = await scheduleJ2ForConfirmedQuestion({ caseId: c.caseId, expectedVersion: asked.version, currentPolicyRevision: POLICY, questionEffectId: "effect-e2e", timerId, sentAt: SENT });
  if (!scheduled.scheduled) throw Error("not scheduled");
  return { caseId: c.caseId, ticketId, threadId: c.threadIds[0]!, timerId };
}
function simulated(initial: J2ReminderEffect = "none") {
  const ledger = new Map<string, J2ReminderEffect>(), planned: { timerId: string; text: string; caseVersion: number }[] = [];
  const ports: J2Ports = {
    reminderEffect: async (timer) => ledger.get(timer.id) ?? initial,
    budgetAvailable: async () => true,
    onConditionsMet: async ({ timer, caseVersion }) => { planned.push({ timerId: timer.id, text: REMINDER_FIXTURE, caseVersion }); ledger.set(timer.id, "planned"); },
  };
  return { ports, ledger, planned };
}
// Pole B's real ports on the real store. Only claim / release / admissionPolicyRevision are used here: touching the model fails the test.
function engine(now: () => Date) {
  const notUsed = () => { throw Error("NOT_USED_IN_J2_BENCH"); };
  const ports = caseInvestigationStorePorts({
    holder: "sav-v2-investigation", ttlSeconds: 300, scope: { locale: "fr", audience: "customer" }, pauseState: async () => "running", knowledge: async () => [],
    customerTexts: async () => ({}), revisions: notUsed as never, callModel: notUsed as never, now, admissionPolicyRevision: async () => POLICY, qualify: async () => null,
  });
  return ports;
}
const pass = (ports: J2Ports, now: string, maxEvents = 10) => runDueJ2Pass({ now: new Date(now), maxEvents, currentPolicyRevision: POLICY, ports });
const mine = <T extends { timerId: string }>(rows: T[], id: string) => rows.filter(row => row.timerId === id);
// A measures the inbound settling wait (Q4, 300 s, unchanged) from the row's REAL insertion time, so a claim made at a fixed past date
// would be "settling" as soon as the real clock passes it. This keeps the fixed dates and the gaps between them, and shifts the whole
// sequence of one test just past the wait only when the real clock has overtaken the anchor. The wait itself is never shortened.
function settledClock(anchorIso: string) {
  const shift = Math.max(0, Date.now() + (SAV_CASE_INBOUND_SETTLE_SECONDS + 60) * 1000 - Date.parse(anchorIso));
  return (iso: string) => new Date(Date.parse(iso) + shift);
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-fixture-key-only-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(async () => { vi.unstubAllEnvs(); await setV2Pause(null); await f.client.exec("UPDATE sav.case_timers SET state='cancelled', cancel_reason='new_question', cancelled_at=now() WHERE state='scheduled'"); });

describe("J2 end to end: store A + timers C + engine ports B (no model, no send)", () => {
  it("hold, then release: nothing is planned or claimed while held; at the first business slot the follow-up resumes once and B claims the exact version C hands over", async () => {
    const { caseId, timerId } = await timered("gm-e2e-hold");
    const sim = simulated();
    const clock = settledClock("2026-11-02T08:00:00.000Z");
    const b = engine(() => clock("2026-11-02T08:00:00.000Z"));
    await b.admissionPolicyRevision();
    await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "technical_hold", actor: { type: "system" }, commandKey: "cmd-e2e-hold", reason: "incident" });
    expect(mine((await pass(sim.ports, "2026-10-29T09:00:00.000Z")).outcomes, timerId)).toEqual([]); // due while held
    expect(sim.planned).toEqual([]);
    expect(await b.claim(caseId, (await readCase(caseId))!.version)).toEqual({ refused: "admission" }); // owner is not the agent: B cannot decide either
    await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "hold_release", to: "agent", actor: staff, commandKey: "cmd-e2e-rel", reason: "fixture", admission: ADMITTED });
    expect(await readCase(caseId)).toMatchObject({ owner: "agent", phase: "awaiting_customer" }); // v8: back in its wait, same J2
    expect(mine((await pass(sim.ports, "2026-10-31T10:00:00.000Z")).outcomes, timerId)).toEqual([]); // Saturday: no slot, no burst
    const monday = mine((await pass(sim.ports, "2026-11-02T08:00:00.000Z")).outcomes, timerId);
    expect(monday).toMatchObject([{ fired: true, revalidation: { status: "timer_conditions_met" } }]);
    const handed = (monday[0]!.revalidation as { caseVersion: number }).caseVersion;
    expect(handed).toBe((await readCase(caseId))!.version);
    const claim = await b.claim(caseId, handed);
    expect(claim).toMatchObject({ token: expect.any(String) });
    await b.release(caseId, (claim as { token: string }).token);
    expect(sim.planned).toEqual([{ timerId, text: REMINDER_FIXTURE, caseVersion: handed }]);
    expect(await listCaseTimers(caseId)).toMatchObject([{ state: "fired", dueAt: DUE }]);
  });

  it("a customer reply during a pause ends the follow-up: after the pause nothing is planned, and B must wait for the reply to settle", async () => {
    const { caseId, ticketId, threadId, timerId } = await timered("gm-e2e-reply");
    const sim = simulated();
    await setV2Pause("fully_paused");
    expect(await pass(sim.ports, "2026-10-29T09:00:00.000Z")).toEqual({ outcomes: [], paused: true });
    await openCaseEvent({ ticketId, threadId, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound("gm-e2e-reply-2"), sourceRef: { type: "email", id: "gm-e2e-reply-2" }, occurredAt: "2026-10-29T10:00:00.000Z" });
    expect((await listCaseTimers(caseId))[0]).toMatchObject({ id: timerId, state: "cancelled", cancelReason: "customer_inbound", dueAt: DUE });
    await setV2Pause("running");
    expect(mine((await pass(sim.ports, "2026-11-02T08:00:00.000Z")).outcomes, timerId)).toEqual([]);
    expect(sim.planned).toEqual([]);
    const version = (await readCase(caseId))!.version;
    // A measures the 5-minute wait (Q4) from the row's insertion time, not from the mail's date: use the real clock.
    const arrived = Date.now();
    const early = engine(() => new Date(arrived + 60_000)); await early.admissionPolicyRevision();
    expect(await early.claim(caseId, version)).toMatchObject({ refused: "settling", retryAt: expect.any(String) });
    const later = engine(() => new Date(arrived + 6 * 60_000)); await later.admissionPolicyRevision();
    const claim = await later.claim(caseId, version);
    expect(claim).toMatchObject({ token: expect.any(String) });
    await later.release(caseId, (claim as { token: string }).token);
  });

  it("a fully paused agent plans nothing and B cannot claim; the pause is not a cancellation and the follow-up is still there", async () => {
    const { caseId, timerId } = await timered("gm-e2e-pause");
    const sim = simulated();
    await setV2Pause("fully_paused");
    expect(await pass(sim.ports, "2026-10-29T09:00:00.000Z")).toEqual({ outcomes: [], paused: true });
    const b = engine(() => new Date("2026-10-29T09:00:00.000Z")); await b.admissionPolicyRevision();
    expect(await b.claim(caseId, (await readCase(caseId))!.version)).toMatchObject({ refused: "paused" });
    expect(sim.planned).toEqual([]);
    expect((await listCaseTimers(caseId))[0]).toMatchObject({ id: timerId, state: "scheduled", dueAt: DUE, cancelReason: null });
  });

  it("actions_paused: B CAN claim (A grants it, flagged actionsPaused: true) but C still plans and sends nothing - the follow-up is an action", async () => {
    const { caseId, timerId } = await timered("gm-e2e-actions-paused");
    const sim = simulated();
    await setV2Pause("actions_paused");
    expect(await pass(sim.ports, "2026-10-29T09:00:00.000Z")).toEqual({ outcomes: [], paused: true });
    const clock = settledClock("2026-10-29T09:00:00.000Z");
    const b = engine(() => clock("2026-10-29T09:00:00.000Z")); await b.admissionPolicyRevision();
    const claim = await b.claim(caseId, (await readCase(caseId))!.version);
    // B 6e21548: the claim port now carries A's `actionsPaused` read under the case lock (it used to be dropped, which this bench first showed).
    expect(claim).toEqual({ token: expect.any(String), actionsPaused: true });
    expect(sim.planned).toEqual([]);
    expect((await listCaseTimers(caseId))[0]).toMatchObject({ id: timerId, state: "scheduled", cancelReason: null });
  });

  it("a crash after the claim and before the release: recovery plans nothing twice, never refires; the stuck lease blocks B until it expires", async () => {
    const { caseId, timerId } = await timered("gm-e2e-crash");
    const sim = simulated();
    const first = mine((await pass(sim.ports, "2026-10-29T08:30:00.000Z")).outcomes, timerId);
    expect(first).toMatchObject([{ fired: true, revalidation: { status: "timer_conditions_met" } }]);
    const handed = (first[0]!.revalidation as { caseVersion: number }).caseVersion;
    const clock = settledClock("2026-10-29T08:31:00.000Z");
    const crashed = engine(() => clock("2026-10-29T08:31:00.000Z")); await crashed.admissionPolicyRevision();
    expect(await crashed.claim(caseId, handed)).toMatchObject({ token: expect.any(String) }); // ...and the process dies here: no release
    const restart = await recoverFiredJ2Timers({ now: new Date("2026-10-29T08:32:00.000Z"), firedSince: new Date("2026-10-29T00:00:00.000Z"), limit: 50, currentPolicyRevision: POLICY, ports: sim.ports });
    expect(mine(restart, timerId)).toMatchObject([{ fired: true, revalidation: { status: "timer_conditions_met" } }]);
    expect(sim.planned.filter(p => p.timerId === timerId)).toHaveLength(1); // planned once across the crash
    expect((await listCaseEvents(caseId)).filter(e => e.kind === "timer_fired")).toHaveLength(1);
    const during = engine(() => clock("2026-10-29T08:33:00.000Z")); await during.admissionPolicyRevision();
    expect(await during.claim(caseId, (await readCase(caseId))!.version)).toMatchObject({ refused: "busy" });
    const after = engine(() => clock("2026-10-29T08:37:00.000Z")); await after.admissionPolicyRevision(); // lease 300 s expired
    expect(await after.claim(caseId, (await readCase(caseId))!.version)).toMatchObject({ token: expect.any(String) });
  });

  it("an effect that may already have left (dispatched / uncertain / failed) is only verified: no new plan, no claim handed over", async () => {
    for (const effect of ["dispatched", "uncertain", "failed"] as const) {
      const { caseId, timerId } = await timered(`gm-e2e-${effect}`);
      const sim = simulated(effect);
      const out = mine((await pass(sim.ports, "2026-10-29T08:30:00.000Z")).outcomes, timerId);
      expect(out).toMatchObject([{ fired: true, revalidation: { status: "verify_only" } }]);
      expect(sim.planned).toEqual([]);
      expect((await listCaseTimers(caseId))[0]).toMatchObject({ state: "fired" });
    }
  });

  it("resume after a technical pause: the due date is kept and the reminder is planned ONCE even when two passes and a recovery run together", async () => {
    const { caseId, timerId } = await timered("gm-e2e-resume-once");
    // The effect ledger must be atomic per timer (SAV-10 unique key). This fake claims the key synchronously, like a unique index would.
    const keys = new Set<string>(), planned: string[] = [];
    const ports: J2Ports = {
      reminderEffect: async (timer) => keys.has(timer.key) ? "planned" : "none",
      budgetAvailable: async () => true,
      onConditionsMet: async ({ timer }) => { if (keys.has(timer.key)) return; keys.add(timer.key); planned.push(timer.id); },
    };
    await setV2Pause("fully_paused");
    expect(await pass(ports, "2026-10-29T09:00:00.000Z")).toEqual({ outcomes: [], paused: true });
    expect(await pass(ports, "2026-10-30T09:00:00.000Z")).toEqual({ outcomes: [], paused: true });
    expect((await listCaseTimers(caseId))[0]).toMatchObject({ id: timerId, state: "scheduled", dueAt: DUE, cancelReason: null });
    await setV2Pause("running");
    const recover = () => recoverFiredJ2Timers({ now: new Date("2026-11-02T08:00:00.000Z"), firedSince: new Date("2026-10-29T00:00:00.000Z"), limit: 50, currentPolicyRevision: POLICY, ports });
    const [a, b, c] = await Promise.all([pass(ports, "2026-11-02T08:00:00.000Z"), pass(ports, "2026-11-02T08:00:00.000Z"), recover()]);
    expect([...a.outcomes, ...b.outcomes].filter(o => o.timerId === timerId && o.fired)).toHaveLength(1);
    expect(mine(c, timerId).every(o => o.fired)).toBe(true);
    expect(planned.filter(id => id === timerId)).toHaveLength(1);
    expect((await listCaseEvents(caseId)).filter(e => e.kind === "timer_fired")).toHaveLength(1);
    expect((await listCaseTimers(caseId))[0]).toMatchObject({ state: "fired", dueAt: DUE });
  });

  it("a person taking the case over after the firing makes the follow-up obsolete: nothing is planned", async () => {
    const { caseId, timerId } = await timered("gm-e2e-takeover");
    const sim = simulated();
    const noPlan: J2Ports = { ...sim.ports, onConditionsMet: undefined }; // the firing happens, the planning is what must not follow
    const fired = mine((await pass(noPlan, "2026-10-29T08:30:00.000Z")).outcomes, timerId);
    expect(fired).toMatchObject([{ fired: true }]);
    await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "human_takeover", actor: staff, commandKey: "cmd-e2e-take", reason: "fixture" });
    const sim2 = simulated();
    const recovered = mine(await recoverFiredJ2Timers({ now: new Date("2026-10-29T08:40:00.000Z"), firedSince: new Date("2026-10-29T00:00:00.000Z"), limit: 50, currentPolicyRevision: POLICY, ports: sim2.ports }), timerId);
    expect(recovered).toMatchObject([{ revalidation: { status: "obsolete" } }]);
    expect(sim2.planned.filter(p => p.timerId === timerId)).toEqual([]);
    expect(sim.planned).toEqual([]);
  });
});
