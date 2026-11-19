import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeExecutionPolicies, savMailboxes, savSyncState, savWebhookReceipts, staffUsers } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import type { ExecutionPolicy } from "../intake/execution-policy";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { sweepDueOwnerHandovers } from "./owner-handover";
import { OWNER_HANDOVER_DELAY_MS, ownerHandoverMarkerKey, type OwnerHandoverTransition } from "./owner-handover-markers";
import { OWNER_HANDOVER_POLL_KEY, OWNER_HANDOVER_POLL_MAX_TICKET_FAILURES, OWNER_HANDOVER_POLL_OVERLAP_MS, ownerHandoverPollSeenKey, pollSavOwnerHandovers } from "./owner-handover-poll";

const fixture = vi.hoisted(() => ({
  db: null as unknown,
  start: vi.fn<(_workflow: unknown, args: [OwnerHandoverTransition, string]) => Promise<unknown>>(),
  threadless: vi.fn(),
}));
vi.mock("@/db", () => ({ requireDb: () => fixture.db }));
vi.mock("workflow/api", () => ({ start: fixture.start }));
vi.mock("./threadless-entry", async original => {
  const { startV2FromThreadlessTicket } = await original<typeof import("./threadless-entry")>();
  return { startV2FromThreadlessTicket: fixture.threadless.mockImplementation(startV2FromThreadlessTicket) };
});

const MAILBOX = "contact@limova.ai", OWNER = "7001", HUMAN = "7002", CODE_REVISION = "a".repeat(40);
const ACCESS = SAV_HUBSPOT_SUPPORT.categories.access;
const SETTLED = Date.now() - OWNER_HANDOVER_DELAY_MS - 1_000;
const CREATED_LONG_AGO = "2025-01-15T09:00:00.000Z";

let database: Awaited<ReturnType<typeof createSavTestDb>>;
let policyId: string, policyHash: string;
let nextTicket = Date.now() * 100;
const testTickets = new Set<string>();

type Ticket = { id: string; owner?: string; modifiedAt?: number; changedAt?: number; source?: string; archived?: boolean; stage?: string; category?: string; unreadable?: boolean | number };

/** A fictional HubSpot: one bounded search and the owner-history read. Any other call fails the test. */
function hubspot(tickets: Ticket[], options: { searchFails?: boolean } = {}) {
  for (const ticket of tickets) testTickets.add(ticket.id);
  const searches: unknown[] = [], reads: string[] = [];
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    const request = new globalThis.URL(url);
    if (request.pathname === "/crm/v3/objects/tickets/search") {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { filterGroups: { filters: { propertyName: string; value: string }[] }[] };
      searches.push(body);
      if (options.searchFails) return Response.json({ message: "synthetic" }, { status: 400 });
      const from = Number(body.filterGroups[0]!.filters.find(filter => filter.propertyName === "hs_lastmodifieddate")!.value);
      const results = tickets.filter(ticket => (ticket.owner ?? OWNER) === OWNER && (ticket.modifiedAt ?? SETTLED) >= from)
        .map(ticket => ({ id: ticket.id, properties: { hubspot_owner_id: ticket.owner ?? OWNER, hs_pipeline: "0",
          hs_lastmodifieddate: new Date(ticket.modifiedAt ?? SETTLED).toISOString(), createdate: CREATED_LONG_AGO } }));
      return Response.json({ total: results.length, results });
    }
    const ticket = tickets.find(row => request.pathname === `/crm/v3/objects/tickets/${row.id}`);
    expect(ticket, `unexpected HubSpot call ${request.pathname}`).toBeDefined();
    expect(init?.method ?? "GET").toBe("GET");
    expect(request.searchParams.get("propertiesWithHistory")).toBe("hubspot_owner_id");
    reads.push(ticket!.id);
    if (ticket!.unreadable) return Response.json({ message: "synthetic" }, { status: ticket!.unreadable === true ? 404 : ticket!.unreadable });
    const owner = ticket!.owner ?? OWNER;
    return Response.json({
      id: ticket!.id, archived: ticket!.archived ?? false,
      properties: { hubspot_owner_id: owner, hs_pipeline: "0", hs_pipeline_stage: ticket!.stage ?? "1", hs_ticket_category: ticket!.category ?? ACCESS },
      propertiesWithHistory: { hubspot_owner_id: [
        { timestamp: CREATED_LONG_AGO, sourceType: "CRM_UI", value: HUMAN },
        { timestamp: new Date(ticket!.changedAt ?? SETTLED).toISOString(), sourceType: ticket!.source ?? "CRM_UI", value: owner },
      ] },
    });
  });
  vi.stubGlobal("fetch", network);
  return { network, searches, reads };
}

const ticket = (extra: Omit<Ticket, "id"> = {}): Ticket => ({ id: String(++nextTicket), ...extra });
const poll = () => pollSavOwnerHandovers({ deadlineMs: Date.now() + 240_000 });
const cursor = async () => {
  const [row] = await database.db.select().from(savSyncState).where(eq(savSyncState.key, OWNER_HANDOVER_POLL_KEY));
  return row ? { ...row, state: JSON.parse(row.cursor!) as { after: number; floor: number; complete: boolean } } : null;
};

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-owner-handover-fixture-key-32");
  database = await createSavTestDb();
  fixture.db = database.db;
  const [mailbox] = await database.db.insert(savMailboxes).values({ email: MAILBOX }).returning();
  const [administrator] = await database.db.insert(staffUsers).values({ clerkId: "synthetic-poll-admin", email: MAILBOX, role: "admin" }).returning();
  const policy: ExecutionPolicy = {
    revision: "sav-intake-execution-2026-10-21.v1", mailboxId: mailbox!.id, codeRevision: CODE_REVISION, enginePolicyHash: "e".repeat(64),
    resourcesHash: "f".repeat(64), receivedAfter: "2026-01-01T00:00:00Z", createdAfter: "2026-01-01T00:00:00Z",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxDossiers: 1, mutations: ["start_case_owner_handover", "send_case_reply"], admission: { kind: "automatic" },
  };
  policyHash = intakeRuntimeHash(policy);
  const [row] = await database.db.insert(savIntakeExecutionPolicies).values({
    revision: policy.revision, administratorId: administrator!.id, state: "approved", policyHash, payloadCiphertext: encryptSavPayload(policy),
  }).returning();
  policyId = row!.id;
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  fixture.start.mockResolvedValue({});
  const env = {
    VERCEL_ENV: "production", SAV_CASE_RECORDING: "on", SAV_V2_ENTRY: "on", SAV_V2_OWNER_HANDOVER: "on", SAV_V2_OWNER_HANDOVER_POLL: "on",
    SAV_V2_HUBSPOT_OWNER_ID: OWNER, SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash,
    VERCEL_GIT_COMMIT_SHA: CODE_REVISION, HUBSPOT_ACCESS_TOKEN: "synthetic-token", SAV_ENCRYPTION_KEY_V1: "synthetic-owner-handover-fixture-key-32",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("Unexpected external call"); }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await database.db.delete(savSyncState).where(inArray(savSyncState.key, [OWNER_HANDOVER_POLL_KEY, ...[...testTickets].flatMap(id => [ownerHandoverMarkerKey(id), ownerHandoverPollSeenKey(id)])]));
  testTickets.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => { await database.client.close(); });

describe("SAV-96 repair: the reconcile pass reads HubSpot instead of waiting for a webhook", () => {
  it.each([
    ["the poll switch absent", { SAV_V2_OWNER_HANDOVER_POLL: "" }],
    ["the poll switch at any other value", { SAV_V2_OWNER_HANDOVER_POLL: "shadow" }],
    ["the handover itself off", { SAV_V2_OWNER_HANDOVER: "" }],
    ["outside production", { VERCEL_ENV: "preview" }],
  ])("makes no HubSpot call and writes nothing with %s", async (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { network } = hubspot([ticket()]);
    await expect(poll()).resolves.toEqual({ skipped: "off" });
    expect(network).not.toHaveBeenCalled();
    expect(await cursor()).toBeNull();
  });

  it("is wired in the shared reconcile pass only behind its switch, with no new route or cron", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(dir, "../reconcile-pass.ts"), "utf8");
    expect(source).toMatch(/savV2OwnerHandoverPollEnabled\(\) \? await runStep<[^]*?>\("v2_owner_handover_poll"/);
    expect(source).toMatch(/\.\.\.\(ownerHandoverPoll \? \{ ownerHandoverPoll \} : \{\}\)/);
    // The poll runs before the due-marker sweep, so a transition already older than the delay is taken in the same pass.
    expect(source.indexOf("v2_owner_handover_poll")).toBeLessThan(source.indexOf("v2_owner_handovers"));
  });

  it("starts SAV-96 for a ticket a person assigned to the agent, with no webhook, whatever its creation date", async () => {
    const assigned = ticket();
    const { searches, reads } = hubspot([assigned]);
    await expect(poll()).resolves.toMatchObject({ status: "ok", found: 1, read: 1, observed: 1 });
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({
      filterGroups: [{ filters: [
        { propertyName: "hs_pipeline", operator: "EQ", value: "0" },
        { propertyName: "hubspot_owner_id", operator: "EQ", value: OWNER },
        { propertyName: "hs_lastmodifieddate", operator: "GTE" },
      ] }],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }], limit: 100,
    });
    expect(reads).toEqual([assigned.id]);
    const transition = { ticketId: assigned.id, ownerTransitionKey: `hubspot-owner:${assigned.id}:${SETTLED}:${OWNER}`, observedAt: new Date(SETTLED).toISOString() };
    expect(fixture.start).toHaveBeenCalledExactlyOnceWith(expect.any(Function), [transition, new Date(SETTLED + OWNER_HANDOVER_DELAY_MS).toISOString()]);
    // The same claim and guards as a webhook: the due-marker sweep runs the handover (here up to the threadless entry, itself off).
    await expect(sweepDueOwnerHandovers(Date.now() + 240_000)).resolves.toEqual({ off: 1 });
    expect(fixture.threadless).toHaveBeenCalledExactlyOnceWith(transition);
    expect(await database.db.select().from(savWebhookReceipts)).toEqual([]);
  });

  it("is idempotent: the same ticket seen by two passes is one marker, one wake and one handover, and is not read again", async () => {
    const assigned = ticket();
    const { searches, reads } = hubspot([assigned]);
    await poll();
    const second = await poll();
    expect(second).toMatchObject({ status: "ok", found: 1, read: 0, seen: 1, observed: 0 });
    expect(searches).toHaveLength(2);
    expect(reads).toEqual([assigned.id]);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    await sweepDueOwnerHandovers(Date.now() + 240_000);
    await sweepDueOwnerHandovers(Date.now() + 240_000);
    await poll();
    expect(fixture.threadless).toHaveBeenCalledTimes(1);
    const markers = await database.db.select().from(savSyncState).where(eq(savSyncState.key, ownerHandoverMarkerKey(assigned.id)));
    expect(markers).toEqual([expect.objectContaining({ status: "complete", processedCount: 1 })]);
  });

  it("re-reads a ticket modified after its observation, and a repeated owner change is still one handover", async () => {
    const assigned = ticket();
    const tickets = [assigned];
    hubspot(tickets);
    await poll();
    await sweepDueOwnerHandovers(Date.now() + 240_000);
    // A later note or stage change on the same ticket: read once more, same owner transition, nothing new.
    assigned.modifiedAt = Date.now() + 1_000;
    const { reads } = hubspot(tickets);
    await expect(poll()).resolves.toMatchObject({ read: 1, observed: 1 });
    expect(reads).toEqual([assigned.id]);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    await sweepDueOwnerHandovers(Date.now() + 240_000);
    expect(fixture.threadless).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an assignment by an integration or a workflow", { source: "INTEGRATION" }],
    ["an assignment by the API (V1's own owner_assign)", { source: "API" }],
    ["an archived ticket", { archived: true }],
  ])("starts nothing for %s", async (_label, extra) => {
    hubspot([ticket(extra)]);
    await poll();
    expect(fixture.start).not.toHaveBeenCalled();
    await expect(sweepDueOwnerHandovers(Date.now() + 240_000)).resolves.toEqual({});
    expect(fixture.threadless).not.toHaveBeenCalled();
  });

  it("never replays an owner change older than the poll's floor (first run minus the lookback), even on a recently modified ticket", async () => {
    vi.stubEnv("SAV_V2_OWNER_HANDOVER_POLL_LOOKBACK_HOURS", "1");
    const old = ticket({ changedAt: Date.now() - 2 * 3_600_000 });
    hubspot([old]);
    await expect(poll()).resolves.toMatchObject({ read: 1, beforeFloor: 1, observed: 0 });
    expect(fixture.start).not.toHaveBeenCalled();
    const state = (await cursor())!.state;
    expect(Date.now() - state.floor).toBeGreaterThanOrEqual(3_600_000);
    expect(Date.now() - state.floor).toBeLessThan(3_600_000 + 60_000);
  });

  it("keeps the existing guards: a person taking the ticket back before the wake stops the handover", async () => {
    const assigned = ticket();
    const tickets = [assigned];
    hubspot(tickets);
    await poll();
    assigned.owner = HUMAN;
    await expect(sweepDueOwnerHandovers(Date.now() + 240_000)).resolves.toEqual({ owner_changed: 1 });
    expect(fixture.threadless).not.toHaveBeenCalled();
  });

  it("takes a reassignment made during the previous wake, without a webhook (Astra 19/11, point 1)", async () => {
    const first = Date.now() - 3 * OWNER_HANDOVER_DELAY_MS, second = Date.now() - OWNER_HANDOVER_DELAY_MS - 1_000;
    const assigned = ticket({ changedAt: first, modifiedAt: first });
    const tickets = [assigned];
    hubspot(tickets);
    await poll();
    expect(fixture.start).toHaveBeenCalledTimes(1);
    // A person takes the ticket and gives it back to the agent while the first wake runs: the wake sees a different transition and stops,
    // and its end rewrites the marker's updatedAt after the reassignment.
    assigned.changedAt = second;
    assigned.modifiedAt = second;
    await expect(sweepDueOwnerHandovers(Date.now() + 240_000)).resolves.toEqual({ owner_transition_changed: 1 });
    const [marker] = await database.db.select().from(savSyncState).where(eq(savSyncState.key, ownerHandoverMarkerKey(assigned.id)));
    expect(marker!.updatedAt.getTime()).toBeGreaterThan(second);
    const { reads } = hubspot(tickets);
    await expect(poll()).resolves.toMatchObject({ read: 1, observed: 1 });
    expect(reads).toEqual([assigned.id]);
    const transition = { ticketId: assigned.id, ownerTransitionKey: `hubspot-owner:${assigned.id}:${second}:${OWNER}`, observedAt: new Date(second).toISOString() };
    expect(fixture.start).toHaveBeenCalledTimes(2);
    expect(fixture.start.mock.lastCall![1][0]).toEqual(transition);
    await expect(sweepDueOwnerHandovers(Date.now() + 240_000)).resolves.toEqual({ off: 1 });
    expect(fixture.threadless).toHaveBeenCalledExactlyOnceWith(transition);
    expect(await database.db.select().from(savWebhookReceipts)).toEqual([]);
  });

  it("isolates a ticket whose history stays unreadable: the next one is taken, the bad one is skipped visibly after a bounded number of tries (point 2)", async () => {
    const base = Date.now() - 600_000;
    const bad = ticket({ modifiedAt: base, unreadable: true }), good = ticket({ modifiedAt: base + 1_000 });
    hubspot([bad, good]);
    await expect(poll()).resolves.toMatchObject({ status: "partial", read: 1, failed: 1, observed: 1 });
    expect(fixture.start).toHaveBeenCalledExactlyOnceWith(expect.any(Function), [expect.objectContaining({ ticketId: good.id }), expect.any(String)]);
    // The cursor waits on the failing ticket only; the good one is not read again.
    expect((await cursor())!.state).toMatchObject({ after: base, complete: false });
    for (let pass = 2; pass < OWNER_HANDOVER_POLL_MAX_TICKET_FAILURES; pass++) {
      const { reads } = hubspot([bad, good]);
      await expect(poll()).resolves.toMatchObject({ read: 0, seen: 1, failed: 1 });
      expect(reads).toEqual([bad.id]);
    }
    const [row] = await database.db.select().from(savSyncState).where(eq(savSyncState.key, ownerHandoverPollSeenKey(bad.id)));
    expect(row).toMatchObject({ status: "failing", processedCount: OWNER_HANDOVER_POLL_MAX_TICKET_FAILURES - 1, lastError: "owner_history_read_failed" });
    await expect(poll()).resolves.toMatchObject({ status: "ok", read: 0, skipped: 1, failed: 0 });
    const [skipped] = await database.db.select().from(savSyncState).where(eq(savSyncState.key, ownerHandoverPollSeenKey(bad.id)));
    expect(skipped).toMatchObject({ status: "skipped", processedCount: OWNER_HANDOVER_POLL_MAX_TICKET_FAILURES, lastError: "owner_history_read_failed" });
    expect(console.warn).toHaveBeenCalledWith("sav_v2_owner_handover_poll", { status: "ticket_skipped", ticketId: bad.id, failures: OWNER_HANDOVER_POLL_MAX_TICKET_FAILURES });
    expect((await cursor())!.state).toMatchObject({ after: base + 1_000, complete: true });
    const { reads } = hubspot([bad, good]);
    await poll();
    expect(reads).toEqual([]);
    expect(fixture.start).toHaveBeenCalledTimes(1);
  });

  it("never counts a transient failure: a ticket in 503 during passes where others succeed waits, then is taken once HubSpot recovers (Astra contre-revue)", async () => {
    const base = Date.now() - 600_000;
    const waiting = ticket({ modifiedAt: base, unreadable: 503 });
    const others: Ticket[] = [];
    for (let pass = 0; pass < OWNER_HANDOVER_POLL_MAX_TICKET_FAILURES + 1; pass++) {
      others.push(ticket({ modifiedAt: base + 1_000 * (pass + 1), source: "INTEGRATION" }));
      hubspot([waiting, ...others]);
      await expect(poll()).resolves.toMatchObject({ read: 1, failed: 1, skipped: 0 });
    }
    const [row] = await database.db.select().from(savSyncState).where(eq(savSyncState.key, ownerHandoverPollSeenKey(waiting.id)));
    expect(row).toMatchObject({ status: "waiting", processedCount: 0, cursor: null, lastError: "owner_history_read_transient" });
    expect((await cursor())!.state).toMatchObject({ after: base, complete: false });
    expect(fixture.start).not.toHaveBeenCalled();
    // HubSpot recovers; the ticket itself has not changed since.
    waiting.unreadable = undefined;
    const { reads } = hubspot([waiting, ...others]);
    await expect(poll()).resolves.toMatchObject({ status: "ok", read: 1, observed: 1, failed: 0 });
    expect(reads).toEqual([waiting.id]);
    await poll();
    expect(fixture.start).toHaveBeenCalledTimes(1);
    await expect(sweepDueOwnerHandovers(Date.now() + 240_000)).resolves.toEqual({ off: 1 });
    expect(fixture.threadless).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ticketId: waiting.id }));
  });

  it("keeps waiting through a full HubSpot outage (every read failing with 503), never skipping, and keeps the cursor", async () => {
    const base = Date.now() - 600_000;
    const tickets = [ticket({ modifiedAt: base, unreadable: 503 }), ticket({ modifiedAt: base + 1_000, unreadable: 503 })];
    for (let pass = 0; pass < OWNER_HANDOVER_POLL_MAX_TICKET_FAILURES + 1; pass++) {
      hubspot(tickets);
      await expect(poll()).resolves.toMatchObject({ read: 0, failed: 2, skipped: 0 });
    }
    const rows = await database.db.select().from(savSyncState).where(inArray(savSyncState.key, tickets.map(row => ownerHandoverPollSeenKey(row.id))));
    expect(rows.map(row => [row.status, row.processedCount, row.cursor])).toEqual([["waiting", 0, null], ["waiting", 0, null]]);
    expect((await cursor())!.state).toMatchObject({ after: base, complete: false });
  });

  it("keeps the cursor on a failed search, and records why", async () => {
    hubspot([ticket()], { searchFails: true });
    await expect(poll()).resolves.toMatchObject({ status: "search_failed", found: 0 });
    const row = (await cursor())!;
    expect(row).toMatchObject({ status: "failed", lastError: "owner_handover_poll_search_failed" });
    expect(row.state.after).toBe(row.state.floor);
    expect(row.state.complete).toBe(false);
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("bounds the reads per pass and resumes exactly where it stopped, then looks back only by the overlap", async () => {
    const base = Date.now() - 600_000;
    const many = Array.from({ length: 30 }, (_, index) => ticket({ modifiedAt: base + index * 1000, source: "INTEGRATION" }));
    const { reads, searches } = hubspot(many);
    await expect(poll()).resolves.toMatchObject({ status: "partial", found: 30, read: 25 });
    expect((await cursor())!.state).toMatchObject({ after: base + 24_000, complete: false });
    await expect(poll()).resolves.toMatchObject({ status: "ok", found: 6, read: 5, seen: 1 });
    expect(reads).toHaveLength(30);
    expect(new Set(reads).size).toBe(30);
    expect((await cursor())!.state).toMatchObject({ after: base + 29_000, complete: true });
    await poll();
    const from = (searches.at(-1) as { filterGroups: { filters: { propertyName: string; value: string }[] }[] }).filterGroups[0]!.filters[2]!.value;
    expect(Number(from)).toBe(base + 29_000 - OWNER_HANDOVER_POLL_OVERLAP_MS);
    expect(reads).toHaveLength(30);
  });

  it("runs one poll at a time across the cron and its fallback", async () => {
    hubspot([ticket()]);
    await database.db.insert(savSyncState).values({ key: OWNER_HANDOVER_POLL_KEY, status: "running", updatedAt: new Date(), cursor: null });
    await expect(poll()).resolves.toEqual({ skipped: "leased" });
    expect(fetch).not.toHaveBeenCalled();
    // A lease older than its bound (a crashed pass) is taken over.
    await database.db.update(savSyncState).set({ updatedAt: new Date(Date.now() - 300_000) }).where(eq(savSyncState.key, OWNER_HANDOVER_POLL_KEY));
    await expect(poll()).resolves.toMatchObject({ status: "ok", observed: 1 });
    expect((await cursor())!.status).toBe("idle");
  });
});
