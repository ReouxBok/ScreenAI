import { z } from "zod";
import { savAttachmentObservationSchema, savAttachmentReasonSchema } from "../attachment-contract";
import { intakeOperatorInformationSchema } from "./operator-information-contract";
import type { SavIntakeDecision, SavIntakeMutation } from "./contract";

const id = z.string().regex(/^\d{1,30}$/);
const ref = z.string().min(1).max(200);
export const intakeMessageSchema = z.object({
  id: z.uuid(), threadId: z.uuid(), receivedAt: z.iso.datetime(),
  fromEmail: z.email(), toEmails: z.array(z.email()).min(1).max(30),
  // Transport must provide the current authored part, not quoted history/signatures.
  currentText: z.string().max(100_000), contentComplete: z.boolean(),
  direction: z.enum(["inbound", "outbound"]),
  operatorInformation: intakeOperatorInformationSchema.optional(),
  attachmentInputs: z.array(z.object({ sourceId: ref, fileHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(3).optional(),
  // Files of a complete text that were NOT read (unsupported type, too large, invalid).
  // Never content: the reader must judge whether the written request suffices without them.
  unreadAttachments: z.array(z.object({ sourceId: ref, reason: savAttachmentReasonSchema }).strict()).min(1).max(20).optional(),
}).strict();
export type IntakeMessage = z.infer<typeof intakeMessageSchema>;
export const intakeContactSchema = z.object({ id, emails: z.array(z.email()).min(1).max(50) }).strict();
export type IntakeContact = z.infer<typeof intakeContactSchema>;
export const intakeAssociationSchema = z.object({
  fromContactId: id, toContactId: id, typeId: z.number().int().nonnegative(),
  category: z.enum(["HUBSPOT_DEFINED", "USER_DEFINED"]),
}).strict();
export type IntakeAssociation = z.infer<typeof intakeAssociationSchema>;
export const intakeTicketSchema = z.object({
  id, contactIds: z.array(id).min(1).max(50),
  stage: z.enum(["new", "open", "closed", "unknown"]),
  createdAt: z.iso.datetime().optional(), closedAt: z.iso.datetime().optional(),
  ownerId: id.nullable().optional(), subject: z.string().max(2000), content: z.string().max(100_000),
}).strict();
export type IntakeTicket = z.infer<typeof intakeTicketSchema>;
export const intakeHistorySchema = z.array(z.object({
  id: ref, kind: z.enum(["note", "email", "stage"]), text: z.string().max(100_000), at: z.iso.datetime(),
}).strict()).max(100);
export type IntakeHistory = z.infer<typeof intakeHistorySchema>;
export type ReadResult<T> = { status: "complete" | "partial" | "failed"; data: T; observedAt: string; reconstructedAsOf?: string };
export const messageAnalysisSchema = z.object({
  messageId: z.uuid(),
  nature: z.enum(["request", "newsletter", "information", "indeterminate"]).optional(),
  requests: z.array(z.object({
    id: ref, kind: z.enum(["support", "finance", "cancellation", "partnership", "commercial", "investor", "other", "acknowledgement", "unknown"]),
    // All intentions must be supported by the CURRENT authored message.
    currentMessageId: z.uuid(),
    originMessageId: z.uuid().optional(),
  }).strict()).max(15),
  attachmentObservations: z.array(savAttachmentObservationSchema).max(3).optional(),
  imageRequirements: z.array(z.object({ sourceId: ref, fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    role: z.enum(["accessory", "required", "unknown"]), textQuote: z.string().min(1).max(2000).optional() }).strict()).max(3).optional(),
  unreadAttachmentRequirements: z.array(z.object({ sourceId: ref, role: z.enum(["accessory", "required", "unknown"]),
    textQuote: z.string().min(1).max(2000).optional() }).strict()).max(20).optional(),
  registration: z.object({ address: z.email(), sourceMessageId: z.uuid(), quote: z.string().min(1).max(2000) }).strict().optional(),
  ticketSummary: z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(100_000), requestIds: z.array(ref).min(1).max(15) }).strict().optional(),
}).strict();
export type MessageAnalysis = z.infer<typeof messageAnalysisSchema>;
export const issueAssessmentSchema = z.object({
  investigationComplete: z.boolean(),
  tickets: z.array(z.object({
    ticketId: id, relation: z.enum(["same", "different", "partial", "unknown"]),
    requestIds: z.array(ref).max(15), evidenceIds: z.array(ref).min(1).max(100),
  }).strict()).max(20),
}).strict();
export type IssueAssessment = z.infer<typeof issueAssessmentSchema>;
export const identityAssessmentSchema = z.object({
  kind: z.enum(["unique", "equivalent", "unknown"]), investigationComplete: z.boolean(),
  contactIds: z.array(id).max(10), evidenceIds: z.array(ref).min(1).max(95),
}).strict();
export type IdentityAssessment = z.infer<typeof identityAssessmentSchema>;
export type IntakeEvidence = SavIntakeDecision["evidence"][number];
export type PrivateResource = { resourceId: string; revisionId: string; sha256: string };
export type EnginePolicy = {
  relationRevision: string;
  admittedRelations: Array<{ typeId: number; category: IntakeAssociation["category"] }>;
  resources: {
    identification?: PrivateResource; registrationNotFound?: PrivateResource;
    multiTicketWarning?: PrivateResource & { text: string };
    partnership?: PrivateResource; commercial?: PrivateResource; investor?: PrivateResource;
  };
  // Server-qualified rules and operator overrides are inputs, never inferred from a brand keyword.
  qualifiedOther?: { family?: "authenticated_newsletter"; resource: PrivateResource; evidenceSource: "private_rule" | "human_override" };
  manualSupportOverride?: PrivateResource;
};
export type IntakeAdapters = {
  analyseMessage(input: { message: IntakeMessage; conversation: readonly IntakeMessage[]; identificationContinuation?: EngineInput["identificationContinuation"] }, signal: AbortSignal): Promise<MessageAnalysis>;
  findContactsByEmail(email: string, signal: AbortSignal): Promise<ReadResult<IntakeContact[]>>;
  directAssociations(contactId: string, signal: AbortSignal): Promise<ReadResult<IntakeAssociation[]>>;
  getContact(contactId: string, signal: AbortSignal): Promise<ReadResult<IntakeContact>>;
  ticketsForContact(contactId: string, signal: AbortSignal): Promise<ReadResult<IntakeTicket[]>>;
  ticketHistory(ticketId: string, signal: AbortSignal): Promise<ReadResult<IntakeHistory>>;
  assessIdentity?(input: { message: IntakeMessage; address: string;
    candidates: readonly { contact: IntakeContact; tickets: { ticket: IntakeTicket; history: IntakeHistory }[] }[];
    evidence: readonly IntakeEvidence[]; requestContext?: IntakeMessage }, signal: AbortSignal): Promise<IdentityAssessment>;
  assessIssues(input: {
    message: IntakeMessage; requests: MessageAnalysis["requests"];
    tickets: readonly { ticket: IntakeTicket; history: IntakeHistory }[]; evidence: readonly IntakeEvidence[]; requestContext?: IntakeMessage;
  }, signal: AbortSignal): Promise<IssueAssessment>;
};
export type EngineInput = {
  message: IntakeMessage; latestInboundMessageId: string; conversation: ReadResult<IntakeMessage[]>;
  now: string; mode: "at_receipt" | "current"; identificationAttemptId: string;
  humanResolution?: {
    suppressOutbound?: true;
    choiceId: string; at: string; contactId?: string; equivalentContactIds?: string[];
    inheritedChoiceIds?:string[]; fieldSources?:Partial<Record<"contactId"|"ticketId"|"classification",string>>;
    ticketId?: string; classification?: MessageAnalysis["requests"][number]["kind"];
  };
  previousIdentification?: { messageId: string; address: string; state: "dispatched" | "uncertain" | "confirmed" };
  identificationContinuation?: { initialMessageId: string; confirmedEffectId: string };
};
export type IntakePlanStep = {
  id: string; mutation: SavIntakeMutation; ticketId: string | null;
  requiresPermission: SavIntakeMutation; status: "not_dispatched";
};
export type IntakePlan = {
  revision: "sav-intake-engine-2026-10-20.v1";
  fingerprint: string;
  decision: SavIntakeDecision;
  steps: IntakePlanStep[];
  progress: import("./contract").SavIntakeProgress;
  noteText: string | null;
  supervisedResource?: PrivateResource;
  candidateContactIds?: string[];
  // Provider-independent creation intent. The future writer must reuse the existing
  // savSupportTicketProperties mapper; this is not a HubSpot POST payload.
  newTicket?: { contactId: string; title: string; description: string; requestIds: string[];
    pipeline: "support"; stage: "new"; source: "email"; owner: "leave_unassigned" };
  originalThreadId: string; originalRecipientEmails: string[];
  referenceMode: EngineInput["mode"];
  readCalls: number;
  effects: "not_connected";
};
export type EngineLimits = { readCalls: number; timeoutMs: number; contacts: number; tickets: number };
