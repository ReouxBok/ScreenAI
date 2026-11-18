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
import { caseAwaitsV2Attribution, type CaseSnapshot } from "./case-types";
import { readCaseTicketStageConfig } from "./customer-return";
import { recordCaseAfterConfirmedIntake, relayPaused, v2HubspotOwnerId } from "./intake-boundary";
import { SAV_V2_OWNER_HANDOVER_PERMISSION, savV2OwnerHandoverEnabled } from "./owner-handover-config";
import {
  claimOwnerHandover, finishOwnerHandover, isHumanOwnerChange, listDueOwnerHandovers, ownerHandoverClaimIsCurrent,
  ownerHandoverFromMarker, type OwnerHandoverTransition,
} from "./owner-handover-markers";
import { readSavV2QualificationScope } from "./qualification-scope";
import { startV2FromThreadlessTicket } from "./threadless-entry";
import { continueCaseAfterCommit, v2EntryRelayDeps } from "./v2-entry";

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
  const { hubspot_owner_id, hs_pipeline, hs_pipeline_stage, hs_ticket_category } = ticket.properties;
  if (hubspot_owner_id !== ownerId) return { skipped: "owner_changed" } as const;
  const config = readCaseTicketStageConfig(env), stages = SAV_HUBSPOT_SUPPORT.stages;
  if (hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId) return { skipped: "outside_support" } as const;
  if (hs_pipeline_stage === stages.closed || (config.mode === "on" && hs_pipeline_stage === config.closed)) return { skipped: "ticket_closed" } as const;
  const openStages: string[] = [stages.new, stages.awaitingContact, stages.awaitingTeam];
  if (config.mode === "on") openStages.push(config.waitingCustomer);
  if (!openStages.includes(hs_pipeline_stage)) return { skipped: "stage_unverified" } as const;
  if (hs_ticket_category !== SAV_HUBSPOT_SUPPORT.categories.access) return { skipped: "outside_access" } as const;

  // A later change away and back may already exist in HubSpot while its webhook is still in flight.
  // The history must confirm the same transition, not just the same current value.
  const latest = ticket.latestOwner;
  if (!latest || Date.parse(latest.timestamp) < Date.parse(input.observedAt)) throw Error("SAV_OWNER_HANDOVER_HISTORY_UNREADABLE");
  if (latest.value !== ownerId || !isHumanOwnerChange(latest.sourceType)
    || Date.parse(latest.timestamp) !== Date.parse(input.observedAt)) return { skipped: "owner_transition_changed" } as const;
  return { ticket };
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

  const linked = await linkedThreads(input.ticketId, current, db);
  if (!linked || linked.length > 1) return "thread_unresolved";
  if (!linked.length) {
    if (scope.mode === "qualification") return "outside_scope";
    if (!await ownerHandoverClaimIsCurrent(claim) || await relayPaused(db)) return "superseded_or_paused";
    return (await startV2FromThreadlessTicket(input)).status;
  }

  const { thread, mailbox } = linked[0]!;
  if (thread.hubspotTicketId && thread.hubspotTicketId !== input.ticketId) return "thread_unresolved";
  if (!mailbox.active || mailbox.email !== MAILBOX || mailbox.id !== policy.mailboxId || !thread.gmailThreadId) return "thread_unresolved";
  if (thread.aiPaused) return "paused";
  const source = await lastStoredInbound(thread.id, db);
  const gmail = await readThreadEnd(thread.gmailThreadId);
  if (!source || !gmail) return "thread_unresolved";
  if (source.gmailId !== gmail.lastInboundId) throw Error("SAV_OWNER_HANDOVER_INBOUND_NOT_SYNCED");
  const awaitCustomer = gmail.teamLast || !await crmAllowsLinkedOwnerHandoverReply(input.ticketId, gmail.lastInboundAt);
  const relay = await recordCaseAfterConfirmedIntake(source.id, {
    ...v2EntryRelayDeps(env),
    readCreatedTicketOwner: async ticketId => {
      if (ticketId !== input.ticketId) return undefined;
      const fresh = await openHandoverTicket(input, ownerId, env);
      return "ticket" in fresh ? ownerId : null;
    },
    ownerHandover: {
      ticketId: input.ticketId, awaitCustomer,
      async assertFresh(tx) {
        const latest = await readCaseByTicket(input.ticketId, tx);
        const threads = await linkedThreads(input.ticketId, latest, tx);
        if (!await ownerHandoverClaimIsCurrent(claim, tx) || (latest && !caseAwaitsV2Attribution(latest))
          || threads?.length !== 1 || threads[0]!.thread.id !== thread.id || threads[0]!.thread.aiPaused
          || (await lastStoredInbound(thread.id, tx))?.id !== source.id) throw Error("SAV_OWNER_HANDOVER_CHANGED");
      },
    },
  });
  if ("skipped" in relay) {
    if (relay.skipped === "intake_not_confirmed") throw Error("SAV_OWNER_HANDOVER_INTAKE_NOT_CONFIRMED");
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
  await finishOwnerHandover(claim, false, now());
  console.info("sav_v2_owner_handover", { status });
  return { status };
}

export async function sweepDueOwnerHandovers(deadlineMs: number) {
  const counts: Record<string, number> = {};
  if (!savV2OwnerHandoverEnabled()) return counts;
  for (const row of await listDueOwnerHandovers(new Date())) {
    if (Date.now() + 100_000 > deadlineMs) break;
    const { status } = await runSavOwnerHandover(ownerHandoverFromMarker(row), { deadlineMs, catchUp: true });
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
