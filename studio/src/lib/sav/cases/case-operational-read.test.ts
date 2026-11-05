import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown, decrypts: 0 }));
vi.mock("../crypto", async importOriginal => { const real = await importOriginal<typeof import("../crypto")>(); return { ...real, decryptSavPayload: ((...args: Parameters<typeof real.decryptSavPayload>) => { state.decrypts += 1; return real.decryptSavPayload(...args); }) as typeof real.decryptSavPayload }; });
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { savCaseReplyValidations, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "../intake/execution-policy";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { executeIntakePass } from "../intake/executor";
import type { ExecutionOptions, ExecutorAdapters } from "../intake/execution-types";
import { openCaseEvent, readCase } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { createCaseEffectDriver } from "./case-effect-driver";
import { caseNoteAssociationKey, caseNoteKey, caseReplyPayloadHash, inboundInteractionId, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply, type CaseEffectNote } from "./case-reply-store";
import { readCaseReplyOperationalState, type CaseOperationalView } from "./case-operational-read";
import { CASE_VERIFICATION_READ_LIMIT, classifyEffectVerification } from "./case-effect-verification";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { describeCaseReplyForReview, listCaseEffectsNeedingPerson, proposeCaseReplyFromDraft, queueValidatedCaseReply, type CaseReplyDraftInput } from "./case-runtime-effects";

// SAV-10 (pole C), C9-OPERATIONAL-READ: the read-only state of one reply and of the effects of its execution. REAL PGlite, REAL ledger and stores, the synthetic provider (no socket: `fetch` throws and is asserted unused).
// Nothing here reaches a provider, a model, Gmail, HubSpot or the network. The scaffold is the one of C5-C7 (`case-last-look-fence.test.ts`).
// C-NIGHT-REPLY-RECOVERY-RACCORD: the injectable entrypoints on the REAL executor, ledger, validation store and case store, with the synthetic provider
// (no socket: `fetch` is replaced by an error and its calls are counted). Nothing here reaches a provider, a model, Gmail, HubSpot or the network.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, policyHash: string, environment: Record<string, string | undefined>, options: ExecutionOptions;
let p: ReturnType<typeof executionProvider>, sends = 0, loseAck = false, ticketSeq = 9_600_000;
let counts: Record<string, number> = {};
const POLICY = "policy-r1";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000003" };
const AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: staff.staffUserId, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
// The injectable reader of the CURRENT owner of the ticket (the port under test). `reading` is what the synthetic CRM answers; `asked` records every ticket id it was asked about.
type Reading = "v2" | "human" | "none" | "unknown" | "throw" | "garbage";
let reading: Reading = "v2", asked: string[] = [], onAsk: ((n: number) => Promise<void> | void) | null = null;
const synOwner = async ({ ticketId }: { ticketId: string }) => {
  asked.push(ticketId);
  await onAsk?.(asked.length);
  if (reading === "throw") throw Error("SYN_OWNER_DOWN");
  return reading as never;
};
const driver = () => createCaseEffectDriver({ env: () => environment, readTicketOwner: synOwner, currentPolicyRevision: async () => POLICY });
const setPause = async (agent: "intake" | "v2", level: "actions_paused" | "fully_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, `sav-agent-pause.v1:${agent}`));
  if (level) await f.db.insert(savSyncState).values({ key: `sav-agent-pause.v1:${agent}`, status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent, level, setBy: "fixture@example.invalid", setAt: AT, reason: "release fictive" }) });
};

/** A stored customer mail in a stored thread, an admitted case on it, and the synthetic provider that knows it. The reply text is B's DRAFT: no mention yet. */
async function scenario(purpose: "question" | "answer" = "question") {
  const gmailThreadId = `gmail-thread-${randomUUID()}`, gmailMessageId = `gm-${randomUUID()}`, ticketId = String(++ticketSeq);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({
    threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "Customer@Example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic connection failure",
    bodyCiphertext: encryptSavPayload({ text: "The synthetic connection fails.", headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z"),
  }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  p = executionProvider(); p.setGmail(gmailMessageId, gmailThreadId); p.seedTicket({ id: ticketId });
  sends = 0; loseAck = false; counts = {};
  const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    if (path === "messages/send") sends += 1;
    const result = await p.gmail<T>(mailbox, path, init);
    if (path === "messages/send" && loseAck) throw Error("SAV_TEST_ACK_LOST");
    return result;
  };
  const real = createIntakeExecutorAdapters({ network: p.network, gmailRequest: gmail, gmailPermissions: async () => { }, env: () => environment });
  // Every adapter call is counted: "fully paused, zero provider" is a number, not a claim.
  options = { ...options, adapters: Object.fromEntries(Object.entries(real).map(([name, fn]) =>
    [name, (...args: unknown[]) => { counts[name] = (counts[name] ?? 0) + 1; return (fn as (...a: unknown[]) => unknown)(...args); }])) as unknown as ExecutorAdapters };
  const version = (await readCase(opened.caseId))!.version;
  const draft: CaseReplyDraftInput = {
    caseId: opened.caseId, triggerEventId: `inbound:${gmailMessageId}`, decidedOn: version, language: { code: "en", proven: true },
    reply: purpose === "question"
      ? { purpose: "question", text: "SYNTHETIC reply.\nSignature kept exactly.", question: { id: `in:${gmailMessageId}:q1`, text: "SYNTHETIC question?", factKeys: [] } }
      : { purpose: "answer", text: "SYNTHETIC reply.\nSignature kept exactly." },
  };
  return { caseId: opened.caseId, thread, message, ticketId, gmailMessageId, gmailThreadId, version, draft };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const APPROVER = "20000000-0000-4000-8000-000000000003";
/** The test's own authorizer: the stand-in for the real one that does not exist yet. The code under test never builds one. */
const allowDecision: CaseReplyAuthorizer = () => ({ allowed: true, basis: "fixture.allow" });
const storeDeps = () => ({ env: () => environment, readTicketOwner: synOwner, currentPolicyRevision: async () => POLICY });
const policyArg = () => ({ id: policyId, hash: policyHash });

async function propose(s: Scenario, overrides: Partial<CaseReplyDraftInput> = {}) {
  const result = await proposeCaseReplyFromDraft({ ...s.draft, ...overrides }, storeDeps());
  if (!result.ok) throw Error(`PROPOSE_REFUSED:${result.code}`);
  return result;
}
const storedProposal = async (validationId: string) => decryptSavPayload<CaseReplyProposal>((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId)))[0]!.proposalCiphertext);
const seenOf = (proposal: CaseReplyProposal) => ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient });
async function approve(validationId: string) {
  const proposal = await storedProposal(validationId);
  const decided = await decideCaseReply({ action: "approve", validationId, approverId: APPROVER, seen: seenOf(proposal), authorizer: allowDecision, deps: storeDeps() });
  if (!decided.ok) throw Error(`APPROVE_REFUSED:${decided.code}`);
}
/** proposal -> a person's decision -> queue, all through the entrypoints. */
async function admit(s: Scenario) {
  const proposed = await propose(s);
  await approve(proposed.validationId);
  const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), deps: storeDeps() });
  if (!queued.ok) throw Error(`QUEUE_REFUSED:${queued.code}`);
  return { id: queued.executionId, validationId: proposed.validationId };
}
const run = (id: string, d = driver(), opts: ExecutionOptions = options) => executeIntakePass(id, opts, {}, d);
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
const providerCalls = () => Object.values(counts).reduce((a, b) => a + b, 0);
async function lostAck(s: Scenario) {
  const { id } = await admit(s);
  loseAck = true; expect(await run(id)).toMatchObject({ state: "uncertain" }); loseAck = false;
  expect(sends).toBe(1);
  return id;
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.spyOn(console, "info").mockImplementation(() => { });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  if (!policyId) {
    const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
    state.user = { id: admin!.clerkId, primaryEmailAddress: { emailAddress: admin!.email, verification: { status: "verified" } } };
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
    const policy: ExecutionPolicy = {
      revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
      createdAfter: new Date(Date.now() - 10_000).toISOString(), receivedAfter: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxDossiers: 10, mutations: ["send_case_reply", "append_case_note"], admission: { kind: "automatic" },
    };
    const grant = await approveIntakeExecutionPolicy(policy);
    policyId = grant.id; policyHash = grant.policyHash;
    options = { runtime: {} as never, policy, config: { policyId, policyHash, codeRevision: "a".repeat(40) }, env: () => environment, signal: AbortSignal.timeout(60_000), adapters: undefined as never };
  }
  environment = { SAV_CASE_EFFECTS: "supervised", SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash, SAV_CODE_REVISION: "a".repeat(40), HUBSPOT_ACCESS_TOKEN: "fake" };
  expect(intakeExecutionConfig(environment)).not.toBeNull();
  reading = "v2"; asked = []; onAsk = null;
  // Each test starts from an empty queue: what earlier tests left open is closed (a refused execution is never listed nor claimed).
  await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused' WHERE state NOT IN ('confirmed','refused')");
});
afterEach(async () => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled(); // transport réseau = 0
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setPause("v2", null); await setPause("intake", null);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// C9 helpers
// ---------------------------------------------------------------------------------------------------------------------------------
const TABLES = ["sav.case_effect_executions", "sav.intake_effects", "sav.case_reply_validations", "sav.intake_effect_journal", "sav.case_events", "sav.case_timers", "sav.sync_state", "sav.cases"];
async function snapshot() {
  const out: Record<string, string[]> = {};
  for (const table of TABLES) out[table] = (await f.client.query<{ r: string }>(`select to_jsonb(x)::text as r from ${table} x order by 1`)).rows.map(row => row.r);
  return out;
}
/** Every SQL statement sent while the caller's code runs, whether it goes through the client or through a transaction of it. */
function captureSql() {
  const log: string[] = [];
  const client = f.client as unknown as Record<string, (...a: unknown[]) => unknown>;
  const query = client.query!.bind(f.client), exec = client.exec!.bind(f.client), transaction = client.transaction!.bind(f.client);
  vi.spyOn(client, "query").mockImplementation((sql: unknown, ...rest: unknown[]) => { log.push(String(sql)); return query(sql, ...rest); });
  vi.spyOn(client, "exec").mockImplementation((sql: unknown, ...rest: unknown[]) => { log.push(String(sql)); return exec(sql, ...rest); });
  vi.spyOn(client, "transaction").mockImplementation((callback: unknown) => transaction((tx: Record<string, unknown>) => (callback as (t: unknown) => unknown)(new Proxy(tx, {
    get(target, key) {
      const value = target[key as string];
      if (key === "query" || key === "exec") return (sql: unknown, ...rest: unknown[]) => { log.push(String(sql)); return (value as (...a: unknown[]) => unknown).call(target, sql, ...rest); };
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }))));
  return log;
}
const allow = () => true;
const NOW = () => new Date("2026-11-01T10:00:00.000Z");
const read = (s: { caseId: string }, validationId: string, deps: Parameters<typeof readCaseReplyOperationalState>[1] = { access: allow, now: NOW }) =>
  readCaseReplyOperationalState({ caseId: s.caseId, validationId }, deps);
async function view(s: { caseId: string }, validationId: string): Promise<CaseOperationalView> {
  const result = await read(s, validationId);
  if (!result.ok) throw Error(`READ_REFUSED:${result.code}`);
  return result.view;
}
const AT_OBSERVED = "2026-11-01T10:00:00.000Z";
const setParent = (id: string, parentState: string) => f.client.query("UPDATE sav.case_effect_executions SET state = $1 WHERE id = $2", [parentState, id]);
const setEffect = (key: string, fields: { state?: string; attempts?: number; marker?: boolean; next?: string | null }) => {
  const sets: string[] = [], params: unknown[] = [key];
  const add = (column: string, value: unknown, type: string) => { params.push(value); sets.push(`${column} = $${params.length}::${type}`); };
  if (fields.state !== undefined) add("state", fields.state, "text");
  if (fields.attempts !== undefined) add("reconcile_attempts", fields.attempts, "int");
  if (fields.next !== undefined) add("next_reconcile_at", fields.next, "timestamptz");
  if (fields.marker !== undefined) sets.push(fields.marker ? "dispatched_at = coalesce(dispatched_at, now())" : "dispatched_at = NULL");
  return f.client.query(`UPDATE sav.intake_effects SET ${sets.join(", ")} WHERE business_key = $1`, params);
};
/** Runs `body` with the CHECK constraints of the two ledger tables lifted, then puts them back (NOT VALID: the forged rows stay). A fixture only: it forges what the database itself refuses to hold. */
async function withoutChecks(body: () => Promise<void>) {
  const saved: { table: string; name: string; def: string }[] = [];
  for (const table of ["intake_effects", "case_effect_executions"]) {
    const rows = (await f.client.query<{ name: string; def: string }>(`SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'sav.${table}'::regclass AND contype = 'c'`)).rows;
    for (const row of rows) { await f.client.exec(`ALTER TABLE sav.${table} DROP CONSTRAINT "${row.name}"`); saved.push({ table, ...row }); }
  }
  try { await body(); } finally { for (const row of saved) await f.client.exec(`ALTER TABLE sav.${row.table} ADD CONSTRAINT "${row.name}" ${row.def} NOT VALID`); }
}
const keyOf = async (id: string, kind: string) => ((await f.client.query<{ k: string }>("SELECT business_key AS k FROM sav.intake_effects WHERE execution_id = $1 AND kind = $2", [id, kind])).rows[0]?.k);
/** A ledger row written by the test itself under a given parent, for shapes the executor cannot produce on demand. */
async function putEffect(executionId: string, kind: "reply_send" | "note_create" | "note_associate", key: string, fields: { state?: string; attempts?: number; marker?: boolean } = {}) {
  await f.client.query(
    `INSERT INTO sav.intake_effects (business_key, execution_id, kind, permission, state, intent_hash, intent_ciphertext, reconcile_attempts, dispatched_at)
     VALUES ($1, $2, $3, $4, $5, 'x', 'x', $6, ${fields.marker ?? ((fields.state ?? "planned") !== "planned") ? "now()" : "NULL"})`,
    [key, executionId, kind, kind === "reply_send" ? "send_case_reply" : "append_case_note", fields.state ?? "planned", fields.attempts ?? 0]);
}
const note = (s: Scenario): CaseEffectNote => ({ interactionId: inboundInteractionId(s.gmailMessageId), text: "Synthetic interaction note.", at: "2026-10-30T10:00:00.000Z" });
async function admitWithNote(s: Scenario) {
  const proposed = await propose(s); await approve(proposed.validationId);
  const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), note: note(s), deps: storeDeps() });
  if (!queued.ok) throw Error(`QUEUE_REFUSED:${queued.code}`);
  return { id: queued.executionId, validationId: proposed.validationId };
}
/** An approved, queued execution with no pass run yet and no ledger row: the parent exists, the effects are whatever the test puts there. */
const queuedOnly = (s: Scenario) => admit(s);
const keysDeep = (value: unknown, into = new Set<string>()): Set<string> => { if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { into.add(k); keysDeep(v, into); } return into; };

describe("C9: the read-only operational state of a reply and of its effects", () => {
  describe("access, input and scoping come before any SQL or decrypt", () => {
    it.each([
      ["absent", undefined], ["false", () => false], ["throws", () => { throw Error("SYN_ACCESS_DOWN"); }],
      ["rejects", async () => { throw Error("SYN_ACCESS_DOWN"); }], ["the string 'true'", (() => "true") as never], ["1", (() => 1) as never], ["a promise of undefined", async () => undefined as never],
    ])("access %s: refused with 0 SQL and 0 decrypt, even for a malformed request", async (_name, access) => {
      const s = await scenario("answer"); const { validationId } = await admit(s);
      const log = captureSql(); state.decrypts = 0;
      expect(await read(s, validationId, { access: access as never })).toEqual({ ok: false, code: "access_denied" });
      expect(await readCaseReplyOperationalState({ caseId: "not-a-uuid", validationId: "x" }, { access: access as never })).toEqual({ ok: false, code: "access_denied" });
      expect(await readCaseReplyOperationalState({ caseId: s.caseId, validationId }, {})).toEqual({ ok: false, code: "access_denied" });
      expect(log).toEqual([]); expect(state.decrypts).toBe(0);
    });
    it("a malformed request (after a granted access) is refused with 0 SQL: the case id is REQUIRED", async () => {
      const s = await scenario("answer"); const { validationId } = await admit(s);
      const log = captureSql(); state.decrypts = 0;
      for (const bad of [{ caseId: "", validationId }, { caseId: s.caseId, validationId: "nope" }, { validationId } as never, { caseId: s.caseId } as never, { caseId: 7 as never, validationId }, null as never])
        expect(await readCaseReplyOperationalState(bad, { access: allow })).toEqual({ ok: false, code: "invalid_input" });
      expect(log).toEqual([]); expect(state.decrypts).toBe(0);
    });
    it("another case: not_found, the parent and its effects are never selected, nothing is decrypted", async () => {
      const a = await scenario("answer"), b = await scenario("answer"); const first = await admit(a); await admit(b);
      const log = captureSql(); state.decrypts = 0;
      expect(await read(b, first.validationId)).toEqual({ ok: false, code: "not_found" });
      expect(await read({ caseId: randomUUID() }, first.validationId)).toEqual({ ok: false, code: "not_found" });
      expect(await read(a, randomUUID())).toEqual({ ok: false, code: "not_found" });
      expect(log.filter(sql => /intake_effects|case_effect_executions/i.test(sql))).toEqual([]);
      expect(state.decrypts).toBe(0);
    });
    it("an upper-case id is the same id", async () => {
      const s = await scenario("answer"); const { validationId } = await admit(s);
      const result = await readCaseReplyOperationalState({ caseId: s.caseId.toUpperCase(), validationId: validationId.toUpperCase() }, { access: allow });
      expect(result.ok).toBe(true);
    });
  });

  describe("the read changes nothing and is a repeatable-read, read-only transaction", () => {
    it("tables are identical before and after; the statements are SELECTs only, with no lock and no ciphertext column", async () => {
      const s = await scenario("question"); const id = await lostAck(s);
      const { validationId } = (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.executionId, id)).then(rows => ({ validationId: rows[0]!.id })));
      const before = await snapshot();
      const log = captureSql(); state.decrypts = 0; const callsBefore = providerCalls();
      const result = await read(s, validationId);
      const after = await snapshot();
      expect(result.ok).toBe(true);
      expect(after).toEqual(before);
      expect(log.length).toBeGreaterThan(0); // the capture works, so "no statement" elsewhere means something
      const text = log.join("\n").toLowerCase();
      expect(text).toMatch(/repeatable read/); expect(text).toMatch(/read only/);
      expect(text).not.toMatch(/\b(insert|update|delete|truncate|alter|create)\b|for update|for share|for no key|_ciphertext|set_config|pg_advisory/);
      expect(state.decrypts).toBe(0); expect(providerCalls()).toBe(callsBefore);
    });
    it("the sources of the reader import nothing that decrypts, writes or locks", () => {
      const source = readFileSync(fileURLToPath(new URL("./case-operational-read.ts", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
      expect(source).not.toMatch(/decryptSavPayload|encryptSavPayload|from "\.\.\/crypto"|\.for\(|\.insert\(|\.update\(|\.delete\(|\.execute\(|sql`/);
    });
  });

  describe("the closed answer", () => {
    it("carries no text, recipient, subject, body, cipher, token or id of the mail: only the closed keys", async () => {
      const s = await scenario("question"); const id = await lostAck(s);
      const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.executionId, id));
      const v = await view(s, row!.id);
      expect([...keysDeep(v)].sort()).toEqual([
        "associate", "audit", "auditRequired", "caseId", "complete", "create", "dispatchedAt", "confirmedAt", "effect", "incomplete", "kind", "needsPerson", "nextVerificationAt", "note", "observedAt",
        "parent", "reason", "reconcileAttempts", "reply", "schemaRevision", "state", "status", "validation", "validationId", "verification", "verificationLimit",
      ].sort());
      const json = JSON.stringify(v).toLowerCase();
      for (const forbidden of ["customer@example.invalid", "synthetic reply", "signature kept", "connection failure", "ciphertext", "message-id", "gmail-thread", "gm-", "token", "mime", "support@example"]) expect(json).not.toContain(forbidden);
      expect(v.schemaRevision).toBe("sav-v2-case-operational-read.v1"); expect(v.observedAt).toBe(AT_OBSERVED);
      expect(v.verificationLimit).toBe(CASE_VERIFICATION_READ_LIMIT);
    });
    it("a validation that was never queued: no parent, no recorded effect, no recorded note step, nothing unknown", async () => {
      const s = await scenario("answer"); const proposed = await propose(s);
      expect(await view(s, proposed.validationId)).toMatchObject({
        validation: "proposed", parent: null, reply: { status: "no_recorded_effect", effect: null }, note: { status: "no_recorded_note_effect", create: null, associate: null },
        needsPerson: false, auditRequired: false, complete: true, incomplete: [],
      });
    });
  });

  describe("the reply: uncertain, the limit, and a person", () => {
    it("below the limit: waiting (dates and attempts are the real ones); at and above the limit: a person must look and the orphan date is not a schedule; confirmed: never", async () => {
      const s = await scenario("question"); const id = await lostAck(s);
      const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.executionId, id));
      const key = (await keyOf(id, "reply_send"))!, next = "2026-11-01T10:30:00.000Z";
      for (const attempts of [0, 1, 4]) {
        await setEffect(key, { attempts, next });
        const v = await view(s, row!.id);
        expect(v.reply).toMatchObject({ status: "uncertain", effect: { state: "uncertain", reconcileAttempts: attempts, nextVerificationAt: next, verification: { needsPerson: false, reason: null, audit: "none" } } });
        expect(v.reply.effect!.dispatchedAt).not.toBeNull();
        expect(v.needsPerson).toBe(false);
      }
      for (const attempts of [CASE_VERIFICATION_READ_LIMIT, CASE_VERIFICATION_READ_LIMIT + 2]) {
        await setEffect(key, { attempts, next });
        const v = await view(s, row!.id);
        expect(v.reply.effect).toMatchObject({ state: "uncertain", reconcileAttempts: attempts, nextVerificationAt: null, verification: { needsPerson: true, reason: "verification_limit", audit: "none" } });
        expect(v.needsPerson).toBe(true); expect(v.auditRequired).toBe(false); expect(v.complete).toBe(true);
      }
      expect(sends).toBe(1); // reading resent nothing
      await setEffect(key, { attempts: 0, next: null }); await letReconcile();
      expect(await run(id)).toMatchObject({ state: "confirmed" });
      const done = await view(s, row!.id);
      expect(done).toMatchObject({ reply: { status: "confirmed" }, needsPerson: false, parent: { state: "confirmed" } });
      expect(done.reply.effect!.nextVerificationAt).toBeNull();
      expect(sends).toBe(1);
    });
    it("a parent that ended with a cancellation code shows the code and nothing else; free text in the reason is never passed on", async () => {
      const s = await scenario("answer"); const { id, validationId } = await admit(s);
      await f.client.query("UPDATE sav.case_effect_executions SET state = 'refused', reason = 'SAV_CASE_EFFECT_CANCELLED_NEW_INPUT' WHERE id = $1", [id]);
      expect((await view(s, validationId)).parent).toEqual({ state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT" });
      await f.client.query("UPDATE sav.case_effect_executions SET reason = 'customer@example.invalid said no' WHERE id = $1", [id]);
      expect((await view(s, validationId)).parent).toEqual({ state: "refused", reason: null });
    });
  });

  describe("the note: creation and association are two phases", () => {
    it("a real pass: reply confirmed, note created and associated => confirmed, both phases visible", async () => {
      const s = await scenario("answer"); const { id, validationId } = await admitWithNote(s);
      expect(await run(id)).toMatchObject({ state: "confirmed" });
      const v = await view(s, validationId);
      expect(v).toMatchObject({ reply: { status: "confirmed" }, note: { status: "confirmed", create: { kind: "note_create", state: "confirmed" }, associate: { kind: "note_associate", state: "confirmed" } }, needsPerson: false, complete: true });
    });
    it("a note requested but with no ledger row yet: no_recorded_note_effect, which is NOT 'no note requested' and not 'no note in the CRM'", async () => {
      const s = await scenario("answer"); const { validationId } = await admitWithNote(s);
      expect(await view(s, validationId)).toMatchObject({ reply: { status: "no_recorded_effect" }, note: { status: "no_recorded_note_effect" } });
    });
    it("create confirmed + associate uncertain: a true phase status, the reply is not mixed with it, and the note reaches its own limit", async () => {
      const s = await scenario("answer"); const { id, validationId } = await admitWithNote(s);
      expect(await run(id)).toMatchObject({ state: "confirmed" });
      const assoc = (await keyOf(id, "note_associate"))!;
      await setParent(id, "uncertain"); await setEffect(assoc, { state: "uncertain", attempts: 2, next: "2026-11-01T10:30:00.000Z" });
      let v = await view(s, validationId);
      expect(v.note).toMatchObject({ status: "association_uncertain", create: { state: "confirmed" }, associate: { state: "uncertain", reconcileAttempts: 2, nextVerificationAt: "2026-11-01T10:30:00.000Z", verification: { needsPerson: false } } });
      expect(v.reply.status).toBe("confirmed"); expect(v.needsPerson).toBe(false);
      await setEffect(assoc, { attempts: CASE_VERIFICATION_READ_LIMIT });
      v = await view(s, validationId);
      expect(v.note.associate).toMatchObject({ nextVerificationAt: null, verification: { needsPerson: true, reason: "verification_limit" } });
      expect(v).toMatchObject({ needsPerson: true, reply: { status: "confirmed", effect: { verification: { needsPerson: false } } }, note: { status: "association_uncertain" } });
    });
    it.each([
      ["planned", null, "creation_pending"], ["dispatched", null, "creation_uncertain"], ["acked", null, "creation_uncertain"], ["uncertain", null, "creation_uncertain"],
      ["confirmed", null, "created_association_pending"], ["confirmed", "planned", "created_association_pending"], ["confirmed", "dispatched", "association_uncertain"],
      ["confirmed", "acked", "association_uncertain"], ["confirmed", "uncertain", "association_uncertain"], ["confirmed", "confirmed", "confirmed"],
      ["planned", "planned", "unknown"], ["uncertain", "confirmed", "unknown"],
    ] as const)("create %s + associate %s => %s", async (create, associate, expected) => {
      const s = await scenario("answer"); const { id, validationId } = await queuedOnly(s);
      await putEffect(id, "note_create", caseNoteKey(s.caseId, "inbound:syn"), { state: create });
      if (associate) await putEffect(id, "note_associate", caseNoteAssociationKey(s.caseId, "inbound:syn"), { state: associate });
      expect((await view(s, validationId)).note.status).toBe(expected);
    });
    it("an association with no creation, or two different interactions, is unknown (never a made-up phase)", async () => {
      const a = await scenario("answer"), b = await scenario("answer"); const one = await queuedOnly(a), two = await queuedOnly(b);
      await putEffect(one.id, "note_associate", caseNoteAssociationKey(a.caseId, "inbound:syn"), { state: "confirmed" });
      expect(await view(a, one.validationId)).toMatchObject({ note: { status: "unknown" } });
      await putEffect(two.id, "note_create", caseNoteKey(b.caseId, "inbound:one"), { state: "confirmed" });
      await putEffect(two.id, "note_associate", caseNoteAssociationKey(b.caseId, "inbound:two"), { state: "confirmed" });
      expect(await view(b, two.validationId)).toMatchObject({ note: { status: "unknown" }, complete: false, incomplete: expect.arrayContaining(["note_pair_inconsistent"]) });
    });
  });

  describe("foreign rows with a similar key are preserved and never shown", () => {
    it("same prefix under another parent, another case's key under this parent, and a non-canonical reply key: untouched, not in the answer, flagged", async () => {
      const a = await scenario("answer"), b = await scenario("answer"); const mine = await queuedOnly(a), other = await queuedOnly(b);
      await putEffect(mine.id, "reply_send", (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, mine.validationId)))[0]!.replyKey, { state: "uncertain", attempts: 1 });
      await putEffect(other.id, "note_create", caseNoteKey(a.caseId, "inbound:foreign"), { state: "uncertain", attempts: 9 }); // a's prefix, but under b's parent
      await putEffect(mine.id, "note_create", caseNoteKey(b.caseId, "inbound:alien"), { state: "uncertain", attempts: 9 }); // b's case, under a's parent
      await putEffect(mine.id, "note_associate", `${caseNoteAssociationKey(a.caseId, "inbound:x")}\n`, { state: "uncertain", attempts: 9 }); // not canonical
      const before = await snapshot();
      const v = await view(a, mine.validationId);
      expect(await snapshot()).toEqual(before);
      expect(v.reply).toMatchObject({ status: "uncertain", effect: { reconcileAttempts: 1 } });
      expect(v.note).toEqual({ status: "no_recorded_note_effect", create: null, associate: null });
      expect(v).toMatchObject({ needsPerson: false, complete: false, incomplete: ["unexpected_effect"] });
      const foreign = await view(b, other.validationId);
      expect(foreign.note.create).toBeNull(); expect(foreign.incomplete).toContain("unexpected_effect");
    });
  });

  describe("a reply effect under the parent with another key is not THIS reply", () => {
    it("a reply_send whose key is not the validation's: not shown, not counted, flagged; the canonical one next to it is the reply", async () => {
      const s = await scenario("answer"); const { id, validationId } = await queuedOnly(s);
      const replyKey = (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId)))[0]!.replyKey;
      await putEffect(id, "reply_send", `reply:${s.caseId}:inbound:another-trigger`, { state: "uncertain", attempts: 9 });
      let v = await view(s, validationId);
      expect(v).toMatchObject({ reply: { status: "no_recorded_effect", effect: null }, needsPerson: false, complete: false, incomplete: ["unexpected_effect"] });
      await putEffect(id, "reply_send", replyKey, { state: "uncertain", attempts: 1 });
      v = await view(s, validationId);
      expect(v.reply).toMatchObject({ status: "uncertain", effect: { reconcileAttempts: 1 } }); expect(v.needsPerson).toBe(false); expect(v.incomplete).toEqual(["unexpected_effect"]);
    });
  });

  describe("unreadable, malformed and contradictory sources are unknown or unavailable, never an empty list", () => {
    it("a database that cannot be read: unavailable, with no error text", async () => {
      const s = await scenario("answer"); const { validationId } = await admit(s);
      const real = state.db;
      state.db = new Proxy({}, { get: () => () => Promise.reject(Error("SYN_DB_DOWN customer@example.invalid")) });
      try { expect(await read(s, validationId)).toEqual({ ok: false, code: "unavailable" }); } finally { state.db = real; }
      const none = await captureAndRead(s, validationId); expect(none.ok).toBe(true);
    });
    it("a parent of another reply key (or another case) is not trusted: unknown, its effects are not selected", async () => {
      const s = await scenario("answer"); const { id, validationId } = await admit(s);
      await putEffect(id, "reply_send", (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId)))[0]!.replyKey, { state: "uncertain", attempts: 9 });
      await f.client.query("UPDATE sav.case_effect_executions SET reply_key = $2 WHERE id = $1", [id, `reply:${s.caseId}:inbound:other`]);
      const log = captureSql();
      const v = await view(s, validationId);
      expect(v).toMatchObject({ parent: { state: "unknown", reason: null }, reply: { status: "unknown", effect: null }, note: { status: "unknown" }, needsPerson: false, complete: false, incomplete: ["parent_unreadable"] });
      expect(log.filter(sql => /intake_effects/i.test(sql))).toEqual([]);
    });
    it("a parent state outside the vocabulary: unknown", async () => {
      const s = await scenario("answer"); const { id, validationId } = await admit(s);
      await withoutChecks(async () => {
        await setParent(id, "mystery");
        expect(await view(s, validationId)).toMatchObject({ parent: { state: "unknown" }, complete: false, incomplete: ["parent_unreadable"] });
      });
    });
    it("an effect with a state outside the vocabulary, a negative count or a ledger state of another vocabulary is unknown and never 'nothing to do'", async () => {
      const shapes = [["mystery", 9], ["failed", 9], ["uncertain", -3]] as const;
      for (const [state, attempts] of shapes) {
        const s = await scenario("answer"); const { id, validationId } = await queuedOnly(s);
        const replyKey = (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId)))[0]!.replyKey;
        await putEffect(id, "reply_send", replyKey, { state: "uncertain", attempts: 1 });
        await withoutChecks(async () => { await setEffect(replyKey, { state, attempts }); });
        expect(await view(s, validationId)).toMatchObject({ reply: { status: "unknown", effect: null }, needsPerson: false, complete: false, incomplete: ["unreadable_value"] });
      }
    });
    it("a finished parent with an engaged effect, or an engaged effect with no marker: needs_audit, reported not repaired, and NOT 'a person must look' by the scheduler's rule", async () => {
      const a = await scenario("question"); const idA = await lostAck(a);
      const [va] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.executionId, idA));
      const b = await scenario("question"); const second = await lostAck(b);
      const [vb] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.executionId, second));
      await setEffect((await keyOf(idA, "reply_send"))!, { attempts: 9 }); await setParent(idA, "refused");
      const finished = await view(a, va!.id);
      expect(finished).toMatchObject({ auditRequired: true, needsPerson: false, complete: false, incomplete: ["contradiction"], reply: { status: "unknown", effect: { verification: { needsPerson: false, reason: null, audit: "needs_audit" }, nextVerificationAt: null } } });
      expect(finished.parent).toMatchObject({ state: "refused" });
      expect((await listCaseEffectsNeedingPerson(50)).map(row => row.executionId)).not.toContain(idA);
      await setEffect((await keyOf(second, "reply_send"))!, { attempts: 9, marker: false }); await setParent(second, "uncertain");
      expect(await view(b, vb!.id)).toMatchObject({ auditRequired: true, needsPerson: false, reply: { status: "unknown", effect: { verification: { audit: "needs_audit", needsPerson: false } } } });
      expect((await listCaseEffectsNeedingPerson(50)).map(row => row.executionId)).not.toContain(second);
      expect(sends).toBe(1); // (the counter restarts with each scenario) nothing was resent, reset or released
    });
  });

  describe("one rule: the reader, the scheduler's listing and the review say the same thing", () => {
    it("across parent states, effect states, marker and attempts the three agree with the pure classifier", async () => {
      const s = await scenario("question"); const id = await lostAck(s);
      const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.executionId, id));
      const key = (await keyOf(id, "reply_send"))!;
      let checked = 0, needing = 0;
      for (const parent of ["pending", "running", "waiting", "uncertain", "confirmed", "refused"]) for (const effect of ["planned", "dispatched", "acked", "uncertain", "confirmed"])
        for (const marker of [true, false]) for (const attempts of [CASE_VERIFICATION_READ_LIMIT - 1, CASE_VERIFICATION_READ_LIMIT, CASE_VERIFICATION_READ_LIMIT + 3]) {
          await setParent(id, parent); await setEffect(key, { state: effect, attempts, marker });
          const verdict = classifyEffectVerification({ executionState: parent, effectState: effect, dispatchedAt: marker ? new Date() : null, reconcileAttempts: attempts });
          const v = await view(s, row!.id);
          const listed = (await listCaseEffectsNeedingPerson(50)).some(item => item.executionId === id);
          const reviewed = await describeCaseReplyForReview({ validationId: row!.id, caseId: s.caseId, access: allow, env: () => environment });
          expect(reviewed.ok).toBe(true);
          const label = `${parent}/${effect}/${marker}/${attempts}`;
          expect({ label, reader: v.needsPerson }).toEqual({ label, reader: verdict === "needs_person" });
          expect({ label, listed }).toEqual({ label, listed: verdict === "needs_person" });
          expect({ label, reviewed: reviewed.ok && reviewed.view.needsPerson }).toEqual({ label, reviewed: verdict === "needs_person" });
          expect({ label, audit: v.auditRequired }).toEqual({ label, audit: verdict === "needs_audit" });
          checked += 1; if (verdict === "needs_person") needing += 1;
        }
      expect(checked).toBe(180); expect(needing).toBe(4 * 3 * 2); // open parents (4) x engaged effects (3) x limit and above (2 counts); markers present
      expect(sends).toBe(1);
    });
    it("the limit is ONE number: the recovery listing, the verification driver and the V1 ledger recovery read the same 5", () => {
      const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      expect(CASE_VERIFICATION_READ_LIMIT).toBe(5);
      expect(read("./case-effect-recovery.ts")).toMatch(/lt\(savIntakeEffects\.reconcileAttempts, 5\)/);
      expect(read("./case-effect-driver.ts")).toMatch(/effect\.reconcileAttempts < 5/);
      expect(read("../intake/executor.ts")).toMatch(/reconcileAttempts\}<5/);
      expect(read("./case-runtime-effects.ts")).toMatch(/gte\(savIntakeEffects\.reconcileAttempts, CASE_VERIFICATION_READ_LIMIT\)/);
      expect(read("./case-runtime-effects.ts")).not.toMatch(/reconcileAttempts >= 5/);
    });
  });
});

async function captureAndRead(s: { caseId: string }, validationId: string) { return read(s, validationId); }
