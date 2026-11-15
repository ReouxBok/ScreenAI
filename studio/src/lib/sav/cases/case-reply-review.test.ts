import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { auditLogs, savCaseEffectExecutions, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "../intake/execution-policy";
import { openCaseEvent, readCase, updateCaseRecord } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply, submitCaseReplyProposal, type CaseReplyStoreDeps } from "./case-reply-store";
import { CASE_REPLY_STUDIO_APPROVAL_BASIS, CASE_REPLY_STUDIO_CORRECTION_BASIS } from "./case-reply-validation";
import { encodeCaseReplyReviewToken, reviewCaseReply, studioReviewAuthorizer, type CaseReplyReviewDeps, type CaseReplyReviewInput } from "./case-reply-review";
import type { ImmediateCaseReplySend } from "./immediate-send-budget";

// SAV-92: the Studio decision on the REAL store, registry and SAV-5 case store (PGlite, synthetic data only). No provider is reached: the immediate send is a
// counted double (the executor itself is covered by case-reply-durable.test.ts); what is proven here is that every refusal writes and sends nothing, and that a
// double click or two administrators make ONE approval, ONE execution and ONE immediate pass.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, policyHash: string, environment: Record<string, string | undefined>, ticketSeq = 9_400_000;
const POLICY = "policy-r1", AT = "2026-10-27T09:00:00.000Z";
const ADMIN = "20000000-0000-4000-8000-000000000003", OTHER_ADMIN = "20000000-0000-4000-8000-000000000004";
const reviewer = { staffUserId: ADMIN, email: "admin@example.invalid" }, otherReviewer = { staffUserId: OTHER_ADMIN, email: "other-admin@example.invalid" };
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: ADMIN, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: ADMIN, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const storeDeps = (extra: Partial<CaseReplyStoreDeps> = {}): CaseReplyStoreDeps => ({ env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY, ...extra });
let sendNow: ReturnType<typeof vi.fn<ImmediateCaseReplySend>>;
const deps = (store: CaseReplyStoreDeps = storeDeps()): CaseReplyReviewDeps => ({ env: () => environment, store, sendNow, callerDeadlineMs: Date.now() + 100_000 });
const rows = async (sqlText: string, params: unknown[] = []) => (await f.client.query<Record<string, unknown>>(sqlText, params)).rows;
const validationsOf = (caseId: string) => rows("SELECT id, state, decided_by, authorization_basis, execution_id FROM sav.case_reply_validations WHERE case_id = $1 ORDER BY created_at, id", [caseId]);
const executionsOf = async (caseId: string) => f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, caseId));
const auditsOf = async (validationId: string) => f.db.select().from(auditLogs).where(eq(auditLogs.entityId, validationId));
const setPause = async (agent: "intake" | "v2", level: "actions_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, `sav-agent-pause.v1:${agent}`));
  if (level) await f.db.insert(savSyncState).values({ key: `sav-agent-pause.v1:${agent}`, status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent, level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
};

/** A case admitted for the agent, its customer mail, and the agent's proposal stored as `proposed` (what a draft block leaves for a person). */
async function proposedReply(text = "Bonjour,\n\nVoici comment retrouver votre accès.") {
  const gmailThreadId = `gmail-thread-${randomUUID()}`, gmailMessageId = `gm-${randomUUID()}`, ticketId = String(++ticketSeq);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({
    threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject: "Accès synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Je n'arrive pas à me connecter (synthétique).", headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z"),
  }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  const snapshot = (await readCase(opened.caseId))!;
  const proposal: CaseReplyProposal = { caseId: opened.caseId, caseVersion: snapshot.version, triggerEventId: `inbound:${gmailMessageId}`, inboundMessageId: message.id, purpose: "answer",
    recipient: "customer@example.invalid", subject: "Accès synthétique", text: finalReplyText(text) };
  const submitted = await submitCaseReplyProposal(proposal, storeDeps());
  if (!submitted.ok) throw Error(`SUBMIT_REFUSED:${submitted.code}`);
  const token = encodeCaseReplyReviewToken({ validationId: submitted.id, payloadHash: caseReplyPayloadHash(proposal), caseVersion: snapshot.version });
  return { caseId: opened.caseId, ticketId, thread, validationId: submitted.id, proposal, token, version: snapshot.version };
}
const review = (input: CaseReplyReviewInput, who = reviewer, d = deps()) => reviewCaseReply(input, who, d);
/** Nothing decided, nothing queued, nothing sent, nothing audited. */
async function nothingHappened(s: Awaited<ReturnType<typeof proposedReply>>) {
  expect(await validationsOf(s.caseId)).toMatchObject([{ id: s.validationId, state: "proposed", decided_by: null, execution_id: null }]);
  expect(await executionsOf(s.caseId)).toHaveLength(0);
  expect(await auditsOf(s.validationId)).toHaveLength(0);
  expect(sendNow).not.toHaveBeenCalled();
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
  }
  environment = { SAV_V2_REPLY_REVIEW: "on", SAV_CASE_EFFECTS: "supervised", SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash, SAV_CODE_REVISION: "a".repeat(40), HUBSPOT_ACCESS_TOKEN: "fake" };
  expect(intakeExecutionConfig(environment)).not.toBeNull();
  sendNow = vi.fn<ImmediateCaseReplySend>(async () => ({ skipped: "synthetic" }));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setPause("v2", null); await setPause("intake", null); });

describe("SAV_V2_REPLY_REVIEW: off unless exactly « on »", () => {
  it("absent, off or any other value: every action is refused review_off, nothing is decided, queued, sent or audited", async () => {
    const s = await proposedReply();
    for (const value of [undefined, "off", "ON", "true", ""]) {
      environment = { ...environment, SAV_V2_REPLY_REVIEW: value };
      for (const action of ["approve", "correct", "decline", "requeue"] as const)
        expect(await review({ action, token: s.token, text: "Bonjour, corrigé.", reason: "Motif synthétique" })).toEqual({ ok: false, code: "review_off" });
    }
    await nothingHappened(s);
  });
});

describe("approve and send: the registry's own path, once", () => {
  it("approves the exact proposal with the Studio basis, queues ONE execution, starts ONE immediate pass, audits who and when", async () => {
    const s = await proposedReply();
    const result = await review({ action: "approve", token: s.token });
    expect(result).toMatchObject({ ok: true, action: "approve", caseId: s.caseId, validationId: s.validationId, send: "catch_up" });
    expect(await validationsOf(s.caseId)).toMatchObject([{ id: s.validationId, state: "approved", decided_by: ADMIN, authorization_basis: CASE_REPLY_STUDIO_APPROVAL_BASIS }]);
    const executions = await executionsOf(s.caseId);
    expect(executions).toHaveLength(1); expect(result.ok && result.executionId).toBe(executions[0]!.id);
    expect(sendNow).toHaveBeenCalledTimes(1); expect(sendNow).toHaveBeenCalledWith(expect.objectContaining({ executionId: executions[0]!.id }));
    const [entry] = await auditsOf(s.validationId);
    expect(entry).toMatchObject({ actorEmail: "admin@example.invalid", action: "sav_case_reply_review", entityType: "sav_case_reply_validation" });
    expect(entry!.technicalMetadata).toMatchObject({ decision: "approve", caseId: s.caseId, validationId: s.validationId, executionId: executions[0]!.id, queued: true });
    // The logs carry identifiers only: no recipient, no text.
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logged).not.toContain("customer@example.invalid"); expect(logged).not.toContain("retrouver votre accès");
  });

  it("double click and two administrators at once: one approval, one execution, one immediate pass; the late click is refused as already decided", async () => {
    const s = await proposedReply();
    const results = await Promise.all([review({ action: "approve", token: s.token }), review({ action: "approve", token: s.token }), review({ action: "approve", token: s.token }, otherReviewer)]);
    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (!r.ok) expect(["already_decided", "not_proposed"]).toContain(r.code);
    expect(await validationsOf(s.caseId)).toMatchObject([{ state: "approved" }]);
    expect(await executionsOf(s.caseId)).toHaveLength(1);
    expect(sendNow).toHaveBeenCalledTimes(1);
    expect(await review({ action: "approve", token: s.token })).toEqual({ ok: false, code: "already_decided", detail: "approved" });
    expect(await executionsOf(s.caseId)).toHaveLength(1); expect(sendNow).toHaveBeenCalledTimes(1);
  });
});

describe("P2-1: an approval recorded but not queued is re-queued by « Remettre en file », once", () => {
  /** An owner reader that fails on its n-th call only (the queue's read), as a passing CRM outage would. */
  const failingOnCall = (n: number) => { let calls = 0; return storeDeps({ readTicketOwner: async () => { calls += 1; if (calls === n) throw Error("SYNTHETIC_CRM_DOWN"); return "v2" as const; } }); };
  const requeueToken = async (caseId: string, validationId: string, payloadHash: string) =>
    encodeCaseReplyReviewToken({ validationId, payloadHash, caseVersion: (await readCase(caseId))!.version });

  it("approve: the queue fails after the decision; the requeue makes ONE execution and ONE immediate pass; a second and concurrent requeues double nothing", async () => {
    const s = await proposedReply();
    // Call 1: the review's own check; call 2: the queue's.
    expect(await review({ action: "approve", token: s.token }, reviewer, deps(failingOnCall(2)))).toMatchObject({ ok: false, code: "owner_read_failed", approvedValidationId: s.validationId });
    expect(await validationsOf(s.caseId)).toMatchObject([{ id: s.validationId, state: "approved", authorization_basis: CASE_REPLY_STUDIO_APPROVAL_BASIS, execution_id: null }]);
    expect(await executionsOf(s.caseId)).toHaveLength(0); expect(sendNow).not.toHaveBeenCalled();
    // « Approuver » again is refused: it is no longer proposed.
    expect(await review({ action: "approve", token: s.token })).toEqual({ ok: false, code: "already_decided", detail: "approved" });
    const token = await requeueToken(s.caseId, s.validationId, caseReplyPayloadHash(s.proposal));
    const first = await review({ action: "requeue", token });
    expect(first).toMatchObject({ ok: true, action: "requeue", validationId: s.validationId, send: "catch_up" });
    const executions = await executionsOf(s.caseId);
    expect(executions).toHaveLength(1); expect(sendNow).toHaveBeenCalledTimes(1);
    expect(await validationsOf(s.caseId)).toMatchObject([{ id: s.validationId, state: "approved", execution_id: executions[0]!.id }]);
    // A second click, then two administrators at once: refused as already queued (or the same execution), never a second one.
    expect(await review({ action: "requeue", token })).toEqual({ ok: false, code: "already_queued" });
    const again = await Promise.all([review({ action: "requeue", token }), review({ action: "requeue", token }, otherReviewer)]);
    for (const r of again) expect(r.ok ? r.executionId : r.code).toBe(r.ok ? executions[0]!.id : "already_queued");
    expect(await executionsOf(s.caseId)).toHaveLength(1); expect(sendNow).toHaveBeenCalledTimes(1);
    expect((await auditsOf(s.validationId)).map(entry => (entry.technicalMetadata as { decision: string }).decision).sort()).toEqual(["approve", "requeue"]);
  });

  it("two requeues racing on an approved, unqueued reply: one execution, one immediate pass", async () => {
    const s = await proposedReply();
    expect(await review({ action: "approve", token: s.token }, reviewer, deps(failingOnCall(2)))).toMatchObject({ ok: false, approvedValidationId: s.validationId });
    const token = await requeueToken(s.caseId, s.validationId, caseReplyPayloadHash(s.proposal));
    const results = await Promise.all([review({ action: "requeue", token }), review({ action: "requeue", token }), review({ action: "requeue", token }, otherReviewer)]);
    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (!r.ok) expect(r.code).toBe("already_queued");
    expect(await executionsOf(s.caseId)).toHaveLength(1); expect(sendNow).toHaveBeenCalledTimes(1);
  });

  it("correct: the corrected text is stored and approved, the queue fails; the requeue on the corrected reply queues it once, under the correction basis", async () => {
    const s = await proposedReply();
    // Call 1: the review's check; call 2: the corrected proposal's store; call 3: the queue's.
    const failed = await review({ action: "correct", token: s.token, text: "Bonjour,\n\nTexte corrigé, file en panne (synthétique)." }, reviewer, deps(failingOnCall(3)));
    expect(failed).toMatchObject({ ok: false, code: "owner_read_failed" });
    const corrected = (failed as { approvedValidationId?: string }).approvedValidationId!;
    expect(await validationsOf(s.caseId)).toMatchObject([{ state: "superseded" }, { id: corrected, state: "approved", authorization_basis: CASE_REPLY_STUDIO_CORRECTION_BASIS, execution_id: null }]);
    const [row] = await rows("SELECT payload_hash FROM sav.case_reply_validations WHERE id = $1", [corrected]);
    const token = await requeueToken(s.caseId, corrected, row!.payload_hash as string);
    expect(await review({ action: "requeue", token })).toMatchObject({ ok: true, action: "requeue", validationId: corrected });
    expect(await review({ action: "requeue", token })).toEqual({ ok: false, code: "already_queued" });
    expect(await executionsOf(s.caseId)).toHaveLength(1); expect(sendNow).toHaveBeenCalledTimes(1);
  });

  it("not this button's: a proposed reply, a declined one, or an approval that is not the Studio's is refused, nothing written", async () => {
    const s = await proposedReply();
    expect(await review({ action: "requeue", token: s.token })).toEqual({ ok: false, code: "not_requeueable", detail: "proposed" });
    await nothingHappened(s);
    // An approval under another basis (the automatic rule's, here a fixture's): its own passage re-queues it, not the Studio.
    const seen = { payloadHash: caseReplyPayloadHash(s.proposal), caseVersion: s.proposal.caseVersion, recipient: s.proposal.recipient };
    expect(await decideCaseReply({ action: "approve", validationId: s.validationId, approverId: ADMIN, seen, deps: storeDeps(), authorizer: () => ({ allowed: true, basis: "fixture.allow" }) })).toMatchObject({ ok: true });
    expect(await review({ action: "requeue", token: s.token })).toEqual({ ok: false, code: "not_requeueable", detail: "approved" });
    expect(await executionsOf(s.caseId)).toHaveLength(0); expect(sendNow).not.toHaveBeenCalled();
  });
});

describe("a stale version refuses: nothing is decided, queued or sent", () => {
  it("a new customer mail since the screen: case_version_changed", async () => {
    const s = await proposedReply();
    await openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`late-${randomUUID()}`), sourceRef: { type: "email", id: "late" }, occurredAt: "2026-10-28T07:30:00.000Z" });
    for (const action of ["approve", "correct", "decline"] as const)
      expect(await review({ action, token: s.token, text: "Bonjour, texte corrigé.", reason: "Motif synthétique" })).toEqual({ ok: false, code: "case_version_changed" });
    await nothingHappened(s);
  });
  it("a newer proposal replaced the one on screen: already_decided (superseded); a forged or other hash: payload_changed; a garbled token: token_invalid", async () => {
    const s = await proposedReply();
    expect(await review({ action: "approve", token: s.token.replace(/\.[a-f0-9]{64}\./, `.${"f".repeat(64)}.`) })).toEqual({ ok: false, code: "payload_changed" });
    expect(await review({ action: "approve", token: "v1.not-a-token" })).toEqual({ ok: false, code: "token_invalid" });
    const newer = await submitCaseReplyProposal({ ...s.proposal, text: finalReplyText("Bonjour, une autre proposition.") }, storeDeps());
    expect(newer).toMatchObject({ ok: true, created: true });
    expect(await review({ action: "approve", token: s.token })).toEqual({ ok: false, code: "already_decided", detail: "superseded" });
    expect(await executionsOf(s.caseId)).toHaveLength(0); expect(sendNow).not.toHaveBeenCalled();
  });
  it("a pause refuses the send (approve and correct), the CRM ticket taken by a person refuses it too", async () => {
    const s = await proposedReply();
    await setPause("v2", "actions_paused");
    expect(await review({ action: "approve", token: s.token })).toMatchObject({ ok: false, code: "paused" });
    expect(await review({ action: "correct", token: s.token, text: "Bonjour, corrigé." })).toMatchObject({ ok: false, code: "paused" });
    await setPause("v2", null);
    expect(await review({ action: "approve", token: s.token }, reviewer, deps(storeDeps({ readTicketOwner: async () => "human" as const })))).toMatchObject({ ok: false, code: "owner_human" });
    await nothingHappened(s);
  });
});

describe("corrected text: the automatic path's checks, then the same registry", () => {
  it("a text that asks for a secret is refused by the validator: nothing stored, nothing sent, the reason is returned", async () => {
    const s = await proposedReply();
    const result = await review({ action: "correct", token: s.token, text: "Bonjour,\n\nMerci de nous envoyer votre mot de passe pour vérifier." });
    expect(result).toEqual({ ok: false, code: "text_refused", problems: [{ code: "credential_request_pattern" }] });
    await nothingHappened(s);
    expect(await review({ action: "correct", token: s.token, text: "   " })).toEqual({ ok: false, code: "text_empty" });
    expect(await review({ action: "correct", token: s.token, text: "x".repeat(6001) })).toEqual({ ok: false, code: "text_too_long" });
    await nothingHappened(s);
  });
  it("an accepted correction is a new proposal with the AI mention, approved under the correction basis; the original is superseded; one execution", async () => {
    const s = await proposedReply();
    const result = await review({ action: "correct", token: s.token, text: "Bonjour,\n\nVoici la procédure corrigée par l'équipe." });
    expect(result).toMatchObject({ ok: true, action: "correct" });
    const rowsNow = await validationsOf(s.caseId);
    expect(rowsNow).toMatchObject([{ id: s.validationId, state: "superseded" }, { state: "approved", decided_by: ADMIN, authorization_basis: CASE_REPLY_STUDIO_CORRECTION_BASIS }]);
    const [stored] = await rows("SELECT proposal_ciphertext FROM sav.case_reply_validations WHERE id = $1", [rowsNow[1]!.id]);
    const sent = decryptSavPayload<CaseReplyProposal>(stored!.proposal_ciphertext as string);
    expect(sent.text).toBe(finalReplyText("Bonjour,\n\nVoici la procédure corrigée par l'équipe."));
    expect(sent.recipient).toBe("customer@example.invalid");
    expect(await executionsOf(s.caseId)).toHaveLength(1); expect(sendNow).toHaveBeenCalledTimes(1);
    // A second click with the same token: the original is no longer proposed.
    expect(await review({ action: "correct", token: s.token, text: "Bonjour,\n\nVoici la procédure corrigée par l'équipe." })).toEqual({ ok: false, code: "already_decided", detail: "superseded" });
    expect(await executionsOf(s.caseId)).toHaveLength(1);
  });
  it("pilot provenance: only the correction basis lets a person's text differ from the decision's; any other basis is still refused", async () => {
    const s = await proposedReply();
    // A gate that, like the real one, refuses a text that is not the decision's, unless the persisted basis is the correction basis.
    const gate = vi.fn(async (proposal: CaseReplyProposal, context?: { basis?: string | null }) => proposal.text === s.proposal.text || context?.basis === CASE_REPLY_STUDIO_CORRECTION_BASIS ? null : "reply_not_from_decision");
    const corrected = { ...s.proposal, text: finalReplyText("Bonjour, texte d'une personne.") };
    const submitted = await submitCaseReplyProposal(corrected, storeDeps(), { supersedes: { validationId: s.validationId, payloadHash: caseReplyPayloadHash(s.proposal) } });
    expect(submitted).toMatchObject({ ok: true, created: true });
    const id = (submitted as { id: string }).id, seen = { payloadHash: caseReplyPayloadHash(corrected), caseVersion: corrected.caseVersion, recipient: corrected.recipient };
    expect(await decideCaseReply({ action: "approve", validationId: id, approverId: ADMIN, seen, deps: storeDeps({ pilotProvenance: gate }),
      authorizer: studioReviewAuthorizer({ staffUserId: ADMIN, action: "approve", payloadHash: seen.payloadHash, basis: CASE_REPLY_STUDIO_APPROVAL_BASIS }) }))
      .toEqual({ ok: false, code: "provenance_unproven", detail: "reply_not_from_decision" });
    expect(await decideCaseReply({ action: "approve", validationId: id, approverId: ADMIN, seen, deps: storeDeps({ pilotProvenance: gate }),
      authorizer: studioReviewAuthorizer({ staffUserId: ADMIN, action: "approve", payloadHash: seen.payloadHash, basis: CASE_REPLY_STUDIO_CORRECTION_BASIS }) }))
      .toMatchObject({ ok: true, changed: true });
  });
  it("supersedes is checked under the case lock: a correction of a proposal that is no longer proposed stores nothing", async () => {
    const s = await proposedReply();
    expect(await review({ action: "approve", token: s.token })).toMatchObject({ ok: true });
    const late = await submitCaseReplyProposal({ ...s.proposal, text: finalReplyText("Bonjour, trop tard.") }, storeDeps(), { supersedes: { validationId: s.validationId, payloadHash: caseReplyPayloadHash(s.proposal) } });
    expect(late).toEqual({ ok: false, code: "not_proposed", detail: "approved" });
    expect(await validationsOf(s.caseId)).toHaveLength(1);
  });
});

describe("sensitive case: never sent from the button", () => {
  it("the database itself refuses a finance case admitted for the agent (so such a case never reaches the button as the agent's)", async () => {
    const s = await proposedReply();
    await expect(f.client.query("UPDATE sav.cases SET sensitivity = 'finance' WHERE id = $1", [s.caseId])).rejects.toThrow(/sav_cases_sensitive_not_admitted/);
  });
  it("an open sensitive request (subscription, written by a person): approve and correct refused, nothing written; a decline stays possible", async () => {
    const s = await proposedReply();
    const current = (await readCase(s.caseId))!;
    const moved = await updateCaseRecord({ caseId: s.caseId, expectedVersion: current.version, actor: { type: "human", staffUserId: ADMIN }, body: { ...current.body,
      openRequests: [...current.body.openRequests, { id: "m1/r9", summary: "Changement d'abonnement (synthétique)", family: "subscription", status: "open", openedAt: "2026-10-28T07:00:00.000Z" }] } });
    const token = encodeCaseReplyReviewToken({ validationId: s.validationId, payloadHash: caseReplyPayloadHash(s.proposal), caseVersion: moved.version });
    expect(await review({ action: "approve", token })).toEqual({ ok: false, code: "sensitive" });
    expect(await review({ action: "correct", token, text: "Bonjour, corrigé." })).toEqual({ ok: false, code: "sensitive" });
    await nothingHappened(s);
    expect(await review({ action: "decline", token, reason: "Abonnement, à traiter par l'équipe" })).toMatchObject({ ok: true, action: "decline", handoff: "done" });
    expect(await executionsOf(s.caseId)).toHaveLength(0); expect(sendNow).not.toHaveBeenCalled();
  });
});

describe("decline: recorded, nothing sent, the case goes to the team", () => {
  it("records the refusal by this administrator, hands the case to the team, keeps the reason in the audit log only", async () => {
    const s = await proposedReply();
    expect(await review({ action: "decline", token: s.token, reason: "  " })).toEqual({ ok: false, code: "reason_invalid" });
    await nothingHappened(s);
    const result = await review({ action: "decline", token: s.token, reason: "Réponse hors sujet (synthétique)" });
    expect(result).toEqual({ ok: true, action: "decline", caseId: s.caseId, validationId: s.validationId, handoff: "done" });
    expect(await validationsOf(s.caseId)).toMatchObject([{ state: "declined", decided_by: ADMIN, authorization_basis: CASE_REPLY_STUDIO_APPROVAL_BASIS, execution_id: null }]);
    expect(await executionsOf(s.caseId)).toHaveLength(0); expect(sendNow).not.toHaveBeenCalled();
    expect(await readCase(s.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "studio_reply_declined" } } });
    const [entry] = await auditsOf(s.validationId);
    expect(entry!.technicalMetadata).toMatchObject({ decision: "decline", handoff: "done", reason: "Réponse hors sujet (synthétique)" });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("hors sujet");
    // Declining again: the case moved (handoff) and the reply is decided.
    expect(await review({ action: "decline", token: s.token, reason: "Encore" })).toEqual({ ok: false, code: "already_decided", detail: "declined" });
  });
});
