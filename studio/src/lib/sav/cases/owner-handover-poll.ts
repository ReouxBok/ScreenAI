import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { requestSavHubspot } from "../hubspot-transport";
import { v2HubspotOwnerId } from "./intake-boundary";
import { savV2OwnerHandoverPollEnabled } from "./owner-handover-config";
import { observeSavOwnerHandoverEvents, ownerHandoverMarkerKey, type OwnerEvent } from "./owner-handover-markers";

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
 * Cost: 1 search per pass (2 at most when a page is full), plus 1 history read per ticket modified since its last observation (25 at most per pass).
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
  | { status: "ok" | "partial" | "search_failed" | "observe_failed"; found: number; read: number; seen: number; observed: number; beforeFloor: number; unreadable: number; pages: number };

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

async function lastObservedAt(ticketId: string) {
  const [row] = await requireDb().select({ updatedAt: savSyncState.updatedAt }).from(savSyncState).where(eq(savSyncState.key, ownerHandoverMarkerKey(ticketId)));
  return row?.updatedAt.getTime() ?? null;
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
  const counts = { found: 0, read: 0, seen: 0, observed: 0, beforeFloor: 0, unreadable: 0, pages: 0 };
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
  let processedThrough: number | null = null, stopped = false;
  for (const ticket of tickets) {
    if (counts.read >= MAX_READS || Date.now() + 30_000 > deadlineMs) { stopped = true; break; }
    // Nothing changed on this ticket since its last owner change was observed: no read.
    const observedAt = await lastObservedAt(ticket.id);
    if (observedAt !== null && observedAt >= ticket.modifiedAt) { counts.seen++; processedThrough = ticket.modifiedAt; continue; }
    let history: OwnerTicketHistory;
    try { history = await readTicket(ticket.id); counts.read++; } catch { stopped = true; break; }
    processedThrough = ticket.modifiedAt;
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
  const complete = exhausted && !stopped;
  const next: PollState = complete
    ? { ...state, after: Math.max(state.after, tickets.at(-1)?.modifiedAt ?? state.after), complete: true }
    // A bounded pass resumes exactly where it stopped, without the overlap, so a busy window always moves forward.
    : { ...state, after: processedThrough ?? from, complete: false };
  await finishPoll(leaseAt, next, null, counts.observed, clock());
  const status = complete ? "ok" : "partial";
  console.info("sav_v2_owner_handover_poll", { status, ...counts });
  return { status, ...counts };
}
