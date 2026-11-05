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
// Strict local ports: importing HubSpot, the model dispatcher or the call ledger fails the file; fetch is a silent spy.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
vi.mock("../intake/runtime-store", () => { throw Error("LEDGER_IMPORTED"); });
import type { CaseAdmissionInput } from "./admission-policy";
import { appendCaseEvent, listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner, updateCaseRecord } from "./case-store";
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseSnapshot } from "./case-types";
import type { CaseInvestigationStoredRecord } from "./investigation-record";
import { latestInvestigationInput, runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationModelResult } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * Night 29→30/10: the access journey on the real pole A store (PGlite, contract v8), from the relayed mail to the
 * admission, the decision and a SIMULATED intention. Fakes only outside B and A: the model, the rules (`qualify`),
 * knowledge, customer texts and the clock. Nothing is sent: SAV-10 (the executor) does not exist, so `simulatedIntent`
 * is a test oracle reading A and the stored record, and `simulatedSend` stands for a person sending the prepared draft.
 * Neither is a contract for SAV-10. Synthetic data only.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_600_000;
const STAFF = "20000000-0000-4000-8000-000000000002", AT = "2026-10-29T09:00:00.000Z";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const qualification = (requests: CaseAdmissionQualification["requests"]): CaseAdmissionQualification =>
  ({ requests, identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [] });
const byRule = (id: string): CaseAdmissionInput => ({ policy: POLICY, qualification: qualification([{ requestId: caseRequestId(id, "r1"), family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-access", revision: "r1", at: AT } }]) });
const hint = (id: string): CaseAdmissionInput => ({ policy: POLICY, qualification: qualification([{ requestId: caseRequestId(id, "r1"), family: "unknown", provenance: { kind: "intake_hint", source: { type: "email", id } } }]) });
const RESET = { id: "k-reset", contentVersionId: "k-reset-v1", title: "Réinitialiser l'accès", content: "Procédure synthétique.", source: "fixture", verifiedAt: "2026-10-01T00:00:00Z", semanticScore: null,
  resolution: { steps: ["Étape synthétique"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as SavRetrievalCandidate;
const RESET_REF = { knowledgeId: RESET.id, contentVersionId: RESET.contentVersionId };

/** The customer texts the runner may read, by `email:<id>`: synthetic. */
const texts: Record<string, string> = {};
/** Mail relayed by V1: the first one admitting, later ones with intake hints only (contract v8). */
async function mail(ticketId: string, threadId: string, id: string, text: string, admission: CaseAdmissionInput, admissionMode?: "exclusions_only") {
  texts[`email:${id}`] = text;
  return (await openCaseEvent({ ticketId, threadId, admission, admissionMode, opens: [{ id: caseRequestId(id, "r1"), summary: "Demande synthétique." }], kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(id), sourceRef: { type: "email", id }, occurredAt: new Date().toISOString() })).case;
}
/** A thank-you on the case thread: V1 opens no request for an acknowledgement (`caseRequestsOpenedByIntake`). */
async function thanksMail(ticketId: string, threadId: string, id: string, text: string) {
  texts[`email:${id}`] = text;
  return (await openCaseEvent({ ticketId, threadId, admission: { policy: POLICY, qualification: qualification([]) }, admissionMode: "exclusions_only", opens: [], kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(id), sourceRef: { type: "email", id }, occurredAt: new Date().toISOString() })).case;
}
async function accessCase(gmail: string) {
  const ticketId = String(++ticketSeq), threadId = randomUUID();
  return { ticketId, threadId, c: await mail(ticketId, threadId, gmail, "Bonjour, je n'arrive plus à me connecter.", byRule(gmail)) };
}

const understood = (snapshot: CaseSnapshot) => ({ requests: snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] });
const reply = (text: string) => ({ text, citations: [RESET_REF], impossibilityClaims: [], accountAdvice: "none" });
/** The procedure of the reset card, with the access link `link`. */
const answer = (link: string) => (request: CaseInvestigationModelRequest): CaseInvestigationModelResult => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "answer", requestIds: [u.requests[0]!.id], steps: [{ text: "Suivre la fiche « Réinitialiser l'accès ».", knowledge: RESET_REF }], expectedResult: "La connexion fonctionne." },
    reply: reply(`Bonjour, voici la marche à suivre depuis ${link} : Réinitialiser l'accès.`) } };
};
const confirm = (mailId: string, trialId: string, quote: string) => (request: CaseInvestigationModelRequest): CaseInvestigationModelResult => {
  const u = understood(request.snapshot), requestId = u.requests[0]!.id;
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u, nextAction: { kind: "confirm_resolution", requestIds: [requestId], evidence: [{ requestId, source: { type: "email", id: mailId }, trialId, quote }] } } };
};
const resolved = (request: CaseInvestigationModelRequest): CaseInvestigationModelResult =>
  ({ status: "ok", output: { verdicts: request.snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ requestId: row.id, verdict: "resolved" })) } });

type Answer = (request: CaseInvestigationModelRequest) => CaseInvestigationModelResult;
type Run = { report: Awaited<ReturnType<typeof runCaseInvestigation>>; calls: CaseInvestigationModelRequest[] };
async function investigate(caseId: string, answers: Answer[], options: { at?: number; rules?: boolean; during?: () => Promise<void> } = {}): Promise<Run> {
  const calls: CaseInvestigationModelRequest[] = [];
  const ports = caseInvestigationStorePorts({
    // Witness: the ticket explicitly carries the V2 owner (Ugo 31/10, the owner read fails closed without it).
    readTicketOwner: async () => "v2",
    holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" },
    now: () => new Date(Date.now() + (options.at ?? 6 * 60_000)),
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level, knowledge: async () => [RESET],
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, texts[`${row.type}:${row.id}`]]).filter(([, text]) => text !== undefined)),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => {
      calls.push(request);
      const next = answers.shift();
      if (options.during) { const during = options.during; options.during = undefined; await during(); }
      return next?.(request) ?? { status: "failed", uncertain: false };
    },
    admissionPolicyRevision: async () => "policy-r1",
    // The approved rule qualifies the case's open requests as access; `rules` off: no rule qualifies (Q10, team).
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open")
        .map(row => ({ requestId: row.id, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } }));
      return options.rules && latest ? { admission: { policy: POLICY, qualification: qualification(requests) }, sourceRef: latest.sourceRef } : null;
    },
  });
  return { report: await runCaseInvestigation(caseId, "observe", ports), calls };
}

/**
 * SIMULATED intention: what the latest accepted decision would ask an executor to do, and what in today's pole A read
 * or the live pause would stop it. Reads only; sends nothing. Its blockers are this test's assumptions, not SAV-10's.
 */
async function simulatedIntent(caseId: string) {
  const events = await listCaseEvents(caseId);
  const observation = events.filter(event => event.kind === "observation_recorded").at(-1);
  const record = observation?.detail?.record as CaseInvestigationStoredRecord | undefined;
  if (!observation || !record?.decision || record.decision.validation.outcome !== "accepted") return null;
  const output = record.progress.proposal?.output as { nextAction: { kind: string }; reply?: { text: string } };
  const snapshot = (await readCase(caseId))!, pause = await readSavAgentPause(f.db as never, "v2");
  const blockers = [
    ...(snapshot.owner === "agent" ? [] : [`owner_${snapshot.owner}`]),
    ...(pause.invalid ? ["pause_unreadable"] : pause.level === "running" ? [] : [`pause_${pause.level}`]),
    ...(latestInvestigationInput(events) === record.inputKey ? [] : ["newer_input"]),
    ...(events.some(event => event.kind === "outbound_observed" && event.caseVersion > observation.caseVersion) ? ["already_applied"] : []),
  ];
  return { action: output.nextAction.kind, replyText: output.reply?.text ?? null, inputKey: record.inputKey, actionsPaused: record.decision.actionsPaused, closure: record.decision.closure?.plan ?? null, blockers };
}
/** SIMULATED: a person sends the prepared draft; pole A then holds the step as a pending trial. */
async function simulatedSend(caseId: string, id: string, trialId: string) {
  const sentAt = new Date().toISOString();
  await appendCaseEvent({ caseId, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: caseDedupeKey.outbound(id), sourceRef: { type: "email", id }, occurredAt: sentAt });
  const c = (await readCase(caseId))!;
  await updateCaseRecord({ caseId, expectedVersion: c.version, actor: { type: "agent" },
    body: { ...c.body, trials: [...c.body.trials, { id: trialId, requestId: c.body.openRequests[0]!.id, procedure: RESET_REF, askedAt: sentAt, outcome: "pending", resultAt: null }] } });
}
async function setV2Pause(level: "actions_paused" | "fully_paused" | null) {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
}
async function effects(caseId: string) {
  const events = await listCaseEvents(caseId);
  return { agentOutbound: events.filter(event => event.kind === "outbound_observed").length, timers: (await listCaseTimers(caseId)).length,
    acting: (await readCase(caseId))!.phase === "acting", network: vi.mocked(fetch).mock.calls.length };
}
const observations = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "observation_recorded");
const codesOf = (calls: CaseInvestigationModelRequest[]) => calls.map(call => call.feedback.map(row => row.code));

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "access-journey-fixture-key-32-chars-x");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
});
afterEach(async () => { await setV2Pause(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("V2 access journey on the real pole A store: mail → admission → decision → simulated intention (night 29→30/10)", () => {
  it("answers with the canonical link after a refused redirect, waits, survives a note and a technical hold, then reads the thanks", async () => {
    const { ticketId, threadId, c } = await accessCase("gm-acc-1");
    expect(c).toMatchObject({ owner: "agent", admission: { target: "agent" }, body: { openRequests: [{ id: "gm-acc-1/r1", family: "access", status: "open" }] } });

    // 1. Within the 5-minute quiet period (Q4): refused by pole A, no call, nothing written.
    const early = await investigate(c.caseId, [answer("https://new.limova.ai")], { at: 0 });
    expect(early.report).toMatchObject({ status: "claim_refused", reason: "settling", modelCalls: 0 });
    expect(await observations(c.caseId)).toEqual([]);

    // 2. A canonical host hiding a redirect is refused with its code; the corrected answer is accepted.
    const first = await investigate(c.caseId, [answer("https://new.limova.ai/?next=https://attacker.invalid"), answer("https://new.limova.ai")]);
    expect(first.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2, actionsPaused: false });
    expect(codesOf(first.calls)).toEqual([[], ["access_link_missing", "access_link_invalid"]]);
    const intent = await simulatedIntent(c.caseId);
    expect(intent).toMatchObject({ action: "answer", actionsPaused: false, blockers: [] });
    expect(intent!.replyText).toContain("https://new.limova.ai :");
    expect(await effects(c.caseId)).toEqual({ agentOutbound: 0, timers: 0, acting: false, network: 0 });

    // 3. A person sends the draft (simulated): the intention is now applied, and never applied twice.
    await simulatedSend(c.caseId, "out-acc-1", "t1");
    expect((await simulatedIntent(c.caseId))!.blockers).toEqual(["already_applied"]);

    // 4. A HubSpot note: no new input, no call.
    await appendCaseEvent({ caseId: c.caseId, kind: "crm_observed", dedupeKey: caseDedupeKey.crm("ticket-acc", "2026-10-29T10:00:00Z"), sourceRef: { type: "hubspot_object", id: "ticket-acc" }, occurredAt: AT, detail: { crmChange: "note_added" } });
    const afterNote = await investigate(c.caseId, [answer("https://new.limova.ai")]);
    expect(afterNote.report).toMatchObject({ status: "already_recorded", modelCalls: 2 });
    expect(afterNote.calls).toEqual([]);

    // 5. A technical hold, then its release with a fresh admission (Q9): nothing runs while held, no new budget after.
    const now = (await readCase(c.caseId))!;
    const held = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: now.version, transition: "technical_hold", actor: { type: "system" }, commandKey: `hold-acc-${c.caseId}`, reason: "incident" });
    expect((await investigate(c.caseId, [answer("https://new.limova.ai")])).report).toMatchObject({ status: "skipped", reason: "not_agent_owned", modelCalls: 0 });
    await transitionCaseOwner({ caseId: c.caseId, expectedVersion: held.case.version, transition: "hold_release", to: "agent", actor: { type: "human", staffUserId: STAFF },
      commandKey: `release-acc-${c.caseId}`, reason: "incident_over", admission: byRule("gm-acc-1") });
    const released = await investigate(c.caseId, [answer("https://new.limova.ai")]);
    expect(released.report).toMatchObject({ status: "already_recorded" });
    expect(released.calls).toEqual([]);

    // 6. The customer thanks us; the rules qualify the new mail (Q10) and the quote is found in it.
    await thanksMail(ticketId, threadId, "gm-acc-2", "Merci, ça remarche depuis le lien !");
    const thanks = await investigate(c.caseId, [confirm("gm-acc-2", "t1", "ça remarche"), resolved, confirm("gm-acc-2", "t1", "ça remarche")], { rules: true });
    // Known, documented (score 4, no change tonight): the hold and its release count as human interventions between our
    // step and the thanks (decision-context.ts), so the closure is refused and the customer is asked to confirm instead.
    expect(thanks.report).toMatchObject({ status: "recorded", outcome: "needs_review" });
    expect(codesOf(thanks.calls)[1]).toEqual(["resolution_evidence_invalid"]);
    expect(await effects(c.caseId)).toMatchObject({ agentOutbound: 1, acting: false, network: 0 });
  });

  it("without a hold, the same thanks is read twice and planned as a soft closure", async () => {
    const { ticketId, threadId, c } = await accessCase("gm-acc-3");
    expect((await investigate(c.caseId, [answer("https://new.limova.ai")])).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    await simulatedSend(c.caseId, "out-acc-3", "t1");
    await thanksMail(ticketId, threadId, "gm-acc-4", "Merci, ça remarche !");
    const thanks = await investigate(c.caseId, [confirm("gm-acc-4", "t1", "ça remarche"), resolved], { rules: true });
    expect(thanks.report).toMatchObject({ status: "recorded", outcome: "accepted", closure: "soft_close", modelCalls: 2 });
    expect(thanks.calls.map(call => call.purpose)).toEqual(["decision", "resolution_check"]);
    expect(await simulatedIntent(c.caseId)).toMatchObject({ action: "confirm_resolution", closure: "soft_close", blockers: [] });
    expect(await effects(c.caseId)).toMatchObject({ agentOutbound: 1, timers: 0, acting: false, network: 0 });
  });

  it("a person takes the case: nothing runs; handed back, the agent gets a new budget of its own", async () => {
    const { c } = await accessCase("gm-acc-5");
    expect((await investigate(c.caseId, [answer("https://new.limova.ai")])).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    const now = (await readCase(c.caseId))!;
    const taken = await transitionCaseOwner({ caseId: c.caseId, expectedVersion: now.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `take-acc-${c.caseId}`, reason: "personal" });
    expect((await simulatedIntent(c.caseId))!.blockers).toEqual(["owner_human", "newer_input"]);
    const whileHuman = await investigate(c.caseId, [answer("https://new.limova.ai")]);
    expect(whileHuman.report).toMatchObject({ status: "skipped", reason: "not_agent_owned", modelCalls: 0 });
    await transitionCaseOwner({ caseId: c.caseId, expectedVersion: taken.case.version, transition: "hand_back", to: "agent", actor: { type: "human", staffUserId: STAFF },
      commandKey: `back-acc-${c.caseId}`, reason: "back_to_agent", admission: byRule("gm-acc-5") });
    const back = await investigate(c.caseId, [answer("https://new.limova.ai")]);
    expect(back.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(back.calls[0]!.inputKey).toMatch(/^back:/);
    expect((await simulatedIntent(c.caseId))!.blockers).toEqual([]);
  });

  it("actions_paused: the decision is recorded and marked, and the simulated intention is held by the live pause until it ends", async () => {
    const { c } = await accessCase("gm-acc-6");
    await setV2Pause("actions_paused");
    expect((await investigate(c.caseId, [answer("https://new.limova.ai")])).report).toMatchObject({ status: "recorded", outcome: "accepted", actionsPaused: true });
    expect(await simulatedIntent(c.caseId)).toMatchObject({ actionsPaused: true, blockers: ["pause_actions_paused"] });
    await setV2Pause("fully_paused");
    expect((await simulatedIntent(c.caseId))!.blockers).toEqual(["pause_fully_paused"]);
    await setV2Pause(null);
    expect((await simulatedIntent(c.caseId))!.blockers).toEqual([]);
    expect(await effects(c.caseId)).toEqual({ agentOutbound: 0, timers: 0, acting: false, network: 0 });
  });

  it("versions: a mail arriving during the call drops the decision; the new mail gets its own budget", async () => {
    const { ticketId, threadId, c } = await accessCase("gm-acc-7");
    const during = async () => { await mail(ticketId, threadId, "gm-acc-8", "Je précise : le message dit « session expirée ».", hint("gm-acc-8"), "exclusions_only"); };
    const raced = await investigate(c.caseId, [answer("https://new.limova.ai")], { during });
    expect(raced.report).toMatchObject({ status: "stale_requeue", modelCalls: 1 });
    expect(await simulatedIntent(c.caseId)).toBeNull();
    const next = await investigate(c.caseId, [answer("https://new.limova.ai")], { rules: true });
    expect(next.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(next.calls[0]!.inputKey).not.toBe(raced.calls[0]!.inputKey);
    expect((await simulatedIntent(c.caseId))!.blockers).toEqual([]);
  });
});
