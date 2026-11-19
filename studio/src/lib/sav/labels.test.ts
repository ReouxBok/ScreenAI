import { describe, expect, it } from "vitest";
import {
  savActionKind,
  savActionStatus,
  savDecisionKind,
  savPilotVerdict,
  savThreadStatus,
} from "@/db/schema";
import { savStructuredProposalSchema } from "./proposal";
import {
  savActionLabels,
  savActionStatusLabels,
  savCategoryLabels,
  savDecisionLabels,
  savLabel,
  savRoutingLabels,
  savRoutingReasonLabels,
  savRunStatusLabels,
  savThreadStatusLabels,
  savToolStatusLabels,
  savUrgencyLabels,
  savVerdictLabels,
} from "./labels";

describe("French SAV display labels", () => {
  it.each([
    ["decision", savDecisionKind.enumValues, savDecisionLabels],
    ["thread", savThreadStatus.enumValues, savThreadStatusLabels],
    ["action", savActionKind.enumValues, savActionLabels],
    ["action status", savActionStatus.enumValues, savActionStatusLabels],
    ["verdict", savPilotVerdict.enumValues, savVerdictLabels],
    ["category", savStructuredProposalSchema.shape.category.options, savCategoryLabels],
    ["urgency", savStructuredProposalSchema.shape.urgency.options, savUrgencyLabels],
  ] as const)("covers every current and legacy %s enum without changing backend values", (_name, values, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort());
    for (const value of values) {
      expect(savLabel(labels, value)).not.toBe(value);
      expect(savLabel(labels, value)).not.toBe("État non reconnu");
      expect(savLabel(labels, value)).not.toContain("_");
    }
  });

  it("covers every structured routing kind and the legacy ambiguous result", () => {
    const kinds = savStructuredProposalSchema.shape.routing.options.map((option) => option.shape.kind.value);
    expect(Object.keys(savRoutingLabels).sort()).toEqual([...kinds, "ambiguous"].sort());
    expect(savLabel(savRoutingLabels, "review")).toBe("Rattachement à vérifier");
    expect(savLabel(savRoutingReasonLabels, "customer_identity_unverified")).toBe("Identité du client à vérifier");
  });

  it("distinguishes simulation and fallback statuses in French", () => {
    expect(savLabel(savRunStatusLabels, "shadow")).toBe("Analyse de simulation");
    expect(savLabel(savRunStatusLabels, "fallback")).toBe("Analyse de repli");
    expect(savLabel(savThreadStatusLabels, "closed_no_action")).toBe("Clos sans action");
    expect(savLabel(savToolStatusLabels, "blocked")).toBe("Bloquée");
  });

  it("does not leak unknown machine values or prototype properties", () => {
    expect(savLabel(savDecisionLabels, "unknown_internal_state")).toBe("État non reconnu");
    expect(savLabel(savDecisionLabels, "unknown_internal_state", "Décision à vérifier")).toBe("Décision à vérifier");
    expect(savLabel(savDecisionLabels, "constructor")).toBe("État non reconnu");
    expect(savLabel(savDecisionLabels, "__proto__")).toBe("État non reconnu");
    expect(savLabel(savDecisionLabels, null)).toBe("Non renseigné");
    expect(savLabel(savDecisionLabels, undefined)).toBe("Non renseigné");
    expect(savLabel(savDecisionLabels, " ")).toBe("Non renseigné");
  });
});
