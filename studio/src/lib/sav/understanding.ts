import { z } from "zod";
import { normalizeSavEvidenceText, savEvidenceContains } from "./evidence-text";
import { cleanSavModelDraft } from "./reply-format";
import { SavContractValidationError, savValidationDiagnosticSchema } from "./validation-diagnostics";

export const SAV_UNDERSTANDING_REVISION = "sav-understanding-2026-10-19.v11";
export const SAV_UNDERSTANDING_PROMPT_REVISION = "sav-understanding-prompt-2026-10-19.v11";
const id = z.string().trim().min(1).max(100);
const ids = z.array(id).max(30);
export const savRequestNatureSchema = z.enum(["technical", "account", "integration", "how_to", "financial_operation", "financial_data", "cancellation", "commercial", "partnership", "callback", "human_request", "security", "privacy", "data_deletion", "legal", "acknowledgement", "non_support", "unknown"]);
const fact = z.object({ id, key: id, requestIds: ids.optional(), checkId: id.nullable().optional(), checkCardId: id.nullable().optional(), checkVersionId: id.nullable().optional(), outcome: z.enum(["expected", "not_expected", "unknown"]).nullable().optional(), text: z.string().trim().min(1).max(1000), evidenceIds: ids.min(1) }).strict();

/** Meaning first. Categories and reply permissions are computed separately below. */
export const savUnderstandingContentSchema = z.object({
  version: z.literal(1),
  status: z.enum(["qualified", "needs_clarification", "unavailable"]),
  language: z.enum(["fr", "en", "unknown"]),
  ticketTitle: z.string().max(120).nullable().optional().catch(null),
  customerRelationship: z.object({ kind: z.enum(["prospect", "existing_customer", "unknown"]), evidenceIds: ids }).strict().optional(),
  primaryRequestId: id.nullable(),
  requests: z.array(z.object({
    id, summary: z.string().trim().min(3).max(600), nature: savRequestNatureSchema,
    financialScope: z.enum(["none", "support_account", "incidental_price", "customer_business_content"]),
    product: z.string().max(200).nullable(), feature: z.string().max(200).nullable(), evidenceIds: ids.min(1),
  }).strict()).max(15),
  knownFacts: z.array(fact).max(30),
  attemptedSteps: z.array(fact).max(30),
  missingInformation: z.array(z.object({ id, key: id, text: z.string().trim().min(3).max(500), requestIds: ids.min(1) }).strict()).max(15),
  evidence: z.array(z.object({ id, source: z.enum(["current_message", "history", "crm", "current_attachment"]), sourceId: id, excerpt: z.string().trim().min(2).max(1500) }).strict()).max(60),
  uncertainties: z.array(z.object({ code: z.enum(["ambiguous_intent", "missing_context", "unread_attachment", "truncated_context", "conflicting_evidence", "provider_unavailable", "invalid_output"]), requestIds: ids }).strict()).max(20),
}).strict();
export const savAiTransportTraceSchema = z.object({ transportRevision: z.string(), correlationId: z.string(), model: z.string(), promptRevision: z.string(), phase: z.enum(["understanding", "composition", "coherence", "ticket_matching", "repair", "learning_comparison", "translation", "attachment_reading"]), attempts: z.number().int().nonnegative(), retries: z.number().int().nonnegative(), durationMs: z.number().nonnegative(), errorCode: z.string().nullable(), failureCategory: z.enum(["authentication", "billing", "rate_limited", "provider_unavailable", "invalid_output", "blocked_output", "budget_exhausted"]).nullable() }).strict();
export const savUnderstandingSchema = savUnderstandingContentSchema.extend({
  trace: z.object({
    contractRevision: z.string(), promptRevision: z.string(), model: z.string().nullable(), inputHash: z.string(), codeRevision: z.string().nullable(),
    durationMs: z.number().nonnegative(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative(),
    errorCode: z.string().nullable(),
    transport: savAiTransportTraceSchema.optional(),
    finishReason: z.string().optional(), blockReason: z.string().optional(), thoughtTokens: z.number().nonnegative().optional(),
    normalizationRevision: z.string().optional(),
    playbookVersionId: z.string().optional(),
    removedKnownQuestions: z.number().int().nonnegative().optional(),
    validationDiagnostics: z.array(savValidationDiagnosticSchema).max(3).optional(),
    validationRecovery: z.object({ attempted: z.literal(true), succeeded: z.boolean(), errorCode: z.string().nullable(), transport: savAiTransportTraceSchema.optional() }).strict().optional(),
    validationRepair: z.object({ attempted: z.literal(true), succeeded: z.boolean(), originalErrorCode: z.string(), errorCode: z.string().nullable(), originalOutputHash: z.string(), repairedOutputHash: z.string().nullable(), transport: savAiTransportTraceSchema.optional() }).strict().optional(),
  }).strict(),
});
export type SavUnderstandingContent = z.infer<typeof savUnderstandingContentSchema>;
/** Counts/enums only: distinguish unusable clarification from successful analysis
 * without copying customer text into the diagnostics trace. */
export const savUnderstandingSummarySchema = z.object({
  status: savUnderstandingContentSchema.shape.status,
  language: savUnderstandingContentSchema.shape.language,
  requests: z.number().int().nonnegative(), knownFacts: z.number().int().nonnegative(), attemptedSteps: z.number().int().nonnegative(),
  uncertainties: z.array(savUnderstandingContentSchema.shape.uncertainties.element.shape.code).max(20),
}).strict();
export type SavUnderstandingV1 = z.infer<typeof savUnderstandingSchema>;
export type SavUnderstandingSource = { source: "current_message" | "history" | "crm" | "current_attachment"; sourceId: string; text: string };

const normalize = normalizeSavEvidenceText;
function unique(values: string[]) { return new Set(values).size === values.length; }

export class SavUnderstandingValidationError extends SavContractValidationError {
  constructor(public readonly reason: "citation_mismatch" | "invalid_structure" | "source_mismatch", rule = reason as string, path = "understanding") { super("SAV_UNDERSTANDING_INVALID_EVIDENCE", rule, path); }
}

/** No model-supplied fact or intent can refer to an invented/quoted-current source. */
export function validateSavUnderstanding(raw: unknown, sources: SavUnderstandingSource[]): SavUnderstandingContent {
  const u = savUnderstandingContentSchema.parse(raw);
  const requestIds = new Set(u.requests.map(r => r.id));
  const evidence = new Map(u.evidence.map(e => [e.id, e]));
  const fail = (rule: string, path: string, reason: "citation_mismatch" | "invalid_structure" | "source_mismatch" = "invalid_structure") => { throw new SavUnderstandingValidationError(reason, rule, path); };
  if (!unique(u.requests.map(r => r.id)) || !unique(u.evidence.map(e => e.id)) || !unique([...u.knownFacts, ...u.attemptedSteps, ...u.missingInformation].map(f => f.id))) fail("duplicate_identifier", "identifiers");
  if (u.primaryRequestId !== null && !requestIds.has(u.primaryRequestId)) fail("primary_request_missing", "primaryRequestId");
  if (u.status === "qualified" && (!u.primaryRequestId || !u.requests.length || u.requests.some(r => r.nature === "unknown") || u.language === "unknown")) fail("qualified_request_required", "requests");
  if (u.status !== "qualified" && !u.uncertainties.length) fail("uncertainty_required", "uncertainties");
  if (u.status === "unavailable" && (u.requests.length || u.primaryRequestId)) fail("unavailable_has_requests", "requests");
  for (const e of u.evidence) {
    const source = sources.find(s => s.source === e.source && s.sourceId === e.sourceId);
    if (!source) fail("source_not_found", "evidence.sourceId", "source_mismatch");
    if (source && !savEvidenceContains(source.text, e.excerpt)) fail("quote_not_in_source", "evidence.excerpt", "citation_mismatch");
  }
  for (const item of [...u.requests, ...u.knownFacts, ...u.attemptedSteps]) {
    if (item.evidenceIds.some(e => !evidence.has(e))) fail("unknown_evidence_reference", "evidenceIds");
    if ("requestIds" in item && item.requestIds?.some(r => !requestIds.has(r))) fail("unknown_request_reference", "requestIds");
    if (item.evidenceIds.every(e => evidence.get(e)?.sourceId === "diagnostic_checks")) fail("diagnostic_is_not_customer_evidence", "evidenceIds");
  }
  if (u.customerRelationship && (u.customerRelationship.evidenceIds.some(e => !evidence.has(e)) || (u.customerRelationship.kind !== "unknown" && !u.customerRelationship.evidenceIds.length))) fail("relationship_evidence_required", "customerRelationship");
  if (u.customerRelationship?.kind !== "unknown" && u.customerRelationship?.evidenceIds.length && u.customerRelationship.evidenceIds.every(id => evidence.get(id)?.source === "current_attachment")) fail("attachment_is_not_customer_identity", "customerRelationship");
  for (const r of u.requests) {
    // An old demand, CRM record or signature cannot introduce a current request.
    if (!r.evidenceIds.some(e => evidence.get(e)?.source === "current_message")) fail("current_request_evidence_required", "requests.evidenceIds");
    const financial = ["financial_operation", "financial_data"].includes(r.nature);
    if (financial !== (r.financialScope === "support_account")) fail("financial_scope_mismatch", "requests.financialScope");
  }
  // A visible control or error is a fact about the screen, not evidence that
  // the customer performed an action, including natural attempts with unknown outcome.
  for (const attempt of u.attemptedSteps) if (attempt.evidenceIds.every(id => evidence.get(id)?.source === "current_attachment"))
    fail("attempt_customer_evidence_required", "attemptedSteps.evidenceIds");
  for (const attempt of u.attemptedSteps) if (attempt.checkId || attempt.checkCardId || attempt.checkVersionId || attempt.outcome === "expected" || attempt.outcome === "not_expected") {
    if (!attempt.checkId) fail("attempt_check_required", "attemptedSteps.checkId");
    const reference = sources.find(source => source.sourceId === "diagnostic_checks" && source.source === "history");
    let checks: Array<{ cardId?: string; id: string; versionId: string }> = [];
    try { checks = z.object({ checks: z.array(z.object({ cardId: z.string().optional(), id: z.string(), versionId: z.string() })) }).parse(JSON.parse(reference?.text ?? "{}")).checks; } catch { /* No validated diagnostic reference is available. */ }
    const referenced = checks.find(check => check.id === attempt.checkId && check.versionId === attempt.checkVersionId);
    if (!referenced || attempt.checkCardId && referenced.cardId !== attempt.checkCardId) fail("attempt_check_reference_missing", "attemptedSteps.checkVersionId");
    // Scope comes from the server-owned sent-control reference, never a guessed model key.
    if (referenced?.cardId) attempt.checkCardId = referenced.cardId;
    if (!attempt.evidenceIds.some(id => { const proof = evidence.get(id); const source = sources.find(s => s.sourceId === proof?.sourceId && s.source === proof?.source); return proof?.source === "current_message" || source?.text.startsWith("[inbound]"); })) fail("attempt_customer_evidence_required", "attemptedSteps.evidenceIds");
  }
  for (const item of [...u.missingInformation, ...u.uncertainties]) if (item.requestIds.some(r => !requestIds.has(r))) fail("unknown_scoped_request", "requestIds");
  // Only redundant questions are recoverable locally, after every reference
  // and request has been validated. Never discard a demand or a source.
  u.missingInformation = u.missingInformation.filter(m => !u.knownFacts.some(f => f.key === m.key));
  return u;
}

/** A citation repair cannot solve validation by removing/changing an intent,
 * financial restriction, source identity, known fact or attempted step. */
export function assertSavUnderstandingRepairPreserves(before: SavUnderstandingContent, after: SavUnderstandingContent) {
  const retained = (u: SavUnderstandingContent) => ({ version: u.version, status: u.status, language: u.language, primaryRequestId: u.primaryRequestId,
    customerRelationship: u.customerRelationship, requests: u.requests, knownFacts: u.knownFacts, attemptedSteps: u.attemptedSteps,
    missingInformation: u.missingInformation.filter(m => !u.knownFacts.some(f => f.key === m.key)), uncertainties: u.uncertainties,
    evidence: u.evidence.map(e => ({ id: e.id, source: e.source, sourceId: e.sourceId })) });
  if (JSON.stringify(retained(before)) !== JSON.stringify(retained(after))) throw new Error("SAV_UNDERSTANDING_REPAIR_REJECTED");
}

/** Re-extraction may fix references, never discard/reclassify an extracted request.
 * Failed candidates have no authority to execute; the whole recovery is validated again. */
export function assertSavUnderstandingRecoveryPreserves(before: unknown, after: SavUnderstandingContent) {
  const raw = before && typeof before === "object" ? before as Record<string, unknown> : {};
  for (const key of ["requests", "knownFacts", "attemptedSteps"] as const) {
    if (!Array.isArray(raw[key])) throw new SavContractValidationError("SAV_UNDERSTANDING_REPAIR_REJECTED", "original_collection_not_preservable", key);
  }
  const signature = (r: Pick<SavUnderstandingContent["requests"][number], "summary" | "nature" | "product" | "feature">) => JSON.stringify([r.summary, r.nature, r.product, r.feature]);
  const minimalRequest = z.object({ id: z.string().optional(), summary: z.string().min(3).max(600), nature: savRequestNatureSchema,
    product: z.string().nullable().optional(), feature: z.string().nullable().optional() });
  const requests = Array.isArray(raw.requests) ? raw.requests.map(r => {
    const parsed = minimalRequest.safeParse(r);
    if (!parsed.success) throw new SavContractValidationError("SAV_UNDERSTANDING_REPAIR_REJECTED", "original_request_not_preservable", "requests");
    return { ...parsed.data, product: parsed.data.product ?? null, feature: parsed.data.feature ?? null };
  }) : [];
  const remaining = after.requests.map(signature);
  for (const request of requests) {
    const i = remaining.indexOf(signature(request));
    if (i < 0) throw new SavContractValidationError("SAV_UNDERSTANDING_REPAIR_REJECTED", "recovery_changed_request", "requests");
    remaining.splice(i, 1);
  }
  const primary = requests.filter(r => r.id === raw.primaryRequestId);
  const recoveredPrimary = after.requests.find(r => r.id === after.primaryRequestId);
  if (primary.length === 1 && (!recoveredPrimary || signature(primary[0]) !== signature(recoveredPrimary)))
    throw new SavContractValidationError("SAV_UNDERSTANDING_REPAIR_REJECTED", "recovery_changed_primary_request", "primaryRequestId");
  // Semantic content survives even when its identifiers/evidence references need repair.
  const scope = (ids: unknown, originals: Array<Pick<typeof requests[number], "id" | "summary" | "nature" | "product" | "feature">>) => {
    if (!Array.isArray(ids) || !ids.length) return [];
    return ids.map(id => { const matches = originals.filter(r => r.id === id);
      if (matches.length !== 1) throw new SavContractValidationError("SAV_UNDERSTANDING_REPAIR_REJECTED", "original_scope_not_preservable", "requestIds");
      return signature(matches[0]); }).sort();
  };
  for (const key of ["knownFacts", "attemptedSteps"] as const) {
    const original = Array.isArray(raw[key]) ? raw[key] as unknown[] : [];
    const minimal = z.object({ key: z.string(), text: z.string().min(1), requestIds: z.array(z.string()).optional() });
    const contents = after[key].map(f => JSON.stringify([f.key, f.text, scope(f.requestIds, after.requests)]));
    for (const fact of original) {
      const parsed = minimal.safeParse(fact);
      if (!parsed.success) throw new SavContractValidationError("SAV_UNDERSTANDING_REPAIR_REJECTED", "original_fact_not_preservable", key);
      const content = JSON.stringify([parsed.data.key, parsed.data.text, scope(parsed.data.requestIds, requests)]);
      const index = contents.indexOf(content);
      if (index < 0) throw new SavContractValidationError("SAV_UNDERSTANDING_REPAIR_REJECTED", "recovery_changed_fact_or_attempt", key);
      contents.splice(index, 1);
    }
  }
  const relationship = raw.customerRelationship as { kind?: string } | undefined;
  if (relationship && ["prospect", "existing_customer"].includes(relationship.kind ?? "") && after.customerRelationship?.kind !== relationship.kind)
    throw new SavContractValidationError("SAV_UNDERSTANDING_REPAIR_REJECTED", "recovery_changed_relationship", "customerRelationship");
}

export type SavSemanticPlan = {
  category: "technical" | "account" | "billing" | "integration" | "how_to" | "acknowledgement" | "other";
  replyPolicy: "compose" | "lead_template" | "none";
  requiresHuman: boolean; ticketRequired: boolean; reasonCode: string; retrievalQuery: string;
};

/** This policy cannot be overridden by either generation runtime. */
export function savSemanticPlan(u: SavUnderstandingV1): SavSemanticPlan {
  const primary = u.requests.find(r => r.id === u.primaryRequestId);
  const nature = primary?.nature;
  const category: SavSemanticPlan["category"] = nature === "technical" || nature === "account" || nature === "integration" || nature === "how_to" || nature === "acknowledgement" ? nature
    : nature === "financial_operation" || nature === "financial_data" ? "billing" : "other";
  const base = { category, requiresHuman: true, ticketRequired: true, retrievalQuery: u.requests.map(r => [r.product, r.feature, r.summary].filter(Boolean).join(" — ")).join("\n").slice(0, 2000) };
  if (u.status === "unavailable" || u.language === "unknown" || !u.requests.length) return { ...base, replyPolicy: "none", reasonCode: u.status === "unavailable" ? "understanding_unavailable" : "understanding_needs_clarification" };
  if (u.requests.some(r => r.nature === "cancellation")) return { ...base, replyPolicy: "none", reasonCode: "cancellation_human_only" };
  if (u.requests.some(r => ["financial_operation", "financial_data"].includes(r.nature))) return { ...base, replyPolicy: "none", reasonCode: "finance_human_only" };
  if (u.requests.some(r => r.nature === "legal")) return { ...base, replyPolicy: "none", reasonCode: "legal_human_only" };
  if (u.status === "needs_clarification") return { ...base, replyPolicy: "compose", reasonCode: "safe_clarification_required" };
  if (u.requests.every(r => ["partnership", "acknowledgement"].includes(r.nature)) && u.requests.some(r => r.nature === "partnership")) return { ...base, replyPolicy: "none", ticketRequired: false, reasonCode: "partnership_human_forward" };
  if (u.requests.every(r => r.nature === "commercial")) return u.customerRelationship?.kind === "prospect"
    ? { ...base, replyPolicy: "lead_template", ticketRequired: false, reasonCode: "lead_product_information" }
    : { ...base, replyPolicy: "none", ticketRequired: false, reasonCode: "commercial_context_to_review" };
  if (u.requests.every(r => ["non_support", "acknowledgement"].includes(r.nature))) return { ...base, replyPolicy: "none", ticketRequired: false, reasonCode: nature === "acknowledgement" ? "simple_acknowledgement" : "non_support_review" };
  // Commercial commitments in a mixed support request stay under human review.
  const sensitive = u.requests.some(r => ["human_request", "callback", "security", "privacy", "data_deletion", "legal", "commercial", "partnership"].includes(r.nature));
  return { ...base, replyPolicy: "compose", requiresHuman: sensitive || u.uncertainties.length > 0, reasonCode: sensitive ? "sensitive_or_human_request" : "semantic_support_request" };
}

export const savReplyCoverageSchema = z.array(z.object({
  requestId: id, text: z.string().trim().min(1).max(4000), procedureGroupId: id.nullable().optional(),
  kind: z.enum(["acknowledgement", "clarification", "solution", "handoff"]),
  sourceIds: ids, missingInformationIds: ids, repeatedAttemptIds: ids,
  repeatJustification: z.string().max(500),
}).strict()).max(15);
export type SavReplyCoverage = z.infer<typeof savReplyCoverageSchema>;

/** The model supplies sections once. The server owns order and the displayed draft. */
export function assembleSavReplySections(u: SavUnderstandingV1, raw: unknown) {
  const coverage = savReplyCoverageSchema.parse(savReplyCoverageSchema.parse(raw).map(part => ({ ...part, text: cleanSavModelDraft(part.text) })));
  if (coverage.length !== u.requests.length || !unique(coverage.map(p => p.requestId)) || u.requests.some(r => !coverage.some(p => p.requestId === r.id)))
    throw new SavContractValidationError("SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING", "request_coverage_mismatch", "coverage");
  const ordered = u.requests.map(r => coverage.find(p => p.requestId === r.id)!);
  const replyDraft = ordered.map(p => p.text).join("\n\n");
  if (replyDraft.length > 8000) throw new SavContractValidationError("SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING", "assembled_reply_too_long", "coverage.text");
  return { coverage: ordered, replyDraft };
}

/** Structural consistency complements citation checks; semantic accuracy still needs human evaluation. */
export function assertSavReplyConsistency(u: SavUnderstandingV1, output: { category: string; replyDraft: string; responseKind: string; coverage?: SavReplyCoverage; citations: Array<{ sourceId: string }> }) {
  const plan = savSemanticPlan(u);
  const fail = (rule: string, path: string) => { throw new SavContractValidationError("SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING", rule, path); };
  if (plan.replyPolicy !== "compose" || output.category !== plan.category) fail("policy_category_mismatch", "category");
  const coverage = output.coverage;
  if (!coverage || coverage.length !== u.requests.length || !unique(coverage.map(c => c.requestId)) || u.requests.some(r => !coverage.some(c => c.requestId === r.id))) fail("request_coverage_mismatch", "coverage");
  // The draft consists exclusively of assessed sections; no unassessed tail can add promises/advice.
  if (normalize(output.replyDraft) !== normalize(coverage!.map(c => c.text).join("\n\n"))) fail("unassessed_reply_text", "replyDraft");
  for (const part of coverage!) {
    if (part.kind === "solution" && (!part.sourceIds.length || output.responseKind !== "solution")) fail("solution_sources_required", "coverage.sourceIds");
    if (part.sourceIds.some(s => !output.citations.some(c => c.sourceId === s))) fail("citation_for_source_required", "coverage.sourceIds");
    if (part.kind === "clarification" && !part.missingInformationIds.length) fail("clarification_fact_required", "coverage.missingInformationIds");
    if (part.missingInformationIds.some(m => !u.missingInformation.some(i => i.id === m && i.requestIds.includes(part.requestId)))) fail("unknown_missing_fact", "coverage.missingInformationIds");
    if (part.repeatedAttemptIds.some(a => !u.attemptedSteps.some(s => s.id === a))) fail("unknown_attempt", "coverage.repeatedAttemptIds");
    if (part.repeatedAttemptIds.length && !part.repeatJustification.trim()) fail("repeat_justification_required", "coverage.repeatJustification");
  }
}

export const SAV_COMPOSITION_CONTRACT = `La compréhension structurée fournie par le serveur est le contrat de cette réponse. Ne requalifie pas les demandes ni leur catégorie. Couvre chaque request.id exactement une fois dans coverage, y compris les demandes secondaires. Chaque section text doit répondre à cette demande, dans la langue comprise. Ne fournis pas de replyDraft : le serveur assemble les sections validées dans l’ordre des demandes, avec deux sauts de ligne et sans ajout. Une section solution exige les sourceIds des fiches validées qui justifient chaque conseil ; responseKind global devient solution dès qu'une section solution existe. Une clarification cite uniquement les missingInformationIds correspondants ; aucune question sur un fait connu. N'utilise pas une question libre comme accusé de réception. Ne répète pas une étape déjà tentée ; si une nouvelle preuve justifie une nouvelle tentative, cite repeatedAttemptIds et donne une repeatJustification explicite dans la réponse. Sans source pertinente ni information manquante utile, prépare seulement un transfert humain factuel qui reconnaît la demande. Aucun délai, promesse de résultat, de rappel, de geste commercial ou d'action déjà effectuée. Les faits CRM ne prouvent pas une procédure produit. Les champs confidence sont des estimations non calibrées et ne constituent jamais une permission d'action.`;
