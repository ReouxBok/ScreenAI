import { describe, expect, it } from "vitest";
import type { SavRetrievalCandidate } from "../../request-retrieval";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION, type CaseBody, type CaseEvent, type CaseSnapshot } from "../case-types";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import {
  isSmartCaseRequest, smartCaseDecisionProvider, smartMemoryFromCase, smartProposalFromTurn, smartTurnInputFromCase, smartTurnUsage,
} from "./smart-case-provider";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, type SmartScript } from "./smart-test-doubles";
import type { SmartTurnResult } from "./smart-agent";
import { caseDecisionProposalSchema } from "../decision-contract";

// Fictional data only: no database, no key, no network.
const CARD = { id: "fiche-connexion", contentVersionId: "v3", title: "Se connecter", source: "fixture", verifiedAt: "2026-11-10T00:00:00Z", semanticScore: null,
  content: "Pour vous connecter, utilisez l'adresse e-mail de votre invitation. Si le code n'arrive pas, vérifiez le dossier des indésirables.", resolution: { steps: ["Ouvrir la page"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as SavRetrievalCandidate;
const snapshot = (admission: unknown = { admission: "smart_support" }, body: Partial<CaseBody> = {}) => ({
  contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "t-1", threadIds: ["th-1"], version: 4, owner: "agent", phase: "queued", sensitivity: "none",
  createdAt: "2026-11-21T07:00:00Z", updatedAt: "2026-11-21T07:00:00Z", admissionInputVersion: 1, admission,
  body: { ...emptyCaseBody(), openRequests: [{ id: "r1", family: "other", status: "open", openedAt: "2026-11-21T07:00:00Z" }], ...body },
}) as unknown as CaseSnapshot;
const mail = (id: string, version: number): CaseEvent => ({ id, caseId: "case-1", kind: "inbound_confirmed", dedupeKey: `inbound:${id}`, caseVersion: version, direction: "customer_inbound",
  occurredAt: "2026-11-21T07:00:00Z", sourceRef: { type: "email", id }, detail: null, createdAt: "2026-11-21T07:00:00Z" });
const requestOf = (patch: Partial<CaseInvestigationModelRequest> = {}): CaseInvestigationModelRequest => ({
  purpose: "decision", caseId: "case-1", caseVersion: 4, inputKey: "in:e2", call: 1, subjectKey: "s", callKey: "s:call1", caseBudgetKey: "sav-case:case-1",
  snapshot: snapshot(), events: [mail("m1", 1), mail("m2", 3)], knowledge: [CARD], coverage: null, feedback: [], closure: [],
  customerContext: { latestMessage: { at: "2026-11-21T07:00:00Z", from: "customer", text: "Le code n'arrive pas.", truncated: false, subject: "Connexion", instructionLikeText: false },
    thread: [{ at: "2026-11-20T07:00:00Z", from: "customer", text: "Je n'arrive pas à me connecter.", truncated: false }] } as unknown as CaseInvestigationModelRequest["customerContext"],
  ...patch,
});
const provider = (script: SmartScript) => {
  const brain = smartScriptedModel(script);
  return { brain, run: smartCaseDecisionProvider({ model: brain.model, env: () => ({ SAV_V2_ENTRY_SMART: "on" }), now: () => new Date("2026-11-21T08:00:00Z"), maxInputBytes: () => 100_000 }) };
};
const turn = (patch: Partial<SmartTurnResult>): SmartTurnResult => ({ outcome: "reply", reasons: [], sensitiveStop: null, reading: null, decision: null, replyWithFooter: null,
  checks: { first: null, second: null }, verdicts: { first: null, second: null }, corrected: false, calls: [], sources: [], missing: [], steps: [], teamNote: null, teamNoteText: null,
  memory: { revision: "m", exchanges: 1, progress: [], needs: [], facts: [], hypotheses: [], trials: [], questions: [] }, progressed: true, ...patch } as SmartTurnResult);

describe("SAV-123 smart-case-provider", () => {
  it("only SAV_V2_ENTRY_SMART=on AND a smart_support admission selects the brain", () => {
    expect(isSmartCaseRequest(requestOf(), { SAV_V2_ENTRY_SMART: "on" })).toBe(true);
    for (const value of [undefined, "", "ON", "true", "shadow"]) expect(isSmartCaseRequest(requestOf(), { SAV_V2_ENTRY_SMART: value })).toBe(false);
    expect(isSmartCaseRequest(requestOf({ snapshot: snapshot({ policyRevision: "p" }) }), { SAV_V2_ENTRY_SMART: "on" })).toBe(false);
    expect(isSmartCaseRequest(requestOf({ snapshot: snapshot(null) }), { SAV_V2_ENTRY_SMART: "on" })).toBe(false);
  });

  it("builds the turn from the latest mail, the thread and the memory derived from the case (no stored smart memory)", () => {
    const snap = snapshot(undefined, {
      questions: [{ id: "q1", text: "Quel message ?", factKeys: [], askedAt: "2026-11-20T08:00:00Z", askedInEffect: "x", answeredBy: { type: "email", id: "m2" } }],
      trials: [{ id: "tr1", requestId: "r1", procedure: { knowledgeId: "fiche-connexion", contentVersionId: "v3" }, askedAt: "2026-11-20T08:00:00Z", outcome: "failed", resultAt: "2026-11-21T07:00:00Z" }],
    } as unknown as Partial<CaseBody>);
    const input = smartTurnInputFromCase(requestOf({ snapshot: snap }))!;
    expect(input).toMatchObject({ subject: "Connexion", body: "Le code n'arrive pas.", thread: [{ from: "customer", text: "Je n'arrive pas à me connecter." }] });
    expect(input.memory).toMatchObject({ exchanges: 1, questions: [{ text: "Quel message ?", answered: true }], trials: [{ id: "tr1", cardId: "fiche-connexion", result: "failed" }] });
    expect(smartMemoryFromCase(snapshot(), [mail("m1", 1)]).exchanges).toBe(0);
    expect(smartTurnInputFromCase(requestOf({ customerContext: undefined }))).toBeNull();
  });

  it("the brain reads the circuit's cards only (no index, no embedding) and a reply becomes an answer citing them", async () => {
    const { brain, run } = provider({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } });
    const out = await run(requestOf());
    expect(out.result).toMatchObject({ status: "ok", output: { caseVersion: 4, nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ knowledge: { knowledgeId: "fiche-connexion", contentVersionId: "v3" } }] },
      reply: { citations: [{ knowledgeId: "fiche-connexion", contentVersionId: "v3" }], accountAdvice: "none" } } });
    expect(out.usage).toEqual({ inputTokens: 3_000, outputTokens: 600 });
    const decidePayload = brain.calls.find(call => call.kind === "decide")!.payload as { cards: Array<{ cardId: string }> };
    expect(decidePayload.cards.map(row => row.cardId)).toEqual(["fiche-connexion"]);
  });

  it("SAV-122 (contract v5): a fact with NO sentence still gives a valid answer; the step text is internal (excerpt), the reply is the model's, untouched", async () => {
    const decision = smartGoodDecision({ facts: [{ ...smartGoodDecision().facts[0], sentence: undefined }] });
    const { run } = provider({ understand: { output: smartReading() }, decide: { output: decision }, verify: { output: SMART_CONFORME } });
    const out = await run(requestOf());
    expect(out.result.status).toBe("ok");
    const proposal = (out.result as { output: unknown }).output;
    expect(caseDecisionProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal).toMatchObject({ reply: { text: decision.reply }, nextAction: { kind: "answer", steps: [{ text: "utilisez l'adresse e-mail de votre invitation", knowledge: { knowledgeId: "fiche-connexion" } }] } });
    // No sentence and no excerpt (built directly): the card's title, never an empty step.
    const bare = smartProposalFromTurn(turn({ outcome: "reply", decision: { ...(decision as unknown as NonNullable<SmartTurnResult["decision"]>),
      facts: [{ sentence: "", needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: "fiche-connexion", version: "v3", toolCallId: null, excerpt: null }] } as never }), requestOf());
    expect(caseDecisionProposalSchema.safeParse(bare).success).toBe(true);
    expect(bare).toMatchObject({ reply: { text: decision.reply }, nextAction: { steps: [{ text: "Se connecter" }] } });
  });

  it("a refusal goes to the brain once (decide payload); the second refusal hands over with NO brain call", async () => {
    const feedback = [{ code: "knowledge_not_valid" as const, label: "Fiche non valide.", path: "nextAction.steps.0.knowledge", kind: "missing_information" as const }];
    const first = provider({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } });
    await first.run(requestOf({ call: 2, feedback }));
    expect((first.brain.calls.find(call => call.kind === "decide")!.payload as { serverRefusals: unknown }).serverRefusals).toEqual([{ code: "knowledge_not_valid", label: "Fiche non valide." }]);
    expect((first.brain.calls.find(call => call.kind === "understand")!.payload as Record<string, unknown>).serverRefusals).toBeUndefined();
    const second = provider({});
    const out = await second.run(requestOf({ call: 3, feedback }));
    expect(second.brain.calls).toEqual([]);
    expect(out).toMatchObject({ result: { status: "ok", output: { nextAction: { kind: "handoff", reason: "repeated_failure", requestIds: ["r1"] } } }, usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it("a resolution check is never the brain's, and a technical end is a provider failure (never a reply)", async () => {
    const check = provider({});
    expect((await check.run(requestOf({ purpose: "resolution_check" }))).result).toMatchObject({ status: "failed", uncertain: false });
    expect(check.brain.calls).toEqual([]);
    const failing = provider({ understand: { fail: "http_503", uncertain: true } });
    expect((await failing.run(requestOf())).result).toMatchObject({ status: "failed", uncertain: true });
    expect(smartProposalFromTurn(turn({ outcome: "interrupted" }), requestOf())).toBeNull();
  });

  it("translation: handed need, reply without a circuit card and an unknown outcome all go to the team with a note", () => {
    const req = requestOf();
    const decision = smartGoodDecision() as unknown as NonNullable<SmartTurnResult["decision"]>;
    expect(smartProposalFromTurn(turn({ decision: { ...decision, coverage: [{ needId: "n1", status: "handed" }] } }), req)!.nextAction.kind).toBe("handoff");
    const unsourced = smartProposalFromTurn(turn({ decision: { ...decision, facts: [{ ...decision.facts[0]!, cardId: "autre", version: "v1" }] } }), req)!;
    expect(unsourced.nextAction).toMatchObject({ kind: "handoff", reason: "knowledge_missing" });
    expect(smartProposalFromTurn(turn({ outcome: "bizarre" as never }), req)!.nextAction).toMatchObject({ kind: "handoff", reason: "diagnosis_out_of_tools" });
    const note = { raison: "wants_human" as const, besoin: "Parler à quelqu'un", compris: "Veut un humain", verifie: [{ fait: "Compte actif", source: "fiche x" }], essaye: [], hypotheses: [],
      prochaineVerification: "Rappeler le client", ditAuClient: null };
    expect(smartProposalFromTurn(turn({ outcome: "handoff", teamNote: note }), req)!.nextAction).toMatchObject({ kind: "handoff", reason: "explicit_human_request",
      report: { need: "Parler à quelqu'un", observed: "Veut un humain", hypotheses: ["Vérifié : Compte actif (source : fiche x)"], expectedIntervention: "Rappeler le client" } });
  });

  it("usage: the sum of a turn's calls, or null when one sent call has no complete usage (the reservation stays)", () => {
    const call = (usage: { inputTokens: number; outputTokens: number } | null, sent = true) => ({ kind: "decide" as const, status: "ok" as const, problem: null, inputBytes: 1, uncertain: false, sent, usage });
    expect(smartTurnUsage({ calls: [call({ inputTokens: 1, outputTokens: 2 }), call({ inputTokens: 3, outputTokens: 4 }), call(null, false)] })).toEqual({ inputTokens: 4, outputTokens: 6 });
    expect(smartTurnUsage({ calls: [call({ inputTokens: 1, outputTokens: 2 }), call(null)] })).toBeNull();
  });
});
