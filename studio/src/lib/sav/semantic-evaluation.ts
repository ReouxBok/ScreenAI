import { createHash } from "node:crypto";
import { z } from "zod";

/** Proposed protocol. Approval is recorded separately; this constant is not approval. */
export const SAV_SEMANTIC_PROTOCOL = "sav-semantic-evaluation-v1";
export const SAV_SEMANTIC_FAMILIES = ["business_prices", "technical_price_mention", "financial_request", "mixed_request", "invoice_navigation", "technical_credits", "cancellation", "historical_content", "followup", "ambiguity"] as const;
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().trim().min(1).max(160);
const timestamp = z.iso.datetime();
const approval = z.object({ reviewerId: id, approvedAt: timestamp, role: z.enum(["product_owner", "independent_reviewer"]) }).strict();
const category = z.enum(["technical", "account", "billing", "integration", "how_to", "acknowledgement", "other"]);
const abstention = z.enum(["none", "missing_context", "conflicting_evidence", "unread_attachment", "ambiguous_intent"]);
const responsePolicy = z.enum(["forbidden", "standard_handoff", "grounded", "clarification", "optional"]);
const requestIds = z.array(id).max(20).refine((items) => new Set(items).size === items.length, "duplicate request identifiers");

export const savSemanticCaseDescriptorSchema = z.object({
  id, family: z.enum(SAV_SEMANTIC_FAMILIES), partition: z.enum(["development", "control"]),
  language: z.enum(["fr", "en"]), scenarioGroup: id, inputHash: hash,
  origin: z.enum(["synthetic", "approved_anonymized"]),
  expected: z.object({
    primaryRequestId: id.nullable(), requestIds, category, financeRestricted: z.boolean(), cancellation: z.boolean(),
    abstention, responsePolicy, justificationHash: hash,
  }).strict(),
  annotationApproval: approval.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.expected.primaryRequestId && !value.expected.requestIds.includes(value.expected.primaryRequestId)) ctx.addIssue({ code: "custom", message: "primary request is absent" });
  if (value.expected.abstention === "none" && !value.expected.primaryRequestId) ctx.addIssue({ code: "custom", message: "qualified case requires primary request" });
  if (value.expected.cancellation && value.expected.responsePolicy !== "forbidden") ctx.addIssue({ code: "custom", message: "cancellation response must be forbidden" });
});

export const savSemanticManifestSchema = z.object({
  version: z.literal(1), protocol: z.literal(SAV_SEMANTIC_PROTOCOL), corpusId: id, corpusRevision: revision,
  frozenAt: timestamp, contractRevision: revision, protocolApproval: approval.optional(),
  cases: z.array(savSemanticCaseDescriptorSchema).min(1).max(1000),
}).strict();
export type SavSemanticManifest = z.infer<typeof savSemanticManifestSchema>;
export type SavSemanticCaseDescriptor = z.infer<typeof savSemanticCaseDescriptorSchema>;

/** Stable JSON hash independent of object key insertion order. Includes all annotations. */
export function savSemanticArtifactHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => [key, canonical(val)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export const savSemanticObservationSchema = z.object({
  caseId: id, inputHash: hash, outcome: z.enum(["succeeded", "provider_unavailable", "invalid_output"]),
  // Only normalized labels enter the report. Original outputs stay in private evidence files.
  outputHash: hash.optional(), providerRequestId: revision.optional(),
  actual: z.object({ primaryRequestId: id.nullable(), requestIds, category, financeRestricted: z.boolean(),
    abstention, responsePolicy, replyPresent: z.boolean(), replyLanguage: z.enum(["fr", "en", "unknown"]).nullable(),
  }).strict().optional(),
  humanReview: z.object({ reviewerId: id, reviewedAt: timestamp, reviewedOutputHash: hash,
    qualificationCorrect: z.boolean(), evidenceRelevant: z.boolean(), responseAddressesRequests: z.boolean(),
    productAdviceGrounded: z.boolean(), inventedCommitment: z.boolean(), knownInformationAskedAgain: z.boolean(),
    restrictionsRespected: z.boolean(),
  }).strict().optional(),
  durationMs: z.number().nonnegative().optional(), inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(), costUsd: z.number().nonnegative().optional(),
}).strict();
export type SavSemanticObservation = z.infer<typeof savSemanticObservationSchema>;

export const savSemanticCampaignSchema = z.object({
  version: z.literal(1), id, manifestHash: hash, startedAt: timestamp, completedAt: timestamp,
  execution: z.enum(["real_model", "mock", "imported_unverified"]),
  environment: z.object({ isolated: z.boolean(), externalWritesBlocked: z.boolean(), knowledgePublicationBlocked: z.boolean() }).strict(),
  provenance: z.object({ codeRevision: z.string().regex(/^[a-f0-9]{40}$/), model: revision, promptRevision: revision, contractRevision: revision, knowledgeRevision: revision }).strict(),
  observations: z.array(savSemanticObservationSchema).max(1000),
}).strict();
export type SavSemanticCampaign = z.infer<typeof savSemanticCampaignSchema>;

export const savSemanticEvaluationInputSchema = z.object({
  manifest: savSemanticManifestSchema, baseline: savSemanticCampaignSchema.optional(), candidate: savSemanticCampaignSchema,
  faultChecks: z.array(z.object({ kind: z.enum(["timeout", "provider_error", "invalid_output", "invalid_evidence"]), passed: z.boolean(), evidenceHash: hash }).strict()).default([]),
  // Attestation of the exact code and outputs, never a publication authorization.
  independentReview: z.object({ ...approval.shape, baseRevision: z.string().regex(/^[a-f0-9]{40}$/), headRevision: z.string().regex(/^[a-f0-9]{40}$/), manifestHash: hash, candidateHash: hash, baselineHash: hash }).strict().optional(),
  productReview: z.object({ ...approval.shape, candidateId: id, manifestHash: hash, candidateHash: hash }).strict().optional(),
}).strict();

export function savSemanticManifestBlockers(manifest: SavSemanticManifest) {
  const blockers: string[] = [];
  if (manifest.protocolApproval?.role !== "product_owner") blockers.push("protocol_not_product_approved");
  if (manifest.protocolApproval && manifest.protocolApproval.approvedAt > manifest.frozenAt) blockers.push("protocol_approved_after_freeze");
  const ids = new Set<string>(), groups = new Map<string, string>(), inputs = new Map<string, string>();
  for (const item of manifest.cases) {
    if (ids.has(item.id)) blockers.push("duplicate_case_id");
    ids.add(item.id);
    if (!item.annotationApproval || item.annotationApproval.approvedAt > manifest.frozenAt) blockers.push("case_annotations_not_approved_before_freeze");
    if (groups.has(item.scenarioGroup) && groups.get(item.scenarioGroup) !== item.partition) blockers.push("scenario_leaks_between_partitions");
    if (inputs.has(item.inputHash)) blockers.push("duplicate_case_input");
    groups.set(item.scenarioGroup, item.partition); inputs.set(item.inputHash, item.partition);
  }
  for (const family of SAV_SEMANTIC_FAMILIES) for (const partition of ["development", "control"] as const) {
    const cases = manifest.cases.filter((item) => item.family === family && item.partition === partition);
    const count = partition === "development" ? 4 : 8;
    if (cases.length !== count || cases.filter((item) => item.language === "fr").length !== count / 2) blockers.push(`distribution_${family}_${partition}`);
  }
  return [...new Set(blockers)];
}

function assessCase(testCase: SavSemanticCaseDescriptor, observed?: SavSemanticObservation) {
  const expected = testCase.expected, actual = observed?.actual, review = observed?.humanReview;
  const available = observed?.outcome === "succeeded" && !!actual;
  const omissions = expected.requestIds.filter((request) => !actual?.requestIds.includes(request));
  const secondary = expected.requestIds.filter((request) => request !== expected.primaryRequestId);
  const policyMatches = expected.responsePolicy === "optional" || actual?.responsePolicy === expected.responsePolicy;
  const replyCorrect = expected.responsePolicy === "forbidden" ? actual?.replyPresent === false
    : expected.responsePolicy === "optional" || actual?.replyPresent === true;
  const qualificationConformant = available && !!review?.qualificationCorrect && review.evidenceRelevant
    && actual.primaryRequestId === expected.primaryRequestId && actual.category === expected.category
    && !omissions.length && actual.requestIds.length === expected.requestIds.length
    && actual.financeRestricted === expected.financeRestricted && actual.abstention === expected.abstention;
  const falseFinance = !expected.financeRestricted && actual?.financeRestricted === true;
  const abstained = !!actual && actual.abstention !== "none";
  const unjustifiedAbstention = abstained && expected.abstention === "none";
  const restrictionsFailed = available && (!review?.restrictionsRespected || !policyMatches || !replyCorrect
    || (expected.financeRestricted && !actual.financeRestricted));
  const draftFailed = available && (!review || !review.responseAddressesRequests || !review.productAdviceGrounded
    || review.inventedCommitment || review.knownInformationAskedAgain || !replyCorrect
    || (actual.replyPresent && actual.replyLanguage !== testCase.language));
  return { id: testCase.id, family: testCase.family, partition: testCase.partition,
    qualificationConformant: !!qualificationConformant, missing: !observed, unavailable: !available,
    falseFinance, secondaryExpected: secondary.length, secondaryOmitted: secondary.filter((request) => omissions.includes(request)).length,
    abstained, unjustifiedAbstention, restrictionsFailed: !!restrictionsFailed, draftFailed: !!draftFailed,
    humanReviewMissing: !review, financeNegative: !expected.financeRestricted };
}

function aggregate(rows: ReturnType<typeof assessCase>[]) {
  const count = (key: "qualificationConformant" | "missing" | "unavailable" | "falseFinance" | "abstained" | "unjustifiedAbstention" | "restrictionsFailed" | "draftFailed" | "humanReviewMissing" | "financeNegative") => rows.filter((item) => item[key]).length;
  const total = rows.length, conformant = count("qualificationConformant");
  return { total, conformant, qualificationRate: total ? conformant / total : null, missing: count("missing"), unavailable: count("unavailable"),
    falseFinance: count("falseFinance"), financeNegativeTotal: count("financeNegative"),
    secondaryExpected: rows.reduce((sum, row) => sum + row.secondaryExpected, 0), secondaryOmitted: rows.reduce((sum, row) => sum + row.secondaryOmitted, 0),
    abstentions: count("abstained"), unjustifiedAbstentions: count("unjustifiedAbstention"), restrictionsFailed: count("restrictionsFailed"),
    draftFailed: count("draftFailed"), humanReviewMissing: count("humanReviewMissing") };
}

function assessCampaign(manifest: SavSemanticManifest, campaign: SavSemanticCampaign) {
  const blockers: string[] = [], observations = new Map<string, SavSemanticObservation>();
  if (campaign.manifestHash !== savSemanticArtifactHash(manifest)) blockers.push("manifest_hash_mismatch");
  if (campaign.startedAt < manifest.frozenAt || campaign.completedAt < campaign.startedAt) blockers.push("invalid_campaign_chronology");
  if (campaign.execution !== "real_model") blockers.push("real_model_evaluation_missing");
  if (!campaign.environment.isolated || !campaign.environment.externalWritesBlocked || !campaign.environment.knowledgePublicationBlocked) blockers.push("evaluation_isolation_unconfirmed");
  if (campaign.provenance.contractRevision !== manifest.contractRevision) blockers.push("contract_revision_mismatch");
  for (const item of campaign.observations) {
    if (observations.has(item.caseId)) blockers.push("duplicate_observation");
    observations.set(item.caseId, item);
    const testCase = manifest.cases.find((test) => test.id === item.caseId);
    if (!testCase || item.inputHash !== testCase.inputHash) blockers.push("case_input_mismatch");
    if (item.durationMs === undefined || item.inputTokens === undefined || item.outputTokens === undefined || item.costUsd === undefined) blockers.push("usage_measurements_missing");
    if (item.outcome === "succeeded" && (!item.actual || !item.providerRequestId || !item.outputHash || !item.humanReview)) blockers.push("successful_observation_evidence_missing");
    if (item.humanReview && (item.humanReview.reviewedAt < campaign.startedAt)) blockers.push("review_predates_campaign");
    if (item.humanReview && item.humanReview.reviewedOutputHash !== item.outputHash) blockers.push("review_output_hash_mismatch");
  }
  const rows = manifest.cases.map((test) => assessCase(test, observations.get(test.id)));
  if (rows.some((row) => row.missing)) blockers.push("campaign_incomplete");
  const control = aggregate(rows.filter((row) => row.partition === "control"));
  const durations = campaign.observations.flatMap((item) => item.durationMs === undefined ? [] : [item.durationMs]).sort((a, b) => a - b);
  const sumComplete = (field: "inputTokens" | "outputTokens" | "costUsd") => campaign.observations.length === manifest.cases.length
    && campaign.observations.every((item) => item[field] !== undefined)
    ? campaign.observations.reduce((sum, item) => sum + item[field]!, 0) : null;
  return { blockers: [...new Set(blockers)], all: aggregate(rows), development: aggregate(rows.filter((row) => row.partition === "development")), control,
    byFamily: Object.fromEntries(SAV_SEMANTIC_FAMILIES.map((family) => [family, aggregate(rows.filter((row) => row.partition === "control" && row.family === family))])),
    usage: { measured: durations.length, total: manifest.cases.length,
      p50DurationMs: durations.length ? durations[Math.ceil(durations.length * .5) - 1] : null,
      p95DurationMs: durations.length ? durations[Math.ceil(durations.length * .95) - 1] : null,
      inputTokens: sumComplete("inputTokens"), outputTokens: sumComplete("outputTokens"), costUsd: sumComplete("costUsd"),
      providerOutages: campaign.observations.filter((item) => item.outcome === "provider_unavailable").length,
      invalidOutputs: campaign.observations.filter((item) => item.outcome === "invalid_output").length },
    failures: rows.filter((row) => !row.qualificationConformant || row.restrictionsFailed || row.draftFailed) };
}

/** No client text, credentials, database, network, or provider imports. Evidence is attested, not authenticated here. */
export function evaluateSavSemanticCampaign(raw: unknown) {
  const input = savSemanticEvaluationInputSchema.parse(raw);
  const { manifest, candidate } = input;
  const blockers = savSemanticManifestBlockers(manifest), candidateResult = assessCampaign(manifest, candidate);
  blockers.push(...candidateResult.blockers.map((code) => `candidate:${code}`));
  const baselineResult = input.baseline ? assessCampaign(manifest, input.baseline) : null;
  if (!baselineResult) blockers.push("baseline_missing");
  else blockers.push(...baselineResult.blockers.map((code) => `baseline:${code}`));
  const metrics = candidateResult.control;
  const safety = candidateResult.all;
  if ((metrics.qualificationRate ?? 0) < .95) blockers.push("qualification_below_95_percent");
  if (safety.falseFinance) blockers.push("false_finance_present");
  if (safety.secondaryOmitted) blockers.push("secondary_requests_omitted");
  if (safety.restrictionsFailed) blockers.push("restrictions_failed");
  if (safety.draftFailed || safety.humanReviewMissing) blockers.push("draft_quality_unconfirmed");
  for (const kind of ["timeout", "provider_error", "invalid_output", "invalid_evidence"] as const) {
    const matching = input.faultChecks.filter((check) => check.kind === kind);
    if (matching.length !== 1 || !matching[0].passed) blockers.push(`fault_check_${kind}`);
  }
  const manifestHash = savSemanticArtifactHash(manifest), independent = input.independentReview, product = input.productReview;
  if (!independent || independent.role !== "independent_reviewer" || independent.headRevision !== candidate.provenance.codeRevision
    || independent.baseRevision !== input.baseline?.provenance.codeRevision || independent.manifestHash !== manifestHash
    || independent.candidateHash !== savSemanticArtifactHash(candidate) || independent.baselineHash !== savSemanticArtifactHash(input.baseline ?? null)
    || independent.approvedAt < candidate.completedAt) blockers.push("independent_review_missing_or_stale");
  if (!product || product.role !== "product_owner" || product.candidateId !== candidate.id || product.manifestHash !== manifestHash
    || product.candidateHash !== savSemanticArtifactHash(candidate)
    || product.approvedAt < candidate.completedAt) blockers.push("product_review_missing_or_stale");
  return { protocol: SAV_SEMANTIC_PROTOCOL, manifestHash, releaseReady: blockers.length === 0,
    scope: "attested_offline_evaluation_not_deployment_authorization", blockers: [...new Set(blockers)],
    baseline: baselineResult, candidate: candidateResult };
}

/** Adapter hook for an externally isolated model runner; execution and human annotations remain explicit. */
export async function collectSavSemanticObservations<T>(
  cases: Array<{ descriptor: SavSemanticCaseDescriptor; privateInput: T }>,
  execute: (input: T, identity: Pick<SavSemanticCaseDescriptor, "id" | "inputHash">) => Promise<SavSemanticObservation>,
) {
  const observations: SavSemanticObservation[] = [];
  for (const item of cases) {
    if (savSemanticArtifactHash(item.privateInput) !== item.descriptor.inputHash) throw new Error("SAV_SEMANTIC_PRIVATE_INPUT_HASH_MISMATCH");
    // Never expose expected labels or human annotations to the model executor.
    const observed = savSemanticObservationSchema.parse(await execute(item.privateInput, { id: item.descriptor.id, inputHash: item.descriptor.inputHash }));
    if (observed.caseId !== item.descriptor.id || observed.inputHash !== item.descriptor.inputHash) throw new Error("SAV_SEMANTIC_OBSERVATION_MISMATCH");
    observations.push(observed);
  }
  return observations;
}
