import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSavNativeTestDb, validateSavNativeTestTarget } from "../../../../test/sav-native-db";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
import { blockedBehind, finishNativeHandle, openNativeHandle, openNativeObserver } from "../../../../test/sav-native-locks";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { openCaseEvent, readCase } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply, submitCaseReplyProposal } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";

// Lock order of the reply store on a REAL Postgres, two connections that truly overlap (PGlite has one connection and cannot deadlock).
// ROOT review of 48e3e8a: `submit` locked CASE then updated VALIDATIONS; `approve` locked the VALIDATION then the CASE: a new proposal racing the approval of the
// proposal it replaces is a cycle, which Postgres resolves by aborting one of the two (SQLSTATE 40P01). The store now locks EXECUTION -> CASE -> VALIDATION everywhere.
// Runs only on the isolated native instance (SAV_TEST_POSTGRES_URL, migrated by the real migrator first); skipped everywhere else. NOT RUN in the session that wrote it:
// no native Postgres was available there. Fresh ids, synthetic data; nothing is deleted (the CI database is shared).
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
type Conn = postgres.ReservedSql;

describe.skipIf(!URL_)("native Postgres: a new proposal and the approval of the one it replaces never deadlock", () => {
  let sql: postgres.Sql, observer: postgres.Sql, store: Awaited<ReturnType<typeof createSavNativeTestDb>>, mailboxId: string;
  const open = () => openNativeHandle(sql);
  // Proof that statements are really waiting behind the holder's lock, not merely slow. Row locks queue: the second waiter waits for the FIRST waiter's tuple lock, not for the
  // holder, so the chain is walked (a direct count never reached two: the six timeouts of the first native run). Observed on a connection of its own.
  const blockedBy = (holder: number, count: number) => blockedBehind(observer, holder, count);
  const done = (...handles: Awaited<ReturnType<typeof open>>[]) => Promise.all(handles.map(handle => finishNativeHandle(observer, handle)));

  /** One case with one stored customer mail, and a first proposal for it that nobody has decided yet. */
  async function scenario() {
    const gmailMessageId = `gm-${randomUUID()}`, ticketId = BigInt(`0x${randomUUID().replace(/-/g, "").slice(0, 24)}`).toString();
    const [thread] = await store.db.insert(savThreads).values({ mailboxId, gmailThreadId: `gt-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning();
    const [message] = await store.db.insert(savMessages).values({
      threadId: thread!.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic native",
      bodyCiphertext: encryptSavPayload({ text: "Synthetic.", headers: { "message-id": "<native@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z"),
    }).returning();
    const { case: opened } = await openCaseEvent({ ticketId, threadId: thread!.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId),
      sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
    const version = (await readCase(opened.caseId))!.version;
    const proposal: CaseReplyProposal = { caseId: opened.caseId, caseVersion: version, triggerEventId: `inbound:${gmailMessageId}`, inboundMessageId: message!.id, purpose: "answer",
      recipient: "customer@example.invalid", subject: "Synthetic native", text: finalReplyText("SYNTHETIC first.") };
    const first = await submitCaseReplyProposal(proposal, storeDeps);
    if (!first.ok) throw Error(`SUBMIT_REFUSED:${first.code}`);
    return { caseId: opened.caseId, proposal, firstId: first.id };
  }

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

  /** The interleaving that used to deadlock, made deterministic: X holds the case; the new proposal (T1) queues on it FIRST; the approval (T2) queues second; X commits. */
  async function interleave(run: { caseId: string; proposal: CaseReplyProposal; firstId: string }) {
    const holder = await open();
    try {
      await holder.conn.unsafe("BEGIN");
      await holder.conn.unsafe("SELECT id FROM sav.cases WHERE id = $1 FOR UPDATE", [run.caseId]);
      const second = { ...run.proposal, text: finalReplyText("SYNTHETIC second, from another producer.") };
      const submitting = submitCaseReplyProposal(second, storeDeps).then(value => ({ value }), (error: Error) => ({ error: error.message }));
      await blockedBy(holder.pid, 1);
      const approving = decideCaseReply({ action: "approve", validationId: run.firstId, approverId: APPROVER,
        seen: { payloadHash: caseReplyPayloadHash(run.proposal), caseVersion: run.proposal.caseVersion, recipient: run.proposal.recipient }, authorizer: allow, deps: storeDeps })
        .then(value => ({ value }), (error: Error) => ({ error: error.message }));
      await blockedBy(holder.pid, 2);
      await holder.conn.unsafe("COMMIT");
      return { submit: await submitting, approve: await approving };
    } finally { await done(holder); }
  }

  it("CONTROL: with the old order (validation row first, case second) this very interleaving is a real deadlock, so the reproduction is sound", async () => {
    const run = await scenario();
    const holder = await open(), early = await open(), late = await open();
    try {
      await holder.conn.unsafe("BEGIN");
      await holder.conn.unsafe("SELECT id FROM sav.cases WHERE id = $1 FOR UPDATE", [run.caseId]);
      // "submit": case first, then the validation rows of the case. Queues on the case first.
      const submitting = (async (conn: Conn) => {
        await conn.unsafe("BEGIN");
        await conn.unsafe("SELECT id FROM sav.cases WHERE id = $1 FOR UPDATE", [run.caseId]);
        await conn.unsafe("UPDATE sav.case_reply_validations SET state = 'superseded' WHERE id = $1", [run.firstId]);
        await conn.unsafe("COMMIT");
      })(early.conn).then(() => "done", async (error: Error) => { await early.conn.unsafe("ROLLBACK"); return error.message; });
      await blockedBy(holder.pid, 1);
      // the old "approve": the validation row first, the case second. Holds the row, queues on the case behind "submit".
      const approving = (async (conn: Conn) => {
        await conn.unsafe("BEGIN");
        await conn.unsafe("SELECT id FROM sav.case_reply_validations WHERE id = $1 FOR UPDATE", [run.firstId]);
        await conn.unsafe("SELECT id FROM sav.cases WHERE id = $1 FOR UPDATE", [run.caseId]);
        await conn.unsafe("COMMIT");
      })(late.conn).then(() => "done", async (error: Error) => { await late.conn.unsafe("ROLLBACK"); return error.message; });
      await blockedBy(holder.pid, 2);
      await holder.conn.unsafe("COMMIT");
      const outcomes = await Promise.all([submitting, approving]);
      expect(outcomes.filter(outcome => /deadlock detected/i.test(outcome))).toHaveLength(1);
    } finally { await done(holder, early, late); }
  });

  it("with the uniform order the same interleaving ends without deadlock: the new proposal wins, the approval of the replaced one is refused as not proposed", async () => {
    const run = await scenario();
    const { submit, approve } = await interleave(run);
    expect(submit, JSON.stringify(submit)).toMatchObject({ value: { ok: true, created: true, state: "proposed" } });
    expect(approve, JSON.stringify(approve)).toMatchObject({ value: { ok: false, code: "not_proposed" } });
    const states = await store.client.query<{ state: string }>("SELECT state FROM sav.case_reply_validations WHERE case_id = $1 ORDER BY created_at, id", [run.caseId]);
    expect(states.rows.map(row => row.state)).toEqual(["superseded", "proposed"]);
  });
});
