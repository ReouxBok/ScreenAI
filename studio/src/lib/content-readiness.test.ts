import { describe, expect, it } from "vitest";
import { assessContentReadiness } from "./content-readiness";

describe("assessContentReadiness", () => {
  it("flags the generic fields produced by a raw training conversion", () => {
    const result = assessContentReadiness({
      type: "onboarding",
      metadata: {
        proposalSignals: ["Créer une image", "Je veux générer une image"],
        qualificationQuestions: [],
        expectedPages: ["/power-ups"],
        successCriteria: ["Le parcours démontré est terminé"],
        branches: [],
        fallbacks: ["Demander une précision au membre Limova"],
        actionSteps: [{ confidence: "medium" }],
      },
    });

    expect(result.checks.find((check) => check.key === "signals")?.status).toBe("complete");
    expect(result.checks.find((check) => check.key === "success")?.status).toBe("staff");
    expect(result.checks.find((check) => check.key === "evaluation")?.status).toBe("demonstration");
  });

  it("keeps code provenance visible", () => {
    const result = assessContentReadiness({
      type: "article",
      itemSourcePath: "client/src/app/account/page.tsx",
      metadata: { sourceMetadata: { sourcePaths: ["api/src/modules/user"] } },
    });
    expect(result.sourcePaths).toEqual(["client/src/app/account/page.tsx", "api/src/modules/user"]);
  });
});
