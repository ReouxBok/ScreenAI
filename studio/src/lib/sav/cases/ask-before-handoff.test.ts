import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
import {
  SAV_CASE_ASK_BEFORE_HANDOFF_INSTRUCTION, SAV_CASE_REASK_ADVISOR_NOTICE, SAV_CASE_REASK_SCREENSHOT_KEY, SAV_CASE_REASK_SCREENSHOT_QUESTION,
} from "./ask-before-handoff";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION, type CaseBody, type CaseEvent, type CaseSnapshot } from "./case-types";
import { buildCaseDecisionContext } from "./decision-context";
import type { CaseDecisionValidation, CaseDecisionValidationContext } from "./decision-contract";
import { validateCaseDecision } from "./decision-validator";
import { caseDecisionDraft } from "./investigation-intent";
import type { CaseInvestigationStoredRecord } from "./investigation-record";
import { caseInvestigationPrompt } from "./investigation-v2-providers";

// Synthetic data only: the 16-17/11 Access sequence, paraphrased, without any customer content.
const now = new Date("2026-11-17T07:00:00Z");
const ACCESS = "https://new.limova.ai";
const REPEAT = "Bonjour, je n'arrive pas à me connecter.";
const Q_ERROR = "Quel message d’erreur s’affiche exactement à l’écran ?";
const Q_PAGE = "Que se passe-t-il quand vous allez sur new.limova.ai et saisissez votre adresse e-mail ?";
const email = (id: string) => ({ type: "email" as const, id });
const loginCard: SavRetrievalCandidate = { id: "k-login", contentVersionId: "k-login-v1", title: "Connexion", content: `Aller sur ${ACCESS} et saisir son adresse.`, source: "test",
  verifiedAt: "2026-11-01T00:00:00Z", semanticScore: null, resolution: { steps: [`Allez sur ${ACCESS}.`, "Saisissez votre adresse e-mail d'inscription."] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };

afterEach(() => vi.unstubAllEnvs());
const on = () => vi.stubEnv("SAV_V2_ASK_BEFORE_HANDOFF", "on");

const codes = (result: CaseDecisionValidation) => result.outcome === "needs_review" ? result.rejections.map(row => row.code) : [];
const decision = (result: CaseDecisionValidation) => { expect(codes(result)).toEqual([]); if (result.outcome !== "accepted") throw new Error("not accepted"); return result; };
const handoff = (reason = "repeated_failure", caseVersion = 9, ids = ["r1"], families: string[] = ids.map(() => "access")) => ({ caseVersion,
  understanding: { requests: ids.map((id, index) => ({ id, summary: "Connexion impossible.", family: families[index]!, status: "open" })), newFacts: [] as unknown[] },
  nextAction: { kind: "handoff", reason, requestIds: ids, report: { need: "Connexion impossible.", expected: null, observed: null, trialIds: [], hypotheses: [], missingInformation: [], expectedIntervention: "Vérifier côté équipe.", knowledge: [] } } });

/* ---------- Unit: the rule on a hand-built validation context ---------- */

type Ctx = CaseDecisionValidationContext;
function ctx(patch: Partial<Ctx> = {}): Ctx {
  return { caseId: "case-1", caseVersion: 9, owner: "agent", admission: { admitted: true }, locale: "fr-FR", audience: "support", sensitiveCategories: [],
    requests: [{ id: "r1", family: "access", status: "open" }],
    sources: [
      { ref: email("m1"), direction: "customer_inbound", at: "2026-11-16T12:00:00Z", order: 1 },
      { ref: email("a1"), direction: "agent_outbound", at: "2026-11-16T12:30:00Z", order: 2 },
      { ref: email("m2"), direction: "customer_inbound", at: "2026-11-16T20:00:00Z", order: 3 },
      { ref: email("a2"), direction: "agent_outbound", at: "2026-11-16T22:50:00Z", order: 4 },
      { ref: email("m3"), direction: "customer_inbound", at: "2026-11-17T06:30:00Z", order: 5 },
    ],
    customerTexts: { "email:m1": REPEAT, "email:m2": REPEAT, "email:m3": REPEAT },
    facts: [],
    questions: [
      { id: "procedure:eff-1", factKeys: [], askedAt: "2026-11-16T12:30:00Z", answeredBy: null, text: "Avez-vous pu essayer la procédure proposée ?" },
      { id: "in:e3:q1", factKeys: ["login_error_message"], askedAt: "2026-11-16T22:50:00Z", answeredBy: null, text: Q_ERROR },
      { id: "in:e3:q2", factKeys: ["login_page_result"], askedAt: "2026-11-16T22:50:00Z", answeredBy: null, text: Q_PAGE },
    ],
    trials: [{ id: "t1", requestId: "r1", knowledge: { knowledgeId: "k-login", contentVersionId: "k-login-v1" }, askedAt: "2026-11-16T12:30:00Z", outcome: "pending", resultAt: null }],
    handoffs: [], knowledge: [loginCard], ...patch };
}
const run = (proposal: unknown, context = ctx()) => validateCaseDecision(proposal, context, now);

describe("SAV_V2_ASK_BEFORE_HANDOFF: one re-ask before a premature hand-over", () => {
  it("off (absent, or any value but exact \"on\"): the hand-over is accepted as on main", () => {
    for (const value of [undefined, "true", "ON", "1"]) {
      if (value !== undefined) vi.stubEnv("SAV_V2_ASK_BEFORE_HANDOFF", value);
      const result = decision(run(handoff()));
      expect(result.decision.nextAction).toMatchObject({ kind: "handoff", reason: "repeated_failure" });
      expect(result.signals).not.toContain("handoff_reask_composed");
    }
  });

  it("on: a repeat without new facts becomes ONE question reply restating the open questions verbatim, in send order, with a screenshot and the advisor notice", () => {
    on();
    const result = decision(run(handoff()));
    expect(result.signals).toContain("handoff_reask_composed");
    const action = result.decision.nextAction;
    if (action.kind !== "ask") throw new Error("expected an ask");
    expect(action.questions.map(question => question.text)).toEqual([Q_ERROR, Q_PAGE, SAV_CASE_REASK_SCREENSHOT_QUESTION]);
    expect(action.questions.map(question => question.seeks.map(seek => seek.factKey))).toEqual([["login_error_message"], ["login_page_result"], [SAV_CASE_REASK_SCREENSHOT_KEY]]);
    const text = result.decision.reply!.text;
    expect(text.indexOf(Q_ERROR)).toBeGreaterThan(0);
    expect(text.indexOf(Q_PAGE)).toBeGreaterThan(text.indexOf(Q_ERROR));
    expect(text.indexOf(SAV_CASE_REASK_SCREENSHOT_QUESTION)).toBeGreaterThan(text.indexOf(Q_PAGE));
    expect(text.trimEnd().endsWith(SAV_CASE_REASK_ADVISOR_NOTICE)).toBe(true);
    expect(text).toContain(ACCESS);
    // The procedure follow-up the case records after an answer is not one of our questions.
    expect(text).not.toContain("Avez-vous pu essayer");
  });

  it("on: diagnosis_out_of_tools on the same empty repeat is composed the same way", () => {
    on();
    expect(decision(run(handoff("diagnosis_out_of_tools"))).decision.nextAction.kind).toBe("ask");
  });

  it.each(["explicit_human_request", "knowledge_missing", "evidence_inaccessible"])("on: the other hand-over reasons are unchanged (%s)", reason => {
    on();
    expect(decision(run(handoff(reason))).decision.nextAction).toMatchObject({ kind: "handoff", reason });
  });

  it("on: several open requests on different topics keep the hand-over", () => {
    on();
    const context = ctx({ requests: [{ id: "r1", family: "access", status: "open" }, { id: "r2", family: "usage", status: "open" }] });
    expect(decision(run(handoff("repeated_failure", 9, ["r1", "r2"], ["access", "usage"]), context)).decision.nextAction.kind).toBe("handoff");
  });

  it("on: a sensitive case keeps its hand-over", () => {
    on();
    expect(decision(run(handoff(), ctx({ sensitiveCategories: ["finance"] }))).decision.nextAction.kind).toBe("handoff");
  });

  it("on: the latest mail answers an open question, the hand-over stands", () => {
    on();
    const proposal = handoff();
    proposal.understanding.newFacts = [{ id: "f1", key: "login_error_message", statement: "Le client cite un message.", kind: "customer_statement", source: email("m3") }];
    expect(decision(run(proposal)).decision.nextAction.kind).toBe("handoff");
  });

  it("on: a file attached to the latest mail is new material, the hand-over stands", () => {
    on();
    const base = ctx();
    const context = ctx({ sources: [...base.sources, { ref: { type: "attachment", id: "m3:2" }, direction: "customer_inbound", at: "2026-11-17T06:30:00Z", order: 6 }] });
    expect(decision(run(handoff(), context)).decision.nextAction.kind).toBe("handoff");
  });

  it("on: once the single re-ask was sent, the next empty repeat is handed over", () => {
    on();
    const base = ctx();
    const context = ctx({ questions: [...base.questions, { id: "in:e5:q3", factKeys: [SAV_CASE_REASK_SCREENSHOT_KEY], askedAt: "2026-11-17T06:31:00Z", answeredBy: null, text: SAV_CASE_REASK_SCREENSHOT_QUESTION }],
      sources: [...base.sources, { ref: email("a3"), direction: "agent_outbound", at: "2026-11-17T06:31:00Z", order: 6 }, { ref: email("m4"), direction: "customer_inbound", at: "2026-11-17T09:00:00Z", order: 7 }],
      customerTexts: { ...base.customerTexts, "email:m4": REPEAT } });
    expect(decision(run(handoff(), context)).decision.nextAction.kind).toBe("handoff");
  });

  it("on: no open question and no screenshot ever asked → asks only for the screenshot, with the advisor notice", () => {
    on();
    const context = ctx({ questions: [ctx().questions[0]!] });
    const result = decision(run(handoff(), context));
    const action = result.decision.nextAction;
    if (action.kind !== "ask") throw new Error("expected an ask");
    expect(action.questions.map(question => question.text)).toEqual([SAV_CASE_REASK_SCREENSHOT_QUESTION]);
    expect(result.decision.reply!.text).toContain(SAV_CASE_REASK_ADVISOR_NOTICE);
  });

  it("on: no open question and a screenshot already asked (and answered) → the hand-over stands", () => {
    on();
    const base = ctx();
    const context = ctx({ questions: base.questions.map(row => ({ ...row, answeredBy: email("m2") })) });
    expect(decision(run(handoff(), context)).decision.nextAction.kind).toBe("handoff");
  });

  it("on: a first message with no earlier exchange keeps its hand-over", () => {
    on();
    const context = ctx({ sources: [ctx().sources[0]!], questions: [], trials: [] });
    expect(decision(run(handoff(), context)).decision.nextAction.kind).toBe("handoff");
  });

  it("on: a record without the sent wording falls back to the hand-over (never a paraphrase)", () => {
    on();
    const context = ctx({ questions: ctx().questions.map(({ text: _text, ...row }) => row) });
    expect(decision(run(handoff(), context)).decision.nextAction.kind).toBe("handoff");
  });

  it("the prompt line is sent only when the switch is on", () => {
    const request = { purpose: "decision", snapshot: { version: 9, body: emptyCaseBody() }, knowledge: [], coverage: null, feedback: [], closure: [] } as never;
    const off = caseInvestigationPrompt(request);
    expect(off.instruction).not.toContain(SAV_CASE_ASK_BEFORE_HANDOFF_INSTRUCTION);
    on();
    const lit = caseInvestigationPrompt(request);
    expect(lit.instruction).toContain(SAV_CASE_ASK_BEFORE_HANDOFF_INSTRUCTION);
    expect(lit.instruction.replace(`${SAV_CASE_ASK_BEFORE_HANDOFF_INSTRUCTION}\n`, "")).toBe(off.instruction);
    expect(lit.payload).toEqual(off.payload);
  });
});

/* ---------- Flow: the real 16-17/11 sequence through the stored case, the context projection, the validator and the reply draft ---------- */

describe("flow: 16/11 card steps → empty repeat → 2 questions → empty repeat (→ re-ask) → empty repeat", () => {
  let seq = 0;
  const event = (kind: CaseEvent["kind"], direction: CaseEvent["direction"], occurredAt: string, id: string): CaseEvent => {
    seq += 1;
    return { id: `e${seq}`, caseId: "case-1", kind, dedupeKey: `${kind}:${seq}`, caseVersion: seq, direction, occurredAt, sourceRef: email(id), detail: null, createdAt: occurredAt };
  };
  const inbound = (id: string, at: string) => event("inbound_confirmed", "customer_inbound", at, id);
  const outbound = (id: string, at: string) => event("outbound_observed", "agent_outbound", at, id);

  /** The case as the store leaves it after the 22:50 questions and the 17/11 repeat. */
  function initial(ids = ["r1"]) {
    seq = 0;
    const events = [inbound("m1", "2026-11-16T12:00:00Z"), outbound("a1", "2026-11-16T12:30:00Z"), inbound("m2", "2026-11-16T20:00:00Z"),
      outbound("a2", "2026-11-16T22:50:00Z"), inbound("m3", "2026-11-17T06:30:00Z")];
    const body: CaseBody = { ...emptyCaseBody(), openRequests: ids.map(id => ({ id, summary: "Connexion impossible.", family: "access" as const, status: "open" as const, openedAt: "2026-11-16T12:00:00Z" })),
      trials: [{ id: "t1", requestId: "r1", procedure: { knowledgeId: "k-login", contentVersionId: "k-login-v1" }, askedAt: "2026-11-16T12:30:00Z", outcome: "pending", resultAt: null }],
      questions: [
        { id: "procedure:eff-1", text: "Avez-vous pu essayer la procédure proposée ?", factKeys: [], askedAt: "2026-11-16T12:30:00Z", askedInEffect: "eff-1" },
        { id: "in:e3:q1", text: Q_ERROR, factKeys: ["login_error_message"], askedAt: "2026-11-16T22:50:00Z", askedInEffect: "eff-2" },
        { id: "in:e3:q2", text: Q_PAGE, factKeys: ["question_abc"], askedAt: "2026-11-16T22:50:00Z", askedInEffect: "eff-2" },
      ] } as CaseBody;
    return { events, body };
  }
  const snapshot = (body: CaseBody, version: number): CaseSnapshot => ({ contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "ticket-1", threadIds: ["thread-1"], version,
    owner: "agent", phase: "awaiting_customer", sensitivity: "none", createdAt: "2026-11-16T12:00:01Z", updatedAt: "2026-11-17T06:30:01Z", body, admission: null, admissionInputVersion: 1 });
  function decide(state: { events: CaseEvent[]; body: CaseBody }, proposal: ReturnType<typeof handoff>) {
    const version = state.events.length;
    const built = buildCaseDecisionContext({ snapshot: snapshot(state.body, version), events: state.events, knowledge: [loginCard], locale: "fr-FR", audience: "support",
      admission: { admitted: true }, customerTexts: Object.fromEntries(state.events.filter(row => row.direction === "customer_inbound").map(row => [`email:${row.sourceRef.id}`, REPEAT])) });
    if (!built.ok) throw new Error(built.problem);
    const validation = validateCaseDecision({ ...proposal, caseVersion: version }, built.context, now);
    const latest = state.events.filter(row => row.direction === "customer_inbound").at(-1)!;
    const stored = { kind: "investigation", inputKey: `in:${latest.id}`, progress: {}, decision: { validation, caseVersion: version, actionsPaused: false, coverage: null, knowledge: [], closure: null } } as unknown as CaseInvestigationStoredRecord;
    return { validation, draft: caseDecisionDraft("case-1", stored, state.events) };
  }

  it("off: the 17/11 empty repeat is handed over, as in production today", () => {
    const { validation, draft } = decide(initial(), handoff());
    expect(decision(validation).decision.nextAction).toMatchObject({ kind: "handoff", reason: "repeated_failure" });
    expect(draft?.reply).toBeNull();
  });

  it("on: one re-ask (open questions + screenshot + advisor), recorded once, then hand-over on the next empty repeat", () => {
    on();
    const state = initial();
    const first = decide(state, handoff());
    expect(decision(first.validation).decision.nextAction.kind).toBe("ask");
    const reply = first.draft!.reply!;
    expect(reply.purpose).toBe("question");
    expect(reply.questions!.map(question => question.text)).toEqual([Q_ERROR, Q_PAGE, SAV_CASE_REASK_SCREENSHOT_QUESTION]);
    expect(reply.text).toContain(SAV_CASE_REASK_ADVISOR_NOTICE);
    expect(reply.text).toContain(ACCESS);

    // No double send: deciding the same input again gives the same single reply, with the same trigger and question ids (C keys the send on them).
    const again = decide(state, handoff());
    expect(again.draft).toEqual(first.draft);
    expect(again.draft!.triggerEventId).toBe(first.draft!.triggerEventId);

    // C records the sent questions on the case (case-effect-outcomes), then the customer repeats once more.
    const sentAt = "2026-11-17T07:05:00Z";
    state.body = { ...state.body, questions: [...state.body.questions, ...reply.questions!.map(question => ({ id: question.id, text: question.text, factKeys: [...question.factKeys], askedAt: sentAt, askedInEffect: "eff-3" }))] };
    state.events.push(outbound("a3", sentAt), inbound("m4", "2026-11-17T10:00:00Z"));
    const second = decide(state, handoff());
    expect(decision(second.validation).decision.nextAction).toMatchObject({ kind: "handoff", reason: "repeated_failure" });
    expect(second.validation.outcome === "accepted" && second.validation.signals).not.toContain("handoff_reask_composed");
    expect(second.draft?.reply ?? null).toBeNull();
  });

  it("on, Ugo's real case: 3 open Access requests relayed from 3 repeated mails, 2 open questions → 1 re-ask, then hand-over on the next empty repeat", () => {
    on();
    const ids = ["r1", "r2", "r3"];
    const state = initial(ids);
    const first = decide(state, handoff("repeated_failure", 9, ids));
    const accepted = decision(first.validation);
    expect(accepted.signals).toContain("handoff_reask_composed");
    const action = accepted.decision.nextAction;
    if (action.kind !== "ask") throw new Error("expected an ask");
    // Every open request is named by a question; the mail shows each question once, in send order.
    expect(new Set(action.questions.map(question => question.requestId))).toEqual(new Set(ids));
    const reply = first.draft!.reply!;
    expect(reply.purpose).toBe("question");
    for (const asked of [Q_ERROR, Q_PAGE, SAV_CASE_REASK_SCREENSHOT_QUESTION]) expect(reply.text.split(asked).length - 1).toBe(1);
    expect(reply.text.indexOf(Q_PAGE)).toBeGreaterThan(reply.text.indexOf(Q_ERROR));
    expect(reply.text.indexOf(SAV_CASE_REASK_SCREENSHOT_QUESTION)).toBeGreaterThan(reply.text.indexOf(Q_PAGE));
    expect(reply.text).toContain(SAV_CASE_REASK_ADVISOR_NOTICE);
    expect(decide(state, handoff("repeated_failure", 9, ids)).draft).toEqual(first.draft);

    const sentAt = "2026-11-17T07:05:00Z";
    state.body = { ...state.body, questions: [...state.body.questions, ...reply.questions!.map(question => ({ id: question.id, text: question.text, factKeys: [...question.factKeys], askedAt: sentAt, askedInEffect: "eff-3" }))] };
    state.events.push(outbound("a3", sentAt), inbound("m4", "2026-11-17T10:00:00Z"));
    const second = decide(state, handoff("repeated_failure", 9, ids));
    expect(decision(second.validation).decision.nextAction).toMatchObject({ kind: "handoff", reason: "repeated_failure", requestIds: ids });
    expect(second.draft?.reply ?? null).toBeNull();
  });
});
