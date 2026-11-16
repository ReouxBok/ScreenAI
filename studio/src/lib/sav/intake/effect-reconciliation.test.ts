import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savIntakeConsole, savIntakeEffectJournal, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns,
  savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { intakeRuntimeHash } from "./runtime-contract";
import { createIntakeExecutorAdapters, renderIntakeNote } from "./execution-adapters";
import { reconcileIntakeUncertainEffect } from "./effect-reconciliation";
import type { EffectAck, EffectIntent, ExecutorAdapters } from "./execution-types";

/** SAV-92: an operator reconciles ONE uncertain V1 effect from its stored receipt, read-only. Synthetic data only. */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
let threadId: string, messageId: string, runId: string, executionId: string;
const ticketId = "201", noteId = "301", emailId = "401", dispatchedAt = new Date("2026-11-15T10:00:00Z");
const noteProps = { hs_note_body: renderIntakeNote("Synthetic note.", "a".repeat(64)), hs_timestamp: "2026-11-15T09:59:00.000Z" };
const emailProps = { hs_timestamp: "2026-11-15T09:58:00.000Z", hs_email_direction: "INCOMING_EMAIL", hs_email_subject: "Synthetic subject", hs_email_text: "Synthetic body." };
type Verify = ExecutorAdapters["verify"];
const proven = (id: string): Verify => vi.fn(async () => ({ confirmed: true, attributed: true, ack: { id } }));
const intents = {
  note_create: (): EffectIntent => ({ kind: "note_create", permission: "append_ticket_note", key: `note:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, text: "Synthetic note.", marker: "a".repeat(64), properties: noteProps }),
  note_associate: (createId: string, objectId = noteId): EffectIntent => ({ kind: "note_associate", permission: "append_ticket_note", key: `note-association:${messageId}:${ticketId}`, ticketId, objectId,
    sourceMessageId: messageId, expectedProperties: noteProps, confirmedNoteCreate: { effectId: createId, objectId } }),
  email_create: (): EffectIntent => ({ kind: "email_create", permission: "associate_email", key: `email:${messageId}`, ticketId, sourceMessageId: messageId, marker: "b".repeat(64), properties: emailProps }),
  email_associate: (): EffectIntent => ({ kind: "email_associate", permission: "associate_email", key: `email-association:${messageId}:${ticketId}`, ticketId, objectId: emailId, sourceMessageId: messageId, expectedProperties: emailProps }),
  stage_new: (): EffectIntent => ({ kind: "stage_new", permission: "set_ticket_new", key: `stage-new:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId }),
};
async function effect(intent: EffectIntent, state: string, ack: EffectAck | null, extra: Partial<typeof savIntakeEffects.$inferInsert> = {}) {
  return (await f.db.insert(savIntakeEffects).values({ executionId, businessKey: intent.key, kind: intent.kind, permission: intent.permission, state,
    intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), dispatchedAt, ackCiphertext: ack ? encryptSavPayload(ack) : null,
    ...(state === "confirmed" ? { confirmedAt: dispatchedAt, verificationCiphertext: encryptSavPayload({ confirmed: true, attributed: true, ack }) } : {}), ...extra }).returning())[0];
}
/** Case 1: note created and confirmed, its association uncertain after 5 reads (attempts kept). */
async function noteAssociationCase(createAck = noteId) {
  const create = await effect(intents.note_create(), "confirmed", { id: createAck });
  return effect(intents.note_associate(create.id), "uncertain", null, { reconcileAttempts: 5 });
}
const dump = async () => ({ effects: await f.db.select().from(savIntakeEffects).orderBy(savIntakeEffects.id), executions: await f.db.select().from(savIntakeExecutions),
  journal: (await f.db.select().from(savIntakeEffectJournal)).length, audits: (await f.db.select().from(auditLogs)).length });
const run = (verify: Verify, raw: unknown = { threadId, messageId }, expected?: Parameters<typeof reconcileIntakeUncertainEffect>[1]) =>
  reconcileIntakeUncertainEffect(raw, expected, { verify });

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 120000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-effect-reconciliation-key-32-chars");
  await f.client.exec("TRUNCATE sav.intake_effect_journal, sav.intake_effects, sav.intake_executions, sav.intake_execution_policies, sav.intake_runs, sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; DELETE FROM sav.sync_state");
  await f.db.insert(savSyncState).values({ key: "sav-intake-console-schema-v1", status: "installed" });
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "ugo@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
  state.user = { id: admin.clerkId, primaryEmailAddress: { emailAddress: admin.email, verification: { status: "verified" } } };
  const mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: "gmail-thread", customerEmail: "customer@example.invalid" }).returning())[0].id;
  messageId = (await f.db.insert(savMessages).values({ threadId, mailboxId, direction: "inbound", gmailMessageId: randomUUID(), fromEmail: "customer@example.invalid",
    toEmails: ["support@example.invalid"], subject: "Synthetic subject", bodyCiphertext: encryptSavPayload({ text: "Synthetic body.", attachments: [] }), receivedAt: dispatchedAt }).returning())[0].id;
  runId = (await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: 1, state: "observed", configHash: "c", policyHash: "p", sourceHash: "s".repeat(64),
    payloadCiphertext: encryptSavPayload({}) }).returning())[0].id;
  const policyId = (await f.db.insert(savIntakeExecutionPolicies).values({ revision: "r", state: "approved", administratorId: admin.id, policyHash: "p", payloadCiphertext: encryptSavPayload({}) }).returning())[0].id;
  executionId = (await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runId, runVersion: 1, policyId, policyHash: "p", state: "uncertain", ticketId,
    payloadCiphertext: encryptSavPayload({ reason: "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED" }) }).returning())[0].id;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("note_associate proven from the stored note id is confirmed; attempts, execution state and leases are left as they were", async () => {
  const association = await noteAssociationCase();
  const verify = proven(noteId);
  expect(await run(verify)).toEqual({ reconciled: true, kind: "note_associate", objectId: noteId });
  // verify got the STORED intent (object id from the confirmed creation's receipt) and the stored (absent) ack.
  expect(verify).toHaveBeenCalledTimes(1);
  const [intent, ack, at] = (verify as ReturnType<typeof vi.fn>).mock.calls[0];
  expect({ kind: intent.kind, objectId: intent.objectId, ack, at }).toEqual({ kind: "note_associate", objectId: noteId, ack: null, at: dispatchedAt });
  const [row] = await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, association.id));
  expect({ state: row.state, attempts: row.reconcileAttempts, ack: decryptSavPayload<EffectAck>(row.ackCiphertext!).id }).toEqual({ state: "confirmed", attempts: 5, ack: noteId });
  const [execution] = await f.db.select().from(savIntakeExecutions);
  expect({ state: execution.state, leaseToken: execution.leaseToken, leaseUntil: execution.leaseUntil }).toEqual({ state: "uncertain", leaseToken: null, leaseUntil: null });
  expect((await f.db.select().from(auditLogs)).map(a => [a.action, a.technicalMetadata.dispatch, a.technicalMetadata.receipt]))
    .toEqual([["sav_intake_effect_reconciled_from_receipt", false, "stored_object_id"]]);
  // Idempotent: a second call finds nothing unsettled and writes nothing.
  const before = await dump();
  expect(await run(verify)).toEqual({ reconciled: false, alreadyConfirmed: true });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(await dump()).toEqual(before);
});

it.each([
  ["not attributed", { confirmed: true, attributed: false, ack: { id: noteId } }],
  ["not confirmed", { confirmed: false, attributed: false }],
  ["another object", { confirmed: true, attributed: true, ack: { id: "999" } }],
])("a verification %s refuses and changes nothing", async (_label, proof) => {
  await noteAssociationCase();
  const before = await dump();
  await expect(run(vi.fn(async () => proof))).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_NOT_PROVEN");
  expect(await dump()).toEqual(before);
});

it("email_create without a stored provider receipt is refused before any read (an older exact email proves nothing)", async () => {
  await effect(intents.note_create(), "confirmed", { id: noteId });
  await effect(intents.email_create(), "uncertain", null);
  const before = await dump(), verify = proven(emailId);
  await expect(run(verify)).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_ACK_MISSING");
  // An operator-selected candidate is not a provider receipt either.
  await f.db.update(savIntakeEffects).set({ ackCiphertext: encryptSavPayload({ id: emailId, operatorCandidate: true }) }).where(eq(savIntakeEffects.kind, "email_create"));
  await expect(run(verify)).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_ACK_NOT_PROVIDER");
  expect(verify).not.toHaveBeenCalled();
  expect((await dump()).audits).toBe(before.audits);
});

it("email_create with its stored provider receipt is verified on that receipt only", async () => {
  await effect(intents.email_create(), "acked", { id: emailId });
  const verify = proven(emailId);
  expect(await run(verify)).toMatchObject({ reconciled: true, kind: "email_create", objectId: emailId });
  expect((verify as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ id: emailId });
});

it("email_associate is refused when the stored email is not found associated (no proof of effect, none of non-effect)", async () => {
  await effect(intents.email_create(), "confirmed", { id: emailId });
  await effect(intents.email_associate(), "uncertain", null);
  const before = await dump();
  await expect(run(vi.fn(async () => ({ confirmed: false, attributed: false, ack: { id: emailId } })))).rejects.toThrow("NOT_PROVEN");
  expect(await dump()).toEqual(before);
});

it.each([
  ["a creation receipt that does not match the stored object", async () => { await noteAssociationCase("302"); }, "DEPENDENCY_UNCONFIRMED"],
  ["a final ticket not yet confirmed", async () => {
    await f.db.update(savIntakeExecutions).set({ ticketId: null });
    await effect(intents.note_create(), "uncertain", { id: noteId });
  }, "DEPENDENCY_UNCONFIRMED"],
  ["two unsettled effects", async () => {
    await effect(intents.note_create(), "uncertain", { id: noteId });
    await effect(intents.email_create(), "uncertain", { id: emailId });
  }, "MULTIPLE_UNSETTLED"],
  ["a ticket state, which proves no authorship", async () => { await effect(intents.stage_new(), "uncertain", { id: ticketId }); }, "KIND_UNSUPPORTED"],
  ["a planned effect never dispatched", async () => { await effect(intents.note_create(), "planned", null, { dispatchedAt: null }); }, "NOT_DISPATCHED"],
])("refuses %s without reading HubSpot", async (_label, arrange, code) => {
  await arrange();
  const before = await dump(), verify = proven(noteId);
  await expect(run(verify)).rejects.toThrow(`SAV_INTAKE_EFFECT_RECONCILIATION_${code}`);
  expect(verify).not.toHaveBeenCalled();
  expect(await dump()).toEqual(before);
});

it.each([
  ["a thread pause or human hold", async () => { await f.db.update(savThreads).set({ aiPaused: true }); }, "LOCKED"],
  ["an agent pause (unreadable setting fails closed)", async () => { await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:intake", cursor: "unreadable", status: "set" }); }, "LOCKED"],
  ["an active execution lease", async () => { await f.db.update(savIntakeExecutions).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) }); }, "LOCKED"],
  ["an active run lease", async () => { await f.db.update(savIntakeRuns).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) }); }, "LOCKED"],
  ["a newer inbound message", async () => {
    const [m] = await f.db.select().from(savMessages);
    await f.db.insert(savMessages).values({ ...m, id: randomUUID(), gmailMessageId: randomUUID(), receivedAt: new Date(dispatchedAt.getTime() + 60000), createdAt: new Date(Date.now() + 60000) });
  }, "LOCKED"],
  ["an execution that is no longer uncertain", async () => { await f.db.update(savIntakeExecutions).set({ state: "waiting" }); }, "NOT_UNCERTAIN"],
  ["a non-administrator", async () => { await f.db.update(staffUsers).set({ role: "member" }); }, "UNAUTHORIZED"],
])("refuses under %s and changes nothing", async (_label, arrange, code) => {
  await noteAssociationCase();
  await arrange();
  const before = await dump(), verify = proven(noteId);
  await expect(run(verify)).rejects.toThrow(code === "UNAUTHORIZED" ? /UNAUTHORIZED/ : new RegExp(`SAV_INTAKE_EFFECT_RECONCILIATION_${code}`));
  expect(verify).not.toHaveBeenCalled();
  expect(await dump()).toEqual(before);
});

it("checks the dossier version the operator decided on", async () => {
  await noteAssociationCase();
  await f.db.insert(savIntakeConsole).values({ threadId, epoch: 3, mailboxId: (await f.db.select().from(savMailboxes))[0].id });
  const version = { runId, version: 1, sourceHash: "s".repeat(64), epoch: 3 };
  await expect(run(proven(noteId), { threadId, messageId }, { ...version, epoch: 2 })).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_CHANGED");
  expect(await run(proven(noteId), { threadId, messageId }, version)).toMatchObject({ reconciled: true });
});

it("never accepts an id supplied by the caller", async () => {
  await noteAssociationCase();
  const verify = proven("999");
  for (const extra of [{ objectId: "999" }, { ackId: "999" }, { effectId: randomUUID() }])
    await expect(run(verify, { threadId, messageId, ...extra })).rejects.toThrow();
  expect(verify).not.toHaveBeenCalled();
});

it("an operation in progress on the same execution makes the write lose, after a read that commits nothing", async () => {
  await noteAssociationCase();
  const verify: Verify = vi.fn(async () => {
    // A worker takes the execution while the provider read is in flight.
    await f.db.update(savIntakeExecutions).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) });
    return { confirmed: true, attributed: true, ack: { id: noteId } };
  });
  await expect(run(verify)).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_BUSY");
  expect((await f.db.select().from(savIntakeEffects)).every(e => e.kind !== "note_associate" || e.state === "uncertain")).toBe(true);
});

it("with the real read-only adapter: a note attached to the ticket is proven; the same note not attached is refused", async () => {
  await noteAssociationCase();
  let attached = false;
  const calls: string[] = [];
  const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method !== "GET") throw Error("WRITE_FORBIDDEN");
    const body = path === `/crm/v3/objects/notes/${noteId}` ? { id: noteId, properties: noteProps }
      : path === `/crm/v4/objects/notes/${noteId}/associations/tickets` ? { results: attached ? [{ toObjectId: Number(ticketId) }] : [] } : null;
    if (!body) throw Error(`UNEXPECTED ${path}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const { verify } = createIntakeExecutorAdapters({ network, env: () => ({ HUBSPOT_ACCESS_TOKEN: "synthetic" }) });
  const before = await dump();
  await expect(run(verify)).rejects.toThrow("NOT_PROVEN");
  expect(await dump()).toEqual(before);
  attached = true;
  expect(await run(verify)).toMatchObject({ reconciled: true, kind: "note_associate", objectId: noteId });
  expect(calls.every(c => c.startsWith("GET "))).toBe(true);
});

// ---- Review Astra (8958159): lock order and pause serialization. PGlite runs ONE connection, so these
// tests prove the statement order inside each transaction, not a native two-connection interleaving.
// Existing orders this one extends: withEffectRecoveryLease (admission -> execution), reconcile_note
// (admission -> execution -> thread -> staff -> runs), model reservations (thread -> run -> budget lock).
const LOCK_RANK = [
  ["admission", /sav-intake-common-admission-v1/],
  ["execution", /from "sav"\."intake_executions"[\s\S]* for (no key )?update/i],
  ["thread", /from "sav"\."threads"[\s\S]* for update/i],
  ["staff", /"staff_users"[\s\S]* for update/i],
  ["runs", /from "sav"\."intake_runs"[\s\S]* for update/i],
  ["pause", /sav-intake-runtime-model-budget-v1/],
] as const;
/** Every transaction of the call, as the ordered list of the locks it takes and of its pause read / effect write. */
async function recordTransactions(work: () => Promise<unknown>) {
  const log: string[] = [];
  const logged = drizzle(f.client as never, { schema, logger: { logQuery: query => { log.push(query); } } }) as unknown as typeof f.db;
  let n = 0;
  state.db = new Proxy(logged, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return async (fn: (tx: unknown) => Promise<unknown>) => { const id = ++n; log.push(`#BEGIN ${id}`); try { return await target.transaction(fn as never); } finally { log.push(`#END ${id}`); } };
  } });
  try { await work().catch(error => error); } finally { state.db = f.db; }
  const transactions: string[][] = [];
  let current: string[] | null = null;
  for (const line of log) {
    if (line.startsWith("#BEGIN")) { current = []; continue; }
    if (line.startsWith("#END")) { if (current) transactions.push(current); current = null; continue; }
    if (!current) continue;
    const lock = LOCK_RANK.find(([, pattern]) => pattern.test(line))?.[0];
    if (lock) current.push(lock);
    else if (/from "sav"\."sync_state"/i.test(line)) current.push("read_pause");
    else if (/^update "sav"\."intake_effects"/i.test(line)) current.push("write_effect");
  }
  return transactions;
}
const ranks = LOCK_RANK.map(([name]) => name as string);
/** No transaction ever takes a lock of lower rank after a higher one (re-taking a held lock is free). */
function assertOneOrder(transactions: string[][]) {
  for (const steps of transactions) {
    const held = new Set<string>(); let top = -1;
    for (const step of steps) {
      const rank = ranks.indexOf(step);
      if (rank < 0 || held.has(step)) continue;
      expect({ step, after: ranks[top] ?? null, ok: rank > top }).toMatchObject({ ok: true });
      held.add(step); top = rank;
    }
  }
}

it("pre-check and confirmation take ONE lock order: admission, execution, thread, staff, runs, pause", async () => {
  await noteAssociationCase();
  const transactions = await recordTransactions(() => run(proven(noteId)));
  const full = transactions.filter(t => ranks.every(lock => t.includes(lock)));
  // The read-only pre-check and the confirmation both run the whole fence.
  expect(full).toHaveLength(2);
  for (const steps of full) {
    const first = ranks.map(lock => steps.indexOf(lock));
    expect(first).toEqual([...first].sort((a, b) => a - b));
  }
  assertOneOrder(transactions);
  // Confirmation: the pause lock is held before the pause is read and until the effect is written.
  const confirmation = full.find(t => t.includes("write_effect"))!;
  expect(confirmation.indexOf("pause")).toBeLessThan(confirmation.indexOf("read_pause"));
  expect(confirmation.indexOf("read_pause")).toBeLessThan(confirmation.indexOf("write_effect"));
  expect((await f.db.select().from(savIntakeEffects)).every(e => e.state === "confirmed")).toBe(true);
});

it("a refused call follows the same order (two calls by the same administrator cannot wait on each other)", async () => {
  await noteAssociationCase();
  assertOneOrder(await recordTransactions(() => run(vi.fn(async () => ({ confirmed: false, attributed: false })))));
  await f.db.update(savThreads).set({ aiPaused: true });
  assertOneOrder(await recordTransactions(() => run(proven(noteId))));
});

it("a pause recorded between the pre-check and the confirmation stops the confirmation", async () => {
  await noteAssociationCase();
  const { setSavAgentPause } = await import("./agent-pause-admin");
  const verify: Verify = vi.fn(async () => {
    // The administrator pauses the agent while the HubSpot read is in flight (after the pre-check read "running").
    await setSavAgentPause({ agent: "intake", level: "actions_paused", reason: "Synthetic pause during verification" });
    return { confirmed: true, attributed: true, ack: { id: noteId } };
  });
  await expect(run(verify)).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_LOCKED");
  expect(verify).toHaveBeenCalledTimes(1);
  expect((await f.db.select().from(savIntakeEffects)).find(e => e.kind === "note_associate")?.state).toBe("uncertain");
  expect((await f.db.select().from(auditLogs)).map(a => a.action)).not.toContain("sav_intake_effect_reconciled_from_receipt");
  const [execution] = await f.db.select().from(savIntakeExecutions);
  expect(execution.leaseToken).toBeNull();
});
