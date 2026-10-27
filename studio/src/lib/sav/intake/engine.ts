import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SAV_INTAKE_CONTRACT_REVISION, savIntakeDecisionSchema, savIntakeEvidenceSchema, savIntakePrivateResourceSchema, savIntakeProgressSchema,
  type SavIntakeDecision, type SavIntakeProgress,
} from "./contract";
import { SAV_TICKET_RETURN_NOTE_VERSION, savTicketReturnNote } from "../ticket-return-note";
import { savEvidenceContains } from "../evidence-text";
import {
  intakeMessageSchema, intakeContactSchema, intakeAssociationSchema, intakeTicketSchema, intakeHistorySchema,
  messageAnalysisSchema, issueAssessmentSchema, identityAssessmentSchema,
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
export const savIntakeCanonicalEvidence = canonical;
export const savIntakeEvidenceContentHash = (value: unknown) => sha(canonical(value));
const unique = <T>(values: T[]) => [...new Set(values)];
const observationTimeSchema = z.iso.datetime({ offset: true });
const DAY = 86_400_000;

/** Content binding, not a signature, dispatch authorization or idempotency store. */
export function savIntakePlanFingerprint(plan: Pick<IntakePlan, "decision" | "noteText" | "newTicket" | "supervisedResource" | "originalThreadId" | "originalRecipientEmails" | "referenceMode">): string {
  return sha(canonical({ decision: plan.decision, noteText: plan.noteText, newTicket: plan.newTicket ?? null, supervisedResource: plan.supervisedResource ?? null,
    originalThreadId: plan.originalThreadId, originalRecipientEmails: plan.originalRecipientEmails, referenceMode: plan.referenceMode }));
}

/** Read and plan only. There is deliberately no write, model client, DB or dispatch dependency. */
export async function planSavIntake(
  input: EngineInput, adapters: IntakeAdapters, policy: EnginePolicy, overrides: Partial<EngineLimits> = {},
  readClock?: () => Date,
): Promise<IntakePlan> {
  const message = intakeMessageSchema.parse(input.message);
  if (!z.iso.datetime().safeParse(input.now).success || Date.parse(input.now) < Date.parse(message.receivedAt)
    || !z.uuid().safeParse(input.latestInboundMessageId).success
    || !["at_receipt", "current"].includes(input.mode)
    || !input.identificationAttemptId.trim()) throw new Error("SAV_INTAKE_INPUT_INVALID");
  const limits = { readCalls: 50, timeoutMs: 2000, contacts: 10, tickets: 20, ...overrides };
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 1)
    || limits.contacts > 10 || limits.tickets > 20 || limits.readCalls > 100 || limits.timeoutMs > 10_000) throw new Error("SAV_INTAKE_LIMITS_INVALID");
  const modelTimeoutMs = limits.modelTimeoutMs ?? limits.timeoutMs;
  if (modelTimeoutMs > 60_000) throw new Error("SAV_INTAKE_LIMITS_INVALID");
  let calls = 0;
  const readTime = () => {
    const value = readClock ? readClock().getTime() : Date.parse(input.now);
    if (!Number.isFinite(value) || value < Date.parse(input.now)) return fail("history_incomplete");
    return value;
  };
  const evidence: IntakeEvidence[] = [];
  const registerEvidence = (value: IntakeEvidence) => {
    const timestamp = observationTimeSchema.safeParse(value.observedAt);
    if (!timestamp.success) return fail("history_incomplete");
    const parsed = savIntakeEvidenceSchema.safeParse({ ...value, observedAt: new Date(timestamp.data).toISOString() });
    if (!parsed.success) return fail("history_incomplete");
    const record = parsed.data;
    const existing = evidence.find(e => e.id === record.id);
    if (existing) {
      if (canonical({ ...existing, observedAt: record.observedAt }) !== canonical(record)) fail("history_incomplete");
      // Identical content observed twice is not a contradiction. Keep the earliest
      // source observation, so a re-read cannot manufacture fresher evidence.
      if (Date.parse(record.observedAt) < Date.parse(existing.observedAt)) existing.observedAt = record.observedAt;
      return record.id;
    }
    if (evidence.length >= 95) fail("history_incomplete");
    evidence.push(record);
    return record.id;
  };
  const addEvidence = (id: string, source: IntakeEvidence["source"], sourceId: string, value: unknown, observedAt = input.now) => {
    return registerEvidence({ id, source, sourceId, observedAt, contentHash: sha(canonical(value)) } as IntakeEvidence);
  };
  const current = addEvidence("current", "current_message", message.id, message);
  let classification: SavIntakeDecision["classification"] = "unknown";
  let requests: SavIntakeDecision["requests"] = [];
  let noteText: string | null = null;
  let newTicket: IntakePlan["newTicket"];
  let candidateContactIds: string[] | undefined;
  let selectedEquivalent: string[] | undefined;
  const humanProof = input.humanResolution ? addEvidence("human-choice", "human_override", input.humanResolution.choiceId, input.humanResolution, input.humanResolution.at) : undefined;
  const finalize = (disposition: SavIntakeDecision["disposition"], progress: SavIntakeProgress = { kind: "processing", phase: "context", view: null }, supervisedResource?: PrivateResource): IntakePlan => {
    const decision = savIntakeDecisionSchema.parse({
      revision: SAV_INTAKE_CONTRACT_REVISION, messageId: message.id, latestInboundMessageId: input.latestInboundMessageId,
      threadId: message.threadId, receivedAt: message.receivedAt, classification, requests,
      evidence: [...evidence].sort((a, b) => a.id.localeCompare(b.id)), disposition,
    });
    const mutations = disposition.kind === "ticket" ? disposition.requiredPermissions : disposition.kind === "request_identification" ? [disposition.permissionRequired] : [];
    const ticketId = disposition.kind === "ticket" && disposition.target.operation !== "create" ? disposition.target.ticketId : null;
    const finalNote = disposition.kind === "ticket" ? noteText : null;
    const finalCreation = disposition.kind === "ticket" && disposition.target.operation === "create" ? newTicket : undefined;
    const fingerprint = savIntakePlanFingerprint({ decision, noteText: finalNote, newTicket: finalCreation, supervisedResource,
      originalThreadId: message.threadId, originalRecipientEmails: [message.fromEmail], referenceMode: input.mode });
    return {
      revision: "sav-intake-engine-2026-10-20.v1", fingerprint, decision,
      steps: mutations.map(mutation => ({ id: `${message.id}:${mutation}:${fingerprint}`, mutation, requiresPermission: mutation, ticketId, status: "not_dispatched" as const })),
      progress: savIntakeProgressSchema.parse(progress), noteText: finalNote, ...(supervisedResource ? { supervisedResource } : {}),
      ...(finalCreation ? { newTicket: finalCreation } : {}), ...((candidateContactIds ?? selectedEquivalent) ? { candidateContactIds:candidateContactIds ?? selectedEquivalent } : {}),
      originalThreadId: message.threadId, originalRecipientEmails: [message.fromEmail], referenceMode: input.mode,
      readCalls: calls, effects: "not_connected",
    };
  };
  const context = (reason: ContextReason, choice?: "equivalent_contact_choice" | "equivalent_ticket_choice" | "same_issue_uncertain" | "request_scope_uncertain") => finalize(
    { kind: "collect_context", reasons: unique([reason, ...(!requests.length || requests.some(r => r.kind === "unknown") || classification === "mixed" ? ["classification_incomplete" as const] : [])]), evidenceIds: evidence.map(e => e.id).sort() },
    choice ? { kind: "human_choice", messageId: message.id, classification: classification === "cancellation" || classification === "finance" || classification === "support" ? classification : "unknown", questionCode: choice, investigation: "bounded_investigation_complete", evidenceIds: evidence.map(e => e.id).sort(), view: "to_validate" }
      : { kind: "processing", phase: reason.startsWith("classification") ? "classification" : "context", view: null },
  );
  async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, reason: ContextReason, timeoutMs = limits.timeoutMs): Promise<T> {
    if (calls >= limits.readCalls) fail(reason);
    calls++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(Error("SAV_INTAKE_STEP_DEADLINE")); reject(new ContextFault(reason)); }, timeoutMs);
      })]);
    } catch { return fail(reason); }
    finally { if (timer) clearTimeout(timer); }
  }
  function complete<T>(result: ReadResult<unknown>, schema: z.ZodType<T>, reason: ContextReason, temporal = false): T {
    if (!result || result.status !== "complete" || !observationTimeSchema.safeParse(result.observedAt).success || Date.parse(result.observedAt) > readTime()) fail(reason);
    if (temporal && input.mode === "at_receipt" && result.reconstructedAsOf !== message.receivedAt) fail("history_incomplete");
    const parsed = schema.safeParse(result.data);
    if (!parsed.success) return fail(reason);
    return parsed.data;
  }
  async function collectHistory(ticketId: string, prefix = "") {
    const result = await bounded(signal => adapters.ticketHistory(ticketId, signal), "history_incomplete");
    const history = complete(result, intakeHistorySchema, "history_incomplete", true);
    if (history.some(h => Date.parse(h.at) > readTime())) return fail("history_incomplete");
    const byId = new Map<string, typeof history[number]>();
    for (const h of history) {
      if (byId.has(h.id) && canonical(byId.get(h.id)) !== canonical(h)) fail("history_incomplete");
      byId.set(h.id, h);
    }
    const relevant = [...byId.values()].filter(h => input.mode !== "at_receipt" || Date.parse(h.at) <= Date.parse(message.receivedAt))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
    addEvidence(`${prefix}history-${ticketId}`, "crm_event", ticketId, relevant, result.observedAt);
    return relevant;
  }
  async function collectTickets(contactId: string, prefix: "identity" | "ticket") {
    const result = await bounded(signal => adapters.ticketsForContact(contactId, signal), "ticket_search_incomplete");
    const found = complete(result, z.array(intakeTicketSchema).max(limits.tickets), "ticket_search_incomplete", true);
    const byId = new Map<string, IntakeTicket>();
    for (const raw of found) {
      const ticket = { ...raw, contactIds: unique(raw.contactIds).sort() };
      if (!ticket.contactIds.includes(contactId) || byId.has(ticket.id) && canonical(byId.get(ticket.id)) !== canonical(ticket)) fail("ticket_search_incomplete");
      if (!ticket.createdAt || Date.parse(ticket.createdAt) > readTime()) fail("ticket_creation_date_unknown");
      byId.set(ticket.id, ticket);
    }
    // Apply the same temporal boundary before hashing or exposing candidates to
    // either semantic assessment. Current snapshots cannot become historical truth.
    const relevant = [...byId.values()]
      .filter(ticket => input.mode !== "at_receipt" || Date.parse(ticket.createdAt!) <= Date.parse(message.receivedAt))
      .sort((a, b) => a.id.localeCompare(b.id));
    addEvidence(`${prefix}-search-${contactId}`, "crm_ticket", `search-${contactId}`, relevant, result.observedAt);
    return { tickets: relevant, observedAt: result.observedAt };
  }
  try {
    if (message.id !== input.latestInboundMessageId || message.direction !== "inbound") return context("history_incomplete");
    if (!message.contentComplete) return context("classification_incomplete");
    const conversation = complete(input.conversation, z.array(intakeMessageSchema).max(50), "history_incomplete");
    if (new Set(conversation.map(m => m.id)).size !== conversation.length || conversation.some(m => m.threadId !== message.threadId
      || Date.parse(m.receivedAt) > Date.parse(message.receivedAt))) return context("history_incomplete");
    if (!message.currentText.trim()) {
      for (const prior of conversation) addEvidence(`context-${prior.id}`, "customer_history", prior.id, prior, input.conversation.observedAt);
      return context("classification_incomplete", "request_scope_uncertain");
    }
    const continuation = input.identificationContinuation;
    const initial = continuation ? conversation.find(m => m.id === continuation.initialMessageId) : undefined;
    if (continuation && (!initial || !initial.contentComplete || initial.direction !== "inbound" || initial.threadId !== message.threadId
      || normalizeEmail(initial.fromEmail) !== normalizeEmail(message.fromEmail) || Date.parse(initial.receivedAt) >= Date.parse(message.receivedAt)
      || input.previousIdentification?.state !== "confirmed" || input.previousIdentification.messageId !== initial.id
      || normalizeEmail(input.previousIdentification.address) !== normalizeEmail(message.fromEmail))) return context("history_incomplete");
    const parsedAnalysis = messageAnalysisSchema.safeParse(await bounded(signal => adapters.analyseMessage({ message, conversation,
      ...(continuation ? { identificationContinuation: continuation } : {}) }, signal), "classification_incomplete", modelTimeoutMs));
    if (!parsedAnalysis.success) return context("classification_incomplete");
    const analysis = parsedAnalysis.data;
    const inherited = analysis.requests.filter(r => r.originMessageId !== undefined);
    if (inherited.length && (!continuation || !initial || inherited.some(r => r.originMessageId !== initial.id)
      || !analysis.registration || analysis.registration.sourceMessageId !== message.id
      || !message.currentText.includes(analysis.registration.quote)
      || !analysis.registration.quote.toLowerCase().includes(analysis.registration.address.toLowerCase()))) return context("history_incomplete");
    const initialProof = inherited.length && initial ? addEvidence("initial-request", "customer_history", initial.id, initial, input.conversation.observedAt) : undefined;
    if (input.humanResolution?.classification) {
      analysis.requests = analysis.requests.map(r => ({ ...r, kind: input.humanResolution!.classification! }));
    }
    if (analysis.messageId !== message.id || analysis.requests.some(r => r.currentMessageId !== message.id)
      || new Set(analysis.requests.map(r => r.id)).size !== analysis.requests.length) return context("classification_incomplete");
    // A literal authored malfunction is never authority for Other/acknowledgement.
    // Preserve it for a targeted operator question if the producer omitted it.
    if (/^(?:ça|ca|cela)\s+ne\s+(?:fonctionne|marche)\s+(?:pas|plus)[.!\s]*$/iu.test(message.currentText.trim().split("\n")[0])
      && !analysis.requests.some(r => ["support", "finance", "cancellation"].includes(r.kind))) {
      classification = "support"; requests = [{ id: "written-support", kind: "support", evidenceIds: [current] }];
      return context("classification_incomplete", "request_scope_uncertain");
    }
    analysis.requests.sort((a, b) => a.id.localeCompare(b.id));
    requests = analysis.requests.map(({ id, kind, originMessageId }) => ({ id, kind,
      evidenceIds: unique([current, ...(humanProof ? [humanProof] : []), ...(originMessageId && initialProof ? [initialProof] : [])]) }));
    const kinds = unique(requests.map(r => r.kind));
    classification = kinds.includes("cancellation") ? "cancellation" : kinds.includes("finance") ? "finance"
      : kinds.includes("unknown") || !kinds.length ? "unknown" : kinds.includes("support") ? "support"
      : kinds.filter(k => ["commercial", "investor", "partnership"].includes(k)).length > 1 ? "mixed"
      : kinds.find(k => ["commercial", "investor", "partnership"].includes(k)) ?? (kinds.includes("other") ? "other" : "acknowledgement");
    if (message.attachmentInputs?.length) {
      const observations = analysis.attachmentObservations;
      if (!observations || observations.length !== message.attachmentInputs.length
        || new Set(observations.map(o => o.sourceId)).size !== observations.length
        || observations.some(o => !message.attachmentInputs!.some(i => i.sourceId === o.sourceId && i.fileHash === o.fileHash))) return context("classification_incomplete");
      const requirements = analysis.imageRequirements ?? [];
      const explicitDependency = /(?:voir|regardez|cf\.?|see)\s+(?:la\s+|les\s+|the\s+)?(?:capture|image|screenshot|pi[eè]ce)/iu.test(message.currentText);
      const accessory = (o: typeof observations[number]) => !explicitDependency && requirements.filter(r => r.sourceId === o.sourceId).length === 1
        && requirements.some(r => r.sourceId === o.sourceId && r.fileHash === o.fileHash && r.role === "accessory"
          && r.textQuote && savEvidenceContains(message.currentText, r.textQuote));
      if (observations.some(o => o.status !== "analyzed" && !accessory(o))) return context("classification_incomplete");
      for (const observation of observations) addEvidence(observation.sourceId, "current_attachment", message.id, observation);
    } else if (analysis.attachmentObservations?.length) return context("classification_incomplete");
    if (!requests.length && analysis.nature === "newsletter" && policy.qualifiedOther?.family === "authenticated_newsletter" && !policy.manualSupportOverride) classification = "other";
    else if (!requests.length || kinds.includes("unknown") || classification === "mixed") return context("classification_incomplete", "request_scope_uncertain");
    if (policy.manualSupportOverride && classification === "other") {
      // Recompute from the current message. An override is not a fabricated support request.
      return context("classification_incomplete");
    }
    if (["other", "acknowledgement", "partnership", "commercial", "investor"].includes(classification)) {
      const outside = classification as "other" | "acknowledgement" | "partnership" | "commercial" | "investor";
      let ruleId: string | undefined;
      if (outside === "other") {
        // Accepted semantic classification is not authority to hide a mail.
        // This is an explicit rule decision, not a transient model failure to
        // retry with the exact same cached output until attempts are exhausted.
        if (!policy.qualifiedOther) return context("private_resource_unavailable", "request_scope_uncertain");
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
      return finalize({ kind: "no_ticket", ...(!requests.length && outside === "other" ? {qualifiedInformation: "authenticated_newsletter" as const} : {}), reason: outside === "other" ? "qualified_other" : outside === "acknowledgement" ? "acknowledgement_only" : "outside_support", nextAction: action, learning: "excluded", evidenceIds: ids }, progress, resource);
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
      if (source.id !== message.id) identityEvidenceIds.push(addEvidence("registration-declaration", "customer_history", source.id, source, input.conversation.observedAt));
    }
    const lookup = await bounded(signal => adapters.findContactsByEmail(address, signal), "contact_lookup_failed");
    if (lookup.status === "failed") return context("contact_lookup_failed");
    let contacts = complete(lookup, z.array(intakeContactSchema).max(limits.contacts), "contact_lookup_incomplete", true);
    // An email search can return a different primary email. Require the full alias list.
    if (contacts.some(c => !c.emails.some(e => normalizeEmail(e) === address))) return context("contact_lookup_incomplete");
    const distinctContacts = new Map<string, IntakeContact>();
    for (const c of contacts) {
      const normalized = { ...c, emails: unique(c.emails.map(normalizeEmail)).sort() };
      if (distinctContacts.has(c.id) && canonical(distinctContacts.get(c.id)) !== canonical(normalized)) return context("contact_lookup_incomplete");
      distinctContacts.set(c.id, normalized);
    }
    contacts = [...distinctContacts.values()].sort((a, b) => a.id.localeCompare(b.id));
    identityEvidenceIds.push(addEvidence("email-lookup", "crm_contact", `lookup-${sha(address)}`,
      { address, status: lookup.status, contacts, reconstructedAsOf: lookup.reconstructedAsOf }, lookup.observedAt));
    const expectedHumanCandidates = input.humanResolution?.equivalentContactIds;
    if (expectedHumanCandidates?.some(id => !contacts.some(contact => contact.id === id))) return context("contact_ambiguous");
    if (!contacts.length) {
      if (input.previousIdentification?.messageId === message.id && normalizeEmail(input.previousIdentification.address) === address) return context("history_incomplete");
      const resource = addressOrigin === "sender" ? policy.resources.identification : policy.resources.registrationNotFound;
      if (!resource) return context("private_resource_unavailable");
      savIntakePrivateResourceSchema.parse(resource);
      return finalize({ kind: "request_identification", lookup: "complete_without_contact", reason: addressOrigin === "sender" ? "sender_contact_absent" : "declared_registration_address_absent",
        identificationAttemptId: input.identificationAttemptId, declaredAddressEvidenceIds: addressOrigin === "sender" ? [] : identityEvidenceIds.filter(id => evidence.some(e => e.id === id && ["current_message", "customer_history"].includes(e.source))),
        template: { ...resource, variant: addressOrigin === "sender" ? "initial_registration_request" : "registration_address_not_found", language: "fr", additionalFooter: false },
        permissionRequired: "send_identity_template", learning: "not_started", evidenceIds: identityEvidenceIds }, { kind: "processing", phase: "dispatch", view: null });
    }
    function contactEvidence(c: IntakeContact, observedAt: string) { return addEvidence(`contact-${c.id}`, "crm_contact", c.id, { ...c, emails: unique(c.emails.map(normalizeEmail)).sort() }, observedAt); }
    if (contacts.length > 1) {
      candidateContactIds = contacts.map(c => c.id);
      for (const c of contacts) contactEvidence(c, lookup.observedAt);
      if (!adapters.assessIdentity) return context("contact_ambiguous");
      const candidateContexts: Parameters<NonNullable<IntakeAdapters["assessIdentity"]>>[0]["candidates"][number][] = [];
      const seenTickets = new Map<string, IntakeTicket>();
      const histories = new Map<string, Awaited<ReturnType<typeof collectHistory>>>();
      for (const c of contacts) {
        const result = await collectTickets(c.id, "identity");
        const rows: typeof candidateContexts[number]["tickets"] = [];
        for (const t of result.tickets) {
          if (seenTickets.has(t.id) && canonical(seenTickets.get(t.id)) !== canonical(t)) return context("ticket_search_incomplete");
          if (!seenTickets.has(t.id)) {
            if (seenTickets.size >= limits.tickets) return context("ticket_search_incomplete");
            seenTickets.set(t.id, t); addEvidence(`identity-ticket-${t.id}`, "crm_ticket", t.id, t, result.observedAt);
            histories.set(t.id, await collectHistory(t.id, "identity-"));
          }
          rows.push({ ticket: t, history: histories.get(t.id)! });
        }
        candidateContexts.push({ contact: c, tickets: rows });
      }
      const parsed = identityAssessmentSchema.safeParse(await bounded(signal => adapters.assessIdentity!({ message, address, candidates: candidateContexts, evidence: [...evidence], ...(initialProof ? { requestContext: initial } : {}) }, signal), "contact_ambiguous", modelTimeoutMs));
      if (!parsed.success) return context("contact_ambiguous");
      const resolution = parsed.data;
      const required = [current, ...contacts.flatMap(c => [`contact-${c.id}`, `identity-search-${c.id}`]), ...[...seenTickets.keys()].flatMap(id => [`identity-ticket-${id}`, `identity-history-${id}`])];
      if (!resolution.investigationComplete || resolution.kind === "unknown" || required.some(id => !resolution.evidenceIds.includes(id))
        || resolution.evidenceIds.some(id => !evidence.some(e => e.id === id)) || unique(resolution.contactIds).length !== resolution.contactIds.length
        || resolution.contactIds.some(id => !contacts.some(c => c.id === id))) return context("contact_ambiguous");
      if (resolution.kind === "equivalent") {
        if (resolution.contactIds.length < 2) return context("contact_ambiguous");
        candidateContactIds = [...resolution.contactIds].sort();
        const choice = input.humanResolution;
        if (!choice?.contactId || !humanProof || !choice.equivalentContactIds
          || canonical([...choice.equivalentContactIds].sort()) !== canonical(candidateContactIds)
          || !candidateContactIds.includes(choice.contactId)) return context("contact_ambiguous", "equivalent_contact_choice");
        selectedEquivalent = [...candidateContactIds];
        contacts = contacts.filter(c => c.id === choice.contactId);
      } else {
        if (resolution.contactIds.length !== 1) return context("contact_ambiguous");
        contacts = contacts.filter(c => c.id === resolution.contactIds[0]);
      }
      candidateContactIds = undefined;
    }
    const primary = contacts[0];
    const scopeContacts: Extract<SavIntakeDecision["disposition"], { kind: "ticket" }>["contactScope"]["contacts"] = [];
    const primaryProof = contactEvidence(primary, lookup.observedAt); identityEvidenceIds.push(primaryProof);
    if (humanProof) identityEvidenceIds.push(humanProof);
    scopeContacts.push({ origin: "email_lookup", addressOrigin, contactId: primary.id, evidenceIds: [primaryProof] });
    const edgeResult = await bounded(signal => adapters.directAssociations(primary.id, signal), "association_incomplete");
    const edges = complete(edgeResult, z.array(intakeAssociationSchema).max(100), "association_incomplete", true);
    addEvidence("association-search", "contact_association", `relations-${primary.id}`, [...edges].sort((a, b) => canonical(a).localeCompare(canonical(b))), edgeResult.observedAt);
    const admitted = edges.filter(edge => edge.fromContactId === primary.id && edge.toContactId !== primary.id
      && policy.admittedRelations.some(p => p.typeId === edge.typeId && p.category === edge.category));
    const direct = [...new Map(admitted.sort((a, b) => canonical(a).localeCompare(canonical(b))).map(e => [e.toContactId, e])).values()].sort((a, b) => a.toContactId.localeCompare(b.toContactId));
    if (direct.length + 1 > limits.contacts) return context("association_incomplete");
    for (const edge of direct) {
      const contactResult = await bounded(signal => adapters.getContact(edge.toContactId, signal), "association_incomplete");
      const c = complete(contactResult, intakeContactSchema, "association_incomplete", true);
      if (c.id !== edge.toContactId) return context("association_incomplete");
      const contactProof = contactEvidence(c, contactResult.observedAt);
      const edgeProof = addEvidence(`association-${c.id}`, "contact_association", `${primary.id}:${c.id}:${edge.typeId}`, edge, edgeResult.observedAt);
      scopeContacts.push({ origin: "direct_association", contactId: c.id, fromContactId: primary.id, associationTypeId: edge.typeId,
        associationCategory: edge.category, direction: "primary_to_contact", relationPolicyRevisionId: policy.relationRevision, evidenceIds: [contactProof, edgeProof] });
    }
    const tickets = new Map<string, IntakeTicket>();
    const ticketObservedAt = new Map<string, string>();
    for (const c of scopeContacts) {
      const result = await collectTickets(c.contactId, "ticket");
      for (const t of result.tickets) {
        if (tickets.has(t.id) && canonical(tickets.get(t.id)) !== canonical(t)) return context("ticket_search_incomplete");
        tickets.set(t.id, t);
        if (!ticketObservedAt.has(t.id) || Date.parse(result.observedAt) < Date.parse(ticketObservedAt.get(t.id)!)) ticketObservedAt.set(t.id, result.observedAt);
      }
      if (tickets.size > limits.tickets) return context("ticket_search_incomplete");
    }
    const candidateTickets = [...tickets.values()].sort((a, b) => a.id.localeCompare(b.id));
    const collected: { ticket: IntakeTicket; history: z.infer<typeof intakeHistorySchema> }[] = [];
    for (const ticket of candidateTickets) {
      addEvidence(`ticket-${ticket.id}`, "crm_ticket", ticket.id, ticket, ticketObservedAt.get(ticket.id)!);
      const relevantHistory = await collectHistory(ticket.id);
      collected.push({ ticket, history: relevantHistory });
      for (const contactId of ticket.contactIds.filter(id => scopeContacts.some(c => c.contactId === id))) {
        const eid = `membership-${ticket.id}-${contactId}`;
        const hash = sha(canonical({ ticketId: ticket.id, contactId }));
        registerEvidence({ id: eid, source: "ticket_contact_association", sourceId: eid, observedAt: ticketObservedAt.get(ticket.id)!, contentHash: hash, ticketId: ticket.id, contactId, direction: "ticket_to_contact" });
      }
    }
    if (evidence.length > 95) return context("history_incomplete");
    const parsedAssessment = issueAssessmentSchema.safeParse(await bounded(signal => adapters.assessIssues({ message, requests: analysis.requests, tickets: collected, evidence: [...evidence], ...(initialProof ? { requestContext: initial } : {}) }, signal), "same_issue_unresolved", modelTimeoutMs));
    if (!parsedAssessment.success) return context("same_issue_unresolved");
    const assessment = parsedAssessment.data;
    const humanTicketId = input.humanResolution?.ticketId;
    if (humanTicketId && humanProof && assessment.investigationComplete) {
      const selected = assessment.tickets.find(t => t.ticketId === humanTicketId);
      if (!selected || !tickets.has(humanTicketId)) return context("same_issue_unresolved", "equivalent_ticket_choice");
      // Explicit human correction of the semantic relation, while all real CRM
      // membership/ticket/history snapshots and other assessments stay intact.
      selected.relation = "same";
      selected.requestIds = requests.map(r => r.id);
      selected.evidenceIds = unique([...selected.evidenceIds, humanProof]);
    }
    if (assessment.tickets.length !== candidateTickets.length || new Set(assessment.tickets.map(t => t.ticketId)).size !== assessment.tickets.length) return context("same_issue_unresolved");
    for (const match of assessment.tickets) {
      const currentProof = match.evidenceIds.includes(current);
      const ticketProof = match.evidenceIds.includes(`ticket-${match.ticketId}`);
      const historyProof = match.evidenceIds.includes(`history-${match.ticketId}`);
      if (!tickets.has(match.ticketId) || !currentProof || !ticketProof || !historyProof || initialProof && !match.evidenceIds.includes(initialProof)
        || match.evidenceIds.some(id => !evidence.some(e => e.id === id))
        || match.requestIds.some(id => !requests.some(r => r.id === id))
        || match.relation === "same" && (requests.length !== unique(match.requestIds).length || requests.some(r => !match.requestIds.includes(r.id)))) return context("same_issue_unresolved");
    }
    if (assessment.tickets.some(t => t.relation === "unknown" || t.relation === "partial") || !assessment.investigationComplete) return context("same_issue_unresolved", assessment.investigationComplete ? "same_issue_uncertain" : undefined);
    const same = candidateTickets.filter(t => assessment.tickets.some(m => m.ticketId === t.id && m.relation === "same"));
    if (candidateTickets.some(t => t.stage === "unknown")) return context("ticket_stage_unknown");
    const opened = same.filter(t => t.stage !== "closed").sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!) || a.id.localeCompare(b.id));
    if (!input.humanResolution?.ticketId && opened.length > 1 && Date.parse(opened[0].createdAt!) === Date.parse(opened[1].createdAt!)) return context("same_issue_unresolved", "equivalent_ticket_choice");
    const closed = same.filter(t => t.stage === "closed");
    if (!opened.length && closed.some(t => !t.closedAt || Date.parse(t.closedAt) > Date.parse(message.receivedAt)
      || Date.parse(t.closedAt) < Date.parse(t.createdAt!))) return context("ticket_closure_date_unknown");
    const recent = closed.filter(t => Date.parse(message.receivedAt) - Date.parse(t.closedAt!) <= 15 * DAY);
    if (!input.humanResolution?.ticketId && !opened.length && (recent.length > 1 || !recent.length && closed.length > 1)) return context("same_issue_unresolved", "equivalent_ticket_choice");
    const chosenTicket = input.humanResolution?.ticketId;
    if (chosenTicket && ![...opened, ...recent].some(t => t.id === chosenTicket)) return context("same_issue_unresolved", "equivalent_ticket_choice");
    const selected = chosenTicket ? [...opened, ...recent].find(t => t.id === chosenTicket) : opened[0] ?? recent[0];
    if (selected?.stage === "closed" && selected.ownerId === undefined) return context("ticket_owner_unknown");
    const targetContactId = selected ? selected.contactIds.includes(primary.id) ? primary.id : selected.contactIds.filter(id => scopeContacts.some(c => c.contactId === id)).sort()[0] : primary.id;
    const binding = (ticket: IntakeTicket, contactId: string) => ({ ticketId: ticket.id, contactId, ticketEvidenceId: `ticket-${ticket.id}`, contactAssociationEvidenceId: `membership-${ticket.id}-${contactId}` });
    const predecessor = !selected && closed[0] ? { ...binding(closed[0], closed[0].contactIds.includes(primary.id) ? primary.id : closed[0].contactIds.filter(id => scopeContacts.some(c => c.contactId === id)).sort()[0]) } : null;
    const target: Extract<SavIntakeDecision["disposition"], { kind: "ticket" }>["target"] = selected
      ? selected.stage === "closed" ? { operation: "reopen", ...binding(selected, targetContactId), preserveOwnerId: selected.ownerId! }
        : { operation: "link", ...binding(selected, targetContactId), alreadyNew: selected.stage === "new" }
      : { operation: "create", contactId: primary.id, predecessor, selection: selectedEquivalent && humanProof ? { kind: "human_equivalent_contacts", equivalentContactIds: selectedEquivalent, choiceEvidenceId: humanProof } : { kind: "retained_email_match" } };
    if (target.operation === "create") {
      const summary = analysis.ticketSummary;
      if (!summary || summary.title.split(/\s+/).length > 6 || summary.requestIds.length !== requests.length
        || unique(summary.requestIds).length !== requests.length || requests.some(r => !summary.requestIds.includes(r.id))) return context("classification_incomplete");
      newTicket = { ...summary, requestIds: [...summary.requestIds].sort(), contactId: primary.id, pipeline: "support", stage: "new", source: "email", owner: "leave_unassigned" };
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
      search: "complete", history: "complete", identity: { kind: selectedEquivalent ? "human_equivalent_contacts" : "unique_crm_match_for_intake", ...(selectedEquivalent ? { choiceEvidenceId: humanProof } : {}), addressOrigin, scope: "intake_only", evidenceIds: identityEvidenceIds },
      sameIssueEvidenceIds: unique([current, ...assessment.tickets.filter(m => m.relation === "same").flatMap(m => m.evidenceIds)]).sort(), requiredPermissions: permissions,
      multiTicketNote: { openTicketIdsOnTargetContact: openIds }, note, learning: classification === "support" ? "eligible_after_confirmed_effect" : "excluded", evidenceIds: [current, primaryProof] },
    { kind: "processing", phase: "dispatch", view: null });
  } catch (error) {
    if (error instanceof ContextFault) return context(error.reason);
    // Malformed injected data never becomes absence or a permission to create.
    return context("history_incomplete");
  }
}
