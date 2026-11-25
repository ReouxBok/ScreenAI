import "server-only";
import { and, asc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { requestSavHubspot } from "../hubspot-transport";
import { APP_TICKET_TRANSITION_PREFIX, appTicketCategoryGated, appTicketSourceLabel, savAppTicketsMode, savAppTicketsSourceTypes } from "./app-tickets-config";
import { hasLocalThreadForTicket, savCaseRecordingEnabled } from "./case-store";
import { savV2EntrySmartOn } from "./smart-entry-switch";
import { v2HubspotOwnerId } from "./intake-boundary";
import { THREADLESS_ADMIT_PERMISSION } from "./threadless-config";
import type { ThreadlessEntryResult } from "./threadless-entry";
import { readThreadlessAuthority, threadlessActionAllowed, threadlessSchemaInstalled } from "./threadless-guard";

/*
 * SAV-138 (Ugo 25/11): tickets created from the Limova app arrive in HubSpot with no mail. Each reconcile pass (the existing cron and its fallback, no new
 * cron or route) runs ONE bounded search (support pipeline, stage « Nouveau », no owner, created since a durable cursor) and decides each ticket ONCE:
 *   1. fresh read of the ticket and of its mail associations; a mail (HubSpot or local thread), an owner, a V1 `EMAIL` ticket, another stage: not this path;
 *   2. category gate BEFORE anything else: « Facturation » / « Résiliation » = never touched (no owner change, no model, no Slack, no mail);
 *   3. shadow: the decision is recorded, nothing else. Live: the entry's own guards are checked first (switches, pause, schema, authority), then the ticket
 *      is assigned to the Agent SAV owner and enters the existing threadless path (`startV2FromThreadlessTicket`): same reads, contact rule (unknown
 *      contact = team, no identification mail), smart door and hand-over stage (nothing sent to the customer before an exchange, #363).
 * One durable row per ticket and mode (`sav-app-ticket.v1:<mode>:<id>`) makes it idempotent; a pass lease serialises concurrent passes. A live row left
 * between assignment and entry is retried from the database (the search no longer sees an owned ticket), at most MAX_ATTEMPTS times, then handed back.
 * HubSpot tickets are never archived or deleted here.
 * Cost per pass: 1 search (2 at most), then 2 reads per new ticket (MAX_TICKETS at most); live adds 1 PATCH and 1 entry (the model) for ONE ticket per pass,
 * and only with APP_TICKETS_ENTRY_MARGIN_MS left before the deadline (as `sweepDueOwnerHandovers`).
 * Leaving live: in shadow, a live row left between assignment and entry is handed back to the team once (`releaseLiveRows`). Off: nothing at all, not even a
 * database read (the reconcile pass does not load this module); the exit procedure is shadow for at least one pass, then off (`docs/SAV_HUBSPOT_MAPPING.md`).
 */

type Env = Record<string, string | undefined>;
type Mode = "shadow" | "live";
export const appTicketsCursorKey = (mode: Mode) => `sav-app-tickets.v1:${mode}`;
export const APP_TICKET_ROW_PREFIX = "sav-app-ticket.v1:";
export const appTicketRowKey = (mode: Mode, ticketId: string) => `${APP_TICKET_ROW_PREFIX}${mode}:${ticketId}`;
export const APP_TICKETS_PAGE_SIZE = 100;
export const APP_TICKETS_MAX_PAGES = 2;
export const APP_TICKETS_MAX_TICKETS = 10;
export const APP_TICKETS_MAX_ATTEMPTS = 5;
const RETRY_BATCH = 5;
/** Review 25/11: at most one entry (a model call) per pass, and only with 100 s left, like `sweepDueOwnerHandovers`. */
export const APP_TICKETS_MAX_ENTRIES = 1;
export const APP_TICKETS_ENTRY_MARGIN_MS = 100_000;
const OVERLAP_MS = 120_000;
const LEASE_MS = 240_000;
const RETENTION_MS = 30 * 86_400_000;
const CRM_ID = /^\d{1,30}$/;
/** Non-final row states: retried from the database. Every other state is the ticket's final decision. */
const PENDING = ["waiting", "assigning", "assigned"] as const;

const cursorSchema = z.object({ v: z.literal(1), after: z.number().int().nonnegative(), floor: z.number().int().nonnegative() }).strict();
type CursorState = z.infer<typeof cursorSchema>;
const detailSchema = z.object({
  v: z.literal(1), sourceType: z.string().max(40).optional(), categoryGated: z.boolean().optional(), createdAt: z.number().int().nonnegative().optional(),
  transition: z.object({ key: z.string().max(420), observedAt: z.string().max(40) }).strict().optional(), entry: z.string().max(80).optional(),
}).strict();
export type AppTicketDetail = z.infer<typeof detailSchema>;

const searchPageSchema = z.object({
  results: z.array(z.object({ id: z.string().regex(CRM_ID), createdAt: z.string().optional(), properties: z.object({
    hubspot_owner_id: z.string().nullish(), hs_pipeline: z.string().nullish(), hs_pipeline_stage: z.string().nullish(), createdate: z.string().nullish(),
  }) })),
  paging: z.object({ next: z.object({ after: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String) }).optional() }).optional(),
});
export type AppTicketSearchPage = z.input<typeof searchPageSchema>;
export type AppTicketRead = {
  id: string; archived: boolean; ownerId: string | null; pipeline: string; stage: string; categories: string; sourceType: string | null; hasEmail: boolean;
};
type Transition = { ticketId: string; ownerTransitionKey: string; observedAt: string };
export type AppTicketsDeps = {
  env?: Env;
  now?: () => Date;
  deadlineMs?: number;
  search?: (body: unknown) => Promise<unknown>;
  readTicket?: (ticketId: string) => Promise<AppTicketRead>;
  /** Live: the threadless entry's own guards, read BEFORE the assignment (a ticket is never assigned to an entry that cannot take it). */
  entryAvailable?: (observedAt: string) => Promise<boolean>;
  assign?: (ticketId: string, ownerId: string) => Promise<void>;
  enter?: (input: Transition) => Promise<ThreadlessEntryResult>;
  handBack?: (input: Transition, reason: string) => Promise<ThreadlessEntryResult>;
};
export type AppTicketsResult =
  | { skipped: "off" | "owner_unconfigured" | "token_missing" | "source_types_unconfigured" | "leased" | "deadline"; released?: number }
  | { mode: Mode; status: "ok" | "partial" | "search_failed"; found: number; decided: Record<string, number>; retried: number; pages: number; released?: number };

export function appTicketsLookbackMs(env: Env) {
  const raw = Number(env.SAV_APP_TICKETS_LOOKBACK_MINUTES);
  return (Number.isInteger(raw) && raw >= 1 ? Math.min(raw, 1_440) : 60) * 60_000;
}

function parse<T>(schema: z.ZodType<T>, text: string | null | undefined): T | null {
  if (!text) return null;
  try { return schema.parse(JSON.parse(text)); } catch { return null; }
}

async function claimPass(mode: Mode, env: Env, now: Date) {
  const key = appTicketsCursorKey(mode);
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key)).for("update");
    if (row?.status === "running" && row.updatedAt.getTime() > now.getTime() - LEASE_MS) return null;
    const floor = now.getTime() - appTicketsLookbackMs(env);
    // An unreadable cursor restarts from a fresh floor: never earlier than the lookback.
    const state = parse(cursorSchema, row?.cursor) ?? { v: 1 as const, after: floor, floor };
    const values = { status: "running", cursor: JSON.stringify(state), updatedAt: now, startedAt: row?.startedAt ?? now };
    await tx.insert(savSyncState).values({ key, ...values }).onConflictDoUpdate({ target: savSyncState.key, set: values });
    return { state, leaseAt: now };
  });
}

async function finishPass(mode: Mode, leaseAt: Date, state: CursorState, error: string | null, decided: number, now: Date) {
  await requireDb().update(savSyncState).set({
    status: error ? "failed" : "idle", cursor: JSON.stringify(state), lastError: error, updatedAt: now, completedAt: now,
    processedCount: sql`${savSyncState.processedCount} + ${decided}`,
  }).where(and(eq(savSyncState.key, appTicketsCursorKey(mode)), eq(savSyncState.status, "running"), eq(savSyncState.updatedAt, leaseAt)));
}

export function appTicketsSearchBody(from: number, after?: string) {
  return {
    filterGroups: [{ filters: [
      { propertyName: "hs_pipeline", operator: "EQ", value: SAV_HUBSPOT_SUPPORT.pipelineId },
      { propertyName: "hs_pipeline_stage", operator: "EQ", value: SAV_HUBSPOT_SUPPORT.stages.new },
      { propertyName: "hubspot_owner_id", operator: "NOT_HAS_PROPERTY" },
      // V1's mail tickets are never this path's (the fresh read checks it again).
      { propertyName: "source_type", operator: "NEQ", value: SAV_HUBSPOT_SUPPORT.source },
      { propertyName: "createdate", operator: "GTE", value: String(from) },
    ] }],
    sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
    properties: ["hubspot_owner_id", "hs_pipeline", "hs_pipeline_stage", "createdate"],
    limit: APP_TICKETS_PAGE_SIZE,
    ...(after ? { after } : {}),
  };
}

const hubspotHeaders = (env: Env) => ({ Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, Accept: "application/json", "Content-Type": "application/json" });
const ticketSchema = z.object({ id: z.string(), archived: z.boolean().optional(), properties: z.object({
  hubspot_owner_id: z.string().nullish(), hs_pipeline: z.string(), hs_pipeline_stage: z.string(), hs_ticket_category: z.string().max(1_000).nullish(),
  source_type: z.string().max(80).nullish(),
}) });
const associationsSchema = z.object({ results: z.array(z.unknown()), paging: z.object({ next: z.unknown().optional() }).optional() });

function defaultDeps(env: Env): Required<Pick<AppTicketsDeps, "search" | "readTicket" | "entryAvailable" | "assign" | "enter" | "handBack">> {
  const call = <T,>(path: string, method: "GET" | "POST" | "PATCH", body?: unknown) => requestSavHubspot<T>(path, {
    method, cache: "no-store", headers: hubspotHeaders(env), signal: AbortSignal.timeout(20_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, status => `HUBSPOT_HTTP_${status}`);
  return {
    search: body => call<unknown>("/crm/v3/objects/tickets/search", "POST", body),
    async readTicket(ticketId) {
      const ticket = ticketSchema.parse(await call<unknown>(
        `/crm/v3/objects/tickets/${ticketId}?properties=hubspot_owner_id,hs_pipeline,hs_pipeline_stage,hs_ticket_category,source_type`, "GET"));
      const mails = associationsSchema.parse(await call<unknown>(`/crm/v4/objects/tickets/${ticketId}/associations/emails?limit=1`, "GET"));
      const p = ticket.properties;
      return { id: ticket.id, archived: ticket.archived ?? false, ownerId: p.hubspot_owner_id || null, pipeline: p.hs_pipeline, stage: p.hs_pipeline_stage,
        categories: p.hs_ticket_category ?? "", sourceType: p.source_type || null, hasEmail: mails.results.length > 0 || Boolean(mails.paging?.next) };
    },
    async entryAvailable(observedAt) {
      const db = requireDb();
      return savCaseRecordingEnabled(env) && await threadlessActionAllowed(env, db) && await threadlessSchemaInstalled(db)
        && Boolean(await readThreadlessAuthority(env, THREADLESS_ADMIT_PERMISSION, observedAt));
    },
    async assign(ticketId, ownerId) { await call<unknown>(`/crm/v3/objects/tickets/${ticketId}`, "PATCH", { properties: { hubspot_owner_id: ownerId } }); },
    enter: async input => (await import("./threadless-entry")).startV2FromThreadlessTicket(input),
    handBack: async (input, reason) => (await import("./threadless-entry")).handBackOwnerHandoverTicket(input, reason),
  };
}

type Row = typeof savSyncState.$inferSelect;
async function readRow(key: string) {
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, key));
  return row ?? null;
}

/** Writes the row only if nobody changed it since `expected` was read (null: only if it does not exist yet). */
async function writeRow(key: string, expected: Row | null, status: string, detail: AppTicketDetail, attempts: number, now: Date, error: string | null = null) {
  const values = { status, cursor: JSON.stringify(detail), processedCount: attempts, lastError: error, updatedAt: now,
    startedAt: expected?.startedAt ?? now, completedAt: (PENDING as readonly string[]).includes(status) ? null : now };
  if (!expected) {
    const inserted = await requireDb().insert(savSyncState).values({ key, ...values }).onConflictDoNothing().returning({ key: savSyncState.key });
    return inserted.length === 1;
  }
  const updated = await requireDb().update(savSyncState).set(values).where(and(eq(savSyncState.key, key), eq(savSyncState.status, expected.status),
    eq(savSyncState.updatedAt, expected.updatedAt))).returning({ key: savSyncState.key });
  return updated.length === 1;
}

type Context = { mode: Mode; env: Env; owner: string; sources: string[]; clock: () => Date; deps: ReturnType<typeof defaultDeps>;
  /** Whether this pass may still start an entry (a model call): under the per-pass bound, with the margin left. */
  canEnter: () => boolean; entered: () => void };

const transitionInput = (key: string, transition: NonNullable<AppTicketDetail["transition"]>): Transition =>
  ({ ticketId: key.slice(key.lastIndexOf(":") + 1), ownerTransitionKey: transition.key, observedAt: transition.observedAt });

/** A ticket in the agent's name that will not enter: back to the team, once, with no mail (`handBackOwnerHandoverTicket`). Returns the row's final state. */
async function handBackRow(deps: Pick<Context["deps"], "handBack">, key: string, row: Row, detail: AppTicketDetail, reason: string, label: string, attempts: number, now: Date,
  keepOn: readonly string[] = []) {
  const input = transitionInput(key, detail.transition!);
  const back = await deps.handBack(input, reason).catch((): ThreadlessEntryResult => ({ status: "unavailable" }));
  if (keepOn.includes(back.status)) return "kept";
  const handedBack = back.status === "human_wait" || back.status === "existing_case";
  if (!handedBack) console.warn("sav_v2_app_tickets", { status: "hand_back_failed", ticketId: input.ticketId, entry: label, handBack: back.status });
  await writeRow(key, row, handedBack ? "handed_back" : "failed", { ...detail, entry: `${label}>${back.status}`.slice(0, 80) }, attempts, now, handedBack ? null : "hand_back_failed");
  return handedBack ? "handed_back" : "failed";
}

/** Maps the threadless entry's answer: a case (agent or team) = taken; a ticket that changed = left; anything else waits for a retry. */
function entryOutcome(result: ThreadlessEntryResult): "taken" | "ignored_owned" | "ignored_closed" | "hand_back" | "retry" | "paused" {
  switch (result.status) {
    case "started": case "queued": case "human_wait": case "existing_case": return "taken";
    case "owner_changed": return "ignored_owned";
    case "closed": return "ignored_closed";
    case "existing_thread": case "out_of_scope": return "hand_back";
    case "paused": return "paused";
    default: return "retry";
  }
}

/** Live, after the assignment: the existing threadless path. Returns the row's new state. */
async function enterAssigned(context: Context, key: string, row: Row, detail: AppTicketDetail): Promise<string> {
  // No time or no slot left in this pass: the row stays `assigned`, the next pass enters it.
  if (!context.canEnter()) return "deferred";
  context.entered();
  const input = transitionInput(key, detail.transition!);
  const result = await context.deps.enter(input).catch((): ThreadlessEntryResult => ({ status: "unavailable" }));
  const outcome = entryOutcome(result), now = context.clock();
  const attempts = outcome === "paused" ? row.processedCount : row.processedCount + 1;
  if (outcome === "retry" || outcome === "paused") {
    if (attempts < APP_TICKETS_MAX_ATTEMPTS) {
      await writeRow(key, row, "assigned", { ...detail, entry: result.status }, attempts, now, "entry_retry");
      return "assigned";
    }
  }
  if (outcome === "taken" || outcome === "ignored_owned" || outcome === "ignored_closed") {
    await writeRow(key, row, outcome, { ...detail, entry: result.status }, attempts, now);
    return outcome;
  }
  // The ticket is in the agent's name and the entry cannot take it: it goes back to the team, once, with no mail.
  return handBackRow(context.deps, key, row, detail, outcome === "hand_back" ? `app_ticket_${result.status}` : "app_ticket_entry_unavailable", result.status, attempts, now);
}

/** One ticket, from its fresh read to its decision (shadow) or its entry (live). Never throws. */
async function decide(context: Context, ticketId: string, createdAt: number | undefined): Promise<string> {
  const { mode, deps } = context;
  const key = appTicketRowKey(mode, ticketId);
  let row = await readRow(key);
  if (row && !(PENDING as readonly string[]).includes(row.status)) return "seen";
  const previous = parse(detailSchema, row?.cursor) ?? { v: 1 as const, ...(createdAt === undefined ? {} : { createdAt }) };
  if (row?.status === "assigned" && previous.transition) return enterAssigned(context, key, row, previous);

  let ticket: AppTicketRead;
  try {
    ticket = await deps.readTicket(ticketId);
    if (ticket.id !== ticketId) throw Error("SAV_APP_TICKET_MISMATCH");
  } catch {
    const attempts = (row?.processedCount ?? 0) + 1, final = attempts >= APP_TICKETS_MAX_ATTEMPTS;
    await writeRow(key, row, final ? "unreadable" : "waiting", previous, attempts, context.clock(), "ticket_read_failed");
    return final ? "unreadable" : "waiting";
  }
  const detail: AppTicketDetail = { ...previous, sourceType: appTicketSourceLabel(ticket.sourceType), categoryGated: appTicketCategoryGated(ticket.categories) };
  // Our own assignment whose answer was lost: the agent owns it now, the entry follows.
  const ours = row?.status === "assigning" && ticket.ownerId === context.owner && Boolean(previous.transition);
  const decision = ticket.archived || ticket.stage === SAV_HUBSPOT_SUPPORT.stages.closed ? "ignored_closed"
    : ticket.pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId ? "ignored_pipeline"
      : ticket.ownerId && !ours ? "ignored_owned"
        : ticket.sourceType === SAV_HUBSPOT_SUPPORT.source ? "ignored_email_source"
          : ticket.hasEmail || await hasLocalThreadForTicket(ticketId) ? "ignored_has_email"
            : !ours && ticket.stage !== SAV_HUBSPOT_SUPPORT.stages.new ? "ignored_not_new"
              // Ugo 25/11: billing and cancellation stay with the team, before any model, owner change, Slack notice or mail.
              : detail.categoryGated ? "team_category"
                : mode === "shadow" ? "would_take"
                  : !ours && !context.sources.includes(ticket.sourceType ?? "") ? "ignored_source" : "take";
  if (decision !== "take") {
    // Our own assignment, but the ticket no longer qualifies (category, mail, stage...): it is in the agent's name, it goes back to the team once.
    if (ours && decision !== "ignored_closed") return handBackRow(deps, key, row!, detail, `app_ticket_${decision}`, decision, row!.processedCount, context.clock());
    await writeRow(key, row, decision, detail, row?.processedCount ?? 0, context.clock());
    return decision;
  }

  // Never assigned without the time and the slot to enter it in this pass (the ticket is taken at a later pass).
  if (!context.canEnter()) return "deferred";
  if (!ours) {
    const observedAt = context.clock().toISOString();
    // The smart brain writes an app ticket's first mail: switched off, no assignment (the ticket would only be handed back).
    if (!savV2EntrySmartOn(context.env) || !await deps.entryAvailable(observedAt).catch(() => false)) {
      const attempts = (row?.processedCount ?? 0) + 1, final = attempts >= APP_TICKETS_MAX_ATTEMPTS;
      await writeRow(key, row, final ? "left_entry_unavailable" : "waiting", detail, attempts, context.clock(), "entry_unavailable");
      return final ? "left_entry_unavailable" : "waiting";
    }
    const transition = { key: `${APP_TICKET_TRANSITION_PREFIX}${ticketId}:${Date.parse(observedAt)}:${context.owner}`, observedAt };
    // The claim: only the pass that writes `assigning` from the state it read may assign.
    if (!await writeRow(key, row, "assigning", { ...detail, transition }, row?.processedCount ?? 0, context.clock())) return "seen";
    row = (await readRow(key))!;
    try { await deps.assign(ticketId, context.owner); } catch {
      // Applied or not, the next pass reads the owner again: ours = the entry follows; still none = assigned again; someone else = left.
      const attempts = row.processedCount + 1, final = attempts >= APP_TICKETS_MAX_ATTEMPTS;
      await writeRow(key, row, final ? "failed" : "assigning", { ...detail, transition }, attempts, context.clock(), "assign_failed");
      if (final) console.warn("sav_v2_app_tickets", { status: "assign_failed", ticketId });
      return final ? "failed" : "assigning";
    }
    if (!await writeRow(key, row, "assigned", { ...detail, transition }, row.processedCount, context.clock())) return "seen";
    return enterAssigned(context, key, (await readRow(key))!, { ...detail, transition });
  }
  if (!await writeRow(key, row, "assigned", detail, row!.processedCount, context.clock())) return "seen";
  return enterAssigned(context, key, (await readRow(key))!, detail);
}

/** A hand-back that could not run now (V2 paused, entry unavailable or switched off): nothing is written, the row is tried again at the next pass. */
const TRANSIENT_HAND_BACK = ["paused", "unavailable", "off"];

/**
 * Review 25/11: live switched to shadow (exit procedure: shadow for at least one pass, then off; `docs/SAV_HUBSPOT_MAPPING.md`). A live row left between
 * assignment and entry (`assigning`, `assigned`) is a ticket possibly in the agent's name that no pass will enter any more: it is handed back to the team ONCE
 * (final state `handed_back` or `failed`, visible in `app_tickets_report` mode live), under the live pass lease; a hand-back that cannot run now leaves the row
 * as it is for the next pass. No such row: one bounded read, no HubSpot call, nothing written. Off never runs it (off = strictly today's behaviour).
 */
async function releaseLiveRows(mode: "shadow", env: Env, clock: () => Date, handBack: Context["deps"]["handBack"]): Promise<number> {
  const stranded = await requireDb().select({ key: savSyncState.key }).from(savSyncState)
    .where(and(sql`${savSyncState.key} like ${APP_TICKET_ROW_PREFIX + "live:%"}`, inArray(savSyncState.status, ["assigning", "assigned"])))
    .orderBy(asc(savSyncState.updatedAt), asc(savSyncState.key)).limit(RETRY_BATCH);
  if (!stranded.length) return 0;
  const claimed = await claimPass("live", env, clock());
  if (!claimed) return 0;
  let released = 0;
  for (const { key } of stranded) {
    const row = await readRow(key), detail = parse(detailSchema, row?.cursor);
    if (!row || !["assigning", "assigned"].includes(row.status) || !detail?.transition) continue;
    const outcome = await handBackRow({ handBack }, key, row, detail, `app_ticket_mode_${mode}`, `mode_${mode}`, row.processedCount, clock(), TRANSIENT_HAND_BACK);
    if (outcome !== "kept") released++;
  }
  await finishPass("live", claimed.leaseAt, claimed.state, null, released, clock());
  return released;
}

export async function reconcileSavAppTickets(options: AppTicketsDeps = {}): Promise<AppTicketsResult> {
  const env = options.env ?? process.env, clock = options.now ?? (() => new Date());
  const mode = savAppTicketsMode(env);
  if (mode === "off") return { skipped: "off" };
  const released = mode === "shadow" ? await releaseLiveRows(mode, env, clock, options.handBack ?? defaultDeps(env).handBack) : 0;
  const withReleased = <T extends AppTicketsResult>(result: T): T => released ? { ...result, released } : result;
  const owner = v2HubspotOwnerId(env);
  if (!owner) return { skipped: "owner_unconfigured" };
  const sources = savAppTicketsSourceTypes(env);
  if (mode === "live" && !sources.length) return { skipped: "source_types_unconfigured" };
  if (!options.search && !env.HUBSPOT_ACCESS_TOKEN) return { skipped: "token_missing" };
  const deadlineMs = options.deadlineMs ?? Date.now() + 120_000;
  if (Date.now() + 30_000 > deadlineMs) return { skipped: "deadline" };
  const claimed = await claimPass(mode, env, clock());
  if (!claimed) return withReleased({ skipped: "leased" });
  const { state, leaseAt } = claimed;
  const defaults = defaultDeps(env);
  const deps = { search: options.search ?? defaults.search, readTicket: options.readTicket ?? defaults.readTicket,
    entryAvailable: options.entryAvailable ?? defaults.entryAvailable, assign: options.assign ?? defaults.assign,
    enter: options.enter ?? defaults.enter, handBack: options.handBack ?? defaults.handBack };
  let entries = 0;
  const context: Context = { mode, env, owner, sources, clock, deps, entered: () => { entries++; },
    canEnter: () => entries < APP_TICKETS_MAX_ENTRIES && Date.now() + APP_TICKETS_ENTRY_MARGIN_MS <= deadlineMs };
  const decided: Record<string, number> = {};
  const count = (status: string) => { decided[status] = (decided[status] ?? 0) + 1; };
  let budget = APP_TICKETS_MAX_TICKETS, retried = 0;
  const timeLeft = () => Date.now() + 30_000 <= deadlineMs;

  // Rows left between two states (a read that failed, an entry not yet available, an assignment without its entry) come back from the database.
  const pending = await requireDb().select({ key: savSyncState.key, cursor: savSyncState.cursor }).from(savSyncState)
    .where(and(sql`${savSyncState.key} like ${APP_TICKET_ROW_PREFIX + mode + ":%"}`, inArray(savSyncState.status, [...PENDING]),
      lt(savSyncState.processedCount, APP_TICKETS_MAX_ATTEMPTS)))
    .orderBy(asc(savSyncState.updatedAt), asc(savSyncState.key)).limit(RETRY_BATCH);
  for (const row of pending) {
    if (!budget || !timeLeft()) break;
    budget--; retried++;
    count(await decide(context, row.key.slice(row.key.lastIndexOf(":") + 1), undefined));
    if (mode === "live" && !context.canEnter()) break;
  }

  const from = Math.max(state.floor, state.after - OVERLAP_MS);
  const tickets: { id: string; createdAt: number }[] = [];
  let pages = 0, exhausted = false;
  try {
    let after: string | undefined;
    for (let page = 0; page < APP_TICKETS_MAX_PAGES; page++) {
      const parsed = searchPageSchema.parse(await deps.search(appTicketsSearchBody(from, after)));
      pages++;
      for (const row of parsed.results) {
        // The search filters; the result is still checked, never trusted.
        const createdAt = Date.parse(row.properties.createdate ?? row.createdAt ?? "");
        if (row.properties.hubspot_owner_id || row.properties.hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId || !Number.isSafeInteger(createdAt)) continue;
        tickets.push({ id: row.id, createdAt });
      }
      after = parsed.paging?.next?.after;
      if (!after) { exhausted = true; break; }
    }
  } catch {
    await finishPass(mode, leaseAt, state, "app_tickets_search_failed", 0, clock());
    console.warn("sav_v2_app_tickets", { mode, status: "search_failed" });
    return withReleased({ mode, status: "search_failed", found: 0, decided, retried, pages });
  }
  tickets.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

  let processedThrough: number | null = null, stopped = false;
  for (const ticket of tickets) {
    // A ticket already decided costs no HubSpot call (the overlap brings back the last ones).
    const known = await readRow(appTicketRowKey(mode, ticket.id));
    if (known) { processedThrough = ticket.createdAt; continue; }
    if (!budget || !timeLeft()) { stopped = true; break; }
    budget--;
    const outcome = await decide(context, ticket.id, ticket.createdAt);
    count(outcome);
    // Deferred: nothing was written for this ticket; the cursor stays before it, the next pass takes it.
    if (outcome === "deferred") { stopped = true; break; }
    processedThrough = ticket.createdAt;
  }
  await requireDb().delete(savSyncState).where(and(sql`${savSyncState.key} like ${APP_TICKET_ROW_PREFIX + "%"}`,
    notInArray(savSyncState.status, [...PENDING]), lt(savSyncState.updatedAt, new Date(clock().getTime() - RETENTION_MS))))
    .catch(() => console.warn("sav_v2_app_tickets", { mode, status: "retention_failed" }));
  const complete = exhausted && !stopped;
  // A bounded pass resumes exactly where it stopped; a complete one from its last ticket (minus the overlap at the next read).
  const next: CursorState = complete ? { ...state, after: Math.max(state.after, tickets.at(-1)?.createdAt ?? state.after) }
    : { ...state, after: Math.max(state.floor, processedThrough ?? state.after) };
  const total = Object.values(decided).reduce((sum, value) => sum + value, 0);
  await finishPass(mode, leaseAt, next, null, total, clock());
  const status = complete ? "ok" : "partial";
  console.info("sav_v2_app_tickets", { mode, status, found: tickets.length, retried, pages, released, ...decided });
  return withReleased({ mode, status, found: tickets.length, decided, retried, pages });
}

/** Admin report (MCP `app_tickets_report`): the recorded decisions, no ticket content (ids, states, source type, gate, dates). */
export async function readSavAppTicketsReport(input: { mode: Mode; limit: number }) {
  const db = requireDb();
  const [cursor] = await db.select().from(savSyncState).where(eq(savSyncState.key, appTicketsCursorKey(input.mode)));
  const prefix = APP_TICKET_ROW_PREFIX + input.mode + ":";
  const counts = await db.select({ status: savSyncState.status, total: sql<number>`count(*)::int` }).from(savSyncState)
    .where(sql`${savSyncState.key} like ${prefix + "%"}`).groupBy(savSyncState.status);
  const rows = await db.select().from(savSyncState).where(sql`${savSyncState.key} like ${prefix + "%"}`)
    .orderBy(sql`${savSyncState.updatedAt} desc`, asc(savSyncState.key)).limit(input.limit);
  const state = parse(cursorSchema, cursor?.cursor);
  return {
    mode: input.mode, configuredMode: savAppTicketsMode(),
    pass: cursor ? { status: cursor.status, lastError: cursor.lastError, completedAt: cursor.completedAt?.toISOString() ?? null,
      after: state ? new Date(state.after).toISOString() : null, floor: state ? new Date(state.floor).toISOString() : null } : null,
    counts: Object.fromEntries(counts.map(row => [row.status, Number(row.total)])),
    tickets: rows.map(row => {
      const detail = parse(detailSchema, row.cursor);
      return { ticketId: row.key.slice(prefix.length), decision: row.status, attempts: row.processedCount, lastError: row.lastError,
        sourceType: detail?.sourceType ?? null, categoryGated: detail?.categoryGated ?? null, entry: detail?.entry ?? null,
        createdAt: detail?.createdAt ? new Date(detail.createdAt).toISOString() : null, decidedAt: row.updatedAt.toISOString() };
    }),
  };
}
