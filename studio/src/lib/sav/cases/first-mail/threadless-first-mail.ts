import "server-only";
import { requireDb } from "@/db";
import { containsPromptInjection } from "../../policy";
import { accessSkillKernelHits } from "../access-skill/access-skill-kernel";
import type { AccessSkillReading } from "../access-skill/access-skill-judge";
import { caseAdmissionStatus } from "../admission-policy";
import { caseEffectHash, caseReplyPayloadHash, type CaseReplyProposal } from "../case-effects";
import { caseReplyEditableBody, finalizeCaseReplyProposal } from "../case-reply-outbound";
import { decideCaseReply, submitCaseReplyProposal, type CaseReplyStoreDeps } from "../case-reply-store";
import { queueValidatedCaseReply } from "../case-runtime-effects";
import { judgeCurrentTicketOwner, type CaseTicketOwnerPort } from "../case-ticket-owner";
import { listCaseEvents, lockCaseForWrite, readCase, readCaseThreadlessSource, transitionCaseOwner } from "../case-store";
import type { CaseEvent, CaseSnapshot } from "../case-types";
import { accessAutoReplyAuthorizer } from "../customer-return-store";
import { readAccessAutoApprovalConfig } from "../customer-return";
import { maskCaseCustomerText, SAV_CASE_CUSTOMER_CONTEXT_LIMITS, SAV_CASE_CUSTOMER_CONTEXT_NOTICE, SAV_CASE_CUSTOMER_CONTEXT_REVISION, type CaseCustomerContext } from "../investigation-customer-context";
import { caseAccessScopeStamp, readCaseDecisionScopes } from "../investigation-access-scope";
import { caseDecisionDraft } from "../investigation-intent";
import { readCaseInvestigationProgress } from "../investigation-record";
import { runCaseInvestigationRuntime, type CaseInvestigationRuntimeDeps } from "../investigation-runtime";
import { pilotProvenanceGate, readPilotReplyProvenance, type PilotProvenanceDeps } from "../pilot-passage-provenance";
import { savV2NewThreadAutoEnabled, threadlessReplySubject } from "../threadless-config";
import { threadlessInputKey } from "../threadless-provenance";
import { threadlessRequestId, threadlessTicketPlainDescription, threadlessTicketSourceRef, type ThreadlessTicketSource } from "../threadless-source";
import { threadlessAutoSendProblem } from "./first-mail-authority";
import { firstMailSkillPinned, SAV_FIRST_MAIL_PROMPT_SUFFIX } from "./first-mail-skill";

/*
 * SAV-96 B (Ugo 18/11): the FIRST mail of a HubSpot ticket that has no email thread, written by the V2 decision model on the normal V2 path,
 * framed by the first-mail skill, and sent without a click when the existing Access auto-reply authority covers it.
 *
 *   1. Sensitive first: SAV-97's kernel, then its judge and counter-read on the TICKET text (stored reading reused, else computed once).
 *      Anything but « admit » leaves the whole ticket to the team; nothing is written for the customer.
 *   2. The normal V2 investigation (`runCaseInvestigationRuntime`): knowledge cards, decision validator, call ledger and V2 budget. The ticket's
 *      own stored event is the input; its subject and description are the only customer text, as untrusted data; the CRM notes are never shown.
 *   3. The recorded decision becomes ONE proposal (`caseDecisionDraft`, SAV-94 layout, `finalizeCaseReplyProposal`, help line, signature, mention).
 *   4. Automated only when every right holds (`first-mail-authority.ts` + A's Access rule on facts read now); otherwise a person validates it.
 *
 * Anything the model path cannot prove returns `fallback`: the caller keeps today's fixed draft for a person (never a silent drop, never a send).
 */

type Env = Record<string, string | undefined>;

export type ThreadlessFirstMailDeps = Readonly<{
  env: () => Env;
  /** The V2 investigation's ports (`createCaseInvestigationV2Deps`); the ticket input, text and context are set here. */
  investigation: CaseInvestigationRuntimeDeps;
  provenance: PilotProvenanceDeps;
  /** C's owner port (the CRM read now). */
  readTicketOwner: CaseTicketOwnerPort;
  /** The approved execution policy an automated first mail is queued under; null: a person validates it. */
  executionPolicy: Readonly<{ id: string; hash: string }> | null;
  /** SAV-97's reading of the ticket (`readOrComputeAccessSkill`, purpose `first_mail`): the stored one, or computed once. */
  accessSkill: (source: ThreadlessTicketSource) => Promise<AccessSkillReading>;
}>;

export type ThreadlessFirstMailResult =
  | Readonly<{ status: "fallback"; reason: string }>
  | Readonly<{ status: "team"; reason: string }>
  | Readonly<{ status: "awaiting_person"; validationId: string; reasons: readonly string[] }>
  | Readonly<{ status: "queued"; validationId: string; executionId: string }>;

/** The ticket as the model may read it: subject and description only, masked and bounded, flagged when they look like an instruction. Never a note. */
export function threadlessFirstMailContext(source: ThreadlessTicketSource, observedAt: string): CaseCustomerContext {
  const L = SAV_CASE_CUSTOMER_CONTEXT_LIMITS;
  const description = maskCaseCustomerText(threadlessTicketPlainDescription(source)), subject = maskCaseCustomerText(source.subject);
  return {
    revision: SAV_CASE_CUSTOMER_CONTEXT_REVISION, notice: SAV_CASE_CUSTOMER_CONTEXT_NOTICE,
    latestMessage: { at: observedAt, from: "customer", text: description.slice(0, L.latestMessageChars), truncated: description.length > L.latestMessageChars,
      subject: subject.slice(0, L.subjectChars), instructionLikeText: containsPromptInjection(`${source.subject}\n${description}`) },
    thread: [], threadOmitted: 0, crm: null, missing: [],
  };
}

/** Hands the whole ticket to the team (same transition as the B entry's wait), nothing for the customer. Idempotent on the command key. */
async function handToTeam(caseId: string, reason: string) {
  await requireDb().transaction(async tx => {
    const snapshot = await lockCaseForWrite(tx, caseId);
    if (snapshot.owner !== "agent" || snapshot.threadIds.length) return;
    await transitionCaseOwner({ caseId, expectedVersion: snapshot.version, transition: "handoff", actor: { type: "agent" },
      commandKey: `first-mail-team.${caseId}`, reason: reason.slice(0, 80) }, tx);
  });
}

export async function composeThreadlessFirstMail(caseId: string, deps: ThreadlessFirstMailDeps): Promise<ThreadlessFirstMailResult> {
  const env = deps.env();
  if (!savV2NewThreadAutoEnabled(env)) return { status: "fallback", reason: "new_thread_auto_off" };
  if (!firstMailSkillPinned()) return { status: "fallback", reason: "first_mail_skill_unpinned" };
  const stored = await readCaseThreadlessSource(requireDb(), caseId);
  const opened = await readCase(caseId);
  if (!stored?.source.contact || !opened || opened.owner !== "agent" || opened.threadIds.length) return { status: "fallback", reason: "case_not_first_mail" };
  const source = stored.source, request = opened.body.openRequests.find(row => row.status === "open");
  if (!request || opened.body.openRequests.filter(row => row.status === "open").length !== 1) return { status: "fallback", reason: "request_unproven" };

  // 1. Sensitive first. The kernel needs no call; the judge and its counter-read are SAV-97's, on the ticket's own words.
  if (accessSkillKernelHits(source.subject, threadlessTicketPlainDescription(source)).length) {
    await handToTeam(caseId, "sensitive_request");
    return { status: "team", reason: "kernel_phrase" };
  }
  if (request.id !== threadlessRequestId(source)) return { status: "fallback", reason: "request_unproven" };
  const reading = await deps.accessSkill(source)
    .catch((): AccessSkillReading => ({ status: "unavailable", reason: "store_failed" }));
  if (reading.status !== "ready" || reading.verdict.outcome !== "admit" || reading.verdict.requests[request.id] !== "access") {
    const reason = reading.status !== "ready" ? `access_skill_${reading.reason}` : reading.verdict.outcome === "team" ? `access_skill_${reading.verdict.reasons[0]}` : "access_skill_not_access";
    await handToTeam(caseId, reason);
    return { status: "team", reason };
  }

  // 2. The normal V2 investigation, the ticket as its input.
  const inputKey = threadlessInputKey(stored.eventId), sourceRef = threadlessTicketSourceRef(source);
  const ticketText = `${source.subject}\n${threadlessTicketPlainDescription(source)}`;
  const base = deps.investigation;
  const investigation: CaseInvestigationRuntimeDeps = {
    ...base,
    threadlessInput: (snapshot: CaseSnapshot, events: readonly CaseEvent[]) =>
      !snapshot.threadIds.length && events.some(event => event.id === stored.eventId && event.kind === "crm_observed") ? { inputKey, sourceRef } : null,
    customerContext: async () => threadlessFirstMailContext(source, stored.observedAt),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.filter(ref => ref.type === sourceRef.type && ref.id === sourceRef.id).map(ref => [`${ref.type}:${ref.id}`, ticketText])),
    revisions: async () => { const revisions = await base.revisions!(); return { ...revisions, prompt: `${revisions.prompt}${SAV_FIRST_MAIL_PROMPT_SUFFIX}` }; },
    model: { ...base.model,
      ...(base.model.preflight ? { preflight: request => base.model.preflight!({ ...request, firstMail: true }) } : {}),
      ...(base.model.provider ? { provider: request => base.model.provider!({ ...request, firstMail: true }) } : {}) },
  };
  const run = await runCaseInvestigationRuntime(caseId, investigation);
  if (run.status !== "recorded" && run.status !== "already_recorded") return { status: "fallback", reason: `investigation_${run.status}` };

  // 3. The recorded decision, under the scope in force, as ONE proposal.
  const events = await listCaseEvents(caseId), read = readCaseInvestigationProgress(events, inputKey);
  if (read.state !== "found" || !read.record.decision) return { status: "fallback", reason: "decision_missing" };
  const decision = read.record.decision;
  if (!decision.revisions.prompt.endsWith(SAV_FIRST_MAIL_PROMPT_SUFFIX)) return { status: "fallback", reason: "decision_not_first_mail" };
  if (decision.validation.outcome === "accepted" && decision.validation.decision.nextAction.kind === "handoff") {
    await handToTeam(caseId, "first_mail_handoff");
    return { status: "team", reason: "decision_handoff" };
  }
  const scope = await readCaseDecisionScopes(deps.provenance.accessScope, await deps.provenance.currentPolicyRevision(), decision);
  const draft = caseDecisionDraft(caseId, read.record, events, { accessScope: scope.ok ? caseAccessScopeStamp(scope.scope) : null }, env);
  if (!draft?.reply || draft.triggerEventId !== `ticket:${stored.eventId}`) return { status: "fallback", reason: draft?.replyLimit ?? "decision_not_accepted" };
  const reply = draft.reply;
  // OUR text never carries a kernel phrase: refused, the ticket goes to the team, nothing is proposed.
  if (accessSkillKernelHits(caseReplyEditableBody(reply.text)).length) {
    await handToTeam(caseId, "reply_sensitive_wording");
    return { status: "team", reason: "reply_sensitive_wording" };
  }
  const snapshot = await readCase(caseId);
  if (!snapshot || snapshot.owner !== "agent" || snapshot.threadIds.length) return { status: "fallback", reason: "case_moved" };
  const shape: Omit<CaseReplyProposal, "text"> = {
    caseId, caseVersion: snapshot.version, triggerEventId: draft.triggerEventId, inboundMessageId: null,
    ticketSource: { kind: "hubspot_ticket", version: caseEffectHash(source) }, purpose: reply.purpose,
    ...(reply.purpose === "question" && reply.question ? { question: reply.question } : {}),
    recipient: source.contact!.email, subject: threadlessReplySubject(source.ticketId),
  };

  // 4. Automated only on every proof, read now; otherwise a person validates the same text under the human mention.
  const store: CaseReplyStoreDeps = { env: deps.env, currentPolicyRevision: deps.provenance.currentPolicyRevision, readTicketOwner: deps.readTicketOwner,
    pilotProvenance: pilotProvenanceGate(deps.provenance) };
  const automated = finalizeCaseReplyProposal({ ...shape, text: reply.text }, { language: "unknown", validation: "automated" });
  const reasons = await autoReasons(snapshot, automated, deps);
  const proposal = reasons.length ? finalizeCaseReplyProposal({ ...shape, text: reply.text }, { language: "unknown", validation: "human" }) : automated;
  const submitted = await submitCaseReplyProposal(proposal, store);
  if (!submitted.ok) return { status: "fallback", reason: `proposal_${submitted.code}` };
  if (reasons.length) return { status: "awaiting_person", validationId: submitted.id, reasons };
  const config = readAccessAutoApprovalConfig(env);
  if (config.mode !== "on" || !deps.executionPolicy) return { status: "awaiting_person", validationId: submitted.id, reasons: ["auto_off"] };
  if (submitted.state === "proposed") {
    const decided = await decideCaseReply({ action: "approve", validationId: submitted.id, approverId: config.approverId, deps: store,
      seen: { payloadHash: submitted.storedPayloadHash ?? caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient },
      authorizer: firstMailAuthorizer(caseId, proposal, deps) });
    if (!decided.ok) return { status: "awaiting_person", validationId: submitted.id, reasons: [decided.code, ...(decided.detail ? [decided.detail] : [])] };
  } else if (submitted.state !== "approved") return { status: "awaiting_person", validationId: submitted.id, reasons: [`validation_${submitted.state}`] };
  const queued = await queueValidatedCaseReply({ validationId: submitted.id, policy: deps.executionPolicy, deps: store });
  if (!queued.ok) return { status: "awaiting_person", validationId: submitted.id, reasons: [queued.code] };
  return { status: "queued", validationId: submitted.id, executionId: queued.executionId };
}

/** Why the first mail may not be approved automatically now (empty: every proof holds). Facts read now, never from the caller. */
async function autoReasons(snapshot: CaseSnapshot, proposal: CaseReplyProposal, deps: ThreadlessFirstMailDeps): Promise<string[]> {
  const env = deps.env(), reasons: string[] = [];
  const problem = await threadlessAutoSendProblem(requireDb(), env, { proposal, decidedBy: null, admissionRecord: snapshot.admission });
  if (problem) reasons.push(problem);
  if (!deps.executionPolicy) reasons.push("execution_policy_absent");
  if (!caseAdmissionStatus(snapshot, await deps.provenance.currentPolicyRevision()).admitted) reasons.push("case_not_admitted");
  if (snapshot.sensitivity !== "none") reasons.push("sensitive");
  const open = snapshot.body.openRequests.filter(row => row.status === "open");
  if (!open.length || open.some(row => row.family !== "access")) reasons.push("not_access_only");
  const owner = await judgeCurrentTicketOwner(deps.readTicketOwner, snapshot.ticketId);
  if (!owner.ok) reasons.push(owner.code);
  let proven = false;
  try { proven = (await readPilotReplyProvenance(proposal, deps.provenance, { reminderInputKey: threadlessInputKey(proposal.triggerEventId.slice("ticket:".length)) })).status === "proven"; }
  catch { proven = false; }
  if (!proven) reasons.push("provenance_unproven");
  return reasons;
}

/**
 * The only authorizer that may approve a first mail without a person: the text-and-switch rights (`first-mail-authority.ts`), then A's Access rule
 * (`accessAutoReplyAuthorizer`, `auto_access.v1`) on facts read now: admitted agent case, access only, the recorded decision accepted on THIS ticket
 * input, every shown source proven, the CRM owner V2.
 */
function firstMailAuthorizer(caseId: string, proposal: CaseReplyProposal, deps: ThreadlessFirstMailDeps) {
  return async (request: Parameters<ReturnType<typeof accessAutoReplyAuthorizer>>[0]) => {
    const snapshot = await readCase(caseId);
    if (!snapshot) return { allowed: false as const, reason: "case_missing" };
    const reasons = await autoReasons(snapshot, proposal, deps);
    if (reasons.length) return { allowed: false as const, reason: reasons[0]! };
    return accessAutoReplyAuthorizer({ env: deps.env(), readFacts: async () => {
      const events = await listCaseEvents(caseId), read = readCaseInvestigationProgress(events, threadlessInputKey(proposal.triggerEventId.slice("ticket:".length)));
      const decision = read.state === "found" ? read.record.decision : null;
      if (!decision || decision.validation.outcome !== "accepted") return null;
      const owner = await judgeCurrentTicketOwner(deps.readTicketOwner, snapshot.ticketId);
      return { case: { owner: snapshot.owner, sensitivity: snapshot.sensitivity, admitted: caseAdmissionStatus(snapshot, await deps.provenance.currentPolicyRevision()).admitted },
        openFamilies: snapshot.body.openRequests.filter(row => row.status === "open").map(row => row.family),
        decision: { accepted: true, scopeCurrent: true, shownSourcesVerified: true, nextAction: decision.validation.decision.nextAction.kind },
        ownerNow: owner.ok ? "v2" : "unknown" };
    } })(request);
  };
}
