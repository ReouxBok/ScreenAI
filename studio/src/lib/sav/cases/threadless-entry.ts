import "server-only";
import { z } from "zod";
import { requireDb } from "@/db";
import { ticketOwnerPort } from "./admission-runtime";
import { caseEffectHash } from "./case-effects";
import { finalizeCaseReplyProposal } from "./case-reply-outbound";
import { submitCaseReplyProposal } from "./case-reply-store";
import { hasLocalThreadForTicket, openCaseFromHubspotTicket, readCase, readCaseThreadlessSource } from "./case-store";
import { isSmartSupportProvenance, SAV_SMART_NO_THREAD_WAIT, type CaseSnapshot } from "./case-types";
import { composeThreadlessFirstMail, handThreadlessFirstMailToTeam, type ThreadlessFirstMailResult } from "./first-mail/threadless-first-mail";
import { appTicketSmartFirstMail } from "./app-tickets-config";
import { savV2NewThreadAutoEnabled, savV2NewThreadEnabled, THREADLESS_ACCESS_DRAFT, THREADLESS_ADMIT_PERMISSION, threadlessReplySubject } from "./threadless-config";
import { readThreadlessAuthority, threadlessAccessRevision, threadlessActionAllowed, threadlessAuthorityStillGranted, threadlessSchemaInstalled } from "./threadless-guard";
import { qualifyThreadlessTicket, readThreadlessTicket, type ThreadlessTicketSource } from "./threadless-source";

type Input = { ticketId: string; ownerTransitionKey: string; observedAt: string };
export type ThreadlessEntryResult =
  | { status: "off" | "invalid" | "closed" | "existing_thread" | "existing_case" | "owner_changed" | "out_of_scope" | "unavailable" | "paused" }
  | { status: "human_wait"; caseId: string; reason: string }
  | { status: "started"; caseId: string; validationId: string }
  /** SAV-96 B (`SAV_V2_NEW_THREAD_AUTO=on`): the model's first mail, queued for the automatic send. */
  | { status: "queued"; caseId: string; validationId: string; executionId: string };

/** SAV-96 B: the model's first mail; null deps (not loadable) keeps today's fixed draft. Injectable for tests. */
export type ThreadlessFirstMailPort = (caseId: string) => Promise<ThreadlessFirstMailResult>;
type EntryOptions = Readonly<{ firstMail?: ThreadlessFirstMailPort }>;

const inputSchema = z.object({ ticketId: z.string().regex(/^\d{1,30}$/), ownerTransitionKey: z.string().min(1).max(420), observedAt: z.iso.datetime({ offset: true }) }).strict();

export async function startV2FromThreadlessTicket(input: { ticketId: string; ownerTransitionKey: string; observedAt: string }, options: EntryOptions = {}): Promise<ThreadlessEntryResult> {
  const env = process.env;
  if (!savV2NewThreadEnabled(env)) return { status: "off" };
  if (!inputSchema.safeParse(input).success || Date.parse(input.observedAt) > Date.now()) return { status: "invalid" };
  return start(input, env, options);
}

async function defaultFirstMail(env: NodeJS.ProcessEnv): Promise<ThreadlessFirstMailPort | null> {
  const { loadThreadlessFirstMailDeps } = await import("./first-mail/threadless-first-mail-binding");
  const deps = await loadThreadlessFirstMailDeps(env);
  return deps ? caseId => composeThreadlessFirstMail(caseId, deps) : null;
}

async function start(input: Input, env: NodeJS.ProcessEnv, options: EntryOptions): Promise<ThreadlessEntryResult> {
  const db = requireDb();
  if (!await threadlessActionAllowed(env, db)) return { status: "paused" };
  if (!await threadlessSchemaInstalled(db)) return { status: "unavailable" };
  if (await hasLocalThreadForTicket(input.ticketId)) return { status: "existing_thread" };
  const authority = await readThreadlessAuthority(env, THREADLESS_ADMIT_PERMISSION, input.observedAt);
  if (!authority) return { status: "unavailable" };
  const read = await readThreadlessTicket(input.ticketId, env);
  if (read.status !== "ready" && read.status !== "human_wait") return { status: read.status };
  // SAV-96 B: under SAV-97 `on`, the entry is the one place that may pay for the skill's reading of the ticket; every later check reads it.
  const qualification = await qualifyThreadlessTicket(read.source, env, new Date(), { accessSkillCompute: true });
  // SAV-123 (N8): a ticket the smart entry admits with no mail thread goes to the team (`smart_no_thread`): the first mail of a ticket is not the smart brain's.
  const smartTicket = qualification.status === "admitted" && qualification.admission.qualification.requests.some(request => isSmartSupportProvenance(request.provenance));
  // SAV-138 (Ugo 25/11): an app ticket the app-tickets pass assigned (its key's marker), mode `live`: the smart brain writes its first mail (no `smart_no_thread`).
  const appSmart = smartTicket && appTicketSmartFirstMail(env, input.ownerTransitionKey);
  const revision = qualification.status === "admitted" && !smartTicket ? await threadlessAccessRevision(env, db) : null;

  // SAV-99 (Ugo 19/11): a person gave this ticket to the agent. When the agent does not take it (not an Access request by its content, no rule,
  // Access closed, sensitive, contact not found...), it never stays in the agent's name with nobody on it: the case is born with the team
  // (`handoff_pending`, the reason kept), and the existing hand-over stage gives the ticket back (« Nouveau », no owner, one short note). No mail.
  const waitReason = qualification.status === "human_wait"
    ? qualification.reason === "identity_unconfirmed" && read.status === "human_wait" ? read.reason : qualification.reason
    : qualification.status === "out_of_scope" ? threadlessWaitReason(qualification.reason)
      : smartTicket ? appSmart ? undefined : SAV_SMART_NO_THREAD_WAIT : !revision ? "access_block_closed" : undefined;
  const opened = await openCaseFromHubspotTicket({
    source: read.source, ownerTransitionKey: input.ownerTransitionKey, observedAt: input.observedAt, env,
    assertFresh: tx => threadlessAuthorityStillGranted(tx, authority, THREADLESS_ADMIT_PERMISSION),
    ...(waitReason ? { waitReason } : {}),
    ...(qualification.status === "admitted" ? { admission: qualification.admission, request: qualification.request } : {}),
  });
  if (!("case" in opened)) return { status: opened.status };
  const snapshot = opened.case;
  if (waitReason && opened.status === "created") return { status: "human_wait", caseId: snapshot.caseId, reason: waitReason };
  if (appSmart) return smartAppFirstMail(input, env, snapshot, read.source, options);
  if (snapshot.owner !== "agent" || !revision || !read.source.contact) return { status: "existing_case" };

  // A retry after the case transaction can restore the same draft from the same immutable event.
  const stored = await readCaseThreadlessSource(db, snapshot.caseId);
  if (!stored || stored.ownerTransitionKey !== input.ownerTransitionKey || caseEffectHash(stored.source) !== caseEffectHash(read.source))
    return { status: "existing_case" };
  // SAV-96 B: under `SAV_V2_NEW_THREAD_AUTO=on`, the V2 decision model writes the first mail (first-mail skill). Whatever it cannot prove falls back to
  // the fixed draft below, for a person; `off` never reaches this (today's path, byte for byte).
  if (savV2NewThreadAutoEnabled(env)) {
    const firstMail = options.firstMail ?? await defaultFirstMail(env);
    const result = firstMail ? await firstMail(snapshot.caseId).catch((): ThreadlessFirstMailResult => ({ status: "fallback", reason: "first_mail_threw" }))
      : { status: "fallback" as const, reason: "first_mail_unavailable" };
    console.info("sav_v2_first_mail", { caseId: snapshot.caseId, status: result.status, ...("reason" in result ? { reason: result.reason } : {}),
      ...("reasons" in result ? { reasons: result.reasons.join(",").slice(0, 200) } : {}) });
    if (result.status === "team") return { status: "human_wait", caseId: snapshot.caseId, reason: result.reason };
    if (result.status === "queued") return { status: "queued", caseId: snapshot.caseId, validationId: result.validationId, executionId: result.executionId };
    if (result.status === "awaiting_person") return { status: "started", caseId: snapshot.caseId, validationId: result.validationId };
    const fresh = await readCase(snapshot.caseId);
    if (!fresh || fresh.owner !== "agent" || fresh.threadIds.length) return { status: "existing_case" };
    return fixedDraft(input, env, fresh, stored, read.source, revision);
  }
  return fixedDraft(input, env, snapshot, stored, read.source, revision);
}

/**
 * SAV-138 (Ugo 25/11): the first mail of an app ticket, written by the smart brain (`composeThreadlessFirstMail`, smart branch), sent on a new Gmail thread to
 * the HubSpot contact by SAV-96's effect. Never the Access fixed draft: anything the model path cannot prove gives the ticket to the team, nothing sent.
 */
async function smartAppFirstMail(input: Input, env: NodeJS.ProcessEnv, snapshot: CaseSnapshot, source: ThreadlessTicketSource, options: EntryOptions): Promise<ThreadlessEntryResult> {
  if (snapshot.owner !== "agent" || snapshot.threadIds.length || !source.contact) return { status: "existing_case" };
  const stored = await readCaseThreadlessSource(requireDb(), snapshot.caseId);
  if (!stored || stored.ownerTransitionKey !== input.ownerTransitionKey || caseEffectHash(stored.source) !== caseEffectHash(source)) return { status: "existing_case" };
  const firstMail = options.firstMail ?? await defaultFirstMail(env);
  const result = firstMail ? await firstMail(snapshot.caseId).catch((): ThreadlessFirstMailResult => ({ status: "fallback", reason: "first_mail_threw" }))
    : { status: "fallback" as const, reason: "first_mail_unavailable" };
  console.info("sav_v2_first_mail", { caseId: snapshot.caseId, smart: true, status: result.status, ...("reason" in result ? { reason: result.reason } : {}),
    ...("reasons" in result ? { reasons: result.reasons.join(",").slice(0, 200) } : {}) });
  if (result.status === "queued") return { status: "queued", caseId: snapshot.caseId, validationId: result.validationId, executionId: result.executionId };
  // No draft mode for app tickets (Ugo 25/11): a text that may not leave automatically is never left waiting in the agent's name; the ticket goes to the team.
  const reason = result.status === "awaiting_person" ? `auto_${result.reasons[0] ?? "refused"}` : result.reason;
  if (result.status !== "team") await handThreadlessFirstMailToTeam(snapshot.caseId, threadlessWaitReason(`smart_first_mail_${reason}`.toLowerCase().replace(/[^a-z_]+/g, "_").slice(0, 80)));
  return { status: "human_wait", caseId: snapshot.caseId, reason };
}

/**
 * SAV-99 (Ugo 19/11): a ticket a person gave the agent, WITH mail, that the agent does not take (outside its blocks, sensitive, sender not the ticket's
 * contact, several threads or tickets for one thread, thread unreadable...). It must not stay in the agent's name with nobody on it: the same team case as a
 * ticket without mail (`handoff_pending`, the reason kept, no thread), hence the same hand-over stage (« Nouveau », no owner, one short note) and Slack notice.
 * Nothing is sent to the customer. Under the same switches, pause and authority as the entry; once per ticket (an existing case is left as it is).
 */
export async function handBackOwnerHandoverTicket(input: Input, reason: string): Promise<ThreadlessEntryResult> {
  const env = process.env;
  if (!savV2NewThreadEnabled(env)) return { status: "off" };
  if (!inputSchema.safeParse(input).success || Date.parse(input.observedAt) > Date.now()) return { status: "invalid" };
  const db = requireDb();
  if (!await threadlessActionAllowed(env, db)) return { status: "paused" };
  if (!await threadlessSchemaInstalled(db)) return { status: "unavailable" };
  const authority = await readThreadlessAuthority(env, THREADLESS_ADMIT_PERMISSION, input.observedAt);
  if (!authority) return { status: "unavailable" };
  const read = await readThreadlessTicket(input.ticketId, env, { handback: true });
  if (read.status !== "ready" && read.status !== "human_wait") return { status: read.status };
  const waitReason = threadlessWaitReason(reason);
  const opened = await openCaseFromHubspotTicket({
    source: read.source, ownerTransitionKey: input.ownerTransitionKey, observedAt: input.observedAt, env, waitReason, handback: true,
    assertFresh: tx => threadlessAuthorityStillGranted(tx, authority, THREADLESS_ADMIT_PERMISSION),
  });
  if (!("case" in opened)) return { status: opened.status };
  return opened.status === "created" ? { status: "human_wait", caseId: opened.case.caseId, reason: waitReason } : { status: "existing_case" };
}

/** The case's stored wait reason (`threadlessTicketEventSchema`): a reason code as it is, anything else the generic « out of scope ». */
export const threadlessWaitReason = (reason: string) => /^[a-z_]{1,80}$/.test(reason) ? reason : "out_of_scope";

type StoredSource = NonNullable<Awaited<ReturnType<typeof readCaseThreadlessSource>>>;
async function fixedDraft(input: Input, env: NodeJS.ProcessEnv, snapshot: CaseSnapshot, stored: StoredSource, source: ThreadlessTicketSource, revision: string): Promise<ThreadlessEntryResult> {
  if (!source.contact) return { status: "existing_case" };
  const proposal = finalizeCaseReplyProposal({
    caseId: snapshot.caseId, caseVersion: snapshot.version, triggerEventId: `ticket:${stored.eventId}`,
    inboundMessageId: null, ticketSource: { kind: "hubspot_ticket", version: caseEffectHash(stored.source) },
    purpose: "answer", recipient: source.contact.email, subject: threadlessReplySubject(input.ticketId), text: THREADLESS_ACCESS_DRAFT,
  }, { language: "fr", validation: "human" });
  const submitted = await submitCaseReplyProposal(proposal, {
    env: () => env,
    currentPolicyRevision: async () => revision,
    readTicketOwner: ticketOwnerPort({ env, readHubspotTicketOwner: async ticketId => {
      const fresh = await readThreadlessTicket(ticketId, env);
      return fresh.status === "ready" && caseEffectHash(fresh.source) === caseEffectHash(stored.source) ? fresh.source.ownerId : undefined;
    } }),
  });
  return submitted.ok ? { status: "started", caseId: snapshot.caseId, validationId: submitted.id } : { status: "unavailable" };
}
