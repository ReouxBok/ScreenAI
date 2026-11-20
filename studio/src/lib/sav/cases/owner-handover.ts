import "server-only";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savIntakeExecutions, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { requestSavGmail } from "../gmail";
import { crmAllowsLinkedOwnerHandoverReply, readSavOwnerHandoverTicket } from "../hubspot";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import { normalizeEmailAddress } from "../policy";
import { readCaseByTicket, type CaseTx } from "./case-store";
import { caseAwaitsV2Attribution, type CaseAdmissionQualification, type CaseSnapshot } from "./case-types";
import { readCaseTicketStageConfig } from "./customer-return";
import { ownerHandoverMailRequest, recordCaseAfterConfirmedIntake, relayOwnerHandoverMail, relayPaused, v2HubspotOwnerId } from "./intake-boundary";
import { SAV_V2_OWNER_HANDOVER_PERMISSION, savV2OwnerHandoverEnabled } from "./owner-handover-config";
import {
  claimOwnerHandover, finishOwnerHandover, isHumanOwnerChange, listDueOwnerHandovers, ownerHandoverClaimIsCurrent,
  ownerHandoverFromMarker, reopenPreOutcomeOwnerHandovers, type OwnerHandoverTransition,
} from "./owner-handover-markers";
import { ownerHandoverPollFloor } from "./owner-handover-poll";
import { readSavV2QualificationScope } from "./qualification-scope";
import { handBackOwnerHandoverTicket, startV2FromThreadlessTicket } from "./threadless-entry";
import { readOwnerHandoverContact, threadlessIdentityReason } from "./threadless-source";
import { savV2EntrySmartOn, smartEntryEffectsHold } from "./smart-entry-switch";
import { continueCaseAfterCommit, firstBlockEvidence, v2EntryRelayDeps } from "./v2-entry";
import { SAV_CASE_BLOCK_REGISTRY } from "./case-block-registry";
import { savCaseSensitiveWording } from "./investigation-return-qualify";
import { readAccessSkillMode } from "./access-skill/access-skill-rule";
import { decryptSavPayload } from "../crypto";

const MAILBOX = "contact@limova.ai";
type Env = Record<string, string | undefined>;
type Claim = NonNullable<Awaited<ReturnType<typeof claimOwnerHandover>>>;
type Options = { env?: Env; now?: () => Date; deadlineMs: number; catchUp?: boolean };

const gmailThreadSchema = z.object({ id: z.string(), messages: z.array(z.object({
  id: z.string().min(1), threadId: z.string(), labelIds: z.array(z.string()).optional(), internalDate: z.string().optional(),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })) }).optional(),
})) });

async function readThreadEnd(threadId: string) {
  const thread = gmailThreadSchema.parse(await requestSavGmail<unknown>(MAILBOX,
    `threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From`));
  if (thread.id !== threadId) throw Error("SAV_OWNER_HANDOVER_GMAIL_THREAD_MISMATCH");
  const messages = thread.messages.filter(message => !message.labelIds?.includes("DRAFT")).map(message => {
    const senders = message.payload?.headers.filter(header => header.name.toLowerCase() === "from") ?? [];
    const sender = senders.length === 1 ? normalizeEmailAddress(senders[0]!.value) : "";
    if (message.threadId !== threadId || !/^\d{1,16}$/.test(message.internalDate ?? "") || !sender.includes("@")) {
      throw Error("SAV_OWNER_HANDOVER_GMAIL_MESSAGE_UNREADABLE");
    }
    return { id: message.id, at: Number(message.internalDate), team: !!message.labelIds?.includes("SENT") || sender.endsWith("@limova.ai") };
  }).sort((left, right) => right.at - left.at);
  const last = messages[0], inbound = messages.filter(message => !message.team);
  if (!last || messages[1]?.at === last.at || !inbound[0] || inbound[0].at === inbound[1]?.at) return null;
  return { lastInboundId: inbound[0].id, lastInboundAt: inbound[0].at, teamLast: last.team };
}

async function linkedThreads(ticketId: string, current: CaseSnapshot | null, db: Pick<CaseTx, "select" | "selectDistinct">) {
  const executions = await db.selectDistinct({ threadId: savIntakeExecutions.threadId }).from(savIntakeExecutions)
    .where(eq(savIntakeExecutions.ticketId, ticketId)).limit(2);
  const known = [...new Set([...(current?.threadIds ?? []), ...executions.map(row => row.threadId)])];
  if (known.length > 1) return null;
  const threads = await db.select({ thread: savThreads, mailbox: savMailboxes }).from(savThreads)
    .innerJoin(savMailboxes, eq(savMailboxes.id, savThreads.mailboxId))
    .where(or(eq(savThreads.hubspotTicketId, ticketId), known.length ? inArray(savThreads.id, known) : undefined))
    .limit(2);
  // A dangling stored case/execution link is an unreadable existing thread.
  if (known.length && !threads.some(row => row.thread.id === known[0])) return null;
  return threads;
}

async function lastStoredInbound(threadId: string, db: Pick<CaseTx, "select">) {
  const [message] = await db.select({ id: savMessages.id, gmailId: savMessages.gmailMessageId })
    .from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  return message;
}

async function openHandoverTicket(input: OwnerHandoverTransition, ownerId: string, env: Env): Promise<
  { skipped: string } | { ticket: Awaited<ReturnType<typeof readSavOwnerHandoverTicket>> }
> {
  const ticket = await readSavOwnerHandoverTicket(input.ticketId);
  if (ticket.archived) return { skipped: "ticket_closed" } as const;
  // SAV-99 (Ugo 19/11): the HubSpot category is often wrong, so it never decides the entry. The ticket's content does (V2 entry / Access skill,
  // sensitive topics to the team); a ticket the agent does not take goes back to the team (`threadless-entry.ts`).
  const { hubspot_owner_id, hs_pipeline, hs_pipeline_stage } = ticket.properties;
  if (hubspot_owner_id !== ownerId) return { skipped: "owner_changed" } as const;
  const config = readCaseTicketStageConfig(env), stages = SAV_HUBSPOT_SUPPORT.stages;
  if (hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId) return { skipped: "outside_support" } as const;
  if (hs_pipeline_stage === stages.closed || (config.mode === "on" && hs_pipeline_stage === config.closed)) return { skipped: "ticket_closed" } as const;
  const openStages: string[] = [stages.new, stages.awaitingContact, stages.awaitingTeam];
  if (config.mode === "on") openStages.push(config.waitingCustomer);
  if (!openStages.includes(hs_pipeline_stage)) return { skipped: "stage_unverified" } as const;

  // A later change away and back may already exist in HubSpot while its webhook is still in flight.
  // The history must confirm the same transition, not just the same current value.
  const latest = ticket.latestOwner;
  if (!latest || Date.parse(latest.timestamp) < Date.parse(input.observedAt)) throw Error("SAV_OWNER_HANDOVER_HISTORY_UNREADABLE");
  if (latest.value !== ownerId || !isHumanOwnerChange(latest.sourceType)
    || Date.parse(latest.timestamp) !== Date.parse(input.observedAt)) return { skipped: "owner_transition_changed" } as const;
  return { ticket };
}

/**
 * SAV-99 (Ugo 19/11): the agent's own reading of a handed-over mail V1 never executed. Sensitive wording, a sender who is not the ticket's one contact, or a mail
 * no active block takes: the ticket goes back to the team. Otherwise the block evidence of the V2 entry (Access skill or detectors, block scope, approved rules)
 * on the stored mail, and the identity of the ticket's contact. A HubSpot read that fails throws (asked again later).
 */
async function manualQualification(messageId: string, ticketId: string, env: Env): Promise<{ handBack: string } | { qualification: CaseAdmissionQualification }> {
  const [message] = await requireDb().select({ gmailId: savMessages.gmailMessageId, from: savMessages.fromEmail, subject: savMessages.subject, body: savMessages.bodyCiphertext })
    .from(savMessages).where(and(eq(savMessages.id, messageId), eq(savMessages.direction, "inbound")));
  if (!message?.gmailId) return { handBack: "thread_unreadable" };
  const text = decryptSavPayload<{ text?: unknown }>(message.body)?.text;
  if (typeof text !== "string" || !text.trim()) return { handBack: "thread_unreadable" };
  // As at every entry: under SAV-97 `on` the Access skill reads sensitivity itself (a sensitive reading admits nobody); before it, the lexical veto.
  // SAV-118 (N5): under `SAV_V2_ENTRY_SMART=on` no word list is read at the door; the smart brain judges sensitivity (contract V1→V2, `smart-entry-switch.ts`).
  const smart = savV2EntrySmartOn(env);
  if (!smart && readAccessSkillMode(env) !== "on" && savCaseSensitiveWording(text, message.subject)) return { handBack: "sensitive_request" };
  const read = await readOwnerHandoverContact(ticketId, env);
  if (!read.contact) return { handBack: threadlessIdentityReason(read.reason, env) };
  if (read.contact.email !== normalizeEmailAddress(message.from)) return { handBack: "identity_mismatch" };
  const request = ownerHandoverMailRequest(message.gmailId);
  const requests = await firstBlockEvidence(env, messageId, message.gmailId, [request], SAV_CASE_BLOCK_REGISTRY,
    { run: { runId: null, runVersion: null }, accessSkillCompute: "always" });
  // SAV-117 review 1D: under `SAV_V2_ENTRY_SMART=on` a reading no block takes (support + cancellation, for one) is not handed back before N8: the relay's handover
  // gate leaves it waiting (`owner_handover_smart_pending`). Off: exactly as before.
  if (!smart && requests.every(row => row.provenance.kind === "team_part")) return { handBack: "no_block_match" };
  return { qualification: { requests, identity: { status: "confirmed", source: { type: "hubspot_object", id: read.contact.id } }, crmContext: "complete", teamSignals: [] } };
}

async function processOwnerHandover(input: OwnerHandoverTransition, claim: Claim, env: Env, options: Options): Promise<string> {
  const db = requireDb(), ownerId = v2HubspotOwnerId(env);
  if (!ownerId) return "owner_unconfigured";
  if (await relayPaused(db)) return "paused";
  const live = await openHandoverTicket(input, ownerId, env);
  if ("skipped" in live) return live.skipped;
  const current = await readCaseByTicket(input.ticketId);
  if (current && !caseAwaitsV2Attribution(current)) return "case_preserved";
  const scope = readSavV2QualificationScope(env);
  if (scope.mode === "closed") return "outside_scope";
  const config = intakeExecutionConfig(env);
  if (!config) return "authority_missing";
  const { policy } = await readIntakeExecutionAuthority(config);
  if (!policy.mutations.includes(SAV_V2_OWNER_HANDOVER_PERMISSION)) return "permission_missing";

  // SAV-99 (Ugo 19/11): a ticket the agent does not take goes back to the team, once, with no mail (`handBackOwnerHandoverTicket`).
  const handBack = async (reason: string) => {
    // SAV-117 review 1F: the central hold before N8 (`smartEntryEffectsHold`, to remove in N8): no hand-back, no HubSpot write; the reason is only logged.
    const hold = smartEntryEffectsHold(env);
    if (hold) { console.info("sav_v2_owner_handover_held", { hold, reason }); return hold; }
    if (!await ownerHandoverClaimIsCurrent(claim) || await relayPaused(db)) return "superseded_or_paused";
    const back = await handBackOwnerHandoverTicket(input, reason);
    return back.status === "human_wait" ? `handed_back:${back.reason}` : `handback_${back.status}`;
  };
  const linked = await linkedThreads(input.ticketId, current, db);
  // Several threads for one ticket, or (below) a thread tied to another ticket: the team sorts it out.
  if (!linked || linked.length > 1) return handBack("thread_ambiguous");
  if (!linked.length) {
    if (scope.mode === "qualification") return "outside_scope";
    if (!await ownerHandoverClaimIsCurrent(claim) || await relayPaused(db)) return "superseded_or_paused";
    const started = (await startV2FromThreadlessTicket(input)).status;
    // A mail on the ticket in HubSpot but no thread in contact@: nothing the agent can answer on, and no new thread over an existing exchange.
    return started === "existing_thread" ? handBack("thread_unreadable") : started;
  }

  const { thread, mailbox } = linked[0]!;
  if (thread.hubspotTicketId && thread.hubspotTicketId !== input.ticketId) return handBack("thread_ambiguous");
  if (!mailbox.active || mailbox.email !== MAILBOX || mailbox.id !== policy.mailboxId || !thread.gmailThreadId) return handBack("thread_unreadable");
  if (thread.aiPaused) return "paused";
  const source = await lastStoredInbound(thread.id, db);
  const gmail = await readThreadEnd(thread.gmailThreadId);
  if (!source || !gmail) return handBack("thread_unreadable");
  if (source.gmailId !== gmail.lastInboundId) throw Error("SAV_OWNER_HANDOVER_INBOUND_NOT_SYNCED");
  const awaitCustomer = gmail.teamLast || !await crmAllowsLinkedOwnerHandoverReply(input.ticketId, gmail.lastInboundAt);
  const deps = {
    ...v2EntryRelayDeps(env),
    readCreatedTicketOwner: async (ticketId: string) => {
      if (ticketId !== input.ticketId) return undefined;
      const fresh = await openHandoverTicket(input, ownerId, env);
      return "ticket" in fresh ? ownerId : null;
    },
    ownerHandover: {
      ticketId: input.ticketId, awaitCustomer,
      async assertFresh(tx: CaseTx) {
        const latest = await readCaseByTicket(input.ticketId, tx);
        const threads = await linkedThreads(input.ticketId, latest, tx);
        if (!await ownerHandoverClaimIsCurrent(claim, tx) || (latest && !caseAwaitsV2Attribution(latest))
          || threads?.length !== 1 || threads[0]!.thread.id !== thread.id || threads[0]!.thread.aiPaused
          || (await lastStoredInbound(thread.id, tx))?.id !== source.id) throw Error("SAV_OWNER_HANDOVER_CHANGED");
      },
    },
  };
  let relay = await recordCaseAfterConfirmedIntake(source.id, deps);
  // SAV-99 (Ugo 19/11): no V1 proof is required for a manual assignment. V1 never executed this mail: the agent reads it itself (`manualQualification`).
  if ("skipped" in relay && relay.skipped === "owner_handover_no_v1_execution") {
    const read = await manualQualification(source.id, input.ticketId, env);
    if ("handBack" in read) return handBack(read.handBack);
    relay = await relayOwnerHandoverMail(source.id, read.qualification, deps);
  }
  if ("skipped" in relay) {
    if (relay.skipped === "intake_not_confirmed") throw Error("SAV_OWNER_HANDOVER_INTAKE_NOT_CONFIRMED");
    if (relay.skipped === "owner_handover_ticket_mismatch") return handBack("thread_ambiguous");
    if (relay.skipped === "owner_handover_out_of_scope") return handBack("out_of_scope");
    return relay.skipped;
  }
  if (relay.owner !== "agent") return "case_preserved";
  if (awaitCustomer) return "awaiting_customer";
  if (await ownerHandoverClaimIsCurrent(claim) && !await relayPaused(db)) {
    // The reconcile pass has a shared budget. Let its ordinary case sweep continue the queued case.
    if (!options.catchUp) await continueCaseAfterCommit(relay.caseId, "relay", { env, immediateDeadlineMs: options.deadlineMs });
  }
  return "relayed";
}

export async function runSavOwnerHandover(input: OwnerHandoverTransition, options: Options) {
  const env = options.env ?? process.env, now = options.now ?? (() => new Date());
  if (!savV2OwnerHandoverEnabled(env)) return { status: "off" };
  const claim = await claimOwnerHandover(input, now());
  if (!claim) return { status: "not_due_or_claimed" };
  let status: string;
  try {
    status = await processOwnerHandover(input, claim, env, options);
  } catch {
    await finishOwnerHandover(claim, true, now());
    console.warn("sav_v2_owner_handover", { status: "read_or_relay_failed" });
    return { status: "read_or_relay_failed" };
  }
  await finishOwnerHandover(claim, false, now(), status);
  console.info("sav_v2_owner_handover", { status });
  return { status };
}

export async function sweepDueOwnerHandovers(deadlineMs: number, env: Env = process.env) {
  const counts: Record<string, number> = {};
  if (!savV2OwnerHandoverEnabled(env)) return counts;
  // SAV-99: the handovers dropped before this fix (category) are evaluated once more, bounded by the poll's floor (`reopenPreOutcomeOwnerHandovers`).
  const now = new Date();
  const reopened = await reopenPreOutcomeOwnerHandovers(now, await ownerHandoverPollFloor(env, now));
  if (reopened) counts.reopened = reopened;
  for (const row of await listDueOwnerHandovers(now)) {
    if (Date.now() + 100_000 > deadlineMs) break;
    const { status } = await runSavOwnerHandover(ownerHandoverFromMarker(row), { env, deadlineMs, catchUp: true });
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
