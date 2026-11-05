import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeExecutionPolicies, savIntakeExecutions, savIntakeHumanEvents, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
import { encryptSavPayload } from "../crypto";
import { SAV_INTAKE_CONTRACT_REVISION, type SavIntakeDecision } from "../intake/contract";
import { readConfirmedV1Context } from "./admission-context-reader";
import { qualificationFromConfirmedV1, v1QualificationPort, type V1AdmissionAdapterPolicy } from "./admission-runtime";
import { readCaseByTicket } from "./case-store";
import { recordCaseAfterConfirmedIntake, type CaseQualificationTarget } from "./intake-boundary";

/*
 * SYN only, on the PGlite test database: synthetic ids and mailbox, no HubSpot, no model, no network
 * (fetch throws). The reader under test is read only; the last block runs the real relay with it.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, adminId: string, seq = 8_400_000;
const SENDER_RULE: V1AdmissionAdapterPolicy = { revision: "synthetic-adapter-r1", decidedBy: "synthetic-decision", identity: "sender_unique_crm_match" };
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [], approvedBy: "20000000-0000-4000-8000-000000000003", approvedAt: "2026-10-30T09:00:00.000Z" };

const evidence = (id: string, source: "current_message" | "crm_contact" | "crm_ticket", sourceId: string) => ({ id, source, sourceId, observedAt: "2026-10-20T09:00:00.000Z", contentHash: "a".repeat(43) });
/** The V1 ticket decision of admission-runtime.test.ts, for one message and ticket. */
function ticketDecision(messageId: string, threadId: string, ticketId: string): SavIntakeDecision {
  return {
    revision: SAV_INTAKE_CONTRACT_REVISION, messageId, latestInboundMessageId: messageId, threadId, receivedAt: "2026-10-20T09:00:00.000Z",
    classification: "support", requests: [{ id: "request-1", kind: "support", evidenceIds: ["current"] }],
    evidence: [evidence("current", "current_message", messageId), evidence("contact", "crm_contact", "101"), evidence("ticket", "crm_ticket", ticketId),
      { ...evidence("ticket-contact", "crm_ticket", `synthetic-association-${ticketId}-101`), source: "ticket_contact_association" as const, ticketId, contactId: "101", direction: "ticket_to_contact" as const }],
    disposition: {
      kind: "ticket", target: { operation: "link", contactId: "101", ticketId, alreadyNew: false, ticketEvidenceId: "ticket", contactAssociationEvidenceId: "ticket-contact" },
      requestIds: ["request-1"],
      contactScope: { primaryContactId: "101", contacts: [{ origin: "email_lookup", addressOrigin: "sender", contactId: "101", evidenceIds: ["contact"] }], complete: true },
      search: "complete", history: "complete",
      identity: { kind: "unique_crm_match_for_intake", addressOrigin: "sender", scope: "intake_only", evidenceIds: ["current", "contact"] },
      sameIssueEvidenceIds: ["current", "ticket"], requiredPermissions: ["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"],
      multiTicketNote: { openTicketIdsOnTargetContact: [ticketId] },
      note: { kind: "existing_return_summary", version: 2, previousState: "open", warningPrefix: null, sourceMessageId: messageId, sourceEvidenceIds: ["current"], renderedContentHash: "a".repeat(43), deduplication: "source_message_and_final_ticket" },
      learning: "eligible_after_confirmed_effect", evidenceIds: ["current", "contact", "ticket", "ticket-contact"],
    },
  };
}

type Seed = { messageId: string; threadId: string; ticketId: string; gmailMessageId: string; executionId: string; runId: string | null; runVersion: number };
/** One inbound message, its run (version 1) and its execution, as V1 leaves them. */
async function seed(options: { state?: string; withRun?: boolean; runVersion?: number; ticketId?: string | null; decision?: (d: SavIntakeDecision) => unknown; direction?: "inbound" | "outbound" } = {}): Promise<Seed> {
  const threadId = randomUUID(), messageId = randomUUID(), ticketId = options.ticketId === undefined ? String(++seq) : options.ticketId, gmailMessageId = `gm-${messageId}`;
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: "client@example.invalid" });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: options.direction ?? "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"], subject: "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Corps synthétique" }), receivedAt: new Date("2026-10-27T07:30:00.000Z"), gmailMessageId });
  const runVersion = options.runVersion ?? 1;
  let runId: string | null = null;
  if (options.withRun ?? true) runId = (await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: runVersion, state: "observed", configHash: `config-${runVersion}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({}) }).returning())[0]!.id;
  const decision = ticketDecision(messageId, threadId, ticketId ?? "201");
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runId, runVersion, policyId, policyHash: "fixture", state: options.state ?? "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: options.decision ? options.decision(decision) : decision } }) }).returning();
  return { messageId, threadId, ticketId: ticketId ?? "", gmailMessageId, executionId: execution!.id, runId, runVersion };
}
const targetOf = (s: Seed): CaseQualificationTarget => ({ ticketId: s.ticketId, executionId: s.executionId, runId: s.runId, runVersion: s.runVersion });
const port = (adapter: V1AdmissionAdapterPolicy | null = SENDER_RULE) => v1QualificationPort({ readConfirmedContext: readConfirmedV1Context, adapterPolicy: async () => adapter });
const ask = (s: Seed, target: CaseQualificationTarget = targetOf(s), adapter: V1AdmissionAdapterPolicy | null = SENDER_RULE) =>
  port(adapter)({ messageId: s.messageId, gmailMessageId: s.gmailMessageId, requests: [], target });

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "admission-reader-fixture-key-32-characters");
  f = await createSavTestDb(); state.db = f.db;
  const run = randomUUID();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: `synthetic-reader-admin-${run}`, email: `reader-admin-${run}@example.invalid`, role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-reader-${run}@example.invalid` }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id; adminId = admin!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "admission-reader-fixture-key-32-characters");
  // The relay block writes the case through the real store, which reads the switch from the environment.
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); state.db = f.db; });

describe("readConfirmedV1Context: V1's own records, read only", () => {
  it("returns the confirmed execution's decision with its source and freshness, in one read-only repeatable-read transaction", async () => {
    const s = await seed();
    const transaction = vi.spyOn(f.db, "transaction");
    const context = await readConfirmedV1Context(s.messageId);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
    expect(context).toMatchObject({
      source: { messageId: s.messageId, gmailMessageId: s.gmailMessageId, executionId: s.executionId, executionState: "confirmed", runId: s.runId, runVersion: 1, ticketId: s.ticketId },
      freshness: { latestRunVersion: 1, humanRefused: false }, decision: { messageId: s.messageId, revision: SAV_INTAKE_CONTRACT_REVISION },
    });
    expect(qualificationFromConfirmedV1(context!, SENDER_RULE).trace).toEqual({ identity: "confirmed_sender_unique_crm_match", crmContext: "complete" });
  });

  it("no execution for the message is null (absent), not an error", async () => {
    const s = await seed();
    await f.db.delete(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, s.messageId));
    expect(await readConfirmedV1Context(s.messageId)).toBeNull();
  });

  it.each([
    ["an invalid message id", async () => "not-a-uuid", "SAV_V1_CONTEXT_MESSAGE_INVALID"],
    ["a missing message", async () => randomUUID(), "SAV_V1_CONTEXT_MESSAGE_MISSING"],
    ["an outbound message", async () => (await seed({ direction: "outbound" })).messageId, "SAV_V1_CONTEXT_SOURCE_INVALID"],
    ["an execution whose run is gone", async () => {
      const s = await seed(); await f.db.update(savIntakeExecutions).set({ runId: randomUUID() }).where(eq(savIntakeExecutions.id, s.executionId)); return s.messageId;
    }, "SAV_V1_CONTEXT_RUN_MISSING"],
    ["an execution pointing at another message's run", async () => {
      const other = await seed(), s = await seed(); await f.db.update(savIntakeExecutions).set({ runId: other.runId }).where(eq(savIntakeExecutions.id, s.executionId)); return s.messageId;
    }, "SAV_V1_CONTEXT_RUN_MISSING"],
    ["an execution whose run version differs", async () => {
      const s = await seed(); await f.db.update(savIntakeExecutions).set({ runVersion: 2 }).where(eq(savIntakeExecutions.id, s.executionId)); return s.messageId;
    }, "SAV_V1_CONTEXT_RUN_VERSION_MISMATCH"],
    ["an execution on another thread", async () => {
      const other = await seed(), s = await seed(); await f.db.update(savIntakeExecutions).set({ threadId: other.threadId }).where(eq(savIntakeExecutions.id, s.executionId)); return s.messageId;
    }, "SAV_V1_CONTEXT_THREAD_MISMATCH"],
    ["a decision of another message", async () => (await seed({ decision: d => ({ ...d, messageId: randomUUID() }) })).messageId, "SAV_V1_CONTEXT_DECISION_MESSAGE_MISMATCH"],
    ["a current-revision decision the V1 contract refuses", async () => (await seed({ decision: d => ({ ...d, disposition: { ...d.disposition, search: "partial" } }) })).messageId, "SAV_V1_CONTEXT_DECISION_INVALID"],
    ["a payload without a decision", async () => (await seed({ decision: () => undefined })).messageId, "SAV_V1_CONTEXT_DECISION_MISSING"],
    ["an execution without a ticket", async () => (await seed({ ticketId: null, state: "running" })).messageId, "SAV_V1_CONTEXT_TICKET_MISSING"],
  ])("%s throws (unavailable is never absent)", async (_name, make, code) => {
    const messageId = await make();
    await expect(readConfirmedV1Context(messageId)).rejects.toThrow(code);
  });

  it("a database that cannot be read throws, through the port too", async () => {
    const s = await seed();
    state.db = null;
    await expect(readConfirmedV1Context(s.messageId)).rejects.toThrow("NO_DB_ALLOWED");
    await expect(ask(s)).rejects.toThrow("NO_DB_ALLOWED");
  });

  it.each([
    ["an execution that is not confirmed", { state: "uncertain" }, "context_not_current"],
    ["an execution without its run", { withRun: false }, "context_not_current"],
    ["an older V1 contract revision", { decision: (d: SavIntakeDecision) => ({ ...d, revision: "sav-intake-2026-10-01.v1", disposition: { kind: "legacy" } }) }, "context_not_current"],
  ] as const)("%s is returned as it is and gives unknown", async (_name, options, trace) => {
    const s = await seed(options);
    const context = await readConfirmedV1Context(s.messageId);
    expect(context).not.toBeNull();
    expect(qualificationFromConfirmedV1(context!, SENDER_RULE)).toMatchObject({ qualification: { identity: { status: "unknown" }, crmContext: "unknown" }, trace: { identity: trace } });
  });

  it("a newer V1 run of the same message makes the execution stale", async () => {
    const s = await seed();
    await f.db.update(savIntakeRuns).set({ isCurrent: false }).where(eq(savIntakeRuns.id, s.runId!));
    await f.db.insert(savIntakeRuns).values({ threadId: s.threadId, messageId: s.messageId, version: 2, state: "observed", configHash: "config-2", policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) });
    const context = await readConfirmedV1Context(s.messageId);
    expect(context!.freshness.latestRunVersion).toBe(2);
    expect((await ask(s))!.identity).toEqual({ status: "unknown" });
  });

  it("an operator's refusal of the analysis makes it unknown", async () => {
    const s = await seed();
    await f.db.insert(savIntakeHumanEvents).values({ commandKey: randomUUID(), threadId: s.threadId, messageId: s.messageId, parentRunId: s.runId!, parentVersion: 1,
      baseConfigHash: "config-1", sourceHash: "synthetic-source", kind: "refuse", payloadCiphertext: encryptSavPayload({ revision: "sav-intake-human.v1", actor: { id: adminId, email: "reader-admin@example.invalid" } }) });
    expect((await readConfirmedV1Context(s.messageId))!.freshness.humanRefused).toBe(true);
    expect((await ask(s))!.identity).toEqual({ status: "unknown" });
  });
});

describe("v1QualificationPort with the reader: the source is compared with the relay's target before any qualification", () => {
  it("a matching target under an explicit adapter decision confirms the sender, CRM complete, no family", async () => {
    const s = await seed();
    expect(await ask(s)).toEqual({ requests: [], identity: { status: "confirmed", source: { type: "hubspot_object", id: "101" } }, crmContext: "complete", teamSignals: [] });
  });
  it("without an adapter decision (today) the same execution stays unknown", async () => {
    const s = await seed();
    expect(await ask(s, targetOf(s), null)).toEqual({ requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] });
  });
  it("no target throws, before the database is read", async () => {
    const s = await seed();
    const transaction = vi.spyOn(f.db, "transaction");
    await expect(port()({ messageId: s.messageId, gmailMessageId: s.gmailMessageId, requests: [] })).rejects.toThrow("SAV_V1_QUALIFICATION_TARGET_MISSING");
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    ["another ticket", (t: CaseQualificationTarget) => ({ ...t, ticketId: "999999" })],
    ["another execution", (t: CaseQualificationTarget) => ({ ...t, executionId: randomUUID() })],
    ["an acknowledgement target (no execution)", (t: CaseQualificationTarget) => ({ ...t, executionId: null })],
    ["another run", (t: CaseQualificationTarget) => ({ ...t, runId: randomUUID() })],
    ["another run version", (t: CaseQualificationTarget) => ({ ...t, runVersion: 2 })],
  ])("a target naming %s throws", async (_name, change) => {
    const s = await seed();
    await expect(ask(s, change(targetOf(s)))).rejects.toThrow("SAV_V1_QUALIFICATION_SOURCE_MISMATCH");
  });
  it("another Gmail id for the same message throws", async () => {
    const s = await seed();
    await expect(port()({ messageId: s.messageId, gmailMessageId: "gm-other", requests: [], target: targetOf(s) })).rejects.toThrow("SAV_V1_QUALIFICATION_SOURCE_MISMATCH");
  });
});

describe("the real relay with the reader injected: nothing is admitted for the agent", () => {
  const relay = (s: Seed, adapter: V1AdmissionAdapterPolicy | null) => recordCaseAfterConfirmedIntake(s.messageId, {
    env: { SAV_CASE_RECORDING: "on" }, readProgress: async () => ({ state: "confirmed", ticketId: s.ticketId, confirmed: true }),
    readAdmissionPolicy: async () => POLICY, readQualification: port(adapter),
  });
  it("today (no adapter decision): the case waits for qualification, identity unconfirmed", async () => {
    const s = await seed();
    const result = await relay(s, null);
    expect(result).toMatchObject({ created: true, owner: "human", admission: { target: "qualification" } });
    expect((result as { admission: { reasons: string[] } }).admission.reasons).toEqual(expect.arrayContaining(["identity_unconfirmed", "context_incomplete"]));
  });
  it("with an explicit adapter decision the identity is confirmed, yet no family is proven: still not the agent", async () => {
    const s = await seed();
    const result = await relay(s, SENDER_RULE);
    expect(result).toMatchObject({ created: true, owner: "human", admission: { target: "qualification" } });
    const reasons = (result as { admission: { reasons: string[] } }).admission.reasons;
    expect(reasons).toContain("family_unknown");
    expect(reasons).not.toContain("identity_unconfirmed");
    expect((await readCaseByTicket(s.ticketId))!.owner).toBe("human");
  });
  it("nothing here touches the network", async () => {
    await relay(await seed(), SENDER_RULE);
    expect(fetch).not.toHaveBeenCalled();
  });
});
