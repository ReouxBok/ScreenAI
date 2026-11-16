import { describe, expect, it } from "vitest";
import { caseBodySchema, type CaseEvent } from "./case-types";
import type { CaseDecisionProposal } from "./decision-contract";
import { hasMultiQuestionWait, reconcileCaseQuestionAnswers } from "./case-question-followup";
import { j2ReminderText, J2_REMINDER_TEXT } from "./j2-auto-reminder";
import { caseReplyPayloadHash, caseEffectHash, caseReplyQuestions, type CaseReplyProposal } from "./case-effects";

const sent = "2026-11-16T09:00:00.000Z", at = "2026-11-16T10:00:00.000Z";
const source = { type: "email" as const, id: "partial" };
const body = () => caseBodySchema.parse({ openRequests: [], facts: [], hypotheses: [], trials: [], handoff: null, cycle: { number: 1 },
  revisions: null,
  questions: [1, 2, 3].map(i => ({ id: `in:initial:q${i}`, text: `Question ${i} ?`, factKeys: [`configuration_q${i}`], askedAt: sent, askedInEffect: "effect" })),
  waiting: { kind: "customer", since: sent, reasonCode: "j2_question", timerId: "timer" } });
const events = [{ direction: "customer_inbound", sourceRef: source, occurredAt: at }] as CaseEvent[];
const decision = (keys: string[]): CaseDecisionProposal => ({ caseVersion: 2, understanding: { requests: [], newFacts: keys.map((key, i) => ({ id: `fact-${i}`, key, statement: "Réponse synthétique", kind: "customer_statement", source })) }, nextAction: { kind: "observe_only" } });

describe("partial customer answers", () => {
  it("closes only sourced answers, keeps the others pending and persists their fact keys for resumption", () => {
    const next = reconcileCaseQuestionAnswers(body(), decision(["configuration_q1"]), events);
    expect(next.questions.map(q => Boolean(q.answeredBy))).toEqual([true, false, false]);
    expect(next.facts.map(f => f.key)).toEqual(["configuration_q1"]);
    expect(hasMultiQuestionWait(next)).toBe(true);
    expect(reconcileCaseQuestionAnswers(next, decision(["configuration_q1"]), events)).toEqual(next);
    expect(j2ReminderText(next, "effect", true)).not.toContain("Question 1 ?");
    expect(j2ReminderText(next, "effect", true)).toContain("Question 2 ?\n- Question 3 ?");
    const one = reconcileCaseQuestionAnswers(body(), decision(["configuration_q1", "configuration_q2"]), events);
    expect(j2ReminderText(one, "effect", true)).toContain("Question 3 ?");
    expect(j2ReminderText(one, "effect", true)).not.toContain("Question 2 ?");
    expect(j2ReminderText(one, "effect", false)).toBe(J2_REMINDER_TEXT);
    const complete = reconcileCaseQuestionAnswers(body(), decision(["configuration_q1", "configuration_q2", "configuration_q3"]), events);
    expect(complete.questions.every(question => question.answeredBy)).toBe(true);
    expect(hasMultiQuestionWait(complete)).toBe(false);
    expect(complete.waiting).toBeNull();
  });
  it("handles successive partial mails even when the model reuses a local fact id", () => {
    const first = reconcileCaseQuestionAnswers(body(), decision(["configuration_q1"]), events);
    const secondSource = { type: "email" as const, id: "partial-2" };
    const second = decision(["configuration_q2"]);
    second.understanding.newFacts[0]!.source = secondSource;
    const next = reconcileCaseQuestionAnswers(first, second, [...events, { ...events[0]!, sourceRef: secondSource, occurredAt: "2026-11-16T11:00:00.000Z" }]);
    expect(next.questions.map(question => Boolean(question.answeredBy))).toEqual([true, true, false]);
    expect(next.facts.map(fact => fact.key)).toEqual(["configuration_q1", "configuration_q2"]);
    expect(new Set(next.facts.map(fact => fact.id)).size).toBe(2);
    expect(next.facts[0]).toEqual(first.facts[0]);
  });
  it("dates a question's final answer by the latest required fact, independently of key order", () => {
    const current = body();
    current.questions[0]!.factKeys = ["later", "earlier"];
    current.facts = [
      { id: "early", key: "earlier", text: "Premier élément", kind: "customer_statement", source: { type: "email", id: "first" }, at },
      { id: "late", key: "later", text: "Second élément", kind: "customer_statement", source, at: "2026-11-16T11:00:00.000Z" },
    ];
    expect(reconcileCaseQuestionAnswers(current, decision([]), events).questions[0]!.answeredBy).toEqual(source);
  });
  it("does not infer answers from an unrelated, old or empty mail; all requested keys are required", () => {
    expect(reconcileCaseQuestionAnswers(body(), decision([]), events).questions.every(q => !q.answeredBy)).toBe(true);
    expect(reconcileCaseQuestionAnswers(body(), decision(["configuration_q1"]), []).questions.every(q => !q.answeredBy)).toBe(true);
    expect(reconcileCaseQuestionAnswers(body(), decision(["configuration_q1"]), [{ ...events[0]!, occurredAt: sent }]).questions.every(q => !q.answeredBy)).toBe(true);
    const current = body(); current.questions[0]!.factKeys.push("configuration_other");
    expect(reconcileCaseQuestionAnswers(current, decision(["configuration_q1"]), events).questions[0]!.answeredBy).toBeUndefined();
  });
  it("retains legacy single-question data and reminder text exactly", () => {
    const legacy = body(); legacy.questions = legacy.questions.slice(0, 1);
    expect(reconcileCaseQuestionAnswers(legacy, decision(["configuration_q1"]), events)).toEqual(legacy);
    expect(j2ReminderText(legacy, "effect", true)).toBe(J2_REMINDER_TEXT);
    const proposal = { caseId: "10000000-0000-4000-8000-000000000001", caseVersion: 1, triggerEventId: "inbound:initial", inboundMessageId: "message", purpose: "question", recipient: "test@example.invalid", subject: "Test", text: "Question ?", question: { id: "in:initial:q1", text: "Question ?", factKeys: [] } } satisfies CaseReplyProposal;
    expect(caseReplyQuestions(proposal)).toEqual([proposal.question]);
    expect(caseReplyPayloadHash(proposal)).toBe(caseEffectHash({ ...proposal }));
    expect(caseReplyPayloadHash({ ...proposal, question: undefined, questions: [proposal.question, { ...proposal.question, id: "q2" }] })).not.toBe(caseReplyPayloadHash(proposal));
  });
});
