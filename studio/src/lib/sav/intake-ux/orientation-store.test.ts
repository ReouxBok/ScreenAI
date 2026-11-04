import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savMailboxes, savThreads, savMessages, savSyncState, staffUsers, savIntakeRuns, savIntakeHumanEvents } from "@/db/schema";
const fixture = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!fixture.db) throw Error("DB_FORBIDDEN"); return fixture.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => fixture.user }));
import { encryptSavPayload, decryptSavPayload } from "@/lib/sav/crypto";
import { planSavIntake } from "@/lib/sav/intake/engine";
import { savIntakeSourceSnapshot } from "@/lib/sav/intake/runtime-store";
import { intakeRuntimeHash, SAV_INTAKE_RUNTIME_REVISION } from "@/lib/sav/intake/runtime-contract";
import type { IntakeAdapters } from "@/lib/sav/intake/engine-types";
import { recordUxOrientation, readUxOrientationReceipt } from "./orientation-server";
import type { Orientation } from "./orientation";
import { readUxMessageControls } from "./message-controls";
import { canAccessSav } from "@/lib/sav/access";
let db: Awaited<ReturnType<typeof createSavTestDb>>, command: Orientation, actorId: string, actor: typeof staffUsers.$inferSelect;
// The native CI step runs several suites in one database: this file creates and removes only its own rows (mailbox and its
// cascade, human events of its threads and the audit rows of those events, staff it created), never other suites' staff, policies,
// mailboxes or audit rows.
// SAV access is limited to three addresses (canAccessSav) and staff emails are unique, so an operator is either a staff row this
// file creates (admin, as before) or an existing one that already passes the same check, adopted unchanged; never a new role.
const SAV_OPERATOR_EMAILS = ["ugo@limova.ai", "reouven@limova.ai", "contact@limova.ai"];
const own = { staff: [] as string[], mailboxes: [] as string[], threads: [] as string[], events: [] as string[] };
// Audit rows of a human event are keyed by the event id (human-commands: entityType sav_intake_human_event), not by the thread.
const HUMAN_EVENT_AUDIT = "sav_intake_human_event";
let foreignAuditsBefore: (typeof auditLogs.$inferSelect)[];
async function syntheticOperator(name: string, exclude: string[] = []) {
  for (const email of SAV_OPERATOR_EMAILS.filter(candidate => !exclude.includes(candidate))) {
    const [created] = await db.db.insert(staffUsers).values({ clerkId: `ux-orientation-${randomUUID()}`, email, name, role: "admin", active: true }).onConflictDoNothing().returning();
    if (created) { own.staff.push(created.id); return created; }
    const [existing] = await db.db.select().from(staffUsers).where(eq(staffUsers.email, email));
    if (existing?.active && canAccessSav(existing.email, existing.role)) return existing;
  }
  throw Error("SYNTHETIC_OPERATOR_UNAVAILABLE");
}
const clerkUser = (staff: typeof staffUsers.$inferSelect) => ({ id: staff.clerkId, primaryEmailAddress: { emailAddress: staff.email, verification: { status: "verified" } } });
/** This file's human events only: the shared database may hold other suites' rows. */
const ownEvents = () => db.db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.threadId, command.threadId));
beforeAll(async () => {
  db = await createSavTestDb(); fixture.db = db.db;
  foreignAuditsBefore = await db.db.select().from(auditLogs);
  actor = await syntheticOperator("Synthetic operator"); actorId = actor.id;
}, 30000);
afterEach(async () => {
  // Own rows, in foreign-key order: human events and audit rows carry no foreign key; the mailbox cascades to its threads, messages and runs.
  // The event ids are read before the events are deleted, so their audit rows stay reachable.
  if (own.threads.length) {
    const events = (await db.db.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents).where(inArray(savIntakeHumanEvents.threadId, own.threads))).map(row => row.id);
    own.events.push(...events);
    if (events.length) await db.db.delete(auditLogs).where(and(eq(auditLogs.entityType, HUMAN_EVENT_AUDIT), inArray(auditLogs.entityId, events)));
    await db.db.delete(savIntakeHumanEvents).where(inArray(savIntakeHumanEvents.threadId, own.threads));
  }
  if (own.mailboxes.length) await db.db.delete(savMailboxes).where(inArray(savMailboxes.id, own.mailboxes));
  own.threads = []; own.mailboxes = [];
});
afterAll(async () => {
  if (!db) return;
  try {
    if (own.staff.length) await db.db.delete(staffUsers).where(inArray(staffUsers.id, own.staff));
    // No own audit row is left, and every audit row present before this file is still there, unchanged.
    if (own.events.length) expect(await db.db.select().from(auditLogs).where(and(eq(auditLogs.entityType, HUMAN_EVENT_AUDIT), inArray(auditLogs.entityId, own.events)))).toEqual([]);
    const byId = (rows: (typeof auditLogs.$inferSelect)[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    if (foreignAuditsBefore.length) expect(byId(await db.db.select().from(auditLogs).where(inArray(auditLogs.id, foreignAuditsBefore.map(row => row.id))))).toEqual(byId(foreignAuditsBefore));
  } finally { await db.client.close(); }
});
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-ux-encryption-key-32-characters");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  await db.db.insert(savSyncState).values({ key: "sav-intake-console-schema-v1", status: "installed" }).onConflictDoNothing();
  fixture.user = clerkUser(actor);
  const [mailbox] = await db.db.insert(savMailboxes).values({ email: `ux-orientation-${randomUUID()}@example.invalid` }).returning(); own.mailboxes.push(mailbox.id);
  const [thread] = await db.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: randomUUID(), customerEmail: "customer@example.invalid" }).returning(); own.threads.push(thread.id);
  expect(await db.db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.threadId, thread.id))).toHaveLength(0);
  const [message] = await db.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, direction: "inbound", gmailMessageId: randomUUID(),
    fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic access problem", receivedAt: new Date(),
    bodyCiphertext: encryptSavPayload({ text: "My synthetic login fails.", headers: {}, attachments: [] }) }).returning();
  const snapshot = await db.db.transaction(tx => savIntakeSourceSnapshot(tx, message, new Date()));
  const at = snapshot.input.now;
  const complete = <T,>(data: T) => ({ status: "complete" as const, data, observedAt: at });
  const adapters: IntakeAdapters = {
    analyseMessage: async () => ({ messageId: message.id, requests: [{ id: "request", kind: "support", currentMessageId: message.id }] }),
    findContactsByEmail: async () => complete(["101", "102"].map(id => ({ id, emails: ["customer@example.invalid"] }))),
    directAssociations: async () => complete([]), getContact: async id => complete({ id, emails: ["customer@example.invalid"] }),
    ticketsForContact: async () => complete([{ id: "201", contactIds: ["101", "102"], stage: "new", ownerId: null,
      subject: "Synthetic access problem", content: "Synthetic login fails.", createdAt: new Date(Date.now() - 60_000).toISOString() }]),
    ticketHistory: async () => complete([]), assessIssues: async () => ({ investigationComplete: false, tickets: [] }),
    assessIdentity: async ({ evidence }) => ({ kind: "equivalent", investigationComplete: true, contactIds: ["101", "102"], evidenceIds: evidence.map(e => e.id) }),
  };
  const plan = await planSavIntake(snapshot.input, adapters, { relationRevision: "synthetic", admittedRelations: [], resources: {} });
  const [run] = await db.db.insert(savIntakeRuns).values({ threadId: thread.id, messageId: message.id, version: 1, configHash: "c".repeat(64), policyHash: "d".repeat(64),
    state: "waiting", sourceHash: snapshot.sourceHash, payloadCiphertext: encryptSavPayload({ revision: SAV_INTAKE_RUNTIME_REVISION, input: snapshot.input, plan, effects: "not_connected",
      configuration: { configHash: "c".repeat(64), resourcesHash: "e".repeat(64), policyHash: "d".repeat(64), codeRevision: "a".repeat(40), model: "gemini-synthetic" } }) }).returning();
  command = { commandKey: randomUUID(), threadId: thread.id, messageId: message.id, runId: run.id, version: 1, sourceHash: snapshot.sourceHash,
    candidatesHash: intakeRuntimeHash(["101", "102"]), intent: "orient", classification: "finance", contactId: "102", ticketId: "201", reason: "Synthetic verified account and billing context." };
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("persists category/contact/ticket atomically in one canonical immutable event, with actor/date/message/version", async () => {
  const result = await recordUxOrientation(command);
  const rows = await ownEvents();
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: result.eventId, kind: "classify", messageId: command.messageId, parentVersion: 1, state: "pending" });
  expect(decryptSavPayload(rows[0].payloadCiphertext)).toMatchObject({ actor: { id: actorId }, contactId: "102", ticketId: "201", classification: "finance", reason: command.reason });
  expect(await readUxOrientationReceipt(commandBinding())).toMatchObject({ eventId: result.eventId, state: "pending", parentVersion: 1 });
  expect(fetch).not.toHaveBeenCalled();
});
const commandBinding = () => ({ commandKey: command.commandKey, threadId: command.threadId, messageId: command.messageId });
it("retains the same event on repeated requests and after its original run has become stale", async () => {
  const first = await recordUxOrientation(command);
  await db.db.update(savIntakeHumanEvents).set({ state: "consumed" }).where(eq(savIntakeHumanEvents.id, first.eventId));
  await db.db.update(savIntakeRuns).set({ isCurrent: false, state: "superseded" }).where(eq(savIntakeRuns.id, command.runId));
  expect(await recordUxOrientation(command)).toEqual(first);
  await expect(recordUxOrientation({ ...command, classification: "other" })).rejects.toThrow();
  expect(await ownEvents()).toHaveLength(1);
});
it("two tabs with different request keys cannot enqueue two choices for one version", async () => {
  await recordUxOrientation(command);
  await expect(recordUxOrientation({ ...command, commandKey: randomUUID() })).rejects.toThrow();
  expect(await ownEvents()).toHaveLength(1);
});
it.each(["contact", "ticket", "source", "message", "run", "candidate_hash", "paused", "unauthorized"])("rejects forged/stale %s before any provider call", async scenario => {
  const value = { ...command };
  if (scenario === "contact") value.contactId = "999";
  if (scenario === "ticket") value.ticketId = "999";
  if (scenario === "source") value.sourceHash = "f".repeat(64);
  if (scenario === "message") value.messageId = randomUUID();
  if (scenario === "run") value.runId = randomUUID();
  if (scenario === "candidate_hash") value.candidatesHash = "f".repeat(64);
  if (scenario === "paused") await db.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, command.threadId));
  if (scenario === "unauthorized") fixture.user = null;
  await expect(recordUxOrientation(value)).rejects.toThrow();
  expect(await ownEvents()).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
});
it("does not disclose another operator's receipt", async () => {
  await recordUxOrientation(command);
  const other = await syntheticOperator("Other synthetic operator", [actor.email]);
  expect(other.id).not.toBe(actorId);
  fixture.user = clerkUser(other);
  expect(await readUxOrientationReceipt(commandBinding())).toBeNull();
});
it("old message choices do not disable a new inbound's analysis controls", async () => {
  await recordUxOrientation(command);
  const [oldMessage] = await db.db.select().from(savMessages).where(eq(savMessages.id, command.messageId));
  const [newMessage] = await db.db.insert(savMessages).values({ mailboxId: oldMessage.mailboxId, threadId: command.threadId, direction: "inbound", gmailMessageId: randomUUID(),
    fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject: "New synthetic request", receivedAt: new Date(Date.now() + 1000), bodyCiphertext: encryptSavPayload({ text: "New request", attachments: [] }) }).returning();
  expect(await readUxMessageControls(command.threadId, command.messageId)).toMatchObject({ blocked: true });
  expect(await readUxMessageControls(command.threadId, newMessage.id)).toEqual({ blocked: false });
});
it("shows an active run lease as a protected analysis state", async () => {
  await db.db.update(savIntakeRuns).set({ leaseUntil: new Date(Date.now()+60_000) }).where(eq(savIntakeRuns.id,command.runId));
  expect(await readUxMessageControls(command.threadId,command.messageId)).toMatchObject({blocked:true,reason:expect.stringContaining("traitement détient")});
});
it("concurrent tabs admit only one conditional event under the canonical transaction",async()=>{
  const results=await Promise.allSettled([recordUxOrientation(command),recordUxOrientation({...command,commandKey:randomUUID()})]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(await ownEvents()).toHaveLength(1);expect(fetch).not.toHaveBeenCalled();
});
