import { describe, expect, it } from "vitest";
import {
  SAV_INTAKE_CONTRACT_REVISION, savIntakeDecisionSchema, savIntakeProgressSchema,
  savIntakeStepReceiptSchema, savIntakeViewSchema, savIntakeViewLabels, type SavIntakeDecision,
} from "./contract";

const messageId = "10000000-0000-4000-8000-000000000001";
const resource = { resourceId: "synthetic-resource", revisionId: "synthetic-v1", sha256: "0".repeat(64) };
const noteSource = () => ({ sourceMessageId: messageId, sourceEvidenceIds: ["current"], renderedContentHash: "a".repeat(43), deduplication: "source_message_and_final_ticket" as const });
const returnSummary = (previousState: "open" | "closed", warning: typeof resource | null = null) => ({
  kind: "existing_return_summary" as const, version: 2 as const, previousState,
  warningPrefix: warning ? { placement: "before_summary" as const, resource: warning } : null, ...noteSource(),
});
const warningOnly = () => ({ kind: "multi_ticket_warning_only" as const, warningResource: resource, ...noteSource() });
const evidence = (id: string, source: "current_message" | "crm_contact" | "crm_ticket", sourceId: string) => ({
  id, source, sourceId, observedAt: "2026-10-20T09:00:00.000Z", contentHash: "a".repeat(43),
});
const targetBinding = () => ({ ticketEvidenceId: "ticket", contactAssociationEvidenceId: "ticket-contact" });
const ticketContactEvidence = (ticketId: string, contactId: string, id = "ticket-contact") => ({
  ...evidence(id, "crm_ticket", `synthetic-association-${ticketId}-${contactId}`),
  source: "ticket_contact_association" as const, ticketId, contactId, direction: "ticket_to_contact" as const,
});
function ticketDecision(): SavIntakeDecision {
  return {
    revision: SAV_INTAKE_CONTRACT_REVISION, messageId, latestInboundMessageId: messageId,
    threadId: "20000000-0000-4000-8000-000000000001", receivedAt: "2026-10-20T09:00:00.000Z",
    classification: "support",
    requests: [{ id: "request-1", kind: "support", evidenceIds: ["current"] }],
    evidence: [evidence("current", "current_message", messageId), evidence("contact", "crm_contact", "101"), evidence("ticket", "crm_ticket", "201"), ticketContactEvidence("201", "101")],
    disposition: {
      kind: "ticket", target: { operation: "link", contactId: "101", ticketId: "201", alreadyNew: false, ...targetBinding() },
      requestIds: ["request-1"],
      contactScope: { primaryContactId: "101", contacts: [{ origin: "email_lookup", addressOrigin: "sender", contactId: "101", evidenceIds: ["contact"] }], complete: true },
      search: "complete", history: "complete",
      identity: { kind: "unique_crm_match_for_intake", addressOrigin: "sender", scope: "intake_only", evidenceIds: ["current", "contact"] },
      sameIssueEvidenceIds: ["current", "ticket"], requiredPermissions: ["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"],
      multiTicketNote: { openTicketIdsOnTargetContact: ["201"] },
      note: returnSummary("open"),
      learning: "eligible_after_confirmed_effect", evidenceIds: ["current", "contact", "ticket", "ticket-contact"],
    },
  };
}
function plan() {
  const decision = ticketDecision();
  if (decision.disposition.kind !== "ticket") throw new Error("INVALID_TEST_FIXTURE");
  return { decision, ticket: decision.disposition };
}
function creationPlan() {
  const { decision, ticket } = plan();
  ticket.target = { operation: "create", contactId: "101", predecessor: null, selection: { kind: "retained_email_match" } };
  ticket.multiTicketNote.openTicketIdsOnTargetContact = []; ticket.note = null;
  ticket.requiredPermissions = ["create_ticket", "associate_email"];
  return { decision, ticket };
}
function relatedPlan() {
  const { decision, ticket } = plan();
  ticket.contactScope.contacts.push({ origin: "direct_association", contactId: "102", fromContactId: "101", associationTypeId: 123,
    associationCategory: "USER_DEFINED", direction: "primary_to_contact", relationPolicyRevisionId: "synthetic-policy", evidenceIds: ["related", "association"] });
  decision.evidence.push(evidence("related", "crm_contact", "102"), { ...evidence("association", "crm_contact", "101:102:123"), source: "contact_association" });
  return { decision, ticket };
}

describe("autonomous intake design contract, without providers or activation", () => {
  it("accepts a scoped plan requiring separate permissions", () => {
    expect(savIntakeDecisionSchema.safeParse(ticketDecision()).success).toBe(true);
  });
  it.each(["partnership", "commercial", "investor"] as const)("keeps a pure %s request outside ticket intake and preserves a support request in the inverse case", kind => {
    const { decision, ticket } = plan(); decision.requests[0].kind = kind;
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    decision.classification = kind;
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    const nextAction = ({ partnership: "supervised_partnership", commercial: "supervised_commercial", investor: "supervised_investor" } as const)[kind];
    decision.disposition = { kind: "no_ticket", reason: "outside_support", nextAction, learning: "excluded", evidenceIds: ["current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    decision.requests[0].kind = "support";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    decision.classification = "support"; decision.disposition = ticket;
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it.each(["partnership", "commercial", "investor"] as const)("retains one support ticket when the mail also contains a %s request", kind => {
    const { decision, ticket } = plan();
    decision.requests.push({ id: "outside-request", kind, evidenceIds: ["current"] }); ticket.requestIds.push("outside-request");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    decision.classification = kind;
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it.each(["finance", "cancellation"] as const)("preserves %s precedence over support and commercial requests", kind => {
    const { decision, ticket } = plan();
    decision.requests.push({ id: "commercial", kind: "commercial", evidenceIds: ["current"] }, { id: "sensitive", kind, evidenceIds: ["current"] });
    ticket.requestIds.push("commercial", "sensitive"); decision.classification = kind; ticket.learning = "excluded";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    decision.classification = "commercial";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it.each(["empty", "unknown", "support_and_unknown"] as const)("requires bounded classification context for %s, without forcing Other", scenario => {
    const decision = ticketDecision();
    decision.requests = scenario === "empty" ? [] : [{ id: "unknown", kind: "unknown", evidenceIds: ["current"] }];
    if (scenario === "support_and_unknown") decision.requests.push({ id: "support", kind: "support", evidenceIds: ["current"] });
    decision.classification = "unknown";
    decision.disposition = { kind: "collect_context", reasons: ["classification_incomplete"], evidenceIds: ["current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    decision.disposition.reasons = ["history_incomplete"];
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    decision.classification = "other";
    decision.evidence.push({ ...evidence("rule", "current_message", messageId), source: "private_rule" });
    decision.disposition = { kind: "no_ticket", reason: "qualified_other", nextAction: "none", learning: "excluded", evidenceIds: ["current", "rule"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("keeps known finance precedence while collecting an unresolved request", () => {
    const decision = ticketDecision(); decision.classification = "finance";
    decision.requests = [{ id: "finance", kind: "finance", evidenceIds: ["current"] }, { id: "unknown", kind: "unknown", evidenceIds: ["current"] }];
    decision.disposition = { kind: "collect_context", reasons: ["classification_incomplete"], evidenceIds: ["current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    decision.classification = "unknown";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("collects context for multiple pure outside-support intents instead of dropping one", () => {
    const decision = ticketDecision(); decision.classification = "mixed";
    decision.requests = [{ id: "partnership", kind: "partnership", evidenceIds: ["current"] }, { id: "investor", kind: "investor", evidenceIds: ["current"] }];
    decision.disposition = { kind: "collect_context", reasons: ["classification_incomplete"], evidenceIds: ["current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    decision.classification = "investor";
    decision.disposition = { kind: "no_ticket", reason: "outside_support", nextAction: "supervised_investor", learning: "excluded", evidenceIds: ["current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("accepts a consistently classified acknowledgement without a ticket", () => {
    const decision = ticketDecision(); decision.classification = "acknowledgement"; decision.requests[0].kind = "acknowledgement";
    decision.disposition = { kind: "no_ticket", reason: "acknowledgement_only", nextAction: "none", learning: "excluded", evidenceIds: ["current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("accepts a customer-declared unique CRM match for intake only", () => {
    const { decision, ticket } = plan();
    ticket.identity.addressOrigin = "customer_declared_registration";
    ticket.contactScope.contacts[0] = { origin: "email_lookup", addressOrigin: "customer_declared_registration", contactId: "101", evidenceIds: ["contact", "current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("rejects an unproved declaration or missing CRM contact evidence", () => {
    const { decision, ticket } = plan();
    ticket.identity.addressOrigin = "customer_declared_registration";
    ticket.contactScope.contacts[0] = { origin: "email_lookup", addressOrigin: "customer_declared_registration", contactId: "101", evidenceIds: ["contact"] };
    ticket.identity.evidenceIds = ["contact"];
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.identity.evidenceIds = ["current"];
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("rejects a ticket target outside the allowed contact scope", () => {
    const { decision, ticket } = plan(); ticket.target.contactId = "999";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it.each(["link", "reopen"] as const)("rejects a valid %s ticket ID bound to the wrong in-scope contact", operation => {
    const { decision, ticket } = relatedPlan();
    ticket.target = operation === "link" ? { operation, contactId: "102", ticketId: "201", alreadyNew: false, ...targetBinding() }
      : { operation, contactId: "102", ticketId: "201", preserveOwnerId: null, ...targetBinding() };
    if (operation === "reopen") { ticket.multiTicketNote.openTicketIdsOnTargetContact = []; ticket.note = returnSummary("closed"); }
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    const association = decision.evidence.find(item => item.id === "ticket-contact");
    if (association?.source !== "ticket_contact_association") throw new Error("INVALID_TEST_FIXTURE");
    association.contactId = "102";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("requires the selected ticket's CRM proof in the same-issue evidence", () => {
    const { decision, ticket } = plan();
    if (ticket.target.operation !== "link") throw new Error("INVALID_TEST_FIXTURE");
    ticket.target.ticketEvidenceId = "contact";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.target.ticketEvidenceId = "ticket";
    const snapshot = decision.evidence.find(item => item.id === "ticket");
    if (!snapshot) throw new Error("INVALID_TEST_FIXTURE");
    snapshot.sourceId = "202";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    snapshot.sourceId = "201"; ticket.sameIssueEvidenceIds = ["current"];
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.sameIssueEvidenceIds.push("ticket");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("requires an explicit ticket-contact association, not an unrelated evidence role", () => {
    const { decision, ticket } = plan();
    if (ticket.target.operation !== "link") throw new Error("INVALID_TEST_FIXTURE");
    ticket.target.contactAssociationEvidenceId = "contact";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.target.contactAssociationEvidenceId = "missing-association";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("binds a predecessor to its actual linked contact without moving the new retained-email target", () => {
    const { decision, ticket } = relatedPlan();
    decision.evidence.push(ticketContactEvidence("201", "102", "predecessor-contact"));
    ticket.target = { operation: "create", contactId: "101", predecessor: { ticketId: "201", contactId: "102", ticketEvidenceId: "ticket", contactAssociationEvidenceId: "predecessor-contact" }, selection: { kind: "retained_email_match" } };
    ticket.multiTicketNote.openTicketIdsOnTargetContact = []; ticket.note = null; ticket.requiredPermissions = ["create_ticket", "associate_email"];
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    const predecessor = ticket.target.predecessor;
    if (!predecessor) throw new Error("INVALID_TEST_FIXTURE");
    predecessor.contactId = "101";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    predecessor.contactId = "102"; predecessor.ticketId = "202";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    expect(savIntakeDecisionSchema.safeParse({ ...decision, disposition: { ...ticket,
      target: { ...ticket.target, predecessor: { ticketId: "201", contactId: "102" } } } }).success).toBe(false);
  });
  it("rejects an incomplete relationship search", () => {
    const { decision, ticket } = plan(); ticket.contactScope.complete = false;
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("rejects a transitive association passed off as direct", () => {
    const { decision, ticket } = plan();
    ticket.contactScope.contacts.push({ origin: "direct_association", contactId: "102", fromContactId: "999", associationTypeId: 123,
      associationCategory: "USER_DEFINED", direction: "primary_to_contact", relationPolicyRevisionId: "synthetic-policy", evidenceIds: ["contact"] });
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("requires both a related contact snapshot and association evidence", () => {
    const { decision, ticket } = plan();
    ticket.contactScope.contacts.push({ origin: "direct_association", contactId: "102", fromContactId: "101", associationTypeId: 123,
      associationCategory: "USER_DEFINED", direction: "primary_to_contact", relationPolicyRevisionId: "synthetic-policy", evidenceIds: ["related", "association"] });
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    decision.evidence.push(evidence("related", "crm_contact", "102"));
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    decision.evidence.push({ ...evidence("association", "crm_contact", "101:102:123"), source: "contact_association" });
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("preserves every request in one ticket", () => {
    const { decision, ticket } = plan();
    decision.requests.push({ id: "request-2", kind: "support", evidenceIds: ["current"] });
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.requestIds.push("request-2");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("requires sensitive classification and excludes the entire mixed ticket from learning", () => {
    const { decision, ticket } = plan();
    decision.requests.push({ id: "request-2", kind: "finance", evidenceIds: ["current"] }); ticket.requestIds.push("request-2");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    decision.classification = "finance";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.learning = "excluded";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it.each(["finance", "cancellation"] as const)("already rejects %s hidden in Other at the root guard", kind => {
    const decision = ticketDecision(); decision.classification = "other";
    decision.requests = [{ id: "sensitive-request", kind, evidenceIds: ["current"] }];
    decision.evidence.push({ ...evidence("rule", "current_message", messageId), source: "private_rule" });
    decision.disposition = { kind: "no_ticket", reason: "qualified_other", nextAction: "none", learning: "excluded", evidenceIds: ["current", "rule"] };
    const result = savIntakeDecisionSchema.safeParse(decision);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("UNEXPECTED_VALIDATION_SUCCESS");
    expect(result.error.issues.map(issue => issue.message)).toContain("SAV_INTAKE_SENSITIVE_PRECEDENCE_REQUIRED");
  });
  it("accepts an already classified credits usage question as support, without claiming NLP evaluation", () => {
    const decision = ticketDecision(); decision.requests[0].id = "credits-how-to";
    if (decision.disposition.kind !== "ticket") throw new Error("INVALID_TEST_FIXTURE");
    decision.disposition.requestIds = ["credits-how-to"];
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("rejects an unrelated requested mutation", () => {
    const { decision, ticket } = plan(); ticket.requiredPermissions.push("create_ticket");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("requires a note resource only when multiple tickets are open on the target contact", () => {
    const { decision, ticket } = plan(); ticket.multiTicketNote.openTicketIdsOnTargetContact.push("202");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.note = returnSummary("open", resource);
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("links an already-New single ticket with email association and no extra note", () => {
    const { decision, ticket } = plan();
    ticket.target = { operation: "link", contactId: "101", ticketId: "201", alreadyNew: true, ...targetBinding() };
    ticket.requiredPermissions = ["link_ticket", "associate_email"]; ticket.note = null;
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    ticket.note = returnSummary("open"); ticket.requiredPermissions.push("append_ticket_note");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("keeps the existing return summary when changing status to New", () => {
    const { decision, ticket } = plan(); ticket.note = null;
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.note = returnSummary("closed");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.note = returnSummary("open");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("uses only the private warning on an already-New multi-ticket contact", () => {
    const { decision, ticket } = plan();
    ticket.target = { operation: "link", contactId: "101", ticketId: "201", alreadyNew: true, ...targetBinding() };
    ticket.requiredPermissions = ["link_ticket", "associate_email", "append_ticket_note"];
    ticket.multiTicketNote = { openTicketIdsOnTargetContact: ["201", "202"] };
    ticket.note = warningOnly();
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    ticket.note = returnSummary("open");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("binds note content/source and deduplication to the source message and final ticket", () => {
    const { decision, ticket } = plan();
    ticket.note = { ...returnSummary("open"), sourceMessageId: "10000000-0000-4000-8000-000000000002" };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.note = { ...returnSummary("open"), sourceEvidenceIds: ["ticket"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    expect(savIntakeDecisionSchema.safeParse({ ...decision, disposition: { ...ticket,
      note: { ...returnSummary("open"), deduplication: "attempt_id" } } }).success).toBe(false);
  });
  it.each(["create", "reopen"] as const)("counts a %s target as open when preparing the warning", operation => {
    const { decision, ticket } = plan();
    ticket.target = operation === "create" ? { operation, contactId: "101", predecessor: null, selection: { kind: "retained_email_match" } }
      : { operation, contactId: "101", ticketId: "201", preserveOwnerId: "301", ...targetBinding() };
    if (operation === "reopen") ticket.multiTicketNote.openTicketIdsOnTargetContact = ["202"];
    ticket.requiredPermissions = operation === "create" ? ["create_ticket", "associate_email", "append_ticket_note"]
      : ["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"];
    ticket.note = null;
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.note = operation === "create" ? warningOnly() : returnSummary("closed", resource);
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("preserves an explicitly unassigned owner on reopen", () => {
    const { decision, ticket } = plan();
    ticket.target = { operation: "reopen", contactId: "101", ticketId: "201", preserveOwnerId: null, ...targetBinding() };
    ticket.multiTicketNote.openTicketIdsOnTargetContact = []; ticket.note = returnSummary("closed");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("rejects an unknown reopen owner while allowing targeted context collection", () => {
    const { decision, ticket } = plan();
    expect(savIntakeDecisionSchema.safeParse({ ...decision, disposition: { ...ticket,
      target: { operation: "reopen", contactId: "101", ticketId: "201", ...targetBinding() }, note: returnSummary("closed"),
      multiTicketNote: { openTicketIdsOnTargetContact: [] } } }).success).toBe(false);
    expect(savIntakeDecisionSchema.safeParse({ ...decision, disposition: { kind: "collect_context", reasons: ["ticket_owner_unknown"], evidenceIds: ["ticket"] } }).success).toBe(true);
  });
  it.each(["link", "reopen"] as const)("requires both the ordered warning prefix and existing summary on multi-ticket %s", operation => {
    const { decision, ticket } = plan();
    const previousState = operation === "reopen" ? "closed" : "open";
    ticket.target = operation === "reopen" ? { operation, contactId: "101", ticketId: "201", preserveOwnerId: null, ...targetBinding() }
      : { operation, contactId: "101", ticketId: "201", alreadyNew: false, ...targetBinding() };
    ticket.multiTicketNote.openTicketIdsOnTargetContact = operation === "reopen" ? ["202"] : ["201", "202"];
    ticket.note = returnSummary(previousState, resource);
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    ticket.note.warningPrefix = null;
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.note = warningOnly();
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.note = { ...returnSummary(previousState, resource), sourceMessageId: "10000000-0000-4000-8000-000000000002" };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    expect(savIntakeDecisionSchema.safeParse({ ...decision, disposition: { ...ticket,
      note: { ...returnSummary(previousState, resource), warningPrefix: { placement: "after_summary", resource } } } }).success).toBe(false);
    expect(savIntakeDecisionSchema.safeParse({ ...decision, disposition: { ...ticket,
      note: { ...returnSummary(previousState, resource), deduplication: "attempt_id" } } }).success).toBe(false);
  });
  it("creates on the retained email contact by default", () => {
    const { decision, ticket } = creationPlan();
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    ticket.target.contactId = "102";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("requires an evidenced human choice only between multiple equivalent contacts", () => {
    const { decision, ticket } = creationPlan();
    ticket.contactScope.contacts.push({ origin: "direct_association", contactId: "102", fromContactId: "101", associationTypeId: 123,
      associationCategory: "USER_DEFINED", direction: "primary_to_contact", relationPolicyRevisionId: "synthetic-policy", evidenceIds: ["related", "association"] });
    decision.evidence.push(evidence("related", "crm_contact", "102"), { ...evidence("association", "crm_contact", "101:102:123"), source: "contact_association" });
    ticket.target = { operation: "create", contactId: "102", predecessor: null, selection: { kind: "retained_email_match" } };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    ticket.target.selection = { kind: "human_equivalent_contacts", equivalentContactIds: ["101", "102"], choiceEvidenceId: "choice" };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    decision.evidence.push({ ...evidence("choice", "crm_contact", "synthetic-selection"), source: "human_override" });
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    ticket.target.selection.equivalentContactIds = ["102"];
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("rejects stale source IDs, without claiming to prove dispatch-time freshness", () => {
    const { decision } = plan(); decision.latestInboundMessageId = "10000000-0000-4000-8000-000000000002";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("requires every referenced evidence ID to exist", () => {
    const { decision, ticket } = plan(); ticket.sameIssueEvidenceIds.push("missing");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("binds current-message evidence to the actual source message", () => {
    const { decision } = plan(); decision.evidence[0].sourceId = "another-message";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("keeps no-contact and alternate-address-not-found variants distinct", () => {
    const decision = ticketDecision();
    decision.disposition = { kind: "request_identification", lookup: "complete_without_contact", reason: "sender_contact_absent",
      identificationAttemptId: "synthetic-attempt", declaredAddressEvidenceIds: [],
      template: { ...resource, variant: "initial_registration_request", language: "fr", additionalFooter: false },
      permissionRequired: "send_identity_template", learning: "not_started", evidenceIds: ["current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    decision.disposition.reason = "declared_registration_address_absent";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    decision.disposition.declaredAddressEvidenceIds = ["current"];
    decision.disposition.template.variant = "registration_address_not_found";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("requires a qualified private rule or override for Other", () => {
    const decision = ticketDecision(); decision.classification = "other";
    decision.requests[0].kind = "other";
    decision.disposition = { kind: "no_ticket", reason: "qualified_other", nextAction: "none", learning: "excluded", evidenceIds: ["current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
    decision.evidence.push({ ...evidence("rule", "current_message", messageId), source: "private_rule" }); decision.disposition.evidenceIds.push("rule");
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
  });
  it("keeps investor forwarding supervised and outside identification", () => {
    const decision = ticketDecision(); decision.classification = "investor";
    decision.requests[0].kind = "investor";
    decision.disposition = { kind: "no_ticket", reason: "outside_support", nextAction: "supervised_investor", learning: "excluded", evidenceIds: ["current"] };
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
    decision.disposition.nextAction = "supervised_partnership";
    expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
  });
  it("does not turn queued or acknowledged sends into Missing contact", () => {
    const receipt = { stepId: "step-1", attemptId: "attempt-1", messageId, targetTicketId: null, mutation: "send_identity_template", outcome: { kind: "queued" } };
    expect(savIntakeStepReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(savIntakeProgressSchema.safeParse({ kind: "identity_wait", templateReceipt: receipt, view: "missing_contact" }).success).toBe(false);
    expect(savIntakeProgressSchema.safeParse({ kind: "identity_wait", templateReceipt: { ...receipt, outcome: { kind: "confirmed", providerReceiptId: "provider-1", verifiedAt: "2026-10-20T09:00:00.000Z", verificationEvidenceIds: ["receipt-proof"] } }, view: "missing_contact" }).success).toBe(true);
  });
  it("requires every planned step and the right ticket before learning follow-up", () => {
    const receipt = { stepId: "step-1", attemptId: "attempt-1", messageId, targetTicketId: "201", mutation: "link_ticket",
      outcome: { kind: "confirmed", providerReceiptId: "provider-1", verifiedAt: "2026-10-20T09:00:00.000Z", verificationEvidenceIds: ["receipt-proof"] } };
    const progress = { kind: "learning_followup", messageId, attemptId: "attempt-1", classification: "support", ticketId: "201", requiredStepIds: ["step-1", "step-2"], receipts: [receipt], learningObservationId: "observation-1", view: "learning" };
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(false);
    progress.receipts.push({ ...receipt, stepId: "step-2", mutation: "associate_email", targetTicketId: "999" });
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(false);
    progress.receipts[1].targetTicketId = "201";
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(true);
  });
  it.each(["learning_followup", "sensitive_followup"] as const)("binds %s receipts to the current message and attempt", kind => {
    const receipt = { stepId: "step-1", attemptId: "attempt-current", messageId, targetTicketId: "201", mutation: "link_ticket",
      outcome: { kind: "confirmed", providerReceiptId: "provider-1", verifiedAt: "2026-10-20T09:00:00.000Z", verificationEvidenceIds: ["receipt-proof"] } };
    const progress = { kind, messageId, attemptId: "attempt-current", ticketId: "201", requiredStepIds: ["step-1", "step-2"],
      receipts: [receipt, { ...receipt, stepId: "step-2", mutation: "associate_email" }],
      ...(kind === "learning_followup" ? { classification: "support", learningObservationId: "observation-1", view: "learning" }
        : { classification: "finance", learning: "excluded", view: "sensitive" }) };
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(true);
    expect(savIntakeProgressSchema.safeParse({ ...progress, messageId: undefined }).success).toBe(false);
    expect(savIntakeProgressSchema.safeParse({ ...progress, attemptId: undefined }).success).toBe(false);
    progress.receipts[1].messageId = "10000000-0000-4000-8000-000000000002";
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(false);
    progress.receipts[1].messageId = messageId; progress.receipts[1].attemptId = "attempt-older";
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(false);
    progress.receipts[0].attemptId = "attempt-older";
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(false);
  });
  it("keeps technical retries out of human arbitration", () => {
    expect(savIntakeProgressSchema.safeParse({ kind: "retry_scheduled", retryAt: "2026-10-20T09:01:00.000Z", reasonCode: "SYNTHETIC_UNAVAILABLE", view: null }).success).toBe(true);
    expect(savIntakeProgressSchema.safeParse({ kind: "retry_scheduled", retryAt: "2026-10-20T09:01:00.000Z", reasonCode: "SYNTHETIC_UNAVAILABLE", view: "to_validate" }).success).toBe(false);
  });
  it("keeps six views with To validate replacing the arbitration-only title", () => {
    expect(savIntakeViewSchema.options).toHaveLength(6);
    expect(savIntakeViewLabels.to_validate).toBe("À valider");
    expect(savIntakeViewSchema.safeParse("needs_arbitration").success).toBe(false);
  });
  it.each(["partnership", "commercial", "investor"] as const)("places the normal supervised %s action in To validate, never Other", classification => {
    const action = ({ partnership: "supervised_partnership", commercial: "supervised_commercial", investor: "supervised_investor" } as const)[classification];
    const progress = { kind: "supervised_action", messageId, classification, action, approval: "human_confirmation_required", evidenceIds: ["current"], view: "to_validate" };
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(true);
    expect(savIntakeProgressSchema.safeParse({ ...progress, view: "other" }).success).toBe(false);
    expect(savIntakeProgressSchema.safeParse({ ...progress, approval: "automatic" }).success).toBe(false);
    expect(savIntakeProgressSchema.safeParse({ kind: "qualified_other", classification, classificationRule: resource, evidenceIds: ["current"], view: "other" }).success).toBe(false);
  });
  it("distinguishes a targeted support choice from routine supervised outside-support actions", () => {
    const choice = { kind: "human_choice", messageId, classification: "support", questionCode: "equivalent_ticket_choice", investigation: "bounded_investigation_complete", evidenceIds: ["current", "ticket"], view: "to_validate" };
    expect(savIntakeProgressSchema.safeParse(choice).success).toBe(true);
    expect(savIntakeProgressSchema.safeParse({ ...choice, questionCode: "human_review_required" }).success).toBe(false);
    expect(savIntakeProgressSchema.safeParse({ ...choice, investigation: undefined }).success).toBe(false);
    expect(savIntakeProgressSchema.safeParse({ kind: "supervised_action", messageId, classification: "support", action: "supervised_commercial", approval: "human_confirmation_required", evidenceIds: ["current"], view: "to_validate" }).success).toBe(false);
  });
  it.each(["awaiting_validation", "awaiting_publication"] as const)("allows completion after closure and finished balance with knowledge %s", knowledgeCandidateStatus => {
    const progress = { kind: "completed", classification: "support", closureEvidenceIds: ["closure-proof"], balance: "complete", balanceEvidenceIds: ["balance-proof"], completionRule: "closed_and_balance_finished", knowledgeCandidateStatus, view: "completed" };
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(true);
    expect(savIntakeProgressSchema.safeParse({ ...progress, balanceEvidenceIds: [] }).success).toBe(false);
    expect(savIntakeProgressSchema.safeParse({ ...progress, closureEvidenceIds: [] }).success).toBe(false);
  });
  it("keeps sensitive completion outside learning", () => {
    const progress = { kind: "completed", classification: "finance", closureEvidenceIds: ["closure-proof"], balance: "not_applicable_sensitive", balanceEvidenceIds: [], completionRule: "closed_and_balance_finished", knowledgeCandidateStatus: "none", view: "completed" };
    expect(savIntakeProgressSchema.safeParse(progress).success).toBe(true);
    expect(savIntakeProgressSchema.safeParse({ ...progress, classification: "support" }).success).toBe(false);
  });
  it("does not retain policy-pending branches for product choices already settled", () => {
    expect(savIntakeDecisionSchema.safeParse({ ...ticketDecision(), disposition: { kind: "awaiting_policy", questions: ["creation_contact"], evidenceIds: ["current"] } }).success).toBe(false);
    expect(savIntakeProgressSchema.safeParse({ kind: "policy_pending", questions: ["outside_support_view"], view: null }).success).toBe(false);
  });
});

it("requires an explicit authenticated newsletter qualification for a no-request Other",()=>{
 const decision=ticketDecision();decision.requests=[];decision.classification="other";
 decision.evidence.push({...evidence("rule","current_message",messageId),source:"private_rule"});
 decision.disposition={kind:"no_ticket",reason:"qualified_other",qualifiedInformation:"authenticated_newsletter",nextAction:"none",learning:"excluded",evidenceIds:["current","rule"]};
 expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(true);
 decision.evidence=decision.evidence.filter(e=>e.id!=="rule");expect(savIntakeDecisionSchema.safeParse(decision).success).toBe(false);
});
