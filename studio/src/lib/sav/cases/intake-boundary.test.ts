import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// The real executor must never be loaded here: every test injects its progress reader.
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
import { encryptSavPayload } from "../crypto";
import { claimCaseForDecision, listCaseEvents, openCaseEvent, readCase, readCaseByTicket, updateCaseRecord } from "./case-store";
import { caseAdmissionStatus } from "./admission-policy";
import { caseDedupeKey, caseRequestSearchText, caseRequestSubject, emptyCaseBody, type CaseAdmissionQualification } from "./case-types";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { SAV_INTAKE_SIMPLE_REVISION } from "../intake/simple-revision";
import { classifyCaseExit } from "./case-outcomes";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { admissionQualificationFromIntake, caseSensitivityOf, readIntakeAcknowledgement, recordCaseAfterConfirmedIntake, sweepCaseRelays } from "./intake-boundary";

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, seq = 8_200_000;
type Kind = "support" | "finance" | "cancellation" | "commercial" | "unknown";
const RECEIVED = "2026-10-27T07:30:00.000Z";

async function intake(options: { state?: string; ticketId?: string | null; classification?: Kind; requests?: Kind[]; direction?: "inbound" | "outbound"; gmail?: string | null; threadId?: string; subject?: string; text?: string } = {}) {
  const threadId = options.threadId ?? randomUUID(), messageId = randomUUID(), ticketId = options.ticketId === undefined ? String(++seq) : options.ticketId;
  if (!options.threadId) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: "client@example.invalid" });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: options.direction ?? "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"], subject: options.subject ?? "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: options.text ?? "Corps synthétique" }), receivedAt: new Date(RECEIVED), gmailMessageId: options.gmail === undefined ? `gm-${messageId}` : options.gmail });
  const classification = options.classification ?? "support";
  const payload = { plan: { decision: { classification, requests: (options.requests ?? [classification]).map((kind, i) => ({ id: `r${i}`, kind })) } } };
  await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion: 1, policyId, policyHash: "fixture", state: options.state ?? "confirmed", ticketId, payloadCiphertext: encryptSavPayload(payload) });
  return { messageId, threadId, ticketId: ticketId ?? "" };
}
const confirmed = (ticketId: string | null, isConfirmed = true, state = "confirmed") => ({ readProgress: vi.fn(async () => ({ state, ticketId, confirmed: isConfirmed })) });

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "intake-boundary-fixture-key-32-characters");
  f = await createSavTestDb(); state.db = f.db;
  // Fresh unique values: the CI's native step runs several files on one shared database, where fixed emails collide.
  const run = randomUUID();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: `synthetic-case-admin-${run}`, email: `case-admin-${run}@example.invalid`, role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-${run}@example.invalid` }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "intake-boundary-fixture-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("recordCaseAfterConfirmedIntake", () => {
  it("does nothing, not even a progress read, while the switch is off", async () => {
    const source = await intake(), deps = confirmed(source.ticketId);
    vi.stubEnv("SAV_CASE_RECORDING", "off");
    expect(await recordCaseAfterConfirmedIntake(source.messageId, deps)).toEqual({ skipped: "recording_off" });
    expect(deps.readProgress).not.toHaveBeenCalled();
    expect(await readCaseByTicket(source.ticketId)).toBeNull();
  });
  it("creates nothing for a plan, a running pass or partially confirmed effects", async () => {
    for (const [execution, progress] of [["pending", confirmed(null, false, "pending")], ["running", confirmed(null, false, "running")], ["uncertain", confirmed(null, false, "uncertain")]] as const) {
      const source = await intake({ state: execution });
      expect(await recordCaseAfterConfirmedIntake(source.messageId, progress)).toEqual({ skipped: "intake_not_confirmed" });
      expect(await readCaseByTicket(source.ticketId)).toBeNull();
    }
    // Execution row says confirmed but the strict progress (all required effects) does not.
    const partial = await intake();
    expect(await recordCaseAfterConfirmedIntake(partial.messageId, confirmed(partial.ticketId, false))).toEqual({ skipped: "intake_not_confirmed" });
    // Progress says confirmed but the durable row disagrees (state or ticket).
    const running = await intake({ state: "running" });
    expect(await recordCaseAfterConfirmedIntake(running.messageId, confirmed(running.ticketId))).toEqual({ skipped: "intake_not_confirmed" });
    const other = await intake();
    expect(await recordCaseAfterConfirmedIntake(other.messageId, confirmed("9999999"))).toEqual({ skipped: "intake_not_confirmed" });
    expect(await readCaseByTicket(other.ticketId)).toBeNull();
    expect(await readCaseByTicket("9999999")).toBeNull();
  });
  it("creates exactly one case for a confirmed intake, for the team while nothing admits it; replaying the wake creates nothing new", async () => {
    const source = await intake();
    const first = await recordCaseAfterConfirmedIntake(source.messageId, confirmed(source.ticketId));
    expect(first).toMatchObject({ created: true, appended: true, version: 3, owner: "human",
      admission: { target: "qualification", reasons: ["policy_missing", "family_unknown", "identity_unconfirmed", "context_incomplete"] } });
    expect(await recordCaseAfterConfirmedIntake(source.messageId, confirmed(source.ticketId))).toMatchObject({ created: false, appended: false, version: 3 });
    const events = await listCaseEvents((first as { caseId: string }).caseId);
    expect(events.map(e => [e.kind, e.sourceRef, e.direction])).toEqual([
      ["inbound_confirmed", { type: "email", id: `gm-${source.messageId}` }, "customer_inbound"], ["admission_decided", { type: "email", id: `gm-${source.messageId}` }, "internal"],
    ]);
    expect(events[0]!.occurredAt).toBe(RECEIVED);
    expect((await readCaseByTicket(source.ticketId))!).toMatchObject({ owner: "human", phase: "handoff_pending" });
  });
  it("never admits from an intake category, even when a policy exists", async () => {
    const source = await intake();
    const policy = { revision: "policy-r1", admittedFamilies: ["access", "usage"], qualifiedRules: [], approvedBy: "20000000-0000-4000-8000-000000000001", approvedAt: RECEIVED };
    const result = await recordCaseAfterConfirmedIntake(source.messageId, { ...confirmed(source.ticketId), readAdmissionPolicy: async () => policy });
    expect(result).toMatchObject({ owner: "human", admission: { target: "qualification", reasons: ["family_unknown", "identity_unconfirmed", "context_incomplete"] } });
    expect(admissionQualificationFromIntake({ classification: "support", requests: [{ id: "r0", kind: "support" }, { id: "r1", kind: "finance" }] } as never, "gm-x").requests.map(r => [r.family, r.provenance.kind]))
      .toEqual([["unknown", "intake_hint"], ["finance", "intake_hint"]]);
    expect(admissionQualificationFromIntake({ classification: "cancellation", requests: [] } as never, "gm-y").requests.map(r => r.family)).toEqual(["cancellation"]);
  });
  it("appends one event for a confirmed customer reply on the same ticket", async () => {
    const first = await intake(), reply = await intake({ ticketId: first.ticketId, threadId: first.threadId });
    await recordCaseAfterConfirmedIntake(first.messageId, confirmed(first.ticketId));
    const second = await recordCaseAfterConfirmedIntake(reply.messageId, confirmed(reply.ticketId));
    // v4: on an existing case the relay records a new admission only for an exclusion, so
    // a plain reply adds its event (version 4) and leaves the admission stale.
    expect(second).toMatchObject({ created: false, appended: true, version: 4, relay: "intake_effects_confirmed" });
    expect((await readCaseByTicket(first.ticketId))!.threadIds).toEqual([first.threadId]);
  });
  it("records finance and cancellation as human-owned, including a sensitive request inside a support mail", async () => {
    const finance = await intake({ classification: "finance" });
    expect(await recordCaseAfterConfirmedIntake(finance.messageId, confirmed(finance.ticketId))).toMatchObject({ created: true, owner: "human", admission: { target: "team" } });
    expect((await readCaseByTicket(finance.ticketId))!).toMatchObject({ sensitivity: "finance", phase: "handoff_pending" });
    const mixed = await intake({ classification: "support", requests: ["support", "cancellation"] });
    expect(await recordCaseAfterConfirmedIntake(mixed.messageId, confirmed(mixed.ticketId))).toMatchObject({ owner: "human", admission: { target: "team", reasons: ["sensitive_family", "mixed_sensitive", "policy_missing", "family_unknown", "identity_unconfirmed", "context_incomplete"] } });
    expect((await readCaseByTicket(mixed.ticketId))!.sensitivity).toBe("cancellation");
    expect(caseSensitivityOf({ classification: "support", requests: [{ kind: "finance" }, { kind: "cancellation" }] } as never)).toBe("cancellation");
  });
  it("skips an outbound or Gmail-less source instead of inventing a key", async () => {
    const outbound = await intake({ direction: "outbound" }), noGmail = await intake({ gmail: null });
    expect(await recordCaseAfterConfirmedIntake(outbound.messageId, confirmed(outbound.ticketId))).toEqual({ skipped: "source_missing" });
    expect(await recordCaseAfterConfirmedIntake(noGmail.messageId, confirmed(noGmail.ticketId))).toEqual({ skipped: "source_missing" });
  });
});

const STAFF = "20000000-0000-4000-8000-000000000001";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access", "usage"], qualifiedRules: [], approvedBy: STAFF, approvedAt: RECEIVED };
const ADMITTED = { policy: POLICY, qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: RECEIVED } }],
  identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] } };
/** A customer message with no V1 execution at all, as for an acknowledgement. */
async function bareMessage(threadId: string, receivedAt = "2026-10-27T09:30:00.000Z") {
  const messageId = randomUUID();
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"], subject: "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Merci, ça fonctionne (synthétique)" }), receivedAt: new Date(receivedAt), gmailMessageId: `gm-${messageId}` });
  return messageId;
}
const ACK = { classification: "acknowledgement", requests: [] } as never;
let runSeq = 100;
/** An accepted V1 analysis row for the message (the relay re-reads it under lock); the reader itself is injected. */
async function ackRun(messageId: string) {
  const [message] = await f.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  const version = ++runSeq;
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId: message!.threadId, messageId, version, isCurrent: false, state: "observed", configHash: `ack-${version}`, policyHash: "fixture",
    sourceHash: "source-hash-fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  return { runId: run!.id, runVersion: version, sourceHash: "source-hash-fixture", decision: ACK };
}
const acknowledged = () => vi.fn(async (messageId: string) => ackRun(messageId));
const noProgress = { readProgress: vi.fn(async () => null) };
/** An agent case admitted by a human qualification, created on the thread of a confirmed intake. */
async function agentCase() {
  const source = await intake();
  const { case: c } = await openCaseEvent({ ticketId: source.ticketId, threadId: source.threadId, admission: ADMITTED, kind: "inbound_confirmed",
    dedupeKey: caseDedupeKey.inbound(`gm-${source.messageId}`), sourceRef: { type: "email", id: `gm-${source.messageId}` }, occurredAt: RECEIVED });
  return { source, c };
}

describe("relay without a new CRM effect (SAV-11, contract v4)", () => {
  it("feeds a « merci » to the existing case through its thread, with no execution, receipt or new admission", async () => {
    const { source, c } = await agentCase(), messageId = await bareMessage(source.threadId), readAcknowledgement = acknowledged();
    const result = await recordCaseAfterConfirmedIntake(messageId, { ...noProgress, readAcknowledgement });
    expect(result).toMatchObject({ caseId: c.caseId, created: false, appended: true, version: c.version + 1, owner: "agent", relay: "acknowledgement_on_case_thread" });
    const event = (await listCaseEvents(c.caseId)).at(-1)!;
    expect(event).toMatchObject({ kind: "inbound_confirmed", direction: "customer_inbound", dedupeKey: `inbound:gm-${messageId}`, occurredAt: "2026-10-27T09:30:00.000Z" });
    expect(event.detail).toMatchObject({ messageId, relay: { kind: "acknowledgement_on_case_thread", messageId, intakeRunVersion: runSeq, sourceHash: "source-hash-fixture" } });
    expect(await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId))).toEqual([]);
    expect(await f.db.select({ id: savIntakeEffects.id }).from(savIntakeEffects).innerJoin(savIntakeExecutions, eq(savIntakeExecutions.id, savIntakeEffects.executionId)).where(eq(savIntakeExecutions.messageId, messageId))).toEqual([]);
    // Still the agent's, but nobody acts on the old admission until it is re-evaluated.
    const after = (await readCaseByTicket(source.ticketId))!;
    expect(after.admission!.version).toBe(c.admission!.version);
    expect(caseAdmissionStatus(after, "policy-r1")).toEqual({ admitted: false, reason: "input_newer" });
    // Replayed wake: same (case, message), nothing new, even with a second accepted run.
    expect(await recordCaseAfterConfirmedIntake(messageId, { ...noProgress, readAcknowledgement })).toMatchObject({ appended: false, version: c.version + 1 });
  });
  it("keeps a human case human on an acknowledgement and refuses to guess a case", async () => {
    const human = await intake();
    await recordCaseAfterConfirmedIntake(human.messageId, confirmed(human.ticketId));
    const ack = await bareMessage(human.threadId);
    expect(await recordCaseAfterConfirmedIntake(ack, { ...noProgress, readAcknowledgement: acknowledged() })).toMatchObject({ appended: true, owner: "human" });
    expect((await readCaseByTicket(human.ticketId))!).toMatchObject({ owner: "human", phase: "handoff_pending" });
    const [orphanThread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `thread-${randomUUID()}`, subject: "Synthétique", customerEmail: "client@example.invalid" }).returning();
    expect(await recordCaseAfterConfirmedIntake(await bareMessage(orphanThread!.id), { ...noProgress, readAcknowledgement: acknowledged() })).toEqual({ skipped: "no_case_for_thread" });
    expect(await recordCaseAfterConfirmedIntake(await bareMessage(human.threadId), { ...noProgress, readAcknowledgement: vi.fn(async () => null) })).toEqual({ skipped: "intake_not_confirmed" });
    expect(await recordCaseAfterConfirmedIntake(await bareMessage(human.threadId, "2026-10-27T07:00:00.000Z"), { ...noProgress, readAcknowledgement: acknowledged() })).toEqual({ skipped: "before_case" });
    // A thread linked to two tickets gives no single case to feed.
    const other = await intake({ threadId: human.threadId });
    await recordCaseAfterConfirmedIntake(other.messageId, confirmed(other.ticketId));
    expect(await recordCaseAfterConfirmedIntake(await bareMessage(human.threadId), { ...noProgress, readAcknowledgement: acknowledged() })).toEqual({ skipped: "thread_case_ambiguous" });
  });
  it("never relays an uncertain or partly confirmed V1 effect, and never falls back to the acknowledgement path", async () => {
    const { source } = await agentCase();
    const pending = await intake({ ticketId: source.ticketId, threadId: source.threadId, state: "running" });
    const readAcknowledgement = acknowledged();
    const uncertain = { readProgress: vi.fn(async () => ({ state: "uncertain", ticketId: null, confirmed: false, effects: [{ kind: "email_create", state: "uncertain" }] })), readAcknowledgement };
    expect(await recordCaseAfterConfirmedIntake(pending.messageId, uncertain)).toEqual({ skipped: "intake_not_confirmed" });
    expect(readAcknowledgement).not.toHaveBeenCalled();
  });
  it("applies exclusions at once on an agent case and otherwise leaves the admission stale", async () => {
    const { source, c } = await agentCase();
    const refund = await intake({ ticketId: source.ticketId, threadId: source.threadId, classification: "finance" });
    expect(await recordCaseAfterConfirmedIntake(refund.messageId, confirmed(source.ticketId))).toMatchObject({ owner: "human",
      admission: { target: "team", reasons: ["sensitive_family", "policy_missing", "identity_unconfirmed", "context_incomplete"] } });
    expect((await readCaseByTicket(source.ticketId))!).toMatchObject({ sensitivity: "finance", phase: "handoff_pending" });
    expect((await listCaseEvents(c.caseId)).map(e => e.kind)).toEqual(["inbound_confirmed", "admission_decided", "inbound_confirmed", "admission_decided", "owner_changed"]);
  });
});

describe("durable catch-up after a crash between V1 confirmation and the wake", () => {
  it("relays confirmed intakes and acknowledgements found in V1 records once, with no network call", async () => {
    const fetchSpy = vi.fn(() => { throw Error("NETWORK_NOT_ALLOWED"); });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      // Crash: V1 confirmed both, nothing reached the case.
      const created = await intake(), { source } = await agentCase();
      const reply = await intake({ ticketId: source.ticketId, threadId: source.threadId });
      const ack = await bareMessage(source.threadId);
      const ackProof = await ackRun(ack);
      const progress = vi.fn(async (messageId: string) => {
        const [row] = await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId));
        return row ? { state: row.state, ticketId: row.ticketId, confirmed: row.state === "confirmed", effects: [{}] } : null;
      });
      const deps = { readProgress: progress, readAcknowledgement: vi.fn(async (id: string) => id === ack ? ackProof : null) };
      const first = await sweepCaseRelays({ limit: 200, deps });
      expect(first).toMatchObject({ relayed: expect.any(Number) });
      expect((await readCaseByTicket(created.ticketId))).not.toBeNull();
      const keys = (await listCaseEvents((await readCaseByTicket(source.ticketId))!.caseId)).map(e => e.dedupeKey);
      expect(keys).toEqual(expect.arrayContaining([`inbound:gm-${reply.messageId}`, `inbound:gm-${ack}`]));
      expect(keys.filter(k => k === `inbound:gm-${ack}`)).toHaveLength(1);
      const again = await sweepCaseRelays({ limit: 200, deps });
      expect(again).toMatchObject({ relayed: 0 });
      expect((await listCaseEvents((await readCaseByTicket(source.ticketId))!.caseId)).map(e => e.dedupeKey)).toEqual(keys);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("does nothing while the switch is off", async () => {
    vi.stubEnv("SAV_CASE_RECORDING", "off");
    expect(await sweepCaseRelays({ deps: noProgress })).toEqual({ skipped: "recording_off" });
  });
});

describe("readIntakeAcknowledgement, against V1 tables", () => {
  it("accepts only the latest accepted acknowledgement analysis whose sources still match", async () => {
    const { savIntakeSourceSnapshot } = await import("../intake/runtime-store");
    const { source } = await agentCase(), messageId = await bareMessage(source.threadId);
    const [message] = await f.db.select().from(savMessages).where(eq(savMessages.id, messageId));
    const snapshot = await f.db.transaction(async tx => savIntakeSourceSnapshot(tx as never, message!, new Date()));
    const plan = (reason: string) => ({ revision: "fixture", plan: { decision: { classification: "acknowledgement", requests: [], disposition: { kind: "no_ticket", reason } } } });
    const [run] = await f.db.insert(savIntakeRuns).values({ threadId: source.threadId, messageId, version: 11, isCurrent: false, state: "observed", configHash: "c1", policyHash: "fixture",
      sourceHash: snapshot.sourceHash, payloadCiphertext: encryptSavPayload(plan("acknowledgement_only")) }).returning();
    expect(await readIntakeAcknowledgement(messageId)).toMatchObject({ runId: run!.id, runVersion: 11, sourceHash: snapshot.sourceHash });
    const relayed = await recordCaseAfterConfirmedIntake(messageId, noProgress);
    expect(relayed).toMatchObject({ appended: true, relay: "acknowledgement_on_case_thread" });
    // Stale sources, another disposition or a non-accepted run prove nothing.
    for (const [state, reason, hash, version] of [["observed", "acknowledgement_only", "other-hash", 12], ["observed", "qualified_other", snapshot.sourceHash, 13], ["waiting", "acknowledgement_only", snapshot.sourceHash, 14]] as const) {
      const other = await bareMessage(source.threadId);
      await f.db.insert(savIntakeRuns).values({ threadId: source.threadId, messageId: other, version, isCurrent: false, state, configHash: `c${version}`, policyHash: "fixture",
        sourceHash: hash, payloadCiphertext: encryptSavPayload(plan(reason)) });
      expect(await readIntakeAcknowledgement(other)).toBeNull();
    }
  });
});

describe("relay feeds the case memory B reads (contract v8, integration findings of 28/10)", () => {
  const RULE_POLICY = { revision: "policy-r1", admittedFamilies: ["usage"], qualifiedRules: [{ ruleId: "rule-usage", revision: "r1", families: ["usage"] }], approvedBy: STAFF, approvedAt: RECEIVED };
  /** A qualification port as a future approved rule would give it: never injected in production. */
  const byRule = (family: "usage" | "telephony" = "usage", ruleId = "rule-usage") => vi.fn(async (input: { requests: { requestId: string }[] }): Promise<CaseAdmissionQualification> => ({
    requests: input.requests.map(request => ({ requestId: request.requestId, family, provenance: { kind: "qualified_rule" as const, ruleId, revision: "r1", at: RECEIVED } })),
    identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [],
  }));
  const qualifiedDeps = (ticketId: string, readQualification = byRule()) => ({ ...confirmed(ticketId), readAdmissionPolicy: async () => RULE_POLICY, readQualification });
  const V2_OWNER = "90000001", V2_ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" };
  /** The V1 ledger row an `owner_assign` effect leaves, as the executor writes it. */
  async function ownerEffect(messageId: string, ticketId: string, options: { state?: string; owner?: string; ticketId?: string; tamper?: boolean } = {}) {
    const [execution] = await f.db.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId));
    const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${options.ticketId ?? ticketId}`, ticketId: options.ticketId ?? ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: options.owner ?? V2_OWNER } };
    await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: options.state ?? "confirmed",
      intentHash: intakeRuntimeHash(options.tamper ? { ...intent, ticketId: "1" } : intent), intentCiphertext: encryptSavPayload(intent), ...(options.state ?? "confirmed") === "confirmed" ? { confirmedAt: new Date(), dispatchedAt: new Date() } : {} });
  }

  it("opens each V1 request in the case, one id per mail, without copying customer text", async () => {
    const source = await intake({ requests: ["support"] });
    const relayed = await recordCaseAfterConfirmedIntake(source.messageId, confirmed(source.ticketId)) as { caseId: string };
    const stored = (await readCase(relayed.caseId))!;
    expect(stored.body.openRequests).toEqual([{ id: `gm-${source.messageId}/r0`, summary: expect.any(String), family: "other", status: "open", openedAt: RECEIVED, subject: { status: "absent", reason: "source_missing" } }]);
    expect(stored.body.openRequests[0]!.summary).not.toMatch(/Corps synthétique|Synthétique/);
    expect(stored.body.facts).toEqual([]);
    // Replayed wake: nothing more. A reply's own « r0 » is another request.
    await recordCaseAfterConfirmedIntake(source.messageId, confirmed(source.ticketId));
    const reply = await intake({ ticketId: source.ticketId, threadId: source.threadId, requests: ["support"] });
    await recordCaseAfterConfirmedIntake(reply.messageId, confirmed(source.ticketId));
    expect((await readCase(relayed.caseId))!.body.openRequests.map(request => request.id)).toEqual([`gm-${source.messageId}/r0`, `gm-${reply.messageId}/r0`]);
  });
  it("v9: a qualified entry waits for its V2 owner with the team; B cannot claim it before the owner is verified", async () => {
    const source = await intake({ requests: ["support"] }), readQualification = byRule();
    const result = await recordCaseAfterConfirmedIntake(source.messageId, { ...qualifiedDeps(source.ticketId, readQualification), env: V2_ENV });
    expect(result).toMatchObject({ created: true, owner: "human", admission: { target: "agent", reasons: ["admitted"] } });
    const [execution] = await f.db.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, source.messageId));
    expect(readQualification).toHaveBeenCalledWith({ messageId: source.messageId, gmailMessageId: `gm-${source.messageId}`, requests: [{ requestId: `gm-${source.messageId}/r0`, kind: "support" }],
      target: { ticketId: source.ticketId, executionId: execution!.id, runId: null, runVersion: 1 } });
    const stored = (await readCaseByTicket(source.ticketId))!;
    expect(stored).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "awaiting_v2_attribution" } } });
    expect(stored.body.openRequests).toMatchObject([{ id: `gm-${source.messageId}/r0`, family: "usage", status: "open" }]);
    const claimed = await claimCaseForDecision({ caseId: stored.caseId, expectedVersion: stored.version, holder: "pole-b-runner", currentPolicyRevision: "policy-r1", ttlSeconds: 300, now: new Date(Date.now() + 6 * 60_000) });
    expect(claimed).toMatchObject({ claimed: false, reason: "owner_not_agent" });
  });
  it("v9: the verified V2 owner effect of this execution gives the case to the agent in the relay's transaction, once", async () => {
    const source = await intake({ requests: ["support"] });
    await ownerEffect(source.messageId, source.ticketId);
    const result = await recordCaseAfterConfirmedIntake(source.messageId, { ...qualifiedDeps(source.ticketId), env: V2_ENV });
    expect(result).toMatchObject({ created: true, owner: "agent" });
    const stored = (await readCaseByTicket(source.ticketId))!;
    expect(stored).toMatchObject({ owner: "agent", phase: "queued", body: { handoff: null } });
    const attribution = (await listCaseEvents(stored.caseId)).filter(e => e.kind === "owner_changed");
    expect(attribution).toMatchObject([{ detail: { transition: "v2_attribution", from: "human", to: "agent", proof: { kind: "hubspot_owner_verified", ticketId: source.ticketId, ownerId: V2_OWNER } } }]);
    const claimed = await claimCaseForDecision({ caseId: stored.caseId, expectedVersion: stored.version, holder: "pole-b-runner", currentPolicyRevision: "policy-r1", ttlSeconds: 300, now: new Date(Date.now() + 6 * 60_000) });
    expect(claimed).toMatchObject({ claimed: true });
    // A replayed wake neither appends nor attributes twice.
    expect(await recordCaseAfterConfirmedIntake(source.messageId, { ...qualifiedDeps(source.ticketId), env: V2_ENV })).toMatchObject({ appended: false, owner: "agent" });
    expect((await listCaseEvents(stored.caseId)).filter(e => e.kind === "owner_changed")).toHaveLength(1);
  });
  it("v9: no attribution from an unverified, foreign or misconfigured owner effect, nor for a team admission", async () => {
    const cases: Array<[string, (source: { messageId: string; ticketId: string }) => Promise<unknown>, Record<string, string>?]> = [
      ["uncertain", source => ownerEffect(source.messageId, source.ticketId, { state: "uncertain" })],
      ["acked", source => ownerEffect(source.messageId, source.ticketId, { state: "acked" })],
      ["other owner", source => ownerEffect(source.messageId, source.ticketId, { owner: "70000001" })],
      ["other ticket", source => ownerEffect(source.messageId, source.ticketId, { ticketId: "9999998" })],
      ["tampered intent", source => ownerEffect(source.messageId, source.ticketId, { tamper: true })],
      ["owner unconfigured", source => ownerEffect(source.messageId, source.ticketId), {}],
    ];
    for (const [label, seed, env = V2_ENV] of cases) {
      const source = await intake({ requests: ["support"] });
      await seed(source);
      expect([label, await recordCaseAfterConfirmedIntake(source.messageId, { ...qualifiedDeps(source.ticketId), env: { ...env, SAV_CASE_RECORDING: "on" } })]).toMatchObject([label, { owner: "human" }]);
      expect([label, (await readCaseByTicket(source.ticketId))!.body.handoff]).toEqual([label, { reason: "awaiting_v2_attribution" }]);
    }
    const refund = await intake({ classification: "finance", requests: ["support", "finance"] });
    await ownerEffect(refund.messageId, refund.ticketId);
    expect(await recordCaseAfterConfirmedIntake(refund.messageId, { ...qualifiedDeps(refund.ticketId), env: V2_ENV })).toMatchObject({ owner: "human", admission: { target: "team" } });
    expect((await readCaseByTicket(refund.ticketId))!.body.handoff?.reason).not.toBe("awaiting_v2_attribution");
  });
  it("keeps an empty mail whose subject carries the request usable: the request comes from V1, never from the text", async () => {
    const source = await intake({ requests: ["support"], subject: "Impossible de me connecter (synthétique)", text: "" });
    const result = await recordCaseAfterConfirmedIntake(source.messageId, qualifiedDeps(source.ticketId));
    expect(result).toMatchObject({ admission: { target: "agent", reasons: ["admitted"] } });
    expect((await readCaseByTicket(source.ticketId))!.body.openRequests).toMatchObject([{ family: "usage", status: "open" }]);
    // A confirmed ticket whose analysis listed no request still opens one for the mail.
    const bare = await intake({ classification: "unknown", requests: [] });
    await recordCaseAfterConfirmedIntake(bare.messageId, confirmed(bare.ticketId));
    expect((await readCaseByTicket(bare.ticketId))!.body.openRequests).toEqual([{ id: `gm-${bare.messageId}/message`, summary: expect.any(String), family: "other", status: "open", openedAt: RECEIVED, subject: { status: "absent", reason: "not_in_summary" } }]);
  });
  it("keeps finance and out-of-scope entries closed to V2, whatever a qualification port says", async () => {
    const refund = await intake({ classification: "finance", requests: ["support", "finance"] });
    expect(await recordCaseAfterConfirmedIntake(refund.messageId, qualifiedDeps(refund.ticketId))).toMatchObject({ owner: "human", admission: { target: "team" } });
    const stored = (await readCaseByTicket(refund.ticketId))!;
    expect(stored.sensitivity).toBe("finance");
    expect(stored.body.openRequests.map(request => request.family)).toContain("finance");
    // A rule the policy does not list proves nothing: the request stays « other », the case with the team.
    const phone = await intake({ requests: ["support"] });
    expect(await recordCaseAfterConfirmedIntake(phone.messageId, qualifiedDeps(phone.ticketId, byRule("telephony", "rule-phone")))).toMatchObject({ owner: "human", admission: { target: "qualification" } });
    expect((await readCaseByTicket(phone.ticketId))!.body.openRequests).toMatchObject([{ family: "other" }]);
    const commercial = await intake({ requests: ["commercial"] });
    expect(await recordCaseAfterConfirmedIntake(commercial.messageId, confirmed(commercial.ticketId))).toMatchObject({ owner: "human" });
  });
  it("opens nothing for a « merci » on the case thread, even when V1 lists it as a request", async () => {
    const source = await intake({ requests: ["support"] });
    await recordCaseAfterConfirmedIntake(source.messageId, qualifiedDeps(source.ticketId));
    const before = (await readCaseByTicket(source.ticketId))!.body.openRequests;
    const thanks = await bareMessage(source.threadId), proof = await ackRun(thanks);
    const readAcknowledgement = vi.fn(async () => ({ ...proof, decision: { classification: "acknowledgement", requests: [{ id: "r0", kind: "acknowledgement" }] } as never }));
    expect(await recordCaseAfterConfirmedIntake(thanks, { ...noProgress, readAcknowledgement })).toMatchObject({ appended: true, relay: "acknowledgement_on_case_thread" });
    expect((await readCaseByTicket(source.ticketId))!.body.openRequests).toEqual(before);
  });
  it("refuses a qualification naming a request the mail does not have, and writes nothing", async () => {
    const source = await intake({ requests: ["support"] });
    const stray = vi.fn(async () => ({ requests: [{ requestId: "r9", family: "usage" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: RECEIVED } }],
      identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] }));
    await expect(recordCaseAfterConfirmedIntake(source.messageId, qualifiedDeps(source.ticketId, stray))).rejects.toThrow("SAV_CASE_QUALIFICATION_REQUEST_UNKNOWN");
    expect(await readCaseByTicket(source.ticketId)).toBeNull();
  });
  it("Q5: a reply that would overflow the memory keeps the mail and sends the case to the team as a technical block", async () => {
    const source = await intake({ requests: ["support"] });
    // v9: the agent holds the case only after V1's verified V2 owner effect.
    await ownerEffect(source.messageId, source.ticketId);
    await recordCaseAfterConfirmedIntake(source.messageId, { ...qualifiedDeps(source.ticketId), env: V2_ENV });
    const agent = (await readCaseByTicket(source.ticketId))!;
    expect(agent.owner).toBe("agent");
    const filler = Array.from({ length: 49 }, (_, i) => ({ id: `filler-${i}`, summary: "Demande synthétique", family: "usage" as const, status: "resolved" as const, openedAt: RECEIVED }));
    const full = await updateCaseRecord({ caseId: agent.caseId, expectedVersion: agent.version, actor: { type: "human", staffUserId: STAFF }, body: { ...emptyCaseBody(), openRequests: [...agent.body.openRequests, ...filler] } });
    const reply = await intake({ ticketId: source.ticketId, threadId: source.threadId, requests: ["support"] });
    expect(await recordCaseAfterConfirmedIntake(reply.messageId, qualifiedDeps(source.ticketId))).toMatchObject({ appended: true, owner: "human" });
    const after = (await readCase(agent.caseId))!;
    expect(after).toMatchObject({ owner: "human", body: { handoff: { reason: "body_limit_reached" } } });
    expect(after.body.openRequests).toHaveLength(50);
    const events = await listCaseEvents(agent.caseId);
    expect(events.some(event => event.dedupeKey === `inbound:gm-${reply.messageId}`)).toBe(true);
    expect(events.map(classifyCaseExit).filter(category => category !== null)).toEqual(["technical_block"]);
    expect(full.version).toBeLessThan(after.version);
  });
});

describe("v10: a searchable subject per relayed request, from V1's accepted analysis only", () => {
  type Analysis = { requests: Array<{ id: string; kind: string }>; ticketSummary?: { title: string; description: string; requestIds: string[] }; tamper?: boolean };
  /** V1's accepted analyses of the message, stored as V1's recorder stores them, and the execution pinned to that run. */
  async function analysed(source: { messageId: string; threadId: string }, analyses: Analysis[], options: { executionRunVersion?: number; validator?: string } = {}) {
    const records = analyses.map((analysis, attempt) => {
      const input = { message: { id: source.messageId }, attempt };
      const result = { messageId: source.messageId, requests: analysis.requests.map(request => ({ ...request, currentMessageId: source.messageId })), ...(analysis.ticketSummary ? { ticketSummary: analysis.ticketSummary } : {}) };
      return { method: "analyseMessage" as const, input, result, inputHash: intakeSemanticInputHash(input), resultHash: analysis.tamper ? "tampered" : savIntakeEvidenceContentHash(result), acceptedAt: RECEIVED };
    });
    const [run] = await f.db.insert(savIntakeRuns).values({ threadId: source.threadId, messageId: source.messageId, version: 1, isCurrent: false, state: "observed", configHash: `subject-${source.messageId}`, policyHash: "fixture",
      payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: options.validator ?? SAV_INTAKE_MODEL_REVISION, records } }) }).returning();
    await f.db.update(savIntakeExecutions).set({ runId: run!.id, runVersion: options.executionRunVersion ?? 1 }).where(eq(savIntakeExecutions.messageId, source.messageId));
    return { runId: run!.id, resultHash: records[0]?.resultHash };
  }
  const relayed = async (source: { messageId: string; ticketId: string }) => {
    await recordCaseAfterConfirmedIntake(source.messageId, confirmed(source.ticketId));
    return (await readCaseByTicket(source.ticketId))!.body.openRequests;
  };
  const summary = (title: string, requestIds: string[], description = "La synchronisation échoue.") => ({ title, description, requestIds });

  it("keeps V1's summary of the request, masked, with the run, hash and validator it comes from; the generic label is never the subject", async () => {
    const source = await intake();
    const { runId, resultHash } = await analysed(source, [{ requests: [{ id: "r0", kind: "support" }],
      ticketSummary: summary("Connexion impossible", ["r0"], "Le client ne peut plus se connecter.\nContact : client@example.invalid, +33 6 12 34 56 78, commande 12345678.") }]);
    const [request] = await relayed(source);
    expect(request).toEqual({ id: `gm-${source.messageId}/r0`, summary: expect.stringMatching(/relevée par l'analyse V1/), family: "other", status: "open", openedAt: RECEIVED,
      subject: { status: "available", text: "Connexion impossible. Le client ne peut plus se connecter. Contact : [email masqué], [téléphone masqué], commande [numéro masqué].",
        provenance: { source: "v1_accepted_analysis", field: "ticketSummary", runId, runVersion: 1, resultHash, validatorRevision: SAV_INTAKE_MODEL_REVISION, acceptedAt: RECEIVED } } });
    expect(caseRequestSearchText(request!)).toBe(request!.subject!.status === "available" ? request!.subject!.text : null);
    expect(caseRequestSearchText({ ...request!, subject: undefined })).toBeNull();
    expect(caseRequestSubject({ ...request!, subject: undefined })).toEqual({ status: "absent", reason: "not_recorded" });
    // An acknowledgement summed up with the request does not make the summary shared.
    const thanks = await intake();
    await analysed(thanks, [{ requests: [{ id: "r0", kind: "support" }, { id: "r1", kind: "acknowledgement" }], ticketSummary: summary("Export bloqué", ["r0", "r1"]) }]);
    expect((await relayed(thanks))[0]!.subject).toMatchObject({ status: "available", text: "Export bloqué. La synchronisation échoue." });
  });

  it("says why a request has no subject: no run, another run version, a shared or missing summary, tampered or foreign records, disagreeing analyses", async () => {
    const reasons = async (source: { messageId: string; ticketId: string }) => (await relayed(source)).map(request => [request.id.split("/")[1], caseRequestSubject(request), caseRequestSearchText(request)]);
    const absent = (reason: string) => ({ status: "absent", reason });
    const noRun = await intake();
    expect(await reasons(noRun)).toEqual([["r0", absent("source_missing"), null]]);
    const otherVersion = await intake();
    await analysed(otherVersion, [{ requests: [{ id: "r0", kind: "support" }], ticketSummary: summary("Connexion", ["r0"]) }], { executionRunVersion: 2 });
    expect(await reasons(otherVersion)).toEqual([["r0", absent("source_missing"), null]]);
    const shared = await intake({ requests: ["support", "support"] });
    await analysed(shared, [{ requests: [{ id: "r0", kind: "support" }, { id: "r1", kind: "support" }], ticketSummary: summary("Connexion et export", ["r0", "r1"]) }]);
    expect(await reasons(shared)).toEqual([["r0", absent("summary_shared"), null], ["r1", absent("summary_shared"), null]]);
    const partial = await intake({ requests: ["support", "support"] });
    await analysed(partial, [{ requests: [{ id: "r0", kind: "support" }, { id: "r1", kind: "support" }], ticketSummary: summary("Connexion", ["r0"]) }]);
    expect(await reasons(partial)).toEqual([["r0", expect.objectContaining({ status: "available" }), "Connexion. La synchronisation échoue."], ["r1", absent("not_in_summary"), null]]);
    const tampered = await intake();
    await analysed(tampered, [{ requests: [{ id: "r0", kind: "support" }], ticketSummary: summary("Connexion", ["r0"]), tamper: true }]);
    expect(await reasons(tampered)).toEqual([["r0", absent("source_invalid"), null]]);
    const foreign = await intake();
    await analysed(foreign, [{ requests: [{ id: "r0", kind: "support" }], ticketSummary: summary("Connexion", ["r0"]) }], { validator: "unknown-validator" });
    expect(await reasons(foreign)).toEqual([["r0", absent("source_invalid"), null]]);
    const disagreeing = await intake();
    await analysed(disagreeing, [{ requests: [{ id: "r0", kind: "support" }], ticketSummary: summary("Connexion", ["r0"]) }, { requests: [{ id: "r0", kind: "support" }], ticketSummary: summary("Facture en double", ["r0"]) }]);
    expect(await reasons(disagreeing)).toEqual([["r0", absent("source_ambiguous"), null]]);
    const unlisted = await intake();
    await analysed(unlisted, [{ requests: [{ id: "r9", kind: "support" }], ticketSummary: summary("Connexion", ["r9"]) }]);
    expect(await reasons(unlisted)).toEqual([["r0", absent("source_missing"), null]]);
    const masked = await intake();
    await analysed(masked, [{ requests: [{ id: "r0", kind: "support" }], ticketSummary: summary("12345678", ["r0"], "client@example.invalid") }]);
    expect(await reasons(masked)).toEqual([["r0", absent("redacted_empty"), null]]);
    const bare = await intake({ requests: [] });
    await analysed(bare, [{ requests: [], ticketSummary: undefined }]);
    expect(await reasons(bare)).toEqual([["message", absent("not_in_summary"), null]]);
  });

  // V1 reader fix (SAV-46 R1/R7, semantic v11 / simple v5): an analysis accepted by a pre-fix reader is not a
  // subject source for V2; only the readers' current revisions are, whichever of the two produced it.
  it("takes a subject only from the readers' current revisions, never from an analysis accepted before the account fix", async () => {
    const subject = async (validator: string) => {
      const source = await intake();
      await analysed(source, [{ requests: [{ id: "r0", kind: "support" }], ticketSummary: summary("Connexion", ["r0"]) }], { validator });
      return caseRequestSubject((await relayed(source))[0]!);
    };
    expect([SAV_INTAKE_MODEL_REVISION, SAV_INTAKE_SIMPLE_REVISION]).toEqual(["sav-intake-semantic-2026-10-31.v11", "sav-intake-simple-2026-10-31.v5"]);
    for (const current of [SAV_INTAKE_MODEL_REVISION, SAV_INTAKE_SIMPLE_REVISION])
      expect(await subject(current)).toMatchObject({ status: "available", text: "Connexion. La synchronisation échoue.", provenance: { validatorRevision: current } });
    for (const preFix of ["sav-intake-semantic-2026-10-29.v10", "sav-intake-simple-2026-10-30.v4"])
      expect(await subject(preFix)).toEqual({ status: "absent", reason: "source_invalid" });
  });
});
