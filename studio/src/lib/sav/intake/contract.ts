import { z } from "zod";
import { SAV_TICKET_RETURN_NOTE_VERSION } from "../ticket-return-note";

/** Design contract only. Parsing a decision never authorizes a provider write. */
export const SAV_INTAKE_CONTRACT_REVISION = "sav-intake-2026-10-20.v4";
const ref = z.string().trim().min(1).max(200);
const crmId = z.string().regex(/^\d{1,30}$/);
const refs = z.array(ref).min(1).max(100).refine(values => new Set(values).size === values.length);

export const savIntakeClassificationSchema = z.enum([
  "support", "finance", "cancellation", "partnership", "commercial", "investor",
  "other", "acknowledgement", "mixed", "unknown",
]);
export type SavIntakeClassification = z.infer<typeof savIntakeClassificationSchema>;

export const savIntakeViewSchema = z.enum([
  "learning", "missing_contact", "to_validate", "sensitive", "completed", "other",
]);
export type SavIntakeView = z.infer<typeof savIntakeViewSchema>;
export const savIntakeViewLabels: Record<SavIntakeView, string> = {
  learning: "Traités — en apprentissage", missing_contact: "Pas de fiche HubSpot", to_validate: "À valider",
  sensitive: "Résiliation / Facturation", completed: "Terminés", other: "Autres",
};

const evidenceOrigin = {
  id: ref,
  sourceId: ref,
  observedAt: z.iso.datetime(),
  contentHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
};
export const savIntakeEvidenceSchema = z.discriminatedUnion("source", [
  z.object({ ...evidenceOrigin,
    source: z.enum(["current_message", "customer_history", "crm_contact", "contact_association", "crm_ticket", "crm_event", "private_rule", "human_override"]),
  }).strict(),
  z.object({ ...evidenceOrigin, source: z.literal("ticket_contact_association"),
    ticketId: crmId, contactId: crmId, direction: z.literal("ticket_to_contact"),
  }).strict(),
]);

/** Exact approved text and recipients belong to private application resources. */
export const savIntakePrivateResourceSchema = z.object({
  resourceId: ref,
  revisionId: ref,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const savIntakeContactScopeSchema = z.object({
  primaryContactId: crmId,
  contacts: z.array(z.discriminatedUnion("origin", [
    z.object({ origin: z.literal("email_lookup"), addressOrigin: z.enum(["sender", "customer_declared_registration"]), contactId: crmId, evidenceIds: refs }).strict(),
    z.object({
      origin: z.literal("direct_association"), contactId: crmId, fromContactId: crmId,
      associationTypeId: z.number().int().nonnegative(),
      associationCategory: z.enum(["HUBSPOT_DEFINED", "USER_DEFINED"]),
      direction: z.literal("primary_to_contact"),
      relationPolicyRevisionId: ref, evidenceIds: refs,
    }).strict(),
  ])).min(1).max(50),
  complete: z.boolean(),
}).strict().superRefine((scope, ctx) => {
  const primary = scope.contacts.filter(contact => contact.origin === "email_lookup");
  if (primary.length !== 1 || primary[0].contactId !== scope.primaryContactId
    || new Set(scope.contacts.map(contact => contact.contactId)).size !== scope.contacts.length) {
    ctx.addIssue({ code: "custom", message: "SAV_INTAKE_CONTACT_SCOPE_INVALID" });
  }
  if (scope.contacts.some(contact => contact.origin === "direct_association"
    && (contact.fromContactId !== scope.primaryContactId || contact.contactId === scope.primaryContactId))) {
    ctx.addIssue({ code: "custom", message: "SAV_INTAKE_DIRECT_ASSOCIATION_REQUIRED" });
  }
});

export const savIntakeMutationSchema = z.enum([
  "create_ticket", "link_ticket", "set_ticket_new", "append_ticket_note", "associate_email", "send_identity_template",
]);
export type SavIntakeMutation = z.infer<typeof savIntakeMutationSchema>;

const noTicket = z.object({
  kind: z.literal("no_ticket"),
  reason: z.enum(["qualified_other", "acknowledgement_only", "outside_support"]),
  nextAction: z.enum(["none", "supervised_partnership", "supervised_commercial", "supervised_investor"]),
  learning: z.literal("excluded"), evidenceIds: refs,
}).strict();

const needsContext = z.object({
  kind: z.literal("collect_context"),
  reasons: z.array(z.enum([
    "classification_incomplete", "contact_lookup_failed", "contact_lookup_incomplete", "contact_ambiguous",
    "association_incomplete", "ticket_search_incomplete", "history_incomplete", "same_issue_unresolved",
    "ticket_creation_date_unknown", "ticket_closure_date_unknown", "ticket_stage_unknown", "ticket_owner_unknown",
    "private_resource_unavailable",
  ])).min(1).max(15),
  evidenceIds: refs,
}).strict();

const identification = z.object({
  kind: z.literal("request_identification"),
  lookup: z.literal("complete_without_contact"),
  reason: z.enum(["sender_contact_absent", "declared_registration_address_absent"]),
  identificationAttemptId: ref,
  declaredAddressEvidenceIds: z.array(ref).max(10),
  template: savIntakePrivateResourceSchema.extend({
    variant: z.enum(["initial_registration_request", "registration_address_not_found"]),
    language: z.literal("fr"), additionalFooter: z.literal(false),
  }).strict(),
  permissionRequired: z.literal("send_identity_template"),
  learning: z.literal("not_started"), evidenceIds: refs,
}).strict();

const ticketBinding = { ticketEvidenceId: ref, contactAssociationEvidenceId: ref };
const ticketTarget = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), contactId: crmId,
    predecessor: z.object({ ticketId: crmId, contactId: crmId, ...ticketBinding }).strict().nullable(),
    selection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("retained_email_match") }).strict(),
      z.object({ kind: z.literal("human_equivalent_contacts"), equivalentContactIds: z.array(crmId).min(2).max(50)
        .refine(values => new Set(values).size === values.length), choiceEvidenceId: ref }).strict(),
    ]),
  }).strict(),
  z.object({ operation: z.literal("link"), contactId: crmId, ticketId: crmId, alreadyNew: z.boolean(), ...ticketBinding }).strict(),
  // Explicitly unassigned is observable and preservable. Missing/unknown is not null.
  z.object({ operation: z.literal("reopen"), contactId: crmId, ticketId: crmId, preserveOwnerId: crmId.nullable(), ...ticketBinding }).strict(),
]);
const noteOrigin = {
  sourceMessageId: z.uuid(), sourceEvidenceIds: refs,
  renderedContentHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  // Final ticket ID is resolved before note dispatch, including after creation.
  // Attempt IDs never generate a second note for the same message/ticket pair.
  deduplication: z.literal("source_message_and_final_ticket"),
};
const ticketNote = z.discriminatedUnion("kind", [
  // Reuses the existing return-note renderer, not a newly generated follow-up.
  z.object({ kind: z.literal("existing_return_summary"), version: z.literal(SAV_TICKET_RETURN_NOTE_VERSION), previousState: z.enum(["open", "closed"]),
    warningPrefix: z.object({ placement: z.literal("before_summary"), resource: savIntakePrivateResourceSchema }).strict().nullable(),
    ...noteOrigin,
  }).strict(),
  // One note containing only the approved warning, without a new return summary.
  z.object({ kind: z.literal("multi_ticket_warning_only"), warningResource: savIntakePrivateResourceSchema, ...noteOrigin }).strict(),
]);
const ticket = z.object({
  kind: z.literal("ticket"), target: ticketTarget,
  requestIds: refs,
  contactScope: savIntakeContactScopeSchema,
  search: z.literal("complete"), history: z.literal("complete"),
  identity: z.object({
    kind: z.literal("unique_crm_match_for_intake"),
    addressOrigin: z.enum(["sender", "customer_declared_registration"]),
    scope: z.literal("intake_only"), evidenceIds: refs,
  }).strict(),
  sameIssueEvidenceIds: refs,
  requiredPermissions: z.array(savIntakeMutationSchema).min(1).max(5)
    .refine(values => new Set(values).size === values.length),
  multiTicketNote: z.object({
    openTicketIdsOnTargetContact: z.array(crmId).max(500),
  }).strict(),
  note: ticketNote.nullable(),
  learning: z.enum(["eligible_after_confirmed_effect", "excluded"]),
  evidenceIds: refs,
}).strict();

/** Snapshots reference server evidence; they are neither grants nor live reads. */
export const savIntakeDecisionSchema = z.object({
  revision: z.literal(SAV_INTAKE_CONTRACT_REVISION),
  messageId: z.uuid(), threadId: z.uuid(), latestInboundMessageId: z.uuid(),
  receivedAt: z.iso.datetime(),
  classification: savIntakeClassificationSchema,
  requests: z.array(z.object({
    id: ref,
    kind: z.enum(["support", "finance", "cancellation", "partnership", "commercial", "investor", "other", "acknowledgement", "unknown"]),
    evidenceIds: refs,
  }).strict()).max(15),
  evidence: z.array(savIntakeEvidenceSchema).min(1).max(100),
  disposition: z.discriminatedUnion("kind", [noTicket, needsContext, identification, ticket]),
}).strict().superRefine((decision, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  const disposition = decision.disposition;
  const evidenceIds = decision.evidence.map(item => item.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) reject("SAV_INTAKE_DUPLICATE_EVIDENCE");
  if (decision.evidence.some(evidence => evidence.source === "current_message" && evidence.sourceId !== decision.messageId)) reject("SAV_INTAKE_CURRENT_EVIDENCE_MISMATCH");
  const referenced = [...disposition.evidenceIds, ...decision.requests.flatMap(request => request.evidenceIds)];
  const currentRequestIds = decision.requests.map(request => request.id);
  if (new Set(currentRequestIds).size !== currentRequestIds.length) reject("SAV_INTAKE_DUPLICATE_REQUEST");
  const sensitive = decision.requests.some(request => ["finance", "cancellation"].includes(request.kind));
  if (sensitive && !["finance", "cancellation"].includes(decision.classification)) reject("SAV_INTAKE_SENSITIVE_PRECEDENCE_REQUIRED");
  // This checks consistency of declared labels, never the meaning of raw text.
  const kinds = new Set(decision.requests.map(request => request.kind));
  const sensitiveKinds = (["finance", "cancellation"] as const).filter(kind => kinds.has(kind));
  const outsideKinds = (["partnership", "commercial", "investor"] as const).filter(kind => kinds.has(kind));
  const neutralKinds = (["other", "acknowledgement"] as const).filter(kind => kinds.has(kind));
  const unresolved = !kinds.size || kinds.has("unknown");
  let compatible: SavIntakeClassification[];
  if (sensitiveKinds.length) compatible = sensitiveKinds;
  else if (unresolved) compatible = ["unknown"];
  else if (kinds.has("support")) compatible = ["support"];
  else if (outsideKinds.length === 1) compatible = outsideKinds;
  else if (outsideKinds.length > 1) compatible = ["mixed"];
  else compatible = neutralKinds;
  if (!compatible.includes(decision.classification)) reject("SAV_INTAKE_REQUEST_CLASSIFICATION_MISMATCH");
  if (unresolved || compatible.includes("mixed")) {
    if (disposition.kind !== "collect_context" || !disposition.reasons.includes("classification_incomplete")) reject("SAV_INTAKE_CLASSIFICATION_CONTEXT_REQUIRED");
  } else {
    const ticketFamily = sensitive || kinds.has("support");
    if (ticketFamily ? disposition.kind === "no_ticket" : !["no_ticket", "collect_context"].includes(disposition.kind)) reject("SAV_INTAKE_REQUEST_DISPOSITION_MISMATCH");
  }
  if (disposition.kind === "ticket") {
    referenced.push(...disposition.sameIssueEvidenceIds, ...disposition.identity.evidenceIds, ...disposition.contactScope.contacts.flatMap(contact => contact.evidenceIds));
    if (!currentRequestIds.length || currentRequestIds.length !== disposition.requestIds.length
      || currentRequestIds.some(id => !disposition.requestIds.includes(id))) reject("SAV_INTAKE_ALL_REQUESTS_ONE_TICKET_REQUIRED");
    if (!["support", "finance", "cancellation"].includes(decision.classification)) reject("SAV_INTAKE_TICKET_CLASSIFICATION_REQUIRED");
    if (!disposition.contactScope.complete || !disposition.contactScope.contacts.some(contact => contact.contactId === disposition.target.contactId)) reject("SAV_INTAKE_TARGET_OUTSIDE_SCOPE");
    const primary = disposition.contactScope.contacts.find(contact => contact.origin === "email_lookup");
    if (!primary || primary.addressOrigin !== disposition.identity.addressOrigin) reject("SAV_INTAKE_IDENTITY_ORIGIN_MISMATCH");
    if (!decision.evidence.some(evidence => evidence.source === "crm_contact"
      && evidence.sourceId === disposition.contactScope.primaryContactId && disposition.identity.evidenceIds.includes(evidence.id))) reject("SAV_INTAKE_UNIQUE_CONTACT_EVIDENCE_REQUIRED");
    if (disposition.identity.addressOrigin === "customer_declared_registration"
      && !decision.evidence.some(evidence => ["current_message", "customer_history"].includes(evidence.source)
        && disposition.identity.evidenceIds.includes(evidence.id))) reject("SAV_INTAKE_CUSTOMER_DECLARATION_REQUIRED");
    if (decision.classification !== "support" && disposition.learning !== "excluded") reject("SAV_INTAKE_SENSITIVE_LEARNING_FORBIDDEN");
    const permissions = disposition.requiredPermissions;
    const target = disposition.target;
    // Evidence IDs bind a declared snapshot and edge, not a live CRM authorization.
    const checkTicketBinding = (binding: { ticketId: string; contactId: string; ticketEvidenceId: string; contactAssociationEvidenceId: string }) => {
      referenced.push(binding.ticketEvidenceId, binding.contactAssociationEvidenceId);
      const record = decision.evidence.find(evidence => evidence.id === binding.ticketEvidenceId);
      const association = decision.evidence.find(evidence => evidence.id === binding.contactAssociationEvidenceId);
      if (record?.source !== "crm_ticket" || record.sourceId !== binding.ticketId) reject("SAV_INTAKE_TICKET_EVIDENCE_REQUIRED");
      if (!disposition.sameIssueEvidenceIds.includes(binding.ticketEvidenceId)) reject("SAV_INTAKE_TARGET_MATCH_EVIDENCE_REQUIRED");
      if (association?.source !== "ticket_contact_association" || association.ticketId !== binding.ticketId
        || association.contactId !== binding.contactId) reject("SAV_INTAKE_TICKET_CONTACT_BINDING_INVALID");
    };
    if (target.operation !== "create") checkTicketBinding(target);
    if (target.operation === "create") {
      const predecessor = target.predecessor;
      if (predecessor) {
        if (!disposition.contactScope.contacts.some(contact => contact.contactId === predecessor.contactId)) reject("SAV_INTAKE_PREDECESSOR_OUTSIDE_SCOPE");
        checkTicketBinding(predecessor);
      }
      if (target.selection.kind === "retained_email_match") {
        if (target.contactId !== disposition.contactScope.primaryContactId) reject("SAV_INTAKE_CREATION_EMAIL_CONTACT_REQUIRED");
      } else {
        const selection = target.selection;
        referenced.push(selection.choiceEvidenceId);
        if (!selection.equivalentContactIds.includes(target.contactId)
          || selection.equivalentContactIds.some(id => !disposition.contactScope.contacts.some(contact => contact.contactId === id))) reject("SAV_INTAKE_EQUIVALENT_CONTACT_SCOPE_INVALID");
        if (!decision.evidence.some(evidence => evidence.id === selection.choiceEvidenceId && evidence.source === "human_override")) reject("SAV_INTAKE_HUMAN_CONTACT_CHOICE_REQUIRED");
      }
    }
    const note = disposition.note;
    if (note) {
      referenced.push(...note.sourceEvidenceIds);
      if (note.sourceMessageId !== decision.messageId) reject("SAV_INTAKE_NOTE_SOURCE_MISMATCH");
      if (!decision.evidence.some(evidence => note.sourceEvidenceIds.includes(evidence.id)
        && evidence.source === "current_message" && evidence.sourceId === decision.messageId)) reject("SAV_INTAKE_NOTE_MESSAGE_EVIDENCE_REQUIRED");
    }
    for (const contact of disposition.contactScope.contacts) {
      if (!decision.evidence.some(evidence => evidence.source === "crm_contact" && evidence.sourceId === contact.contactId
        && contact.evidenceIds.includes(evidence.id))) reject("SAV_INTAKE_CONTACT_EVIDENCE_REQUIRED");
      if (contact.origin === "direct_association" && !decision.evidence.some(evidence => evidence.source === "contact_association"
        && contact.evidenceIds.includes(evidence.id))) reject("SAV_INTAKE_ASSOCIATION_EVIDENCE_REQUIRED");
    }
    const openIds = disposition.multiTicketNote.openTicketIdsOnTargetContact;
    // A created/reopened target becomes open too; IDs refer to the observed state.
    const multipleOpenAfterAction = openIds.length + (target.operation === "link" ? 0 : 1) > 1;
    const returnsToNew = target.operation === "reopen" || target.operation === "link" && !target.alreadyNew;
    const warning = note?.kind === "existing_return_summary" ? note.warningPrefix?.resource : note?.warningResource;
    if (multipleOpenAfterAction && !warning) reject("SAV_INTAKE_MULTI_TICKET_NOTE_REQUIRED");
    if (!multipleOpenAfterAction && warning) reject("SAV_INTAKE_UNNECESSARY_WARNING");
    if (returnsToNew) {
      if (note?.kind !== "existing_return_summary" || note.previousState !== (target.operation === "reopen" ? "closed" : "open")) reject("SAV_INTAKE_RETURN_SUMMARY_REQUIRED");
    } else if (multipleOpenAfterAction) {
      if (note?.kind !== "multi_ticket_warning_only") reject("SAV_INTAKE_MULTI_TICKET_NOTE_REQUIRED");
    } else if (note !== null) reject("SAV_INTAKE_UNNECESSARY_NOTE");
    const expectedPermissions: SavIntakeMutation[] = [target.operation === "create" ? "create_ticket" : "link_ticket", "associate_email"];
    if (returnsToNew || multipleOpenAfterAction) expectedPermissions.push("append_ticket_note");
    if (returnsToNew) expectedPermissions.push("set_ticket_new");
    if (expectedPermissions.some(permission => !permissions.includes(permission))
      || permissions.some(permission => !expectedPermissions.includes(permission))) reject("SAV_INTAKE_TICKET_PERMISSIONS_INVALID");
    if ((target.operation === "reopen" || target.operation === "link" && !target.alreadyNew) && !permissions.includes("set_ticket_new")) reject("SAV_INTAKE_RETURN_PERMISSION_REQUIRED");
    if (new Set(openIds).size !== openIds.length) reject("SAV_INTAKE_DUPLICATE_OPEN_TICKET");
    if (target.operation === "link" && !openIds.includes(target.ticketId)
      || target.operation === "reopen" && openIds.includes(target.ticketId)) reject("SAV_INTAKE_TARGET_STATUS_INCONSISTENT");
    if (multipleOpenAfterAction && !permissions.includes("append_ticket_note")) reject("SAV_INTAKE_MULTI_TICKET_NOTE_REQUIRED");
  }
  if (disposition.kind === "request_identification") {
    referenced.push(...disposition.declaredAddressEvidenceIds);
    if (!["support", "finance", "cancellation"].includes(decision.classification)) reject("SAV_INTAKE_IDENTIFICATION_POLICY_REQUIRED");
    if (disposition.reason === "declared_registration_address_absent"
      ? disposition.template.variant !== "registration_address_not_found" || !disposition.declaredAddressEvidenceIds.length
      : disposition.template.variant !== "initial_registration_request" || disposition.declaredAddressEvidenceIds.length > 0) reject("SAV_INTAKE_TEMPLATE_VARIANT_INVALID");
    if (disposition.declaredAddressEvidenceIds.some(id => !decision.evidence.some(evidence => evidence.id === id
      && ["current_message", "customer_history"].includes(evidence.source)))) reject("SAV_INTAKE_CUSTOMER_DECLARATION_REQUIRED");
  }
  if (disposition.kind === "no_ticket") {
    const permitted = {
      other: ["qualified_other", "none"], acknowledgement: ["acknowledgement_only", "none"],
      partnership: ["outside_support", "supervised_partnership"], commercial: ["outside_support", "supervised_commercial"],
      investor: ["outside_support", "supervised_investor"],
    } as const;
    const expected = permitted[decision.classification as keyof typeof permitted];
    if (!expected || expected[0] !== disposition.reason || expected[1] !== disposition.nextAction) reject("SAV_INTAKE_NO_TICKET_CLASSIFICATION_INVALID");
    if (decision.classification === "other" && !decision.evidence.some(evidence => disposition.evidenceIds.includes(evidence.id)
      && ["private_rule", "human_override"].includes(evidence.source))) reject("SAV_INTAKE_QUALIFIED_OTHER_EVIDENCE_REQUIRED");
  }
  if (referenced.some(id => !evidenceIds.includes(id))) reject("SAV_INTAKE_UNKNOWN_EVIDENCE");
  if (["ticket", "request_identification"].includes(disposition.kind) && decision.messageId !== decision.latestInboundMessageId) reject("SAV_INTAKE_SOURCE_SUPERSEDED");
});
export type SavIntakeDecision = z.infer<typeof savIntakeDecisionSchema>;

/** Queueing and provider acknowledgement are distinct from verified completion. */
export const savIntakeStepReceiptSchema = z.object({
  stepId: ref, attemptId: ref, messageId: z.uuid(), mutation: savIntakeMutationSchema,
  targetTicketId: crmId.nullable(),
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("queued") }).strict(),
    z.object({ kind: z.literal("dispatched"), dispatchedAt: z.iso.datetime() }).strict(),
    z.object({ kind: z.literal("acknowledged"), providerReceiptId: ref, acknowledgedAt: z.iso.datetime() }).strict(),
    z.object({ kind: z.literal("confirmed"), providerReceiptId: ref, verifiedAt: z.iso.datetime(), verificationEvidenceIds: refs }).strict(),
    z.object({ kind: z.literal("not_applied"), reasonCode: ref }).strict(),
    z.object({ kind: z.literal("uncertain"), dispatchedAt: z.iso.datetime(), reasonCode: ref }).strict(),
  ]),
}).strict().superRefine((receipt, ctx) => {
  const requiresTarget = receipt.mutation !== "send_identity_template"
    && (receipt.mutation !== "create_ticket" || ["acknowledged", "confirmed"].includes(receipt.outcome.kind));
  if (requiresTarget && !receipt.targetTicketId || receipt.mutation === "send_identity_template" && receipt.targetTicketId !== null) {
    ctx.addIssue({ code: "custom", message: "SAV_INTAKE_RECEIPT_TARGET_INVALID" });
  }
});
export type SavIntakeStepReceipt = z.infer<typeof savIntakeStepReceiptSchema>;

function completeTicketSteps(value: { messageId: string; attemptId: string; ticketId: string; requiredStepIds: string[]; receipts: SavIntakeStepReceipt[] }) {
  const ids = value.receipts.map(receipt => receipt.stepId);
  return new Set(ids).size === ids.length && ids.length === value.requiredStepIds.length
    && value.requiredStepIds.every(id => ids.includes(id))
    && value.receipts.some(receipt => ["create_ticket", "link_ticket"].includes(receipt.mutation))
    && value.receipts.every(receipt => receipt.outcome.kind === "confirmed" && receipt.targetTicketId === value.ticketId
      && receipt.messageId === value.messageId && receipt.attemptId === value.attemptId
      && receipt.mutation !== "send_identity_template");
}

const supervisedAction = z.object({
  kind: z.literal("supervised_action"), messageId: z.uuid(),
  classification: z.enum(["partnership", "commercial", "investor"]),
  action: z.enum(["supervised_partnership", "supervised_commercial", "supervised_investor"]),
  approval: z.literal("human_confirmation_required"), evidenceIds: refs, view: z.literal("to_validate"),
}).strict().refine(value => value.action === ({ partnership: "supervised_partnership", commercial: "supervised_commercial", investor: "supervised_investor" } as const)[value.classification], "SAV_INTAKE_SUPERVISED_ACTION_MISMATCH");

/** Progress is not a seventh view; normal action validation differs from arbitration. */
export const savIntakeProgressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("processing"), phase: z.enum(["classification", "identity", "context", "decision", "dispatch", "verification", "reconciliation"]), view: z.null() }).strict(),
  z.object({ kind: z.literal("retry_scheduled"), retryAt: z.iso.datetime(), reasonCode: ref, view: z.null() }).strict(),
  supervisedAction,
  z.object({ kind: z.literal("human_choice"), messageId: z.uuid(), classification: z.enum(["support", "finance", "cancellation", "unknown"]),
    questionCode: z.enum(["equivalent_contact_choice", "equivalent_ticket_choice", "same_issue_uncertain", "request_scope_uncertain"]),
    investigation: z.literal("bounded_investigation_complete"), evidenceIds: refs, view: z.literal("to_validate"),
  }).strict(),
  z.object({ kind: z.literal("identity_wait"), templateReceipt: savIntakeStepReceiptSchema, view: z.literal("missing_contact") }).strict()
    .refine(value => value.templateReceipt.mutation === "send_identity_template" && value.templateReceipt.outcome.kind === "confirmed", "SAV_INTAKE_TEMPLATE_CONFIRMATION_REQUIRED"),
  z.object({ kind: z.literal("learning_followup"), messageId: z.uuid(), attemptId: ref, classification: z.literal("support"), ticketId: crmId, requiredStepIds: refs, receipts: z.array(savIntakeStepReceiptSchema).min(1).max(20), learningObservationId: ref, view: z.literal("learning") }).strict()
    .refine(completeTicketSteps, "SAV_INTAKE_VERIFIED_EFFECT_REQUIRED"),
  z.object({ kind: z.literal("sensitive_followup"), messageId: z.uuid(), attemptId: ref, classification: z.enum(["finance", "cancellation"]), ticketId: crmId, requiredStepIds: refs, receipts: z.array(savIntakeStepReceiptSchema).min(1).max(20), learning: z.literal("excluded"), view: z.literal("sensitive") }).strict()
    .refine(completeTicketSteps, "SAV_INTAKE_VERIFIED_EFFECT_REQUIRED"),
  z.object({ kind: z.literal("qualified_other"), classification: z.literal("other"), classificationRule: savIntakePrivateResourceSchema, evidenceIds: refs, view: z.literal("other") }).strict(),
  z.object({ kind: z.literal("completed"), classification: z.enum(["support", "finance", "cancellation"]), closureEvidenceIds: refs,
    balance: z.enum(["complete", "not_applicable_sensitive"]), balanceEvidenceIds: z.array(ref).max(100),
    completionRule: z.literal("closed_and_balance_finished"),
    knowledgeCandidateStatus: z.enum(["none", "awaiting_validation", "awaiting_publication", "published", "discarded", "unknown"]).optional(),
    view: z.literal("completed"),
  }).strict().refine(value => value.balance === "complete" ? value.balanceEvidenceIds.length > 0 : value.classification !== "support", "SAV_INTAKE_RESOLUTION_BALANCE_REQUIRED"),
]);

export type SavIntakeProgress = z.infer<typeof savIntakeProgressSchema>;

export type SavIntakeSpecificationCase = {
  id: string;
  requirement: "classification" | "identity" | "routing" | "learning" | "delivery" | "views";
  facts: readonly string[];
  expected: readonly string[];
};
