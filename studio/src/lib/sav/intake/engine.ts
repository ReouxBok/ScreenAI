import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SAV_INTAKE_CONTRACT_REVISION, savIntakeDecisionSchema, savIntakePrivateResourceSchema,
  type SavIntakeDecision, type SavIntakeProgress,
} from "./contract";
import { SAV_TICKET_RETURN_NOTE_VERSION, savTicketReturnNote } from "../ticket-return-note";
import {
  intakeMessageSchema, intakeContactSchema, intakeAssociationSchema, intakeTicketSchema, intakeHistorySchema,
  messageAnalysisSchema, issueAssessmentSchema,
  type EngineInput, type EngineLimits, type EnginePolicy, type IntakeAdapters, type IntakeContact,
  type IntakeEvidence, type IntakePlan, type IntakeTicket, type ReadResult, type PrivateResource,
} from "./engine-types";

type ContextReason = Extract<SavIntakeDecision["disposition"], { kind: "collect_context" }>["reasons"][number];
class ContextFault extends Error { constructor(readonly reason: ContextReason) { super(reason); } }
const fail = (reason: ContextReason): never => { throw new ContextFault(reason); };
const normalizeEmail = (email: string) => email.trim().toLowerCase();
const sha = (value: string) => createHash("sha256").update(value).digest("base64url");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const unique = <T>(values: T[]) => [...new Set(values)];
const validTime = (value: string | undefined) => value !== undefined && Number.isFinite(Date.parse(value));
const DAY = 86_400_000;

/** Read and plan only. There is deliberately no write, model client, DB or dispatch dependency. */
export async function planSavIntake(
  input: EngineInput, adapters: IntakeAdapters, policy: EnginePolicy, overrides: Partial<EngineLimits> = {},
): Promise<IntakePlan> {
  const message = intakeMessageSchema.parse(input.message);
  if (!validTime(input.now) || Date.parse(input.now) < Date.parse(message.receivedAt)
    || !z.uuid().safeParse(input.latestInboundMessageId).success
    || !["at_receipt", "current"].includes(input.mode)
    || !input.identificationAttemptId.trim()) throw new Error("SAV_INTAKE_INPUT_INVALID");
  const limits = { readCalls: 50, timeoutMs: 2000, contacts: 10, tickets: 20, ...overrides };
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 1)
    || limits.contacts > 10 || limits.tickets > 20 || limits.readCalls > 100 || limits.timeoutMs > 10_000) throw new Error("SAV_INTAKE_LIMITS_INVALID");
  let calls = 0;
  const evidence: IntakeEvidence[] = [];
  const addEvidence = (id: string, source: IntakeEvidence["source"], sourceId: string, value: unknown, observedAt = input.now) => {
    if (evidence.length >= 95 || evidence.some(e => e.id === id)) fail("history_incomplete");
    evidence.push({ id, source, sourceId, observedAt, contentHash: sha(canonical(value)) } as IntakeEvidence);
    return id;
  };
  const current = addEvidence("current", "current_message", message.id, message);
  let classification: SavIntakeDecision["classification"] = "unknown";
  let requests: SavIntakeDecision["requests"] = [];
  let noteText: string | null = null;
  let newTicket: IntakePlan["newTicket"];
  const finalize = (disposition: SavIntakeDecision["disposition"], progress: SavIntakeProgress = { kind: "processing", phase: "context", view: null }, supervisedResource?: PrivateResource): IntakePlan => {
    const decision = savIntakeDecisionSchema.parse({
      revision: SAV_INTAKE_CONTRACT_REVISION, messageId: message.id, latestInboundMessageId: input.latestInboundMessageId,
      threadId: message.threadId, receivedAt: message.receivedAt, classification, requests,
      evidence: [...evidence].sort((a, b) => a.id.localeCompare(b.id)), disposition,
    });
    const mutations = disposition.kind === "ticket" ? disposition.requiredPermissions : disposition.kind === "request_identification" ? [disposition.permissionRequired] : [];
    const ticketId = disposition.kind === "ticket" && disposition.target.operation !== "create" ? disposition.target.ticketId : null;
    return {
      revision: "sav-intake-engine-2026-10-20.v1", decision,
      steps: mutations.map(mutation => ({ id: `${message.id}:${mutation}`, mutation, requiresPermission: mutation, ticketId, status: "not_dispatched" as const })),
      progress, noteText: disposition.kind === "ticket" ? noteText : null, ...(supervisedResource ? { supervisedResource } : {}),
      ...(disposition.kind === "ticket" && disposition.target.operation === "create" && newTicket ? { newTicket } : {}),
      originalThreadId: message.threadId, originalRecipientEmails: [message.fromEmail], referenceMode: input.mode,
      readCalls: calls, effects: "not_connected",
    };
  };
  const context = (reason: ContextReason, choice?: "equivalent_contact_choice" | "equivalent_ticket_choice" | "same_issue_uncertain") => finalize(
    { kind: "collect_context", reasons: unique([reason, ...(!requests.length || requests.some(r => r.kind === "unknown") || classification === "mixed" ? ["classification_incomplete" as const] : [])]), evidenceIds: [current] },
    choice ? { kind: "human_choice", messageId: message.id, classification: classification === "cancellation" || classification === "finance" ? classification : "support", questionCode: choice, investigation: "bounded_investigation_complete", evidenceIds: [current], view: "to_validate" }
      : { kind: "processing", phase: reason.startsWith("classification") ? "classification" : "context", view: null },
  );
  async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, reason: ContextReason): Promise<T> {
    if (calls >= limits.readCalls) fail(reason);
    calls++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ContextFault(reason)); }, limits.timeoutMs);
      })]);
    } catch { return fail(reason); }
    finally { if (timer) clearTimeout(timer); }
  }
  function complete<T>(result: ReadResult<unknown>, schema: z.ZodType<T>, reason: ContextReason): T {
    if (!result || result.status !== "complete" || !validTime(result.observedAt) || Date.parse(result.observedAt) > Date.parse(input.now)) fail(reason);
    const parsed = schema.safeParse(result.data);
    if (!parsed.success) return fail(reason);
    return parsed.data;
  }
  try {
    if (message.id !== input.latestInboundMessageId || message.direction !== "inbound") return context("history_incomplete");
    if (!message.contentComplete || !message.currentText.trim()) return context("classification_incomplete");
    const conversation = complete(input.conversation, z.array(intakeMessageSchema).max(50), "history_incomplete");
    if (new Set(conversation.map(m => m.id)).size !== conversation.length || conversation.some(m => m.threadId !== message.threadId
      || Date.parse(m.receivedAt) > Date.parse(message.receivedAt))) return context("history_incomplete");
    const parsedAnalysis = messageAnalysisSchema.safeParse(await bounded(signal => adapters.analyseMessage({ message, conversation }, signal), "classification_incomplete"));
    if (!parsedAnalysis.success) return context("classification_incomplete");
    const analysis = parsedAnalysis.data;
    if (analysis.messageId !== message.id || analysis.requests.some(r => r.currentMessageId !== message.id)
      || new Set(analysis.requests.map(r => r.id)).size !== analysis.requests.length) return context("classification_incomplete");
    requests = analysis.requests.map(({ id, kind }) => ({ id, kind, evidenceIds: [current] }));
    const kinds = unique(requests.map(r => r.kind));
    classification = kinds.includes("cancellation") ? "cancellation" : kinds.includes("finance") ? "finance"
      : kinds.includes("unknown") || !kinds.length ? "unknown" : kinds.includes("support") ? "support"
      : kinds.filter(k => ["commercial", "investor", "partnership"].includes(k)).length > 1 ? "mixed"
      : kinds.find(k => ["commercial", "investor", "partnership"].includes(k)) ?? kinds[0];
    if (!requests.length || kinds.includes("unknown") || classification === "mixed") return context("classification_incomplete");
    if (policy.manualSupportOverride && classification === "other") {
      // Recompute from the current message. An override is not a fabricated support request.
      return context("classification_incomplete");
    }
    if (["other", "acknowledgement", "partnership", "commercial", "investor"].includes(classification)) {
      const outside = classification as "other" | "acknowledgement" | "partnership" | "commercial" | "investor";
      let ruleId: string | undefined;
      if (outside === "other") {
        if (!policy.qualifiedOther) return context("classification_incomplete");
        const resource = savIntakePrivateResourceSchema.parse(policy.qualifiedOther.resource);
        ruleId = addEvidence("classification-rule", policy.qualifiedOther.evidenceSource, resource.resourceId, resource);
      }
      const resource = outside === "other" || outside === "acknowledgement" ? undefined : policy.resources[outside];
      if (!["other", "acknowledgement"].includes(outside) && !resource) return context("private_resource_unavailable");
      if (resource) savIntakePrivateResourceSchema.parse(resource);
      const ids = ruleId ? [current, ruleId] : [current];
      const action = outside === "partnership" ? "supervised_partnership" : outside === "commercial" ? "supervised_commercial" : outside === "investor" ? "supervised_investor" : "none";
      const progress: SavIntakeProgress = outside === "other" ? { kind: "qualified_other", classification: "other", classificationRule: policy.qualifiedOther!.resource, evidenceIds: ids, view: "other" }
        : outside === "acknowledgement" ? { kind: "processing", phase: "decision", view: null }
        : { kind: "supervised_action", messageId: message.id, classification: outside, action: action as "supervised_partnership" | "supervised_commercial" | "supervised_investor", approval: "human_confirmation_required", evidenceIds: ids, view: "to_validate" };
      return finalize({ kind: "no_ticket", reason: outside === "other" ? "qualified_other" : outside === "acknowledgement" ? "acknowledgement_only" : "outside_support", nextAction: action, learning: "excluded", evidenceIds: ids }, progress, resource);
    }
    let addressOrigin: "sender" | "customer_declared_registration" = "sender";
    let address = normalizeEmail(message.fromEmail);
    const identityEvidenceIds = [current];
    if (analysis.registration) {
      const declaration = analysis.registration;
      const source = declaration.sourceMessageId === message.id ? message : conversation.find(m => m.id === declaration.sourceMessageId);
      if (!source || source.direction !== "inbound" || !source.contentComplete || normalizeEmail(source.fromEmail) !== address
        || !source.currentText.includes(declaration.quote) || !declaration.quote.toLowerCase().includes(declaration.address.toLowerCase())) return context("contact_lookup_incomplete");
      address = normalizeEmail(declaration.address); addressOrigin = "customer_declared_registration";
      if (source.id !== message.id) identityEvidenceIds.push(addEvidence("registration-declaration", "customer_history", source.id, source));
    }
    const lookup = await bounded(signal => adapters.findContactsByEmail(address, signal), "contact_lookup_failed");
    if (lookup.status === "failed") return context("contact_lookup_failed");
    let contacts = complete(lookup, z.array(intakeContactSchema).max(limits.contacts), "contact_lookup_incomplete");
    // An email search can return a different primary email. Require the full alias list.
    if (contacts.some(c => !c.emails.some(e => normalizeEmail(e) === address))) return context("contact_lookup_incomplete");
    const distinctContacts = new Map<string, IntakeContact>();
    for (const c of contacts) {
      const normalized = { ...c, emails: unique(c.emails.map(normalizeEmail)).sort() };
      if (distinctContacts.has(c.id) && canonical(distinctContacts.get(c.id)) !== canonical(normalized)) return context("contact_lookup_incomplete");
      distinctContacts.set(c.id, normalized);
    }
    contacts = [...distinctContacts.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (!contacts.length) {
      if (input.previousIdentification?.messageId === message.id && normalizeEmail(input.previousIdentification.address) === address) return context("history_incomplete");
      const resource = addressOrigin === "sender" ? policy.resources.identification : policy.resources.registrationNotFound;
      if (!resource) return context("private_resource_unavailable");
      savIntakePrivateResourceSchema.parse(resource);
      return finalize({ kind: "request_identification", lookup: "complete_without_contact", reason: addressOrigin === "sender" ? "sender_contact_absent" : "declared_registration_address_absent",
        identificationAttemptId: input.identificationAttemptId, declaredAddressEvidenceIds: addressOrigin === "sender" ? [] : identityEvidenceIds,
        template: { ...resource, variant: addressOrigin === "sender" ? "initial_registration_request" : "registration_address_not_found", language: "fr", additionalFooter: false },
        permissionRequired: "send_identity_template", learning: "not_started", evidenceIds: identityEvidenceIds }, { kind: "processing", phase: "dispatch", view: null });
    }
    if (contacts.length > 1) return context("contact_ambiguous", "equivalent_contact_choice");
    const primary = contacts[0];
    const scopeContacts: Extract<SavIntakeDecision["disposition"], { kind: "ticket" }>["contactScope"]["contacts"] = [];
    function contactEvidence(c: IntakeContact) { return addEvidence(`contact-${c.id}`, "crm_contact", c.id, { ...c, emails: [...c.emails].sort() }); }
    const primaryProof = contactEvidence(primary); identityEvidenceIds.push(primaryProof);
    scopeContacts.push({ origin: "email_lookup", addressOrigin, contactId: primary.id, evidenceIds: [primaryProof] });
    const edges = complete(await bounded(signal => adapters.directAssociations(primary.id, signal), "association_incomplete"), z.array(intakeAssociationSchema).max(100), "association_incomplete");
    const admitted = edges.filter(edge => edge.fromContactId === primary.id && edge.toContactId !== primary.id
      && policy.admittedRelations.some(p => p.typeId === edge.typeId && p.category === edge.category));
    const direct = [...new Map(admitted.sort((a, b) => canonical(a).localeCompare(canonical(b))).map(e => [e.toContactId, e])).values()].sort((a, b) => a.toContactId.localeCompare(b.toContactId));
    if (direct.length + 1 > limits.contacts) return context("association_incomplete");
    for (const edge of direct) {
      const c = complete(await bounded(signal => adapters.getContact(edge.toContactId, signal), "association_incomplete"), intakeContactSchema, "association_incomplete");
      if (c.id !== edge.toContactId) return context("association_incomplete");
      const contactProof = contactEvidence(c);
      const edgeProof = addEvidence(`association-${c.id}`, "contact_association", `${primary.id}:${c.id}:${edge.typeId}`, edge);
      scopeContacts.push({ origin: "direct_association", contactId: c.id, fromContactId: primary.id, associationTypeId: edge.typeId,
        associationCategory: edge.category, direction: "primary_to_contact", relationPolicyRevisionId: policy.relationRevision, evidenceIds: [contactProof, edgeProof] });
    }
    const tickets = new Map<string, IntakeTicket>();
    for (const c of scopeContacts) {
      const result = await bounded(signal => adapters.ticketsForContact(c.contactId, signal), "ticket_search_incomplete");
      // Current CRM stages are not historical stages. A historical adapter must explicitly
      // attest its reconstruction; the engine never backdates a current snapshot.
      if (input.mode === "at_receipt" && result.reconstructedAsOf !== message.receivedAt) return context("history_incomplete");
      const found = complete(result, z.array(intakeTicketSchema).max(limits.tickets), "ticket_search_incomplete");
      for (const t of found) {
        const normalized = { ...t, contactIds: unique(t.contactIds).sort() };
        if (!normalized.contactIds.includes(c.contactId) || tickets.has(t.id) && canonical(tickets.get(t.id)) !== canonical(normalized)) return context("ticket_search_incomplete");
        tickets.set(t.id, normalized);
      }
      if (tickets.size > limits.tickets) return context("ticket_search_incomplete");
    }
    let candidateTickets = [...tickets.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (candidateTickets.some(t => !t.createdAt || Date.parse(t.createdAt) > Date.parse(input.now))) return context("ticket_creation_date_unknown");
    if (input.mode === "at_receipt") candidateTickets = candidateTickets.filter(t => Date.parse(t.createdAt!) <= Date.parse(message.receivedAt));
    const collected: { ticket: IntakeTicket; history: z.infer<typeof intakeHistorySchema> }[] = [];
    for (const ticket of candidateTickets) {
      addEvidence(`ticket-${ticket.id}`, "crm_ticket", ticket.id, ticket);
      const history = complete(await bounded(signal => adapters.ticketHistory(ticket.id, signal), "history_incomplete"), intakeHistorySchema, "history_incomplete");
      if (history.some(h => Date.parse(h.at) > Date.parse(input.now))) return context("history_incomplete");
      const relevantHistory = input.mode === "at_receipt" ? history.filter(h => Date.parse(h.at) <= Date.parse(message.receivedAt)) : history;
      addEvidence(`history-${ticket.id}`, "crm_event", ticket.id, relevantHistory);
      collected.push({ ticket, history: relevantHistory });
      for (const contactId of ticket.contactIds.filter(id => scopeContacts.some(c => c.contactId === id))) {
        const eid = `membership-${ticket.id}-${contactId}`;
        const hash = sha(canonical({ ticketId: ticket.id, contactId }));
        evidence.push({ id: eid, source: "ticket_contact_association", sourceId: eid, observedAt: input.now, contentHash: hash, ticketId: ticket.id, contactId, direction: "ticket_to_contact" });
      }
    }
    if (evidence.length > 95) return context("history_incomplete");
    const parsedAssessment = issueAssessmentSchema.safeParse(await bounded(signal => adapters.assessIssues({ message, requests: analysis.requests, tickets: collected, evidence: [...evidence] }, signal), "same_issue_unresolved"));
    if (!parsedAssessment.success) return context("same_issue_unresolved");
    const assessment = parsedAssessment.data;
    if (assessment.tickets.length !== candidateTickets.length || new Set(assessment.tickets.map(t => t.ticketId)).size !== assessment.tickets.length) return context("same_issue_unresolved");
    for (const match of assessment.tickets) {
      const currentProof = match.evidenceIds.includes(current);
      const ticketProof = match.evidenceIds.includes(`ticket-${match.ticketId}`);
      const historyProof = match.evidenceIds.includes(`history-${match.ticketId}`);
      if (!tickets.has(match.ticketId) || !currentProof || !ticketProof || !historyProof
        || match.evidenceIds.some(id => !evidence.some(e => e.id === id))
        || match.requestIds.some(id => !requests.some(r => r.id === id))
        || match.relation === "same" && (requests.length !== unique(match.requestIds).length || requests.some(r => !match.requestIds.includes(r.id)))) return context("same_issue_unresolved");
    }
    if (assessment.tickets.some(t => t.relation === "unknown" || t.relation === "partial") || !assessment.investigationComplete) return context("same_issue_unresolved", assessment.investigationComplete ? "same_issue_uncertain" : undefined);
    const same = candidateTickets.filter(t => assessment.tickets.some(m => m.ticketId === t.id && m.relation === "same"));
    if (candidateTickets.some(t => t.stage === "unknown")) return context("ticket_stage_unknown");
    const opened = same.filter(t => t.stage !== "closed").sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!) || a.id.localeCompare(b.id));
    if (opened.length > 1 && Date.parse(opened[0].createdAt!) === Date.parse(opened[1].createdAt!)) return context("same_issue_unresolved", "equivalent_ticket_choice");
    const closed = same.filter(t => t.stage === "closed");
    if (!opened.length && closed.some(t => !t.closedAt || Date.parse(t.closedAt) > Date.parse(message.receivedAt)
      || Date.parse(t.closedAt) < Date.parse(t.createdAt!))) return context("ticket_closure_date_unknown");
    const recent = closed.filter(t => Date.parse(message.receivedAt) - Date.parse(t.closedAt!) <= 15 * DAY);
    if (!opened.length && (recent.length > 1 || !recent.length && closed.length > 1)) return context("same_issue_unresolved", "equivalent_ticket_choice");
    const selected = opened[0] ?? recent[0];
    if (selected?.stage === "closed" && selected.ownerId === undefined) return context("ticket_owner_unknown");
    const targetContactId = selected ? selected.contactIds.includes(primary.id) ? primary.id : selected.contactIds.filter(id => scopeContacts.some(c => c.contactId === id)).sort()[0] : primary.id;
    const binding = (ticket: IntakeTicket, contactId: string) => ({ ticketId: ticket.id, contactId, ticketEvidenceId: `ticket-${ticket.id}`, contactAssociationEvidenceId: `membership-${ticket.id}-${contactId}` });
    const predecessor = !selected && closed[0] ? { ...binding(closed[0], closed[0].contactIds.includes(primary.id) ? primary.id : closed[0].contactIds.filter(id => scopeContacts.some(c => c.contactId === id)).sort()[0]) } : null;
    const target: Extract<SavIntakeDecision["disposition"], { kind: "ticket" }>["target"] = selected
      ? selected.stage === "closed" ? { operation: "reopen", ...binding(selected, targetContactId), preserveOwnerId: selected.ownerId! }
        : { operation: "link", ...binding(selected, targetContactId), alreadyNew: selected.stage === "new" }
      : { operation: "create", contactId: primary.id, predecessor, selection: { kind: "retained_email_match" } };
    if (target.operation === "create") {
      const summary = analysis.ticketSummary;
      if (!summary || summary.title.split(/\s+/).length > 6 || summary.requestIds.length !== requests.length
        || unique(summary.requestIds).length !== requests.length || requests.some(r => !summary.requestIds.includes(r.id))) return context("classification_incomplete");
      newTicket = { ...summary, contactId: primary.id, pipeline: "support", stage: "new", source: "email", owner: "leave_unassigned" };
    }
    const openIds = candidateTickets.filter(t => t.stage !== "closed" && t.contactIds.includes(targetContactId)).map(t => t.id).sort();
    const multiple = openIds.length + (target.operation === "link" ? 0 : 1) > 1;
    const returns = target.operation === "reopen" || target.operation === "link" && !target.alreadyNew;
    const warning = multiple ? policy.resources.multiTicketWarning : undefined;
    if (multiple && (!warning || createHash("sha256").update(warning.text).digest("hex") !== warning.sha256)) return context("private_resource_unavailable");
    const resource = warning ? savIntakePrivateResourceSchema.parse({ resourceId: warning.resourceId, revisionId: warning.revisionId, sha256: warning.sha256 }) : null;
    noteText = returns ? [warning?.text, savTicketReturnNote(target.operation === "reopen" ? "closed" : "open")].filter(Boolean).join("\n\n") : warning?.text ?? null;
    const noteOrigin = { sourceMessageId: message.id, sourceEvidenceIds: [current], renderedContentHash: sha(noteText ?? ""), deduplication: "source_message_and_final_ticket" as const };
    const note: Extract<SavIntakeDecision["disposition"], { kind: "ticket" }>["note"] = returns ? { kind: "existing_return_summary" as const, version: SAV_TICKET_RETURN_NOTE_VERSION, previousState: target.operation === "reopen" ? "closed" as const : "open" as const, warningPrefix: resource ? { placement: "before_summary" as const, resource } : null, ...noteOrigin }
      : resource ? { kind: "multi_ticket_warning_only" as const, warningResource: resource, ...noteOrigin } : null;
    const permissions: Extract<SavIntakeDecision["disposition"], { kind: "ticket" }>["requiredPermissions"] = [target.operation === "create" ? "create_ticket" : "link_ticket", "associate_email"];
    if (note) permissions.push("append_ticket_note");
    if (returns) permissions.push("set_ticket_new");
    return finalize({ kind: "ticket", target, requestIds: requests.map(r => r.id), contactScope: { primaryContactId: primary.id, contacts: scopeContacts, complete: true },
      search: "complete", history: "complete", identity: { kind: "unique_crm_match_for_intake", addressOrigin, scope: "intake_only", evidenceIds: identityEvidenceIds },
      sameIssueEvidenceIds: unique([current, ...assessment.tickets.filter(m => m.relation === "same").flatMap(m => m.evidenceIds)]), requiredPermissions: permissions,
      multiTicketNote: { openTicketIdsOnTargetContact: openIds }, note, learning: classification === "support" ? "eligible_after_confirmed_effect" : "excluded", evidenceIds: [current, primaryProof] },
    { kind: "processing", phase: "dispatch", view: null });
  } catch (error) {
    if (error instanceof ContextFault) return context(error.reason);
    // Malformed injected data never becomes absence or a permission to create.
    return context("history_incomplete");
  }
}
