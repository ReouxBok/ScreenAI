import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { requestSavHubspot, SavCrmReadError } from "../hubspot-transport";
import { v2HubspotOwnerId } from "./intake-boundary";
import { savV2OwnerHandoverPollEnabled } from "./owner-handover-config";
import { observeSavOwnerHandoverEvents, type OwnerEvent } from "./owner-handover-markers";

/*
 * SAV-96 repair (19/11). Production never received a HubSpot webhook, so `observeSavOwnerHandoverEvents` was never called and a ticket a person
 * assigns to the Agent SAV in HubSpot was never taken. Each reconcile pass (the existing cron and its self-scheduler fallback, no new cron or route)
 * now runs ONE bounded HubSpot search: support pipeline, owner = SAV_V2_HUBSPOT_OWNER_ID, modified since a durable cursor. For each ticket found, the
 * owner history (the same read as the handover's own check) gives the last owner change, which goes to the SAME markers as a webhook event: same
 * high-water mark per ticket (a ticket seen twice is one handover), same human-source rule, same delay, same claim, same guards in
 * `runSavOwnerHandover` (owner changed, ticket closed, mail already linked, case preserved, pause, permission).
 *
 * The ticket's creation date never matters. Only an owner change made after the poll's floor (its first run minus the lookback, default 24 h)
 * can start a handover, so turning the poll on never replays months of old assignments.
 *
 * Cost: 1 search per pass (2 at most when a page is full), plus 1 history read per ticket modified since the poll last read it (25 at most per pass).
 * No model, no write to HubSpot. Off: not one call.
 */

type Env = Record<string, string | undefined>;
export const OWNER_HANDOVER_POLL_KEY = "sav-v2-owner-handover-poll.v1";
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
const MAX_READS = 25;
/** A finished pass looks this far back again: HubSpot's search index may show a just-modified ticket a little late. */
export const OWNER_HANDOVER_POLL_OVERLAP_MS = 120_000;
const LEASE_MS = 240_000;
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_LOOKBACK_HOURS = 168;
const CRM_ID = /^\d{1,30}$/;

const stateSchema = z.object({ v: z.literal(1), after: z.number().int().nonnegative(), floor: z.number().int().nonnegative(), complete: z.boolean() }).strict();
type PollState = z.infer<typeof stateSchema>;

const searchPageSchema = z.object({
  results: z.array(z.object({
    id: z.string().regex(CRM_ID), updatedAt: z.string().optional(),
    properties: z.object({ hubspot_owner_id: z.string().nullish(), hs_pipeline: z.string().nullish(), hs_lastmodifieddate: z.string().nullish() }),
  })),
  paging: z.object({ next: z.object({ after: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String) }).optional() }).optional(),
});
export type OwnerTicketSearchPage = z.input<typeof searchPageSchema>;
export type OwnerTicketHistory = {
  id: string; archived: boolean;
  latestOwner: { value?: string | null; timestamp: string; sourceType: string } | null | undefined;
};
export type OwnerHandoverPollDeps = {
  env?: Env;
  now?: () => Date;
  deadlineMs?: number;
  search?: (body: unknown) => Promise<unknown>;
  readTicket?: (ticketId: string) => Promise<OwnerTicketHistory>;
  observe?: (events: readonly OwnerEvent[], options: { env: Env; now: Date }) => Promise<void>;
};
export type OwnerHandoverPollResult =
  | { skipped: "off" | "owner_unconfigured" | "token_missing" | "leased" | "deadline" }
  | { status: "ok" | "partial" | "search_failed" | "observe_failed"; found: number; read: number; seen: number; observed: number; beforeFloor: number; unreadable: number; failed: number; skipped: number; pages: number };

export function ownerHandoverPollLookbackMs(env: Env) {
  const raw = Number(env.SAV_V2_OWNER_HANDOVER_POLL_LOOKBACK_HOURS);
  const hours = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, MAX_LOOKBACK_HOURS) : DEFAULT_LOOKBACK_HOURS;
  return hours * 3_600_000;
}

function parseState(cursor: string | null | undefined): PollState | null {
  if (!cursor) return null;
  try { return stateSchema.parse(JSON.parse(cursor)); } catch { return null; }
}

/** One poll at a time across the cron and its fallback: a lease on the cursor row. */
async function claimPoll(env: Env, now: Date) {
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${OWNER_HANDOVER_POLL_KEY}))`);
    const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, OWNER_HANDOVER_POLL_KEY)).for("update");
    if (row?.status === "running" && row.updatedAt.getTime() > now.getTime() - LEASE_MS) return null;
    const floor = now.getTime() - ownerHandoverPollLookbackMs(env);
    // An unreadable cursor restarts from a fresh floor: never earlier than the lookback, never a replay of old assignments.
    const state = parseState(row?.cursor) ?? { v: 1 as const, after: floor, floor, complete: false };
    const values = { status: "running", cursor: JSON.stringify(state), updatedAt: now, startedAt: row?.startedAt ?? now };
    await tx.insert(savSyncState).values({ key: OWNER_HANDOVER_POLL_KEY, ...values }).onConflictDoUpdate({ target: savSyncState.key, set: values });
    return { state, leaseAt: now };
  });
}

async function finishPoll(leaseAt: Date, state: PollState, error: string | null, observed: number, now: Date) {
  await requireDb().update(savSyncState).set({
    status: error ? "failed" : "idle", cursor: JSON.stringify(state), lastError: error, updatedAt: now, completedAt: now,
    processedCount: sql`${savSyncState.processedCount} + ${observed}`,
  }).where(and(eq(savSyncState.key, OWNER_HANDOVER_POLL_KEY), eq(savSyncState.status, "running"), eq(savSyncState.updatedAt, leaseAt)));
}

function searchBody(owner: string, from: number, after?: string) {
  return {
    filterGroups: [{ filters: [
      { propertyName: "hs_pipeline", operator: "EQ", value: SAV_HUBSPOT_SUPPORT.pipelineId },
      { propertyName: "hubspot_owner_id", operator: "EQ", value: owner },
      { propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(from) },
    ] }],
    sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
    properties: ["hubspot_owner_id", "hs_pipeline", "hs_lastmodifieddate"],
    limit: PAGE_SIZE,
    ...(after ? { after } : {}),
  };
}

function defaultSearch(env: Env) {
  return (body: unknown) => requestSavHubspot<unknown>("/crm/v3/objects/tickets/search", {
    method: "POST", cache: "no-store", body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, Accept: "application/json", "Content-Type": "application/json" },
  }, status => `HUBSPOT_HTTP_${status}`);
}

async function defaultReadTicket(ticketId: string): Promise<OwnerTicketHistory> {
  return (await import("../hubspot")).readSavOwnerHandoverTicket(ticketId);
}

/** The ticket's last owner change, as the webhook event HubSpot would have delivered for it. */
export function ownerEventFromHistory(ticket: OwnerTicketHistory): OwnerEvent | null {
  const latest = ticket.latestOwner;
  const occurredAt = latest ? Date.parse(latest.timestamp) : NaN;
  if (!latest || !Number.isSafeInteger(occurredAt) || occurredAt <= 0) return null;
  return {
    subscriptionType: "ticket.propertyChange", propertyName: "hubspot_owner_id", objectId: ticket.id, occurredAt,
    portalId: Number(SAV_HUBSPOT_SUPPORT.portalId), propertyValue: latest.value ?? "", changeSource: latest.sourceType,
  };
}

/*
 * What the poll itself last read for each ticket: the `hs_lastmodifieddate` whose owner history was read and handed to the markers. Never the
 * marker's own `updatedAt`, which the end of a wake rewrites (Astra, 19/11: a reassignment made during a wake would otherwise be missed).
 * `processedCount` counts the consecutive failed reads of this ticket; after MAX_TICKET_FAILURES the ticket is skipped, visibly.
 */
export const OWNER_HANDOVER_POLL_SEEN_PREFIX = "sav-v2-owner-handover-poll.seen:";
export const ownerHandoverPollSeenKey = (ticketId: string) => OWNER_HANDOVER_POLL_SEEN_PREFIX + ticketId;
export const OWNER_HANDOVER_POLL_MAX_TICKET_FAILURES = 3;
const SEEN_RETENTION_MS = 14 * 86_400_000;

function transientReadFailure(error: unknown) {
  const code = error instanceof SavCrmReadError ? error.diagnostic.code : "";
  return /^(?:HUBSPOT_HTTP_(?:408|429|5\d\d)|SAV_HUBSPOT_READ_)/.test(code);
}

async function readSeen(ticketId: string) {
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, ownerHandoverPollSeenKey(ticketId)));
  if (!row) return null;
  const modifiedAt = row.cursor && /^\d{1,16}$/.test(row.cursor) ? Number(row.cursor) : null;
  return { modifiedAt, failures: row.processedCount };
}

async function writeSeen(ticketId: string, values: { cursor: string | null; status: string; failures: number; lastError: string | null }, now: Date) {
  const set = { cursor: values.cursor, status: values.status, processedCount: values.failures, lastError: values.lastError, updatedAt: now };
  await requireDb().insert(savSyncState).values({ key: ownerHandoverPollSeenKey(ticketId), ...set }).onConflictDoUpdate({ target: savSyncState.key, set });
}

export async function pollSavOwnerHandovers(deps: OwnerHandoverPollDeps = {}): Promise<OwnerHandoverPollResult> {
  const env = deps.env ?? process.env, clock = deps.now ?? (() => new Date());
  if (!savV2OwnerHandoverPollEnabled(env)) return { skipped: "off" };
  const owner = v2HubspotOwnerId(env);
  if (!owner) return { skipped: "owner_unconfigured" };
  if (!deps.search && !env.HUBSPOT_ACCESS_TOKEN) return { skipped: "token_missing" };
  const deadlineMs = deps.deadlineMs ?? Date.now() + 120_000;
  if (Date.now() + 30_000 > deadlineMs) return { skipped: "deadline" };
  const claimed = await claimPoll(env, clock());
  if (!claimed) return { skipped: "leased" };
  const { state, leaseAt } = claimed;
  const search = deps.search ?? defaultSearch(env), readTicket = deps.readTicket ?? defaultReadTicket;
  const observe = deps.observe ?? ((events, options) => observeSavOwnerHandoverEvents(events, options));
  const counts = { found: 0, read: 0, seen: 0, observed: 0, beforeFloor: 0, unreadable: 0, failed: 0, skipped: 0, pages: 0 };
  const from = state.complete ? Math.max(state.floor, state.after - OWNER_HANDOVER_POLL_OVERLAP_MS) : state.after;

  const tickets: { id: string; modifiedAt: number }[] = [];
  let exhausted = false;
  try {
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const parsed = searchPageSchema.parse(await search(searchBody(owner, from, after)));
      counts.pages++;
      for (const row of parsed.results) {
        // The search filters; the result is still checked, never trusted.
        const modifiedAt = Date.parse(row.properties.hs_lastmodifieddate ?? row.updatedAt ?? "");
        if (row.properties.hubspot_owner_id !== owner || row.properties.hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId || !Number.isSafeInteger(modifiedAt)) continue;
        tickets.push({ id: row.id, modifiedAt });
      }
      after = parsed.paging?.next?.after;
      if (!after) { exhausted = true; break; }
    }
  } catch {
    await finishPoll(leaseAt, state, "owner_handover_poll_search_failed", 0, clock());
    console.warn("sav_v2_owner_handover_poll", { status: "search_failed" });
    return { status: "search_failed", ...counts };
  }
  tickets.sort((left, right) => left.modifiedAt - right.modifiedAt || left.id.localeCompare(right.id));
  counts.found = tickets.length;

  const events: OwnerEvent[] = [];
  const read: { id: string; modifiedAt: number }[] = [], failed: { id: string; modifiedAt: number; failures: number; seenAt: number | null; transient: boolean }[] = [];
  let processedThrough: number | null = null, stopped = false;
  for (const ticket of tickets) {
    if (counts.read + failed.length >= MAX_READS || Date.now() + 30_000 > deadlineMs) { stopped = true; break; }
    processedThrough = ticket.modifiedAt;
    // Nothing changed on this ticket since the poll last read its owner history: no read.
    const seen = await readSeen(ticket.id);
    if (seen?.modifiedAt != null && seen.modifiedAt >= ticket.modifiedAt) { counts.seen++; continue; }
    let history: OwnerTicketHistory;
    // One unreadable ticket never stops the others: its failure is counted below, the loop goes on.
    try { history = await readTicket(ticket.id); } catch (error) {
      failed.push({ id: ticket.id, modifiedAt: ticket.modifiedAt, failures: seen?.failures ?? 0, seenAt: seen?.modifiedAt ?? null, transient: transientReadFailure(error) });
      continue;
    }
    counts.read++;
    read.push(ticket);
    const event = history.id === ticket.id && !history.archived ? ownerEventFromHistory(history) : null;
    if (!event) { counts.unreadable++; continue; }
    if ((event.occurredAt ?? 0) < state.floor) { counts.beforeFloor++; continue; }
    events.push(event);
  }

  if (events.length) {
    try { await observe(events, { env, now: clock() }); counts.observed = events.length; } catch {
      await finishPoll(leaseAt, state, "owner_handover_poll_observe_failed", 0, clock());
      console.warn("sav_v2_owner_handover_poll", { status: "observe_failed" });
      return { status: "observe_failed", ...counts };
    }
  }
  // Recorded only once the markers hold the events: a crash before leaves the tickets to be read again.
  for (const ticket of read) await writeSeen(ticket.id, { cursor: String(ticket.modifiedAt), status: "seen", failures: 0, lastError: null }, clock());
  // A transient failure (429, 5xx, timeout) in a pass where no read succeeded is a HubSpot outage, not a bad ticket: nothing is counted, the
  // cursor waits. Any other failure (404, 403, an unexpected answer), or a transient one while other reads succeed, counts one failure; after
  // MAX_TICKET_FAILURES the ticket is skipped (logged, kept in sync_state with its error) and the cursor moves on.
  let holdAt: number | null = null;
  for (const ticket of failed) {
    const outage = ticket.transient && counts.read === 0;
    const failures = outage ? ticket.failures : ticket.failures + 1;
    const skip = !outage && failures >= OWNER_HANDOVER_POLL_MAX_TICKET_FAILURES;
    if (!outage) await writeSeen(ticket.id, { cursor: skip ? String(ticket.modifiedAt) : ticket.seenAt === null ? null : String(ticket.seenAt),
      status: skip ? "skipped" : "failing", failures, lastError: "owner_history_read_failed" }, clock());
    console.warn("sav_v2_owner_handover_poll", { status: skip ? "ticket_skipped" : "ticket_read_failed", ticketId: ticket.id, failures });
    if (skip) counts.skipped++;
    else { counts.failed++; holdAt = Math.min(holdAt ?? ticket.modifiedAt, ticket.modifiedAt); }
  }
  await requireDb().delete(savSyncState).where(and(sql`${savSyncState.key} like ${OWNER_HANDOVER_POLL_SEEN_PREFIX + "%"}`,
    sql`${savSyncState.updatedAt} < ${new Date(clock().getTime() - SEEN_RETENTION_MS)}`)).catch(() => undefined);
  const complete = exhausted && !stopped && holdAt === null;
  const next: PollState = complete
    ? { ...state, after: Math.max(state.after, tickets.at(-1)?.modifiedAt ?? state.after), complete: true }
    // A bounded pass resumes exactly where it stopped, without the overlap, so a busy window always moves forward; a ticket still being retried
    // holds the cursor at its own date (the others after it are not read again: their seen rows answer).
    : { ...state, after: Math.min(holdAt ?? Infinity, processedThrough ?? from), complete: false };
  await finishPoll(leaseAt, next, null, counts.observed, clock());
  const status = complete ? "ok" : "partial";
  console.info("sav_v2_owner_handover_poll", { status, ...counts });
  return { status, ...counts };
}
