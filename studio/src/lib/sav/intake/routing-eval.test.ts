// V1 routing (23/11): the measurement harness on synthetic rows (the real labelled sample stays private, outside the repository).
import { describe, expect, it } from "vitest";
import { baselineIntakeRoutingClass, intakeRoutingExpectedAction, normalizeIntakeRoutingLabel, summarizeIntakeRoutingEval } from "./routing-eval";

describe("labels", () => {
  it("maps the sample spellings to routing classes", () => {
    expect(normalizeIntakeRoutingLabel("demarchage_newsletter_pub")).toBe("demarchage");
    expect(normalizeIntakeRoutingLabel("resiliation")).toBe("cancellation");
    expect(normalizeIntakeRoutingLabel("autre")).toBe("unknown");
    expect(normalizeIntakeRoutingLabel("notification_auto")).toBe("notification_auto");
    expect(normalizeIntakeRoutingLabel("")).toBeNull();
    expect(baselineIntakeRoutingClass("partnership/supervised_action")).toBe("partenariat");
    expect(baselineIntakeRoutingClass("non_lu")).toBe("unknown");
  });
  it("expected actions", () => {
    expect(intakeRoutingExpectedAction("candidature")).toBe("forward:sacha");
    expect(intakeRoutingExpectedAction("partenariat")).toBe("forward:nathan");
    expect(intakeRoutingExpectedAction("notification_auto")).toBe("archive");
    expect(intakeRoutingExpectedAction("finance")).toBe("keep");
    expect(intakeRoutingExpectedAction("lead_commercial", "medium")).toBe("keep");
  });
});

describe("summary", () => {
  it("counts correct, wrong, missed and sensitive routes", () => {
    const summary = summarizeIntakeRoutingEval([
      { id: "a", expected: "lead_commercial", predicted: "lead_commercial", predictedConfidence: "high" },
      { id: "b", expected: "demarchage", predicted: "partenariat", predictedConfidence: "high" },
      { id: "c", expected: "notification_auto", predicted: "notification_auto", predictedConfidence: "low" },
      { id: "d", expected: "finance", predicted: "lead_commercial", predictedConfidence: "high" },
      { id: "e", expected: "support", predicted: "support", predictedConfidence: "high" },
      { id: "f", expected: null, predicted: "demarchage", predictedConfidence: "high" },
    ]);
    expect(summary).toMatchObject({ rows: 6, labelled: 5, unlabelled: 1, classAccuracy: 3 / 5,
      actions: { correctRoutes: 1, correctKeeps: 1, wrongRoutes: 2, missedRoutes: 1, sensitiveOrSupportRouted: 1, unpredicted: 0 },
      wrongRouteIds: ["b", "d"], sensitiveRoutedIds: ["d"] });
    expect(summary.perClass.lead_commercial).toEqual({ support: 1, predicted: 2, precision: 0.5, recall: 1 });
  });
});
