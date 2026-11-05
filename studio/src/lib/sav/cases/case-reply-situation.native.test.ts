import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSavNativeTestDb, validateSavNativeTestTarget } from "../../../../test/sav-native-db";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
import { blockedBehind, finishNativeHandle, openNativeHandle, openNativeObserver } from "../../../../test/sav-native-locks";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { savCaseReplyValidations, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { listCaseEvents, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { caseReplyKey, caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply, submitCaseReplyProposal } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";

// B-7 on a REAL Postgres, two connections that truly overlap: ONE situation (a customer mail, and the hand back that returns to it) is answered by at most one
// approved reply, whatever the order in which the two names reach the store. Every path of the store takes the case row first (the lock order of
// `case-reply-lock-order.native.test.ts`), so the second name reads the first one's COMMITTED approval when it gets the lock. The overlap is made deterministic:
// X holds the case; the first name queues on it, then the second; X commits. Runs only on the isolated native instance (SAV_TEST_POSTGRES_URL, migrated by the real
// migrator first); skipped everywhere else. Fresh ids, synthetic data; nothing is deleted (the CI database is shared).
const URL_ = process.env.SAV_TEST_POSTGRES_URL, TOKEN = process.env.SAV_TEST_POSTGRES_TOKEN;
const APPROVER = randomUUID(), POLICY = "native-policy-r1", AT = "2026-10-27T09:00:00.000Z";
const allow: CaseReplyAuthorizer = () => ({ allowed: true, basis: "native.fixture" });
const environment = { SAV_CASE_EFFECTS: "supervised", SAV_CASE_RECORDING: "on" };
const storeDeps = { env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY };
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: APPROVER, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: APPROVER, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const seenOf = (proposal: CaseReplyProposal) => ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient });

describe.skipIf(!URL_)("native Postgres: two names of one situation are never both approved", () => {
  let sql: postgres.Sql, observer: postgres.Sql, store: Awaited<ReturnType<typeof createSavNativeTestDb>>, mailboxId: string;
  const open = () => openNativeHandle(sql);
  const blockedBy = (holder: number, count: number) => blockedBehind(observer, holder, count);
  const done = (...handles: Awaited<ReturnType<typeof open>>[]) => Promise.all(handles.map(handle => finishNativeHandle(observer, handle)));
  const settle = <T,>(promise: Promise<T>) => promise.then(value => ({ value }), (error: Error) => ({ error: error.message }));

  /** One admitted case, one stored customer mail, one hand back after it; B's name (`inbound:`) and the other producer's name (`back:`) for the same situation. */
  async function scenario() {
    const gmailMessageId = `gm-${randomUUID()}`, ticketId = BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 24)}`).toString();
    const [thread] = await store.db.insert(savThreads).values({ mailboxId, gmailThreadId: `gt-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning();
    const [message] = await store.db.insert(savMessages).values({
      threadId: thread!.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic native",
      bodyCiphertext: encryptSavPayload({ text: "Synthetic.", headers: { "message-id": "<native@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z"),
    }).returning();
    const { case: opened } = await openCaseEvent({ ticketId, threadId: thread!.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId),
      sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
    const caseId = opened.caseId, actor = { type: "human" as const, staffUserId: APPROVER };
    await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "human_takeover", actor, commandKey: `nat-take-${caseId}`, reason: "fixture" });
    await transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "hand_back", actor, commandKey: `nat-back-${caseId}`, reason: "fixture", to: "agent", admission: ADMITTED });
    const handBack = (await listCaseEvents(caseId)).filter(event => event.kind === "owner_changed").at(-1)!, version = (await readCase(caseId))!.version;
    const base: CaseReplyProposal = { caseId, caseVersion: version, triggerEventId: `inbound:${gmailMessageId}`, inboundMessageId: message!.id, purpose: "answer",
      recipient: "customer@example.invalid", subject: "Synthetic native", text: finalReplyText("SYNTHETIC from B.") };
    return { caseId, byB: base, byOther: { ...base, triggerEventId: `back:${handBack.id}`, text: finalReplyText("SYNTHETIC from the other producer.") } satisfies CaseReplyProposal };
  }
  /** A proposal stored around the guard, as a database written before it could hold it (the table's guard allows a row born `proposed`). */
  async function legacyProposed(caseId: string, proposal: CaseReplyProposal) {
    const [row] = await store.db.insert(savCaseReplyValidations).values({ caseId, replyKey: caseReplyKey(caseId, proposal.triggerEventId), payloadHash: caseReplyPayloadHash(proposal),
      caseVersion: proposal.caseVersion, recipient: proposal.recipient, proposalCiphertext: encryptSavPayload(proposal) }).returning();
    return row!.id;
  }
  const approve = (validationId: string, proposal: CaseReplyProposal) => decideCaseReply({ action: "approve", validationId, approverId: APPROVER, seen: seenOf(proposal), authorizer: allow, deps: storeDeps });
  const approvedOf = async (caseId: string) => (await store.client.query<{ reply_key: string }>("SELECT reply_key FROM sav.case_reply_validations WHERE case_id = $1 AND state = 'approved'", [caseId])).rows;

  beforeAll(async () => {
    validateSavNativeTestTarget(URL_!, TOKEN);
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters");
    vi.stubEnv("SAV_CASE_RECORDING", "on");
    observer = openNativeObserver(URL_!);
    sql = postgres(URL_!, { max: 4, prepare: false, connect_timeout: 5, onnotice: () => {}, connection: { application_name: "codex_sav_validation", statement_timeout: 10000, lock_timeout: 8000 } });
    const [identity] = await sql`select current_setting('codex.test_token', true) as token`;
    if (identity?.token !== TOKEN) throw new Error("SAV_NATIVE_TEST_INSTANCE_REFUSED");
    store = await createSavNativeTestDb(URL_!, TOKEN, { poolMax: 4 });
    state.db = store.db;
    await store.db.insert(staffUsers).values({ id: APPROVER, clerkId: `native-${APPROVER}`, email: `native-${APPROVER}@example.invalid`, name: "Synthetic Native", role: "admin", active: true });
    mailboxId = (await store.db.insert(savMailboxes).values({ email: `native-${randomUUID()}@example.invalid` }).returning())[0]!.id;
  }, 60_000);
  afterAll(async () => { state.db = null; vi.unstubAllEnvs(); await store?.client.close(); await sql?.end({ timeout: 2 }); await observer?.end({ timeout: 2 }); });

  /** X holds the case; `first` queues on it, then `second`; X commits: the two run one after the other in that order, on two real connections. */
  async function overlap(caseId: string, first: () => Promise<unknown>, second: () => Promise<unknown>) {
    const holder = await open();
    try {
      await holder.conn.unsafe("BEGIN");
      await holder.conn.unsafe("SELECT id FROM sav.cases WHERE id = $1 FOR UPDATE", [caseId]);
      const early = settle(first());
      await blockedBy(holder.pid, 1);
      const late = settle(second());
      await blockedBy(holder.pid, 2);
      await holder.conn.unsafe("COMMIT");
      return { early: await early, late: await late };
    } finally { await done(holder); }
  }

  it("two approvals of the two names, queued on the case lock in turn: exactly one is approved, the other is refused as already answered", async () => {
    const run = await scenario();
    const [one, other] = [await legacyProposed(run.caseId, run.byB), await legacyProposed(run.caseId, run.byOther)];
    const { early, late } = await overlap(run.caseId, () => approve(one, run.byB), () => approve(other, run.byOther));
    expect(early, JSON.stringify(early)).toMatchObject({ value: { ok: true, state: "approved", changed: true } });
    expect(late, JSON.stringify(late)).toMatchObject({ value: { ok: false, code: "situation_already_answered" } });
    expect(await approvedOf(run.caseId)).toEqual([{ reply_key: caseReplyKey(run.caseId, run.byB.triggerEventId) }]);
  });

  it("the same race the other way round (the hand-back name first): the first stays the only approved reply", async () => {
    const run = await scenario();
    const [one, other] = [await legacyProposed(run.caseId, run.byB), await legacyProposed(run.caseId, run.byOther)];
    const { early, late } = await overlap(run.caseId, () => approve(other, run.byOther), () => approve(one, run.byB));
    expect(early, JSON.stringify(early)).toMatchObject({ value: { ok: true, state: "approved" } });
    expect(late, JSON.stringify(late)).toMatchObject({ value: { ok: false, code: "situation_already_answered" } });
    expect(await approvedOf(run.caseId)).toEqual([{ reply_key: caseReplyKey(run.caseId, run.byOther.triggerEventId) }]);
  });

  it("an approval and the submission of the other name, queued on the case lock in turn: the submission sees the committed approval and stores nothing", async () => {
    const run = await scenario();
    const first = await submitCaseReplyProposal(run.byB, storeDeps);
    if (!first.ok) throw Error(`SUBMIT_REFUSED:${first.code}`);
    const { early, late } = await overlap(run.caseId, () => approve(first.id, run.byB), () => submitCaseReplyProposal(run.byOther, storeDeps));
    expect(early, JSON.stringify(early)).toMatchObject({ value: { ok: true, state: "approved" } });
    expect(late, JSON.stringify(late)).toMatchObject({ value: { ok: false, code: "situation_already_answered" } });
    const rows = await store.client.query<{ state: string }>("SELECT state FROM sav.case_reply_validations WHERE case_id = $1 ORDER BY created_at, id", [run.caseId]);
    expect(rows.rows.map(row => row.state)).toEqual(["approved"]);
  });

  it("the submission first, the approval second: the new proposal replaces the undecided one, so there is still never more than one live reply for the situation", async () => {
    const run = await scenario();
    const first = await submitCaseReplyProposal(run.byB, storeDeps);
    if (!first.ok) throw Error(`SUBMIT_REFUSED:${first.code}`);
    const { early, late } = await overlap(run.caseId, () => submitCaseReplyProposal(run.byOther, storeDeps), () => approve(first.id, run.byB));
    expect(early, JSON.stringify(early)).toMatchObject({ value: { ok: true, created: true, state: "proposed" } });
    expect(late, JSON.stringify(late)).toMatchObject({ value: { ok: false, code: "not_proposed" } });
    expect(await approvedOf(run.caseId)).toEqual([]);
  });
});
