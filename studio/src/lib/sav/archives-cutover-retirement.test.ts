import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";

// SAV-60 x SAV-9 (pole C, synthetic rows only). The archive list is filtered by the V0 cutover row (`savV0EligibleMessageFilter`). The UX lot
// found that, with that row inactive or absent, the list is empty without saying why. Question asked here: does retiring the V0 commands, or
// pausing the SAV agents, change that row? Answer pinned below: no code path writes it after its one-time activation, and none of the retirement
// or pause paths touches it. The historical restriction (cutover mailbox, received after the boundary) is pinned too: it must survive any fix.
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; }, getDb: () => state.db, isDatabaseConfigured: () => true }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { auditLogs, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { encryptSavPayload } from "./crypto";
import { getSavV0Cutover, isSavMessageEligible } from "./cutover";
import { setSavAgentPause } from "./intake/agent-pause-admin";
import { confirmSavSuggestedReply, queueSavManualReply } from "./manual-replies";
import { queueSavManualTicket } from "./manual-tickets";
import { approveSavDraft, correctSavDecision, listSavInbox, requestHumanIntervention, retrySavAction } from "./service";
import { enqueueSavContextRefresh, processPendingSavContextRefreshes } from "./dispatch";
import { SAV_LEGACY_COMMAND_RETIRED } from "./v0-command-retirement";

const CUTOVER_KEY = "sav-v0-cutover";
const UUID = "00000000-0000-4000-8000-000000000001";
const staff = "operateur@example.test";
const cutover = (status: string) => ({ key: CUTOVER_KEY, status, cursor: JSON.stringify({ receivedAfter: "2026-01-01T00:00:00.000Z", mailboxEmail: "sav@example.com",
  intakeRecipient: "contact@limova.ai", deploymentSha: "0".repeat(40), activatedBy: "ugo@limova.ai" }) });

let f: Awaited<ReturnType<typeof createSavTestDb>>;
let subjects: Record<string, string>;
const row = async () => (await f.client.query<Record<string, unknown>>("select key, status, cursor, started_at, updated_at from sav.sync_state where key = $1", [CUTOVER_KEY])).rows;
const listed = async () => (await listSavInbox(51, { offset: 0 })).map(entry => entry.subject);

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { await f?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  await f.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs; TRUNCATE staff_users CASCADE");
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
  state.user = { id: admin!.clerkId, primaryEmailAddress: { emailAddress: admin!.email, verification: { status: "verified" } } };
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "sav@example.com" }).returning();
  const [other] = await f.db.insert(savMailboxes).values({ email: "autre@example.com" }).returning();
  subjects = { after: "Après la bascule", before: "Avant la bascule", other: "Autre boîte" };
  for (const [box, subject, receivedAt] of [[mailbox, subjects.after!, new Date("2026-06-01T10:00:00Z")], [mailbox, subjects.before!, new Date("2025-12-01T10:00:00Z")], [other, subjects.other!, new Date("2026-06-01T10:00:00Z")]] as const) {
    const [thread] = await f.db.insert(savThreads).values({ mailboxId: box!.id, gmailThreadId: `g-${subject}`, customerEmail: "client@example.test", subject }).returning();
    await f.db.insert(savMessages).values({ mailboxId: box!.id, threadId: thread!.id, direction: "inbound", fromEmail: "client@example.test", subject,
      bodyCiphertext: encryptSavPayload({ text: "Question synthétique" }), receivedAt, processedAt: receivedAt, analysisStatus: "done" });
  }
});

describe("the historical restriction of the archive list (to keep whatever the fix)", () => {
  it("active: only the cutover mailbox, only after the boundary", async () => {
    await f.db.insert(savSyncState).values(cutover("active"));
    expect(await listed()).toEqual([subjects.after]);
    expect(await getSavV0Cutover()).toMatchObject({ mailboxEmail: "sav@example.com", receivedAfter: "2026-01-01T00:00:00.000Z" });
  });

  for (const label of ["disabled", "absent"]) it(`${label}: the three stored dossiers are not listed, and the cutover reader says so by returning null`, async () => {
    if (label !== "absent") await f.db.insert(savSyncState).values(cutover(label));
    expect(await listed()).toEqual([]);
    expect(await getSavV0Cutover()).toBeNull();
    const stored = await f.client.query("select count(*)::int as n from sav.messages");
    expect(stored.rows[0]).toEqual({ n: 3 });
  });
});

describe("retiring the V0 commands and pausing the agents do not change the cutover row", () => {
  it("every refused command, the delayed redispatch and a full pause leave the row, the list and the other stores untouched", async () => {
    await f.db.insert(savSyncState).values(cutover("active"));
    const [first] = await row(), counts = async () => (await f.client.query(
      "select (select count(*)::int from sav.actions) actions, (select count(*)::int from sav.messages) messages, (select count(*)::int from sav.threads) threads").then(r => r.rows[0]));
    const before = { rows: await row(), list: await listed(), counts: await counts() };
    const calls: [string, () => Promise<unknown>][] = [
      ["queueSavManualReply", () => queueSavManualReply({ threadId: UUID }, staff)],
      ["confirmSavSuggestedReply", () => confirmSavSuggestedReply({ threadId: UUID }, staff)],
      ["requestHumanIntervention", () => requestHumanIntervention(UUID, staff, "raison valable")],
      ["correctSavDecision", () => correctSavDecision(UUID, {}, staff)],
      ["queueSavManualTicket", () => queueSavManualTicket({ threadId: UUID, reviewId: UUID, kind: "create_ticket" }, staff)],
      ["enqueueSavContextRefresh", () => enqueueSavContextRefresh(UUID, staff)],
      ["approveSavDraft", () => approveSavDraft(UUID, staff)],
      ["retrySavAction", () => retrySavAction(UUID, staff)],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow(SAV_LEGACY_COMMAND_RETIRED);
    expect(await processPendingSavContextRefreshes(5)).toEqual({ dispatched: 0, retired: true });
    for (const level of ["actions_paused", "fully_paused", "running"] as const) await setSavAgentPause({ agent: "intake", level, reason: "synthetic pause check" });
    expect(await row()).toEqual(before.rows);
    expect(first).toMatchObject({ key: CUTOVER_KEY, status: "active" });
    expect(await listed()).toEqual(before.list);
    expect(await counts()).toEqual(before.counts);
    // The pause wrote its own key and its own audit line, nothing else in the synchronisation table.
    const keys = (await f.client.query<{ key: string }>("select key from sav.sync_state order by key")).rows.map(entry => entry.key);
    expect(keys).toEqual([CUTOVER_KEY, "sav-agent-pause.v1:intake"].sort());
    expect((await f.db.select().from(auditLogs)).map(entry => entry.action).sort()).toEqual(["sav_agent_pause_set", "sav_agent_pause_set", "sav_agent_pause_set"]);
    expect(await isSavMessageEligible((await f.db.select().from(savMessages))[0]!.id)).toBeTypeOf("boolean");
  });
});

describe("nothing in the source writes the cutover row after its activation", () => {
  const SRC = join(__dirname, "..", "..");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "node_modules" ? [] : walk(path)) : [path];
  });
  const production = () => walk(SRC).filter(path => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));

  it("only cutover.ts names the key to write it (insert, never update or delete); the dashboard projection only reads it", () => {
    const naming = production().filter(path => /sav-v0-cutover|SAV_V0_CUTOVER_KEY/.test(readFileSync(path, "utf8"))).map(path => relative(SRC, path)).sort();
    expect(naming).toEqual(["lib/sav/cutover.ts", "lib/sav/dashboard-projection.ts"]);
    const text = readFileSync(join(SRC, "lib/sav/cutover.ts"), "utf8");
    const writes = [...text.matchAll(/\.(insert|update|delete)\(savSyncState\)/g)].map(match => match[1]);
    expect(writes).toEqual(["insert"]); // the one-time activation (immutable: re-activating the same boundary reads, a different one throws); no update, no delete
    expect(readFileSync(join(SRC, "lib/sav/dashboard-projection.ts"), "utf8")).not.toMatch(/(update|delete|insert)[^;]*sync_state/i);
  });

  it("every other writer of the synchronisation table uses a key of its own, which cannot be the cutover key", () => {
    const keys = [/gmail-v0-recovery:\$\{/, /sav-agent-pause/];
    const gmail = readFileSync(join(SRC, "lib/sav/gmail.ts"), "utf8"), pause = readFileSync(join(SRC, "lib/sav/intake/agent-pause.ts"), "utf8");
    expect(keys[0]!.test(gmail)).toBe(true);
    expect(keys[1]!.test(pause)).toBe(true);
    expect(CUTOVER_KEY).not.toMatch(/^(gmail-v0-recovery:|sav-agent-pause)/);
  });
});
