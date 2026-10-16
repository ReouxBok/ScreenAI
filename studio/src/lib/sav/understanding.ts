import { z } from "zod";
import { normalizeSavEvidenceText, savEvidenceContains } from "./evidence-text";
import { cleanSavModelDraft } from "./reply-format";

export const SAV_UNDERSTANDING_REVISION = "sav-understanding-2026-10-16.v3";
export const SAV_UNDERSTANDING_PROMPT_REVISION = "sav-understanding-prompt-2026-10-16.v4";
const id = z.string().trim().min(1).max(100);
const ids = z.array(id).max(30);
export const savRequestNatureSchema = z.enum(["technical", "account", "integration", "how_to", "financial_operation", "financial_data", "cancellation", "commercial", "partnership", "callback", "human_request", "security", "privacy", "data_deletion", "legal", "acknowledgement", "non_support", "unknown"]);
const fact = z.object({ id, key: id, text: z.string().trim().min(1).max(1000), evidenceIds: ids.min(1) }).strict();

/** Meaning first. Categories and reply permissions are computed separately below. */
export const savUnderstandingContentSchema = z.object({
  version: z.literal(1),
  status: z.enum(["qualified", "needs_clarification", "unavailable"]),
  language: z.enum(["fr", "en", "unknown"]),
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
  evidence: z.array(z.object({ id, source: z.enum(["current_message", "history", "crm"]), sourceId: id, excerpt: z.string().trim().min(2).max(1500) }).strict()).max(60),
  uncertainties: z.array(z.object({ code: z.enum(["ambiguous_intent", "missing_context", "unread_attachment", "truncated_context", "conflicting_evidence", "provider_unavailable", "invalid_output"]), requestIds: ids }).strict()).max(20),
}).strict();
export const savAiTransportTraceSchema = z.object({ transportRevision: z.string(), correlationId: z.string(), model: z.string(), promptRevision: z.string(), phase: z.enum(["understanding", "composition", "coherence", "ticket_matching", "repair"]), attempts: z.number().int().nonnegative(), retries: z.number().int().nonnegative(), durationMs: z.number().nonnegative(), errorCode: z.string().nullable(), failureCategory: z.enum(["authentication", "billing", "rate_limited", "provider_unavailable", "invalid_output", "blocked_output", "budget_exhausted"]).nullable() }).strict();
export const savUnderstandingSchema = savUnderstandingContentSchema.extend({
  trace: z.object({
    contractRevision: z.string(), promptRevision: z.string(), model: z.string().nullable(), inputHash: z.string(), codeRevision: z.string().nullable(),
    durationMs: z.number().nonnegative(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative(),
    errorCode: z.string().nullable(),
    transport: savAiTransportTraceSchema.optional(),
    finishReason: z.string().optional(), blockReason: z.string().optional(), thoughtTokens: z.number().nonnegative().optional(),
    normalizationRevision: z.string().optional(),
    removedKnownQuestions: z.number().int().nonnegative().optional(),
    validationRepair: z.object({ attempted: z.literal(true), succeeded: z.boolean(), originalErrorCode: z.string(), errorCode: z.string().nullable(), originalOutputHash: z.string(), repairedOutputHash: z.string().nullable(), transport: savAiTransportTraceSchema.optional() }).strict().optional(),
  }).strict(),
});
export type SavUnderstandingContent = z.infer<typeof savUnderstandingContentSchema>;
export type SavUnderstandingV1 = z.infer<typeof savUnderstandingSchema>;
export type SavUnderstandingSource = { source: "current_message" | "history" | "crm"; sourceId: string; text: string };

const normalize = normalizeSavEvidenceText;
function unique(values: string[]) { return new Set(values).size === values.length; }

export class SavUnderstandingValidationError extends Error {
  constructor(public readonly reason: "citation_mismatch" | "invalid_structure" | "source_mismatch") { super("SAV_UNDERSTANDING_INVALID_EVIDENCE"); }
}

/** No model-supplied fact or intent can refer to an invented/quoted-current source. */
export function validateSavUnderstanding(raw: unknown, sources: SavUnderstandingSource[]): SavUnderstandingContent {
  const u = savUnderstandingContentSchema.parse(raw);
  const requestIds = new Set(u.requests.map(r => r.id));
  const evidence = new Map(u.evidence.map(e => [e.id, e]));
  const fail = (reason: "citation_mismatch" | "invalid_structure" | "source_mismatch" = "invalid_structure") => { throw new SavUnderstandingValidationError(reason); };
  if (!unique(u.requests.map(r => r.id)) || !unique(u.evidence.map(e => e.id)) || !unique([...u.knownFacts, ...u.attemptedSteps, ...u.missingInformation].map(f => f.id))) fail();
  if (u.primaryRequestId !== null && !requestIds.has(u.primaryRequestId)) fail();
  if (u.status === "qualified" && (!u.primaryRequestId || !u.requests.length || u.requests.some(r => r.nature === "unknown") || u.language === "unknown")) fail();
  if (u.status !== "qualified" && !u.uncertainties.length) fail();
  if (u.status === "unavailable" && (u.requests.length || u.primaryRequestId)) fail();
  for (const e of u.evidence) {
    const source = sources.find(s => s.source === e.source && s.sourceId === e.sourceId);
    if (!source) fail("source_mismatch");
    if (source && !savEvidenceContains(source.text, e.excerpt)) fail("citation_mismatch");
  }
  for (const item of [...u.requests, ...u.knownFacts, ...u.attemptedSteps]) {
    if (item.evidenceIds.some(e => !evidence.has(e))) fail();
  }
  if (u.customerRelationship && (u.customerRelationship.evidenceIds.some(e => !evidence.has(e)) || (u.customerRelationship.kind !== "unknown" && !u.customerRelationship.evidenceIds.length))) fail();
  for (const r of u.requests) {
    // An old demand, CRM record or signature cannot introduce a current request.
    if (!r.evidenceIds.some(e => evidence.get(e)?.source === "current_message")) fail();
    const financial = ["financial_operation", "financial_data"].includes(r.nature);
    if (financial !== (r.financialScope === "support_account")) fail();
  }
  for (const item of [...u.missingInformation, ...u.uncertainties]) if (item.requestIds.some(r => !requestIds.has(r))) fail();
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
  if (u.status !== "qualified") return { ...base, replyPolicy: "none", reasonCode: u.status === "unavailable" ? "understanding_unavailable" : "understanding_needs_clarification" };
  if (u.requests.some(r => r.nature === "cancellation")) return { ...base, replyPolicy: "none", reasonCode: "cancellation_human_only" };
  if (u.requests.some(r => ["financial_operation", "financial_data"].includes(r.nature))) return { ...base, replyPolicy: "none", reasonCode: "finance_human_only" };
  if (u.requests.some(r => r.nature === "legal")) return { ...base, replyPolicy: "none", reasonCode: "legal_human_only" };
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
  requestId: id, text: z.string().trim().min(1).max(4000),
  kind: z.enum(["acknowledgement", "clarification", "solution", "handoff"]),
  sourceIds: ids, missingInformationIds: ids, repeatedAttemptIds: ids,
  repeatJustification: z.string().max(500),
}).strict()).max(15);
export type SavReplyCoverage = z.infer<typeof savReplyCoverageSchema>;

/** The model supplies sections once. The server owns order and the displayed draft. */
export function assembleSavReplySections(u: SavUnderstandingV1, raw: unknown) {
  const coverage = savReplyCoverageSchema.parse(savReplyCoverageSchema.parse(raw).map(part => ({ ...part, text: cleanSavModelDraft(part.text) })));
  if (coverage.length !== u.requests.length || !unique(coverage.map(p => p.requestId)) || u.requests.some(r => !coverage.some(p => p.requestId === r.id)))
    throw new Error("SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING");
  const ordered = u.requests.map(r => coverage.find(p => p.requestId === r.id)!);
  const replyDraft = ordered.map(p => p.text).join("\n\n");
  if (replyDraft.length > 8000) throw new Error("SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING");
  return { coverage: ordered, replyDraft };
}

/** Structural consistency complements citation checks; semantic accuracy still needs human evaluation. */
export function assertSavReplyConsistency(u: SavUnderstandingV1, output: { category: string; replyDraft: string; responseKind: string; coverage?: SavReplyCoverage; citations: Array<{ sourceId: string }> }) {
  const plan = savSemanticPlan(u);
  const fail = () => { throw new Error("SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING"); };
  if (plan.replyPolicy !== "compose" || output.category !== plan.category) fail();
  const coverage = output.coverage;
  if (!coverage || coverage.length !== u.requests.length || !unique(coverage.map(c => c.requestId)) || u.requests.some(r => !coverage.some(c => c.requestId === r.id))) fail();
  // The draft consists exclusively of assessed sections; no unassessed tail can add promises/advice.
  if (normalize(output.replyDraft) !== normalize(coverage!.map(c => c.text).join("\n\n"))) fail();
  for (const part of coverage!) {
    if (part.kind === "solution" && (!part.sourceIds.length || output.responseKind !== "solution")) fail();
    if (part.sourceIds.some(s => !output.citations.some(c => c.sourceId === s))) fail();
    if (part.kind === "clarification" && !part.missingInformationIds.length) fail();
    if (part.missingInformationIds.some(m => !u.missingInformation.some(i => i.id === m && i.requestIds.includes(part.requestId)))) fail();
    if (part.repeatedAttemptIds.some(a => !u.attemptedSteps.some(s => s.id === a))) fail();
    if (part.repeatedAttemptIds.length && !part.repeatJustification.trim()) fail();
  }
}

export const SAV_COMPOSITION_CONTRACT = `La compréhension structurée fournie par le serveur est le contrat de cette réponse. Ne requalifie pas les demandes ni leur catégorie. Couvre chaque request.id exactement une fois dans coverage, y compris les demandes secondaires. Chaque section text doit répondre à cette demande, dans la langue comprise. Ne fournis pas de replyDraft : le serveur assemble les sections validées dans l’ordre des demandes, avec deux sauts de ligne et sans ajout. Une section solution exige les sourceIds des fiches validées qui justifient chaque conseil ; responseKind global devient solution dès qu'une section solution existe. Une clarification cite uniquement les missingInformationIds correspondants ; aucune question sur un fait connu. N'utilise pas une question libre comme accusé de réception. Ne répète pas une étape déjà tentée ; si une nouvelle preuve justifie une nouvelle tentative, cite repeatedAttemptIds et donne une repeatJustification explicite dans la réponse. Sans source pertinente ni information manquante utile, prépare seulement un transfert humain factuel qui reconnaît la demande. Aucun délai, promesse de résultat, de rappel, de geste commercial ou d'action déjà effectuée. Les faits CRM ne prouvent pas une procédure produit. Les champs confidence sont des estimations non calibrées et ne constituent jamais une permission d'action.`;
