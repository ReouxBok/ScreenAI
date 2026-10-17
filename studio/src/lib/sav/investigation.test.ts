import { describe, expect, it } from "vitest";
import { addSavInvestigationQuestions, buildSavInvestigationReply } from "./investigation";
import { understandingFixture } from "../../../test/sav-understanding-fixtures";
import type { SavRequestPlan } from "./request-planner";
const plan = (requestId = "request-1"): SavRequestPlan => ({ requestId, domain: "general", mode: "knowledge_gap", card: null, missingFacts: [], nextCheck: null, repeatAllowed: false, limits: [] });
describe("controlled investigation drafts", () => {
  it("asks bounded product-independent questions without any invented solution", () => {
    const u = understandingFixture(), plans = addSavInvestigationQuestions(u, [plan()]);
    u.missingInformation = plans.flatMap(p => p.missingFacts.map(f => ({ id: f.id, key: f.key, text: f.question, requestIds: [p.requestId] })));
    const reply = buildSavInvestigationReply(u, plans);
    expect(reply.coverage[0].kind).toBe("clarification"); expect(reply.coverage[0].sourceIds).toEqual([]);
    expect(reply.replyDraft).toContain("Quelle version"); expect(reply.replyDraft).not.toMatch(/humain|équipe|redémarr|résolu/i);
    expect(plans[0].missingFacts.length).toBeLessThanOrEqual(2);
  });
  it.each(["version", "app_version", "product_version"])("does not ask known %s or repeat a prior control", key => {
    const u = understandingFixture(); u.knownFacts = [{ id: "version", key, text: "Version 2", evidenceIds: ["evidence-1"], requestIds: ["request-1"] }];
    u.attemptedSteps = [{ id: "restart", key: "restart", text: "Redémarrage déjà tenté", evidenceIds: ["evidence-1"], requestIds: ["request-1"] }];
    const plans = addSavInvestigationQuestions(u, [plan()]);
    expect(JSON.stringify(plans[0].missingFacts)).not.toContain("version du produit");
    expect(plans[0].nextCheck).toBeNull();
  });
  it("keeps an approved solution and its versioned control intact", () => {
    const u = understandingFixture(), p = { ...plan(), mode: "solution" as const, nextCheck: { id: "check", instruction: "Instruction contrôlée", expectedResult: "Résultat", sourceId: "card" } };
    expect(addSavInvestigationQuestions(u, [p])).toEqual([p]);
  });
  it.each(["financial_operation", "cancellation", "legal"] as const)("does not bypass %s restrictions", nature => {
    const u = understandingFixture(); u.requests[0].nature = nature;
    expect(addSavInvestigationQuestions(u, [plan()])).toEqual([plan()]);
    expect(() => buildSavInvestigationReply(u, [plan()])).toThrow("SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING");
  });
  it("keeps all requests but never exceeds three new questions", () => {
    const u = understandingFixture(); u.requests.push({ ...u.requests[0], id: "second", summary: "Une autre demande" }, { ...u.requests[0], id: "third", summary: "Encore une demande" });
    const plans = addSavInvestigationQuestions(u, u.requests.map(r => plan(r.id)));
    expect(plans.reduce((n, p) => n + p.missingFacts.length, 0)).toBeLessThanOrEqual(3);
    expect(plans.map(p => p.requestId)).toEqual(u.requests.map(r => r.id));
  });
});
