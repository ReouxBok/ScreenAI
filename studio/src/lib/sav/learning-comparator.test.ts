import { describe, expect, it } from "vitest";
import { compareSavLearningResolution, validateSavLearningComparison, type SavLearningComparisonInput } from "./learning-comparator";

const input: SavLearningComparisonInput = {
  sourceRef: "hubspot:synthetic-1", subject: "Connexion API", resolution: "Ugo a régénéré la clé API puis la connexion a fonctionné.",
  evidenceRef: "hubspot-message:synthetic-1", evidenceExcerpt: "Ugo a régénéré la clé API", productVersion: "v0.0-fixture",
  knowledge: [{ ref: "content:fixture", versionId: "version-fixture", title: "Régénérer une clé", body: "Procédure fictive." }], openCandidates: [],
};
const decision = {
  outcome: "new", matchedRef: null, groupSignature: "api-key-rotation", subject: "Régénérer une clé API", resolution: input.resolution,
  conditions: ["La connexion utilise une clé API"], expectedResult: "La connexion est rétablie", limitations: ["Ne couvre pas une panne serveur"],
  evidenceRef: input.evidenceRef, evidenceExcerpt: input.evidenceExcerpt, rationale: "Intervention humaine reproductible avec un résultat observable.",
};

describe("SAV learning comparator evidence contract", () => {
  it("keeps its strict single call and authenticates by header without a key in the URL", async () => {
    let calls = 0;
    const result = await compareSavLearningResolution(input, { apiKey: "synthetic-header-key", model: "fixture", fetch: async (url, init) => {
      calls++;
      expect(String(url)).not.toContain("key=");
      expect(String(url)).not.toContain("synthetic-header-key");
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("synthetic-header-key");
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(decision) }] } }] });
    } });
    expect(calls).toBe(1);
    expect(result.decision).toEqual(decision);
  });
  it("accepts a synthetic proposal only when its quote and group are grounded in supplied evidence", () => {
    expect(validateSavLearningComparison(decision, input)).toEqual(decision);
  });
  it("rejects fabricated evidence, unknown matches, or a new procedure without a group", () => {
    expect(() => validateSavLearningComparison({ ...decision, evidenceExcerpt: "le client est satisfait" }, input)).toThrow("SAV_LEARNING_COMPARATOR_INVALID_EVIDENCE");
    expect(() => validateSavLearningComparison({ ...decision, outcome: "amendment", matchedRef: "content:invented" }, input)).toThrow("SAV_LEARNING_COMPARATOR_INVALID_MATCH");
    expect(() => validateSavLearningComparison({ ...decision, groupSignature: null }, input)).toThrow("SAV_LEARNING_COMPARATOR_GROUP_REQUIRED");
  });
  it("requires a specific gap and exact existing reference for an amendment", () => {
    const amendment = { ...decision, outcome: "amendment", matchedRef: "content:fixture" };
    expect(validateSavLearningComparison(amendment, input).outcome).toBe("amendment");
    expect(() => validateSavLearningComparison({ ...amendment, matchedRef: null }, input)).toThrow("SAV_LEARNING_COMPARATOR_MATCH_REQUIRED");
  });
  it("requires a quoted material delta before proposing a previously rejected procedure", () => {
    const previous = { ref: "candidate:rejected", groupKey: "new:old", groupSignature: decision.groupSignature, subject: decision.subject, resolution: input.resolution, caseCount: 1 };
    const withHistory = { ...input, priorRejections: [previous] };
    expect(() => validateSavLearningComparison(decision, withHistory)).toThrow("SAV_LEARNING_SUBSTANTIVE_DELTA_REQUIRED");
    expect(() => validateSavLearningComparison({ ...decision, rejectedRef: previous.ref, newEvidenceExcerpt: input.resolution }, withHistory)).toThrow("SAV_LEARNING_SUBSTANTIVE_DELTA_REQUIRED");
    const newEvidence = "Le contrôle du proxy a ensuite confirmé la connexion après une nouvelle configuration.";
    expect(validateSavLearningComparison({ ...decision, resolution: `${input.resolution} ${newEvidence}`, rejectedRef: previous.ref, newEvidenceExcerpt: newEvidence }, { ...withHistory, resolution: `${input.resolution} ${newEvidence}` }).rejectedRef).toBe(previous.ref);
  });
});
