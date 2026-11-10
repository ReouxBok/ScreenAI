import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
import {
  caseEventIsAdmissionInput, emptyCaseBody, SAV_CASE_ADMISSION_REVISION, SAV_CASE_CONTRACT_REVISION,
  type CaseAdmissionRecord, type CaseBody, type CaseCrmChange, type CaseEvent, type CaseEventDirection, type CaseEventKind, type CaseOwner, type CaseSnapshot, type SourceRef,
} from "./case-types";
import { caseInvestigationObservationRecord, readCaseInvestigationProgress, type CaseInvestigationJournalEvent } from "./investigation-record";
import {
  runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS,
  type CaseInvestigationModelRequest, type CaseInvestigationModelResult, type CaseInvestigationPorts, type CaseInvestigationProgress, type CaseInvestigationRecord,
} from "./investigation-runner";
import { listCaseInvestigationWaits } from "./investigation-waits";

/*
 * Access-request journey, local and off: mail -> admitted case -> knowledge -> targeted question -> answer ->
 * resolution, or a J2 timer. Real pole A admission rule (`caseAdmissionStatus`, `caseEventIsAdmissionInput`, contract v6),
 * real context builder, validator, closure reading and investigation record; fakes for everything else: an in-memory
 * case journal standing in for the pole A store (one observation per claim, version +1, not an admission input; a new
 * customer message stales the admission until a qualified re-evaluation, a CRM note does not), a scripted model
 * transport, no Gmail, no HubSpot, no network. Each sent reply is a human
 * sending the prepared draft (SAV-10 effects are not authorised): the agent itself never sends. Synthetic texts only.
 * This proves the flow and its rules, not the quality of a real model.
 */

const card = (id: string, title: string): SavRetrievalCandidate => Object.freeze({
  id, contentVersionId: `${id}-v1`, title, content: "Procédure synthétique.", source: "fixture", verifiedAt: "2026-10-01T00:00:00Z", semanticScore: null,
  resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
}) as SavRetrievalCandidate;
const RESET = card("k-reset", "Réinitialiser l'accès"), BROWSER = card("k-browser", "Se connecter depuis un autre navigateur");
const ref = (card: SavRetrievalCandidate) => ({ knowledgeId: card.id, contentVersionId: card.contentVersionId });

/** In-memory case journal with the pole A semantics the runner depends on. */
class FakeCaseStore {
  version = 0; owner: CaseOwner = "agent";
  events: CaseEvent[] = []; journal: CaseInvestigationJournalEvent[] = []; texts: Record<string, string> = {};
  body: CaseBody = { ...emptyCaseBody(), openRequests: [{ id: "r1", summary: "Le client ne parvient plus à se connecter.", family: "access", status: "open", openedAt: "2026-10-27T10:00:00Z" }] };
  admission: CaseAdmissionRecord | null = null; admissionInputVersion = 0;
  /** What the approved rules say of the latest input (Q10): admit it, send the case to the team, or nothing qualifies it. */
  rules: "admit" | "team" | "none" = "none";
  private at = Date.parse("2026-10-27T09:00:00Z");
  /** A message or signal recorded in the journal, one version each. */
  append(kind: CaseEventKind, direction: CaseEventDirection, sourceRef: SourceRef, text?: string, crmChange?: CaseCrmChange) {
    this.version += 1; this.at += 3_600_000;
    const event: CaseEvent = { id: `e${this.version}`, caseId: "case-1", kind, dedupeKey: `${kind === "inbound_confirmed" ? "inbound" : kind === "timer_fired" ? "timer" : "outbound"}:${sourceRef.id}`,
      caseVersion: this.version, direction, occurredAt: new Date(this.at).toISOString(), sourceRef, detail: crmChange ? { crmChange } : null, createdAt: new Date(this.at).toISOString() };
    this.events.push(event);
    if (caseEventIsAdmissionInput(kind, direction, crmChange)) this.admissionInputVersion = this.version;
    if (text !== undefined) this.texts[`${sourceRef.type}:${sourceRef.id}`] = text;
    return event;
  }
  /** `recordCaseObservation`: always kept, bumps the version, never an admission input. */
  observe(record: Record<string, unknown>) { this.version += 1; this.journal.push({ kind: "observation_recorded", caseVersion: this.version, detail: { applied: false, reason: null, record } }); }
  /** `reevaluateCaseAdmission` with a qualified rule: a positive admission covering every input so far. */
  admit() {
    this.version += 1;
    this.admission = { revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none", families: ["access"], sensitivity: "none",
      policyRevision: "policy-r1", decidedAt: new Date(this.at).toISOString(), version: this.version, inputVersion: this.admissionInputVersion,
      qualification: { requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] } };
  }
  /** `reevaluateCaseAdmission` as the Q10 adapter would call it: approved rules only, on the version read. */
  reevaluate(version: number): "reevaluated" | "handed_off" | "version_moved" {
    if (version !== this.version) return "version_moved";
    // No approved rule: the adapter hands the case to the team (`out_of_scope`), one owner change.
    if (this.rules === "none") { this.version += 1; this.owner = "human"; return "handed_off"; }
    this.admit();
    // Pole A withdraws a case the rules do not admit: the team takes it, with the reason kept on the admission.
    if (this.rules === "team") { this.admission = { ...this.admission!, target: "team", reasons: ["family_not_admitted"], nextStep: "team_takeover" }; this.owner = "human"; }
    return "reevaluated";
  }
  get now() { return new Date(this.at + 60_000); }
  snapshot(): CaseSnapshot {
    return { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "ticket-1", threadIds: ["thread-1"], version: this.version, owner: this.owner,
      phase: this.owner === "agent" ? "queued" : "human_owned", sensitivity: "none", createdAt: "2026-10-27T09:00:00Z", updatedAt: new Date(this.at).toISOString(), body: structuredClone(this.body),
      admission: structuredClone(this.admission), admissionInputVersion: this.admissionInputVersion };
  }
}

type Run = { report: Awaited<ReturnType<typeof runCaseInvestigation>>; calls: CaseInvestigationModelRequest[]; records: CaseInvestigationRecord[] };
/** One scheduled run: the ports a real adapter would give, progress and decision flushed as ONE observation when the claim ends. */
async function investigate(store: FakeCaseStore, answers: CaseInvestigationModelResult[]): Promise<Run> {
  const calls: CaseInvestigationModelRequest[] = [], records: CaseInvestigationRecord[] = [];
  let pending: { inputKey: string; progress: CaseInvestigationProgress } | null = null;
  const ports: CaseInvestigationPorts = {
    scope: { locale: "fr-FR", audience: "support" },
    // Witness: this CRM double gives the ticket the V2 owner while the store's case is the agent's, a person otherwise.
    readTicketOwner: async () => store.owner === "agent" ? "v2" : "human",
    pauseState: async () => "running",
    readCase: async () => ({ snapshot: store.snapshot(), events: structuredClone(store.events) }),
    admissionPolicyRevision: async () => "policy-r1",
    reevaluateAdmission: async snapshot => store.reevaluate(snapshot.version),
    claim: async (_caseId, version) => version === store.version && store.owner === "agent" ? { token: `claim-${version}`, actionsPaused: false } : { refused: "busy" },
    release: async () => {
      if (!pending) return;
      store.observe(caseInvestigationObservationRecord(pending.inputKey, pending.progress, records.at(-1) ?? null));
      pending = null;
    },
    knowledge: async () => [RESET, BROWSER],
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, store.texts[`${row.type}:${row.id}`]]).filter(([, text]) => text !== undefined)),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => { calls.push(structuredClone(request)); return answers.shift() ?? { status: "failed", uncertain: false }; },
    progress: {
      load: async (_caseId, inputKey) => {
        const read = readCaseInvestigationProgress(store.journal, inputKey);
        if (read.state === "unreadable") throw Error("progress unreadable");
        return read.state === "found" ? read.record.progress : null;
      },
      save: async (_caseId, inputKey, progress) => { pending = { inputKey, progress: structuredClone(progress) }; },
    },
    record: async record => { records.push(structuredClone(record)); },
    now: () => store.now,
  };
  return { report: await runCaseInvestigation("case-1", "observe", ports), calls, records };
}

const ok = (output: unknown): CaseInvestigationModelResult => ({ status: "ok", output });
const understood = () => ({ requests: [{ id: "r1", summary: "Le client ne parvient plus à se connecter.", family: "access", status: "open" }], newFacts: [] });
const reply = (text: string, citations: ReturnType<typeof ref>[] = []) => ({ text, citations, impossibilityClaims: [], accountAdvice: "none" });
const answer = (version: number, knowledge: SavRetrievalCandidate) => ({ caseVersion: version, understanding: understood(),
  nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: `Suivre la fiche « ${knowledge.title} ».`, knowledge: ref(knowledge) }], expectedResult: "La connexion fonctionne." },
  reply: reply(`Bonjour, voici la marche à suivre depuis https://new.limova.ai : ${knowledge.title}.`, [ref(knowledge)]) });
const ask = (version: number, factKey: string) => ({ caseVersion: version, understanding: understood(),
  nextAction: { kind: "ask", questions: [{ text: "Quel message s'affiche exactement quand vous validez la connexion ?", requestId: "r1", reducesUncertainty: "Savoir à quelle étape la connexion échoue.", seeks: [{ kind: "observed_result", factKey }] }] },
  reply: reply("Bonjour, pouvez-vous nous indiquer le message affiché lorsque vous vous connectez sur https://new.limova.ai ?") });
const confirm = (version: number, mail: string, trialId: string, quote: string) => ({ caseVersion: version, understanding: understood(),
  nextAction: { kind: "confirm_resolution", requestIds: ["r1"], evidence: [{ requestId: "r1", source: { type: "email", id: mail }, trialId, quote }] } });
const askingPassword = (version: number) => ({ ...ask(version, "login_error"), nextAction: { kind: "ask", questions: [{ text: "Pouvez-vous nous envoyer votre mot de passe ?", requestId: "r1", reducesUncertainty: "x", seeks: [{ kind: "credential" }] }] } });

/** A human sends the prepared draft; the store then holds the step as a pending trial (what applying the decision would do). */
function humanSendsDraft(store: FakeCaseStore, id: string, trial?: { id: string; knowledge: SavRetrievalCandidate }) {
  const sent = store.append("outbound_observed", "agent_outbound", { type: "email", id });
  if (trial) store.body.trials.push({ id: trial.id, requestId: "r1", procedure: ref(trial.knowledge), askedAt: sent.occurredAt, outcome: "pending", resultAt: null });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("V2 access-request journey (local, off, simulated transport)", () => {
  it("goes from the first mail to a soft closure, never repeating a failed step or known information, with no network", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const store = new FakeCaseStore();
    store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m1" }, "Bonjour, je n'arrive plus à me connecter à mon espace.");
    store.admit();

    // 1. First mail: an answer grounded in the applicable knowledge, with the access link.
    const first = await investigate(store, [ok(answer(store.version, RESET))]);
    expect(first.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(first.calls[0]).toMatchObject({ inputKey: "in:e1", subjectKey: "sav-case:case-1:in:e1", knowledge: [expect.objectContaining({ id: "k-reset" }), expect.objectContaining({ id: "k-browser" })] });
    humanSendsDraft(store, "a1", { id: "t1", knowledge: RESET });

    // 2. The customer tried it, it failed, and gave the login error. The model first proposes the same step again,
    //    then asks for the error already given: both refused with their codes, the third proposal is accepted.
    const failed = store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m2" }, "J'ai réinitialisé, ça ne marche toujours pas : « session expirée ».");
    store.body.trials[0] = { ...store.body.trials[0], outcome: "failed", resultAt: failed.occurredAt };
    store.body.facts.push({ id: "f1", text: "Message affiché : session expirée.", source: { type: "email", id: "m2" }, at: failed.occurredAt, key: "login_error", kind: "customer_statement" });
    // Q10: an approved rule qualifies the new message, so the run re-evaluates by itself (one version) and goes on, with
    // no human validation. (A message no rule qualifies goes to the team instead: runner and store tests.)
    store.rules = "admit";
    const v = store.version + 1;
    const second = await investigate(store, [ok(answer(v, RESET)), ok(ask(v, "login_error")), ok(answer(v, BROWSER))]);
    expect(second.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 3 });
    expect(second.calls.map(call => call.feedback.map(row => row.code))).toEqual([[], ["repeated_failed_procedure"], ["question_already_answered"]]);
    expect(second.calls.every(call => call.subjectKey === `sav-case:case-1:in:${failed.id}`)).toBe(true);
    expect(second.records[0].attempts.map(row => row.result === "validated" && row.codes)).toEqual([["repeated_failed_procedure"], ["question_already_answered"], []]);
    humanSendsDraft(store, "a2", { id: "t2", knowledge: BROWSER });

    // 3. "Merci, ça remarche": the quote is checked in the mail, then a second reading tells resolved from a transfer thanks.
    const thanks = store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m3" }, "Merci, ça remarche depuis l'autre navigateur !");
    const third = await investigate(store, [ok(confirm(store.version + 1, "m3", "t2", "ça remarche")), ok({ verdicts: [{ requestId: "r1", verdict: "resolved" }] })]);
    expect(third.report).toMatchObject({ status: "recorded", outcome: "accepted", closure: "soft_close", modelCalls: 2 });
    expect(third.calls.map(call => call.purpose)).toEqual(["decision", "resolution_check"]);

    // Every run left exactly one observation in the journal, readable back; no network at any step.
    expect(store.journal).toHaveLength(3);
    expect(readCaseInvestigationProgress(store.journal, `in:${thanks.id}`)).toMatchObject({ state: "found", record: { decision: { closure: { plan: "soft_close" } } } });
    expect(network).not.toHaveBeenCalled();
  });

  it("asks a targeted question, then waits for J2: neither the timer nor a CRM change spends a call, the answer opens a new budget", async () => {
    const store = new FakeCaseStore();
    store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m1" }, "Bonjour, je n'arrive plus à me connecter.");
    store.admit();
    const first = await investigate(store, [ok(ask(store.version, "login_error"))]);
    expect(first.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    const sent = humanSendsDraft(store, "a1");
    // What applying the decision stores: the question is now pending, so re-validating it would refuse it as "already pending".
    store.body.questions.push({ id: "q1", text: "Quel message s'affiche ?", factKeys: ["login_error"], askedAt: sent.occurredAt, askedInEffect: "effect-a1" });
    // No answer: a CRM change, then the J2 timer (pole C sends the follow-up). Neither is a customer input: no call,
    // no record, no team flag from our own pending question.
    // A HubSpot note alone keeps the admission (pole A v6): the run reaches the stored decision, not the team.
    store.append("crm_observed", "internal", { type: "hubspot_object", id: "ticket-1" }, undefined, "note_added");
    store.append("timer_fired", "internal", { type: "timer", id: "j2-1" });
    const afterTimer = await investigate(store, [ok(ask(store.version, "login_error"))]);
    expect(afterTimer.calls).toEqual([]);
    expect(afterTimer.records).toEqual([]);
    expect(afterTimer.report).toMatchObject({ status: "already_recorded", recordedOn: 2, modelCalls: 1 });
    // The customer finally answers: a new input, with its own budget.
    store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m2" }, "Le message est « session expirée ».");
    store.admit();
    const answered = await investigate(store, [ok(answer(store.version, RESET))]);
    expect(answered.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
  });

  it("re-evaluates a new message by the approved rules only (Q10): out of scope goes to the team with its reason, a human owner stays human", async () => {
    const store = new FakeCaseStore();
    store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m1" }, "Bonjour, je n'arrive plus à me connecter.");
    store.admit();
    expect((await investigate(store, [ok(ask(store.version, "login_error"))])).report).toMatchObject({ status: "recorded", modelCalls: 1 });
    // A new message the approved rules do not admit: pole A withdraws the case to the team, no claim and no call.
    store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m2" }, "Autre sujet : je voudrais une démonstration d'un autre produit.");
    store.rules = "team";
    const out = await investigate(store, [ok(ask(store.version + 1, "login_error"))]);
    expect(out.report).toMatchObject({ status: "skipped", reason: "not_agent_owned", detail: "human", modelCalls: 0 });
    expect(out.calls).toEqual([]);
    expect(store.admission).toMatchObject({ target: "team", reasons: ["family_not_admitted"] });
    // The team holds it; another customer message is never re-evaluated back to the agent (only a hand-back can).
    const version = store.version; store.rules = "admit";
    store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m3" }, "Et pour ma connexion ?");
    const still = await investigate(store, [ok(ask(store.version, "login_error"))]);
    expect(still.report).toMatchObject({ status: "skipped", reason: "not_agent_owned", modelCalls: 0 });
    expect(store.version).toBe(version + 1);
    expect(store.owner).toBe("human");
  });

  it("stops a repeated refusal visibly, keeps an uncertain call unsent, and lets a hand-back open a new budget", async () => {
    const store = new FakeCaseStore();
    store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m1" }, "Bonjour, je n'arrive plus à me connecter.");
    store.admit();
    const v = store.version;
    const refused = await investigate(store, [ok(askingPassword(v)), ok(askingPassword(v)), ok(ask(v, "login_error"))]);
    expect(refused.report).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: 2, refusal: { kind: "forbidden_action" } });
    const stored = readCaseInvestigationProgress(store.journal, "in:e1");
    expect(stored.state === "found" && listCaseInvestigationWaits([{ caseId: "case-1", inputKey: "in:e1", progress: stored.record.progress }], store.now))
      .toEqual([expect.objectContaining({ reason: "decision_refused", needsPerson: true })]);
    // The team takes it, then gives it back: a new budget of 3 calls; the first one is uncertain and is never re-sent.
    store.owner = "human"; store.append("outbound_observed", "human_outbound", { type: "email", id: "h1" });
    expect((await investigate(store, [])).report).toMatchObject({ status: "skipped", reason: "not_agent_owned" });
    store.owner = "agent";
    const handBack = store.append("owner_changed", "internal", { type: "studio_command", id: "back-1" });
    store.admit();
    const back = await investigate(store, [{ status: "failed", uncertain: true }]);
    expect(back.report).toMatchObject({ status: "usage_uncertain", modelCalls: 1 });
    expect(back.calls[0]).toMatchObject({ inputKey: `back:${handBack.id}`, call: 1 });
    const again = await investigate(store, [ok(ask(store.version, "login_error"))]);
    expect(again.calls).toEqual([]);
    expect(again.report).toMatchObject({ status: "usage_uncertain", modelCalls: 1 });
    expect(SAV_CASE_INVESTIGATION_MAX_CALLS).toBe(3);
  });

  it("stops at once when the model finds a finance request the intake missed, flags it and lists it for the team", async () => {
    const store = new FakeCaseStore();
    store.append("inbound_confirmed", "customer_inbound", { type: "email", id: "m1" }, "Je n'arrive plus à me connecter, et je veux le remboursement du mois.");
    store.admit();
    const finance = { ...ask(store.version, "login_error"), understanding: { requests: [{ id: "r1", summary: "Accès et remboursement.", family: "finance", status: "open" }], newFacts: [] } };
    const run = await investigate(store, [ok(finance), ok(ask(store.version, "login_error"))]);
    expect(run.report).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: 1, refusal: { kind: "forbidden_case", nextStep: "team" } });
    expect(run.records[0].flags).toEqual({ sensitiveFoundByModel: true, learningExcluded: true, sameRefusalRepeated: false });
    expect(readCaseInvestigationProgress(store.journal, "in:e1")).toMatchObject({ state: "found", record: { progress: { waiting: { reason: "decision_refused" } } } });
  });
});
