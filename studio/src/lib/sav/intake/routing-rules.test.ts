// V1 routing (23/11): the pure rule. Classification → action per class, finance/cancellation/support never routed, any doubt keeps today's path. Synthetic.
import { describe, expect, it } from "vitest";
import { decideIntakeRouting, intakeRoutingModelFromSemantics, intakeRoutingShadowLabel, publicIntakeRoutingDecision, savIntakeRoutingLogLine, savIntakeRoutingMode,
  type SavIntakeRoutingClass, type SavIntakeRoutingFacts } from "./routing-rules";

const MID = "50000000-0000-4000-8000-000000000001";
const facts = (cls: SavIntakeRoutingClass, over: Partial<SavIntakeRoutingFacts> = {}, confidence: "high" | "medium" | "low" = "high"): SavIntakeRoutingFacts => ({
  messageId: MID, model: { class: cls, confidence, justification: "Fait court." },
  plan: { classification: "commercial", requestKinds: ["commercial"], disposition: "no_ticket", progress: "supervised_action" },
  thread: { conversationLength: 1, ticketId: null, humanContext: false, quotedReply: false }, ...over });

describe("mode switch", () => {
  it("off unless exactly shadow or live", () => {
    expect(savIntakeRoutingMode({})).toBe("off");
    expect(savIntakeRoutingMode({ SAV_INTAKE_ROUTING_MODE: "shadow" })).toBe("shadow");
    expect(savIntakeRoutingMode({ SAV_INTAKE_ROUTING_MODE: "live" })).toBe("live");
    for (const typo of ["on", "LIVE", "Shadow", " live", "true"]) expect(savIntakeRoutingMode({ SAV_INTAKE_ROUTING_MODE: typo })).toBe("off");
  });
});

describe("routing per class", () => {
  it.each([
    ["lead_commercial", "forward", "sacha@limova.ai"], ["candidature", "forward", "sacha@limova.ai"], ["investisseur", "forward", "sacha@limova.ai"],
    ["partenariat", "forward", "nathan@limova.ai"], ["demarchage", "archive", null], ["notification_auto", "archive", null],
  ] as const)("%s → %s %s", (cls, action, recipient) => {
    const decision = decideIntakeRouting(facts(cls));
    expect(decision).toMatchObject({ action, recipient, class: cls, reason: null });
  });
  it.each(["support", "finance", "cancellation", "acknowledgement", "mixed", "unknown"] as const)("model class %s keeps the current path", cls => {
    expect(decideIntakeRouting(facts(cls)).action).toBe("keep");
  });
  it("a bounce V1 left unknown/human_choice is archived when the model is sure", () => {
    expect(decideIntakeRouting(facts("notification_auto", { plan: { classification: "unknown", requestKinds: ["unknown"], disposition: "collect_context", progress: "human_choice" } })))
      .toMatchObject({ action: "archive" });
  });
});

describe("finance and cancellation are never routed", () => {
  it.each(["finance", "cancellation"])("V1 classification %s wins over a confident lead", kind => {
    expect(decideIntakeRouting(facts("lead_commercial", { plan: { classification: kind, requestKinds: [kind], disposition: "ticket", progress: "processing" } })))
      .toMatchObject({ action: "keep", reason: "sensitive_request" });
  });
  it("one finance request among others wins", () => {
    expect(decideIntakeRouting(facts("demarchage", { plan: { classification: "unknown", requestKinds: ["other", "finance"], disposition: "collect_context", progress: "human_choice" } })))
      .toMatchObject({ action: "keep", reason: "sensitive_request" });
  });
  it("support, mixed and a V1 ticket path keep", () => {
    expect(decideIntakeRouting(facts("lead_commercial", { plan: { classification: "unknown", requestKinds: ["support", "commercial"], disposition: "collect_context", progress: "human_choice" } })).reason).toBe("support_request");
    expect(decideIntakeRouting(facts("lead_commercial", { plan: { classification: "mixed", requestKinds: ["commercial", "partnership"], disposition: "collect_context", progress: "human_choice" } })).reason).toBe("mixed_request");
    expect(decideIntakeRouting(facts("candidature", { plan: { classification: "other", requestKinds: ["other"], disposition: "request_identification", progress: "processing" } })).reason).toBe("v1_ticket_path");
  });
});

describe("low confidence and ongoing exchanges stay human", () => {
  it.each(["medium", "low"] as const)("confidence %s keeps", confidence => {
    expect(decideIntakeRouting(facts("lead_commercial", {}, confidence))).toMatchObject({ action: "keep", reason: `confidence_${confidence}` });
  });
  it.each([
    ["thread_ticket", { ticketId: "123" }], ["thread_history", { conversationLength: 2 }], ["human_context", { humanContext: true }],
    ["reply_to_team", { quotedReply: true }], ["v2_case", { v2Case: true }], ["newer_message", { newerMessage: true }], ["handled_externally", { handledExternally: true }],
  ] as const)("%s keeps", (reason, thread) => {
    expect(decideIntakeRouting(facts("partenariat", { thread: { conversationLength: 1, ticketId: null, humanContext: false, quotedReply: false, ...thread } })))
      .toMatchObject({ action: "keep", reason });
  });
  it("no model class, no plan or a waiting analysis keeps", () => {
    expect(decideIntakeRouting({ ...facts("lead_commercial"), model: null }).reason).toBe("model_routing_missing");
    expect(decideIntakeRouting({ ...facts("lead_commercial"), plan: null }).reason).toBe("plan_missing");
    expect(decideIntakeRouting({ ...facts("lead_commercial"), analysisWaiting: true }).reason).toBe("analysis_waiting");
  });
});

describe("records and display", () => {
  it("reads the class of THIS mail from the accepted understanding only", () => {
    const records = [{ method: "analyseMessage", result: { messageId: MID, routing: { class: "candidature", confidence: "high", justification: "CV joint." } } },
      { method: "assessIssues", result: {} }];
    expect(intakeRoutingModelFromSemantics({ records }, MID)?.class).toBe("candidature");
    expect(intakeRoutingModelFromSemantics({ records }, "50000000-0000-4000-8000-000000000009")).toBeNull();
    expect(intakeRoutingModelFromSemantics({ records: [{ method: "analyseMessage", result: { messageId: MID, routing: { class: "boss" } } }] }, MID)).toBeNull();
  });
  it("shadow says what it would have done; the log line carries codes only", () => {
    const forward = decideIntakeRouting(facts("partenariat"));
    expect(intakeRoutingShadowLabel(forward)).toBe("Routage (test, aucune action) : aurait transféré à nathan@limova.ai (Partenariat)");
    expect(intakeRoutingShadowLabel(decideIntakeRouting(facts("demarchage")))).toBe("Routage (test, aucune action) : aurait archivé (Démarchage / newsletter)");
    expect(intakeRoutingShadowLabel(decideIntakeRouting(facts("support")))).toBeNull();
    expect(JSON.parse(savIntakeRoutingLogLine("shadow", forward))).toMatchObject({ event: "sav_intake_routing", mode: "shadow", action: "forward", performed: false });
    expect(savIntakeRoutingLogLine("shadow", forward)).not.toContain("Fait court");
  });
  it("diagnostics projection is allow-listed (no justification, no foreign recipient)", () => {
    const pub = publicIntakeRoutingDecision({ ...decideIntakeRouting(facts("lead_commercial")), mode: "shadow", justification: "secret" });
    expect(pub).toEqual({ mode: "shadow", class: "lead_commercial", confidence: "high", action: "forward", recipient: "sacha@limova.ai", reason: null,
      label: "Routage (test, aucune action) : aurait transféré à sacha@limova.ai (Lead commercial)" });
    expect(publicIntakeRoutingDecision({ mode: "live", action: "forward", recipient: "attacker@example.test" })?.recipient).toBeNull();
    expect(publicIntakeRoutingDecision(null)).toBeNull();
  });
});
