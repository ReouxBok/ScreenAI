import { describe, expect, it, vi } from "vitest";
import {
  collectSavSemanticObservations, evaluateSavSemanticCampaign, SAV_SEMANTIC_FAMILIES, SAV_SEMANTIC_PROTOCOL,
  savSemanticArtifactHash, type SavSemanticCampaign, type SavSemanticManifest,
} from "./semantic-evaluation";

const before = "2026-01-01T00:00:00Z", frozen = "2026-01-02T00:00:00Z", started = "2026-01-03T00:00:00Z", completed = "2026-01-04T00:00:00Z";
const annotation = { reviewerId: "fixture-reviewer", approvedAt: before, role: "product_owner" as const };
// Synthetic metadata tests only: fixture approval values are not real product approval.
function fixture() {
  const manifest: SavSemanticManifest = {
    version: 1, protocol: SAV_SEMANTIC_PROTOCOL, corpusId: "synthetic-fixture", corpusRevision: "fixture-v1",
    frozenAt: frozen, contractRevision: "fixture-contract-v1", protocolApproval: annotation,
    cases: SAV_SEMANTIC_FAMILIES.flatMap((family) => (["development", "control"] as const).flatMap((partition) =>
      Array.from({ length: partition === "development" ? 4 : 8 }, (_, index) => {
        const caseId = `${family.replaceAll("_", "-")}-${partition}-${index}`;
        const cancellation = family === "cancellation", financeRestricted = family === "financial_request" || family === "mixed_request";
        return { id: caseId, family, partition, language: index % 2 ? "en" as const : "fr" as const,
          scenarioGroup: caseId, inputHash: savSemanticArtifactHash({ synthetic: caseId }), origin: "synthetic" as const,
          expected: { primaryRequestId: "main", requestIds: family === "mixed_request" ? ["main", "secondary"] : ["main"],
            category: financeRestricted ? "billing" as const : "technical" as const, financeRestricted, cancellation,
            abstention: family === "ambiguity" ? "missing_context" as const : "none" as const,
            responsePolicy: cancellation ? "forbidden" as const : financeRestricted ? "standard_handoff" as const : "grounded" as const,
            justificationHash: savSemanticArtifactHash({ syntheticJustification: caseId }) }, annotationApproval: annotation };
      }))),
  };
  const makeCampaign = (id: string, revision: string): SavSemanticCampaign => ({
    version: 1, id, manifestHash: savSemanticArtifactHash(manifest), startedAt: started, completedAt: completed,
    execution: "real_model", environment: { isolated: true, externalWritesBlocked: true, knowledgePublicationBlocked: true },
    provenance: { codeRevision: revision.repeat(40), model: "synthetic-provider-metadata", promptRevision: "fixture-prompt", contractRevision: manifest.contractRevision, knowledgeRevision: "fixture-knowledge" },
    observations: manifest.cases.map((test) => ({ caseId: test.id, inputHash: test.inputHash, outcome: "succeeded",
      outputHash: savSemanticArtifactHash({ syntheticOutput: test.id }), providerRequestId: `fixture-${test.id}`,
      actual: { primaryRequestId: test.expected.primaryRequestId, requestIds: [...test.expected.requestIds], category: test.expected.category,
        financeRestricted: test.expected.financeRestricted, abstention: test.expected.abstention, responsePolicy: test.expected.responsePolicy,
        replyPresent: !test.expected.cancellation, replyLanguage: test.expected.cancellation ? null : test.language },
      humanReview: { reviewerId: "fixture-rater", reviewedAt: completed, reviewedOutputHash: savSemanticArtifactHash({ syntheticOutput: test.id }), qualificationCorrect: true, evidenceRelevant: true, responseAddressesRequests: true,
        productAdviceGrounded: true, inventedCommitment: false, knownInformationAskedAgain: false, restrictionsRespected: true },
      durationMs: 100, inputTokens: 100, outputTokens: 50, costUsd: .001,
    })),
  });
  const baseline = makeCampaign("fixture-baseline", "a"), candidate = makeCampaign("fixture-candidate", "b");
  return { manifest, baseline, candidate,
    faultChecks: (["timeout", "provider_error", "invalid_output", "invalid_evidence"] as const).map((kind) => ({ kind, passed: true, evidenceHash: savSemanticArtifactHash(kind) })),
    independentReview: { reviewerId: "fixture-independent", role: "independent_reviewer" as const, approvedAt: completed, baseRevision: "a".repeat(40), headRevision: "b".repeat(40), manifestHash: savSemanticArtifactHash(manifest), candidateHash: savSemanticArtifactHash(candidate), baselineHash: savSemanticArtifactHash(baseline) },
    productReview: { reviewerId: "fixture-product", role: "product_owner" as const, approvedAt: completed, candidateId: "fixture-candidate", manifestHash: savSemanticArtifactHash(manifest), candidateHash: savSemanticArtifactHash(candidate) },
  };
}

describe("semantic evaluation protocol", () => {
  it("calculates all denominators, partitions, families, and usage without claiming real evidence", () => {
    const report = evaluateSavSemanticCampaign(fixture());
    expect(report.releaseReady).toBe(true);
    expect(report.candidate.control).toMatchObject({ total: 80, conformant: 80, qualificationRate: 1, secondaryExpected: 8, secondaryOmitted: 0, abstentions: 8 });
    expect(report.candidate.development.total).toBe(40);
    expect(report.candidate.byFamily.mixed_request.total).toBe(8);
    expect(report.candidate.usage).toMatchObject({ measured: 120, total: 120, p95DurationMs: 100, inputTokens: 12000 });
    expect(report.scope).toBe("attested_offline_evaluation_not_deployment_authorization");
  });
  it("does not accept mocks, missing baseline, or missing human approvals", () => {
    const input = fixture();
    input.candidate.execution = "mock";
    delete input.manifest.protocolApproval;
    const report = evaluateSavSemanticCampaign({ ...input, baseline: undefined, independentReview: undefined, productReview: undefined });
    expect(report.releaseReady).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining(["protocol_not_product_approved", "candidate:real_model_evaluation_missing", "baseline_missing", "independent_review_missing_or_stale", "product_review_missing_or_stale"]));
  });
  it("keeps missing and unavailable results in the full validation denominator", () => {
    const input = fixture();
    const controlIds = input.manifest.cases.filter((test) => test.partition === "control").slice(0, 6).map((test) => test.id);
    input.candidate.observations = input.candidate.observations.filter((row) => row.caseId !== controlIds[0]);
    for (const row of input.candidate.observations.filter((item) => controlIds.includes(item.caseId))) { row.outcome = "provider_unavailable"; delete row.actual; delete row.humanReview; }
    const report = evaluateSavSemanticCampaign(input);
    expect(report.candidate.control).toMatchObject({ total: 80, conformant: 74, missing: 1, unavailable: 6, qualificationRate: .925 });
    expect(report.candidate.usage.providerOutages).toBe(5);
    expect(report.blockers).toContain("qualification_below_95_percent");
  });
  it("fails a single false Finance despite a global score above 95 percent", () => {
    const input = fixture();
    input.candidate.observations.find((row) => row.caseId === "technical-price-mention-control-0")!.actual!.financeRestricted = true;
    const report = evaluateSavSemanticCampaign(input);
    expect(report.candidate.control.qualificationRate).toBe(79 / 80);
    expect(report.candidate.control.falseFinance).toBe(1);
    expect(report.blockers).toContain("false_finance_present");
  });
  it("detects omitted secondary intent, unjustified abstention, and unsafe draft independently", () => {
    const input = fixture();
    input.candidate.observations.find((row) => row.caseId === "mixed-request-control-0")!.actual!.requestIds = ["main"];
    input.candidate.observations.find((row) => row.caseId === "technical-credits-control-0")!.actual!.abstention = "missing_context";
    const cancellation = input.candidate.observations.find((row) => row.caseId === "cancellation-control-0")!;
    cancellation.actual!.replyPresent = true;
    const badDraft = input.candidate.observations.find((row) => row.caseId === "followup-control-0")!;
    badDraft.humanReview!.knownInformationAskedAgain = true;
    badDraft.humanReview!.inventedCommitment = true;
    const report = evaluateSavSemanticCampaign(input);
    expect(report.candidate.control).toMatchObject({ secondaryOmitted: 1, unjustifiedAbstentions: 1, restrictionsFailed: 1, draftFailed: 2 });
    expect(report.blockers).toEqual(expect.arrayContaining(["secondary_requests_omitted", "restrictions_failed", "draft_quality_unconfirmed"]));
  });
  it("prevents a changed corpus, cross-partition paraphrase leakage, and missing approvals", () => {
    const input = fixture();
    const development = input.manifest.cases[0], control = input.manifest.cases[4];
    control.scenarioGroup = development.scenarioGroup;
    delete control.annotationApproval;
    input.manifest.cases.pop();
    const report = evaluateSavSemanticCampaign(input);
    expect(report.releaseReady).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining(["scenario_leaks_between_partitions", "case_annotations_not_approved_before_freeze", "candidate:manifest_hash_mismatch", "distribution_ambiguity_control"]));
  });
  it("fails absent usage, request IDs, review evidence, or isolation attestations", () => {
    const input = fixture();
    delete input.candidate.observations[4].humanReview;
    delete input.candidate.observations[4].providerRequestId;
    delete input.candidate.observations[4].costUsd;
    input.candidate.environment.externalWritesBlocked = false;
    const report = evaluateSavSemanticCampaign(input);
    expect(report.blockers).toEqual(expect.arrayContaining(["candidate:usage_measurements_missing", "candidate:successful_observation_evidence_missing", "candidate:evaluation_isolation_unconfirmed"]));
    expect(report.candidate.usage.costUsd).toBeNull();
  });
  it("invalidates approval when any candidate output changes", () => {
    const input = fixture();
    input.candidate.observations[4].outputHash = savSemanticArtifactHash("changed-output");
    const report = evaluateSavSemanticCampaign(input);
    expect(report.blockers).toEqual(expect.arrayContaining(["candidate:review_output_hash_mismatch", "product_review_missing_or_stale", "independent_review_missing_or_stale"]));
  });
  it("rejects raw text accidentally included in strict metadata artifacts", () => {
    const input = fixture();
    expect(() => evaluateSavSemanticCampaign({ ...input, originalEmail: "private sentinel" })).toThrow();
    expect(() => evaluateSavSemanticCampaign({ ...input, candidate: { ...input.candidate, observations: [{ ...input.candidate.observations[0], replyDraft: "private sentinel" }] } })).toThrow();
  });
  it("hashes canonical artifacts independently of object property order", () => {
    expect(savSemanticArtifactHash({ a: 1, b: { c: 2, d: 3 } })).toBe(savSemanticArtifactHash({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("does not reveal golden labels to the injected model executor", async () => {
    const input = fixture(), descriptor = input.manifest.cases[0];
    const privateInput = { synthetic: descriptor.id };
    const execute = vi.fn(async () => input.candidate.observations[0]);
    await expect(collectSavSemanticObservations([{ descriptor, privateInput }], execute)).resolves.toHaveLength(1);
    expect(execute).toHaveBeenCalledWith(privateInput, { id: descriptor.id, inputHash: descriptor.inputHash });
    await expect(collectSavSemanticObservations([{ descriptor, privateInput: { synthetic: "modified" } }], execute)).rejects.toThrow("SAV_SEMANTIC_PRIVATE_INPUT_HASH_MISMATCH");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
