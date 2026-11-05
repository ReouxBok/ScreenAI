// V2 customer return (LOCAL, OFF): reads the facts of one new inbound mail, routes it with `decideCustomerReturn`, and writes the routes that are V2's
// (continue, reopen, hand to the team) with `recordCustomerReturn`. Every other route writes nothing: V1's normal intake and relay keep the mail as before.
// Called by the V2 entry (`v2-entry.ts`) behind its own flag. Reads the database, and the ticket owner through an injected port only when the route needs it (one GET, no write).
import "server-only";
import { and, eq, inArray, min, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEvents, savCases, savIntakeExecutions, savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { intakeAutomatedMessage } from "../intake/automated-message";
import type { ExecutionPayload } from "../intake/execution-types";
import type { CaseAdmissionInput } from "./admission-policy";
import { CaseVersionStaleError, listCaseEvents, readCase, recordCustomerReturn, savCaseRecordingEnabled, type CaseTx, type CustomerReturnRecord } from "./case-store";
import { caseDedupeKey } from "./case-types";
import {
  customerMailOrder, customerReturnNeedsOwner, decideAccessAutoApproval, decideCustomerReturn, readAccessAutoApprovalConfig,
  type AccessAutoApprovalFacts, type CustomerReturnFacts, type CustomerReturnOwnerNow, type CustomerReturnRoute,
} from "./customer-return";
import type { CaseReplyAuthorizationRequest, CaseReplyAuthorizer } from "./case-reply-validation";
import { readIntakeAcknowledgement, relayAdmissionInput, relayPaused, v2HubspotOwnerId, type CaseBoundaryDeps } from "./intake-boundary";

type Env = Record<string, string | undefined>;
export type CustomerReturnDeps = {
  env?: Env;
  /** The HubSpot owner of a ticket, read now. Throws when it cannot read; `undefined` is unknown, never nobody. Absent: nothing is continued. */
  readTicketOwner?: (ticketId: string) => Promise<string | null | undefined>;
  /** The same admission sources as the relay, used only for a mail V1 confirmed on this ticket. */
  readAdmissionPolicy?: CaseBoundaryDeps["readAdmissionPolicy"];
  readQualification?: CaseBoundaryDeps["readQualification"];
  /** THIS mail's admission. Default: V1's confirmed decision of it. None (consumed before V1): the admission stays stale, nothing inherited. */
  readMailAdmission?: (input: { messageId: string; gmailMessageId: string; ticketId: string }) => Promise<CaseAdmissionInput | null>;
  /** First statement of the `continue` transaction (see `CustomerReturnWrite.fence`): the entry gate ends V1's run there. */
  fence?: (tx: CaseTx) => Promise<void>;
  /** Defaults read V1's own records: its accepted acknowledgement, its confirmed execution, the stored Gmail headers. */
  readAcknowledgement?: (messageId: string) => Promise<boolean>;
  readV1Target?: (messageId: string, caseTicketId: string) => Promise<CustomerReturnFacts["v1Target"]>;
  readAutomated?: (messageId: string) => Promise<boolean>;
};

export type CustomerReturnOutcome =
  | Readonly<{ skipped: "recording_off" | "source_missing" }>
  | Readonly<{ route: CustomerReturnRoute; caseId: string | null; written: false; retry?: "version_moved" }>
  | Readonly<{ route: CustomerReturnRoute; caseId: string; written: true; record: CustomerReturnRecord }>;

async function readOwner(ticketId: string, deps: CustomerReturnDeps): Promise<CustomerReturnOwnerNow> {
  const v2 = v2HubspotOwnerId(deps.env);
  if (!v2 || !deps.readTicketOwner) return "unknown";
  let reading: string | null | undefined;
  try { reading = await deps.readTicketOwner(ticketId); } catch { return "unknown"; }
  if (reading === null) return "none";
  if (reading === undefined || !/^[0-9]{1,20}$/.test(reading)) return "unknown";
  return reading === v2 ? "v2" : "human";
}

/** V1's confirmed execution of this mail: its ticket is the case's (linked, or reopened by V1's 15-day same-subject rule), another one, or none yet. */
async function readV1Target(messageId: string, caseTicketId: string): Promise<CustomerReturnFacts["v1Target"]> {
  const [execution] = await requireDb().select({ state: savIntakeExecutions.state, ticketId: savIntakeExecutions.ticketId }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId));
  if (!execution || execution.state === "refused") return "none";
  if (execution.state !== "confirmed") return "pending";
  if (!execution.ticketId) return "none";
  return execution.ticketId === caseTicketId ? "same_ticket" : "other_ticket";
}

/** The admission of this very mail from V1's confirmed decision of it, on the relay's sources: a sensitive or mixed mail excludes, an unproven one admits nobody. No confirmed execution on this ticket: none. */
async function readMailAdmission(input: { messageId: string; gmailMessageId: string; ticketId: string }, deps: CustomerReturnDeps): Promise<CaseAdmissionInput | null> {
  const [execution] = await requireDb().select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, input.messageId));
  if (execution?.state !== "confirmed" || execution.ticketId !== input.ticketId) return null;
  const decision = decryptSavPayload<ExecutionPayload>(execution.payloadCiphertext).plan.decision;
  const { admission } = await relayAdmissionInput({ messageId: input.messageId, gmailMessageId: input.gmailMessageId, decision, confirmedTicket: true,
    deps: { ...(deps.env ? { env: deps.env } : {}), ...(deps.readAdmissionPolicy ? { readAdmissionPolicy: deps.readAdmissionPolicy } : {}), ...(deps.readQualification ? { readQualification: deps.readQualification } : {}) },
    target: { ticketId: input.ticketId, executionId: execution.id, runId: execution.runId, runVersion: execution.runVersion } });
  return admission;
}

/** Whether a customer mail already on the case's journal comes later than this one. A journal mail no longer stored is placed by the date it recorded. */
async function olderThanRecorded(message: { id: string; receivedAt: Date; createdAt: Date }, caseId: string) {
  const recorded = (await listCaseEvents(caseId)).filter(event => event.kind === "inbound_confirmed" && event.direction === "customer_inbound" && event.sourceRef?.type === "email");
  if (!recorded.length) return false;
  const rows = await requireDb().select({ id: savMessages.id, gmail: savMessages.gmailMessageId, receivedAt: savMessages.receivedAt, createdAt: savMessages.createdAt }).from(savMessages)
    .where(inArray(savMessages.gmailMessageId, recorded.map(event => event.sourceRef!.id)));
  return recorded.some(event => {
    const row = rows.find(candidate => candidate.gmail === event.sourceRef!.id);
    return row ? customerMailOrder(row, message) > 0 : Date.parse(event.occurredAt) > message.receivedAt.getTime();
  });
}

/** The V1 automation gate on the stored mail: Gmail headers and the thread's own support messages, never the subject alone. */
async function readAutomated(messageId: string): Promise<boolean> {
  const db = requireDb();
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, messageId));
  if (!message) return false;
  type Body = { text?: unknown; headers?: unknown; attachments?: unknown };
  const body = decryptSavPayload<Body>(message.bodyCiphertext);
  const outbound = await db.select({ body: savMessages.bodyCiphertext }).from(savMessages).where(and(eq(savMessages.threadId, message.threadId), eq(savMessages.direction, "outbound")));
  const supportMessageIds = outbound.flatMap(row => {
    const headers = decryptSavPayload<Body>(row.body).headers as Record<string, unknown> | undefined;
    return headers?.["x-studio-automation-headers"] === "singleton-v1" && typeof headers["message-id"] === "string" ? [headers["message-id"].trim()] : [];
  });
  const text = typeof body.text === "string" ? body.text : "";
  return intakeAutomatedMessage({
    message: { id: message.id, threadId: message.threadId, receivedAt: message.receivedAt.toISOString(), fromEmail: message.fromEmail, toEmails: message.toEmails,
      currentText: text, contentComplete: typeof body.text === "string", direction: message.direction as "inbound" | "outbound" },
    headers: body.headers, attachments: body.attachments, supportMessageIds, bodyText: text, subject: message.subject,
  }) !== null;
}

/** The facts of one stored inbound mail, owner not read yet (`unknown`). */
export async function readCustomerReturnFacts(messageId: string, deps: CustomerReturnDeps = {}) {
  const db = requireDb();
  const [message] = await db.select({ id: savMessages.id, threadId: savMessages.threadId, gmailMessageId: savMessages.gmailMessageId, direction: savMessages.direction, receivedAt: savMessages.receivedAt, createdAt: savMessages.createdAt })
    .from(savMessages).where(eq(savMessages.id, messageId));
  if (!message || message.direction !== "inbound" || !message.gmailMessageId) return null;
  const cases = await db.select({ id: savCases.id }).from(savCases).where(sql`${message.threadId} = any(${savCases.threadIds})`).limit(2);
  const current = cases.length === 1 ? await readCase(cases[0]!.id) : null;
  const base = { message: { ...message, gmailMessageId: message.gmailMessageId }, case: current };
  if (!current) return { ...base, facts: { link: cases.length > 1 ? "several_cases" : "no_case", case: null, alreadyRecorded: false, beforeCase: false, automated: false,
    acknowledgement: false, v1Target: "none", olderThanLatest: false, ownerNow: "unknown", paused: false } as CustomerReturnFacts };
  const [recorded] = await db.select({ id: savCaseEvents.id }).from(savCaseEvents)
    .where(and(eq(savCaseEvents.caseId, current.caseId), eq(savCaseEvents.dedupeKey, caseDedupeKey.inbound(message.gmailMessageId))));
  const [first] = await db.select({ at: min(savCaseEvents.occurredAt) }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, current.caseId), eq(savCaseEvents.kind, "inbound_confirmed")));
  const facts: CustomerReturnFacts = {
    link: "one_case", case: { owner: current.owner, phase: current.phase, sensitivity: current.sensitivity }, alreadyRecorded: Boolean(recorded),
    beforeCase: Boolean(first?.at && message.receivedAt < new Date(first.at)),
    automated: await (deps.readAutomated ?? readAutomated)(message.id),
    acknowledgement: await (deps.readAcknowledgement ?? (async (id: string) => await readIntakeAcknowledgement(id) !== null))(message.id),
    v1Target: await (deps.readV1Target ?? readV1Target)(message.id, current.ticketId),
    olderThanLatest: !recorded && await olderThanRecorded(message, current.caseId),
    ownerNow: "unknown", paused: await relayPaused(db),
  };
  return { ...base, facts };
}

/** Routes one new inbound mail and writes the routes that are V2's. A concurrent write (a relay, another pass) is decided again from what was written, twice at most. */
export async function routeCustomerReturn(messageId: string, deps: CustomerReturnDeps = {}): Promise<CustomerReturnOutcome> {
  if (!savCaseRecordingEnabled(deps.env)) return { skipped: "recording_off" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await readCustomerReturnFacts(messageId, deps);
    if (!read) return { skipped: "source_missing" };
    let route = decideCustomerReturn(read.facts);
    if (customerReturnNeedsOwner(route) && read.case) route = decideCustomerReturn({ ...read.facts, ownerNow: await readOwner(read.case.ticketId, deps) });
    if (!read.case || (route.route !== "continue" && route.route !== "reopen" && route.route !== "hand_to_team")) return { route, caseId: read.case?.caseId ?? null, written: false };
    try {
      const identity = { messageId: read.message.id, gmailMessageId: read.message.gmailMessageId, ticketId: read.case.ticketId };
      const admission = route.route === "hand_to_team" ? null : await (deps.readMailAdmission ?? (input => readMailAdmission(input, deps)))(identity);
      const record = await recordCustomerReturn({
        route: route.route, reason: route.reason, caseId: read.case.caseId, expectedVersion: read.case.version, ticketId: read.case.ticketId, threadId: read.message.threadId,
        messageId: read.message.id, gmailMessageId: read.message.gmailMessageId, receivedAt: read.message.receivedAt.toISOString(),
        ...(admission ? { admission } : {}), ...(route.route === "continue" && deps.fence ? { fence: deps.fence } : {}),
      });
      return { route, caseId: read.case.caseId, written: true, record };
    } catch (error) {
      if (!(error instanceof CaseVersionStaleError)) throw error;
      if (attempt === 2) return { route, caseId: read.case.caseId, written: false, retry: "version_moved" };
    }
  }
  throw Error("SAV_CASE_RETURN_UNREACHABLE");
}

/** `CaseReplyAuthorizer` of the access rule: an explicit yes only from `decideAccessAutoApproval` on facts the injected port read just now. No port, a port that
 * fails, or any fact outside the rule is a refusal, and the reply waits for a person as before. */
export function accessAutoReplyAuthorizer(deps: { env?: Env; readFacts?: (request: CaseReplyAuthorizationRequest) => Promise<AccessAutoApprovalFacts | null> }): CaseReplyAuthorizer {
  return async request => {
    const config = readAccessAutoApprovalConfig(deps.env ?? {});
    let facts: AccessAutoApprovalFacts | null = null;
    if (config.mode === "on" && deps.readFacts) { try { facts = await deps.readFacts(request); } catch { facts = null; } }
    const outcome = decideAccessAutoApproval({ config, action: request.action, approverId: request.approverId, purpose: request.purpose, facts });
    return outcome.allowed ? { allowed: true, basis: outcome.basis } : { allowed: false, reason: outcome.reason };
  };
}
