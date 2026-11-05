import { z } from "zod";
import type { CaseAdmissionStatus } from "./admission-policy";
import type { CaseAccessScope } from "./investigation-access-scope";
import { savFactKeySchema } from "../playbook-contract";
import type { SavRetrievalCandidate } from "../request-retrieval";
import {
  knowledgeRefSchema, SAV_CASE_ATTACHMENT_REF, SAV_CASE_REQUEST_FAMILIES, SAV_CASE_SENSITIVE_FAMILIES, sourceRefSchema,
  type CaseEventDirection, type CaseOwner, type CaseTrial, type KnowledgeRef, type SourceRef,
} from "./case-types";

/**
 * V2 decision contract (SAV-6). Parsing or accepting a decision never authorizes an effect:
 * effects are planned later, under their own permissions, by the existing executor.
 */
export const SAV_CASE_DECISION_CONTRACT_REVISION = "sav-case-decision-2026-10-27.v1";

const id = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().min(1).max(max);
const ids = (max: number, min = 0) => z.array(id).min(min).max(max).refine(values => new Set(values).size === values.length, "DUPLICATE_ID");

/** References and families are the SAV-5 case contract's own (case-types.ts, sav-case-2026-10-27.v2). */
export const caseDecisionSourceRefSchema = sourceRefSchema;
export type CaseDecisionSourceRef = SourceRef;
/** The mail an attachment belongs to, from its `<gmailMessageId>:<partId>` reference (pole A v7, Q6). */
export const caseDecisionAttachmentMail = (ref: SourceRef) => ref.type === "attachment" ? SAV_CASE_ATTACHMENT_REF.exec(ref.id)?.[1] : undefined;
export const caseDecisionKnowledgeRefSchema = knowledgeRefSchema;
export type CaseDecisionKnowledgeRef = KnowledgeRef;

export const savCaseSensitiveFamilySchema = z.enum(SAV_CASE_SENSITIVE_FAMILIES);
export type SavCaseSensitiveFamily = z.infer<typeof savCaseSensitiveFamilySchema>;
export const savCaseRequestFamilySchema = z.enum(SAV_CASE_REQUEST_FAMILIES);
export type SavCaseRequestFamily = z.infer<typeof savCaseRequestFamilySchema>;
export const isSensitiveCaseFamily = (family: SavCaseRequestFamily): family is SavCaseSensitiveFamily =>
  (savCaseSensitiveFamilySchema.options as readonly string[]).includes(family);

/** What a question seeks. `credential` exists so that a declared request for a secret is refused with an exact reason. */
export const caseQuestionSeekKindSchema = z.enum([
  "operation_performed", "observed_result", "error_message", "screenshot", "account_email",
  "configuration", "environment", "timing", "reproduction_steps", "other", "credential",
]);
/**
 * `trialId: null` = the customer reports it works again without any step from us (Ugo, 27/10/2026: the case is closed).
 * `quote`: the customer's own words, copied exactly; the server checks they appear in that message (Ugo, 27/10/2026).
 * It proves the evidence exists, not what it means: the meaning is checked by a separate resolution reading.
 */
const resolutionEvidenceSchema = z.object({ source: caseDecisionSourceRefSchema, trialId: id.nullable(), quote: text(300) }).strict();
export type CaseResolutionEvidence = z.infer<typeof resolutionEvidenceSchema>;

const handoffReasonSchema = z.enum([
  "explicit_human_request", "sensitive_request", "knowledge_missing", "knowledge_conflict",
  "evidence_inaccessible", "diagnosis_out_of_tools", "repeated_failure",
]);
const nextActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ask"), questions: z.array(z.object({
    text: text(600), requestId: id, reducesUncertainty: text(300),
    seeks: z.array(z.object({ kind: caseQuestionSeekKindSchema, factKey: savFactKeySchema.optional() }).strict()).min(1).max(5),
  }).strict()).min(1).max(4) }).strict(),
  z.object({ kind: z.literal("answer"), requestIds: ids(6, 1), steps: z.array(z.object({
    text: text(1000), knowledge: caseDecisionKnowledgeRefSchema, newFactIds: ids(10).default([]),
  }).strict()).min(1).max(8), expectedResult: text(600) }).strict(),
  z.object({ kind: z.literal("confirm_resolution"), requestIds: ids(6, 1), evidence: z.array(z.object({ requestId: id, ...resolutionEvidenceSchema.shape }).strict()).min(1).max(6) }).strict(),
  z.object({ kind: z.literal("handoff"), reason: handoffReasonSchema, requestIds: ids(6, 1), report: z.object({
    need: text(1000), expected: text(600).nullable(), observed: text(600).nullable(),
    trialIds: ids(20), hypotheses: z.array(text(600)).max(10), missingInformation: z.array(text(300)).max(10),
    expectedIntervention: text(600), knowledge: z.array(caseDecisionKnowledgeRefSchema).max(10),
  }).strict() }).strict(),
  z.object({ kind: z.literal("observe_only") }).strict(),
]);

export const caseDecisionProposalSchema = z.object({
  caseVersion: z.number().int().nonnegative(),
  understanding: z.object({
    requests: z.array(z.object({
      id, summary: text(600), family: savCaseRequestFamilySchema, status: z.enum(["open", "resolved"]),
      resolvedBy: resolutionEvidenceSchema.optional(),
    }).strict()).max(10),
    newFacts: z.array(z.object({
      id, key: savFactKeySchema.nullable(), statement: text(1000),
      kind: z.enum(["observed", "customer_statement"]), source: caseDecisionSourceRefSchema,
    }).strict()).max(30),
  }).strict(),
  nextAction: nextActionSchema,
  reply: z.object({
    text: text(6000), citations: z.array(caseDecisionKnowledgeRefSchema).max(10),
    impossibilityClaims: z.array(z.object({ requestId: id, statement: text(600), knowledge: caseDecisionKnowledgeRefSchema }).strict()).max(5),
    accountAdvice: z.enum(["none", "existing_account_access", "new_subscription", "new_account"]),
  }).strict().optional(),
}).strict();
export type CaseDecisionProposal = z.infer<typeof caseDecisionProposalSchema>;
export type CaseDecisionAction = CaseDecisionProposal["nextAction"]["kind"];

/**
 * The admission is pole A's own status (`caseAdmissionStatus`, contract v6): fresh while no newer *input* arrived,
 * so a CRM note, a timer or our own observation moves the version without staling it. Our refusal codes, by A reason.
 */
export function caseAdmissionRefusalCode(status: CaseAdmissionStatus | null): "admission_missing" | "admission_not_positive" | "admission_stale" | null {
  if (!status) return "admission_missing";
  if (status.admitted) return null;
  switch (status.reason) {
    case "no_admission": case "policy_missing": return "admission_missing";
    case "input_newer": case "policy_changed": return "admission_stale";
    case "owner_not_agent": case "not_admitted": return "admission_not_positive";
  }
}

/**
 * Per-request knowledge retrieval (`selectCaseKnowledge`, investigation-knowledge.ts). `covered`: at least one
 * applicable card was retrieved for the request; `no_applicable_knowledge`: the search ran and found none (a real gap);
 * `not_searched`: a request or context budget, or a summary too short to search, never an absence.
 */
export type CaseKnowledgeCoverageStatus = "covered" | "no_applicable_knowledge" | "not_searched";
export type CaseKnowledgeCoverage = {
  requestId: string; family: SavCaseRequestFamily; status: CaseKnowledgeCoverageStatus;
  /** Cards retrieved for this request: the only ones that may support it (`knowledge_not_linked_to_request`). */
  knowledge: KnowledgeRef[];
  limitations: string[];
};

/**
 * Minimal read-only view the validator needs, projected from a SAV-5 `CaseSnapshot` and its events by
 * `buildCaseDecisionContext`, never stored: identifiers, dates and categories, plus customer message texts for quote checks only.
 */
export type CaseDecisionValidationContext = {
  caseId: string; caseVersion: number; owner: CaseOwner;
  /** Pole A admission status for this read; null when it could not be computed: no agent action is accepted. */
  admission: CaseAdmissionStatus | null;
  locale: string; audience: string;
  sensitiveCategories: SavCaseSensitiveFamily[];
  requests: Array<{ id: string; family: SavCaseRequestFamily; status: "open" | "resolved" | "handed_off" }>;
  /** `order`: arrival order in our own store (event case version), used instead of message clocks to order sources. */
  sources: Array<{ ref: CaseDecisionSourceRef; direction: CaseEventDirection; at: string; order: number }>;
  /**
   * Text of customer messages, keyed `type:id`, read only to check a resolution quote word for word.
   * A missing entry makes a closure unverifiable; nothing else reads it.
   */
  customerTexts: Readonly<Record<string, string>>;
  facts: Array<{ id: string; key: string | null; kind: "observed" | "customer_statement"; source: CaseDecisionSourceRef; at: string }>;
  questions: Array<{ id: string; factKeys: string[]; askedAt: string; answeredBy: CaseDecisionSourceRef | null }>;
  trials: Array<{ id: string; requestId: string; knowledge: CaseDecisionKnowledgeRef; askedAt: string; outcome: CaseTrial["outcome"]; resultAt: string | null }>;
  /** `order` null: known only by its date (body handoff), so it cannot be placed safely against a message. */
  handoffs: Array<{ at: string; order: number | null }>;
  knowledge: SavRetrievalCandidate[];
  /**
   * Per-request retrieval of the cards (`selectCaseKnowledge`), when the knowledge came from it: a card may then only
   * support the requests it was retrieved for. Absent or null (cards given as a plain list): no link is checked.
   */
  coverage?: readonly CaseKnowledgeCoverage[] | null;
  /**
   * Pilot ACCÈS (`investigation-access-scope.ts`): the sources that may support what is shown to the customer, at their exact
   * version; set, it also means only `access` (or a sensitive family, handed off) is admissible. Absent: not the pilot, not
   * checked (the runner sets it whenever its scope port is wired). Null: no scope, so nothing is shown from any source.
   */
  accessScope?: CaseAccessScope | null;
};

export const SAV_CASE_ACCESS_URL = "https://new.limova.ai";

export const caseDecisionRejectionLabels = {
  context_invalid: "Contexte de validation incohérent : la décision ne peut pas être vérifiée.",
  proposal_schema_invalid: "La décision proposée ne respecte pas le format attendu.",
  case_version_stale: "Le dossier a changé depuis la lecture : la décision porte sur une version périmée.",
  case_not_agent_owned: "Un humain ou une pause détient le dossier : l'agent peut seulement observer, sans répondre.",
  admission_missing: "Aucune admission du dossier pour l'agent n'est connue : l'agent peut seulement observer.",
  admission_not_positive: "Le dossier n'est pas admis pour l'agent : l'agent peut seulement observer.",
  admission_stale: "Une entrée plus récente ou une nouvelle politique a périmé l'admission : elle doit être réévaluée avant toute action.",
  observe_only_with_reply: "Une observation ne peut pas contenir de réponse au client.",
  sensitive_requires_human: "Demande sensible (finance, résiliation, abonnement, droits ou identité) : seule une passation à l'équipe est permise.",
  sensitive_request_downgraded: "Une demande classée sensible dans le dossier a été reclassée en demande ordinaire.",
  request_reference_unknown: "La décision cite une demande qui n'existe pas dans le dossier.",
  request_duplicate: "La même demande apparaît plusieurs fois.",
  request_not_open: "La décision agit sur une demande déjà résolue ou transférée.",
  open_request_omitted: "Une demande encore ouverte du dossier n'est pas reprise dans la décision.",
  request_resolved_without_evidence: "Une demande est marquée résolue sans retour du client indiquant que cela fonctionne.",
  source_reference_unknown: "La décision cite une source absente du dossier.",
  customer_statement_as_observed: "Une déclaration du client est présentée comme un fait constaté.",
  knowledge_reference_unknown: "La décision cite une fiche de connaissance absente des sources fournies.",
  knowledge_revision_mismatch: "La décision cite une autre révision que celle de la fiche fournie.",
  knowledge_not_valid: "La fiche citée n'est pas validée ou n'est plus applicable.",
  knowledge_superseded: "La fiche citée est remplacée par une fiche plus récente.",
  knowledge_not_linked_to_request: "La fiche citée n'a pas été retrouvée pour cette demande : elle ne peut pas l'appuyer.",
  knowledge_conflict: "Les fiches applicables se contredisent : il faut une passation citant les deux sources.",
  impossibility_without_valid_source: "Une impossibilité est affirmée sans fiche validée qui l'énonce.",
  credential_requested: "La décision demande un code, un mot de passe ou un jeton : c'est interdit.",
  credential_request_pattern: "Le texte semble demander un code, un mot de passe ou un jeton : c'est interdit.",
  question_already_answered: "La question porte sur une information déjà connue du dossier.",
  question_already_pending: "Cette information a déjà été demandée et le client n'a pas encore répondu.",
  repeated_failed_procedure: "Cette procédure a déjà échoué pour cette demande et aucun fait nouveau n'est cité.",
  new_fact_reference_invalid: "Le fait nouveau cité n'existe pas ou est antérieur à l'échec de la procédure.",
  account_advice_forbidden: "Conseiller une nouvelle souscription ou un nouveau compte est interdit.",
  access_link_missing: `Parcours d'accès : la réponse doit rappeler le lien ${SAV_CASE_ACCESS_URL}.`,
  access_link_invalid: `Parcours d'accès : seul le lien ${SAV_CASE_ACCESS_URL} est permis pour se connecter.`,
  login_procedure_redundant: "Le client a déjà fait ce que demande la fiche de connexion et dit ce qui s'affiche : ni recommencer la procédure, ni redemander. Transférer à l'équipe avec ce qui est connu, sans inventer de cause.",
  procedure_step_repeated: "La réponse redonne une étape déjà envoyée au client, ou qu'il dit avoir faite : poser la question suivante utile ou transférer.",
  access_scope_missing: "Pilote accès : aucun périmètre de sources approuvé, aucune réponse autonome sur une demande d'accès.",
  access_source_out_of_scope: "Pilote accès : la fiche citée est hors du périmètre approuvé ; elle peut orienter une passation, pas fonder une réponse.",
  access_source_version_out_of_scope: "Pilote accès : la version citée n'est pas celle approuvée dans le périmètre.",
  access_source_orient_only: "Pilote accès : cette fiche sert seulement à orienter (décision en attente ou sujet sensible) ; pas de réponse autonome.",
  pilot_family_out_of_scope: "Pilote accès : seule la famille accès est admise ; une autre famille ordinaire sort du périmètre (une famille sensible impose la passation).",
  other_requests_open: "Résolution partielle : au moins une autre demande reste ouverte.",
  resolution_evidence_invalid: "La confirmation de résolution ne s'appuie pas sur un retour valable du client indiquant que cela fonctionne.",
  resolution_quote_not_found: "La phrase du client citée comme preuve de résolution ne figure pas dans son message.",
  resolution_quote_unverifiable: "Le texte du message client cité n'a pas pu être lu : la résolution ne peut pas être vérifiée pour l'instant.",
  handoff_report_reference_invalid: "Le rapport de passation cite un essai ou une fiche inconnus.",
  handoff_conflict_sources_missing: "Contradiction de fiches : la passation doit citer les deux sources en conflit.",
} as const;
export type CaseDecisionRejectionCode = keyof typeof caseDecisionRejectionLabels;

/** What the server cannot prove. Listed on every result so that acceptance is never read as a semantic guarantee. */
export const caseDecisionUnverifiedLabels = {
  request_classification: "Classement des demandes (sensible ou non, famille) : repris du dossier et de la proposition, non rejugé.",
  question_overlap_semantics: "Recouvrement de sens entre une question et des informations en texte libre : non vérifié.",
  answer_relevance: "Adéquation des fiches citées à la demande du client : non vérifiée.",
  impossibility_statement_support: "La fiche citée énonce-t-elle réellement l'impossibilité : non vérifié.",
  resolution_semantics: "Le message client confirme-t-il que l'étape a fonctionné (et non un remerciement) : non vérifié.",
  reply_semantics: "Sens général de la réponse (impossibilité ou conseil d'abonnement non déclarés) : non vérifié.",
} as const;
export type CaseDecisionUnverifiedJudgment = keyof typeof caseDecisionUnverifiedLabels;

/** Non-blocking wording indices, for measurement in observation mode only. */
export const caseDecisionSignalLabels = {
  impossibility_wording_without_claim: "La réponse emploie une formulation d'impossibilité sans impossibilité déclarée.",
  account_wording_without_advice: "La réponse évoque un compte ou un abonnement sans conseil déclaré.",
  login_procedure_refused_routed: "Proposition redondante sur la connexion refusée : le dossier suit le relais prévu par la fiche, sans nouvel appel au modèle.",
  handoff_knowledge_missing_with_cards: "Transfert pour connaissance manquante alors que des fiches applicables ont été retrouvées pour chaque demande transférée (transfert peut-être injustifié, Q11).",
} as const;
export type CaseDecisionSignal = keyof typeof caseDecisionSignalLabels;

export type CaseDecisionRejection = { code: CaseDecisionRejectionCode; label: string; path: string; detail?: string };
export type CaseDecisionValidation =
  | { outcome: "accepted"; contractRevision: string; decision: CaseDecisionProposal; unverified: CaseDecisionUnverifiedJudgment[]; signals: CaseDecisionSignal[] }
  | { outcome: "needs_review"; contractRevision: string; rejections: CaseDecisionRejection[]; unverified: CaseDecisionUnverifiedJudgment[]; signals: CaseDecisionSignal[] };
