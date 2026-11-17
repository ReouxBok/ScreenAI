import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savIntakeConsole, savIntakeEffectJournal, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeHumanEvents,
  savIntakeOccupations, savIntakeRuns, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { intakeRuntimeHash } from "./runtime-contract";
import { renderIntakeNote } from "./execution-adapters";
import { reconcileIntakeUncertainEffect } from "./effect-reconciliation";
import type { EffectAck, EffectIntent, ExecutorAdapters } from "./execution-types";

/** SAV-92 follow-up: the whole get_dossier -> reconcile_effect path on a dossier whose console projection is LIVE.
 * The message carries an intake analysis status, so the real console triggers (0042/0043) bump
 * `sav.intake_console.epoch` on every write to runs, executions and effects, exactly as in production.
 * Only Clerk and the read-only HubSpot verification are replaced. Synthetic data only. */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string, adminId: string, threadId: string, messageId: string, runId: string, executionId: string;
const ticketId = "201", noteId = "301", emailId = "401", dispatchedAt = new Date("2026-11-15T10:00:00Z");
const noteProps = { hs_note_body: renderIntakeNote("Synthetic note.", "a".repeat(64)), hs_timestamp: "2026-11-15T09:59:00.000Z" };
const emailProps = { hs_timestamp: "2026-11-15T09:58:00.000Z", hs_email_direction: "INCOMING_EMAIL", hs_email_subject: "Synthetic subject", hs_email_text: "Synthetic body." };
type Verify = ExecutorAdapters["verify"];
type Expected = NonNullable<Parameters<typeof reconcileIntakeUncertainEffect>[1]>;
const proven = (id: string): Verify => vi.fn(async () => ({ confirmed: true, attributed: true, ack: { id } }));
const intents = {
  note_create: (m: string): EffectIntent => ({ kind: "note_create", permission: "append_ticket_note", key: `note:${m}:${ticketId}`, ticketId, sourceMessageId: m, text: "Synthetic note.", marker: "a".repeat(64), properties: noteProps }),
  note_associate: (m: string, createId: string): EffectIntent => ({ kind: "note_associate", permission: "append_ticket_note", key: `note-association:${m}:${ticketId}`, ticketId, objectId: noteId,
    sourceMessageId: m, expectedProperties: noteProps, confirmedNoteCreate: { effectId: createId, objectId: noteId } }),
  email_create: (m: string): EffectIntent => ({ kind: "email_create", permission: "associate_email", key: `email:${m}`, ticketId, sourceMessageId: m, marker: "b".repeat(64), properties: emailProps }),
  email_associate: (m: string): EffectIntent => ({ kind: "email_associate", permission: "associate_email", key: `email-association:${m}:${ticketId}`, ticketId, objectId: emailId, sourceMessageId: m, expectedProperties: emailProps }),
};
async function effect(exec: string, intent: EffectIntent, effectState: string, ack: EffectAck | null) {
  return (await f.db.insert(savIntakeEffects).values({ executionId: exec, businessKey: intent.key, kind: intent.kind, permission: intent.permission, state: effectState,
    intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), dispatchedAt, ackCiphertext: ack ? encryptSavPayload(ack) : null,
    reconcileAttempts: effectState === "confirmed" ? 0 : 5,
    ...(effectState === "confirmed" ? { confirmedAt: dispatchedAt, verificationCiphertext: encryptSavPayload({ confirmed: true, attributed: true, ack }) } : {}) }).returning())[0];
}
/** The three production shapes, each with exactly one unsettled effect and its stored receipt. */
const shapes = {
  note_associate: async (exec: string, m: string) => {
    const create = await effect(exec, intents.note_create(m), "confirmed", { id: noteId });
    return { effect: await effect(exec, intents.note_associate(m, create.id), "uncertain", null), objectId: noteId };
  },
  email_create: async (exec: string, m: string) => {
    await effect(exec, intents.note_create(m), "confirmed", { id: noteId });
    return { effect: await effect(exec, intents.email_create(m), "uncertain", { id: emailId }), objectId: emailId };
  },
  email_associate: async (exec: string, m: string) => {
    await effect(exec, intents.email_create(m), "confirmed", { id: emailId });
    return { effect: await effect(exec, intents.email_associate(m), "uncertain", null), objectId: emailId };
  },
} as const;
async function inbound(at: Date) {
  return (await f.db.insert(savMessages).values({ threadId, mailboxId, direction: "inbound", gmailMessageId: randomUUID(), fromEmail: "customer@example.invalid",
    toEmails: ["support@example.invalid"], subject: "Synthetic subject", bodyCiphertext: encryptSavPayload({ text: "Synthetic body.", attachments: [] }), receivedAt: at,
    createdAt: at, analysisStatus: "intake_execution_uncertain" }).returning())[0].id;
}
async function run_(m: string, version: number, isCurrent = true) {
  return (await f.db.insert(savIntakeRuns).values({ threadId, messageId: m, version, state: "observed", isCurrent, configHash: "c", policyHash: "p", sourceHash: `${version}`.repeat(64).slice(0, 64),
    payloadCiphertext: encryptSavPayload({}) }).returning())[0].id;
}
async function execution(m: string, r: string, version: number, keys: string[] = []) {
  const policyId = (await f.db.select().from(savIntakeExecutionPolicies))[0].id;
  const id = (await f.db.insert(savIntakeExecutions).values({ messageId: m, threadId, runId: r, runVersion: version, policyId, policyHash: "p", state: "uncertain", ticketId,
    payloadCiphertext: encryptSavPayload({ reason: "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED", keys }) }).returning())[0].id;
  for (const key of keys) await f.db.insert(savIntakeOccupations).values({ key, ownerId: id, ownerKind: "intake" });
  return id;
}
/** What get_dossier hands the MCP agent: the current run and the console epoch, freshly read. */
async function dossierVersion(): Promise<Expected> {
  const [current] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.isCurrent, true));
  const [projection] = await f.db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, threadId));
  return { runId: current?.id ?? null, version: current?.version ?? null, sourceHash: current?.sourceHash ?? null, epoch: projection.epoch };
}
const epoch = async () => (await f.db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, threadId)))[0].epoch;
const reconcile = (verify: Verify, expected: Expected, m = messageId) => reconcileIntakeUncertainEffect({ threadId, messageId: m }, expected, { verify });
const stored = async () => ({ effects: (await f.db.select().from(savIntakeEffects).orderBy(savIntakeEffects.id)).map(e => ({ id: e.id, state: e.state, attempts: e.reconcileAttempts, ack: e.ackCiphertext })),
  executions: (await f.db.select().from(savIntakeExecutions).orderBy(savIntakeExecutions.id)).map(e => ({ id: e.id, state: e.state, leaseToken: e.leaseToken, leaseUntil: e.leaseUntil })),
  occupations: (await f.db.select().from(savIntakeOccupations)).length, journal: (await f.db.select().from(savIntakeEffectJournal)).length,
  audits: (await f.db.select().from(auditLogs)).length });

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 120000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-effect-reconcile-flow-key-32-chars");
  await f.client.exec(`TRUNCATE sav.intake_effect_journal, sav.intake_effects, sav.intake_occupations, sav.intake_human_events, sav.intake_executions, sav.intake_execution_policies,
    sav.intake_runs, sav.intake_console, sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; DELETE FROM sav.sync_state`);
  await f.db.insert(savSyncState).values({ key: "sav-intake-console-schema-v1", status: "installed" });
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "ugo@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
  adminId = admin.id;
  state.user = { id: admin.clerkId, primaryEmailAddress: { emailAddress: admin.email, verification: { status: "verified" } } };
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
  threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: "gmail-thread", customerEmail: "customer@example.invalid" }).returning())[0].id;
  await f.db.insert(savIntakeExecutionPolicies).values({ revision: "r", state: "approved", administratorId: adminId, policyHash: "p", payloadCiphertext: encryptSavPayload({}) });
  messageId = await inbound(dispatchedAt);
  runId = await run_(messageId, 1);
  executionId = await execution(messageId, runId, 1);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("the console projection is live (production triggers)", () => {
  it("every write to the execution row moves the console epoch: a recovery lease alone moves it", async () => {
    await shapes.note_associate(executionId, messageId);
    const before = await epoch();
    await f.db.update(savIntakeExecutions).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 80000) }).where(eq(savIntakeExecutions.id, executionId));
    expect(await epoch()).toBe(before + 1);
    await f.db.update(savIntakeExecutions).set({ leaseToken: null, leaseUntil: null }).where(eq(savIntakeExecutions.id, executionId));
    expect(await epoch()).toBe(before + 2);
  });

  it.each(Object.keys(shapes) as (keyof typeof shapes)[])(
    "%s: freshly read version -> claim -> HubSpot read -> confirmation -> reread; exactly one confirmed receipt", async kind => {
      const { effect: target, objectId } = await shapes[kind](executionId, messageId);
      const expected = await dossierVersion(), verify = proven(objectId);
      expect(await reconcile(verify, expected)).toEqual({ reconciled: true, kind, objectId });
      expect(verify).toHaveBeenCalledTimes(1);
      const [row] = await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, target.id));
      expect({ state: row.state, attempts: row.reconcileAttempts, ack: decryptSavPayload<EffectAck>(row.ackCiphertext!).id }).toEqual({ state: "confirmed", attempts: 5, ack: objectId });
      expect((await f.db.select().from(savIntakeEffects)).filter(e => e.state !== "confirmed")).toHaveLength(0);
      const confirmations = (await f.db.select().from(savIntakeEffectJournal)).filter(j => j.effectId === target.id && j.kind === "confirmed");
      expect(confirmations).toHaveLength(1);
      expect((await f.db.select().from(auditLogs)).filter(a => a.action === "sav_intake_effect_reconciled_from_receipt")).toHaveLength(1);
      const [exec] = await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, executionId));
      expect({ state: exec.state, leaseToken: exec.leaseToken, leaseUntil: exec.leaseUntil }).toEqual({ state: "uncertain", leaseToken: null, leaseUntil: null });
      // Reread: a second call with a fresh version finds nothing unsettled, reads nothing and writes nothing.
      const before = await stored();
      expect(await reconcile(verify, await dossierVersion())).toEqual({ reconciled: false, alreadyConfirmed: true });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(await stored()).toEqual(before);
    });

  it("a version read before the call is still refused when it is stale (no global epoch tolerance)", async () => {
    await shapes.note_associate(executionId, messageId);
    const expected = await dossierVersion();
    const before = await stored(), verify = proven(noteId);
    await expect(reconcile(verify, { ...expected, epoch: expected.epoch - 1 })).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_CHANGED");
    await expect(reconcile(verify, { ...expected, epoch: expected.epoch + 1 })).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_CHANGED");
    await expect(reconcile(verify, { ...expected, version: 2 })).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_CHANGED");
    await expect(reconcile(verify, { ...expected, sourceHash: "x".repeat(64) })).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_CHANGED");
    expect(verify).not.toHaveBeenCalled();
    expect(await stored()).toEqual(before);
  });
});

describe("a real concurrent change during the HubSpot read still refuses and confirms nothing", () => {
  const changes: [string, () => Promise<void>, RegExp][] = [
    ["a new inbound message", async () => { await inbound(new Date(dispatchedAt.getTime() + 60000)); }, /SAV_INTAKE_EFFECT_RECONCILIATION_(LOCKED|CHANGED)/],
    ["a recorded human choice", async () => {
      await f.db.insert(savIntakeHumanEvents).values({ commandKey: randomUUID(), threadId, messageId, parentRunId: runId, parentVersion: 1, baseConfigHash: "c",
        sourceHash: "1".repeat(64), kind: "select", payloadCiphertext: encryptSavPayload({}) });
    }, /SAV_INTAKE_EFFECT_RECONCILIATION_(LOCKED|CHANGED)/],
    ["a thread pause", async () => { await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId)); }, /SAV_INTAKE_EFFECT_RECONCILIATION_(LOCKED|CHANGED)/],
    ["an agent pause", async () => {
      const { setSavAgentPause } = await import("./agent-pause-admin");
      await setSavAgentPause({ agent: "intake", level: "actions_paused", reason: "Synthetic pause during verification" });
    }, /SAV_INTAKE_EFFECT_RECONCILIATION_LOCKED/],
    ["an unrelated projection change (console epoch only)", async () => {
      await f.db.update(savMessages).set({ analysisStatus: "intake_execution_waiting" }).where(eq(savMessages.id, messageId));
    }, /SAV_INTAKE_EFFECT_RECONCILIATION_CHANGED/],
  ];
  it.each(changes)("%s", async (_label, change, code) => {
    const { effect: target } = await shapes.note_associate(executionId, messageId);
    const expected = await dossierVersion();
    const verify: Verify = vi.fn(async () => { await change(); return { confirmed: true, attributed: true, ack: { id: noteId } }; });
    await expect(reconcile(verify, expected)).rejects.toThrow(code);
    expect(verify).toHaveBeenCalledTimes(1);
    const [row] = await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, target.id));
    expect({ state: row.state, attempts: row.reconcileAttempts }).toEqual({ state: "uncertain", attempts: 5 });
    expect((await f.db.select().from(savIntakeEffectJournal)).filter(j => j.kind === "confirmed")).toHaveLength(0);
    expect((await f.db.select().from(auditLogs)).map(a => a.action)).not.toContain("sav_intake_effect_reconciled_from_receipt");
    const [exec] = await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, executionId));
    expect({ state: exec.state, leaseToken: exec.leaseToken }).toEqual({ state: "uncertain", leaseToken: null });
  });
});

describe("a missing or ambiguous receipt is refused clearly, with no new effect and no read", () => {
  it.each([
    ["email_create without a stored provider receipt", async () => {
      await effect(executionId, intents.note_create(messageId), "confirmed", { id: noteId });
      await effect(executionId, intents.email_create(messageId), "uncertain", null);
    }, "ACK_MISSING"],
    ["an operator candidate instead of a provider receipt", async () => {
      await effect(executionId, intents.email_create(messageId), "uncertain", { id: emailId, operatorCandidate: true });
    }, "ACK_NOT_PROVIDER"],
    ["an association whose creation has two confirmed receipts", async () => {
      await effect(executionId, intents.email_create(messageId), "confirmed", { id: emailId });
      await effect(executionId, { ...intents.email_create(messageId), key: `email:${messageId}:again` }, "confirmed", { id: "402" });
      await effect(executionId, intents.email_associate(messageId), "uncertain", null);
    }, "DEPENDENCY_UNCONFIRMED"],
    ["two unsettled effects", async () => {
      await effect(executionId, intents.note_create(messageId), "uncertain", { id: noteId });
      await effect(executionId, intents.email_create(messageId), "uncertain", { id: emailId });
    }, "MULTIPLE_UNSETTLED"],
  ])("%s", async (_label, arrange, code) => {
    await arrange();
    const effectsBefore = (await f.db.select().from(savIntakeEffects)).length;
    const before = await stored(), verify = proven(emailId);
    await expect(reconcile(verify, await dossierVersion())).rejects.toThrow(`SAV_INTAKE_EFFECT_RECONCILIATION_${code}`);
    expect(verify).not.toHaveBeenCalled();
    expect((await f.db.select().from(savIntakeEffects)).length).toBe(effectsBefore);
    expect(await stored()).toEqual(before);
  });
});

describe("historical effect: the single uncertain execution of an OLDER message of the same thread", () => {
  let olderMessageId: string, currentRunId: string;
  /** The default execution becomes superseded: a newer inbound arrives, gets its own current run and no execution
   * (e.g. analysis attempts exhausted). The older execution keeps its uncertain effect and its scope. */
  async function supersede(keys = ["ticket:201", "note:201"]) {
    olderMessageId = messageId;
    for (const key of keys) await f.db.insert(savIntakeOccupations).values({ key, ownerId: executionId, ownerKind: "intake" });
    await f.db.update(savIntakeRuns).set({ isCurrent: false }).where(eq(savIntakeRuns.id, runId));
    messageId = await inbound(new Date(dispatchedAt.getTime() + 3600000));
    currentRunId = await run_(messageId, 2);
  }
  const currentSnapshot = async () => ({
    message: (await f.db.select().from(savMessages).where(eq(savMessages.id, messageId)))[0],
    run: (await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, currentRunId)))[0],
    executions: (await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId))).length,
  });

  it.each(Object.keys(shapes) as (keyof typeof shapes)[])(
    "%s: proven from its stored receipt, confirmed once, the superseded execution handed off; the current message is intact", async kind => {
      const { effect: target, objectId } = await shapes[kind](executionId, messageId);
      await supersede();
      const current = await currentSnapshot(), verify = proven(objectId);
      expect(await reconcile(verify, await dossierVersion())).toEqual({ reconciled: true, kind, objectId, historical: true, handedOff: true });
      // The read was made on the OLDER message's stored intent and receipt.
      expect(verify).toHaveBeenCalledTimes(1);
      expect((verify as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ kind, sourceMessageId: olderMessageId });
      const [row] = await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, target.id));
      expect({ state: row.state, attempts: row.reconcileAttempts }).toEqual({ state: "confirmed", attempts: 5 });
      const journal = await f.db.select().from(savIntakeEffectJournal);
      expect(journal.filter(j => j.effectId === target.id && j.kind === "confirmed")).toHaveLength(1);
      const handoff = journal.filter(j => j.kind === "new_message_handoff");
      expect(handoff).toHaveLength(1);
      expect(decryptSavPayload<{ nextMessageId: string; origin: string }>(handoff[0].payloadCiphertext)).toMatchObject({ nextMessageId: messageId, origin: "effect_reconciliation" });
      const [old] = await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, executionId));
      expect({ state: old.state, leaseToken: old.leaseToken, leaseUntil: old.leaseUntil }).toEqual({ state: "refused", leaseToken: null, leaseUntil: null });
      expect(await f.db.select().from(savIntakeOccupations)).toHaveLength(0);
      const [audit] = (await f.db.select().from(auditLogs)).filter(a => a.action === "sav_intake_effect_reconciled_from_receipt");
      expect(audit.technicalMetadata).toMatchObject({ messageId: olderMessageId, currentMessageId: messageId, historical: true, dispatch: false, executionStatePreserved: "superseded_handoff" });
      // The current message, its run and its (absent) execution are untouched; no effect was created anywhere.
      expect(await currentSnapshot()).toEqual(current);
      expect((await f.db.select().from(savIntakeEffects)).length).toBe(2);
      // Reread: nothing left to reconcile, nothing read, nothing written.
      const before = await stored();
      await expect(reconcile(verify, await dossierVersion())).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_NOT_UNCERTAIN");
      expect(verify).toHaveBeenCalledTimes(1);
      expect(await stored()).toEqual(before);
    });

  it("a historical proof that fails keeps the uncertain effect, the older execution and its scope", async () => {
    await shapes.note_associate(executionId, messageId);
    await supersede();
    const before = await stored();
    await expect(reconcile(vi.fn(async () => ({ confirmed: false, attributed: false })), await dossierVersion())).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_NOT_PROVEN");
    expect(await stored()).toEqual(before);
  });

  it("is refused without the dossier version (no historical target outside the version-checked path)", async () => {
    await shapes.note_associate(executionId, messageId);
    await supersede();
    const before = await stored(), verify = proven(noteId);
    await expect(reconcileIntakeUncertainEffect({ threadId, messageId }, undefined, { verify })).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_CHANGED");
    expect(verify).not.toHaveBeenCalled();
    expect(await stored()).toEqual(before);
  });

  it("two superseded non-terminal executions are ambiguous: refused before any read", async () => {
    await shapes.note_associate(executionId, messageId);
    await supersede();
    const middle = await inbound(new Date(dispatchedAt.getTime() + 1800000));
    const middleRun = await run_(middle, 9, false);
    await execution(middle, middleRun, 9);
    const before = await stored(), verify = proven(noteId);
    await expect(reconcile(verify, await dossierVersion())).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_MULTIPLE_UNSETTLED");
    expect(verify).not.toHaveBeenCalled();
    expect(await stored()).toEqual(before);
  });

  it("a live execution on the current message keeps the normal path: the older one is never targeted", async () => {
    await shapes.note_associate(executionId, messageId);
    await supersede();
    const own = await execution(messageId, currentRunId, 2);
    await f.db.update(savIntakeExecutions).set({ state: "waiting" }).where(eq(savIntakeExecutions.id, own));
    const before = await stored(), verify = proven(noteId);
    await expect(reconcile(verify, await dossierVersion())).rejects.toThrow("SAV_INTAKE_EFFECT_RECONCILIATION_NOT_UNCERTAIN");
    expect(verify).not.toHaveBeenCalled();
    expect(await stored()).toEqual(before);
  });

  it.each([
    ["a newer inbound message", async () => { await inbound(new Date(dispatchedAt.getTime() + 7200000)); }],
    ["an execution admitted for the current message", async () => { await execution(messageId, currentRunId, 2); }],
    ["a thread pause", async () => { await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, threadId)); }],
  ])("a real concurrent change (%s) during the read refuses and confirms nothing", async (_label, change) => {
    const { effect: target } = await shapes.note_associate(executionId, messageId);
    await supersede();
    const verify: Verify = vi.fn(async () => { await change(); return { confirmed: true, attributed: true, ack: { id: noteId } }; });
    await expect(reconcile(verify, await dossierVersion())).rejects.toThrow(/SAV_INTAKE_EFFECT_RECONCILIATION_(LOCKED|CHANGED)/);
    const [row] = await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, target.id));
    expect(row.state).toBe("uncertain");
    const [old] = await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, executionId));
    expect({ state: old.state, leaseToken: old.leaseToken }).toEqual({ state: "uncertain", leaseToken: null });
    expect((await f.db.select().from(savIntakeOccupations)).filter(o => o.ownerId === executionId)).toHaveLength(2);
    expect((await f.db.select().from(savIntakeEffectJournal)).filter(j => ["confirmed", "new_message_handoff"].includes(j.kind))).toHaveLength(0);
  });
});
