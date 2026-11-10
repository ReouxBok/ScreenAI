import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { emptyCaseBody, SAV_CASE_ADMISSION_REVISION, SAV_CASE_CONTRACT_REVISION, type CaseAdmissionRecord, type CaseBody, type CaseEvent, type CaseSnapshot } from "./case-types";
import { caseAdmissionStatus } from "./admission-policy";
import { caseDecisionRejectionLabels } from "./decision-contract";
import { caseInvestigationGate, caseInvestigationGateLabels } from "./investigation-gate";
import { caseDecisionNextStepLabels } from "./decision-recovery";
import { SAV_CASE_INVESTIGATION_RECORD_KIND } from "./investigation-record";
import { listCaseInvestigationWaits } from "./investigation-waits";
import {
  latestInvestigationInput, runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS,
  type CaseInvestigationClaimRefusal, type CaseInvestigationModelRequest, type CaseInvestigationModelResult, type CaseInvestigationPorts, type CaseInvestigationProgress,
  type CaseInvestigationRecord, type CaseInvestigationTicketOwner,
} from "./investigation-runner";

// Fake ports and frozen fixtures only: no database, no model, no network, no customer content.
const knowledge: SavRetrievalCandidate[] = [Object.freeze({
  id: "k1", contentVersionId: "k1-v1", title: "Fiche k1", content: "Procédure synthétique.", source: "fixture",
  verifiedAt: "2026-10-01T00:00:00Z", semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
}) as SavRetrievalCandidate];
const usage = { id: "r1", summary: "Demande synthétique.", family: "usage" as const, status: "open" as const };
/** A positive pole A admission decided after input version `inputVersion`, under policy "policy-r1". */
const agentAdmission = (inputVersion = 1): CaseAdmissionRecord => ({ revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none", families: ["usage"],
  sensitivity: "none", policyRevision: "policy-r1", decidedAt: "2026-10-20T09:00:02Z", version: inputVersion + 1, inputVersion,
  qualification: { requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] } });
type LooseBody = Partial<Omit<CaseBody, "openRequests">> & { openRequests?: Array<Omit<CaseBody["openRequests"][number], "openedAt"> & { openedAt?: string }> };
const opened = (body: LooseBody): Partial<CaseBody> => body.openRequests ? { ...body, openRequests: body.openRequests.map(row => ({ openedAt: "2026-10-20T09:00:00Z", ...row })) } : body as Partial<CaseBody>;
function snapshot(patch: Partial<CaseSnapshot> = {}, body: LooseBody = {}): CaseSnapshot {
  return { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "ticket-1", threadIds: ["thread-1"], version: 2,
    owner: "agent", phase: "queued", sensitivity: "none", createdAt: "2026-10-20T09:00:01Z", updatedAt: "2026-10-20T09:00:01Z",
    body: { ...emptyCaseBody(), ...opened({ openRequests: [usage], ...body }) } as CaseBody, admission: agentAdmission(), admissionInputVersion: 1, ...patch };
}
const inbound: CaseEvent = { id: "e1", caseId: "case-1", kind: "inbound_confirmed", dedupeKey: "inbound:m1", caseVersion: 1, direction: "customer_inbound",
  occurredAt: "2026-10-20T09:00:00Z", sourceRef: { type: "email", id: "m1" }, detail: null, createdAt: "2026-10-20T09:00:01Z" };

const ask = (version = 2) => ({ caseVersion: version, understanding: { requests: [{ id: "r1", summary: "Demande.", family: "usage", status: "open" }], newFacts: [] },
  nextAction: { kind: "ask", questions: [{ text: "Quel résultat obtenez-vous après l'opération ?", requestId: "r1", reducesUncertainty: "Savoir où cela échoue.", seeks: [{ kind: "observed_result" }] }] } });
const malformed = () => ({ ...ask(), nextAction: { kind: "ask" } });
const askingPassword = () => ({ ...ask(), nextAction: { kind: "ask", questions: [{ text: "Pouvez-vous nous envoyer votre mot de passe ?", requestId: "r1", reducesUncertainty: "x", seeks: [{ kind: "credential" }] }] } });

type Fake = { ports: CaseInvestigationPorts; calls: CaseInvestigationModelRequest[]; records: CaseInvestigationRecord[]; log: string[]; progress: Map<string, CaseInvestigationProgress>; reevaluated: CaseSnapshot[] };
/** What the ticket's HubSpot owner read answers, in order (the last answer repeats); `absent`: no read port at all. */
type OwnerRead = CaseInvestigationTicketOwner | "throws";
function fake(options: {
  /** Required: an agent witness states that its ticket carries the V2 owner; nothing defaults to it. */
  owner: OwnerRead | OwnerRead[] | "absent";
  snap?: CaseSnapshot; events?: CaseEvent[]; policy?: string | null; paused?: boolean; pauseFrom?: number; claim?: boolean;
  claimRefusal?: { refused: CaseInvestigationClaimRefusal; retryAt?: string };
  model?: CaseInvestigationModelResult[]; versionAfter?: number | null; progress?: Map<string, CaseInvestigationProgress>;
  texts?: Record<string, string>;
  /** Pause level read by the runner when not fully paused, and pole A's reading under the claim lock. */
  level?: "running" | "actions_paused"; claimActionsPaused?: boolean;
  /** Q10 re-evaluation result, and the case read after a `reevaluated` one. */
  reevaluate?: "reevaluated" | "handed_off" | "version_moved"; afterReevaluation?: CaseSnapshot;
}): Fake {
  let snap = options.snap ?? snapshot();
  const log: string[] = [], calls: CaseInvestigationModelRequest[] = [], records: CaseInvestigationRecord[] = [], reevaluated: CaseSnapshot[] = [];
  const answers = [...(options.model ?? [{ status: "ok", output: ask() }])];
  const events = options.events ?? [inbound];
  // Shared between runs to simulate the durable store a resumed run reads back.
  const progress = options.progress ?? new Map<string, CaseInvestigationProgress>();
  let reads = 0, pauses = 0;
  const owners = options.owner === "absent" ? [] : Array.isArray(options.owner) ? [...options.owner] : [options.owner];
  const ports: CaseInvestigationPorts = {
    scope: { locale: "fr-FR", audience: "support" },
    pauseState: async () => { log.push("pause"); pauses += 1; return options.paused || (options.pauseFrom !== undefined && pauses >= options.pauseFrom) ? "fully_paused" : options.level ?? "running"; },
    readCase: async () => {
      log.push("read"); reads += 1;
      if (reads > 1 && options.versionAfter !== undefined) return options.versionAfter === null ? null : { snapshot: { ...snap, version: options.versionAfter }, events };
      return { snapshot: snap, events };
    },
    admissionPolicyRevision: async () => { log.push("admission"); return options.policy === undefined ? "policy-r1" : options.policy; },
    reevaluateAdmission: async snapshotArg => {
      log.push("reevaluate");
      reevaluated.push(structuredClone(snapshotArg));
      const result = options.reevaluate ?? "handed_off";
      if (result !== "version_moved" && options.afterReevaluation) snap = options.afterReevaluation;
      return result;
    },
    claim: async () => { log.push("claim"); return options.claim === false ? { refused: "busy" } : options.claimRefusal ?? { token: "lease-1", actionsPaused: options.claimActionsPaused ?? false }; },
    release: async () => { log.push("release"); },
    knowledge: async () => { log.push("knowledge"); return knowledge; },
    customerTexts: async () => options.texts ?? { "email:m1": "Bonjour, je n'arrive pas à faire l'opération.", "email:m2": "Merci beaucoup, ça remarche maintenant !" },
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => { log.push("model"); calls.push(request); return answers.shift() ?? { status: "failed", uncertain: false }; },
    progress: {
      load: async (caseId, inputKey) => { log.push("progress"); return structuredClone(progress.get(`${caseId}:${inputKey}`) ?? null); },
      save: async (caseId, inputKey, value) => { progress.set(`${caseId}:${inputKey}`, structuredClone(value)); },
    },
    record: async record => { log.push("record"); records.push(record); },
    now: () => new Date("2026-10-27T12:00:00Z"),
    ...(options.owner === "absent" ? {} : { readTicketOwner: async () => {
      log.push("owner");
      const answer = owners.length > 1 ? owners.shift()! : owners[0]!;
      if (answer === "throws") throw Error("CRM_UNREADABLE");
      return answer;
    } }),
  };
  return { ports, calls, records, log, progress, reevaluated };
}

afterEach(() => vi.unstubAllGlobals());

describe("Ugo 31/10: a ticket a person owns is not handled by V2 (owner read, fail closed)", () => {
  it.each([
    ["no owner read port", "absent", "ticket_owner_unverified", "owner_read_unavailable"],
    ["a failed read", "throws", "ticket_owner_unverified", "owner_read_failed"],
    ["no owner on the ticket", "none", "ticket_owner_unverified", "none"],
    ["an unknown owner", "unknown", "ticket_owner_unverified", "unknown"],
    ["a person", "human", "ticket_owner_human", "human"],
  ] as const)("stops an agent case on %s before any lease, search or call", async (_name, owner, reason, detail) => {
    const run = fake({ owner });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toEqual({ status: "skipped", caseId: "case-1", caseVersion: 2, reason, detail, modelCalls: 0 });
    expect(run.log).toEqual(["pause", "read", "admission", ...(owner === "absent" ? [] : ["owner"])]);
    expect(run.calls).toEqual([]);
    expect(run.records).toEqual([]);
    expect(run.progress.size).toBe(0);
  });
  it("an answer outside the contract is not the V2 owner", async () => {
    const run = fake({ owner: "v2" });
    run.ports.readTicketOwner = async () => "90000001" as never;
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "skipped", reason: "ticket_owner_unverified", detail: "owner_read_invalid", modelCalls: 0 });
  });
  it("reads the owner before the re-evaluation of a newer input: a person's ticket gets no admission write", async () => {
    const run = fake({ owner: "human", snap: snapshot({ version: 3, admissionInputVersion: 3 }), reevaluate: "reevaluated" });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "skipped", reason: "ticket_owner_human", modelCalls: 0 });
    expect(run.log).toEqual(["pause", "read", "admission", "owner"]);
    expect(run.reevaluated).toEqual([]);
  });
  it("does not read the owner of a case the gate already closes (team, sensitive): nothing to protect, nothing asked", async () => {
    const run = fake({ owner: "throws", snap: snapshot({ owner: "human", phase: "handoff_pending" }) });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "skipped", reason: "not_agent_owned", modelCalls: 0 });
    expect(run.log).not.toContain("owner");
  });
  it.each(["human", "unknown", "throws"] as const)("a change to %s while the lease is taken: no search, text read or progress, lease released", async change => {
    const run = fake({ owner: ["v2", change] });
    let texts = 0;
    run.ports.customerTexts = async () => { texts++; return {}; };
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toEqual({ status: "ticket_owner_stop", caseId: "case-1", caseVersion: 2, reason: change === "human" ? "ticket_owner_human" : "ticket_owner_unverified", detail: change === "throws" ? "owner_read_failed" : change, modelCalls: 0 });
    expect(run.log).toEqual(["pause", "read", "admission", "owner", "claim", "owner", "release"]);
    expect(texts).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.records).toEqual([]);
    expect(run.progress.size).toBe(0);
  });
  it.each(["human", "unknown", "throws"] as const)("a change to %s after the lease and the search: no call, nothing recorded, lease released", async change => {
    const run = fake({ owner: ["v2", "v2", change] });
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toMatchObject({ status: "ticket_owner_stop", reason: change === "human" ? "ticket_owner_human" : "ticket_owner_unverified", modelCalls: 0 });
    expect(run.log).toEqual(["pause", "read", "admission", "owner", "claim", "owner", "progress", "knowledge", "pause", "owner", "release"]);
    expect(run.calls).toEqual([]);
    expect(run.records).toEqual([]);
    expect(run.progress.size).toBe(0);
  });
  it("a change while a correction call would follow: the next call is not made, the first one and its proposal stay in the progress", async () => {
    const run = fake({ owner: ["v2", "v2", "v2", "human"], model: [ok(malformed()), ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "ticket_owner_stop", reason: "ticket_owner_human", modelCalls: 1 });
    expect(run.calls).toHaveLength(1);
    expect(run.records).toEqual([]);
    expect([...run.progress.values()]).toMatchObject([{ modelCalls: 1, proposal: { proposedOn: 2 }, recordedOn: null }]);
  });
  it("a change after the last call: the decision is not recorded as a proposal; the call stays counted", async () => {
    const run = fake({ owner: ["v2", "v2", "v2", "human"] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "ticket_owner_stop", reason: "ticket_owner_human", modelCalls: 1 });
    expect(run.log.slice(-4)).toEqual(["model", "read", "owner", "release"]);
    expect(run.records).toEqual([]);
    expect([...run.progress.values()]).toMatchObject([{ modelCalls: 1, recordedOn: null }]);
  });
});

describe("SAV-7 automatic admission re-evaluation after a new input (Q10, Ugo 28/10)", () => {
  // Admitted after input 1; input 3 is newer. After the re-evaluation: version 4, admission covering input 3.
  const stale = snapshot({ version: 3, admissionInputVersion: 3 });
  const readmitted = snapshot({ version: 4, admissionInputVersion: 3, admission: agentAdmission(3) });
  it("re-evaluates once by the approved rules, reads again and goes on with no human validation", async () => {
    const run = fake({ owner: "v2", snap: stale, reevaluate: "reevaluated", afterReevaluation: readmitted, model: [ok(ask(4))] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", caseVersion: 4, outcome: "accepted", modelCalls: 1 });
    expect(run.log.slice(0, 7)).toEqual(["pause", "read", "admission", "owner", "reevaluate", "read", "claim"]);
    // The re-evaluation gets the case as read, before any model call: no model output can qualify it.
    expect(run.reevaluated).toEqual([stale]);
    expect(run.log.indexOf("reevaluate")).toBeLessThan(run.log.indexOf("model"));
  });
  it("leaves the case with the team when the rules withdraw it, with pole A's reason, and spends nothing", async () => {
    const team = snapshot({ version: 5, owner: "human", phase: "handoff_pending", admissionInputVersion: 3,
      admission: { ...agentAdmission(3), target: "team", reasons: ["family_not_admitted"], nextStep: "team_takeover" } });
    const run = fake({ owner: "v2", snap: stale, reevaluate: "reevaluated", afterReevaluation: team });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toEqual({ status: "skipped", caseId: "case-1", caseVersion: 5, reason: "not_agent_owned", detail: "human", modelCalls: 0 });
    expect(run.log).not.toContain("claim");
  });
  it.each([
    // Q10: out of the approved rules means out of scope: the team takes it, read again, never left stale with the agent.
    ["no approved rule qualifies the input", "handed_off", { status: "skipped", caseId: "case-1", caseVersion: 4, reason: "not_agent_owned", detail: "human", modelCalls: 0 }],
    ["the case moved meanwhile", "version_moved", { status: "claim_refused", caseId: "case-1", reason: "busy", modelCalls: 0 }],
  ] as const)("does not investigate when %s", async (_name, reevaluate, report) => {
    const run = fake({ owner: "v2", snap: stale, reevaluate, afterReevaluation: snapshot({ version: 4, owner: "human", phase: "handoff_pending", admissionInputVersion: 3 }) });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toEqual(report);
    expect(run.log.filter(step => step === "reevaluate")).toHaveLength(1);
    expect(run.log).not.toContain("claim");
  });
  it("never loops: a re-evaluation that still leaves a newer input is not retried in the same run", async () => {
    const run = fake({ owner: "v2", snap: stale, reevaluate: "reevaluated", afterReevaluation: snapshot({ version: 4, admissionInputVersion: 4 }) });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "skipped", reason: "admission_stale", detail: "input_newer" });
    expect(run.log.filter(step => step === "reevaluate")).toHaveLength(1);
  });
  it.each([
    ["a human owner (a human stays human)", { snap: snapshot({ owner: "human", phase: "human_owned", admissionInputVersion: 3 }) }],
    ["a sensitive case", { snap: snapshot({ admissionInputVersion: 3 }, { openRequests: [usage, { ...usage, id: "r2", family: "subscription" }] }) }],
    ["a changed policy (reviewed on its own, not per message)", { policy: "policy-r2" }],
    ["no admission at all", { snap: snapshot({ admission: null }) }],
    ["an admission to the team", { snap: snapshot({ admission: { ...agentAdmission(), target: "team", reasons: ["family_not_admitted"], nextStep: "team_takeover" } }) }],
    ["no approved policy", { policy: null }],
  ])("never re-evaluates for %s", async (_name, options) => {
    const run = fake({ owner: "v2", ...options, reevaluate: "reevaluated", afterReevaluation: readmitted });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(run.log).not.toContain("reevaluate");
  });
});

describe("SAV-7 gate before any claim or model call", () => {
  it.each([
    ["finance alone", snapshot({ sensitivity: "finance", owner: "human", phase: "handoff_pending" }, { openRequests: [{ ...usage, family: "finance" }] }), "excluded_sensitive"],
    ["support mixed with a refund request", snapshot({ sensitivity: "finance", owner: "human", phase: "handoff_pending" }, { openRequests: [usage, { ...usage, id: "r2", family: "finance" }] }), "excluded_sensitive"],
    ["cancellation", snapshot({ sensitivity: "cancellation", owner: "human", phase: "handoff_pending" }, { openRequests: [{ ...usage, family: "cancellation" }] }), "excluded_sensitive"],
    ["subscription even with an agent owner (excluded family)", snapshot({}, { openRequests: [usage, { ...usage, id: "r2", family: "subscription" }] }), "excluded_sensitive"],
    ["a human owner after a new inbound", snapshot({ owner: "human", phase: "human_owned" }), "not_agent_owned"],
    ["an administrative hold", snapshot({ owner: "system_hold" }), "not_agent_owned"],
  ])("refuses %s before claim, retrieval or model call (no V2 call to say handoff)", async (_name, snap, reason) => {
    const run = fake({ owner: "v2", snap });
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toMatchObject({ status: "skipped", reason, modelCalls: 0 });
    expect(run.log).toEqual(["pause", "read", "admission"]);
    expect(run.calls).toEqual([]);
    expect(run.records).toEqual([]);
  });
  it.each([
    ["no admission", { snap: snapshot({ admission: null }) }, "admission_missing"],
    ["no approved admission policy", { policy: null }, "admission_missing"],
    ["a team admission", { snap: snapshot({ admission: { ...agentAdmission(), target: "team" } }) }, "admission_not_positive"],
    ["a newer customer input after the admission", { snap: snapshot({ admissionInputVersion: 3 }) }, "admission_stale"],
    ["a changed admission policy", { policy: "policy-r2" }, "admission_stale"],
  ])("refuses %s: owner=agent is not enough", async (_name, options, reason) => {
    const run = fake({ owner: "v2", ...options });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "skipped", reason, modelCalls: 0 });
    expect(run.log).not.toContain("claim");
  });
  it("keeps a pole A admission fresh across non-input versions (CRM note, timer, observation): no exact-version rule (contract v6)", async () => {
    // Admission decided after input 1; the case is now at version 7 through notes, timers and observations only.
    const run = fake({ owner: "v2", snap: snapshot({ version: 7, admissionInputVersion: 1 }), model: [ok(ask(7))] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", caseVersion: 7, outcome: "accepted", modelCalls: 1 });
    expect(caseInvestigationGate(snapshot({ version: 7, admissionInputVersion: 2 }), caseAdmissionStatus(snapshot({ version: 7, admissionInputVersion: 2 }), "policy-r1")))
      .toEqual({ open: false, reason: "admission_stale", detail: "input_newer" });
  });
  it("puts the sensitive reason first even when other conditions also close the gate", () => {
    expect(caseInvestigationGate(snapshot({ sensitivity: "finance", owner: "human", phase: "handoff_pending" }), null)).toEqual({ open: false, reason: "excluded_sensitive", detail: "finance" });
    expect(caseInvestigationGate(snapshot({}, { openRequests: [{ ...usage, status: "resolved" }] }), { admitted: true })).toMatchObject({ reason: "no_open_request" });
    expect(Object.values(caseInvestigationGateLabels).every(label => label.length > 20)).toBe(true);
  });
});

describe("SAV-7 operational waits are not business exclusions", () => {
  it("does nothing at all when the mode is off (default)", async () => {
    const run = fake({ owner: "v2" });
    expect(await runCaseInvestigation("case-1", "off", run.ports)).toEqual({ status: "off", caseId: "case-1", modelCalls: 0 });
    expect(run.log).toEqual([]);
  });
  it("stops at the case-wide ceiling (Ugo 28/10): no call consumed, a visible wait with its retry time, nothing recorded", async () => {
    const run = fake({ owner: "v2", model: [{ status: "case_budget_exhausted", retryAt: "2026-10-28T09:00:00Z" }] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports))
      .toEqual({ status: "case_budget_exhausted", caseId: "case-1", caseVersion: 2, retryAt: "2026-10-28T09:00:00Z", modelCalls: 0 });
    expect(run.calls[0]).toMatchObject({ caseBudgetKey: "sav-case:case-1", subjectKey: "sav-case:case-1:in:e1" });
    expect(run.records).toEqual([]);
    expect(run.progress.get("case-1:in:e1")).toMatchObject({ modelCalls: 0, attempts: [], waiting: { reason: "case_budget" } });
    expect(listCaseInvestigationWaits([{ caseId: "case-1", inputKey: "in:e1", progress: run.progress.get("case-1:in:e1")! }], new Date("2026-10-27T12:30:00Z")))
      .toMatchObject([{ reason: "case_budget", needsPerson: false, waitingMinutes: 30 }]);
  });
  it("keeps the calls already made when the case ceiling stops an investigation half-way, and resumes the same input after it", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    const first = fake({ owner: "v2", progress, model: [ok(malformed()), { status: "case_budget_exhausted", retryAt: "2026-10-28T09:00:00Z" }] });
    expect(await runCaseInvestigation("case-1", "observe", first.ports)).toMatchObject({ status: "case_budget_exhausted", modelCalls: 1 });
    const later = fake({ owner: "v2", progress, model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", later.ports)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
    expect(later.calls.map(call => call.callKey)).toEqual(["sav-case:case-1:in:e1:call2"]);
  });
  it("stops on the V2 pause before reading the case", async () => {
    const run = fake({ owner: "v2", paused: true });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "paused", modelCalls: 0 });
    expect(run.log).toEqual(["pause"]);
  });
  it("reports a budget deferral with zero model calls and nothing recorded", async () => {
    const run = fake({ owner: "v2", model: [{ status: "deferred" }] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toEqual({ status: "deferred_budget", caseId: "case-1", caseVersion: 2, modelCalls: 0 });
    expect(run.records).toEqual([]);
    // Visible as a wait, with no attempt consumed.
    expect(run.progress.get("case-1:in:e1")).toEqual({ modelCalls: 0, attempts: [], proposal: null, last: null, closure: null, recordedOn: null, waiting: { reason: "deferred_budget", since: "2026-10-27T12:00:00.000Z", caseVersion: 2 } });
    expect(run.log.at(-1)).toBe("release");
  });
  it("leaves another worker's lease alone", async () => {
    const run = fake({ owner: "v2", claim: false });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "claim_refused", reason: "busy", modelCalls: 0 });
    expect(run.log).not.toContain("model");
    expect(run.log).not.toContain("release");
  });
  it.each([
    [{ refused: "settling" as const, retryAt: "2026-10-27T12:05:00Z" }, { status: "claim_refused", reason: "settling", retryAt: "2026-10-27T12:05:00Z", modelCalls: 0 }],
    [{ refused: "admission" as const }, { status: "claim_refused", reason: "admission", modelCalls: 0 }],
    [{ refused: "paused" as const }, { status: "paused", caseId: "case-1", modelCalls: 0 }],
  ])("reports the store's claim refusal %o as such, with no call and nothing stored", async (claimRefusal, expected) => {
    const run = fake({ owner: "v2", claimRefusal });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toEqual({ caseId: "case-1", ...expected });
    expect(run.calls).toEqual([]);
    expect(run.progress.size).toBe(0);
  });
  it("lets the shared ledger, not the lost local count, decide that the calls of an input are spent", async () => {
    // A crashed run spent calls whose progress was never saved: the ledger refuses a new one.
    const crashed = fake({ owner: "v2", model: [{ status: "subject_exhausted" }] });
    expect(await runCaseInvestigation("case-1", "observe", crashed.ports)).toEqual({ status: "technical_exhausted", caseId: "case-1", caseVersion: 2, modelCalls: SAV_CASE_INVESTIGATION_MAX_CALLS });
    expect(crashed.records).toEqual([]);
    expect(crashed.progress.get("case-1:in:e1")?.waiting?.reason).toBe("technical_exhausted");
    // With a proposal already validated, that proposal is the result: no further call is attempted.
    const corrected = fake({ owner: "v2", model: [ok(askingPassword()), { status: "subject_exhausted" }, ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", corrected.ports)).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: SAV_CASE_INVESTIGATION_MAX_CALLS });
    expect(corrected.calls).toHaveLength(2);
  });
  it("never repeats a call whose usage is uncertain, and does not retry a failed one itself", async () => {
    const uncertain = fake({ owner: "v2", model: [{ status: "failed", uncertain: true }, { status: "ok", output: ask() }] });
    expect(await runCaseInvestigation("case-1", "observe", uncertain.ports)).toMatchObject({ status: "usage_uncertain", modelCalls: 1 });
    expect(uncertain.calls).toHaveLength(1);
    const failed = fake({ owner: "v2", model: [{ status: "failed", uncertain: false }, { status: "ok", output: ask() }] });
    expect(await runCaseInvestigation("case-1", "observe", failed.ports)).toMatchObject({ status: "technical_wait", modelCalls: 1 });
    expect(failed.calls).toHaveLength(1);
    expect([...uncertain.records, ...failed.records]).toEqual([]);
  });
});

describe("SAV-7 observed decision", () => {
  it("actions_paused: analyses and records, marking the decision, whether the runner or pole A's claim saw the pause", async () => {
    for (const [level, claimActionsPaused] of [["actions_paused", false], ["running", true]] as const) {
      const run = fake({ owner: "v2", level, claimActionsPaused });
      expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", modelCalls: 1, actionsPaused: true });
      expect(run.records[0]).toMatchObject({ actionsPaused: true, mode: "observe" });
    }
    // An unknown level is read as a full pause: fail closed, no claim.
    const odd = fake({ owner: "v2" });
    odd.ports.pauseState = async () => "paused" as never;
    expect(await runCaseInvestigation("case-1", "observe", odd.ports)).toEqual({ status: "paused", caseId: "case-1", modelCalls: 0 });
    expect(odd.log).not.toContain("claim");
  });
  it("records an accepted decision with its exact revisions and knowledge, and nothing else", async () => {
    const run = fake({ owner: "v2" });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toEqual({ status: "recorded", caseId: "case-1", caseVersion: 2, outcome: "accepted", refusal: null, closure: null, modelCalls: 1, actionsPaused: false, callSignal: null });
    expect(run.records).toHaveLength(1);
    expect(run.records[0]).toMatchObject({ caseId: "case-1", caseVersion: 2, leaseToken: "lease-1", mode: "observe", modelCalls: 1,
      revisions: { rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" },
      knowledge: [{ knowledgeId: "k1", contentVersionId: "k1-v1" }], validation: { outcome: "accepted" } });
    expect(run.log).toEqual(["pause", "read", "admission", "owner", "claim", "owner", "progress", "knowledge", "pause", "owner", "model", "read", "owner", "record", "release"]);
  });
  it("gives a rejected proposal bounded correction calls with exact codes and our own labels, then keeps needs_review", async () => {
    const run = fake({ owner: "v2", model: [askingPassword(), malformed(), askingPassword(), ask()].map(ok) });
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: SAV_CASE_INVESTIGATION_MAX_CALLS });
    expect(run.calls.map(call => call.call)).toEqual([1, 2, 3]);
    expect(run.calls[0].feedback).toEqual([]);
    expect(run.calls[1].feedback.map(row => row.code)).toEqual(expect.arrayContaining(["credential_requested", "credential_request_pattern"]));
    expect(run.calls[1].feedback.find(row => row.code === "credential_requested")?.label).toBe(caseDecisionRejectionLabels.credential_requested);
    // Codes and our fixed labels only: never the model's own wording.
    expect(JSON.stringify(run.calls[1].feedback)).not.toContain("Pouvez-vous");
  });
  it("stops after the same refusal twice in a row, and a resumed run does not pay the third call either", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    const run = fake({ owner: "v2", progress, model: [askingPassword(), askingPassword(), ask()].map(ok) });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: 2 });
    expect(run.records[0].flags).toEqual({ sensitiveFoundByModel: false, learningExcluded: false, sameRefusalRepeated: true });
    const again = fake({ owner: "v2", progress, model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", again.ports)).toMatchObject({ status: "already_recorded", outcome: "needs_review", modelCalls: 2 });
    expect(again.calls).toEqual([]);
  });
  it("stops correcting as soon as a proposal is accepted", async () => {
    const run = fake({ owner: "v2", model: [{ status: "ok", output: askingPassword() }, { status: "ok", output: ask() }] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
  });
  it("drops the decision and re-queues when a new inbound moved the case during the investigation", async () => {
    const run = fake({ owner: "v2", versionAfter: 3 });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toEqual({ status: "stale_requeue", caseId: "case-1", caseVersion: 2, currentVersion: 3, modelCalls: 1 });
    expect(run.records).toEqual([]);
    expect(run.log.at(-1)).toBe("release");
  });
  it("records a decision proposed on an older version as needs_review, never as accepted", async () => {
    const run = fake({ owner: "v2", model: [1, 2, 3].map(() => ({ status: "ok" as const, output: ask(1) })) });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", outcome: "needs_review" });
    expect(run.records[0].validation).toMatchObject({ rejections: [expect.objectContaining({ code: "case_version_stale" })] });
  });
  it("refuses an inconsistent case read before any model call", async () => {
    const run = fake({ owner: "v2", snap: snapshot({}, { trials: [{ id: "t1", requestId: "r9", procedure: { knowledgeId: "k1", contentVersionId: "k1-v1" }, askedAt: "2026-10-21T09:00:00Z", outcome: "pending", resultAt: null }] }) });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "context_invalid", problem: "body_invalid", modelCalls: 0 });
    expect(run.log).toContain("release");
    // Night 31/10: never a silent return. The case waits for a person, with the reason, and no call was made.
    expect(run.calls).toEqual([]);
    const stored = run.progress.get("case-1:in:e1")!;
    // Only the closed reason code is kept: the raw schema message never reaches the stored wait nor the list.
    expect(stored.waiting).toEqual({ reason: "context_invalid", since: expect.any(String), caseVersion: 2, problem: "body_invalid" });
    expect(listCaseInvestigationWaits([{ caseId: "case-1", inputKey: "in:e1", progress: stored }], new Date("2026-10-27T12:30:00Z")))
      .toMatchObject([{ reason: "context_invalid", needsPerson: true, problem: "body_invalid", embeddingCalls: null, modelCalls: 0 }]);
  });
  it("a context that cannot be built after a paid knowledge search: no generation call, the embedding calls kept and shown, never « no call »", async () => {
    const run = fake({ owner: "v2", snap: snapshot({}, { trials: [{ id: "t1", requestId: "r9", procedure: { knowledgeId: "k1", contentVersionId: "k1-v1" }, askedAt: "2026-10-21T09:00:00Z", outcome: "pending", resultAt: null }] }) });
    run.ports.knowledge = async () => ({ status: "ready", selection: { revision: "kb-r1", cards: knowledge, coverage: [], alerts: [] }, embeddingCalls: 1 });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "context_invalid", modelCalls: 0, embeddingCalls: 1 });
    expect(run.calls).toEqual([]);
    const stored = run.progress.get("case-1:in:e1")!;
    expect(stored.waiting).toMatchObject({ reason: "context_invalid", problem: "body_invalid", embeddingCalls: 1 });
    const [item] = listCaseInvestigationWaits([{ caseId: "case-1", inputKey: "in:e1", progress: stored }], new Date("2026-10-27T12:30:00Z"));
    expect(item).toMatchObject({ embeddingCalls: 1, modelCalls: 0 });
    expect(item!.label).toMatch(/aucun appel de génération/);
    expect(item!.label).not.toMatch(/aucun appel fait/);
  });
  it("a context that cannot be built after a recorded decision writes nothing over it", async () => {
    const recorded: CaseInvestigationProgress = { modelCalls: 1, attempts: [], waiting: null, proposal: null, last: null, closure: null, recordedOn: 2 };
    const run = fake({ owner: "v2", progress: new Map([["case-1:in:e1", recorded]]),
      snap: snapshot({}, { trials: [{ id: "t1", requestId: "r9", procedure: { knowledgeId: "k1", contentVersionId: "k1-v1" }, askedAt: "2026-10-21T09:00:00Z", outcome: "pending", resultAt: null }] }) });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "context_invalid" });
    expect(run.progress.get("case-1:in:e1")).toEqual(recorded);
  });
});

describe("night 31/10: the budgeted knowledge search stops the run before any paid call (K-COST1)", () => {
  it("an uncertain call is verify-only: the progress is read first and no search (no embedding) is made", async () => {
    const uncertain: CaseInvestigationProgress = { modelCalls: 1, attempts: [], waiting: { reason: "usage_uncertain", since: "2026-10-27T11:00:00Z", caseVersion: 2 }, proposal: null, last: null, closure: null, recordedOn: null };
    const run = fake({ owner: "v2", progress: new Map([["case-1:in:e1", uncertain]]) });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "usage_uncertain", modelCalls: 1 });
    expect(run.log).not.toContain("knowledge");
    expect(run.calls).toEqual([]);
  });
  it("hands the input key to the knowledge port, so the search is paid under this input", async () => {
    const run = fake({ owner: "v2" });
    const seen: unknown[] = [];
    run.ports.knowledge = async (_snapshot, context) => { seen.push(context); return knowledge; };
    await runCaseInvestigation("case-1", "observe", run.ports);
    expect(seen).toEqual([{ inputKey: "in:e1" }]);
  });
  it.each([
    [{ reason: "knowledge_paused" }, { status: "paused", modelCalls: 0 }, "paused"],
    [{ reason: "knowledge_budget_deferred", detail: "refused_by_root" }, { status: "deferred_budget", modelCalls: 0 }, "deferred_budget"],
    [{ reason: "knowledge_usage_uncertain" }, { status: "usage_uncertain", modelCalls: 0 }, "usage_uncertain"],
    [{ reason: "knowledge_calls_exhausted" }, { status: "technical_exhausted", modelCalls: 0 }, "technical_exhausted"],
    [{ reason: "knowledge_owner_stop", owner: { reason: "ticket_owner_human", detail: "human" } }, { status: "ticket_owner_stop", reason: "ticket_owner_human", detail: "human", modelCalls: 0 }, null],
    [{ reason: "knowledge_stale", currentVersion: 3 }, { status: "stale_requeue", currentVersion: 3, modelCalls: 0 }, null],
    [{ reason: "knowledge_busy" }, { status: "technical_wait", modelCalls: 0 }, "technical_wait"],
    [{ reason: "knowledge_request_invalid", problem: "query_count_invalid" }, { status: "knowledge_request_invalid", problem: "query_count_invalid", modelCalls: 0 }, "knowledge_request_invalid"],
  ] as const)("a search stopped by %o: %o, no model call, the wait kept only when the case waits", async (stop, report, waiting) => {
    const run = fake({ owner: "v2" });
    run.ports.knowledge = async () => ({ status: "stopped", stop });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject(report);
    expect(run.calls).toEqual([]);
    expect(run.records).toEqual([]);
    expect(run.log.at(-1)).toBe("release");
    if (waiting) expect(run.progress.get("case-1:in:e1")).toMatchObject({ waiting: { reason: waiting, caseVersion: 2 }, recordedOn: null });
    else expect(run.progress.size).toBe(0);
  });
});

describe("SAV-7 boundaries", () => {
  it("has no effect port, no network and no live switch", async () => {
    const fetch = vi.fn(() => { throw new Error("network"); });
    vi.stubGlobal("fetch", fetch);
    const run = fake({ owner: "v2" });
    await runCaseInvestigation("case-1", "observe", run.ports);
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.keys(run.ports).sort()).toEqual(["admissionPolicyRevision", "callModel", "claim", "customerTexts", "knowledge", "now", "pauseState", "progress", "readCase", "readTicketOwner", "record", "reevaluateAdmission", "release", "revisions", "scope"]);
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const source = ["investigation-runner.ts", "investigation-gate.ts", "decision-recovery.ts", "investigation-waits.ts"].map(file => readFileSync(path.join(dir, file), "utf8")).join("\n");
    expect(source).not.toMatch(/process\.env|SAV_CASE_INVESTIGATION\b|from "(?:@\/|\.\.\/intake|\.\.\/gmail|\.\.\/hubspot|\.\.\/\.\.\/db)/);
  });
});

// Acceptance scenarios of the V2 product feedback (27/10): fake ports, real context builder and validator.
const k1 = { knowledgeId: "k1", contentVersionId: "k1-v1" };
const trial = (outcome: "pending" | "failed" = "pending") => ({ id: "t1", requestId: "r1", procedure: k1, askedAt: "2026-10-21T09:00:00Z", outcome, resultAt: outcome === "failed" ? "2026-10-21T10:00:00Z" : null });
const agentReply: CaseEvent = { ...inbound, id: "e2", kind: "outbound_observed", dedupeKey: "outbound:a1", caseVersion: 2, direction: "agent_outbound", occurredAt: "2026-10-21T09:00:00Z", sourceRef: { type: "email", id: "a1" } };
const humanTransfer: CaseEvent = { ...inbound, id: "e3", kind: "outbound_observed", dedupeKey: "outbound:h1", caseVersion: 2, direction: "human_outbound", occurredAt: "2026-10-21T11:00:00Z", sourceRef: { type: "email", id: "h1" } };
const thanks: CaseEvent = { ...inbound, id: "e4", dedupeKey: "inbound:m2", caseVersion: 3, occurredAt: "2026-10-21T12:00:00Z", sourceRef: { type: "email", id: "m2" } };
const understood = (family = "usage") => ({ requests: [{ id: "r1", summary: "Demande.", family, status: "open" }], newFacts: [] });
const confirm = (version = 3) => ({ caseVersion: version, understanding: understood(), nextAction: { kind: "confirm_resolution", requestIds: ["r1"], evidence: [{ requestId: "r1", source: { type: "email", id: "m2" }, trialId: "t1", quote: "ça remarche" }] } });
const observe = (version = 3) => ({ caseVersion: version, understanding: understood(), nextAction: { kind: "observe_only" } });
const answerWithK1 = () => ({ ...ask(), nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Refaire l'étape synthétique.", knowledge: k1 }], expectedResult: "Cela fonctionne." } });
const ok = (output: unknown): CaseInvestigationModelResult => ({ status: "ok", output });
const verdict = (value: string) => ({ verdicts: [{ requestId: "r1", verdict: value }] });
const malformed3 = () => ({ ...malformed(), caseVersion: 3 });
const askingPassword3 = () => ({ ...askingPassword(), caseVersion: 3 });

describe("V2 acceptance: thanks for a resolution vs thanks for a transfer", () => {
  it("plans a soft closure when the customer says it works after our step and the second reading agrees", async () => {
    const run = fake({ owner: "v2", snap: snapshot({ version: 3 }, { trials: [trial()] }), events: [inbound, agentReply, thanks], model: [ok(confirm()), ok(verdict("resolved"))] });
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", refusal: null, closure: "soft_close", modelCalls: 2 });
    expect(run.records[0].validation).toMatchObject({ outcome: "accepted", decision: { nextAction: { kind: "confirm_resolution" } } });
    expect(run.calls[1]).toMatchObject({ purpose: "resolution_check", call: 2, subjectKey: "sav-case:case-1:in:e4", callKey: "sav-case:case-1:in:e4:call2",
      closure: [{ requestId: "r1", evidence: { source: { type: "email", id: "m2" }, quote: "ça remarche", trialId: "t1" } }] });
    expect(run.records[0].closure).toEqual({ plan: "soft_close", verdicts: [{ requestId: "r1", verdict: "resolved" }], reason: "checked" });
  });
  it.each([
    ["thanks_for_transfer", "no_close_transfer_thanks"], ["not_resolved", "no_close_not_resolved"], ["unclear", "ask_confirmation"],
  ] as const)("does not close when the second reading says %s", async (answer, plan) => {
    const run = fake({ owner: "v2", snap: snapshot({ version: 3 }, { trials: [trial()] }), events: [inbound, agentReply, thanks], model: [ok(confirm()), ok(verdict(answer))] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", outcome: "accepted", closure: plan });
  });
  it("asks for confirmation instead of closing when the second reading is unreadable or no call is left", async () => {
    const unreadable = fake({ owner: "v2", snap: snapshot({ version: 3 }, { trials: [trial()] }), events: [inbound, agentReply, thanks], model: [ok(confirm()), ok({ verdict: "yes" })] });
    await runCaseInvestigation("case-1", "observe", unreadable.ports);
    expect(unreadable.records[0].closure).toEqual({ plan: "ask_confirmation", verdicts: [], reason: "check_unreadable" });
    const late = fake({ owner: "v2", snap: snapshot({ version: 3 }, { trials: [trial()] }), events: [inbound, agentReply, thanks], model: [ok(malformed3()), ok(askingPassword3()), ok(confirm()), ok(verdict("resolved"))] });
    expect(await runCaseInvestigation("case-1", "observe", late.ports)).toMatchObject({ outcome: "accepted", closure: "ask_confirmation", modelCalls: 3 });
    expect(late.calls.every(call => call.purpose === "decision")).toBe(true);
  });
  it("refuses a closure whose quoted words are not in the customer's message, then lets the model correct it", async () => {
    const wrongQuote = () => ({ ...confirm(), nextAction: { ...confirm().nextAction, evidence: [{ requestId: "r1", source: { type: "email", id: "m2" }, trialId: "t1", quote: "tout est réglé" }] } });
    const run = fake({ owner: "v2", snap: snapshot({ version: 3 }, { trials: [trial()] }), events: [inbound, agentReply, thanks], model: [ok(wrongQuote()), ok(confirm()), ok(verdict("resolved"))] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", outcome: "accepted", closure: "soft_close", modelCalls: 3 });
    expect(run.calls[1].feedback).toEqual([expect.objectContaining({ code: "resolution_quote_not_found", kind: "forbidden_action" })]);
  });
  it("treats an unreadable message text as a technical wait, then re-checks the stored proposal without a new decision call", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    const setup = { snap: snapshot({ version: 3 }, { trials: [trial()] }), events: [inbound, agentReply, thanks], progress };
    const first = fake({ owner: "v2", ...setup, texts: {}, model: [ok(confirm())] });
    expect(await runCaseInvestigation("case-1", "observe", first.ports)).toEqual({ status: "technical_wait", caseId: "case-1", caseVersion: 3, modelCalls: 1 });
    expect(first.records).toEqual([]);
    expect(progress.get("case-1:in:e4")?.waiting?.reason).toBe("technical_wait");
    const second = fake({ owner: "v2", ...setup, model: [ok(verdict("resolved"))] });
    expect(await runCaseInvestigation("case-1", "observe", second.ports)).toMatchObject({ status: "recorded", outcome: "accepted", closure: "soft_close", modelCalls: 2 });
    expect(second.calls.map(call => call.purpose)).toEqual(["resolution_check"]);
  });
  it("refuses a closure when a human replied in between, then accepts the corrected action, and keeps the recovered refusal", async () => {
    // Each event has its own arrival number in the store: the human reply is 3rd, the thanks 4th.
    const run = fake({ owner: "v2", snap: snapshot({ version: 4 }, { trials: [trial()] }), events: [inbound, agentReply, { ...humanTransfer, caseVersion: 3 }, { ...thanks, caseVersion: 4 }],
      model: [ok(confirm(4)), ok(observe(4))] });
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
    expect(run.calls[1].feedback).toEqual([expect.objectContaining({ code: "resolution_evidence_invalid", detail: "human_intervened_after_trial", kind: "forbidden_action" })]);
    expect(run.records[0].attempts).toEqual([
      { call: 1, result: "validated", outcome: "needs_review", kinds: ["forbidden_action"], codes: ["resolution_evidence_invalid"] },
      { call: 2, result: "validated", outcome: "accepted", kinds: [], codes: [] },
    ]);
  });
});

describe("V2 acceptance: refusals stay distinct and useful", () => {
  it("repairs a format error with one bounded correction", async () => {
    const run = fake({ owner: "v2", model: [ok({ ...ask(), nextAction: { kind: "ask" } }), ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
    expect(run.calls[1].feedback.every(row => row.kind === "repairable_format" && row.code === "proposal_schema_invalid")).toBe(true);
  });
  it("keeps a security refusal intact through every correction and ends on an explicit next step", async () => {
    const run = fake({ owner: "v2", model: [askingPassword(), malformed(), askingPassword(), ask()].map(ok) });
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: 3, refusal: { kind: "forbidden_action", nextStep: "observe_and_review" } });
    expect(run.records[0].attempts.filter(row => row.result === "validated" && row.codes.includes("credential_requested"))).toHaveLength(2);
  });
  it("names missing information (a failed procedure proposed again) as such, not as a format or technical error", async () => {
    const run = fake({ owner: "v2", snap: snapshot({}, { trials: [trial("failed")] }), events: [inbound, agentReply], model: [1, 2, 3].map(() => ok(answerWithK1())) });
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toMatchObject({ status: "recorded", outcome: "needs_review", refusal: { kind: "missing_information", nextStep: "ask_wait_or_handoff", codes: ["repeated_failed_procedure"] } });
  });
  it("reports a provider failure as a technical wait: nothing recorded, no team need invented", async () => {
    const run = fake({ owner: "v2", model: [{ status: "failed", uncertain: false }] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toEqual({ status: "technical_wait", caseId: "case-1", caseVersion: 2, modelCalls: 1 });
    expect(run.records).toEqual([]);
    expect(run.progress.get("case-1:in:e1")).toMatchObject({ modelCalls: 1, waiting: { reason: "technical_wait", since: "2026-10-27T12:00:00.000Z", caseVersion: 2 }, attempts: [{ call: 1, result: "failed", uncertain: false }] });
  });
  it("stops at once, without a correction call, when the model itself finds a finance request", async () => {
    const run = fake({ owner: "v2", model: [ok({ ...ask(), understanding: understood("finance") }), ok(ask())] });
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: 1, refusal: { kind: "forbidden_case", nextStep: "team" } });
    expect(run.calls).toHaveLength(1);
    // Point 7 (Ugo, 27/10): counted as an intake classification miss and excluded from any learning; listed for the team.
    expect(run.records[0].flags).toEqual({ sensitiveFoundByModel: true, learningExcluded: true, sameRefusalRepeated: false });
    expect(run.progress.get("case-1:in:e1")?.waiting?.reason).toBe("decision_refused");
  });
  it("makes zero calls and reads no progress for finance or a human-owned case", async () => {
    for (const snap of [snapshot({ sensitivity: "finance", owner: "human", phase: "handoff_pending" }, { openRequests: [{ ...usage, family: "finance" }] }), snapshot({ owner: "human", phase: "human_owned" })]) {
      const run = fake({ owner: "v2", snap });
      expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "skipped", modelCalls: 0 });
      expect(run.log).not.toContain("progress");
      expect(run.calls).toEqual([]);
    }
  });
});

describe("V2 acceptance: resumption never replays a call or a reservation", () => {
  it("resumes after a technical wait with the remaining calls only, the kept feedback and new reservation keys", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    const first = fake({ owner: "v2", progress, model: [ok(askingPassword()), { status: "failed", uncertain: false }] });
    expect(await runCaseInvestigation("case-1", "observe", first.ports)).toMatchObject({ status: "technical_wait", modelCalls: 2 });
    const second = fake({ owner: "v2", progress, model: [ok(ask()), ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", second.ports)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 3 });
    expect(second.calls.map(call => [call.call, call.callKey])).toEqual([[3, "sav-case:case-1:in:e1:call3"]]);
    expect(second.calls[0].feedback.map(row => row.code)).toContain("credential_requested");
    expect([...first.calls, ...second.calls].map(call => call.callKey)).toEqual(["sav-case:case-1:in:e1:call1", "sav-case:case-1:in:e1:call2", "sav-case:case-1:in:e1:call3"]);
    expect(new Set([...first.calls, ...second.calls].map(call => call.subjectKey))).toEqual(new Set(["sav-case:case-1:in:e1"]));
  });
  it("makes no call at all while a previous call is uncertain (verify only, no reset)", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    const first = fake({ owner: "v2", progress, model: [{ status: "failed", uncertain: true }] });
    expect(await runCaseInvestigation("case-1", "observe", first.ports)).toMatchObject({ status: "usage_uncertain", modelCalls: 1 });
    const second = fake({ owner: "v2", progress, model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", second.ports)).toEqual({ status: "usage_uncertain", caseId: "case-1", caseVersion: 2, modelCalls: 1 });
    expect(second.calls).toEqual([]);
    expect(second.log.at(-1)).toBe("release");
  });
  it("does not call again once the calls of this input are spent, and re-checks a stored acceptance without a call", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    const spent = fake({ owner: "v2", progress, model: [ok(askingPassword()), ok(malformed()), { status: "failed", uncertain: false }] });
    expect(await runCaseInvestigation("case-1", "observe", spent.ports)).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: 3 });
    const after = fake({ owner: "v2", progress, model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", after.ports)).toEqual({ status: "already_recorded", caseId: "case-1", caseVersion: 2, recordedOn: 2, outcome: "needs_review", modelCalls: 3 });
    expect(after.records).toEqual([]);
    expect(after.calls).toEqual([]);
    const accepted = new Map<string, CaseInvestigationProgress>();
    await runCaseInvestigation("case-1", "observe", fake({ owner: "v2", progress: accepted }).ports);
    const again = fake({ owner: "v2", progress: accepted });
    expect(await runCaseInvestigation("case-1", "observe", again.ports)).toMatchObject({ status: "already_recorded", outcome: "accepted", modelCalls: 1 });
    expect(again.calls).toEqual([]);
  });
  it("re-checks a recorded acceptance on today's read without a call (Ugo, 27/10), and reports it no longer holds", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    await runCaseInvestigation("case-1", "observe", fake({ owner: "v2", progress, model: [ok(answerWithK1())] }).ports);
    expect(progress.get("case-1:in:e1")?.last?.outcome).toBe("accepted");
    // Same input, but the read now shows that procedure failed: the acceptance is no longer valid, yet no call is paid
    // without a new customer message, and nothing is recorded as is. The executor re-checks again before any effect.
    const again = fake({ owner: "v2", progress, snap: snapshot({}, { trials: [trial("failed")] }), events: [inbound, agentReply], model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", again.ports)).toMatchObject({ status: "already_recorded", outcome: "needs_review", modelCalls: 1 });
    expect(again.calls).toEqual([]);
    expect(again.records).toEqual([]);
  });
  it("gives a new customer message its own calls: the previous input's progress is neither reused nor reset", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    const during = fake({ owner: "v2", progress, versionAfter: 3 });
    expect(await runCaseInvestigation("case-1", "observe", during.ports)).toMatchObject({ status: "stale_requeue", currentVersion: 3, modelCalls: 1 });
    const next = fake({ owner: "v2", progress, snap: snapshot({ version: 3 }), events: [inbound, thanks], model: [ok(observe())] });
    expect(await runCaseInvestigation("case-1", "observe", next.ports)).toMatchObject({ status: "recorded", caseVersion: 3, modelCalls: 1 });
    expect(next.calls[0]).toMatchObject({ call: 1, inputKey: "in:e4", subjectKey: "sav-case:case-1:in:e4", callKey: "sav-case:case-1:in:e4:call1", feedback: [] });
    expect(progress.get("case-1:in:e1")).toMatchObject({ modelCalls: 1 });
  });
});

describe("Ugo 27/10: pause before every call, budget per customer message, no silent wait", () => {
  const crmNote: CaseEvent = { ...inbound, id: "e5", kind: "crm_observed", dedupeKey: "crm:ticket-1:n1", caseVersion: 3, direction: "internal", occurredAt: "2026-10-21T13:00:00Z", sourceRef: { type: "hubspot_note", id: "n1" } };
  it("stops before the next call when the pause is set during an investigation, then resumes without losing a call", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    const first = fake({ owner: "v2", progress, pauseFrom: 3, model: [ok(askingPassword()), ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", first.ports)).toEqual({ status: "paused", caseId: "case-1", modelCalls: 1 });
    expect(first.calls).toHaveLength(1);
    expect(first.records).toEqual([]);
    expect(first.log.at(-1)).toBe("release");
    expect(progress.get("case-1:in:e1")).toMatchObject({ modelCalls: 1, waiting: { reason: "paused" } });
    const second = fake({ owner: "v2", progress, model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", second.ports)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
    expect(second.calls.map(call => call.call)).toEqual([2]);
  });
  it("does not reopen a budget for a HubSpot change: a new version without a customer message makes no call", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    await runCaseInvestigation("case-1", "observe", fake({ owner: "v2", progress }).ports);
    const afterNote = fake({ owner: "v2", progress, snap: snapshot({ version: 3 }), events: [inbound, crmNote], model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", afterNote.ports)).toMatchObject({ status: "already_recorded", caseVersion: 3, recordedOn: 2, outcome: "accepted", modelCalls: 1 });
    expect(afterNote.calls).toEqual([]);
    expect(afterNote.records).toEqual([]);
  });
  it("cannot buy extra calls with internal events once the calls of a message are spent", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    await runCaseInvestigation("case-1", "observe", fake({ owner: "v2", progress, model: [askingPassword(), malformed(), askingPassword()].map(ok) }).ports);
    const afterNote = fake({ owner: "v2", progress, snap: snapshot({ version: 3 }), events: [inbound, crmNote], model: [ok(ask())] });
    expect(await runCaseInvestigation("case-1", "observe", afterNote.ports)).toMatchObject({ status: "already_recorded", outcome: "needs_review", modelCalls: 3 });
    expect(afterNote.calls).toEqual([]);
  });
  it("keys the budget on the latest customer message only, and skips a case without one before any claim", async () => {
    expect(latestInvestigationInput([inbound, agentReply, crmNote])).toBe("in:e1");
    expect(latestInvestigationInput([crmNote, thanks, inbound])).toBe("in:e4");
    const run = fake({ owner: "v2", events: [agentReply] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "skipped", reason: "no_customer_input", modelCalls: 0 });
    expect(run.log).not.toContain("claim");
  });
  it("marks a case whose allowed calls all failed as needing a person, keeps the first wait time, and never calls again", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    const down = (minute: number) => ({ ...fake({ owner: "v2", progress, model: [{ status: "failed", uncertain: false }] }).ports, now: () => new Date(`2026-10-27T12:${String(minute).padStart(2, "0")}:00Z`) });
    const statuses = [];
    for (const minute of [0, 10, 20, 30]) statuses.push((await runCaseInvestigation("case-1", "observe", down(minute))).status);
    expect(statuses).toEqual(["technical_wait", "technical_wait", "technical_exhausted", "technical_exhausted"]);
    expect(progress.get("case-1:in:e1")).toMatchObject({ modelCalls: 3, waiting: { reason: "technical_exhausted", since: "2026-10-27T12:00:00.000Z" } });
    const waits = listCaseInvestigationWaits([
      { caseId: "case-1", inputKey: "in:e1", progress: progress.get("case-1:in:e1")! },
      { caseId: "case-2", inputKey: "in:x", progress: { modelCalls: 0, attempts: [], proposal: null, last: null, closure: null, recordedOn: null, waiting: { reason: "deferred_budget", since: "2026-10-27T08:00:00Z", caseVersion: 4 } } },
      { caseId: "case-3", inputKey: "in:y", progress: { modelCalls: 1, attempts: [], proposal: null, last: null, closure: null, recordedOn: null, waiting: null } },
    ], new Date("2026-10-27T13:00:00Z"));
    expect(waits.map(row => [row.caseId, row.reason, row.waitingMinutes, row.needsPerson])).toEqual([
      ["case-1", "technical_exhausted", 60, true], ["case-2", "deferred_budget", 300, false],
    ]);
    expect(waits.every(row => row.label.length > 20 && row.unblock.length > 20)).toBe(true);
  });
  it("shows every wait reason, including an unreadable date as the oldest", () => {
    const row = (reason: CaseInvestigationProgress["waiting"] extends infer W ? W extends { reason: infer R } ? R : never : never, since = "2026-10-27T12:00:00Z") =>
      ({ caseId: `c-${reason}`, inputKey: "in:z", progress: { modelCalls: 0, attempts: [], proposal: null, last: null, closure: null, recordedOn: null, waiting: { reason, since, caseVersion: 1 } } });
    const waits = listCaseInvestigationWaits([row("paused"), row("usage_uncertain"), row("technical_wait", "not-a-date"), row("deferred_budget"), row("case_budget")], new Date("2026-10-27T12:30:00Z"));
    expect(waits).toHaveLength(5);
    expect(waits[0]).toMatchObject({ reason: "technical_wait", waitingMinutes: Number.MAX_SAFE_INTEGER });
  });
});

describe("P1 (Ugo 28/10, option c): the per-case call signal flags, never blocks", () => {
  const earlier = (inputKey: string, modelCalls: number, caseVersion: number): CaseEvent => ({ ...inbound, id: `o${caseVersion}`, kind: "observation_recorded", dedupeKey: `obs:${caseVersion}`,
    caseVersion, direction: "internal", sourceRef: { type: "studio_command", id: `obs-${caseVersion}` }, createdAt: "2026-10-27T10:00:00Z",
    detail: { record: { kind: SAV_CASE_INVESTIGATION_RECORD_KIND, inputKey, progress: { modelCalls } } } });
  it("a case far above the threshold is still called and recorded, flagged over; the stored decision carries the signal", async () => {
    const run = fake({ owner: "v2", events: [inbound, earlier("in:old1", 3, 2), earlier("in:old2", 3, 3)], snap: snapshot({ version: 3 }), model: [ok(ask(3))] });
    run.ports.callSignal = { windowHours: 24, threshold: 2 };
    const report = await runCaseInvestigation("case-1", "observe", run.ports);
    expect(report).toMatchObject({ status: "recorded", modelCalls: 1, callSignal: { windowHours: 24, calls: 7, threshold: 2, over: true } });
    expect(run.calls).toHaveLength(1);
    expect(run.records[0]!.callSignal).toEqual({ windowHours: 24, calls: 7, threshold: 2, over: true });
  });
  it("with no threshold it only measures; unconfigured it is absent", async () => {
    const measured = fake({ owner: "v2" });
    measured.ports.callSignal = { windowHours: 24, threshold: null };
    expect(await runCaseInvestigation("case-1", "observe", measured.ports)).toMatchObject({ status: "recorded", callSignal: { calls: 1, threshold: null, over: null } });
    expect(await runCaseInvestigation("case-1", "observe", fake({ owner: "v2" }).ports)).toMatchObject({ status: "recorded", callSignal: null });
  });
});

describe("Ugo 27/10 (second round): budget on hand-back, refused decisions listed, partial closures read twice", () => {
  const handBack: CaseEvent = { ...inbound, id: "o2", kind: "owner_changed", dedupeKey: "cmd:hand-back-1", caseVersion: 3, direction: "internal", occurredAt: "2026-10-21T14:00:00Z", sourceRef: { type: "studio_command", id: "c1" } };
  it("gives the agent a new budget when a human gives the case back, not for a CRM note", () => {
    expect(latestInvestigationInput([inbound, handBack])).toBe("back:o2");
    expect(latestInvestigationInput([handBack, { ...thanks, caseVersion: 4 }])).toBe("in:e4");
    expect(latestInvestigationInput([handBack])).toBeNull();
  });
  it("Q9: a technical or organisational hold and its release are not a new input; a retired admin_hold release still is", () => {
    const owner = (id: string, caseVersion: number, detail: Record<string, unknown>): CaseEvent => ({ ...handBack, id, caseVersion, dedupeKey: `cmd:${id}`, detail });
    for (const kept of ["technical_hold", "organisational_hold"]) {
      const held = owner("h1", 3, { transition: kept, from: "agent", to: "system_hold" }), released = owner("h2", 4, { transition: "hold_release", from: "system_hold", to: "agent" });
      expect(latestInvestigationInput([inbound, held, released])).toBe("in:e1");
    }
    // A person who takes the case during the hold and gives it back is a new input, as any hand-back.
    expect(latestInvestigationInput([inbound, owner("h1", 3, { transition: "technical_hold", to: "system_hold" }), owner("h2", 4, { transition: "hold_release", to: "human" }), owner("h3", 5, { transition: "hand_back", to: "agent" })])).toBe("back:h3");
    // admin_hold cancelled the J2 (older journals): its release restarts a round, as before.
    expect(latestInvestigationInput([inbound, owner("h1", 3, { transition: "admin_hold", to: "system_hold" }), owner("h2", 4, { transition: "hold_release", to: "agent" })])).toBe("back:h2");
  });
  it("runs 3 new calls after a hand-back even when the previous message's calls were spent", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    await runCaseInvestigation("case-1", "observe", fake({ owner: "v2", progress, model: [askingPassword(), malformed(), askingPassword()].map(ok) }).ports);
    const back = fake({ owner: "v2", progress, snap: snapshot({ version: 3 }), events: [inbound, handBack], model: [ok(ask(3))] });
    expect(await runCaseInvestigation("case-1", "observe", back.ports)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(back.calls[0]).toMatchObject({ inputKey: "back:o2", call: 1, subjectKey: "sav-case:case-1:back:o2", callKey: "sav-case:case-1:back:o2:call1" });
  });
  it("lists a refused decision for the team with the next step of its refusal, but not a technical refusal", async () => {
    const progress = new Map<string, CaseInvestigationProgress>();
    await runCaseInvestigation("case-1", "observe", fake({ owner: "v2", progress, model: [askingPassword(), askingPassword()].map(ok) }).ports);
    const waits = listCaseInvestigationWaits([{ caseId: "case-1", inputKey: "in:e1", progress: progress.get("case-1:in:e1")! }], new Date("2026-10-27T12:30:00Z"));
    expect(waits).toEqual([expect.objectContaining({ reason: "decision_refused", needsPerson: true, waitingMinutes: 30, refusalNextStep: caseDecisionNextStepLabels.observe_and_review })]);
    const technical = new Map<string, CaseInvestigationProgress>();
    const setup = { snap: snapshot({ version: 3 }, { trials: [trial()] }), events: [inbound, agentReply, thanks], progress: technical };
    await runCaseInvestigation("case-1", "observe", fake({ owner: "v2", ...setup, texts: {}, model: [ok(confirm())] }).ports);
    expect(listCaseInvestigationWaits([{ caseId: "case-1", inputKey: "in:e4", progress: technical.get("case-1:in:e4")! }], new Date("2026-10-27T12:30:00Z")))
      .toEqual([expect.objectContaining({ reason: "technical_wait", needsPerson: false, refusalNextStep: null })]);
  });
  it("reads a request marked resolved along the way a second time too", async () => {
    const twoRequests = snapshot({ version: 3 }, { openRequests: [usage, { ...usage, id: "r2" }], trials: [trial()] });
    const partial = { caseVersion: 3, understanding: { requests: [
      { id: "r1", summary: "Demande.", family: "usage", status: "resolved", resolvedBy: { source: { type: "email", id: "m2" }, trialId: "t1", quote: "ça remarche" } },
      { id: "r2", summary: "Autre demande.", family: "usage", status: "open" }], newFacts: [] },
      nextAction: { kind: "ask", questions: [{ text: "Quel résultat obtenez-vous pour la seconde demande ?", requestId: "r2", reducesUncertainty: "Savoir où cela échoue.", seeks: [{ kind: "observed_result" }] }] } };
    const run = fake({ owner: "v2", snap: twoRequests, events: [inbound, agentReply, thanks], model: [ok(partial), ok(verdict("thanks_for_transfer"))] });
    expect(await runCaseInvestigation("case-1", "observe", run.ports)).toMatchObject({ status: "recorded", outcome: "accepted", closure: "no_close_transfer_thanks", modelCalls: 2 });
    expect(run.calls[1].closure.map(item => item.requestId)).toEqual(["r1"]);
  });
});

describe("login history at the investigation model boundary", () => {
  const nextMail: CaseEvent = { ...inbound, id: "e2", caseVersion: 2, dedupeKey: "inbound:m2",
    sourceRef: { type: "email", id: "m2" }, occurredAt: "2026-10-21T09:00:00Z" };
  async function history(previous: string, latest: string) {
    const run = fake({ owner: "v2", snap: snapshot({ version: 3, admission: agentAdmission(2) }, { openRequests: [{ ...usage, family: "access" }] }),
      events: [inbound, nextMail], texts: { "email:m1": previous, "email:m2": latest } });
    await runCaseInvestigation("case-1", "observe", run.ports);
    expect(run.calls.length).toBeGreaterThan(0);
    return run.calls[0]!.customerReportedLogin;
  }
  it("exposes the current customer's bounded positive statement and source at the model boundary", async () => {
    const quote = "Merci, nous pouvons à nouveau utiliser Limova.";
    const result = await history("Je ne peux pas me connecter.", quote + "\nBien à vous\nEnvoyé depuis Outlook pour iOS<https://aka.ms/example>");
    expect(result).toEqual({ restoredAccessReported: { source: { type: "email", id: "m2" }, quote } });
    expect(await history("J’ai déjà vérifié le bon lien et la bonne adresse.", "Merci, mais ça ne fonctionne toujours pas.")).toMatchObject({
      correctLinkReported: true, ownAddressReported: true,
      stillBlockedReported: { source: { type: "email", id: "m2" } },
    });
  });
  it("carries the customer's prior checks across a reminder without sending their words or codes", async () => {
    const stated = "J’ai déjà essayé le bon lien et la bonne adresse. Je ne reçois aucun code. Mon code secret est 123456.";
    expect(await history(stated, "Toujours rien.")).toEqual({ correctLinkReported: true, ownAddressReported: true,
      missingCodeReported: true, spamCheckedReported: false, screenReport: null, latestIsReminder: true });
    expect(await history("Impossible de me connecter.", "Toujours rien.")).toMatchObject({ correctLinkReported: false, ownAddressReported: false });
    expect(await history(stated, "")).toBeNull();
    expect(await history(stated, "Comment connecter Gmail ?")).toBeNull();
  });
});
