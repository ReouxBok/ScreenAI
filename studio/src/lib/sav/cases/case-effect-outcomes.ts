// SAV-10 x SAV-8 (pole C): what the case records ONCE a `reply_send` is CONFIRMED by the existing verification, and only then.
// Called by the executor after `confirmExecutionEffect` for a reply; never before, never from an uncertain, dispatched or failed send
// (an uncertain send is verify-only and schedules nothing: the J2 only follows a question that really left).
// Every step is idempotent, so a crash between two of them, a second wake or the recovery of the same effect completes the missing step
// and repeats none: the event is keyed by the Gmail message, the question by the effect, the trials of an answer by (effect, position), the timer by (case, question effect).
import { createHash } from "node:crypto";
import { trialRecipientBinding } from "./case-trial-return";
import { appendCaseEvent, CaseVersionStaleError, readCase, updateCaseRecord, type CaseTx } from "./case-store";
import type { CaseReplyProposal } from "./case-effects";
import { scheduleJ2ForConfirmedQuestion } from "./timer-store";

export type ConfirmedReply = Readonly<{
  proposal: CaseReplyProposal;
  /** Id of the confirmed `reply_send` ledger row: the question's `askedInEffect` and the J2 timer's `questionEffectId`. */
  effectId: string;
  /** The sent mail, as the verification attributed it. */
  gmailMessageId: string;
  gmailThreadId: string;
  sentAt: Date;
  currentPolicyRevision: string | null;
}>;
export type ConfirmedReplyOutcome = Readonly<{
  event: "appended" | "already_recorded";
  question: "recorded" | "already_recorded" | "not_applicable" | { refused: "owner_not_agent" };
  j2: "scheduled" | "already_scheduled" | "not_applicable" | { refused: string };
  /** Only for an answer that carries procedures: the pending trials it opens. */
  trials?: "recorded" | "already_recorded" | { refused: "owner_not_agent" };
}>;

const RETRIES = 3;
/** Deterministic id from the effect, so a repeated attempt names the same timer. A timer already stored under the key is returned as it is. */
const timerIdFor = (effectId: string) => {
  const hex = createHash("sha256").update(`j2-timer:${effectId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
/** Deterministic id of the n-th procedure of a confirmed reply: a repeated attempt names the same trial. */
export const trialIdFor = (effectId: string, index: number) => `trial:${effectId}:${index + 1}`;
async function cas<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await step(); } catch (error) { if (!(error instanceof CaseVersionStaleError) || attempt >= RETRIES) throw error; }
  }
}

/**
 * `options.tx` is the receipt's single transaction (see `case-effect-driver.ts`): the three writers run inside it, in this order, with NO retry of their own (a stale
 * version throws and rolls the caller's whole transaction back; a retry in another transaction would be a partial commit). Without it the behaviour is the historical one:
 * each step in its own transaction with a bounded compare-and-set retry. Returned refusals ("already recorded", owner, J2 refusal) are the caller's to judge.
 */
export async function recordConfirmedCaseReply(input: ConfirmedReply, options: Readonly<{ tx?: CaseTx }> = {}): Promise<ConfirmedReplyOutcome> {
  const { proposal } = input, { tx } = options;
  const step = <T>(run: () => Promise<T>): Promise<T> => tx ? run() : cas(run);
  const sentAt = input.sentAt.toISOString();
  // 1. The outbound mail enters the journal. It is not a customer input, a human action or an owner change: it stales no admission and cancels no timer.
  const appended = await step(() => appendCaseEvent({
    caseId: proposal.caseId, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: `outbound:${input.gmailMessageId}`,
    sourceRef: { type: "email", id: input.gmailMessageId }, occurredAt: sentAt,
    detail: { effectId: input.effectId, purpose: proposal.purpose, triggerEventId: proposal.triggerEventId, gmailThreadId: input.gmailThreadId,
      ...(proposal.purpose === "answer" && proposal.procedures?.length === 1 ? { trialRecipient: trialRecipientBinding(proposal.caseId, proposal.recipient) } : {}) },
  }, tx));
  const event = appended.appended ? "appended" : "already_recorded";
  if (proposal.purpose !== "question") {
    const procedures = proposal.purpose === "answer" ? proposal.procedures ?? [] : [];
    if (!procedures.length) return { event, question: "not_applicable", j2: "not_applicable" };
    // 2 (answer). The sealed procedures become pending trials, dated from the mail that really left. The id comes from the effect, so a replay finds the same trial and adds none.
    const trials = await step(async () => {
      const current = await readCase(proposal.caseId, tx);
      if (!current) throw new Error("SAV_CASE_EFFECT_CASE_MISSING");
      // A person took the case after the send left: the mail stays in the journal, the agent records nothing more on the case.
      if (current.owner !== "agent") return { refused: "owner_not_agent" } as const;
      const known = new Set(current.body.trials.map(trial => trial.id));
      const opened = procedures.map((row, index) => ({ id: trialIdFor(input.effectId, index), requestId: row.requestId, procedure: { ...row.procedure }, askedAt: sentAt, outcome: "pending" as const, resultAt: null }))
        .filter(trial => !known.has(trial.id));
      if (!opened.length) return "already_recorded" as const;
      await updateCaseRecord({ caseId: current.caseId, expectedVersion: current.version, actor: { type: "agent" }, body: { ...current.body, trials: [...current.body.trials, ...opened] } }, tx);
      return "recorded" as const;
    });
    return { event, question: "not_applicable", j2: "not_applicable", trials };
  }
  if (!proposal.question) throw new Error("SAV_CASE_EFFECT_QUESTION_MISSING");
  const question = proposal.question;

  // 2. The question is recorded on the case against the effect that sent it (the J2 timer needs it).
  const questionState = await step(async () => {
    const current = await readCase(proposal.caseId, tx);
    if (!current) throw new Error("SAV_CASE_EFFECT_CASE_MISSING");
    // A person took the case after the send left: the mail is real and stays in the journal, but the agent writes nothing more and no J2 follows.
    if (current.owner !== "agent") return { refused: "owner_not_agent" } as const;
    if (current.body.questions.some(candidate => candidate.askedInEffect === input.effectId)) return "already_recorded" as const;
    await updateCaseRecord({
      caseId: current.caseId, expectedVersion: current.version, actor: { type: "agent" },
      body: { ...current.body, questions: [...current.body.questions, { id: question.id, text: question.text, factKeys: [...question.factKeys], askedAt: sentAt, askedInEffect: input.effectId }] },
    }, tx);
    return "recorded" as const;
  });

  if (typeof questionState === "object") return { event, question: questionState, j2: { refused: "owner_not_agent" } };

  // 3. Then, and only then, the J2 timer for that confirmed question: one timer per question effect.
  const scheduled = await step(async () => {
    const current = await readCase(proposal.caseId, tx);
    if (!current) throw new Error("SAV_CASE_EFFECT_CASE_MISSING");
    return scheduleJ2ForConfirmedQuestion({
      caseId: current.caseId, expectedVersion: current.version, currentPolicyRevision: input.currentPolicyRevision,
      questionEffectId: input.effectId, timerId: timerIdFor(input.effectId), sentAt: input.sentAt, answeredVersion: proposal.caseVersion,
    }, tx);
  });
  const j2 = scheduled.scheduled ? "scheduled" as const : scheduled.reason === "already_exists" ? "already_scheduled" as const : { refused: scheduled.reason };
  return { event, question: questionState, j2 };
}
