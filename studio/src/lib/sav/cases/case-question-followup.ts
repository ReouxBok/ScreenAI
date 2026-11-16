import { createHash } from "node:crypto";
import type { CaseBody, CaseEvent } from "./case-types";
import type { CaseDecisionProposal } from "./decision-contract";

/** A batch belongs to one confirmed mail, regardless of how many of its questions are answered. */
export function hasMultiQuestionWait(body: Pick<CaseBody, "questions" | "waiting">): boolean {
  return body.waiting?.kind === "customer" && body.questions.some(question =>
    question.askedAt === body.waiting?.since && body.questions.filter(other => other.askedInEffect === question.askedInEffect).length > 1 && !question.answeredBy);
}

/** Only validated customer facts after the sent question can close it. No whole-mail acknowledgement inference. */
export function reconcileCaseQuestionAnswers(body: CaseBody, proposal: CaseDecisionProposal, events: readonly CaseEvent[]): CaseBody {
  const batches = new Set(body.questions.filter(question => body.questions.filter(other => other.askedInEffect === question.askedInEffect).length > 1).map(question => question.askedInEffect));
  if (!batches.size) return body;
  const facts = proposal.understanding.newFacts.flatMap(fact => {
    const event = events.find(event => event.direction === "customer_inbound" && event.sourceRef.type === fact.source.type && event.sourceRef.id === fact.source.id);
    return event && fact.kind === "customer_statement" && fact.key ? [{ id: fact.id, key: fact.key, text: fact.statement, kind: fact.kind, source: fact.source, at: event.occurredAt }] : [];
  });
  // Model-local ids (often "f1") may recur on another mail. Preserve earlier facts and
  // give a conflicting new fact its own stable identity rather than dropping the answer.
  const distinct = facts.map(fact => {
    const collision = [...body.facts, ...facts].some(known => known.id === fact.id && (known.key !== fact.key || known.source.type !== fact.source.type || known.source.id !== fact.source.id));
    return collision ? { ...fact, id: `answer_${createHash("sha256").update(JSON.stringify([fact.id, fact.key, fact.source])).digest("hex").slice(0, 24)}` } : fact;
  });
  const all = [...body.facts, ...distinct.filter(fact => !body.facts.some(known => known.id === fact.id))];
  const questions = body.questions.map(question => {
    if (question.answeredBy || !batches.has(question.askedInEffect) || !question.factKeys.length) return question;
    const answers = question.factKeys.map(key => all.find(fact => fact.key === key && fact.kind === "customer_statement" && Date.parse(fact.at) > Date.parse(question.askedAt)));
    return answers.every(Boolean) ? { ...question, answeredBy: answers.filter(answer => answer !== undefined).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)!.source } : question;
  });
  const waitEnded = hasMultiQuestionWait(body) && !hasMultiQuestionWait({ ...body, questions });
  return { ...body, facts: all, questions, ...(waitEnded ? { waiting: null } : {}) };
}
