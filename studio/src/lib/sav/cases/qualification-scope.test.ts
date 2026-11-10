import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savCases, savMailboxes, savMessages, savSyncState, savThreads } from "@/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown, admission: { assign: true as boolean } }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// The admission of the owner at creation is tested on its own (execution.test.ts); here only its answer is fixed, to test what SAV-80 adds after it.
vi.mock("./owner-attribution", () => ({ v2OwnerAtCreationPort: () => async () => state.admission.assign ? { assign: true, ownerId: "90000001" } : { assign: false, reason: "not_admitted" } }));
import { encryptSavPayload } from "../crypto";
import { SAV_INTAKE_CONTRACT_REVISION } from "../intake/contract";
import { creationOwnerForIntake } from "./v2-entry";
import {
  bindSavV2QualificationThread, readSavV2QualificationScope, savV2QualificationCaseAllowed, savV2QualificationMessageAllowed, savV2QualificationScopeHash,
  SAV_V2_QUALIFICATION_SCOPE_SCHEMA,
} from "./qualification-scope";

/* SAV-80, synthetic only: invented addresses (example.invalid), contact ids and subjects. No CRM, Gmail, model or network. */
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "";
const SENDER = "tester@example.invalid", CONTACT = "100000001", SUBJECT = "Test Accès V2 synthétique";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const base = { schema: SAV_V2_QUALIFICATION_SCOPE_SCHEMA as typeof SAV_V2_QUALIFICATION_SCOPE_SCHEMA, revision: "q-syn-r1", senderEmail: SENDER, hubspotContactId: CONTACT, initialSubject: SUBJECT,
  notBefore: "2026-11-10T11:00:00.000Z", expiresAt: "2026-11-10T13:00:00.000Z" };
const env = (over: Record<string, unknown> = {}, mode: string | null = "qualification") =>
  ({ ...(mode === null ? {} : { SAV_V2_SCOPE_MODE: mode }), SAV_V2_QUALIFICATION_SCOPE_JSON: JSON.stringify({ ...base, ...over }) });
const noDb = new Proxy({}, { get: () => { throw Error("DB_TOUCHED"); } }) as never;

async function thread(messages: Array<{ from?: string; subject?: string; at?: string; direction?: "inbound" | "outbound"; text?: string }>) {
  const threadId = randomUUID();
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `t-${threadId}`, subject: messages[0]?.subject ?? SUBJECT, customerEmail: messages[0]?.from ?? SENDER });
  const ids: string[] = [];
  for (const [i, m] of messages.entries()) {
    const id = randomUUID(); ids.push(id);
    await f.db.insert(savMessages).values({ id, threadId, mailboxId, direction: m.direction ?? "inbound", fromEmail: m.from ?? SENDER, toEmails: ["contact@example.invalid"],
      subject: m.subject ?? SUBJECT, bodyCiphertext: encryptSavPayload({ text: m.text ?? "Bonjour" }), receivedAt: new Date(m.at ?? new Date(Date.parse("2026-11-10T11:30:00.000Z") + i * 60_000).toISOString()),
      gmailMessageId: `g-${id}` });
  }
  return { threadId, ids };
}
const caseFor = async (threadIds: string[]) => {
  const [row] = await f.db.insert(savCases).values({ ticketId: String(Math.floor(Math.random() * 1e9)), threadIds, owner: "human", phase: "human_owned", contractRevision: "syn", payloadCiphertext: "syn" }).returning();
  return row!.id;
};

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-scope-proof-key-32-chars!!!!");
  f = await createSavTestDb(); state.db = f.db;
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "contact@example.invalid" }).returning())[0]!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(async () => { await f.db.delete(savSyncState).where(like(savSyncState.key, "sav-v2-qualification-thread.v1:%")); state.admission.assign = true; });

describe("configuration: strict, positive, never a permissive fallback", () => {
  it("no mode and no scope is today's behaviour, without touching the database", async () => {
    expect(readSavV2QualificationScope({}, NOW)).toEqual({ mode: "open" });
    expect(await bindSavV2QualificationThread({}, { messageId: randomUUID(), primaryContactId: null }, NOW, noDb)).toEqual({ allowed: true });
    expect(await savV2QualificationMessageAllowed({}, randomUUID(), NOW, noDb)).toEqual({ allowed: true });
    expect(await savV2QualificationCaseAllowed({ SAV_V2_SCOPE_MODE: "" }, randomUUID(), NOW, noDb)).toEqual({ allowed: true });
  });
  it.each([
    ["a scope without the mode", env({}, null), "scope_mode_missing"],
    ["an unknown mode", env({}, "Qualification"), "scope_mode_invalid"],
    ["the mode without a scope", { SAV_V2_SCOPE_MODE: "qualification" }, "scope_missing"],
    ["malformed JSON", { SAV_V2_SCOPE_MODE: "qualification", SAV_V2_QUALIFICATION_SCOPE_JSON: "{" }, "scope_invalid"],
    ["an extra field", env({ extra: 1 }), "scope_invalid"],
    ["an upper-case sender", env({ senderEmail: "Tester@example.invalid" }), "scope_invalid"],
    ["a display-name sender", env({ senderEmail: "Tester <tester@example.invalid>" }), "scope_invalid"],
    ["a non-numeric contact", env({ hubspotContactId: "contact-1" }), "scope_invalid"],
    ["a padded subject", env({ initialSubject: ` ${SUBJECT}` }), "scope_invalid"],
    ["an end before the start", env({ expiresAt: "2026-11-10T10:00:00.000Z" }), "scope_invalid"],
    ["a window longer than 7 days", env({ expiresAt: "2026-11-18T11:00:01.000Z" }), "scope_invalid"],
    ["a window not open yet", env({ notBefore: "2026-11-10T12:30:00.000Z" }), "scope_not_open"],
    ["an expired window", env({ expiresAt: "2026-11-10T12:00:00.000Z" }), "scope_expired"],
  ])("%s closes every V2 action, without touching the database", async (_name, configuration, problem) => {
    expect(readSavV2QualificationScope(configuration, NOW)).toEqual({ mode: "closed", problem });
    for (const decided of [await bindSavV2QualificationThread(configuration, { messageId: randomUUID(), primaryContactId: CONTACT }, NOW, noDb),
      await savV2QualificationMessageAllowed(configuration, randomUUID(), NOW, noDb), await savV2QualificationCaseAllowed(configuration, randomUUID(), NOW, noDb)])
      expect(decided).toEqual({ allowed: false, reason: `qualification_${problem}` });
  });
});

describe("binding: the first admissible thread only, atomically, bound to the exact configuration", () => {
  it("binds the opening message of the exact sender, contact, subject and window; then admits that thread's sender only", async () => {
    const t = await thread([{}, { subject: `Re: ${SUBJECT}` }, { from: "other@example.invalid", subject: `Re: ${SUBJECT}`, text: `De : ${SENDER}` }]);
    expect(await bindSavV2QualificationThread(env(), { messageId: t.ids[0]!, primaryContactId: CONTACT }, NOW)).toEqual({ allowed: true });
    expect(await bindSavV2QualificationThread(env(), { messageId: t.ids[0]!, primaryContactId: CONTACT }, NOW)).toEqual({ allowed: true }); // idempotent (final pre-dispatch check)
    const [row] = await f.db.select().from(savSyncState).where(eq(savSyncState.key, "sav-v2-qualification-thread.v1:q-syn-r1"));
    expect(JSON.parse(row!.cursor!)).toMatchObject({ threadId: t.threadId, messageId: t.ids[0], configHash: savV2QualificationScopeHash(base) });
    expect(await savV2QualificationMessageAllowed(env(), t.ids[1]!, NOW)).toEqual({ allowed: true });
    // Another sender on the same thread, even quoting the test address in its text, is not the sender.
    expect(await savV2QualificationMessageAllowed(env(), t.ids[2]!, NOW)).toEqual({ allowed: false, reason: "qualification_sender_mismatch" });
    expect(await savV2QualificationCaseAllowed(env(), await caseFor([t.threadId]), NOW)).toEqual({ allowed: true });
  });
  it.each([
    ["another contact", [{}], { primaryContactId: "100000002" }, "qualification_contact_mismatch"],
    ["no contact", [{}], { primaryContactId: null }, "qualification_contact_mismatch"],
    ["another sender", [{ from: "other@example.invalid" }], {}, "qualification_sender_mismatch"],
    ["a forward by another address quoting the sender", [{ from: "colleague@example.invalid", subject: `Fwd: ${SUBJECT}`, text: `From: ${SENDER}` }], {}, "qualification_sender_mismatch"],
    ["another subject", [{ subject: `${SUBJECT} ` + "bis" }], {}, "qualification_subject_mismatch"],
    ["a reply subject", [{ subject: `Re: ${SUBJECT}` }], {}, "qualification_subject_mismatch"],
    ["before the window", [{ at: "2026-11-10T10:59:59.000Z" }], {}, "qualification_outside_window"],
    ["an outbound message", [{ direction: "outbound" as const }], {}, "qualification_sender_mismatch"],
  ])("refuses %s and binds nothing", async (_name, messages, over, reason) => {
    const t = await thread(messages);
    expect(await bindSavV2QualificationThread(env(), { messageId: t.ids[0]!, primaryContactId: CONTACT, ...over }, NOW)).toEqual({ allowed: false, reason });
    expect(await f.db.select().from(savSyncState).where(like(savSyncState.key, "sav-v2-qualification-thread.v1:%"))).toEqual([]);
  });
  it("an older thread answered under the exact subject is not a new test thread", async () => {
    const t = await thread([{ from: "other@example.invalid", subject: "Ancien échange", at: "2026-11-01T09:00:00.000Z" }, {}]);
    expect(await bindSavV2QualificationThread(env(), { messageId: t.ids[1]!, primaryContactId: CONTACT }, NOW)).toEqual({ allowed: false, reason: "qualification_not_first_message" });
  });
  it("a second thread is refused once one is bound, and the other thread's messages and cases are refused", async () => {
    const first = await thread([{}]), second = await thread([{}]);
    expect(await bindSavV2QualificationThread(env(), { messageId: first.ids[0]!, primaryContactId: CONTACT }, NOW)).toEqual({ allowed: true });
    expect(await bindSavV2QualificationThread(env(), { messageId: second.ids[0]!, primaryContactId: CONTACT }, NOW)).toEqual({ allowed: false, reason: "qualification_other_thread_bound" });
    expect(await savV2QualificationMessageAllowed(env(), second.ids[0]!, NOW)).toEqual({ allowed: false, reason: "qualification_other_thread" });
    expect(await savV2QualificationCaseAllowed(env(), await caseFor([second.threadId]), NOW)).toEqual({ allowed: false, reason: "qualification_other_thread" });
    // A case that gathered a second thread is no longer the test exchange.
    expect(await savV2QualificationCaseAllowed(env(), await caseFor([first.threadId, second.threadId]), NOW)).toEqual({ allowed: false, reason: "qualification_other_thread" });
  });
  it("two threads binding concurrently: exactly one wins", async () => {
    const threads = await Promise.all([thread([{}]), thread([{}]), thread([{}])]);
    const answers = await Promise.all(threads.map(t => bindSavV2QualificationThread(env(), { messageId: t.ids[0]!, primaryContactId: CONTACT }, NOW)));
    expect(answers.filter(answer => answer.allowed)).toHaveLength(1);
    expect(answers.filter(answer => !answer.allowed)).toEqual([{ allowed: false, reason: "qualification_other_thread_bound" }, { allowed: false, reason: "qualification_other_thread_bound" }]);
  });
  it.each([
    ["contact", { hubspotContactId: "100000002" }], ["sender", { senderEmail: "other@example.invalid" }], ["subject", { initialSubject: "Autre objet" }],
    ["window", { expiresAt: "2026-11-10T13:30:00.000Z" }],
  ])("a %s changed under the same revision is refused everywhere, never reinterpreted", async (_name, changed_) => {
    const change = changed_ as Partial<Record<"hubspotContactId" | "senderEmail" | "initialSubject" | "expiresAt", string>>;
    const t = await thread([{}]), caseId = await caseFor([t.threadId]);
    expect(await bindSavV2QualificationThread(env(), { messageId: t.ids[0]!, primaryContactId: CONTACT }, NOW)).toEqual({ allowed: true });
    const changed = env(change), other = await thread([{ from: change.senderEmail ?? SENDER, subject: change.initialSubject ?? SUBJECT }]);
    expect(await bindSavV2QualificationThread(changed, { messageId: other.ids[0]!, primaryContactId: change.hubspotContactId ?? CONTACT }, NOW)).toEqual({ allowed: false, reason: "qualification_scope_changed" });
    expect(await savV2QualificationMessageAllowed(changed, t.ids[0]!, NOW)).toEqual({ allowed: false, reason: "qualification_scope_changed" });
    expect(await savV2QualificationCaseAllowed(changed, caseId, NOW)).toEqual({ allowed: false, reason: "qualification_scope_changed" });
  });
  it("an unreadable binding row binds nothing and allows nothing", async () => {
    const t = await thread([{}]);
    await f.db.insert(savSyncState).values({ key: "sav-v2-qualification-thread.v1:q-syn-r1", status: "bound", cursor: "not json" });
    expect(await bindSavV2QualificationThread(env(), { messageId: t.ids[0]!, primaryContactId: CONTACT }, NOW)).toEqual({ allowed: false, reason: "qualification_binding_unreadable" });
    expect(await savV2QualificationMessageAllowed(env(), t.ids[0]!, NOW)).toEqual({ allowed: false, reason: "qualification_binding_unreadable" });
  });
  it("no binding yet: messages and cases are refused (only the owner at creation binds)", async () => {
    const t = await thread([{}]);
    expect(await savV2QualificationMessageAllowed(env(), t.ids[0]!, NOW)).toEqual({ allowed: false, reason: "qualification_thread_unbound" });
    expect(await savV2QualificationCaseAllowed(env(), await caseFor([t.threadId]), NOW)).toEqual({ allowed: false, reason: "qualification_thread_unbound" });
  });
});

describe("owner at creation (creationOwnerForIntake): the only binder, after V2's own admission", () => {
  const decision = (messageId: string, contactId = CONTACT) => ({ revision: SAV_INTAKE_CONTRACT_REVISION, messageId, latestInboundMessageId: messageId, classification: "support",
    requests: [{ id: "r0", kind: "support" }], disposition: { kind: "ticket", target: { operation: "create", contactId }, contactScope: { primaryContactId: contactId } } }) as never;
  const entryEnv = (over: Record<string, string | undefined> = {}) => ({ SAV_V2_ENTRY: "on", SAV_CASE_RECORDING: "on", ...env(), ...over });
  const signal = new AbortController().signal;
  it("in scope: the V2 owner, and the thread bound; a second thread then gets no V2 owner", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    try {
      const first = await thread([{}]), second = await thread([{}]);
      expect(await creationOwnerForIntake(entryEnv(), { decision: decision(first.ids[0]!), signal })).toEqual({ assign: true, ownerId: "90000001" });
      expect(await creationOwnerForIntake(entryEnv(), { decision: decision(second.ids[0]!), signal })).toEqual({ assign: false, reason: "not_admitted" });
    } finally { vi.useRealTimers(); }
  });
  it("another contact or an expired scope: no V2 owner (V1 creates its ticket as today)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    try {
      const t = await thread([{}]);
      expect(await creationOwnerForIntake(entryEnv(), { decision: decision(t.ids[0]!, "100000002"), signal })).toEqual({ assign: false, reason: "not_admitted" });
      expect(await creationOwnerForIntake({ ...entryEnv(), ...env({ expiresAt: "2026-11-10T11:59:00.000Z" }) }, { decision: decision(t.ids[0]!), signal })).toEqual({ assign: false, reason: "not_admitted" });
      expect(await f.db.select().from(savSyncState).where(like(savSyncState.key, "sav-v2-qualification-thread.v1:%"))).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it("a mail V2 does not admit consumes no binding: the test thread stays free", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    try {
      state.admission.assign = false;
      const t = await thread([{}]);
      expect(await creationOwnerForIntake(entryEnv(), { decision: decision(t.ids[0]!), signal })).toEqual({ assign: false, reason: "not_admitted" });
      expect(await f.db.select().from(savSyncState).where(like(savSyncState.key, "sav-v2-qualification-thread.v1:%"))).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it("outside qualification mode nothing changes: the port's answer is returned as before", async () => {
    const t = await thread([{ from: "anyone@example.invalid", subject: "Autre" }]);
    expect(await creationOwnerForIntake({ SAV_V2_ENTRY: "on", SAV_CASE_RECORDING: "on" }, { decision: decision(t.ids[0]!, "100000009"), signal })).toEqual({ assign: true, ownerId: "90000001" });
  });
});
