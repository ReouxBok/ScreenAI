import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import type { SavRetrievalCandidate } from "../request-retrieval";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// No external service at all: importing a HubSpot module fails the file, and fetch is a spy that must stay silent.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
import type { CaseAdmissionInput } from "./admission-policy";
import { classifyCaseExit } from "./case-outcomes";
import { appendCaseEvent, claimCaseForDecision, listCaseEvents, listCaseTimers, openCaseEvent, readCase } from "./case-store";
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseSnapshot } from "./case-types";
import { readCaseInvestigationProgress } from "./investigation-record";
import { runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationModelResult } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * SAV-7 end to end on the real pole A store (PGlite, contract v6): relay-style case opening, admission, the 5-minute
 * quiet period, claim, the one observation per claim, the stored decision per input, a HubSpot note, the automatic
 * re-evaluation by approved rules (Q10) and the withdrawal of a sensitive case. Fakes only for what lies outside:
 * the model, knowledge, pause and clock. Synthetic data only.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_200_000;
const STAFF = "20000000-0000-4000-8000-000000000001", AT = "2026-10-27T09:00:00.000Z";
const POLICY = { revision: "policy-r1", admittedFamilies: ["usage"], qualifiedRules: [{ ruleId: "rule-usage", revision: "r1", families: ["usage"] }], approvedBy: STAFF, approvedAt: AT };
const qualification = (requests: CaseAdmissionQualification["requests"]): CaseAdmissionQualification =>
  ({ requests, identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [] });
/** Each mail opens one request, `<mail>/r1` (contract v8), qualified by an intake hint or by the approved rule. */
const hint = (id: string, family: "unknown" | "finance"): CaseAdmissionInput => ({ policy: POLICY, qualification: qualification([{ requestId: caseRequestId(id, "r1"), family, provenance: { kind: "intake_hint", source: { type: "email", id } } }]) });
const byRule = (id: string): CaseAdmissionInput => ({ policy: POLICY, qualification: qualification([{ requestId: caseRequestId(id, "r1"), family: "usage", provenance: { kind: "qualified_rule", ruleId: "rule-usage", revision: "r1", at: AT } }]) });
const card = { id: "k1", contentVersionId: "k1-v1", title: "Fiche k1", content: "Procédure synthétique.", source: "fixture", verifiedAt: "2026-10-01T00:00:00Z", semanticScore: null,
  resolution: { steps: ["Étape synthétique"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as SavRetrievalCandidate;
/** A question on the case's open requests as the relay opened them. */
const ask = (snapshot: CaseSnapshot) => {
  const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ id: row.id, summary: "Demande.", family: row.family, status: "open" }));
  return { caseVersion: snapshot.version, understanding: { requests, newFacts: [] },
    nextAction: { kind: "ask", questions: [{ text: "Quel résultat obtenez-vous après l'opération ?", requestId: requests[0]!.id, reducesUncertainty: "Savoir où cela échoue.", seeks: [{ kind: "observed_result" }] }] } };
};

/** Mail relayed by V1 after confirmation: the first one with an admitting qualification, later ones with intake hints only. */
async function mail(ticketId: string, threadId: string, id: string, admission: CaseAdmissionInput, admissionMode?: "exclusions_only") {
  // The V1 relay opens the mail's request with a neutral summary, never the customer's text (contract v8).
  return (await openCaseEvent({ ticketId, threadId, admission, admissionMode, opens: [{ id: caseRequestId(id, "r1"), summary: "Demande synthétique." }], kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(id), sourceRef: { type: "email", id }, occurredAt: new Date().toISOString() })).case;
}

type Run = { report: Awaited<ReturnType<typeof runCaseInvestigation>>; calls: CaseInvestigationModelRequest[]; qualified: number };
async function investigate(caseId: string, answers: Array<(request: CaseInvestigationModelRequest) => CaseInvestigationModelResult>, options: { at?: number; rules?: boolean; staleRunning?: boolean; callSignal?: { windowHours: number; threshold: number | null }; qualifyThrows?: boolean } = {}): Promise<Run> {
  const calls: CaseInvestigationModelRequest[] = [];
  let qualified = 0;
  const ports = caseInvestigationStorePorts({
    // Witness: the ticket explicitly carries the V2 owner (Ugo 31/10, the owner read fails closed without it).
    readTicketOwner: async () => "v2",
    holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" },
    // Six minutes after the mails by default: past the 5-minute quiet period of pole A.
    now: () => new Date(Date.now() + (options.at ?? 6 * 60_000)),
    // The real V2 pause row, read as pole A's claim reads it (no row: running; unreadable: fully paused).
    // `staleRunning`: a reading taken just before the pause was set, so only pole A's reading under lock sees it.
    pauseState: async () => (options.staleRunning ? "running" : (await readSavAgentPause(f.db as never, "v2")).level), knowledge: async () => [card], customerTexts: async () => ({}),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => { calls.push(request); return answers.shift()?.(request) ?? { status: "failed", uncertain: false }; },
    admissionPolicyRevision: async () => "policy-r1", ...(options.callSignal ? { callSignal: options.callSignal } : {}),
    qualify: async (_snapshot, events) => {
      qualified += 1;
      if (options.qualifyThrows) throw Error("CRM_UNREADABLE_FIXTURE");
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      return options.rules && latest ? { admission: byRule(latest.sourceRef.id), sourceRef: latest.sourceRef } : null;
    },
  });
  return { report: await runCaseInvestigation(caseId, "observe", ports), calls, qualified };
}
/** The real `sav-agent-pause.v1:v2` setting, as the admin panel writes it; `garbage` is an unreadable row. */
async function setV2Pause(level: "actions_paused" | "fully_paused" | "garbage" | null) {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: level === "garbage" ? "not-a-payload" : encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
}
/** A case admitted for the agent with one open request, as in the journey above. */
async function admittedCase(gmail: string) {
  const ticketId = String(++ticketSeq), threadId = randomUUID();
  const c = await mail(ticketId, threadId, gmail, byRule(gmail));
  return { ticketId, threadId, c };
}
/** Everything that would show an effect: an outbound or owner event, a J2 timer, the `acting` phase, any network call. */
async function effects(caseId: string) {
  const events = await listCaseEvents(caseId);
  return { outbound: events.filter(event => event.kind === "outbound_observed").length, timers: (await listCaseTimers(caseId)).length,
    acting: (await readCase(caseId))!.phase === "acting", network: vi.mocked(fetch).mock.calls.length };
}
const NO_EFFECT = { outbound: 0, timers: 0, acting: false, network: 0 };
const observations = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "observation_recorded");
const asked = (request: CaseInvestigationModelRequest): CaseInvestigationModelResult => ({ status: "ok", output: ask(request.snapshot) });

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "investigation-store-fixture-key-32-chars");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
});
afterEach(async () => { await setV2Pause(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("SAV-7 investigation on the real pole A store (PGlite)", () => {
  it("follows a case from the relayed mail to a stored decision, across a note, a new message and a sensitive one", async () => {
    const ticketId = String(++ticketSeq), threadId = randomUUID();
    const snapshot: CaseSnapshot = await mail(ticketId, threadId, "gm-1", byRule("gm-1"));
    expect(snapshot).toMatchObject({ owner: "agent", admission: { target: "agent" } });
    const caseId = snapshot.caseId;
    // Contract v8 closed B's finding: the relay itself opened the mail's request, with its proven family.
    expect(snapshot.body.openRequests).toEqual([{ id: "gm-1/r1", summary: "Demande synthétique.", family: "usage", status: "open", openedAt: expect.any(String) }]);

    // 1. Within the 5-minute quiet period: refused by the store, no call, nothing written.
    const early = await investigate(caseId, [asked], { at: 0 });
    expect(early.report).toMatchObject({ status: "claim_refused", reason: "settling", retryAt: expect.any(String), modelCalls: 0 });
    expect(early.calls).toEqual([]);
    expect(await observations(caseId)).toEqual([]);

    // 2. After it: one call, one observation that ends the claim, readable back for this input.
    const first = await investigate(caseId, [asked]);
    expect(first.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1, caseVersion: snapshot.version });
    expect(first.calls[0]).toMatchObject({ caseBudgetKey: `sav-case:${caseId}`, subjectKey: `sav-case:${caseId}:${first.calls[0].inputKey}` });
    const kept = await observations(caseId);
    expect(kept).toHaveLength(1);
    expect(readCaseInvestigationProgress(kept, first.calls[0].inputKey)).toMatchObject({ state: "found", record: { progress: { modelCalls: 1, recordedOn: snapshot.version } } });
    expect((await readCase(caseId))!.admission).toMatchObject({ target: "agent" });

    // 3. A HubSpot note: the admission holds (v6) and the stored decision is re-checked without any call.
    //    HubSpot's ISO date is taken as is since contract v8 (B's second finding).
    await appendCaseEvent({ caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm("ticket-obj", "2026-10-27T10:00:00Z"), sourceRef: { type: "hubspot_object", id: "ticket-obj" }, occurredAt: AT, detail: { crmChange: "note_added" } });
    const afterNote = await investigate(caseId, [asked]);
    expect(afterNote.report).toMatchObject({ status: "already_recorded", modelCalls: 1 });
    expect(afterNote.calls).toEqual([]);
    expect(afterNote.qualified).toBe(0);

    // 4. A new message relayed with intake hints only: the approved rules qualify it and the run goes on by itself (Q10).
    await mail(ticketId, threadId, "gm-2", hint("gm-2", "unknown"), "exclusions_only");
    const continued = await investigate(caseId, [asked], { rules: true });
    expect(continued.qualified).toBe(1);
    expect(continued.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(continued.calls[0].inputKey).not.toBe(first.calls[0].inputKey);
    expect(await observations(caseId)).toHaveLength(2);

    // 5. A refund request: pole A withdraws the case to the team at once; nothing to re-evaluate, no call.
    await mail(ticketId, threadId, "gm-3", hint("gm-3", "finance"), "exclusions_only");
    expect(await readCase(caseId)).toMatchObject({ owner: "human", sensitivity: "finance" });
    const team = await investigate(caseId, [asked], { rules: true });
    expect(team.report).toMatchObject({ status: "skipped", reason: "excluded_sensitive", modelCalls: 0 });
    expect(team.calls).toEqual([]);
    expect(team.qualified).toBe(0);
  });

  it("P1 (option c): the call signal is read from the stored journal, carried by the stored decision, and never stops a call", async () => {
    const { ticketId, threadId, c } = await admittedCase("gm-p1-a");
    expect((await investigate(c.caseId, [asked], { callSignal: { windowHours: 24, threshold: 1 } })).report).toMatchObject({ status: "recorded", callSignal: { calls: 1, over: false } });
    await mail(ticketId, threadId, "gm-p1-b", byRule("gm-p1-b"), "exclusions_only");
    // Second input: one call already in the journal plus this one, above a threshold of 1, and still called and recorded.
    const second = await investigate(c.caseId, [asked], { rules: true, callSignal: { windowHours: 24, threshold: 1 } });
    expect(second.report).toMatchObject({ status: "recorded", modelCalls: 1, callSignal: { windowHours: 24, calls: 2, threshold: 1, over: true } });
    expect(second.calls).toHaveLength(1);
    const stored = (await observations(c.caseId)).at(-1)!.detail as { record: { decision: { callSignal: unknown } } };
    expect(stored.record.decision.callSignal).toEqual({ windowHours: 24, calls: 2, threshold: 1, over: true });
    expect(await effects(c.caseId)).toEqual(NO_EFFECT);
  });

  it("maps a claim held elsewhere to busy and leaves the other claim untouched", async () => {
    const ticketId = String(++ticketSeq), threadId = randomUUID();
    const snapshot = await mail(ticketId, threadId, "gm-busy", byRule("gm-busy"));
    const other = await claimCaseForDecision({ caseId: snapshot.caseId, expectedVersion: snapshot.version, holder: "other-worker", currentPolicyRevision: "policy-r1", ttlSeconds: 300, now: new Date(Date.now() + 6 * 60_000) });
    expect(other.claimed).toBe(true);
    const run = await investigate(snapshot.caseId, [asked]);
    expect(run.report).toMatchObject({ status: "claim_refused", reason: "busy", modelCalls: 0 });
    expect(await observations(snapshot.caseId)).toEqual([]);
  });

  it("Q10: hands to the team, once, a new message no approved rule qualifies, instead of leaving it stale with the agent", async () => {
    const { ticketId, threadId, c } = await admittedCase("gm-out-1");
    await mail(ticketId, threadId, "gm-out-2", hint("gm-out-2", "unknown"), "exclusions_only");
    const run = await investigate(c.caseId, [asked]);
    expect(run.report).toMatchObject({ status: "skipped", reason: "not_agent_owned", detail: "human", modelCalls: 0 });
    expect(run.calls).toEqual([]);
    expect(await readCase(c.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "out_of_scope" } } });
    const exits = (await listCaseEvents(c.caseId)).filter(event => event.kind === "owner_changed");
    expect(exits).toHaveLength(1);
    // Pole A's Q11 measure counts it as a business transfer, never as a silent block.
    expect(classifyCaseExit(exits[0]!)).toBe("business_transfer");
    // Run again (a timer, a replay): a person owns it now, nothing more is written.
    expect((await investigate(c.caseId, [asked])).report).toMatchObject({ status: "skipped", reason: "not_agent_owned" });
    expect((await listCaseEvents(c.caseId)).filter(event => event.kind === "owner_changed")).toHaveLength(1);
  });

  it("actions_paused (contract agent-pause v1): the analysis runs and is recorded as decided under the pause, and no effect leaves", async () => {
    const { c } = await admittedCase("gm-ap-1");
    await setV2Pause("actions_paused");
    const run = await investigate(c.caseId, [asked]);
    // Analysis allowed: pole A granted the claim (its `actionsPaused` reading under lock), one call, one decision.
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1, actionsPaused: true });
    const [kept] = await observations(c.caseId);
    expect(kept).toMatchObject({ detail: { applied: true, record: { decision: { actionsPaused: true, mode: "observe" } } } });
    // No effect: no mail or note observed, no J2 scheduled, never `acting`, no network.
    expect(await effects(c.caseId)).toEqual(NO_EFFECT);

    // Pause set between the runner's reading and the claim: pole A's reading under the case lock still marks the decision.
    const { c: raced } = await admittedCase("gm-ap-race");
    const late = await investigate(raced.caseId, [asked], { staleRunning: true });
    expect(late.report).toMatchObject({ status: "recorded", actionsPaused: true });
    expect((await observations(raced.caseId))[0]).toMatchObject({ detail: { record: { decision: { actionsPaused: true } } } });
    expect(await effects(raced.caseId)).toEqual(NO_EFFECT);
  });

  it("actions_paused also stops the automatic re-admission of a new message: no admission write until the pause ends", async () => {
    const { ticketId, threadId, c } = await admittedCase("gm-ap-2");
    await mail(ticketId, threadId, "gm-ap-3", hint("gm-ap-3", "unknown"), "exclusions_only");
    await setV2Pause("actions_paused");
    const decisions = async () => (await listCaseEvents(c.caseId)).filter(event => event.kind === "admission_decided" || event.kind === "owner_changed").length;
    const before = await decisions();
    const held = await investigate(c.caseId, [asked], { rules: true });
    expect(held.report).toMatchObject({ status: "skipped", reason: "admission_stale", detail: "input_newer", modelCalls: 0 });
    expect(held.qualified).toBe(0);
    expect(await decisions()).toBe(before);
    // Pause over: the same run re-admits by the approved rules and goes on.
    await setV2Pause(null);
    expect((await investigate(c.caseId, [asked], { rules: true })).report).toMatchObject({ status: "recorded", actionsPaused: false });
  });

  it.each(["fully_paused", "garbage"] as const)("%s: no new analysis, no claim, no call, nothing written", async level => {
    const { c } = await admittedCase(`gm-fp-${level}`);
    await setV2Pause(level);
    const before = await listCaseEvents(c.caseId);
    const run = await investigate(c.caseId, [asked]);
    expect(run.report).toEqual({ status: "paused", caseId: c.caseId, modelCalls: 0 });
    expect(run.calls).toEqual([]);
    expect(await listCaseEvents(c.caseId)).toEqual(before);
    expect(await effects(c.caseId)).toEqual(NO_EFFECT);
    // Pole A refuses the claim on its own reading too, whatever the runner's port says.
    expect(await claimCaseForDecision({ caseId: c.caseId, expectedVersion: c.version, holder: "other-worker", currentPolicyRevision: "policy-r1", ttlSeconds: 300, now: new Date(Date.now() + 6 * 60_000) }))
      .toMatchObject({ claimed: false, reason: "agent_paused" });
  });
});

describe("B5 OBS1 (night 01/11): a qualification that cannot run before the claim is a typed technical gap, not « unqualified »", () => {
  it("throws: qualification_unavailable, not persisted; no handoff, no admission write, no observation, no call; the next run qualifies and goes on", async () => {
    const { ticketId, threadId, c } = await admittedCase("gm-obs1-a");
    expect((await investigate(c.caseId, [asked])).report).toMatchObject({ status: "recorded" });
    await mail(ticketId, threadId, "gm-obs1-b", hint("gm-obs1-b", "unknown"), "exclusions_only");
    const before = (await readCase(c.caseId))!, events = (await listCaseEvents(c.caseId)).length;
    const failed = await investigate(c.caseId, [asked], { rules: true, qualifyThrows: true });
    expect(failed.report).toEqual({ status: "qualification_unavailable", caseId: c.caseId, caseVersion: before.version, admissionInputVersion: before.admissionInputVersion,
      // B7: a raw error (not A6's typed refusal) keeps the generic gap, its A6 fields null.
      inputKey: expect.stringMatching(/^in:/), persisted: false, modelCalls: 0, qualification: null });
    expect(failed.calls).toEqual([]);
    expect(await readCase(c.caseId)).toMatchObject({ version: before.version, owner: "agent", admissionInputVersion: before.admissionInputVersion });
    expect(await listCaseEvents(c.caseId)).toHaveLength(events);
    const continued = await investigate(c.caseId, [asked], { rules: true });
    expect(continued.report).toMatchObject({ status: "recorded", modelCalls: 1 });
  });
  it("answers null (no approved rule): the business outcome stays the handoff to the team, distinct from the technical gap", async () => {
    const { ticketId, threadId, c } = await admittedCase("gm-obs1-c");
    expect((await investigate(c.caseId, [asked])).report).toMatchObject({ status: "recorded" });
    await mail(ticketId, threadId, "gm-obs1-d", hint("gm-obs1-d", "unknown"), "exclusions_only");
    const team = await investigate(c.caseId, [asked], { rules: false });
    expect(team.report).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(team.report.status).not.toBe("qualification_unavailable");
    expect(team.calls).toEqual([]);
    expect(await readCase(c.caseId)).toMatchObject({ owner: "human" });
  });
});
