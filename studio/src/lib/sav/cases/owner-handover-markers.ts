import "server-only";
import { and, asc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import type { CaseTx } from "./case-store";
import { v2HubspotOwnerId } from "./intake-boundary";
import { savV2OwnerHandoverEnabled } from "./owner-handover-config";

const PREFIX = "sav-v2-owner-handover:";
export const ownerHandoverMarkerKey = (ticketId: string) => PREFIX + ticketId;
export const OWNER_HANDOVER_DELAY_MS = 305_000;
const LEASE_MS = 300_000;
const RETRY_MS = 120_000;
const MAX_ATTEMPTS = 5;
const CRM_ID = /^\d{1,30}$/;

export type OwnerEvent = {
  subscriptionType: string; propertyName?: string; objectId?: string | number; occurredAt?: number;
  portalId?: number; propertyValue?: string; changeSource?: string;
};
type Env = Record<string, string | undefined>;
type Marker = typeof savSyncState.$inferSelect;
export type OwnerHandoverTransition = { ticketId: string; ownerTransitionKey: string; observedAt: string };
type StartWake = (input: OwnerHandoverTransition, wakeAt: string) => Promise<unknown>;

// Mobile may report a CRM UI edit. Unknown sources can invalidate a pending handover but cannot start one.
export function isHumanOwnerChange(source: string | undefined) {
  return source === "CRM_UI" || source === "MOBILE";
}

function transitionOf(event: OwnerEvent, owner: string, now: Date) {
  const ticketId = String(event.objectId ?? ""), occurredAt = event.occurredAt;
  if (event.subscriptionType !== "ticket.propertyChange" || event.propertyName !== "hubspot_owner_id"
    || String(event.portalId) !== SAV_HUBSPOT_SUPPORT.portalId || !CRM_ID.test(ticketId)
    || occurredAt === undefined || !Number.isSafeInteger(occurredAt) || occurredAt <= 0 || occurredAt > now.getTime() + 300_000) return null;
  const ownerId = event.propertyValue || null;
  if (ownerId && !CRM_ID.test(ownerId)) return null;
  return {
    ticketId, ownerTransitionKey: `hubspot-owner:${ticketId}:${occurredAt}:${ownerId ?? "none"}`,
    observedAt: new Date(occurredAt).toISOString(), due: ownerId === owner && isHumanOwnerChange(event.changeSource),
  };
}

const startWake: StartWake = async (input, wakeAt) => {
  const [{ start }, { processSavV2OwnerHandoverWorkflow }] = await Promise.all([import("workflow/api"), import("@/workflows/sav-v2-case")]);
  return start(processSavV2OwnerHandoverWorkflow, [input, wakeAt]);
};

/** One high-water mark per ticket. Older deliveries cannot replace a newer transition, even after a wake has finished. */
export async function observeSavOwnerHandoverEvents(events: readonly OwnerEvent[], options: { env?: Env; now?: Date; start?: StartWake } = {}) {
  const env = options.env ?? process.env;
  if (!savV2OwnerHandoverEnabled(env)) return;
  const owner = v2HubspotOwnerId(env);
  if (!owner) return;
  const now = options.now ?? new Date();
  const byTicket = new Map<string, NonNullable<ReturnType<typeof transitionOf>>[]>();
  for (const event of events) {
    const transition = transitionOf(event, owner, now);
    if (transition) byTicket.set(transition.ticketId, [...(byTicket.get(transition.ticketId) ?? []), transition]);
  }
  for (const [ticketId, transitions] of byTicket) {
    const key = PREFIX + ticketId;
    const latestAt = transitions.map(transition => transition.observedAt).sort().at(-1)!;
    const latest = transitions.filter(transition => transition.observedAt === latestAt);
    const transition = latest[0]!;
    const due = latest.every(item => item.ownerTransitionKey === transition.ownerTransitionKey && item.due);
    const reserved = await requireDb().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
      const [current] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key)).for("update");
      const currentAt = current?.startedAt?.toISOString();
      if (currentAt && currentAt > latestAt) return false;
      if (currentAt === latestAt) {
        if (!due || current?.cursor !== transition.ownerTransitionKey) {
          await tx.update(savSyncState).set({ status: "ignored", updatedAt: now }).where(eq(savSyncState.key, key));
        }
        return false;
      }
      const values = { cursor: transition.ownerTransitionKey, status: due ? "pending" : "ignored", startedAt: new Date(latestAt),
        updatedAt: now, processedCount: 0, lastError: null, completedAt: null };
      await tx.insert(savSyncState).values({ key, ...values }).onConflictDoUpdate({ target: savSyncState.key, set: values });
      return due;
    });
    if (reserved) {
      const input = { ticketId, ownerTransitionKey: transition.ownerTransitionKey, observedAt: transition.observedAt };
      const wakeAt = new Date(Date.parse(input.observedAt) + OWNER_HANDOVER_DELAY_MS).toISOString();
      // The result of start may be uncertain. The due-row sweep is the fallback, with the same claim.
      await (options.start ?? startWake)(input, wakeAt).catch(() => console.warn("sav_v2_owner_handover", { status: "wake_start_failed" }));
    }
  }
}

function dueMarkers(now: Date) {
  return and(lte(savSyncState.startedAt, new Date(now.getTime() - OWNER_HANDOVER_DELAY_MS)),
    lt(savSyncState.processedCount, MAX_ATTEMPTS),
    or(
      and(eq(savSyncState.status, "pending"), or(eq(savSyncState.processedCount, 0), lte(savSyncState.updatedAt, new Date(now.getTime() - RETRY_MS)))),
      and(eq(savSyncState.status, "running"), lte(savSyncState.updatedAt, new Date(now.getTime() - LEASE_MS))),
    ));
}

export function listDueOwnerHandovers(now: Date) {
  return requireDb().select().from(savSyncState)
    .where(and(sql`${savSyncState.key} like ${PREFIX + "%"}`, dueMarkers(now)))
    .orderBy(asc(savSyncState.startedAt), asc(savSyncState.key)).limit(5);
}

export function ownerHandoverFromMarker(row: Marker): OwnerHandoverTransition {
  return { ticketId: row.key.slice(PREFIX.length), ownerTransitionKey: row.cursor!, observedAt: row.startedAt!.toISOString() };
}

export async function claimOwnerHandover(input: OwnerHandoverTransition, now: Date) {
  const [claimed] = await requireDb().update(savSyncState).set({
    status: "running", processedCount: sql`${savSyncState.processedCount} + 1`, updatedAt: now,
  }).where(and(eq(savSyncState.key, PREFIX + input.ticketId), eq(savSyncState.cursor, input.ownerTransitionKey),
    eq(savSyncState.startedAt, new Date(input.observedAt)), dueMarkers(now))).returning();
  return claimed ?? null;
}

function sameClaim(row: Marker) {
  return and(eq(savSyncState.key, row.key), eq(savSyncState.cursor, row.cursor!), eq(savSyncState.status, "running"),
    eq(savSyncState.processedCount, row.processedCount));
}

export async function ownerHandoverClaimIsCurrent(row: Marker, tx?: CaseTx) {
  const [current] = await (tx ?? requireDb()).select({ key: savSyncState.key }).from(savSyncState).where(sameClaim(row)).for("share");
  return !!current;
}

/** SAV-99 (19/11): a finished handover now keeps WHY it ended (`outcome:<status>`), so a later reading never has to guess it. */
export const ownerHandoverOutcome = (status: string) => `outcome:${status.replace(/[^a-z0-9_]/gi, "_").slice(0, 60)}`;

export async function finishOwnerHandover(row: Marker, retry: boolean, now: Date, outcome?: string) {
  const status = retry ? row.processedCount < MAX_ATTEMPTS ? "pending" : "failed" : "complete";
  await requireDb().update(savSyncState).set({
    status, lastError: retry ? "owner_handover_read_or_relay_failed" : outcome ? ownerHandoverOutcome(outcome) : null, updatedAt: now,
    completedAt: status === "pending" ? null : now,
  }).where(sameClaim(row));
}

/**
 * SAV-99 (Ugo 19/11): until this fix, a ticket a person gave the agent was dropped when its HubSpot category was not « Acces » (`outside_access`), and
 * the marker ended `complete` without its outcome. Such a handover is evaluated ONCE more with the current rules: only a marker that ended `complete`
 * BEFORE outcomes were recorded (`lastError` null), whose transition is not older than the poll's floor, whose ticket has no case, with attempts left.
 * Nothing is reset: same transition, same claim, same attempt counter, same guards in `runSavOwnerHandover` (owner still the agent, the same human
 * transition, ticket open, pause, case, permission). The reopened row carries `sav99_category_recheck` until it ends with its outcome, so it is never
 * reopened twice. At most `limit` per pass. Never a global replay: a marker finished after this fix always carries its outcome.
 */
export const OWNER_HANDOVER_CATEGORY_RECHECK = "sav99_category_recheck";
export async function reopenPreOutcomeOwnerHandovers(now: Date, floor: Date, limit = 5) {
  const db = requireDb();
  const rows = await db.select({ key: savSyncState.key }).from(savSyncState).where(and(sql`${savSyncState.key} like ${PREFIX + "%"}`,
    eq(savSyncState.status, "complete"), isNull(savSyncState.lastError), gte(savSyncState.startedAt, floor), lt(savSyncState.processedCount, MAX_ATTEMPTS),
    sql`not exists (select 1 from sav.cases c where c.ticket_id = substring(${savSyncState.key} from ${PREFIX.length + 1}))`))
    .orderBy(asc(savSyncState.startedAt), asc(savSyncState.key)).limit(limit);
  let reopened = 0;
  for (const { key } of rows) {
    // Due at once for the sweep that follows (a pending retry is due RETRY_MS after its last update), and only if nobody touched the row since.
    const [row] = await db.update(savSyncState).set({ status: "pending", lastError: OWNER_HANDOVER_CATEGORY_RECHECK, completedAt: null,
      updatedAt: new Date(now.getTime() - RETRY_MS) })
      .where(and(eq(savSyncState.key, key), eq(savSyncState.status, "complete"), isNull(savSyncState.lastError))).returning({ key: savSyncState.key });
    if (row) reopened++;
  }
  return reopened;
}
