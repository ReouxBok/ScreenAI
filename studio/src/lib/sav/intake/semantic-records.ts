import { savIntakeEvidenceContentHash } from "./engine";
import { identityAssessmentSchema, issueAssessmentSchema, messageAnalysisSchema } from "./engine-types";
import { SAV_INTAKE_MODEL_REVISION, type SavIntakeSemanticReaders } from "./model-readers";
import { SAV_INTAKE_SIMPLE_REVISION } from "./simple-revision";
/** Stored only after strict reader parsing, citations and coverage validation. */
export const SAV_INTAKE_SEMANTIC_RECORD_REVISION = "sav-intake-accepted-results.v1";
export type AcceptedIntakeSemantics = {
  revision: typeof SAV_INTAKE_SEMANTIC_RECORD_REVISION;
  validatorRevision: string;
  records: Array<{ method: keyof SavIntakeSemanticReaders; input: unknown; result: unknown;
    inputHash: string; resultHash: string; acceptedAt: string }>;
};
export function intakeSemanticInputHash(input: unknown) {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter(v => !(v && typeof v === "object" && "source" in v && v.source === "human_override")).map(strip);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "observedAt").map(([key, v]) => [key, strip(v)]));
    return value;
  };
  return savIntakeEvidenceContentHash(strip(JSON.parse(JSON.stringify(input))));
}
function validateAccepted(method: keyof SavIntakeSemanticReaders, input: unknown, result: unknown) {
  const reject = () => { throw Error("SAV_INTAKE_SEMANTIC_COVERAGE_REJECTED"); };
  if (method === "analyseMessage") {
    const i = input as Parameters<SavIntakeSemanticReaders["analyseMessage"]>[0], r = messageAnalysisSchema.parse(result);
    if (r.attachmentObservations?.some(o => !i.message.attachmentInputs?.some(a => a.sourceId === o.sourceId && a.fileHash === o.fileHash))) reject();
    if (r.messageId !== i.message.id || r.requests.some(q => q.currentMessageId !== i.message.id)
      || new Set(r.requests.map(q => q.id)).size !== r.requests.length) reject();
    for (const request of r.requests.filter(q => q.originMessageId)) {
      const initial = i.conversation.find(m => m.id === request.originMessageId);
      if (request.originMessageId !== i.identificationContinuation?.initialMessageId || !initial || !initial.contentComplete
        || initial.direction !== "inbound" || initial.threadId !== i.message.threadId || initial.fromEmail.toLowerCase() !== i.message.fromEmail.toLowerCase()
        || !r.registration || r.registration.sourceMessageId !== i.message.id || !i.message.currentText.includes(r.registration.quote)
        || !r.registration.quote.toLowerCase().includes(r.registration.address.toLowerCase())) reject();
    }
  } else if (method === "assessIdentity") {
    const i = input as Parameters<NonNullable<SavIntakeSemanticReaders["assessIdentity"]>>[0], r = identityAssessmentSchema.parse(result);
    if (r.contactIds.some(id => !i.candidates.some(c => c.contact.id === id)) || new Set(r.contactIds).size !== r.contactIds.length
      || r.evidenceIds.some(id => !i.evidence.some(e => e.id === id))) reject();
    if (r.investigationComplete && r.kind !== "unknown") {
      const required = ["current", ...i.candidates.flatMap(c => [`contact-${c.contact.id}`, `identity-search-${c.contact.id}`,
        ...c.tickets.flatMap(t => [`identity-ticket-${t.ticket.id}`, `identity-history-${t.ticket.id}`])])];
      if (required.some(id => !r.evidenceIds.includes(id)) || r.kind === "unique" && r.contactIds.length !== 1
        || r.kind === "equivalent" && r.contactIds.length < 2) reject();
    }
  } else {
    const i = input as Parameters<SavIntakeSemanticReaders["assessIssues"]>[0], r = issueAssessmentSchema.parse(result);
    if (r.tickets.length !== i.tickets.length || new Set(r.tickets.map(t => t.ticketId)).size !== r.tickets.length) reject();
    for (const t of r.tickets) {
      if (!i.tickets.some(row => row.ticket.id === t.ticketId) || ["current", ...(i.requestContext ? ["initial-request"] : []), `ticket-${t.ticketId}`, `history-${t.ticketId}`].some(id => !t.evidenceIds.includes(id))
        || t.evidenceIds.some(id => !i.evidence.some(e => e.id === id)) || t.requestIds.some(id => !i.requests.some(q => q.id === id))
        || t.relation === "same" && (new Set(t.requestIds).size !== i.requests.length || i.requests.some(q => !t.requestIds.includes(q.id)))) reject();
    }
  }
}
export function recordAcceptedIntakeSemantics(readers: SavIntakeSemanticReaders, envelope: AcceptedIntakeSemantics,
  onAccepted: () => void, onRejected?: (failure: { method: keyof SavIntakeSemanticReaders; errorCode: string }) => void): SavIntakeSemanticReaders {
  const wrap = (method: keyof SavIntakeSemanticReaders) => async (input: unknown, signal: AbortSignal) => {
    const fn = readers[method];
    if (!fn) throw Error("SAV_INTAKE_SEMANTIC_RESULT_MISSING");
    const result = await (fn as (i: unknown, s: AbortSignal) => Promise<unknown>)(input, signal);
    try { validateAccepted(method, input, result); }
    catch (error) {
      onRejected?.({ method, errorCode: error instanceof Error && /^SAV_INTAKE_[A-Z_]+$/.test(error.message)
        ? error.message : "SAV_INTAKE_SEMANTIC_OUTPUT_REJECTED" });
      throw error;
    }
    const record = { method, input: structuredClone(input), result: structuredClone(result), inputHash: intakeSemanticInputHash(input),
      resultHash: savIntakeEvidenceContentHash(JSON.parse(JSON.stringify(result))), acceptedAt: new Date().toISOString() };
    const prior = envelope.records.find(row => row.method === method && row.inputHash === record.inputHash);
    if (prior && prior.resultHash !== record.resultHash) throw Error("SAV_INTAKE_SEMANTIC_RESULT_CONFLICT");
    if (!prior) envelope.records.push(record);
    onAccepted();
    return result;
  };
  return { analyseMessage: wrap("analyseMessage") as SavIntakeSemanticReaders["analyseMessage"],
    assessIdentity: wrap("assessIdentity") as SavIntakeSemanticReaders["assessIdentity"],
    assessIssues: wrap("assessIssues") as SavIntakeSemanticReaders["assessIssues"] };
}
export function acceptedIntakeResult<T>(envelope: AcceptedIntakeSemantics | undefined, method: keyof SavIntakeSemanticReaders, input: unknown): T {
  // Both readers produce the engine's own result shapes; the record names which validator accepted it.
  if (envelope?.revision !== SAV_INTAKE_SEMANTIC_RECORD_REVISION || ![SAV_INTAKE_MODEL_REVISION, SAV_INTAKE_SIMPLE_REVISION].includes(envelope.validatorRevision))
    throw Error("SAV_INTAKE_SEMANTIC_PROVENANCE_MISSING");
  const rows = envelope.records.filter(row => row.method === method && row.inputHash === intakeSemanticInputHash(input)
    && row.inputHash === intakeSemanticInputHash(row.input) && row.resultHash === savIntakeEvidenceContentHash(row.result));
  if (rows.length !== 1) throw Error("SAV_INTAKE_SEMANTIC_CONTEXT_CHANGED");
  validateAccepted(method, input, rows[0].result);
  return structuredClone(rows[0].result) as T;
}

/** Resuming a read never buys a third understanding attempt. Reuse requires an
 * accepted current-validator record with the same complete input and bounded age. */
export function reuseAcceptedIntakeSemantics(readers: SavIntakeSemanticReaders, envelope: AcceptedIntakeSemantics,
  onHit: (method: keyof SavIntakeSemanticReaders) => void, now = () => new Date()): SavIntakeSemanticReaders {
  const wrap = (method: keyof SavIntakeSemanticReaders) => async (input: unknown, signal: AbortSignal) => {
    const rows = envelope.records.filter(r => r.method === method && r.inputHash === intakeSemanticInputHash(input));
    if (rows.length) {
      const age = now().getTime() - Date.parse(rows[0].acceptedAt);
      if (!Number.isFinite(age) || age < 0 || age >= 300_000) throw Error("SAV_INTAKE_SEMANTIC_CONTEXT_CHANGED");
      const result = acceptedIntakeResult(envelope,method,input); onHit(method); return result;
    }
    if (method === "analyseMessage") throw Error("SAV_INTAKE_SEMANTIC_PROVENANCE_MISSING");
    const fn=readers[method];if(!fn)throw Error("SAV_INTAKE_SEMANTIC_RESULT_MISSING");
    return (fn as (i:unknown,s:AbortSignal)=>Promise<unknown>)(input,signal);
  };
  return { analyseMessage:wrap("analyseMessage") as SavIntakeSemanticReaders["analyseMessage"],
    assessIssues:wrap("assessIssues") as SavIntakeSemanticReaders["assessIssues"],assessIdentity:wrap("assessIdentity") as SavIntakeSemanticReaders["assessIdentity"] };
}
