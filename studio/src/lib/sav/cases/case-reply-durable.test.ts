import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
// The real decryption, only counted: it lets a test prove that a reply of another case is never decrypted.
vi.mock("../crypto", async importOriginal => { const original = await importOriginal<typeof import("../crypto")>(); return { ...original, decryptSavPayload: vi.fn(original.decryptSavPayload) }; });
import * as dbSchema from "@/db/schema";
import { savCaseEffectExecutions, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "../intake/execution-policy";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { executeIntakePass } from "../intake/executor";
import { getExecutionEffects } from "../intake/execution-store";
import type { ExecutionOptions } from "../intake/execution-types";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { createCaseEffectDriver } from "./case-effect-driver";
import { nextJ2Slot } from "./j2-calendar";
import { caseReplyPayloadHash, inboundInteractionId, type CaseReplyProposal } from "./case-effects";
import { getCaseReplyEffect, listCaseReplyEffects } from "./case-reply-registry";
import { decideCaseReply, enqueueApprovedCaseReply, revokeCaseReply, submitCaseReplyProposal, type CaseEffectNote } from "./case-reply-store";
import { readFileSync } from "node:fs";
import type { CaseReplyAuthorizer } from "./case-reply-validation";

// SAV-10 durable validation on the REAL executor and the real SAV-5 store (PGlite, A's migrations through 0051): `executeIntakePass` with the case driver, the real ledger (sav.intake_effects), the real Gmail/HubSpot adapters on the
// synthetic provider (no socket), the real SAV-5 case store. Nothing here reaches a provider.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, policyHash: string, environment: Record<string, string | undefined>, options: ExecutionOptions;
let p: ReturnType<typeof executionProvider>, sends = 0, loseAck = false, ticketSeq = 9_300_000;
const POLICY = "policy-r1";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000003" };
const AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: staff.staffUserId, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const driver = () => createCaseEffectDriver({ env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY });
const setV2Pause = async (level: "actions_paused" | "fully_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "release fictive" }) });
};

async function scenario(purpose: CaseReplyProposal["purpose"] = "question", extra: { note?: boolean; text?: string } = {}) {
  const gmailThreadId = `gmail-thread-${randomUUID()}`, gmailMessageId = `gm-${randomUUID()}`, ticketId = String(++ticketSeq);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({
    threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic connection failure",
    bodyCiphertext: encryptSavPayload({ text: "The synthetic connection fails.", headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z"),
  }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  p = executionProvider(); p.setGmail(gmailMessageId, gmailThreadId); p.seedTicket({ id: ticketId });
  sends = 0; loseAck = false;
  const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    if (path === "messages/send") sends += 1;
    const result = await p.gmail<T>(mailbox, path, init);
    if (path === "messages/send" && loseAck) throw Error("SAV_TEST_ACK_LOST");
    return result;
  };
  options = { ...options, adapters: createIntakeExecutorAdapters({ network: p.network, gmailRequest: gmail, gmailPermissions: async () => { }, env: () => environment }) };
  const snapshot = (await readCase(opened.caseId))!;
  const proposal: CaseReplyProposal = {
    caseId: opened.caseId, caseVersion: snapshot.version, triggerEventId: `inbound:${gmailMessageId}`, inboundMessageId: message.id, purpose, recipient: "customer@example.invalid",
    subject: "Synthetic connection failure", text: finalReplyText(extra.text ?? "SYNTHETIC reply.\nSignature kept exactly."),
    ...(purpose === "question" ? { question: { id: "q1", text: "SYNTHETIC question?", factKeys: [] } } : {}),
  };
  const note: CaseEffectNote | undefined = extra.note ? { interactionId: inboundInteractionId(gmailMessageId), text: "Synthetic interaction note.", at: "2026-10-30T10:00:00.000Z" } : undefined;
  return { caseId: opened.caseId, thread, message, ticketId, gmailMessageId, gmailThreadId, proposal, note };
}
const APPROVER = "20000000-0000-4000-8000-000000000003";
const allow: CaseReplyAuthorizer = () => ({ allowed: true, basis: "fixture.allow" });
const storeDeps = (env: () => Record<string, string | undefined> = () => environment) => ({ env, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY });
const seenOf = (proposal: CaseReplyProposal) => ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient });
/** The whole durable path: the proposal is stored, a person approves what they saw, the execution is queued from the stored validation. */
async function validate(proposal: CaseReplyProposal) {
  const submitted = await submitCaseReplyProposal(proposal, storeDeps());
  if (!submitted.ok) throw Error(`SUBMIT_REFUSED:${submitted.code}`);
  const decided = await decideCaseReply({ action: "approve", validationId: submitted.id, approverId: APPROVER, seen: seenOf(proposal), authorizer: allow, deps: storeDeps() });
  if (!decided.ok) throw Error(`APPROVE_REFUSED:${decided.code}`);
  return submitted.id;
}
const queue = (validationId: string, note?: CaseEffectNote) => enqueueApprovedCaseReply({ validationId, policy: { id: policyId, hash: policyHash }, ...(note ? { note } : {}), deps: storeDeps() });
async function admit(s: { proposal: CaseReplyProposal; note?: CaseEffectNote }) {
  const validationId = await validate(s.proposal), queued = await queue(validationId, s.note);
  if (!queued.ok) throw Error(`ENQUEUE_REFUSED:${queued.code}`);
  return { id: queued.executionId, created: queued.created, validationId };
}
const run = (id: string, hooks: Parameters<typeof executeIntakePass>[2] = {}, d = driver()) => executeIntakePass(id, options, hooks, d);
const execution = async (id: string) => (await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, id)))[0]!;
const effectsOf = (id: string) => getExecutionEffects(id);
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
const outbound = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed");

beforeAll(async () => {
  f = await createSavTestDb(); state.db = f.db;
}, 60_000);
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
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setV2Pause(null); });

const deny: CaseReplyAuthorizer = () => ({ allowed: false, reason: "fixture" });
const rows = async (sqlText: string, params: unknown[] = []) => (await f.client.query<Record<string, unknown>>(sqlText, params)).rows;
const validationsOf = (caseId: string) => rows("SELECT id, state, decided_by, execution_id FROM sav.case_reply_validations WHERE case_id = $1 ORDER BY created_at, id", [caseId]);
const propose = async (proposal: CaseReplyProposal) => { const r = await submitCaseReplyProposal(proposal, storeDeps()); if (!r.ok) throw Error(`SUBMIT_REFUSED:${r.code}`); return r.id; };
const approve = (validationId: string, proposal: CaseReplyProposal, authorizer: CaseReplyAuthorizer | null | undefined | "default" = "default", approverId = APPROVER) =>
  decideCaseReply({ action: "approve", validationId, approverId, seen: seenOf(proposal), authorizer: authorizer === "default" ? allow : authorizer, deps: storeDeps() });
const newInbound = (s: Awaited<ReturnType<typeof scenario>>, at = "2026-10-28T07:30:00.000Z") =>
  openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`late-${randomUUID()}`), sourceRef: { type: "email", id: "late" }, occurredAt: at });

describe("double click and same key: one validation, one approval, one execution", () => {
  it("submitting twice, even at once, stores one row; approving twice, even at once, approves once", async () => {
    const s = await scenario("answer");
    const [a, b] = await Promise.all([submitCaseReplyProposal(s.proposal, storeDeps()), submitCaseReplyProposal(s.proposal, storeDeps())]);
    expect(a).toMatchObject({ ok: true }); expect(b).toMatchObject({ ok: true });
    expect(await validationsOf(s.caseId)).toHaveLength(1);
    const id = (a as { id: string }).id;
    expect((b as { id: string }).id).toBe(id);
    const decisions = await Promise.all([approve(id, s.proposal), approve(id, s.proposal)]);
    expect(decisions.every(d => d.ok)).toBe(true);
    expect(decisions.filter(d => d.ok && d.changed)).toHaveLength(1);
    expect(await validationsOf(s.caseId)).toMatchObject([{ id, state: "approved", decided_by: APPROVER }]);
  });

  it("queueing twice, even at once, makes one execution and a second call returns it", async () => {
    const s = await scenario("answer");
    const id = await validate(s.proposal);
    const [a, b] = await Promise.all([queue(id), queue(id)]);
    expect(a).toMatchObject({ ok: true }); expect(b).toMatchObject({ ok: true });
    expect((a as { executionId: string }).executionId).toBe((b as { executionId: string }).executionId);
    expect([a, b].filter(r => r.ok && r.created)).toHaveLength(1);
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, s.caseId))).toHaveLength(1);
    expect(await queue(id)).toMatchObject({ ok: true, created: false });
  });

  it("the same trigger with another payload: the undecided one is superseded and can no longer be approved; an approved trigger accepts no other payload", async () => {
    const s = await scenario("answer");
    const first = await propose(s.proposal);
    const edited = { ...s.proposal, text: finalReplyText("SYNTHETIC other text.") };
    const second = await propose(edited);
    expect(second).not.toBe(first);
    expect((await validationsOf(s.caseId)).map(row => row.state)).toEqual(["superseded", "proposed"]);
    expect(await approve(first, s.proposal)).toEqual({ ok: false, code: "not_proposed", detail: "superseded" });
    expect(await approve(second, s.proposal)).toEqual({ ok: false, code: "payload_changed" });
    expect(await approve(second, edited)).toMatchObject({ ok: true, changed: true });
    expect(await submitCaseReplyProposal({ ...s.proposal, text: finalReplyText("SYNTHETIC third text.") }, storeDeps())).toEqual({ ok: false, code: "trigger_already_approved" });
  });

  it("two payloads of one trigger cannot both be approved even if both rows exist: the table lets exactly one through", async () => {
    const s = await scenario("answer");
    const first = await propose(s.proposal);
    const edited = { ...s.proposal, text: finalReplyText("SYNTHETIC other text.") };
    const { encryptSavPayload: seal } = await import("../crypto");
    const key = (await rows("SELECT reply_key FROM sav.case_reply_validations WHERE id = $1", [first]))[0]!.reply_key as string;
    const other = (await rows(`INSERT INTO sav.case_reply_validations(case_id, reply_key, payload_hash, case_version, recipient, proposal_ciphertext) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [s.caseId, key, caseReplyPayloadHash(edited), edited.caseVersion, edited.recipient, seal(edited)]))[0]!.id as string;
    expect(await approve(first, s.proposal)).toMatchObject({ ok: true, changed: true });
    expect(await approve(other, edited)).toEqual({ ok: false, code: "trigger_already_approved" });
    expect((await validationsOf(s.caseId)).map(row => row.state).sort()).toEqual(["approved", "proposed"]);
  });
});

describe("who may decide: an injected port that refuses by default; no role is implied", () => {
  it.each([
    ["no authorizer wired", undefined, "authorizer_missing"], ["null", null, "authorizer_missing"], ["a deny port", deny, "not_authorized"],
    ["a port that throws", (() => { throw Error("down"); }) as CaseReplyAuthorizer, "authorizer_failed"],
    ["a silent port", (() => undefined) as unknown as CaseReplyAuthorizer, "decision_absent"], ["a yes without a basis", (() => ({ allowed: true })) as unknown as CaseReplyAuthorizer, "decision_absent"],
  ])("%s: the approval is refused, nothing is stored as decided, nothing is queued", async (_name, authorizer, code) => {
    const s = await scenario("answer");
    const id = await propose(s.proposal);
    expect(await approve(id, s.proposal, (authorizer ?? null) as CaseReplyAuthorizer | null)).toEqual({ ok: false, code });
    expect(await validationsOf(s.caseId)).toMatchObject([{ state: "proposed", decided_by: null }]);
    expect(await queue(id)).toMatchObject({ ok: false, code: "not_approved" });
    expect(sends).toBe(0);
  });

  it("an approver that is not a staff UUID never reaches the port; declining needs the same authorization", async () => {
    const s = await scenario("answer");
    const id = await propose(s.proposal);
    const port = vi.fn<CaseReplyAuthorizer>(() => ({ allowed: true, basis: "fixture.allow" }));
    expect(await approve(id, s.proposal, port, "staff@example.invalid")).toEqual({ ok: false, code: "approver_invalid" });
    expect(port).not.toHaveBeenCalled();
    expect(await decideCaseReply({ action: "decline", validationId: id, approverId: APPROVER, seen: seenOf(s.proposal), authorizer: undefined, deps: storeDeps() })).toEqual({ ok: false, code: "authorizer_missing" });
    expect(await decideCaseReply({ action: "decline", validationId: id, approverId: APPROVER, seen: seenOf(s.proposal), authorizer: allow, deps: storeDeps() })).toMatchObject({ ok: true, state: "declined" });
    expect(await approve(id, s.proposal)).toEqual({ ok: false, code: "not_proposed", detail: "declined" });
  });

  it("the port is told exactly what is decided on (case, trigger, payload hash, purpose, action)", async () => {
    const s = await scenario("question");
    const id = await propose(s.proposal);
    const port = vi.fn<CaseReplyAuthorizer>(() => ({ allowed: true, basis: "fixture.allow" }));
    await approve(id, s.proposal, port);
    expect(port).toHaveBeenCalledWith({ action: "approve", approverId: APPROVER, caseId: s.caseId, replyKey: `reply:${s.caseId}:${s.proposal.triggerEventId}`, payloadHash: caseReplyPayloadHash(s.proposal), purpose: "question" });
  });

  it("OFF stores nothing and decides nothing: with the mode off, an existing proposal cannot be approved nor queued", async () => {
    const s = await scenario("answer");
    const id = await propose(s.proposal);
    environment = { ...environment, SAV_CASE_EFFECTS: "off" };
    expect(await approve(id, s.proposal)).toEqual({ ok: false, code: "effects_off" });
    expect(await queue(id)).toEqual({ ok: false, code: "effects_off" });
    expect(await validationsOf(s.caseId)).toMatchObject([{ state: "proposed" }]);
  });
});

describe("what changes between the proposal, the click and the marker", () => {
  it("a customer message before the click refuses the approval and leaves the proposal undecided; a person taking the case does too", async () => {
    const s = await scenario("answer");
    const id = await propose(s.proposal);
    await newInbound(s);
    expect(await approve(id, s.proposal)).toMatchObject({ ok: false, code: "new_input", detail: "input_newer" });
    expect(await validationsOf(s.caseId)).toMatchObject([{ state: "proposed" }]);
    const t = await scenario("answer");
    const taken = await propose(t.proposal);
    await transitionCaseOwner({ caseId: t.caseId, expectedVersion: (await readCase(t.caseId))!.version, transition: "human_takeover", actor: staff, commandKey: `cmd-${randomUUID()}`, reason: "fixture" });
    expect(await approve(taken, t.proposal)).toEqual({ ok: false, code: "not_admitted", detail: "owner_not_agent" });
  });

  it("a customer message between the click and the marker cancels for good: no marker, no ledger row, nothing sent", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    await newInbound(s);
    expect(await run(id)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT" });
    expect(await effectsOf(id)).toEqual([]);
    expect(sends).toBe(0);
  });

  it("a proposal cannot be stored for a recipient that is not the stored sender, for another case's message, or after a newer message", async () => {
    const s = await scenario("answer");
    expect(await submitCaseReplyProposal({ ...s.proposal, recipient: "someone-else@example.invalid" }, storeDeps())).toEqual({ ok: false, code: "recipient_changed" });
    const other = await scenario("answer");
    expect(await submitCaseReplyProposal({ ...s.proposal, inboundMessageId: other.message.id }, storeDeps())).toEqual({ ok: false, code: "inbound_not_in_case" });
    expect(await submitCaseReplyProposal({ ...s.proposal, text: "   " }, storeDeps())).toEqual({ ok: false, code: "proposal_invalid", detail: "text" });
    await newInbound(s);
    expect(await submitCaseReplyProposal(s.proposal, storeDeps())).toMatchObject({ ok: false, code: "new_input", detail: "input_newer" });
    expect(await validationsOf(s.caseId)).toEqual([]);
  });
});

describe("revocation: until the marker, then verify-only", () => {
  it("an approval withdrawn before the pass: the execution is cancelled at the gate, nothing is sent, and the key is never reused", async () => {
    const s = await scenario("answer");
    const { id, validationId } = await admit(s);
    expect(await revokeCaseReply({ validationId, approverId: APPROVER, authorizer: allow })).toMatchObject({ ok: true, state: "revoked", changed: true });
    expect(await revokeCaseReply({ validationId, approverId: APPROVER, authorizer: allow })).toMatchObject({ ok: true, changed: false });
    expect(await run(id)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_APPROVAL_REVOKED" });
    expect(await effectsOf(id)).toEqual([]);
    expect(sends).toBe(0);
    expect((await execution(id)).state).toBe("refused");
    expect(await approve(validationId, s.proposal)).toEqual({ ok: false, code: "not_proposed", detail: "revoked" });
  });

  it("revoking needs the same authorization, works with the mode off (it only removes a permission), and is refused for a reply nobody approved", async () => {
    const s = await scenario("answer");
    const { id, validationId } = await admit(s);
    expect(await revokeCaseReply({ validationId, approverId: APPROVER, authorizer: undefined })).toEqual({ ok: false, code: "authorizer_missing" });
    expect(await revokeCaseReply({ validationId, approverId: APPROVER, authorizer: deny })).toEqual({ ok: false, code: "not_authorized" });
    environment = { ...environment, SAV_CASE_EFFECTS: "off" };
    expect(await revokeCaseReply({ validationId, approverId: APPROVER, authorizer: allow })).toMatchObject({ ok: true, state: "revoked" });
    environment = { ...environment, SAV_CASE_EFFECTS: "supervised" };
    expect(await run(id)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_APPROVAL_REVOKED" });
    const t = await scenario("answer");
    expect(await revokeCaseReply({ validationId: await propose(t.proposal), approverId: APPROVER, authorizer: allow })).toEqual({ ok: false, code: "not_approved", detail: "proposed" });
  });

  it("once a marker exists the revocation is refused (too late): the reply is verified only, never resent, and recorded once", async () => {
    const s = await scenario("question");
    const { id, validationId } = await admit(s);
    loseAck = true;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(1);
    expect(await revokeCaseReply({ validationId, approverId: APPROVER, authorizer: allow })).toEqual({ ok: false, code: "too_late" });
    // the table refuses it by itself too, whoever tries
    await expect(f.client.query("UPDATE sav.case_reply_validations SET state = 'revoked', revoked_by = $2, revoked_at = now(), revocation_basis = 'x' WHERE id = $1", [validationId, APPROVER])).rejects.toThrow("cannot be revoked once the send started");
    loseAck = false; await letReconcile();
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await revokeCaseReply({ validationId, approverId: APPROVER, authorizer: allow })).toEqual({ ok: false, code: "too_late" });
  });

  it("a revocation between the intent and the marker is seen by the marker's own transaction", async () => {
    const s = await scenario("answer");
    const { id, validationId } = await admit(s);
    expect(await run(id, { beforeMarker: async () => { expect(await revokeCaseReply({ validationId, approverId: APPROVER, authorizer: allow })).toMatchObject({ ok: true }); } }))
      .toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_APPROVAL_REVOKED" });
    expect(sends).toBe(0);
    expect(await effectsOf(id)).toMatchObject([{ state: "planned", dispatchedAt: null }]);
  });
});

describe("no approval can be forged: the approval is the stored row, nothing else", () => {
  const plant = async (s: Awaited<ReturnType<typeof scenario>>, validationId: string, proposal: CaseReplyProposal) => {
    const { encryptSavPayload: seal } = await import("../crypto");
    const payload = { validationId, proposal, context: { mailboxEmail: "support@example.invalid", gmailThreadId: s.gmailThreadId, priorRfcMessageId: "<incoming@example.invalid>", inboundFromEmail: "customer@example.invalid" } };
    const [row] = await f.db.insert(savCaseEffectExecutions).values({ caseId: s.caseId, replyKey: `reply:${s.caseId}:${proposal.triggerEventId}:planted-${randomUUID()}`, threadId: s.thread.id, policyId, policyHash, payloadCiphertext: seal(payload) }).returning();
    return row!.id;
  };

  it("a sealed payload that names a proposal nobody approved is cancelled at the gate: no marker, nothing sent", async () => {
    const s = await scenario("answer");
    const validationId = await propose(s.proposal);
    const planted = await plant(s, validationId, s.proposal);
    expect(await run(planted)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_APPROVAL_INVALID" });
    expect(sends).toBe(0);
  });

  it("an approval bound to another execution, or a missing validation, is not an approval", async () => {
    const s = await scenario("answer");
    const { validationId } = await admit(s);
    const planted = await plant(s, validationId, s.proposal);
    expect(await run(planted)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_APPROVAL_INVALID" });
    const ghost = await plant(s, randomUUID(), s.proposal);
    expect(await run(ghost)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_APPROVAL_INVALID" });
    expect(sends).toBe(0);
  });

  it("a sealed text that is not the approved text is refused as a changed payload", async () => {
    const s = await scenario("answer");
    const validationId = await validate(s.proposal);
    const queued = await queue(validationId);
    if (!queued.ok) throw Error("QUEUE");
    const { encryptSavPayload: seal } = await import("../crypto");
    const forged = { validationId, proposal: { ...s.proposal, text: "FORGED text." }, context: { mailboxEmail: "support@example.invalid", gmailThreadId: s.gmailThreadId, priorRfcMessageId: "<incoming@example.invalid>", inboundFromEmail: "customer@example.invalid" } };
    await f.db.update(savCaseEffectExecutions).set({ payloadCiphertext: seal(forged) }).where(eq(savCaseEffectExecutions.id, queued.executionId));
    expect(await run(queued.executionId)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_PAYLOAD_CHANGED" });
    expect(sends).toBe(0);
  });

  it("the table is durable evidence: payload, decision and execution cannot be rewritten, a decided reply cannot go back, nothing is deleted", async () => {
    const s = await scenario("answer");
    const { validationId } = await admit(s);
    const attempt = (sqlText: string) => expect(f.client.query(sqlText, [validationId])).rejects.toThrow(/immutable|transition refused|never deleted|violates check/);
    await attempt("UPDATE sav.case_reply_validations SET payload_hash = repeat('b', 64) WHERE id = $1");
    await attempt("UPDATE sav.case_reply_validations SET recipient = 'other@example.invalid' WHERE id = $1");
    await attempt("UPDATE sav.case_reply_validations SET case_version = case_version + 1 WHERE id = $1");
    await attempt("UPDATE sav.case_reply_validations SET proposal_ciphertext = 'x' WHERE id = $1");
    await attempt("UPDATE sav.case_reply_validations SET state = 'proposed', decided_by = NULL, decided_at = NULL, authorization_basis = NULL WHERE id = $1");
    await attempt("UPDATE sav.case_reply_validations SET decided_by = gen_random_uuid() WHERE id = $1");
    await attempt("UPDATE sav.case_reply_validations SET execution_id = NULL WHERE id = $1");
    await attempt("DELETE FROM sav.case_reply_validations WHERE id = $1");
    expect(await validationsOf(s.caseId)).toMatchObject([{ state: "approved", decided_by: APPROVER }]);
  });
});

describe("the two parents of the effect ledger, and what each may host", () => {
  const ids = { intake: "30000000-0000-4000-8000-000000000012", caseEffect: "30000000-0000-4000-8000-000000000013", orphan: "30000000-0000-4000-8000-0000000000ff" };
  const effect = (execution: string, key: string, kind: string, permission = "append_case_note") =>
    f.client.query("INSERT INTO sav.intake_effects(business_key, execution_id, kind, permission, intent_hash, intent_ciphertext) VALUES ($1,$2,$3,$4,'h','c')", [key, execution, kind, permission]);

  it("both parents are accepted for their own kinds; a V1 kind on a case execution, reply_send on a V1 execution, and a missing parent are refused, for the ledger and its journal", async () => {
    const s = await scenario("answer");
    await f.client.query("INSERT INTO sav.intake_executions(id, message_id, thread_id, run_version, policy_id, policy_hash, payload_ciphertext) VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1, $2, 'h', 'c')", [ids.intake, policyId]);
    await f.client.query("INSERT INTO sav.case_effect_executions(id, case_id, reply_key, thread_id, policy_id, policy_hash, payload_ciphertext) VALUES ($1, $2, $3, gen_random_uuid(), $4, 'h', 'c')", [ids.caseEffect, s.caseId, `reply-key-${ids.caseEffect}`, policyId]);
    // each parent hosts its own kinds
    await effect(ids.intake, "t-v1-identity", "identity_send", "send_identity_email");
    await effect(ids.intake, "t-v1-note", "note_create", "append_ticket_note");
    await effect(ids.caseEffect, "t-case-reply", "reply_send", "send_case_reply");
    await effect(ids.caseEffect, "t-case-note", "note_create");
    await effect(ids.caseEffect, "t-case-assoc", "note_associate");
    // wrong type
    for (const kind of ["ticket_create", "email_create", "email_associate", "stage_new", "identity_send", "owner_assign"]) {
      await expect(effect(ids.caseEffect, `t-case-${kind}`, kind)).rejects.toThrow(/cannot belong to a case execution/);
    }
    await expect(effect(ids.intake, "t-v1-reply", "reply_send", "send_case_reply")).rejects.toThrow("reply_send can only belong to a case execution");
    await expect(f.client.query("UPDATE sav.intake_effects SET execution_id = $1 WHERE business_key = 't-v1-identity'", [ids.caseEffect])).rejects.toThrow(/cannot belong to a case execution/);
    await expect(f.client.query("UPDATE sav.intake_effects SET execution_id = $1 WHERE business_key = 't-case-reply'", [ids.intake])).rejects.toThrow("reply_send can only belong to a case execution");
    // orphans
    await expect(effect(ids.orphan, "t-orphan", "note_create", "append_ticket_note")).rejects.toThrow("effect parent execution missing");
    await expect(f.client.query("INSERT INTO sav.intake_effect_journal(execution_id, kind, payload_ciphertext) VALUES ($1, 'planned', 'c')", [ids.orphan])).rejects.toThrow("effect parent execution missing");
    await f.client.query("INSERT INTO sav.intake_effect_journal(execution_id, kind, payload_ciphertext) VALUES ($1, 'planned', 'c')", [ids.caseEffect]);
    await f.client.query("INSERT INTO sav.intake_effect_journal(execution_id, kind, payload_ciphertext) VALUES ($1, 'planned', 'c')", [ids.intake]);
    // parent side: a referenced execution is neither deleted nor renumbered
    await expect(f.client.query("DELETE FROM sav.case_effect_executions WHERE id = $1", [ids.caseEffect])).rejects.toThrow("effect parent execution still referenced");
    await expect(f.client.query("DELETE FROM sav.intake_executions WHERE id = $1", [ids.intake])).rejects.toThrow("effect parent execution still referenced");
    await expect(f.client.query("UPDATE sav.case_effect_executions SET id = gen_random_uuid() WHERE id = $1", [ids.caseEffect])).rejects.toThrow("effect parent execution still referenced");
  });

  it("the case driver only ever plans reply_send and the two note kinds on a case execution (the ledger confirms it after a full run)", async () => {
    const s = await scenario("answer", { note: true });
    const { id } = await admit(s);
    await run(id);
    expect((await effectsOf(id)).map(effect => effect.kind)).toEqual(["reply_send", "note_create", "note_associate"]);
  });
});

describe("what the Studio may read: truthful, read-only, no text in a list", () => {
  const readDeps = () => ({ env: () => environment });
  const tableCounts = async () => (await rows(`SELECT (SELECT count(*) FROM sav.case_reply_validations)::int AS v, (SELECT count(*) FROM sav.case_effect_executions)::int AS x,
    (SELECT count(*) FROM sav.intake_effects)::int AS e, (SELECT count(*) FROM sav.intake_effect_journal)::int AS j, (SELECT count(*) FROM sav.case_timers)::int AS t, (SELECT count(*) FROM sav.case_events)::int AS c`))[0];

  it("follows one reply from proposal to confirmed mail and J2, and says `sent` only with a confirmed receipt", async () => {
    const s = await scenario("question");
    const validationId = await propose(s.proposal);
    expect(await getCaseReplyEffect({ validationId }, readDeps())).toMatchObject({ validation: "proposed", approvability: { ok: true }, status: { code: "awaiting_validation", sent: "no" }, effect: null, recipient: "customer@example.invalid", proposal: { subject: s.proposal.subject, text: s.proposal.text, question: { id: "q1" } } });
    await approve(validationId, s.proposal);
    expect(await getCaseReplyEffect({ validationId }, readDeps())).toMatchObject({ validation: "approved", approvability: { ok: false, reason: "already_decided" }, status: { code: "approved_not_queued", sent: "no" } });
    const queued = await queue(validationId);
    if (!queued.ok) throw Error("QUEUE");
    expect(await getCaseReplyEffect({ validationId }, readDeps())).toMatchObject({ status: { code: "queued", sent: "no" }, effect: { executionId: queued.executionId, executionState: "pending", reply: null } });
    loseAck = true;
    await run(queued.executionId);
    expect(await getCaseReplyEffect({ validationId }, readDeps())).toMatchObject({ status: { code: "send_unconfirmed", sent: "maybe", terminal: false, j2: { state: "none" } }, effect: { reply: { state: "uncertain", confirmedAt: null, gmailMessageId: null } } });
    // The operational monitor counts sav.intake_effects as a whole (monitor.ts, `effect_uncertain`): a reply whose receipt was lost is a critical incident there, not invisible.
    const monitored = async () => (await f.client.query("select count(*) filter(where state in ('uncertain','dispatched','acked') and confirmed_at is null)::int as uncertain, count(*) filter(where state='failed')::int as failed from sav.intake_effects")).rows[0];
    expect(await monitored()).toEqual({ uncertain: 1, failed: 0 });
    loseAck = false; await letReconcile();
    await run(queued.executionId);
    expect(await monitored()).toEqual({ uncertain: 0, failed: 0 });
    const done = (await getCaseReplyEffect({ validationId }, readDeps()))!;
    expect(done).toMatchObject({ status: { code: "sent_confirmed", sent: "yes", terminal: true, j2: { state: "scheduled" } }, effect: { executionState: "confirmed", reply: { state: "confirmed" } } });
    expect(done.effect!.reply!.gmailMessageId).toEqual(expect.any(String));
    expect(done.status.j2.dueAt).toEqual(expect.any(String));
  });

  it("says what stopped a reply: a cancellation with its code, a hold with its reason, the mode off", async () => {
    const s = await scenario("answer");
    const { id, validationId } = await admit(s);
    await newInbound(s);
    await run(id);
    expect(await getCaseReplyEffect({ validationId }, readDeps())).toMatchObject({ status: { code: "cancelled", cancel: "new_input", sent: "no", terminal: true } });
    const t = await scenario("answer");
    const held = await admit(t);
    await setV2Pause("actions_paused");
    await run(held.id);
    expect(await getCaseReplyEffect({ validationId: held.validationId }, readDeps())).toMatchObject({ status: { code: "queued", sent: "no", terminal: false }, effect: { executionState: "waiting" } });
    environment = { ...environment, SAV_CASE_EFFECTS: "off" };
    expect(await getCaseReplyEffect({ validationId: held.validationId }, readDeps())).toMatchObject({ status: { code: "held", hold: "effects_off" }, approvability: { ok: false } });
  });

  it("a list carries neither text nor recipient nor ciphertext; the single read does carry the text; reading changes nothing", async () => {
    const s = await scenario("answer", { text: "SYNTHETIC-LIST-SECRET-TEXT" });
    const validationId = await propose(s.proposal);
    const before = await tableCounts();
    const listed = await listCaseReplyEffects({ caseId: s.caseId }, readDeps());
    const json = JSON.stringify(listed);
    expect(listed.items).toHaveLength(1);
    expect(json).not.toContain("SYNTHETIC-LIST-SECRET-TEXT");
    expect(json).not.toContain("customer@example.invalid");
    expect(json).not.toMatch(/ciphertext/i);
    expect(JSON.stringify(await getCaseReplyEffect({ validationId }, readDeps()))).toContain("SYNTHETIC-LIST-SECRET-TEXT");
    expect(await getCaseReplyEffect({ validationId: randomUUID() }, readDeps())).toBeNull();
    expect(await tableCounts()).toEqual(before);
  });

  it("the single read can be bound to a case in the query itself: another case's reply is not read, not decrypted, and a malformed id reaches no query", async () => {
    const mine = await scenario("answer", { text: "SYNTHETIC-CASE-A-TEXT" }), other = await scenario("answer", { text: "SYNTHETIC-CASE-B-TEXT" });
    const mineId = await propose(mine.proposal), otherId = await propose(other.proposal);
    const decrypt = vi.mocked(decryptSavPayload);
    decrypt.mockClear();
    expect(await getCaseReplyEffect({ validationId: otherId, caseId: mine.caseId }, readDeps())).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
    expect(JSON.stringify(await getCaseReplyEffect({ validationId: mineId, caseId: mine.caseId }, readDeps()))).toContain("SYNTHETIC-CASE-A-TEXT");
    expect(decrypt).toHaveBeenCalled();
    decrypt.mockClear();
    for (const bad of ["", "not-a-uuid", "1 OR 1=1", "20000000-0000-4000-8000-00000000000"]) {
      expect(await getCaseReplyEffect({ validationId: bad }, readDeps())).toBeNull();
      expect(await getCaseReplyEffect({ validationId: mineId, caseId: bad }, readDeps())).toBeNull();
    }
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("pages newest first by cursor without a gap or a duplicate, filters by state, and bounds the page", async () => {
    const s = await scenario("answer");
    const first = await propose(s.proposal);
    const second = await propose({ ...s.proposal, text: finalReplyText("SYNTHETIC second.") });
    const third = await propose({ ...s.proposal, text: finalReplyText("SYNTHETIC third.") });
    const page1 = await listCaseReplyEffects({ caseId: s.caseId, limit: 2 }, readDeps());
    expect(page1.items.map(item => item.id)).toEqual([third, second]);
    const page2 = await listCaseReplyEffects({ caseId: s.caseId, limit: 2, before: page1.next! }, readDeps());
    expect(page2.items.map(item => item.id)).toEqual([first]);
    expect(page2.next).toBeNull();
    expect((await listCaseReplyEffects({ caseId: s.caseId, states: ["proposed"] }, readDeps())).items.map(item => item.id)).toEqual([third]);
    expect((await listCaseReplyEffects({ caseId: s.caseId, states: ["superseded"] }, readDeps())).items).toHaveLength(2);
    expect((await listCaseReplyEffects({ caseId: s.caseId, limit: 10_000 }, readDeps())).items.length).toBeLessThanOrEqual(50);
  });
});

describe("J2 counts from the real mail, only after a confirmed send", () => {
  it("the timer starts at Gmail's verified send time (not at the marker) and its due date follows from it", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    loseAck = true;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    const [sentEffect] = await effectsOf(id);
    // Gmail's own date of that mail is four minutes after our marker (inside the verification window).
    const real = new Date(sentEffect!.dispatchedAt!.getTime() + 240_000);
    for (const mail of Object.values(p.sent) as { internalDate: string }[]) mail.internalDate = String(real.getTime());
    loseAck = false; await letReconcile();
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    const [timer] = await listCaseTimers(s.caseId);
    expect(timer).toMatchObject({ state: "scheduled", sentAt: real.toISOString(), dueAt: nextJ2Slot(real).toISOString() });
    expect(timer!.sentAt).not.toBe(sentEffect!.dispatchedAt!.toISOString());
    expect(sends).toBe(1);
  });

  it("a pause that delays the recording by days keeps the date: the J2 still counts from the mail, and the recording itself is not held by the pause", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    const crashing = { ...driver(), finish: async () => { throw Error("SAV_TEST_CRASH_AFTER_CONFIRMED"); } };
    await run(id, {}, crashing);
    const [confirmed] = await effectsOf(id);
    const mailAt = (JSON.parse(JSON.stringify((await rows("SELECT confirmed_at FROM sav.intake_effects WHERE id = $1", [confirmed!.id]))[0]))).confirmed_at as string;
    expect(Number.isFinite(Date.parse(mailAt))).toBe(true);
    await setV2Pause("actions_paused");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 40 * 3_600_000));
    try {
      expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    } finally { vi.useRealTimers(); }
    const [timer] = await listCaseTimers(s.caseId);
    expect(timer).toBeDefined();
    // counted from the mail (marker time ~ now), not from the recording 40 hours later
    expect(Date.parse(timer!.sentAt)).toBeLessThan(Date.now() + 60_000);
    expect(timer!.dueAt).toBe(nextJ2Slot(new Date(timer!.sentAt)).toISOString());
    expect(sends).toBe(1);
  });

  it("a customer message that arrives after the question left: before the recording no J2 is planned; after it the planned J2 is cancelled", async () => {
    const early = await scenario("question");
    const first = await admit(early);
    const crashing = { ...driver(), finish: async () => { throw Error("SAV_TEST_CRASH_AFTER_CONFIRMED"); } };
    await run(first.id, {}, crashing);
    await newInbound(early, new Date(Date.now() + 1000).toISOString());
    expect(await run(first.id)).toEqual({ state: "confirmed", executionId: first.id });
    expect(await outbound(early.caseId)).toHaveLength(1);
    expect(await listCaseTimers(early.caseId)).toEqual([]);
    const late = await scenario("question");
    const second = await admit(late);
    expect(await run(second.id)).toEqual({ state: "confirmed", executionId: second.id });
    expect(await listCaseTimers(late.caseId)).toMatchObject([{ state: "scheduled" }]);
    await newInbound(late, new Date(Date.now() + 1000).toISOString());
    expect(await listCaseTimers(late.caseId)).toMatchObject([{ state: "cancelled" }]);
  });

  it("no confirmed receipt, no timer: cancelled, revoked, held and uncertain replies plan no J2", async () => {
    const cases: [string, () => Promise<string>][] = [
      ["new input", async () => { const s = await scenario("question"); const a = await admit(s); await newInbound(s); await run(a.id); return s.caseId; }],
      ["revoked", async () => { const s = await scenario("question"); const a = await admit(s); await revokeCaseReply({ validationId: a.validationId, approverId: APPROVER, authorizer: allow }); await run(a.id); return s.caseId; }],
      ["held by a pause", async () => { const s = await scenario("question"); const a = await admit(s); await setV2Pause("fully_paused"); await run(a.id); return s.caseId; }],
      ["crash after the marker", async () => { const s = await scenario("question"); const a = await admit(s); await run(a.id, { afterMarker: async () => { throw Error("SAV_TEST_CRASH"); } }); return s.caseId; }],
    ];
    for (const [, make] of cases) { const caseId = await make(); expect(await listCaseTimers(caseId)).toEqual([]); await setV2Pause(null); }
    expect(sends).toBe(0);
  });
});

// B5 (ROOT review): the reply key must not depend on how a producer names the mail. One canonical trigger per customer mail, derived from the stored fact.
describe("one canonical trigger per customer mail: two producers, one approval, one send", () => {
  const eventOf = async (caseId: string, key: string) => (await listCaseEvents(caseId)).find(event => event.dedupeKey === key)!;
  const asB = async (s: Awaited<ReturnType<typeof scenario>>, patch: Partial<CaseReplyProposal> = {}): Promise<CaseReplyProposal> =>
    ({ ...s.proposal, triggerEventId: `in:${(await eventOf(s.caseId, caseDedupeKey.inbound(s.gmailMessageId))).id}`, ...patch });
  /** A later customer mail of the same case: its own stored message and its own `inbound_confirmed` event. */
  const secondMail = async (s: Awaited<ReturnType<typeof scenario>>) => {
    const gmailMessageId = `gm-${randomUUID()}`;
    const message = (await f.db.insert(savMessages).values({ threadId: s.thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"],
      subject: "Synthetic second mail", bodyCiphertext: encryptSavPayload({ text: "Second.", headers: { "message-id": "<second@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T08:00:00.000Z") }).returning())[0]!;
    await openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T08:00:00.000Z" });
    return { gmailMessageId, message, version: (await readCase(s.caseId))!.version };
  };

  it("pole B's `in:<case event id>` and the store's `inbound:<gmail id>` are the same mail: same stored proposal, same key, the alias is stored under its canonical name", async () => {
    const s = await scenario("answer");
    const viaB = await submitCaseReplyProposal(await asB(s), storeDeps()), viaC = await submitCaseReplyProposal(s.proposal, storeDeps());
    expect(viaB).toMatchObject({ ok: true, created: true });
    expect(viaC).toMatchObject({ ok: true, created: false, id: (viaB as { id: string }).id });
    const stored = await rows("SELECT reply_key, payload_hash FROM sav.case_reply_validations WHERE case_id = $1", [s.caseId]);
    expect(stored).toEqual([{ reply_key: `reply:${s.caseId}:inbound:${s.gmailMessageId}`, payload_hash: caseReplyPayloadHash(s.proposal) }]);
    expect(JSON.stringify(await getCaseReplyEffect({ validationId: (viaB as { id: string }).id }, { env: () => environment }))).toContain(s.gmailMessageId);
  });

  it("two producers with two different texts for the same mail: the second replaces the first, only one can ever be approved, and one mail is sent once", async () => {
    const s = await scenario("answer");
    const mine = { ...s.proposal, text: finalReplyText("SYNTHETIC from the case store.") }, theirs = await asB(s, { text: finalReplyText("SYNTHETIC from pole B.") });
    const first = await propose(mine), second = await propose(theirs);
    expect((await validationsOf(s.caseId)).map(row => row.state)).toEqual(["superseded", "proposed"]);
    expect(await approve(first, mine)).toMatchObject({ ok: false, code: "not_proposed", detail: "superseded" });
    const hashSeenByThePerson = caseReplyPayloadHash({ ...theirs, triggerEventId: `inbound:${s.gmailMessageId}` });
    expect(await decideCaseReply({ action: "approve", validationId: second, approverId: APPROVER, seen: { payloadHash: hashSeenByThePerson, caseVersion: theirs.caseVersion, recipient: theirs.recipient }, authorizer: allow, deps: storeDeps() })).toMatchObject({ ok: true, changed: true });
    // the other producer comes back with its own text after the approval: refused, the trigger already holds an approved reply
    expect(await submitCaseReplyProposal({ ...mine, text: finalReplyText("SYNTHETIC again.") }, storeDeps())).toMatchObject({ ok: false, code: "trigger_already_approved" });
    const queued = await queue(second);
    if (!queued.ok) throw Error("QUEUE");
    expect(await queue(second)).toMatchObject({ ok: true, created: false, executionId: queued.executionId });
    await run(queued.executionId);
    expect(sends).toBe(1);
    expect(await rows("SELECT count(*)::int AS n FROM sav.case_effect_executions WHERE case_id = $1", [s.caseId])).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*)::int AS n FROM sav.intake_effects WHERE kind = 'reply_send' AND business_key LIKE $1", [`reply:${s.caseId}:%`])).toEqual([{ n: 1 }]);
    expect((await outbound(s.caseId))).toHaveLength(1);
  });

  it("an alias that does not match the stored mail the reply answers is refused, whoever the producer is", async () => {
    const s = await scenario("answer");
    const later = await secondMail(s);
    const firstEvent = await eventOf(s.caseId, caseDedupeKey.inbound(s.gmailMessageId));
    const base = { ...s.proposal, caseVersion: later.version, inboundMessageId: later.message.id };
    for (const trigger of [`in:${firstEvent.id}`, `inbound:${s.gmailMessageId}`]) {
      expect(await submitCaseReplyProposal({ ...base, triggerEventId: trigger }, storeDeps()), trigger).toMatchObject({ ok: false, code: "trigger_inconsistent" });
    }
    expect(await validationsOf(s.caseId)).toEqual([]);
  });

  it("a free string is not a trigger: a suffix, a retry tag, an unknown or foreign event, a wrong kind of event, an unknown timer", async () => {
    const s = await scenario("answer"), other = await scenario("answer");
    const mine = await eventOf(s.caseId, caseDedupeKey.inbound(s.gmailMessageId)), foreign = await eventOf(other.caseId, caseDedupeKey.inbound(other.gmailMessageId));
    const refusals: [string, string][] = [
      [`inbound:${s.gmailMessageId}:retry`, "trigger_invalid"], [`inbound:${s.gmailMessageId}:2`, "trigger_invalid"], ["made-up", "trigger_invalid"], ["in:not-a-uuid", "trigger_invalid"], ["", "trigger_invalid"],
      [`in:${randomUUID()}`, "trigger_unknown"], [`in:${foreign.id}`, "trigger_unknown"], [`inbound:${other.gmailMessageId}`, "trigger_unknown"],
      [`back:${mine.id}`, "trigger_unknown"], [`back:${randomUUID()}`, "trigger_unknown"], [`timer:${randomUUID()}`, "trigger_unknown"],
    ];
    for (const [trigger, code] of refusals) expect(await submitCaseReplyProposal({ ...s.proposal, triggerEventId: trigger }, storeDeps()), trigger).toMatchObject({ ok: false, code });
    expect(await validationsOf(s.caseId)).toEqual([]);
    expect(await validationsOf(other.caseId)).toEqual([]);
  });

  it("a new customer mail is an independent trigger: its own key; the proposal for the older mail is stale, never sent", async () => {
    const s = await scenario("answer");
    const first = await propose(s.proposal);
    const later = await secondMail(s);
    expect(await submitCaseReplyProposal(s.proposal, storeDeps())).toMatchObject({ ok: true, created: false, id: first });
    const next = { ...s.proposal, caseVersion: later.version, inboundMessageId: later.message.id, triggerEventId: `inbound:${later.gmailMessageId}`, text: finalReplyText("SYNTHETIC for the second mail.") };
    const second = await propose(next);
    expect(second).not.toBe(first);
    expect(await rows("SELECT reply_key, state FROM sav.case_reply_validations WHERE case_id = $1 ORDER BY created_at, id", [s.caseId])).toEqual([
      { reply_key: `reply:${s.caseId}:inbound:${s.gmailMessageId}`, state: "superseded" }, { reply_key: `reply:${s.caseId}:inbound:${later.gmailMessageId}`, state: "proposed" }]);
    expect(await approve(first, s.proposal)).toMatchObject({ ok: false });
    expect(await approve(second, next)).toMatchObject({ ok: true });
  });
});

// Lock order (ROOT review of 48e3e8a): EXECUTION -> CASE -> VALIDATION on every path. PGlite has one connection, so a deadlock cannot be provoked here; what can be
// proved is the order of the lock statements each function issues. The two-connection reproduction is `case-reply-lock-order.native.test.ts` (native instance only).
describe("lock order: the case is locked before the validation on every path of the store", () => {
  const lockStatements = async (call: () => Promise<unknown>) => {
    const log: string[] = [];
    const logged = drizzle(f.client as never, { schema: dbSchema, logger: { logQuery: (query: string) => { log.push(query.toLowerCase()); } } });
    state.db = logged;
    try { await call(); } finally { state.db = f.db; }
    return log;
  };
  const caseLock = (q: string) => /from "sav"\."cases" .*for update/.test(q);
  const validationLock = (q: string) => /case_reply_validations/.test(q) && (/ for (update|share)/.test(q) || /^(update|insert into) "sav"\."case_reply_validations"/.test(q));
  const orderOf = (log: string[]) => ({ caseAt: log.findIndex(caseLock), validationAt: log.findIndex(validationLock) });
  const expectCaseFirst = (log: string[], what: string) => {
    const { caseAt, validationAt } = orderOf(log);
    expect(caseAt, `${what}: no case lock`).toBeGreaterThanOrEqual(0);
    expect(validationAt, `${what}: no validation lock`).toBeGreaterThanOrEqual(0);
    expect(caseAt, `${what}: the validation is locked before the case`).toBeLessThan(validationAt);
  };

  it("submit, approve, decline, revoke and enqueue each lock the case before any validation row", async () => {
    const s = await scenario("answer"), declined = await scenario("question");
    expectCaseFirst(await lockStatements(() => submitCaseReplyProposal(s.proposal, storeDeps())), "submit");
    const id = (await validationsOf(s.caseId))[0]!.id as string;
    expectCaseFirst(await lockStatements(() => approve(id, s.proposal)), "approve");
    expectCaseFirst(await lockStatements(() => queue(id)), "enqueue");
    expectCaseFirst(await lockStatements(() => revokeCaseReply({ validationId: id, approverId: APPROVER, authorizer: allow })), "revoke");
    const other = await propose(declined.proposal);
    expectCaseFirst(await lockStatements(() => decideCaseReply({ action: "decline", validationId: other, approverId: APPROVER, seen: seenOf(declined.proposal), authorizer: allow, deps: storeDeps() })), "decline");
  });

  it("the executor's gate takes its execution row, then the case, then the validation (read from the source, the three statements being in one function)", () => {
    const text = readFileSync(new URL("./case-effect-driver.ts", import.meta.url), "utf8");
    // C6: the reads moved from `gate` into `eligibility`, which `gate` (marker / plan) and `localFenceAfterRead` (final look) both call: one reader, the same order.
    const gate = text.slice(text.indexOf("async function eligibility("), text.indexOf("async function gate("));
    expect(gate.indexOf("readCaseReplyFacts(tx, proposal")).toBeGreaterThan(-1);
    expect(gate).toContain("readCaseReplyFacts(tx, proposal, policyRevision, { lockCase: true })"); // the case row is LOCKED in the gate and in the final look
    expect(gate.indexOf("readCaseReplyFacts(tx, proposal")).toBeLessThan(gate.indexOf("durableApproval(tx, lease, payload)"));
    expect(text).toMatch(/\.for\("share"\)/);
    const caller = text.slice(text.indexOf("async function gate("), text.indexOf("async function assertLocal("));
    expect(caller).toContain("await eligibility(tx, lease, phase");
    const finalLook = text.slice(text.indexOf("async function localFenceAfterRead("), text.indexOf("/** The guard of every plan"));
    expect(finalLook.indexOf("ownedExecution(tx, lease)")).toBeGreaterThan(-1);
    expect(finalLook.indexOf("ownedExecution(tx, lease)")).toBeLessThan(finalLook.indexOf("await eligibility(tx, lease"));
    expect(finalLook.indexOf("await deps.currentPolicyRevision()")).toBeLessThan(finalLook.indexOf("transaction(async tx"));
    const local = text.slice(text.indexOf("async function assertLocal("), text.indexOf("async function withdraw("));
    expect(local.indexOf('.for("update")')).toBeLessThan(local.indexOf("await gate("));
  });
});
