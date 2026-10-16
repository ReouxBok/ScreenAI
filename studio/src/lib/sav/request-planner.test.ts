import { describe, expect, it } from "vitest";
import { savSupportDeliveryProjectionSchema, savDeliveryGroups, serializeSavDeliveryGroups } from "@/lib/knowledge/support-delivery";
import { planSavRequests, assembleSavPlannedReply } from "./request-planner";
import { defaultSavPlaybook } from "./playbook-contract";
import { savSemanticPlan, type SavUnderstandingV1 } from "./understanding";
import type { SavRequestRetrievalResult } from "./request-retrieval";
const playbook = { versionId: "book-1", version: 1, document: defaultSavPlaybook };
function understanding(patch: Partial<SavUnderstandingV1> = {}): SavUnderstandingV1 {
  return { version: 1, status: "qualified", language: "fr", primaryRequestId: "r1",
    requests: [{ id: "r1", summary: "Ma page SEO ne s’indexe pas", nature: "technical", financialScope: "none", product: "SEO", feature: null, evidenceIds: ["e1"] }],
    knownFacts: [{ id: "f1", key: "url", text: "https://example.invalid", evidenceIds: ["e1"] }], attemptedSteps: [], missingInformation: [],
    evidence: [{ id: "e1", source: "current_message", sourceId: "current_body", excerpt: "Ma page SEO" }], uncertainties: [],
    trace: { contractRevision: "fixture", promptRevision: "fixture", model: null, inputHash: "fixture", codeRevision: null, durationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, errorCode: null }, ...patch };
}
function retrieval(): SavRequestRetrievalResult {
  return { contractRevision: "fixture", revision: "kb-1", alerts: [], metrics: { attempts: 1, queryCount: 1, embeddingBatchesUpperBound: 1, serializedBytes: 1000, contextTextTokensUpperBound: 1000 },
    requests: [{ requestId: "r1", status: "candidates", candidateKeys: ["card:v1"], limitations: [] }],
    sources: [{ id: "card", contentVersionId: "v1", key: "card:v1", requestIds: ["r1"], title: "Diagnostic SEO", source: "fixture", content: "Ouvrir le diagnostic fictif. Lire le résultat fictif.", verifiedAt: new Date().toISOString(), grounding: "unassessed", signals: [{ requestId: "r1", semanticScore: .9, lexicalScore: .8, rankingScore: .9 }],
      resolution: { steps: ["Ouvrir le diagnostic fictif.", "Lire le résultat fictif."], diagnostic: { requiredFacts: [{ key: "page_url", label: "URL", question: "Quelle est l’URL ?", requiredFor: ["open"] }], knownCauses: [],
        checks: [{ id: "open", evidenceStepId: "open", instruction: "Ouvrir le diagnostic fictif.", expectedResult: "", prerequisites: ["page_url"], ifExpected: "read", ifNot: null }, { id: "read", evidenceStepId: "read", instruction: "Lire le résultat fictif.", expectedResult: "", prerequisites: [], ifExpected: null, ifNot: null }] } } }], };
}
describe("SAV-68 server request plans", () => {
  it("requires the fact for the current request rather than reusing another request’s URL", () => {
    const u = understanding(); u.requests.push({ ...u.requests[0], id: "r2", summary: "Une autre page ne s’indexe pas" });
    u.knownFacts[0].requestIds = ["r1"];
    const r = retrieval(); r.requests.push({ ...r.requests[0], requestId: "r2" }); r.sources[0].requestIds.push("r2");
    const plans = planSavRequests(u, r, playbook);
    expect(plans[0].nextCheck?.id).toBe("open");
    expect(plans[1].nextCheck).toBeNull();
    expect(plans[1].missingFacts[0].key).toBe("page_url");
    delete u.knownFacts[0].requestIds;
    const ambiguous = planSavRequests(u, r, playbook)[1];
    expect(ambiguous.nextCheck).toBeNull();
    expect(ambiguous.missingFacts).toEqual([]);
    expect(ambiguous.limits).toContain("fact_scope_requires_review");
  });
  it("keeps checks of distinct cards independent even when their local IDs match", () => {
    const u = understanding({ attemptedSteps: [{ id: "old", key: "open", checkId: "open", checkCardId: "other-card", checkVersionId: "other-v1", outcome: "expected", text: "Autre contrôle effectué", evidenceIds: ["e1"] }] });
    expect(planSavRequests(u, retrieval(), playbook)[0].nextCheck?.id).toBe("open");
  });
  it("never chooses a branch from a legacy key without a validated check reference", () => {
    const u = understanding({ attemptedSteps: [{ id: "old", key: "open", checkId: null, checkVersionId: "v1", outcome: "expected", text: "Ancienne consigne sortante", evidenceIds: ["e1"] }] });
    expect(planSavRequests(u, retrieval(), playbook)[0].nextCheck).toBeNull();
  });

  it("never includes free model advice outside the selected check, even with the same card ID", () => {
    const u = understanding();
    const plans = planSavRequests(u, retrieval(), playbook);
    const [result] = assembleSavPlannedReply(u, [{ requestId: "r1", text: "Réinitialisez aussi l’intégration.", kind: "solution", sourceIds: ["card"], missingInformationIds: [], repeatedAttemptIds: [], repeatJustification: "" }], plans);
    expect(result.text).not.toContain("Réinitialisez");
    expect(result.text).toContain(u.requests[0].summary);
    expect(result.text).toContain("Ouvrir le diagnostic fictif.");
    expect(result.text).not.toContain("Lire le résultat fictif.");
  });
  it("uses an already known alias without asking the URL again and chooses the first sourced check", () => {
    const [plan] = planSavRequests(understanding(), retrieval(), playbook);
    expect(plan.mode).toBe("solution"); expect(plan.missingFacts).toEqual([]); expect(plan.nextCheck?.id).toBe("open");
  });
  it("asks only reviewed missing questions and blocks dependent steps", () => {
    const [plan] = planSavRequests(understanding({ knownFacts: [] }), retrieval(), playbook);
    expect(plan.mode).toBe("clarification"); expect(plan.nextCheck).toBeNull(); expect(plan.missingFacts[0]).toMatchObject({ key: "page_url", origin: "card:card:v1" });
  });
  it("advances on an evidenced successful check but never infers the result of a failed or unknown attempt", () => {
    const attempted = { id: "a1", key: "open", checkId: "open", checkVersionId: "v1", text: "Contrôle déjà exécuté", evidenceIds: ["e1"] };
    expect(planSavRequests(understanding({ attemptedSteps: [{ ...attempted, outcome: "expected" }] }), retrieval(), playbook)[0].nextCheck?.id).toBe("read");
    for (const outcome of ["not_expected", "unknown"] as const) expect(planSavRequests(understanding({ attemptedSteps: [{ ...attempted, outcome }] }), retrieval(), playbook)[0].nextCheck).toBeNull();
  });
  it("permits a safe clarification without opening a sensitive policy", () => {
    const u = understanding({ status: "needs_clarification", knownFacts: [], uncertainties: [{ code: "ambiguous_intent", requestIds: ["r1"] }] });
    expect(savSemanticPlan(u).replyPolicy).toBe("compose"); expect(planSavRequests(u, retrieval(), playbook)[0].mode).toBe("clarification");
    for (const nature of ["financial_operation", "cancellation", "legal"] as const) {
      const sensitive = { ...u, requests: [{ ...u.requests[0], nature }] };
      expect(savSemanticPlan(sensitive).replyPolicy).toBe("none"); expect(planSavRequests(sensitive, retrieval(), playbook)[0].mode).toBe("reserved");
    }
  });
  it("separates provider failure, knowledge gaps, expiry and per-request coverage", () => {
    const r = retrieval(); r.requests[0].status = "search_unavailable";
    expect(planSavRequests(understanding(), r, playbook)[0].mode).toBe("provider_failure");
    const expired = retrieval(); expired.sources[0].resolution!.validUntil = "2020-01-01";
    expect(planSavRequests(understanding(), expired, playbook)[0].mode).toBe("knowledge_gap");
    const u = understanding(); u.requests.push({ ...u.requests[0], id: "r2", summary: "Une seconde demande" });
    const plans = planSavRequests(u, retrieval(), playbook); expect(plans.map(p => p.requestId)).toEqual(["r1", "r2"]); expect(plans[1].nextCheck).toBeNull();
  });
  it("assembles the reviewed question itself and rejects a free-form model question", () => {
    const u = understanding({ knownFacts: [] }); const plans = planSavRequests(u, retrieval(), playbook);
    const part = { requestId: "r1", text: "Vous signalez un problème d’indexation.", kind: "acknowledgement" as const, sourceIds: [], missingInformationIds: [], repeatedAttemptIds: [], repeatJustification: "" };
    const [result] = assembleSavPlannedReply(u, [part], plans); expect(result.text).toContain("Quelle est l’URL ?"); expect(result.kind).toBe("clarification");
    expect(() => assembleSavPlannedReply(u, [{ ...part, text: "Quel est votre mot de passe ?" }], plans)).toThrow("SAV_REPLY_OUTSIDE_REQUEST_PLAN");
  });
});

describe("SAV-68 thirteen synthetic acceptance scenarios (no model call)", () => {
  it("SEO first turn uses the supplied URL and next sourced control", () => {
    const plan = planSavRequests(understanding(), retrieval(), playbook)[0]; expect(plan.nextCheck?.id).toBe("open"); expect(plan.missingFacts.some(f => f.key === "page_url")).toBe(false);
  });
  it("SEO second turn uses the evidenced result instead of repeating the previous control", () => {
    const u = understanding({ attemptedSteps: [{ id: "a", key: "open", checkId: "open", checkVersionId: "v1", outcome: "expected", text: "Contrôle déjà réalisé", evidenceIds: ["e1"] }] });
    expect(planSavRequests(u, retrieval(), playbook)[0].nextCheck?.id).toBe("read");
  });
  it("integration asks only the validated missing connection mode", () => {
    const u = understanding(); u.requests[0].nature = "integration"; u.requests[0].summary = "Le connecteur Alpha ne se connecte plus"; u.knownFacts = [{ id: "f", key: "integration_name", text: "Alpha", evidenceIds: ["e1"] }];
    const r = retrieval(); r.sources = []; r.requests[0].candidateKeys = [];
    const book = { ...playbook, document: { ...defaultSavPlaybook, facts: defaultSavPlaybook.facts.map(f => f.key === "connection_mode" ? { ...f, question: "Quel mode de connexion utilisez-vous ?" } : f) } };
    const plan = planSavRequests(u, r, book)[0]; expect(plan.missingFacts.map(f => f.key)).toEqual(["connection_mode"]); expect(plan.nextCheck).toBeNull();
  });
  it("access preserves the supplied account email and reports an unread attachment", () => {
    const u = understanding({ knownFacts: [{ id: "f", key: "registration_email", text: "person@example.invalid", evidenceIds: ["e1"] }], uncertainties: [{ code: "unread_attachment", requestIds: ["r1"] }] }); u.requests[0].nature = "account";
    const r = retrieval(); r.sources = []; r.requests[0].candidateKeys = [];
    const book = { ...playbook, document: { ...defaultSavPlaybook, facts: defaultSavPlaybook.facts.map(f => f.key === "error_message" ? { ...f, question: "Quel message d’erreur apparaît ?" } : f) } };
    const plan = planSavRequests(u, r, book)[0]; expect(plan.limits).toContain("unread_attachment"); expect(plan.missingFacts.map(f => f.key)).toEqual(["error_message"]);
  });
  it("incidental telephone credits keep technical policy", () => {
    const u = understanding(); u.requests[0].summary = "Les appels ne sonnent plus malgré les crédits disponibles"; expect(savSemanticPlan(u).replyPolicy).toBe("compose"); expect(savSemanticPlan(u).category).toBe("technical");
  });
  it("three current requests each receive an explicit plan", () => {
    const u = understanding(); u.requests.push({ ...u.requests[0], id: "r2" }, { ...u.requests[0], id: "r3" }); const plans = planSavRequests(u, retrieval(), playbook);
    expect(plans).toHaveLength(3); expect(plans[1].card).toBeNull(); expect(plans[2].card).toBeNull();
  });
  it("a discriminating clarification never becomes a proved solution", () => {
    const u = understanding({ status: "needs_clarification", knownFacts: [], uncertainties: [{ code: "ambiguous_intent", requestIds: ["r1"] }] }); const p = planSavRequests(u, retrieval(), playbook)[0]; expect(p.mode).toBe("clarification"); expect(p.nextCheck).toBeNull();
  });
  it("an unproved current request cannot be invented from history", () => {
    const u = understanding({ status: "needs_clarification", requests: [], primaryRequestId: null }); expect(savSemanticPlan(u).replyPolicy).toBe("none"); expect(planSavRequests(u, retrieval(), playbook)).toEqual([]);
  });
  it("cancellation remains draft-forbidden despite an available technical card", () => {
    const u = understanding(); u.requests[0].nature = "cancellation"; expect(planSavRequests(u, retrieval(), playbook)[0].mode).toBe("reserved");
  });
  it("a financial operation remains draft-forbidden", () => {
    const u = understanding(); u.requests[0].nature = "financial_operation"; u.requests[0].financialScope = "support_account"; expect(savSemanticPlan(u).replyPolicy).toBe("none");
  });
  it("contradictory procedures never receive an automatic truth verdict", () => {
    const r = retrieval(); r.sources.push({ ...r.sources[0], id: "other", key: "other:v1", resolution: { ...r.sources[0].resolution, conflictsWith: ["card"] } }); r.requests[0].candidateKeys.push("other:v1");
    const p = planSavRequests(understanding(), r, playbook)[0]; expect(p.nextCheck).toBeNull(); expect(p.limits).toContain("contradictory_cards");
  });
  it("partial CRM allows a safe product question without claiming a customer or ticket was found", () => {
    const u = understanding({ knownFacts: [], uncertainties: [{ code: "missing_context", requestIds: ["r1"] }] }); const p = planSavRequests(u, retrieval(), playbook)[0]; expect(p.mode).toBe("clarification"); expect(p.limits).toContain("missing_context"); expect(JSON.stringify(p)).not.toContain("contactId");
  });
  it("English uses an approved English question and preserves answered context", () => {
    const u = understanding({ language: "en", knownFacts: [] }); const r = retrieval(); const d = r.sources[0].resolution!.diagnostic as { requiredFacts: Array<{ questionEn?: string }> }; d.requiredFacts[0].questionEn = "What is the page URL?";
    expect(planSavRequests(u, r, playbook)[0].missingFacts[0].question).toBe("What is the page URL?");
  });
});

describe("complete qualified procedures", () => {
  function procedural() {
    const r = retrieval(); delete r.sources[0].resolution!.diagnostic;
    const group = { id: "method.first", label: "Première méthode fictive", requiresHuman: false, prerequisites: [], exceptions: [], expectedResult: "", escalation: "", steps: [
      { id: "first.open", userLabel: "Ouvrir", instruction: "Ouvrir le diagnostic fictif.", expectedResult: "", prerequisites: [], exceptions: [], escalation: "" },
      { id: "first.read", userLabel: "Lire", instruction: "Lire le résultat fictif.", expectedResult: "", prerequisites: [], exceptions: [], escalation: "" },
    ] };
    r.sources[0].resolution!.delivery = serializeSavDeliveryGroups("procedure", [group]); return r;
  }
  const part = { requestId: "r1", text: "Texte du modèle ignoré.", kind: "solution" as const, sourceIds: ["card"], missingInformationIds: [], repeatedAttemptIds: [], repeatJustification: "" };
  it("sends the full source procedure without invented questions or free model advice", () => {
    const u = understanding({ knownFacts: [] }); const p = planSavRequests(u, procedural(), playbook);
    const [reply] = assembleSavPlannedReply(u, [{ ...part, procedureGroupId: "method.first" }], p);
    expect(reply.text).toContain("Ouvrir le diagnostic fictif."); expect(reply.text).toContain("Lire le résultat fictif.");
    expect(reply.text).not.toContain("Texte du modèle"); expect(p[0].missingFacts).toEqual([]);
  });
  it("requires one explicit method when there are alternatives and withholds sensitive objectives", () => {
    const r = procedural(); const groups = savDeliveryGroups(r.sources[0].resolution!.delivery); const d = { groups };
    d.groups.push({ ...d.groups[0], id: "method.other", label: "Autre méthode fictive", steps: [d.groups[0].steps[1]] });
    d.groups.push({ ...d.groups[0], id: "method.sensitive", requiresHuman: true });
    r.sources[0].resolution!.delivery = serializeSavDeliveryGroups("procedure", d.groups);
    const u = understanding(); const p = planSavRequests(u, r, playbook);
    expect(p[0].procedures).toHaveLength(3);
    expect(() => assembleSavPlannedReply(u, [part], p)).toThrow("SELECTION_REQUIRED");
    expect(assembleSavPlannedReply(u, [{ ...part, kind: "handoff", procedureGroupId: null, sourceIds: [] }], p)[0]).toMatchObject({ kind: "handoff", sourceIds: [] });
    expect(assembleSavPlannedReply(u, [{ ...part, procedureGroupId: "method.sensitive" }], p)[0]).toMatchObject({ kind: "handoff", sourceIds: [] });
    const [reply] = assembleSavPlannedReply(u, [{ ...part, procedureGroupId: "method.other" }], p);
    expect(reply.text).toContain("Lire le résultat fictif."); expect(reply.text).not.toContain("Ouvrir le diagnostic fictif.");
  });
  it("hands off an oversized full procedure without truncating it or expanding the persisted reply contract", () => {
    const r = procedural(); const delivery = savSupportDeliveryProjectionSchema.parse(r.sources[0].resolution!.delivery);
    for (const step of delivery.steps) step.instruction = "Instruction fictive. ".repeat(95).trim();
    r.sources[0].resolution!.delivery = delivery; r.sources[0].content = delivery.steps.map(s => s.instruction).join("\n");
    const u = understanding(); u.requests[0].summary = "Résumé fictif. ".repeat(35);
    expect(planSavRequests(u, r, playbook)[0]).toMatchObject({ mode: "knowledge_gap", limits: ["procedure_requires_review"] });
  });
  it("blocks repeated attempts, internal instructions, uncertain context and non-source steps", () => {
    const r = procedural();
    expect(planSavRequests(understanding({ attemptedSteps: [{ id: "a", key: "old", text: "Déjà essayé", evidenceIds: ["e1"] }] }), r, playbook)[0].mode).toBe("knowledge_gap");
    expect(planSavRequests(understanding({ status: "needs_clarification" }), r, playbook)[0].mode).toBe("knowledge_gap");
    r.sources[0].resolution!.delivery = serializeSavDeliveryGroups("internal", []);
    expect(planSavRequests(understanding(), r, playbook)[0].limits).toContain("internal_guidance_only");
    const invalid = procedural(); const invalidDelivery = savSupportDeliveryProjectionSchema.parse(invalid.sources[0].resolution!.delivery); invalidDelivery.steps[0].instruction = "Instruction inventée."; invalid.sources[0].resolution!.delivery = invalidDelivery;
    expect(planSavRequests(understanding(), invalid, playbook)[0].procedures).toBeUndefined();
  });
});
