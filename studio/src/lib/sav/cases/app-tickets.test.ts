import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState } from "@/db/schema";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { APP_TICKET_DEFAULT_SUBJECT, appTicketCategoryGated, appTicketReplySubject, savAppTicketsMode, savAppTicketsSourceTypes } from "./app-tickets-config";
import {
  APP_TICKET_ROW_PREFIX, APP_TICKETS_ENTRY_MARGIN_MS, APP_TICKETS_MAX_ATTEMPTS, APP_TICKETS_MAX_PAGES, APP_TICKETS_MAX_TICKETS, appTicketRowKey, appTicketsCursorKey,
  appTicketsSearchBody, readSavAppTicketsReport, reconcileSavAppTickets, type AppTicketRead, type AppTicketsDeps,
} from "./app-tickets";
import type { ThreadlessEntryResult } from "./threadless-entry";

const fixture = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => fixture.db }));

/*
 * SAV-138 (Ugo 25/11): tickets created from the Limova app. FICTIONAL HubSpot: tickets live in memory, every port is a spy; no network (fetch throws).
 */
const OWNER = "7001", HUMAN = "7002", APP_SOURCE = "FORM";
const { billing, cancellation, technical, other } = SAV_HUBSPOT_SUPPORT.categories;
let database: Awaited<ReturnType<typeof createSavTestDb>>;
let nextTicket = Date.now() * 100;

type Ticket = Partial<Omit<AppTicketRead, "id">> & { id: string; createdAt: number };
const ticket = (extra: Partial<Ticket> = {}): Ticket => ({ id: String(++nextTicket), createdAt: Date.now() - 60_000, ...extra });

function hubspot(tickets: Ticket[], options: { fullPages?: boolean } = {}) {
  const searches: unknown[] = [];
  const search = vi.fn(async (body: unknown) => {
    searches.push(body);
    const from = Number((body as { filterGroups: { filters: { propertyName: string; value?: string }[] }[] }).filterGroups[0]!.filters
      .find(filter => filter.propertyName === "createdate")!.value);
    const rows = tickets.filter(row => !row.ownerId && row.createdAt >= from).map(row => ({ id: row.id, properties: {
      hubspot_owner_id: null, hs_pipeline: "0", hs_pipeline_stage: "1", createdate: new Date(row.createdAt).toISOString() } }));
    return options.fullPages ? { results: rows.slice(0, 100), paging: { next: { after: String(searches.length * 100) } } } : { results: rows };
  });
  const readTicket = vi.fn(async (id: string): Promise<AppTicketRead> => {
    const row = tickets.find(item => item.id === id);
    if (!row) throw Error("synthetic 404");
    return { id, archived: row.archived ?? false, ownerId: row.ownerId ?? null, pipeline: row.pipeline ?? "0", stage: row.stage ?? "1",
      categories: row.categories ?? "", sourceType: row.sourceType === undefined ? APP_SOURCE : row.sourceType, hasEmail: row.hasEmail ?? false };
  });
  const assign = vi.fn(async (id: string, owner: string) => { tickets.find(item => item.id === id)!.ownerId = owner; });
  const enter = vi.fn(async (input: { ticketId: string }): Promise<ThreadlessEntryResult> => ({ status: "human_wait", caseId: crypto.randomUUID(), reason: `team:${input.ticketId}` }));
  const handBack = vi.fn<(input: unknown, reason: string) => Promise<ThreadlessEntryResult>>(async () => ({ status: "human_wait", caseId: crypto.randomUUID(), reason: "app_ticket_entry_unavailable" }));
  const entryAvailable = vi.fn(async () => true);
  const deps: AppTicketsDeps = { search, readTicket, assign, enter, handBack, entryAvailable, deadlineMs: Date.now() + 240_000 };
  return { deps, search, readTicket, assign, enter, handBack, entryAvailable, searches };
}

const row = async (mode: "shadow" | "live", id: string) =>
  (await database.db.select().from(savSyncState).where(eq(savSyncState.key, appTicketRowKey(mode, id))))[0] ?? null;
const allRows = () => database.db.select().from(savSyncState).where(like(savSyncState.key, "sav-app-ticket%"));

beforeAll(async () => {
  database = await createSavTestDb();
  fixture.db = database.db;
}, 60_000);
beforeEach(() => {
  for (const [key, value] of Object.entries({ VERCEL_ENV: "production", SAV_APP_TICKETS_MODE: "shadow", SAV_V2_HUBSPOT_OWNER_ID: OWNER,
    SAV_APP_TICKETS_SOURCE_TYPES: APP_SOURCE, HUBSPOT_ACCESS_TOKEN: "synthetic-token", SAV_V2_ENTRY_SMART: "on" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("Unexpected external call"); }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await database.db.delete(savSyncState).where(like(savSyncState.key, "sav-app-ticket%"));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => { await database.client.close(); });

describe("configuration", () => {
  it("is off unless production and exactly shadow or live", () => {
    expect(savAppTicketsMode({ VERCEL_ENV: "production" })).toBe("off");
    for (const value of ["", "on", "LIVE", "true", "auto"]) expect(savAppTicketsMode({ VERCEL_ENV: "production", SAV_APP_TICKETS_MODE: value })).toBe("off");
    expect(savAppTicketsMode({ VERCEL_ENV: "preview", SAV_APP_TICKETS_MODE: "live" })).toBe("off");
    expect(savAppTicketsMode({ VERCEL_ENV: "production", SAV_APP_TICKETS_MODE: "shadow" })).toBe("shadow");
    expect(savAppTicketsMode({ VERCEL_ENV: "production", SAV_APP_TICKETS_MODE: "live" })).toBe("live");
  });
  it("gates exactly the billing and cancellation categories, alone or in a multi-select", () => {
    expect(billing).toBe("Facturation"); expect(cancellation).toBe("Résiliation");
    for (const value of [billing, cancellation, `${technical};${billing}`, ` ${other} ; ${cancellation} `]) expect(appTicketCategoryGated(value)).toBe(true);
    for (const value of [technical, other, SAV_HUBSPOT_SUPPORT.categories.feedback, SAV_HUBSPOT_SUPPORT.categories.access, "", null, "facturation"])
      expect(appTicketCategoryGated(value)).toBe(false);
  });
  it("never accepts EMAIL (V1's tickets) as an app source type", () => {
    expect(savAppTicketsSourceTypes({ SAV_APP_TICKETS_SOURCE_TYPES: " FORM , EMAIL,CHAT,bad value,FORM" })).toEqual(["FORM", "CHAT"]);
  });
  it("excludes V1's EMAIL tickets in the HubSpot search itself", () => {
    expect(appTicketsSearchBody(0).filterGroups[0]!.filters).toContainEqual({ propertyName: "source_type", operator: "NEQ", value: "EMAIL" });
  });
  it("cuts the first mail's subject at 200 UTF-16 units between characters, never inside an emoji", () => {
    const subject = appTicketReplySubject(`${"a".repeat(199)}😀 suite`);
    expect(subject).toBe("a".repeat(199));
    expect(subject).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(appTicketReplySubject(`Re: ${"é".repeat(198)}😀`)).toBe(`${"é".repeat(198)}😀`);
    expect(appTicketReplySubject(" \u0000 ")).toBe(APP_TICKET_DEFAULT_SUBJECT);
  });
});

describe("off", () => {
  it("does not touch the database at all", async () => {
    vi.stubEnv("SAV_APP_TICKETS_MODE", "");
    const real = fixture.db, touched = vi.fn();
    fixture.db = new Proxy({}, { get: (_target, property) => { touched(property); throw Error("DB_TOUCHED"); } });
    try {
      const crm = hubspot([ticket()]);
      expect(await reconcileSavAppTickets(crm.deps)).toEqual({ skipped: "off" });
      expect(touched).not.toHaveBeenCalled();
    } finally { fixture.db = real; }
  });
  it("is wired in the reconcile pass behind its switch only: off loads no module and runs no step", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../reconcile-pass.ts"), "utf8");
    const call = source.slice(source.indexOf("const appTickets ="), source.indexOf("const emailOpenings ="));
    expect(call).toMatch(/^const appTickets = savAppTicketsMode\(\) !== "off" \? await runStep<[^]*?>\("v2_app_tickets", async \(\) =>/);
    expect(call.trimEnd()).toMatch(/\) : undefined;$/);
    expect(call.match(/import\("@\/lib\/sav\/cases\/app-tickets"\)/g)).toHaveLength(2);
    expect(source.match(/cases\/app-tickets"/g)).toHaveLength(2);
  });
  it.each([["absent", { SAV_APP_TICKETS_MODE: "" }], ["another value", { SAV_APP_TICKETS_MODE: "on" }], ["outside production", { VERCEL_ENV: "preview" }]])(
    "with the switch %s: no HubSpot call, no row", async (_label, env) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const crm = hubspot([ticket()]);
      expect(await reconcileSavAppTickets(crm.deps)).toEqual({ skipped: "off" });
      expect(crm.search).not.toHaveBeenCalled(); expect(crm.readTicket).not.toHaveBeenCalled();
      expect(await allRows()).toEqual([]);
    });
});

describe("shadow", () => {
  it("records what it would do and changes nothing: no owner change, no entry, no hand-back", async () => {
    const take = ticket(), bill = ticket({ categories: billing }), cancel = ticket({ categories: `${technical};${cancellation}` });
    const mail = ticket({ hasEmail: true }), v1 = ticket({ sourceType: "EMAIL" }), unknownSource = ticket({ sourceType: "CHAT", categories: other });
    const crm = hubspot([take, bill, cancel, mail, v1, unknownSource]);
    const result = await reconcileSavAppTickets(crm.deps);
    expect(result).toMatchObject({ mode: "shadow", status: "ok", found: 6, decided: { would_take: 2, team_category: 2, ignored_has_email: 1, ignored_email_source: 1 } });
    expect(crm.assign).not.toHaveBeenCalled(); expect(crm.enter).not.toHaveBeenCalled(); expect(crm.handBack).not.toHaveBeenCalled();
    expect(crm.entryAvailable).not.toHaveBeenCalled();
    expect((await row("shadow", take.id))?.status).toBe("would_take");
    expect(JSON.parse((await row("shadow", unknownSource.id))!.cursor!)).toMatchObject({ sourceType: "CHAT", categoryGated: false });
    expect(JSON.parse((await row("shadow", bill.id))!.cursor!)).toMatchObject({ categoryGated: true });
    // Nothing for live: a shadow decision never takes a ticket later.
    expect(await row("live", take.id)).toBeNull();
    // A second pass reads none of them again.
    crm.readTicket.mockClear();
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ decided: {} });
    expect(crm.readTicket).not.toHaveBeenCalled();
  });
  it("is readable in the admin report, without any ticket content", async () => {
    const take = ticket(), bill = ticket({ categories: billing });
    await reconcileSavAppTickets(hubspot([take, bill]).deps);
    const report = await readSavAppTicketsReport({ mode: "shadow", limit: 50 });
    expect(report.counts).toEqual({ would_take: 1, team_category: 1 });
    expect(report.pass).toMatchObject({ status: "idle" });
    expect(report.tickets.map(item => [item.ticketId, item.decision, item.sourceType]).sort()).toEqual([[bill.id, "team_category", APP_SOURCE], [take.id, "would_take", APP_SOURCE]].sort());
  });
});

describe("live", () => {
  beforeEach(() => { vi.stubEnv("SAV_APP_TICKETS_MODE", "live"); });

  it("does nothing, not even a search, without the app's source types", async () => {
    vi.stubEnv("SAV_APP_TICKETS_SOURCE_TYPES", "");
    const crm = hubspot([ticket()]);
    expect(await reconcileSavAppTickets(crm.deps)).toEqual({ skipped: "source_types_unconfigured" });
    expect(crm.search).not.toHaveBeenCalled();
  });

  it("assigns an app ticket to the Agent SAV once and hands it to the threadless entry, also on replay", async () => {
    const take = ticket({ categories: technical });
    const crm = hubspot([take]);
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ mode: "live", decided: { taken: 1 } });
    expect(crm.assign).toHaveBeenCalledExactlyOnceWith(take.id, OWNER);
    expect(crm.enter).toHaveBeenCalledTimes(1);
    const input = crm.enter.mock.calls[0]![0] as { ticketId: string; ownerTransitionKey: string; observedAt: string };
    expect(input.ticketId).toBe(take.id);
    expect(input.ownerTransitionKey).toMatch(new RegExp(`^hubspot-app-ticket:${take.id}:\\d+:${OWNER}$`));
    expect(Date.parse(input.observedAt)).toBeLessThanOrEqual(Date.now());
    // The entry's guards are read BEFORE the owner changes.
    expect(crm.entryAvailable.mock.invocationCallOrder[0]!).toBeLessThan(crm.assign.mock.invocationCallOrder[0]!);
    expect(await row("live", take.id)).toMatchObject({ status: "taken" });
    // Back in the team's hands (no owner), the ticket is found again by the search: it is never taken twice.
    take.ownerId = null;
    await reconcileSavAppTickets(crm.deps);
    await reconcileSavAppTickets(crm.deps);
    expect(crm.assign).toHaveBeenCalledTimes(1); expect(crm.enter).toHaveBeenCalledTimes(1);
  });

  it("takes a ticket once when two passes run at the same time: the second one, started during the first one's assignment, is refused", async () => {
    const take = ticket(), later = ticket();
    const crm = hubspot([take, later]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let assigning!: () => void;
    const started = new Promise<void>(resolve => { assigning = resolve; });
    crm.assign.mockImplementationOnce(async (id: string, owner: string) => { assigning(); await gate; take.ownerId = owner; void id; });
    const first = reconcileSavAppTickets(crm.deps);
    await started;
    // The first pass holds the lease and is inside its HubSpot assignment: a concurrent pass decides nothing.
    expect(await reconcileSavAppTickets(crm.deps)).toEqual({ skipped: "leased" });
    release();
    expect(await first).toMatchObject({ mode: "live", decided: { taken: 1 } });
    expect(crm.assign).toHaveBeenCalledExactlyOnceWith(take.id, OWNER);
    expect(crm.enter).toHaveBeenCalledTimes(1);
  });

  it("assigns nothing while the smart entry is off: the ticket waits, unassigned (the smart brain writes an app ticket's first mail)", async () => {
    vi.stubEnv("SAV_V2_ENTRY_SMART", "off");
    const take = ticket();
    const crm = hubspot([take]);
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ decided: { waiting: 1 } });
    expect(crm.assign).not.toHaveBeenCalled(); expect(crm.enter).not.toHaveBeenCalled();
    expect(take.ownerId).toBeUndefined();
    expect(await row("live", take.id)).toMatchObject({ status: "waiting", lastError: "entry_unavailable" });
  });

  it("enters at most one ticket per pass (one model call), the others at the next passes, never skipped", async () => {
    const tickets = [ticket(), ticket(), ticket()];
    const crm = hubspot(tickets);
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ status: "partial", decided: { taken: 1, deferred: 1 } });
    expect(crm.assign).toHaveBeenCalledTimes(1); expect(crm.enter).toHaveBeenCalledTimes(1);
    await reconcileSavAppTickets(crm.deps);
    await reconcileSavAppTickets(crm.deps);
    expect(crm.enter).toHaveBeenCalledTimes(3);
    expect(new Set(crm.assign.mock.calls.map(call => call[0]))).toEqual(new Set(tickets.map(item => item.id)));
  });

  it("neither assigns nor enters without 100 s left before the deadline; the ticket is taken at a later pass", async () => {
    const take = ticket();
    const crm = hubspot([take]);
    expect(await reconcileSavAppTickets({ ...crm.deps, deadlineMs: Date.now() + APP_TICKETS_ENTRY_MARGIN_MS - 10_000 })).toMatchObject({ decided: { deferred: 1 } });
    expect(crm.assign).not.toHaveBeenCalled(); expect(crm.enter).not.toHaveBeenCalled();
    expect(await row("live", take.id)).toBeNull();
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ decided: { taken: 1 } });
    expect(crm.assign).toHaveBeenCalledTimes(1);
  });

  it("switched from live to shadow: a ticket left assigned is handed back to the team once, and shows in the report", async () => {
    const take = ticket();
    const crm = hubspot([take]);
    crm.enter.mockResolvedValue({ status: "unavailable" });
    await reconcileSavAppTickets(crm.deps);
    expect(await row("live", take.id)).toMatchObject({ status: "assigned" });
    vi.stubEnv("SAV_APP_TICKETS_MODE", "shadow");
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ released: 1 });
    expect(crm.handBack).toHaveBeenCalledTimes(1);
    expect(crm.handBack.mock.calls[0]![1]).toBe("app_ticket_mode_shadow");
    expect(await row("live", take.id)).toMatchObject({ status: "handed_back" });
    await reconcileSavAppTickets(crm.deps);
    expect(crm.handBack).toHaveBeenCalledTimes(1);
    expect(crm.enter).toHaveBeenCalledTimes(1);
    const report = await readSavAppTicketsReport({ mode: "live", limit: 10 });
    expect(report.tickets).toContainEqual(expect.objectContaining({ ticketId: take.id, decision: "handed_back", entry: "mode_shadow>human_wait" }));
  });

  it.each(["paused", "unavailable", "off"] as const)("V2 %s while live is switched to shadow: the row is tried again at the next pass, never failed", async status => {
    const take = ticket();
    const crm = hubspot([take]);
    crm.enter.mockResolvedValue({ status: "unavailable" });
    await reconcileSavAppTickets(crm.deps);
    vi.stubEnv("SAV_APP_TICKETS_MODE", "shadow");
    crm.handBack.mockResolvedValueOnce({ status });
    expect(await reconcileSavAppTickets(crm.deps)).not.toHaveProperty("released");
    expect(await row("live", take.id)).toMatchObject({ status: "assigned" });
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ released: 1 });
    expect(crm.handBack).toHaveBeenCalledTimes(2);
    expect(await row("live", take.id)).toMatchObject({ status: "handed_back" });
  });

  it("switched from live straight to off: strictly nothing (the exit procedure goes through shadow first)", async () => {
    const take = ticket();
    const crm = hubspot([take]);
    crm.enter.mockResolvedValue({ status: "unavailable" });
    await reconcileSavAppTickets(crm.deps);
    vi.stubEnv("SAV_APP_TICKETS_MODE", "");
    expect(await reconcileSavAppTickets(crm.deps)).toEqual({ skipped: "off" });
    expect(crm.handBack).not.toHaveBeenCalled();
    expect(await row("live", take.id)).toMatchObject({ status: "assigned" });
  });

  it("off with no live row left: no HubSpot call, nothing written", async () => {
    vi.stubEnv("SAV_APP_TICKETS_MODE", "");
    const crm = hubspot([ticket()]);
    expect(await reconcileSavAppTickets(crm.deps)).toEqual({ skipped: "off" });
    for (const port of [crm.search, crm.readTicket, crm.assign, crm.enter, crm.handBack]) expect(port).not.toHaveBeenCalled();
    expect(await allRows()).toEqual([]);
  });

  it("our own assignment on a ticket that turned billing meanwhile: handed back to the team once, never entered", async () => {
    const take = ticket();
    const crm = hubspot([take]);
    crm.assign.mockImplementationOnce(async (id: string, owner: string) => { take.ownerId = owner; throw Error(`synthetic timeout ${id}`); });
    await reconcileSavAppTickets(crm.deps);
    take.categories = billing;
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ retried: 1, decided: { handed_back: 1 } });
    expect(crm.handBack).toHaveBeenCalledTimes(1);
    expect(crm.handBack.mock.calls[0]![1]).toBe("app_ticket_team_category");
    expect(crm.enter).not.toHaveBeenCalled();
  });

  it("never touches a billing or cancellation ticket: no owner change, no entry (no model), no hand-back (no Slack, no mail)", async () => {
    const bill = ticket({ categories: billing }), cancel = ticket({ categories: `${other};${cancellation}` });
    const crm = hubspot([bill, cancel]);
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ decided: { team_category: 2 } });
    for (const port of [crm.assign, crm.enter, crm.handBack, crm.entryAvailable]) expect(port).not.toHaveBeenCalled();
    expect(bill.ownerId).toBeUndefined();
  });

  it("leaves tickets that are not app tickets: a mail thread, an owner, V1's EMAIL source, another source, another stage", async () => {
    const mail = ticket({ hasEmail: true }), v1 = ticket({ sourceType: "EMAIL" }), chat = ticket({ sourceType: "CHAT" }), moved = ticket({ stage: "3" });
    const owned = ticket();
    const crm = hubspot([mail, v1, chat, moved, owned]);
    // Owned by a person between the search and the fresh read.
    crm.readTicket.mockImplementation(async (id: string) => {
      const item = [mail, v1, chat, moved, owned].find(entry => entry.id === id)!;
      return { id, archived: false, ownerId: id === owned.id ? HUMAN : null, pipeline: "0", stage: item.stage ?? "1", categories: "",
        sourceType: item.sourceType ?? APP_SOURCE, hasEmail: item.hasEmail ?? false };
    });
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ decided: { ignored_has_email: 1, ignored_email_source: 1, ignored_source: 1, ignored_not_new: 1, ignored_owned: 1 } });
    expect(crm.assign).not.toHaveBeenCalled(); expect(crm.enter).not.toHaveBeenCalled();
  });

  it("assigns nothing while the entry cannot take a ticket, and takes it once it can", async () => {
    const take = ticket();
    const crm = hubspot([take]);
    crm.entryAvailable.mockResolvedValue(false);
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ decided: { waiting: 1 } });
    expect(crm.assign).not.toHaveBeenCalled();
    crm.entryAvailable.mockResolvedValue(true);
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ retried: 1, decided: { taken: 1 } });
    expect(crm.assign).toHaveBeenCalledTimes(1);
  });

  it("after a lost assignment answer, enters once the owner reads as the agent, without assigning again", async () => {
    const take = ticket();
    const crm = hubspot([take]);
    crm.assign.mockImplementationOnce(async (id: string, owner: string) => { take.ownerId = owner; throw Error(`synthetic timeout ${id}`); });
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ decided: { assigning: 1 } });
    expect(crm.enter).not.toHaveBeenCalled();
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ retried: 1, decided: { taken: 1 } });
    expect(crm.assign).toHaveBeenCalledTimes(1); expect(crm.enter).toHaveBeenCalledTimes(1);
  });

  it("gives an assigned ticket back to the team, once, when the entry keeps failing", async () => {
    const take = ticket();
    const crm = hubspot([take]);
    crm.enter.mockResolvedValue({ status: "unavailable" });
    for (let pass = 0; pass < APP_TICKETS_MAX_ATTEMPTS + 2; pass++) await reconcileSavAppTickets(crm.deps);
    expect(crm.enter).toHaveBeenCalledTimes(APP_TICKETS_MAX_ATTEMPTS);
    expect(crm.handBack).toHaveBeenCalledTimes(1);
    expect(crm.handBack.mock.calls[0]![1]).toBe("app_ticket_entry_unavailable");
    expect(await row("live", take.id)).toMatchObject({ status: "handed_back" });
    expect(crm.assign).toHaveBeenCalledTimes(1);
  });

  it("shadow reads at most two search pages and decides at most the per-pass bound, then resumes from the cursor", async () => {
    vi.stubEnv("SAV_APP_TICKETS_MODE", "shadow");
    const base = Date.now() - 30 * 60_000;
    const tickets = Array.from({ length: 250 }, (_, index) => ticket({ createdAt: base + index * 1_000 }));
    const crm = hubspot(tickets, { fullPages: true });
    const first = await reconcileSavAppTickets(crm.deps);
    expect(crm.search).toHaveBeenCalledTimes(APP_TICKETS_MAX_PAGES);
    expect(first).toMatchObject({ status: "partial", decided: { would_take: APP_TICKETS_MAX_TICKETS } });
    expect(crm.readTicket).toHaveBeenCalledTimes(APP_TICKETS_MAX_TICKETS);
    const [cursor] = await database.db.select().from(savSyncState).where(eq(savSyncState.key, appTicketsCursorKey("shadow")));
    expect(JSON.parse(cursor!.cursor!).after).toBe(tickets[APP_TICKETS_MAX_TICKETS - 1]!.createdAt);
    await reconcileSavAppTickets(crm.deps);
    expect(crm.readTicket).toHaveBeenCalledTimes(2 * APP_TICKETS_MAX_TICKETS);
    expect(new Set(crm.readTicket.mock.calls.map(call => call[0])).size).toBe(2 * APP_TICKETS_MAX_TICKETS);
    expect(crm.assign).not.toHaveBeenCalled();
  });

  it("never looks before its own floor: tickets older than the lookback are not searched", async () => {
    const old = ticket({ createdAt: Date.now() - 3 * 3_600_000 }), fresh = ticket();
    const crm = hubspot([old, fresh]);
    expect(await reconcileSavAppTickets(crm.deps)).toMatchObject({ found: 1, decided: { taken: 1 } });
    expect(crm.assign).toHaveBeenCalledExactlyOnceWith(fresh.id, OWNER);
    expect((await allRows()).map(item => item.key).filter(key => key.startsWith(APP_TICKET_ROW_PREFIX))).toEqual([`${APP_TICKET_ROW_PREFIX}live:${fresh.id}`]);
  });
});
