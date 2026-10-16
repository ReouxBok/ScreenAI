import { describe, expect, it } from "vitest";
import { assertSavReplyConsistency, savSemanticPlan, validateSavUnderstanding, type SavUnderstandingContent } from "./understanding";
import { coverageFixture, understandingContent, understandingFixture } from "../../../test/sav-understanding-fixtures";

const sources = [{ source: "current_message" as const, sourceId: "current_body", text: "L’agent téléphone cesse de répondre." }];
describe("SAV meaning contract provenance", () => {
  it("accepts evidence from the bounded current source", () => {
    expect(validateSavUnderstanding(understandingContent(), sources)).toEqual(understandingContent());
  });
  it.each<[string, (u: SavUnderstandingContent) => void]>([
    ["invented excerpt", u => { u.evidence[0].excerpt = "Le remboursement a été effectué."; }],
    ["invented source", u => { u.evidence[0].sourceId = "unknown"; }],
    ["unknown request evidence", u => { u.requests[0].evidenceIds = ["unknown"]; }],
    ["duplicate requests", u => { u.requests.push({ ...u.requests[0] }); }],
    ["duplicate evidence", u => { u.evidence.push({ ...u.evidence[0] }); }],
    ["unknown primary request", u => { u.primaryRequestId = "unknown"; }],
    ["qualified unknown meaning", u => { u.requests[0].nature = "unknown"; }],
    ["qualified unknown language", u => { u.language = "unknown"; }],
    ["unavailable with invented request", u => { u.status = "unavailable"; u.uncertainties = [{ code: "provider_unavailable", requestIds: [] }]; }],
    ["financial nature without account scope", u => { u.requests[0].nature = "financial_operation"; }],
    ["technical nature with account financial scope", u => { u.requests[0].financialScope = "support_account"; }],
    ["question for unknown request", u => { u.missingInformation = [{ id: "q1", key: "error", text: "Quel message voyez-vous ?", requestIds: ["unknown"] }]; }],
    ["prospect without evidence", u => { u.customerRelationship = { kind: "prospect", evidenceIds: [] }; }],
    ["customer with fabricated evidence", u => { u.customerRelationship = { kind: "existing_customer", evidenceIds: ["fabricated"] }; }],
  ])("rejects %s", (_label, change) => {
    const content = understandingContent(); change(content);
    expect(() => validateSavUnderstanding(content, sources)).toThrow();
  });
  it.each(["history", "crm"] as const)("cannot turn %s into a current request", source => {
    const content = understandingContent(); content.evidence[0].source = source;
    expect(() => validateSavUnderstanding(content, [{ ...sources[0], source }])).toThrow("SAV_UNDERSTANDING_INVALID_EVIDENCE");
  });
});

describe("SAV semantic server policy", () => {
  it.each(["incidental_price", "customer_business_content"] as const)("keeps technical context when the financial scope is %s", financialScope => {
    const u = understandingFixture(); u.requests[0].financialScope = financialScope;
    expect(savSemanticPlan(u)).toMatchObject({ category: "technical", replyPolicy: "compose", reasonCode: "semantic_support_request" });
  });
  it("keeps every mixed request while restricting financial content", () => {
    const u = understandingFixture(); u.requests.push({ ...u.requests[0], id: "refund", summary: "Demander le remboursement.", nature: "financial_operation", financialScope: "support_account" });
    expect(savSemanticPlan(u)).toMatchObject({ category: "technical", replyPolicy: "none", requiresHuman: true });
    expect(savSemanticPlan(u).retrievalQuery).toContain("remboursement");
    u.requests.push({ ...u.requests[0], id: "cancel", nature: "cancellation" });
    expect(savSemanticPlan(u)).toMatchObject({ replyPolicy: "none", reasonCode: "cancellation_human_only" });
  });
  it("allows a lead template only for an exclusively commercial request", () => {
    const u = understandingFixture(); u.requests[0].nature = "commercial"; u.customerRelationship = { kind: "prospect", evidenceIds: ["evidence-1"] };
    expect(savSemanticPlan(u)).toMatchObject({ replyPolicy: "lead_template", ticketRequired: false });
    u.requests.push({ ...u.requests[0], id: "setup", nature: "integration" });
    expect(savSemanticPlan(u)).toMatchObject({ replyPolicy: "compose", ticketRequired: true, requiresHuman: true });
  });
  it.each(["needs_clarification", "unavailable"] as const)("never composes for status %s", status => {
    expect(savSemanticPlan(understandingFixture({ status }))).toMatchObject({ replyPolicy: "none", requiresHuman: true });
  });
  it.each(["human_request", "callback", "security", "privacy", "data_deletion", "legal"] as const)("retains review for %s without erasing the draft policy", nature => {
    const u = understandingFixture(); u.requests[0].nature = nature;
    expect(savSemanticPlan(u)).toMatchObject({ replyPolicy: nature === "legal" ? "none" : "compose", requiresHuman: true });
  });
});

describe("SAV reply structural coverage", () => {
  function reply() { const u = understandingFixture(); const coverage = coverageFixture(u); return { u, output: { category: "technical", replyDraft: coverage.map(c => c.text).join("\n\n"), responseKind: "handoff", citations: [] as Array<{ sourceId: string }>, coverage } }; }
  it("accepts a complete claim-free handoff", () => { const { u, output } = reply(); expect(() => assertSavReplyConsistency(u, output)).not.toThrow(); });
  it.each(["wrong_category", "missing_request", "duplicate_request", "extra_tail", "uncited_solution", "undeclared_source", "unknown_question", "unjustified_repeat"])("rejects %s", scenario => {
    const { u, output } = reply();
    if (scenario === "wrong_category") output.category = "billing";
    if (scenario === "missing_request") output.coverage = [];
    if (scenario === "duplicate_request") output.coverage.push({ ...output.coverage[0] });
    if (scenario === "extra_tail") output.replyDraft += "\nVous serez remboursé demain.";
    if (scenario === "uncited_solution") output.coverage[0].kind = "solution";
    if (scenario === "undeclared_source") output.coverage[0].sourceIds = ["invented"];
    if (scenario === "unknown_question") { output.coverage[0].kind = "clarification"; output.coverage[0].missingInformationIds = ["invented"]; }
    if (scenario === "unjustified_repeat") { u.attemptedSteps = [{ id: "step-1", key: "reload", text: "Déjà rechargé", evidenceIds: ["evidence-1"] }]; output.coverage[0].repeatedAttemptIds = ["step-1"]; }
    expect(() => assertSavReplyConsistency(u, output)).toThrow("SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING");
  });
  it("accepts a question only for missing information linked to its request", () => {
    const { u, output } = reply(); u.missingInformation = [{ id: "question-1", key: "error_message", text: "Quel message est affiché ?", requestIds: ["request-1"] }];
    output.coverage[0] = { ...output.coverage[0], kind: "clarification", text: u.missingInformation[0].text, missingInformationIds: ["question-1"] };
    output.replyDraft = output.coverage[0].text; output.responseKind = "clarification";
    expect(() => assertSavReplyConsistency(u, output)).not.toThrow();
  });
});
