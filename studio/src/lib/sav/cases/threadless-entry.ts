import "server-only";
import { z } from "zod";
import { requireDb } from "@/db";
import { ticketOwnerPort } from "./admission-runtime";
import { caseEffectHash } from "./case-effects";
import { finalizeCaseReplyProposal } from "./case-reply-outbound";
import { submitCaseReplyProposal } from "./case-reply-store";
import { hasLocalThreadForTicket, openCaseFromHubspotTicket, readCase, readCaseThreadlessSource } from "./case-store";
import type { CaseSnapshot } from "./case-types";
import { composeThreadlessFirstMail, type ThreadlessFirstMailResult } from "./first-mail/threadless-first-mail";
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
  if (qualification.status === "out_of_scope") return { status: "out_of_scope" };
  const revision = qualification.status === "admitted" ? await threadlessAccessRevision(env, db) : null;
  if (qualification.status === "admitted" && !revision) return { status: "out_of_scope" };

  const waitReason = qualification.status === "human_wait"
    ? qualification.reason === "identity_unconfirmed" && read.status === "human_wait" ? read.reason : qualification.reason
    : undefined;
  const opened = await openCaseFromHubspotTicket({
    source: read.source, ownerTransitionKey: input.ownerTransitionKey, observedAt: input.observedAt, env,
    assertFresh: tx => threadlessAuthorityStillGranted(tx, authority, THREADLESS_ADMIT_PERMISSION),
    ...(waitReason ? { waitReason } : {}),
    ...(qualification.status === "admitted" ? { admission: qualification.admission, request: qualification.request } : {}),
  });
  if (!("case" in opened)) return { status: opened.status };
  const snapshot = opened.case;
  if (waitReason && opened.status === "created") return { status: "human_wait", caseId: snapshot.caseId, reason: waitReason };
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
