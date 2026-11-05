import { describe, expect, it } from "vitest";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import type { CaseDecisionProposal } from "./decision-contract";
import { caseAnswerProcedures } from "./investigation-intent";
import { trialsAfterResolution } from "./case-resolution";

type AnswerAction = Extract<CaseDecisionProposal["nextAction"], { kind: "answer" }>;
type ConfirmAction = Extract<CaseDecisionProposal["nextAction"], { kind: "confirm_resolution" }>;
const A = { knowledgeId: "a", contentVersionId: "a1" }, B = { knowledgeId: "b", contentVersionId: "b1" };
const answer = (requestIds: string[], ...cards: (typeof A)[]): AnswerAction => ({ kind: "answer", requestIds, expectedResult: "Résultat.", steps: cards.map(knowledge => ({ text: "Étape.", knowledge, newFactIds: [] })) });
const BASE: CaseReplyProposal = { caseId: "00000000-0000-4000-8000-000000000001", caseVersion: 2, triggerEventId: "inbound:gm-1", inboundMessageId: "00000000-0000-4000-8000-000000000002", purpose: "answer", recipient: "customer@example.invalid", subject: "Sujet", text: "Texte." };

describe("the procedures sealed in an answer", () => {
  it("one per request and exact card version, in step order; a repeated card counts once", () => {
    expect(caseAnswerProcedures(answer(["r1"], A, B, A), null)).toEqual([{ requestId: "r1", procedure: A }, { requestId: "r1", procedure: B }]);
  });
  it("with the recorded coverage, a card is only tried for the request it was retrieved for", () => {
    expect(caseAnswerProcedures(answer(["r1", "r2"], A, B), [{ requestId: "r1", knowledge: [A] }, { requestId: "r2", knowledge: [B] }])).toEqual([{ requestId: "r1", procedure: A }, { requestId: "r2", procedure: B }]);
    expect(caseAnswerProcedures(answer(["r1"], { knowledgeId: "a", contentVersionId: "other" }), [{ requestId: "r1", knowledge: [A] }])).toEqual([]);
  });
  it("are part of what is approved, and leave the hash of a reply without procedures untouched", () => {
    const plain = caseReplyPayloadHash(BASE);
    expect(caseReplyPayloadHash({ ...BASE, procedures: [] })).toBe(plain);
    const one = caseReplyPayloadHash({ ...BASE, procedures: [{ requestId: "r1", procedure: A }] });
    expect(one).not.toBe(plain);
    expect(caseReplyPayloadHash({ ...BASE, procedures: [{ requestId: "r1", procedure: B }] })).not.toBe(one);
  });
});

describe("what the closing proof says about the trials", () => {
  const pending = (id: string, requestId: string) => ({ id, requestId, procedure: A, askedAt: "2026-11-04T09:00:00.000Z", outcome: "pending" as const, resultAt: null });
  const source = { type: "email" as const, id: "gm-2" };
  const action = (trialId: string | null): ConfirmAction => ({ kind: "confirm_resolution", requestIds: ["r1"], evidence: [{ requestId: "r1", source, trialId, quote: "ça remarche" }] });
  const events = [{ direction: "customer_inbound" as const, sourceRef: source, occurredAt: "2026-11-04T10:00:00.000Z" }];
  const LEARNT = "2026-11-04T11:00:00.000Z";

  it("the cited trial succeeded on the customer's words and the date of their mail; another pending one of that request is unknown; another request's is untouched", () => {
    expect(trialsAfterResolution([pending("t1", "r1"), pending("t2", "r1"), pending("t3", "r2")], action("t1"), events, LEARNT)).toEqual([
      { ...pending("t1", "r1"), outcome: "succeeded", resultAt: "2026-11-04T10:00:00.000Z", result: { text: "ça remarche", source } },
      { ...pending("t2", "r1"), outcome: "unknown" },
      pending("t3", "r2"),
    ]);
  });
  it("a spontaneous resolution proves no trial, and a failed trial stays failed", () => {
    const failed = { ...pending("t2", "r1"), outcome: "failed" as const, resultAt: "2026-11-04T09:30:00.000Z" };
    expect(trialsAfterResolution([pending("t1", "r1"), failed], action(null), events, LEARNT)).toEqual([{ ...pending("t1", "r1"), outcome: "unknown" }, failed]);
  });
  it("a source with no event found is dated when the proof was recorded", () => {
    expect(trialsAfterResolution([pending("t1", "r1")], action("t1"), [], LEARNT)[0]).toMatchObject({ outcome: "succeeded", resultAt: LEARNT });
  });
});
