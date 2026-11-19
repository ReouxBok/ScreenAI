import { describe, expect, it, vi } from "vitest";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { SAV_CASE_SUBJECT_ABSENCES, type CaseRequestSubject, type CaseSnapshot } from "./case-types";
import { SAV_CASE_DECISION_CONTRACT_REVISION } from "./decision-contract";
import { caseReplyPayloadHash, checkCaseReplyApproval } from "./case-effects";
import { caseDecisionDraft, caseReplyTriggerOf } from "./investigation-intent";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { caseBodySchema, emptyCaseBody, type CaseEvent } from "./case-types";
import { hasMultiQuestionWait, reconcileCaseQuestionAnswers } from "./case-question-followup";
import type { CaseDecisionProposal } from "./decision-contract";
import type { CaseInvestigationStoredRecord } from "./investigation-record";

/* Weekend 30/10: per-request knowledge selection, the SAV-19 inventory and the B → C intents. Pure, synthetic data. */

const now = new Date("2026-10-30T12:00:00Z");
const scope = { locale: "fr-FR", audience: "support" as const, now };
const card = (id: string, extra: Record<string, unknown> = {}, patch: Partial<SavRetrievalCandidate> = {}): SavRetrievalCandidate => ({
  id, contentVersionId: `${id}-v1`, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture", verifiedAt: "2026-10-20T00:00:00Z", semanticScore: null,
  resolution: { steps: ["Étape synthétique"], ...extra }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" }, ...patch,
});
type Row = CaseSnapshot["body"]["openRequests"][number];
/** A relayed request as pole A stores it (v10): the generic label, and the searchable subject from V1's accepted analysis. */
const label = (id: string) => `Demande « support » relevée par l'analyse V1 du mail ${id.split("/")[0]}.`;
const available = (text: string): CaseRequestSubject => ({ status: "available", text, provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
  runId: "30000000-0000-4000-8000-000000000001", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: "2026-10-30T08:59:00Z" } });
const row = (id: string, subject: string | CaseRequestSubject, family: Row["family"] = "access", openedAt = "2026-10-30T09:00:00Z", status: Row["status"] = "open"): Row =>
  ({ id, summary: label(id), family, status, openedAt, subject: typeof subject === "string" ? available(subject) : subject });
const snapshot = (openRequests: Row[]) => ({ caseId: "case-1", version: 4, body: { openRequests } }) as unknown as CaseSnapshot;
function backend(byPattern: Array<[RegExp, SavRetrievalCandidate[]]>, options: { down?: boolean; revisions?: string[] } = {}) {
  const queries: string[][] = [], revisions = [...(options.revisions ?? [])];
  const search = vi.fn(async (batch: readonly string[]) => {
    queries.push([...batch]);
    if (options.down) throw Error("SEARCH_DOWN_FIXTURE");
    return batch.map(query => byPattern.filter(([pattern]) => pattern.test(query)).flatMap(([, cards]) => cards));
  });
  const port: SavRetrievalBackend = { readRevision: async () => revisions.length ? revisions.shift()! : "kb-r1", search };
  return { port, queries, search };
}

describe("selectCaseKnowledge: published, applicable cards per open request, read only", () => {
  it("keeps the backend's own card objects, per request, and reports a real gap separately from a covered request", async () => {
    const login = card("k-login");
    const b = backend([[/connexion/i, [login]]]);
    const read = await selectCaseKnowledge(snapshot([row("r1", "Connexion impossible."), row("r2", "Export des contacts en erreur.", "usage")]), b.port, scope);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.selection.cards[0]).toBe(login);
    expect(read.selection.coverage.map(entry => [entry.requestId, entry.status, entry.knowledge.length])).toEqual([["r1", "covered", 1], ["r2", "no_applicable_knowledge", 0]]);
    expect(read.selection.revision).toBe("kb-r1");
  });

  it("never offers an expired, unverified, unpublished or other-locale card, and says why", async () => {
    const b = backend([[/connexion/i, [card("k-old", { validUntil: "2026-01-01" }), card("k-unverified", {}, { verifiedAt: null }),
      card("k-draft", {}, { availability: { ...card("x").availability, published: false } }), card("k-en", {}, { availability: { ...card("x").availability, locale: "en-GB" } })]]]);
    const read = await selectCaseKnowledge(snapshot([row("r1", "Connexion impossible.")]), b.port, scope);
    expect(read).toMatchObject({ status: "ready", selection: { cards: [], coverage: [{ status: "no_applicable_knowledge" }] } });
    if (read.status === "ready") expect(read.selection.alerts.map(alert => alert.code).sort()).toEqual(["expired", "locale", "unpublished", "unverified"]);
  });

  it("never searches a sensitive or closed request; long case request ids are searched under local aliases", async () => {
    const long = `${"m".repeat(150)}/r1`;
    const b = backend([[/connexion/i, [card("k-login")]]]);
    const read = await selectCaseKnowledge(snapshot([row(long, "Connexion impossible."), row("r-fin", "Demande de remboursement.", "finance"), row("r-done", "Connexion rétablie.", "access", undefined, "resolved")]), b.port, scope);
    expect(b.queries).toEqual([["Connexion impossible."]]);
    expect(read).toMatchObject({ status: "ready", selection: { coverage: [{ requestId: long, status: "covered" }] } });
  });

  it("beyond the search budget, the newest requests are searched; the others are `not_searched`, never an absence", async () => {
    const b = backend([[/./, [card("k-any")]]]);
    const rows = ["Demande A.", "Demande B.", "Demande C.", "Demande D."].map((summary, index) => row(`r${index}`, summary, "usage", `2026-10-30T0${index}:00:00Z`));
    const read = await selectCaseKnowledge(snapshot([...rows, row("r-short", "ok")]), b.port, scope);
    if (read.status !== "ready") throw Error("expected ready");
    expect(read.selection.coverage.map(entry => [entry.requestId, entry.status])).toEqual([["r0", "not_searched"], ["r1", "covered"], ["r2", "covered"], ["r3", "covered"], ["r-short", "not_searched"]]);
    expect(read.selection.coverage.find(entry => entry.requestId === "r-short")!.limitations).toEqual(["subject_too_short"]);
  });

  it("searches pole A's subject (`caseRequestSearchText`), never the relay's label", async () => {
    const b = backend([[/connexion/i, [card("k-login")]], [/relevée par l'analyse/, [card("k-label")]]]);
    const read = await selectCaseKnowledge(snapshot([row("gm-1/r1", "Connexion impossible. Le code n'arrive pas.")]), b.port, scope);
    expect(b.queries).toEqual([["Connexion impossible. Le code n'arrive pas."]]);
    expect(read).toMatchObject({ status: "ready", selection: { coverage: [{ requestId: "gm-1/r1", status: "covered", knowledge: [{ knowledgeId: "k-login" }] }] } });
  });

  it("no subject, whatever pole A's reason (absent, ambiguous, shared, masked, before v10): not searched, never a false gap, and the reason is kept", async () => {
    const b = backend([[/./, [card("k-any")]]]);
    const rows = SAV_CASE_SUBJECT_ABSENCES.map((reason, index) => row(`gm-${index}/r1`, { status: "absent", reason }));
    const before = { ...row("gm-old/r1", "inutile"), subject: undefined };
    const read = await selectCaseKnowledge(snapshot([...rows, before]), b.port, scope);
    if (read.status !== "ready") throw Error("expected ready");
    expect(read.selection.coverage.map(entry => [entry.requestId, entry.status, entry.limitations])).toEqual([
      ...SAV_CASE_SUBJECT_ABSENCES.map((reason, index) => [`gm-${index}/r1`, "not_searched", ["subject_unavailable", `subject_${reason}`]]),
      ["gm-old/r1", "not_searched", ["subject_unavailable", "subject_not_recorded"]],
    ]);
    expect(read.selection.cards).toEqual([]);
    expect(b.search).not.toHaveBeenCalled();
  });

  it("a port that hands back the generic label is not searched either (`subject_generic`)", async () => {
    const b = backend([[/./, [card("k-any")]]]);
    const read = await selectCaseKnowledge(snapshot([row("gm-1/r1", "Connexion impossible.")]), b.port, scope, request => request.summary);
    expect(read).toMatchObject({ status: "ready", selection: { cards: [], coverage: [{ requestId: "gm-1/r1", status: "not_searched", limitations: ["subject_unavailable", "subject_generic"] }] } });
    expect(b.search).not.toHaveBeenCalled();
  });

  it("a failed search or a moving revision is `unavailable`, not a gap", async () => {
    expect(await selectCaseKnowledge(snapshot([row("r1", "Connexion impossible.")]), backend([], { down: true }).port, scope)).toEqual({ status: "unavailable", reason: "search_unavailable" });
    expect(await selectCaseKnowledge(snapshot([row("r1", "Connexion impossible.")]), backend([], { revisions: ["a", "b", "c", "d"] }).port, scope)).toEqual({ status: "unavailable", reason: "revision_unstable" });
  });
});

describe("B → C draft: the decision in pole C's own proposal shape (SAV-10), validated and gated by C", () => {
  const ref = { knowledgeId: "k1", contentVersionId: "k1-v1" };
  const stored = (nextAction: Record<string, unknown>, extra: Record<string, unknown> = {}, outcome = "accepted"): CaseInvestigationStoredRecord => ({
    kind: "sav-case-investigation.v1", inputKey: "in:evt-1", progress: { modelCalls: 1, attempts: [], waiting: null, proposal: null, last: null, closure: null, recordedOn: 7 },
    decision: { caseId: "case-1", caseVersion: 7, inputKey: "in:evt-1", actionsPaused: false, knowledge: [],
      validation: outcome === "accepted" ? { outcome, contractRevision: SAV_CASE_DECISION_CONTRACT_REVISION, decision: { caseVersion: 7, understanding: { requests: [], newFacts: [] }, nextAction, ...extra }, unverified: [], signals: [] }
        : { outcome, contractRevision: SAV_CASE_DECISION_CONTRACT_REVISION, rejections: [], unverified: [], signals: [] } } as never,
  });
  /** The stored input of `stored()`: the customer mail gm-1 (case event evt-1). */
  const EVENTS = [{ id: "evt-1", direction: "customer_inbound" as const, sourceRef: { type: "email" as const, id: "gm-1" } }];
  const answer = { kind: "answer", requestIds: ["r1"], steps: [{ text: "Suivre la fiche.", knowledge: ref, newFactIds: [] }], expectedResult: "Ça marche." };
  const reply = (text: string) => ({ reply: { text, citations: [ref], impossibilityClaims: [], accountAdvice: "none" } });

  const ask = (questions: string[]) => ({ kind: "ask", questions: questions.map(text => ({ text, requestId: "r1", reducesUncertainty: "Pour savoir.", seeks: [{ kind: "observed_result" }, { kind: "configuration", factKey: "configuration.version" }] })) });

  it("no draft for a refused decision or an observation; a handoff has a team note and no reply to send", () => {
    expect(caseDecisionDraft("case-1", stored(answer, {}, "needs_review"), EVENTS)).toBeNull();
    expect(caseDecisionDraft("case-1", stored({ kind: "observe_only" }), EVENTS)).toBeNull();
    const handoff = { kind: "handoff", reason: "knowledge_missing", requestIds: ["r1"], report: { need: "Besoin.", expected: null, observed: null, trialIds: [],
      hypotheses: ["Adresse différente."], missingInformation: ["Capture de l'écran."], expectedIntervention: "Vérifier l'accès.", knowledge: [] } };
    const draft = caseDecisionDraft("case-1", stored(handoff), EVENTS)!;
    expect(draft).toMatchObject({ reply: null, replyLimit: "no_reply", triggerEventId: "inbound:gm-1", decidedOn: 7 });
    expect(draft.noteText.split("\n")).toEqual(["Agent SAV V2 — Transfert à l'équipe (décision supervisée, à valider).", "Motif : knowledge_missing", "Besoin : Besoin.",
      "Intervention attendue : Vérifier l'accès.", "Manque : Capture de l'écran.", "Hypothèse : Adresse différente."]);
    expect(caseDecisionDraft("case-1", stored(handoff, reply("Nous transmettons à l'équipe.")), EVENTS)).toMatchObject({ reply: null, replyLimit: "purpose_not_supported" });
  });

  it("terminal messages are opt-in, deterministic and require a checked customer resolution", () => {
    const env = { SAV_V2_CLOSING_HANDOFF_REPLY: "on" };
    const action = { kind: "handoff", reason: "diagnosis_out_of_tools", requestIds: ["r1"], report: { need: "Diagnostic", expectedIntervention: "Vérifier", trialIds: [], hypotheses: [], missingInformation: [], knowledge: [], expected: null, observed: null } };
    expect(caseDecisionDraft("case-1", stored(action), EVENTS)?.reply).toBeNull();
    const handoff = caseDecisionDraft("case-1", stored(action, reply("Délai garanti https://evil.invalid")), EVENTS, undefined, env)!;
    expect(handoff).toMatchObject({ reply: { purpose: "handoff", text: "Un conseiller reprend votre demande." }, shownSources: [], citations: [] });
    expect(caseDecisionDraft("case-1", stored({ ...action, reason: "sensitive_request" }), EVENTS, undefined, env)?.reply).toBeNull();
    for (const family of ["finance", "cancellation", "identity", "rights", "subscription"]) {
      const sensitive = stored(action, { understanding: { requests: [{ id: "r1", family, status: "open", summary: "Sensible" }], newFacts: [] } });
      expect(caseDecisionDraft("case-1", sensitive, EVENTS, undefined, env)?.reply).toBeNull();
    }
    const resolved = stored({ kind: "confirm_resolution", requestIds: ["r1"], evidence: [] });
    expect(caseDecisionDraft("case-1", resolved, EVENTS, undefined, env)?.reply).toBeNull();
    resolved.decision!.closure = { plan: "soft_close", reason: "checked", verdicts: [{ requestId: "r1", verdict: "resolved" }] };
    expect(caseDecisionDraft("case-1", resolved, EVENTS, undefined, env)?.reply).toMatchObject({ purpose: "closing", text: expect.stringContaining("Merci pour votre confirmation") });
    expect(caseDecisionDraft("case-1", resolved, [], undefined, env)).toMatchObject({ reply: null, replyLimit: "inbound_unknown" });
    resolved.decision!.closure = { plan: "no_close_transfer_thanks", reason: "checked", verdicts: [] };
    expect(caseDecisionDraft("case-1", resolved, EVENTS, undefined, env)?.reply).toBeNull();
  });

  it("an answer becomes C's `answer` reply; one question becomes C's `question` with its fact keys; up to five questions share one mail; six are refused", () => {
    expect(caseDecisionDraft("case-1", stored(answer, reply("Bonjour, voici la marche.")), EVENTS)).toMatchObject({ reply: { purpose: "answer", text: "Bonjour, voici la marche." }, citations: [ref] });
    expect(caseDecisionDraft("case-1", stored(ask(["Quelle version utilisez-vous ?"]), reply("Bonjour, quelle version ?")), EVENTS)!.reply).toEqual({ purpose: "question", text: "Bonjour, quelle version ?",
      question: { id: "in:evt-1:q1", text: "Quelle version utilisez-vous ?", factKeys: ["configuration.version"] } });
    for (const count of [2, 3, 5]) {
      const texts = ["Quelle version ?", "Quel écran ?", "Quel navigateur ?", "Depuis quand ?", "Quel appareil ?"].slice(0, count);
      const action = ask(texts);
      action.questions.forEach((question, index) => { question.seeks = [{ kind: "configuration", factKey: `configuration_q${index + 1}` }]; });
      const draft = caseDecisionDraft("case-1", stored(action, reply("Bonjour, plusieurs questions.")), EVENTS)!;
      expect(draft.replyLimit).toBeNull();
      expect(draft.reply).toEqual({ purpose: "question", text: "Bonjour, plusieurs questions.", questions: texts.map((text, i) => ({ id: `in:evt-1:q${i + 1}`, text, factKeys: [`configuration_q${i + 1}`] })) });
    }
    const overlapping = caseDecisionDraft("case-1", stored(ask(["Quel écran ?", "Quel navigateur ?"]), reply("Deux questions.")), EVENTS)!.reply!.questions!;
    expect(overlapping.every(question => question.factKeys.length === 1)).toBe(true);
    expect(overlapping.map(question => question.factKeys)).toEqual([["configuration.version"], ["configuration.version"]]);
    const unkeyed = ask(["Q1 ?", "Q2 ?"]);
    unkeyed.questions.forEach(question => { question.seeks = [{ kind: "observed_result" }]; });
    const fallback = caseDecisionDraft("case-1", stored(unkeyed, reply("Deux questions.")), EVENTS)!.reply!;
    expect(fallback.questions?.map(question => question.factKeys[0])).toEqual([expect.stringMatching(/^question_[a-f0-9]{24}$/), expect.stringMatching(/^question_[a-f0-9]{24}$/)]);
    expect(fallback.questions?.[0]!.factKeys).not.toEqual(fallback.questions?.[1]!.factKeys);
    expect(caseDecisionDraft("case-1", stored(ask(["Q1 ?", "Q2 ?", "Q3 ?", "Q4 ?", "Q5 ?", "Q6 ?"]), reply("Six questions.")), EVENTS)).toMatchObject({ reply: null, replyLimit: "too_many_questions" });
  });

  it.each([
    [["browser", "device"], [false, false]],
    [["account_email"], [false, false]],
    [["browser", "account_email"], [true, false]],
    [["device", "account_email"], [false, true]],
    [["browser", "device", "account_email"], [true, true]],
    [[], [false, false]],
  ] as const)("preserves shared requirements from draft through partial answers: %j", (keys, answered) => {
    const action = ask(["Navigateur et compte ?", "Appareil et compte ?"]);
    const required = [["browser", "account_email"], ["device", "account_email"]];
    action.questions.forEach((question, index) => { question.seeks = required[index]!.map(factKey => ({ kind: "configuration", factKey })); });
    const questions = caseDecisionDraft("case-1", stored(action, reply("Deux questions.")), EVENTS)!.reply!.questions!;
    expect(questions.map(question => question.factKeys)).toEqual(required);
    const sent = "2026-11-16T09:00:00.000Z", at = "2026-11-16T10:00:00.000Z";
    const body = caseBodySchema.parse({ ...emptyCaseBody(), questions: questions.map(question => ({ ...question, askedAt: sent, askedInEffect: "effect" })),
      waiting: { kind: "customer", since: sent, reasonCode: "j2_question", timerId: "timer" } });
    const source = { type: "email" as const, id: "partial" };
    const proposal = (factKeys: readonly string[]): CaseDecisionProposal => ({ caseVersion: 8,
      understanding: { requests: [], newFacts: factKeys.map((key, i) => ({ id: `f${i}`, key, statement: "Réponse synthétique", kind: "customer_statement", source })) },
      nextAction: { kind: "observe_only" } });
    const events = [{ direction: "customer_inbound", sourceRef: source, occurredAt: at }] as CaseEvent[];
    const next = reconcileCaseQuestionAnswers(body, proposal(keys), events);
    expect(next.questions.map(question => Boolean(question.answeredBy))).toEqual(answered);
    const pending = answered.some(done => !done);
    expect(hasMultiQuestionWait(next)).toBe(pending);
    expect(next.waiting).toEqual(pending ? body.waiting : null);
    const complete = reconcileCaseQuestionAnswers(next, proposal(required.flat()), events);
    expect(complete.questions.every(question => question.answeredBy)).toBe(true);
    expect(complete.waiting).toBeNull();
  });

  it("the trigger is the stored mail answered (C's canonical `inbound:<Gmail id>`), never the input key; no stored mail, no reply", () => {
    const mail = (id: string, gmail: string) => ({ id, direction: "customer_inbound" as const, sourceRef: { type: "email" as const, id: gmail } });
    const back = (id: string) => ({ id, direction: "internal" as const, sourceRef: { type: "studio_command" as const, id } });
    const events = [mail("e1", "gm-a"), back("e2"), mail("e3", "gm-b"), back("e4")];
    expect(caseReplyTriggerOf(events, "in:e1")).toBe("inbound:gm-a");
    // A hand back answers the last customer mail before it: the same mail keeps the same key.
    expect(caseReplyTriggerOf(events, "back:e2")).toBe("inbound:gm-a");
    expect(caseReplyTriggerOf(events, "back:e4")).toBe("inbound:gm-b");
    expect(caseReplyTriggerOf([back("e0"), mail("e1", "gm-a")], "back:e0")).toBeNull();
    expect(caseReplyTriggerOf(events, "in:e2")).toBeNull();
    expect(caseReplyTriggerOf(events, "in:missing")).toBeNull();
    expect(caseDecisionDraft("case-1", stored(answer, reply("Bonjour.")), [])).toMatchObject({ triggerEventId: null, reply: null, replyLimit: "inbound_unknown" });
  });

  it("C's payload hash covers B's text: one changed character is another payload to validate", () => {
    const base = { caseId: "00000000-0000-4000-8000-000000000001", caseVersion: 8, inboundMessageId: "m1", recipient: "client@example.invalid", subject: "Accès" };
    const a = caseDecisionDraft("case-1", stored(answer, reply("Bonjour, voici la marche.")), EVENTS)!, b = caseDecisionDraft("case-1", stored(answer, reply("Bonjour, voici la marche !")), EVENTS)!;
    const proposal = (draft: typeof a) => ({ ...base, triggerEventId: draft.triggerEventId!, ...draft.reply! });
    expect(checkCaseReplyApproval(proposal(b), { payloadHash: caseReplyPayloadHash(proposal(a)), caseVersion: 8, recipient: base.recipient, approvedBy: "staff-1", approvedAt: "2026-10-30T12:00:00Z" })).toBe("payload_changed");
  });
});
