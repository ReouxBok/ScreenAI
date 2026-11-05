import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// No external service and no model: importing one fails the file, and fetch is a spy that must stay silent.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../gmail", () => { throw Error("GMAIL_IMPORTED"); });
import type { CaseAdmissionInput } from "./admission-policy";
import { listCaseEvents, listCaseIdsForPolicyRevalidation, listCaseTimers, openCaseEvent, readCase, scheduleCaseTimer, transitionCaseOwner, updateCaseRecord } from "./case-store";
import { caseDedupeKey, caseEventIsAdmissionInput, caseRequestId, SAV_CASE_CONTRACT_REVISION, type CaseAdmissionQualification, type CaseSnapshot } from "./case-types";
import { sweepCaseAdmissionsAfterPolicyChange, type CaseAdmissionSweepPorts } from "./investigation-policy-sweep";
import { runCaseInvestigation } from "./investigation-runner";
import { caseAdmissionSweepStorePorts, caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * SAV-7 sweep after an approved policy change (Q10), on the real pole A store (PGlite, contract v7). Synthetic data only.
 * Policy r1 admits `usage` by rule-usage r1; r2 keeps it and adds `access`; r3 drops `usage`.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_300_000;
const STAFF = "20000000-0000-4000-8000-000000000002", AT = "2026-10-27T09:00:00.000Z";
const rule = { ruleId: "rule-usage", revision: "r1", families: ["usage"] as const };
const policy = (revision: string, families: string[], rules = [rule]) => ({ revision, admittedFamilies: families, qualifiedRules: rules, approvedBy: STAFF, approvedAt: AT });
const R1 = policy("policy-r1", ["usage"]);
const R2 = policy("policy-r2", ["usage", "access"], [rule, { ruleId: "rule-access", revision: "r1", families: ["access"] as never }]);
const R3 = policy("policy-r3", ["access"], [{ ruleId: "rule-access", revision: "r1", families: ["access"] as never }]);
const qualification: CaseAdmissionQualification = {
  requests: [{ requestId: "gm-q/r1", family: "usage", provenance: { kind: "qualified_rule", ruleId: "rule-usage", revision: "r1", at: AT } }],
  identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [],
};
/** A case admitted under r1 whose request the relay opened (contract v8), and optionally a question on a J2 timer. */
async function agentCase(withJ2 = false) {
  const ticketId = String(++ticketSeq), threadId = randomUUID(), gmail = `gm-${ticketId}`, requestId = caseRequestId(gmail, "r1");
  const admission: CaseAdmissionInput = { policy: R1, qualification: { ...qualification, requests: [{ ...qualification.requests[0]!, requestId }] } };
  let c = (await openCaseEvent({ ticketId, threadId, admission, opens: [{ id: requestId, summary: "Demande synthétique." }],
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
  if (c.body.openRequests[0]?.family !== "usage") throw Error("RELAY_REQUEST_NOT_OPENED");
  if (!withJ2) return c;
  // The agent asked a question (the effect itself is simulated: only its record and its J2).
  c = await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" },
    body: { ...c.body, questions: [{ id: "q1", text: "Question fictive", factKeys: [], askedAt: AT, askedInEffect: "effect-j2" }] } });
  const sentAt = new Date(Date.now() + 60_000).toISOString(), dueAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const scheduled = await scheduleCaseTimer({ caseId: c.caseId, expectedVersion: c.version, currentPolicyRevision: "policy-r1", reasonCode: "j2_question", timer: { id: randomUUID(), questionEffectId: "effect-j2", sentAt, dueAt } });
  if (!scheduled.scheduled) throw Error(`J2_NOT_SCHEDULED:${scheduled.reason}`);
  return scheduled.case;
}

/** Pole A's real ports (listing, read, revalidation); a test overrides one only to inject a race. */
function ports(current: { revision: string | null; policy: unknown }, overrides: Partial<CaseAdmissionSweepPorts> = {}) {
  return { ...caseAdmissionSweepStorePorts({
    enabled: true, pauseState: async () => "running", now: () => new Date(),
    admissionPolicyRevision: async () => current.revision, approvedPolicy: async () => current.policy,
  }), ...overrides };
}
/** Every page until done, as a caller would loop. */
async function sweepAll(p: CaseAdmissionSweepPorts, limit = 50) {
  const seen: Array<{ caseId: string; outcome: string; reason?: string }> = [];
  for (let after: string | null = null, pass = 0; pass < 100; pass++) {
    const report = await sweepCaseAdmissionsAfterPolicyChange(p, { after, limit });
    if (!("cases" in report)) return { report, seen };
    seen.push(...report.cases);
    if (report.status !== "partial") return { report, seen };
    after = report.next;
  }
  throw Error("SWEEP_DID_NOT_END");
}
const outcomeOf = (seen: Array<{ caseId: string; outcome: string; reason?: string }>, caseId: string) => seen.find(row => row.caseId === caseId);
const admissionEvents = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "admission_decided");

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "investigation-store-fixture-key-32-chars");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  // Every test starts from cases decided under r1 only: earlier tests' cases are moved to a person.
  for (const caseId of await listCaseIdsForPolicyRevalidation({ currentPolicyRevision: "no-such-revision", after: null, limit: 500 })) {
    const c = (await readCase(caseId))!;
    if (c.owner === "agent") await transitionCaseOwner({ caseId, expectedVersion: c.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `reset-${caseId}-${c.version}`, reason: "test_reset" });
  }
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("SAV-7 sweep after an approved policy change (Q10, real pole A store)", () => {
  it("keeps on the agent what the new policy still admits, and the runner goes on without any human step", async () => {
    const c = await agentCase(true);
    const { report, seen } = await sweepAll(ports({ revision: "policy-r2", policy: R2 }));
    expect(report).toMatchObject({ status: "done", policyRevision: "policy-r2" });
    expect(outcomeOf(seen, c.caseId)).toEqual({ caseId: c.caseId, outcome: "kept_agent" });
    const after = (await readCase(c.caseId))!;
    expect(after).toMatchObject({ owner: "agent", admission: { target: "agent", policyRevision: "policy-r2" } });
    // The J2 survives: same timer, same due date, still scheduled.
    expect(await listCaseTimers(c.caseId)).toEqual([expect.objectContaining({ state: "scheduled", dueAt: c.body.waiting!.dueAt })]);
    expect((await admissionEvents(c.caseId)).at(-1)).toMatchObject({ sourceRef: { type: "studio_command", id: "admission-policy", revision: "policy-r2" } });
    // Pole A's list no longer returns it: it is decided under the current revision.
    expect(await listCaseIdsForPolicyRevalidation({ currentPolicyRevision: "policy-r2", after: null, limit: 500 })).not.toContain(c.caseId);

    // The runner's claim now passes under r2 (it was refused as `policy_changed` before the sweep).
    const calls: unknown[] = [];
    const run = await runCaseInvestigation(c.caseId, "observe", caseInvestigationStorePorts({
      // Witness: the ticket explicitly carries the V2 owner (Ugo 31/10, the owner read fails closed without it).
      readTicketOwner: async () => "v2",
      holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now: () => new Date(Date.now() + 6 * 60_000),
      pauseState: async () => "running", knowledge: async () => [], customerTexts: async () => ({}),
      revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
      callModel: async request => { calls.push(request); return { status: "failed", uncertain: false }; },
      admissionPolicyRevision: async () => "policy-r2", qualify: async () => null,
    }));
    expect(run).not.toMatchObject({ status: "claim_refused" });
    expect(run).not.toMatchObject({ status: "skipped" });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("sends to the team, with its reason, what the new policy no longer admits; the J2 is cancelled with it", async () => {
    const c = await agentCase(true);
    const { seen } = await sweepAll(ports({ revision: "policy-r3", policy: R3 }));
    expect(outcomeOf(seen, c.caseId)).toEqual({ caseId: c.caseId, outcome: "to_team", reason: "family_not_admitted" });
    expect(await readCase(c.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "family_not_admitted" } } });
    expect(await listCaseTimers(c.caseId)).toEqual([expect.objectContaining({ state: "cancelled", cancelReason: "admission_withdrawn" })]);
    const withdrawn = (await listCaseEvents(c.caseId)).filter(event => event.kind === "owner_changed").at(-1);
    expect(withdrawn).toMatchObject({ detail: { transition: "admission_withdrawn", from: "agent", to: "human", reasons: ["family_not_admitted"] } });
  });

  it("never touches a person's case or a held one (Q9: the hold keeps its J2), nor a case staled by a newer input", async () => {
    const human = await agentCase();
    await transitionCaseOwner({ caseId: human.caseId, expectedVersion: human.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `take-${human.caseId}`, reason: "personal" });
    const held = await agentCase(true);
    await transitionCaseOwner({ caseId: held.caseId, expectedVersion: held.version, transition: "organisational_hold", actor: { type: "human", staffUserId: STAFF }, commandKey: `hold-${held.caseId}`, reason: "audit" });
    const newer = await agentCase();
    await openCaseEvent({ ticketId: newer.ticketId, threadId: newer.threadIds[0]!, admission: { policy: R1, qualification: { ...qualification, requests: [{ requestId: "r2", family: "unknown", provenance: { kind: "intake_hint", source: { type: "email", id: "gm-new" } } }] } },
      admissionMode: "exclusions_only", kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`gm-new-${newer.ticketId}`), sourceRef: { type: "email", id: `gm-new-${newer.ticketId}` }, occurredAt: new Date().toISOString() });
    const before = await Promise.all([human, held, newer].map(async c => (await listCaseEvents(c.caseId)).length));

    const { seen } = await sweepAll(ports({ revision: "policy-r3", policy: R3 }));
    // Pole A's list leaves out a person's case and a held one; a newer input is left to the runner's own Q10 path.
    expect(outcomeOf(seen, human.caseId)).toBeUndefined();
    expect(outcomeOf(seen, held.caseId)).toBeUndefined();
    expect(outcomeOf(seen, newer.caseId)?.outcome).toBe("input_newer");
    expect(await Promise.all([human, held, newer].map(async c => (await listCaseEvents(c.caseId)).length))).toEqual(before);
    expect(await readCase(held.caseId)).toMatchObject({ owner: "system_hold" });
    expect(await listCaseTimers(held.caseId)).toEqual([expect.objectContaining({ state: "scheduled" })]);
  });

  it("Q9 across a policy change: a held case is not swept; released under the new policy it is back in its wait, same J2, and no call is paid again", async () => {
    const c = await agentCase(true);
    const dueAt = c.body.waiting!.dueAt;
    const runner = (revision: string, calls: unknown[]) => runCaseInvestigation(c.caseId, "observe", caseInvestigationStorePorts({
      // Witness: the ticket explicitly carries the V2 owner (Ugo 31/10, the owner read fails closed without it).
      readTicketOwner: async () => "v2",
      holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now: () => new Date(Date.now() + 6 * 60_000),
      pauseState: async () => "running", knowledge: async () => [], customerTexts: async () => ({}),
      revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
      // A valid question on the relay-opened request: the decision is stored for this mail.
      callModel: async request => {
        calls.push(request);
        const requests = request.snapshot.body.openRequests.map(row => ({ id: row.id, summary: "Demande.", family: row.family, status: "open" }));
        return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: { requests, newFacts: [] }, nextAction: { kind: "ask",
          questions: [{ text: "Quel résultat obtenez-vous après l'opération ?", requestId: requests[0]!.id, reducesUncertainty: "Savoir où cela échoue.", seeks: [{ kind: "observed_result" }] }] } } };
      },
      admissionPolicyRevision: async () => revision, qualify: async () => null,
    }));
    // The agent decided on the current mail under r1 (its decision is stored for this input).
    const before: unknown[] = [];
    expect(await runner("policy-r1", before)).toMatchObject({ status: "recorded", modelCalls: 1 });
    const worked = (await readCase(c.caseId))!;
    const held = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: worked.version, transition: "technical_hold", actor: { type: "system" }, commandKey: `hold-q9-${c.caseId}`, reason: "incident" });
    // r2 is approved while the case is held: pole A does not list it, the sweep writes nothing.
    const decisionsBefore = (await admissionEvents(c.caseId)).length;
    const { seen } = await sweepAll(ports({ revision: "policy-r2", policy: R2 }));
    expect(outcomeOf(seen, c.caseId)).toBeUndefined();
    expect(await admissionEvents(c.caseId)).toHaveLength(decisionsBefore);
    // A person releases it to the agent with a fresh admission under r2 (pole A cfa2c37): back to its wait, same J2.
    const released = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: held.case.version, transition: "hold_release", to: "agent", actor: { type: "human", staffUserId: STAFF },
      commandKey: `release-q9-${c.caseId}`, reason: "incident_over", admission: { policy: R2, qualification: c.admission!.qualification } });
    expect(released.case).toMatchObject({ owner: "agent", phase: "awaiting_customer", admission: { policyRevision: "policy-r2" }, body: { waiting: { kind: "customer", dueAt } } });
    expect(await listCaseTimers(c.caseId)).toEqual([expect.objectContaining({ state: "scheduled", dueAt })]);
    // Nothing new from the customer: the runner pays nothing again for the same mail.
    const after: unknown[] = [];
    const run = await runner("policy-r2", after);
    expect(after).toEqual([]);
    expect(run).toMatchObject({ status: "already_recorded", modelCalls: 1 });
  });

  it("is idempotent and safe under concurrency: two passes at once and a replay write one decision per case", async () => {
    const cases = [await agentCase(), await agentCase(), await agentCase()];
    const p = ports({ revision: "policy-r2", policy: R2 });
    const [a, b] = await Promise.all([sweepAll(p), sweepAll(p)]);
    for (const c of cases) {
      expect((await admissionEvents(c.caseId)).filter(event => event.detail?.policyRevision === "policy-r2")).toHaveLength(1);
      expect([outcomeOf(a.seen, c.caseId)?.outcome, outcomeOf(b.seen, c.caseId)?.outcome].sort()).toEqual(expect.arrayContaining(["kept_agent"]));
      expect(["kept_agent", "current", "version_moved"]).toContain(outcomeOf(b.seen, c.caseId)?.outcome);
    }
    // Replay (a crash after the writes, then a new pass): nothing more is written.
    const counts = await Promise.all(cases.map(async c => (await listCaseEvents(c.caseId)).length));
    const replay = await sweepAll(p);
    // Decided under r2, they are no longer listed by pole A: the replay does not even read them.
    for (const c of cases) expect(outcomeOf(replay.seen, c.caseId)).toBeUndefined();
    expect(await Promise.all(cases.map(async c => (await listCaseEvents(c.caseId)).length))).toEqual(counts);
  });

  it("a customer mail arriving mid-pass wins: after the listing it is left to the runner, after the read the write is refused", async () => {
    const mailNow = async (c: CaseSnapshot, id: string) => openCaseEvent({ ticketId: c.ticketId, threadId: c.threadIds[0]!, admission: { policy: R1, qualification: { ...qualification, requests: [{ requestId: "rx", family: "unknown", provenance: { kind: "intake_hint", source: { type: "email", id } } }] } },
      admissionMode: "exclusions_only", kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(id), sourceRef: { type: "email", id }, occurredAt: new Date().toISOString() });
    const listed = await agentCase(), read = await agentCase();
    const real = ports({ revision: "policy-r2", policy: R2 });
    const racing = ports({ revision: "policy-r2", policy: R2 }, {
      listCases: async page => { const ids = await real.listCases(page); if (ids.includes(listed.caseId)) await mailNow(listed, `gm-race-l-${listed.ticketId}`); return ids; },
      readCase: async caseId => { const snap = await real.readCase(caseId); if (caseId === read.caseId && snap) await mailNow(read, `gm-race-r-${read.ticketId}`); return snap; },
    });
    const before = await Promise.all([listed, read].map(async c => (await admissionEvents(c.caseId)).length));
    const { report, seen } = await sweepAll(racing);
    expect(report).toMatchObject({ status: "done" });
    expect(outcomeOf(seen, listed.caseId)?.outcome).toBe("input_newer");
    // Lost the race once, read again by the next pass: now staled by the newer mail, left to the runner.
    expect(seen.filter(row => row.caseId === read.caseId).map(row => row.outcome)).toEqual(["version_moved", "input_newer"]);
    // Neither decision was written over the newer mail.
    expect(await Promise.all([listed, read].map(async c => (await admissionEvents(c.caseId)).length))).toEqual(before);
  });

  describe("review B (28/10): the cursor never passes a case that lost a version race", () => {
    /** Ports whose read of `target` is followed, once, by another write: `note` keeps the body (a version-only move), `takeover` gives it to a person. */
    function racingOnce(target: string, race: "note" | "takeover") {
      const real = ports({ revision: "policy-r2", policy: R2 });
      let raced = false;
      return ports({ revision: "policy-r2", policy: R2 }, { readCase: async caseId => {
        const read = await real.readCase(caseId);
        if (read && caseId === target && !raced) {
          raced = true;
          if (race === "note") await updateCaseRecord({ caseId, expectedVersion: read.version, actor: { type: "agent" }, body: read.body });
          else await transitionCaseOwner({ caseId, expectedVersion: read.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `race-${caseId}`, reason: "personal" });
        }
        return read;
      } });
    }
    const stillOnOldPolicy = async () => listCaseIdsForPolicyRevalidation({ currentPolicyRevision: "policy-r2", after: null, limit: 500 });

    it("a version-only race (a note, no new input): the pass stops before the case, the next one revalidates it, nothing is left on the old policy", async () => {
      const c = await agentCase();
      const first = await sweepCaseAdmissionsAfterPolicyChange(racingOnce(c.caseId, "note"), { limit: 1 });
      expect(first).toMatchObject({ status: "partial", next: null, cases: [{ caseId: c.caseId, outcome: "version_moved" }] });
      expect(await stillOnOldPolicy()).toContain(c.caseId);
      const { report, seen } = await sweepAll(racingOnce(c.caseId, "note"), 1);
      expect(report).toMatchObject({ status: "done" });
      expect(seen).toContainEqual({ caseId: c.caseId, outcome: "version_moved" });
      expect(seen.at(-1)).toEqual(expect.not.objectContaining({ outcome: "version_moved" }));
      expect(await stillOnOldPolicy()).not.toContain(c.caseId);
      expect(await readCase(c.caseId)).toMatchObject({ owner: "agent", admission: { policyRevision: "policy-r2" } });
    });
    it("witness without a race: one pass revalidates the case under r2", async () => {
      const c = await agentCase();
      const { report, seen } = await sweepAll(ports({ revision: "policy-r2", policy: R2 }), 1);
      expect(report).toMatchObject({ status: "done" });
      expect(outcomeOf(seen, c.caseId)).toEqual({ caseId: c.caseId, outcome: "kept_agent" });
      expect(await stillOnOldPolicy()).not.toContain(c.caseId);
    });
    it("a race that gave the case to a person does not hold the others: it is no longer listed and the next case is swept", async () => {
      const a = await agentCase(), b = await agentCase();
      const [first, second] = [a, b].sort((x, y) => x.caseId.localeCompare(y.caseId));
      const { report, seen } = await sweepAll(racingOnce(first!.caseId, "takeover"), 1);
      expect(report).toMatchObject({ status: "done" });
      expect(seen.filter(row => row.caseId === first!.caseId).map(row => row.outcome)).toEqual(["version_moved"]);
      expect(outcomeOf(seen, second!.caseId)).toEqual({ caseId: second!.caseId, outcome: "kept_agent" });
      expect(await readCase(first!.caseId)).toMatchObject({ owner: "human", admission: { policyRevision: "policy-r1" } });
      expect(await stillOnOldPolicy()).toEqual([]);
    });
    it("a lost race in the middle of a page keeps the cursor on the case before it", async () => {
      const ids = (await Promise.all([agentCase(), agentCase(), agentCase()])).map(c => c.caseId).sort();
      const report = await sweepCaseAdmissionsAfterPolicyChange(racingOnce(ids[1]!, "note"), { limit: 3 });
      expect(report).toMatchObject({ status: "partial", next: ids[0], cases: [{ caseId: ids[0], outcome: "kept_agent" }, { caseId: ids[1], outcome: "version_moved" }] });
      // From that cursor the race is over: both remaining cases are decided.
      const rest = await sweepCaseAdmissionsAfterPolicyChange(ports({ revision: "policy-r2", policy: R2 }), { after: ids[0], limit: 3 });
      expect(rest).toMatchObject({ status: "done", cases: [{ caseId: ids[1], outcome: "kept_agent" }, { caseId: ids[2], outcome: "kept_agent" }] });
    });
    it("two passes at once, page size 1, one of them losing a version race: nothing left on the old policy, one admission per case (night 29→30/10)", async () => {
      const ids = (await Promise.all([agentCase(), agentCase(), agentCase()])).map(c => c.caseId).sort();
      const decisions = () => Promise.all(ids.map(async id => (await admissionEvents(id)).length));
      const before = await decisions();
      // The note races the other pass too: a note that itself loses (version already moved) is simply not written.
      const real = ports({ revision: "policy-r2", policy: R2 });
      let raced = false;
      const racing = ports({ revision: "policy-r2", policy: R2 }, { readCase: async caseId => {
        const read = await real.readCase(caseId);
        if (read && caseId === ids[1] && !raced) {
          raced = true;
          await updateCaseRecord({ caseId, expectedVersion: read.version, actor: { type: "agent" }, body: read.body })
            .catch((error: unknown) => { if (!String(error).includes("SAV_CASE_VERSION_STALE")) throw error; });
        }
        return read;
      } });
      const [a, b] = await Promise.all([sweepAll(racing, 1), sweepAll(ports({ revision: "policy-r2", policy: R2 }), 1)]);
      expect([a.report.status, b.report.status]).toEqual(["done", "done"]);
      expect(await stillOnOldPolicy()).toEqual([]);
      expect((await decisions()).map((count, index) => count - before[index]!)).toEqual([1, 1, 1]);
      for (const id of ids) expect(await readCase(id)).toMatchObject({ owner: "agent", admission: { policyRevision: "policy-r2" } });
    });
  });

  it("the store adapter reports pole A's own refusal under lock as refused, never as a revalidation", async () => {
    const c = await agentCase();
    const taken = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: c.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `take-adapter-${c.caseId}`, reason: "personal" });
    const before = (await admissionEvents(c.caseId)).length;
    expect(await ports({ revision: "policy-r2", policy: R2 }).revalidate(taken.case, R2 as never)).toBe("refused");
    expect(await admissionEvents(c.caseId)).toHaveLength(before);
    expect(await readCase(c.caseId)).toMatchObject({ owner: "human" });
  });

  it("works in bounded pages from a cursor and resumes where it stopped", async () => {
    const cases = [await agentCase(), await agentCase(), await agentCase()];
    const p = ports({ revision: "policy-r2", policy: R2 });
    const first = await sweepCaseAdmissionsAfterPolicyChange(p, { limit: 1 });
    expect(first).toMatchObject({ status: "partial", next: expect.any(String), cases: [{ outcome: "kept_agent" }] });
    // Resume from the cursor, one case per page, until done: each case is decided exactly once.
    const rest: Array<{ caseId: string; outcome: string }> = [];
    let after = "next" in first ? first.next : null;
    for (let pass = 0; pass < 10; pass++) {
      const page = await sweepCaseAdmissionsAfterPolicyChange(p, { after, limit: 1 });
      if (!("cases" in page)) throw Error("UNEXPECTED_REFUSAL");
      rest.push(...page.cases);
      if (page.status !== "partial") break;
      after = page.next;
    }
    const decided = [...("cases" in first ? first.cases : []), ...rest];
    expect(decided.map(row => row.caseId).sort()).toEqual(cases.map(c => c.caseId).sort());
    expect(decided.every(row => row.outcome === "kept_agent")).toBe(true);
    for (const c of cases) expect((await admissionEvents(c.caseId)).filter(event => event.detail?.policyRevision === "policy-r2")).toHaveLength(1);
    expect(await sweepCaseAdmissionsAfterPolicyChange(p, { limit: 0 })).toEqual({ status: "refused", reason: "page_invalid" });
    expect(await sweepCaseAdmissionsAfterPolicyChange(p, { limit: 201 })).toEqual({ status: "refused", reason: "page_invalid" });
  });

  it("writes nothing when off, paused, or when the policy is missing, invalid, unapproved or disagrees with the pointer", async () => {
    const c = await agentCase();
    await agentCase();
    const versionBefore = c.version;
    const refusals: Array<[Parameters<typeof ports>[0], Partial<CaseAdmissionSweepPorts>, unknown]> = [
      [{ revision: "policy-r2", policy: R2 }, { enabled: false }, { status: "disabled" }],
      [{ revision: "policy-r2", policy: R2 }, { pauseState: async () => "fully_paused" }, { status: "paused" }],
      // An actions pause stops admission writes too (`assertSavAgentActionsAllowed`): the sweep waits for its end.
      [{ revision: "policy-r2", policy: R2 }, { pauseState: async () => "actions_paused" }, { status: "paused" }],
      [{ revision: null, policy: null }, {}, { status: "refused", reason: "policy_missing" }],
      [{ revision: "policy-r2", policy: { ...R2, approvedBy: undefined } }, {}, { status: "refused", reason: "policy_invalid" }],
      // A policy carrying a field (a new destination, a tag) the contract does not know is refused, never read as admitted.
      [{ revision: "policy-r2", policy: { ...R2, destination: "new-team" } }, {}, { status: "refused", reason: "policy_invalid" }],
      [{ revision: "policy-r2", policy: R3 }, {}, { status: "refused", reason: "policy_conflict" }],
      [{ revision: "policy-r2", policy: { ...R2, approvedAt: "2099-01-01T00:00:00.000Z" } }, {}, { status: "refused", reason: "policy_unapproved" }],
    ];
    for (const [current, overrides, expected] of refusals) expect(await sweepCaseAdmissionsAfterPolicyChange(ports(current, overrides))).toEqual(expected);
    expect((await readCase(c.caseId))!.version).toBe(versionBefore);

    // A pause arriving mid-pass stops before the next case; the cursor resumes there.
    let reads = 0;
    const stopping = ports({ revision: "policy-r2", policy: R2 }, { pauseState: async () => (reads++ < 2 ? "running" : "actions_paused") });
    const paused = await sweepCaseAdmissionsAfterPolicyChange(stopping);
    expect(paused).toMatchObject({ status: "paused", policyRevision: "policy-r2" });
    expect("cases" in paused && paused.cases).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("SAV-7 sweep, pure checks", () => {
  const snapshot = (over: Partial<CaseSnapshot>) => ({ caseId: "c1", version: 3, owner: "agent", admissionInputVersion: 1,
    contractRevision: SAV_CASE_CONTRACT_REVISION, admission: { target: "agent", policyRevision: "policy-r1", inputVersion: 1, reasons: ["admitted"], qualification }, ...over }) as unknown as CaseSnapshot;
  const fake = (snap: CaseSnapshot | null, revalidate: CaseAdmissionSweepPorts["revalidate"] = vi.fn(async () => "revalidated" as const)): CaseAdmissionSweepPorts => ({
    enabled: true, pauseState: async () => "running", now: () => new Date(), admissionPolicyRevision: async () => "policy-r2", approvedPolicy: async () => R2,
    listCases: async ({ after }) => (after ? [] : ["c1"]), readCase: async () => snap, revalidate,
  });

  it("refuses a case stored under another contract revision instead of guessing, and never re-evaluates it", async () => {
    const revalidate = vi.fn(async () => "revalidated" as const);
    const report = await sweepCaseAdmissionsAfterPolicyChange(fake(snapshot({ contractRevision: `${SAV_CASE_CONTRACT_REVISION}-next` as never }), revalidate));
    expect(report).toMatchObject({ status: "done", cases: [{ caseId: "c1", outcome: "contract_conflict" }] });
    expect(revalidate).not.toHaveBeenCalled();
  });
  it("hands pole A the approved policy only (the store re-reads the recorded qualification), and reports its answers", async () => {
    const moved = vi.fn(async () => "version_moved" as const);
    expect(await sweepCaseAdmissionsAfterPolicyChange(fake(snapshot({}), moved))).toMatchObject({ cases: [{ outcome: "version_moved" }] });
    expect(moved).toHaveBeenCalledWith(expect.objectContaining({ caseId: "c1", version: 3 }), R2);
    const refused = vi.fn(async () => "refused" as const);
    expect(await sweepCaseAdmissionsAfterPolicyChange(fake(snapshot({}), refused))).toMatchObject({ cases: [{ outcome: "refused_by_store" }] });
  });
  it.each([
    ["no admission", { admission: null }, "not_admitted"],
    ["an admission to the team", { admission: { target: "team", policyRevision: "policy-r1", inputVersion: 1, reasons: ["sensitive_family"], qualification } }, "not_admitted"],
    ["already under r2", { admission: { target: "agent", policyRevision: "policy-r2", inputVersion: 1, reasons: ["admitted"], qualification } }, "current"],
    ["a held case", { owner: "system_hold" }, "not_agent"],
  ])("leaves %s alone", async (_label, over, outcome) => {
    const revalidate = vi.fn(async () => "revalidated" as const);
    expect(await sweepCaseAdmissionsAfterPolicyChange(fake(snapshot(over as Partial<CaseSnapshot>), revalidate))).toMatchObject({ cases: [{ outcome }] });
    expect(revalidate).not.toHaveBeenCalled();
  });
  it("cannot feed itself: no event B or the sweep writes is an admission input, so no write re-triggers a run", async () => {
    const c = await agentCase(true);
    await sweepAll(ports({ revision: "policy-r3", policy: R3 }));
    const written = (await listCaseEvents(c.caseId)).filter(event => ["admission_decided", "owner_changed", "observation_recorded", "timer_fired"].includes(event.kind));
    expect(written.length).toBeGreaterThan(0);
    for (const event of written) expect(caseEventIsAdmissionInput(event.kind, event.direction, (event.detail?.crmChange as never) ?? "unknown")).toBe(false);
    // Only a customer mail, a human outbound or command, or a CRM change other than a note opens a new round.
    expect(caseEventIsAdmissionInput("inbound_confirmed", "customer_inbound")).toBe(true);
    expect(caseEventIsAdmissionInput("crm_observed", "internal", "note_added")).toBe(false);
  });
  it("imports no model, effect, network or store module of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./investigation-policy-sweep.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]).sort()).toEqual(["./admission-policy", "./case-types"]);
    expect(source).not.toMatch(/process\.env/);
  });
});
