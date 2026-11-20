import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { SAV_INTAKE_CONTRACT_REVISION, type SavIntakeDecision } from "../intake/contract";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import { readConfirmedV1Context } from "./admission-context-reader";
import { caseAdmissionStatus } from "./admission-policy";
import { caseInvestigationQualify, caseRelayAdmissionDeps, type AdmissionInvestigationDeps } from "./admission-investigation-ports";
import type { AdmissionPolicyRecord, V1AdmissionAdapterPolicy } from "./admission-runtime";
import { listCaseEvents, readCase } from "./case-store";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { SAV_SMART_ENTRY_POLICY_REVISION, smartSupportProvenance } from "./smart-entry-switch";
import { v2EntryPolicySources } from "./v2-entry";

/*
 * SAV-117 review P1B, SYNTHETIC only on PGlite: the smart entry through the REAL relay (V1's confirmed records → A's qualification with the real rule port of
 * `v2-entry.ts` → the store) and the REAL re-evaluation (`caseInvestigationQualify`). Proven: every support request of the mail is admitted (5, 15), a cancellation
 * among them keeps the whole mail with the team; the historical admission policy, unreadable here, is never read to qualify; a smart admission never gives the case
 * to the agent (no `v2_attribution`, even with V1's confirmed V2 owner effect) and V2 actors keep refusing it before N8. No HubSpot, no Gmail, no model.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 9_117_000;
const AT = "2026-11-20T01:00:00.000Z", V2_OWNER = "90000117";
const SENDER = "client@example.invalid";
const SMART_ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on", SAV_V2_ENTRY_SMART: "on" };
const SYN_ADAPTER: V1AdmissionAdapterPolicy = { revision: "syn-adapter-r1-pour-test", decidedBy: "synthetic-test-approval-not-production", identity: "sender_unique_crm_match" };

/** The real sources of the entry (rule port of `v2-entry.ts` under the switch), the adapter approved for the test, and a policy reader that cannot read, counted. */
function sources() {
  const policyReads = { count: 0 };
  const deps: AdmissionInvestigationDeps = {
    readConfirmedContext: readConfirmedV1Context, adapterPolicy: async () => SYN_ADAPTER, now: () => new Date(),
    readPolicyRecord: async (): Promise<AdmissionPolicyRecord | null> => { policyReads.count++; throw Error("SAV_V2_ENTRY_ADMISSION_POLICY_JSON_INVALID"); },
    approvedRules: v2EntryPolicySources(SMART_ENV).approvedRules,
  };
  return { deps, policyReads };
}

const evidence = (id: string, source: "current_message" | "crm_contact" | "crm_ticket", sourceId: string) => ({ id, source, sourceId, observedAt: "2026-11-20T00:30:00.000Z", contentHash: "a".repeat(43) });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `request-${i + 1}`);
function ticketDecision(messageId: string, threadId: string, ticketId: string, kinds: string[]): SavIntakeDecision {
  const requestIds = ids(kinds.length);
  return {
    revision: SAV_INTAKE_CONTRACT_REVISION, messageId, latestInboundMessageId: messageId, threadId, receivedAt: "2026-11-20T00:30:00.000Z",
    classification: kinds.includes("cancellation") ? "cancellation" : "support", requests: kinds.map((kind, i) => ({ id: requestIds[i]!, kind, evidenceIds: ["current"] })) as SavIntakeDecision["requests"],
    evidence: [evidence("current", "current_message", messageId), evidence("contact", "crm_contact", "101"), evidence("ticket", "crm_ticket", ticketId),
      { ...evidence("ticket-contact", "crm_ticket", `synthetic-association-${ticketId}-101`), source: "ticket_contact_association" as const, ticketId, contactId: "101", direction: "ticket_to_contact" as const }],
    disposition: {
      kind: "ticket", target: { operation: "link", contactId: "101", ticketId, alreadyNew: false, ticketEvidenceId: "ticket", contactAssociationEvidenceId: "ticket-contact" },
      requestIds,
      contactScope: { primaryContactId: "101", contacts: [{ origin: "email_lookup", addressOrigin: "sender", contactId: "101", evidenceIds: ["contact"] }], complete: true },
      search: "complete", history: "complete",
      identity: { kind: "unique_crm_match_for_intake", addressOrigin: "sender", scope: "intake_only", evidenceIds: ["current", "contact"] },
      sameIssueEvidenceIds: ["current", "ticket"], requiredPermissions: ["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"],
      multiTicketNote: { openTicketIdsOnTargetContact: [ticketId] },
      note: { kind: "existing_return_summary", version: 2, previousState: "open", warningPrefix: null, sourceMessageId: messageId, sourceEvidenceIds: ["current"], renderedContentHash: "a".repeat(43), deduplication: "source_message_and_final_ticket" },
      learning: kinds.includes("cancellation") ? "excluded" : "eligible_after_confirmed_effect", evidenceIds: ["current", "contact", "ticket", "ticket-contact"],
    },
  } as SavIntakeDecision;
}

/** One V1 mail as V1 leaves it (confirmed execution, accepted analysis, optionally V1's confirmed V2 owner effect), then the relay on the entry's sources. */
async function v1Mail(deps: AdmissionInvestigationDeps, kinds: string[], options: { ownerEffect?: boolean } = {}) {
  const ticketId = String(++seq), threadId = randomUUID(), messageId = randomUUID();
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Google Sheet",
    bodyCiphertext: encryptSavPayload({ text: "Bonjour, mon Google Sheet est mal rempli et j'ai d'autres questions fictives." }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: kinds.map((kind, i) => ({ id: ids(kinds.length)[i], kind, currentMessageId: messageId })),
    ticketSummary: { title: "Demande fictive", description: "Description fictive.", requestIds: ids(kinds.length) } };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: 1, isCurrent: false, state: "observed", configHash: `smart-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
      records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runId: run!.id, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: ticketDecision(messageId, threadId, ticketId, kinds) } }) }).returning();
  if (options.ownerEffect) {
    const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
    await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
      intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
  }
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }), ...caseRelayAdmissionDeps(deps), env: SMART_ENV }) as
    { caseId: string; owner: string; admission: { target: string; reasons: string[] } | null };
  return { ticketId, messageId, gmail: `gm-${messageId}`, ...relayed };
}

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-relay-fixture-key-32-chars!!!!!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-smart-admin", email: "smart-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support-smart@example.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-relay-fixture-key-32-chars!!!!!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the smart entry through the real relay and re-evaluation", () => {
  it.each([5, 15])("%i support requests: every one is admitted smart_support, the unreadable policy is read 0 times", async n => {
    const { deps, policyReads } = sources();
    const mail = await v1Mail(deps, Array(n).fill("support"));
    const recorded = (await readCase(mail.caseId))!.admission!;
    expect(recorded).toMatchObject({ target: "agent", reasons: ["admitted"], admission: "smart_support", policyRevision: SAV_SMART_ENTRY_POLICY_REVISION });
    expect(recorded.qualification.requests.map(row => row.requestId)).toEqual(ids(n).map(id => `${mail.gmail}/${id}`));
    expect(recorded.qualification.requests.every(row => JSON.stringify(row.provenance) === JSON.stringify(smartSupportProvenance(row.provenance.kind === "qualified_rule" ? row.provenance.at : "")))).toBe(true);
    expect(policyReads.count).toBe(0);
  });

  it("a cancellation among 15 requests: the whole mail is the team's", async () => {
    const { deps, policyReads } = sources();
    const mail = await v1Mail(deps, [...Array(14).fill("support"), "cancellation"]);
    expect([mail.owner, policyReads.count]).toEqual(["human", 0]);
    expect((await readCase(mail.caseId))!.admission).toMatchObject({ target: "team", sensitivity: "cancellation" });
    expect((await readCase(mail.caseId))!.admission!.admission).toBeUndefined();
  });

  it("V1's confirmed V2 owner effect does not give a smart admission to the agent: the case stays with the team, no v2_attribution", async () => {
    const { deps } = sources();
    const mail = await v1Mail(deps, ["support"], { ownerEffect: true });
    const snapshot = (await readCase(mail.caseId))!;
    expect([mail.owner, snapshot.owner, snapshot.phase]).toEqual(["human", "human", "handoff_pending"]);
    expect(snapshot.admission).toMatchObject({ target: "agent", admission: "smart_support" });
    const events = await listCaseEvents(mail.caseId);
    expect(events.filter(event => event.kind === "owner_changed" && (event.detail as { transition?: string } | null)?.transition === "v2_attribution")).toEqual([]);
    // Before N8, V2 actors keep refusing it (their current revision is the historical policy's, never smart-entry.v1).
    expect(caseAdmissionStatus({ ...snapshot, owner: "agent" }, "syn-policy-r1").admitted).toBe(false);
  });

  it("the re-evaluation reads the mail again through the entry and never reads the unreadable policy", async () => {
    const { deps, policyReads } = sources();
    const mail = await v1Mail(deps, ["support", "support"]);
    const snapshot = (await readCase(mail.caseId))!, events = await listCaseEvents(mail.caseId);
    const qualified = await caseInvestigationQualify(deps)(snapshot, events);
    expect(qualified?.admission.policy).toBeNull();
    expect(qualified?.admission.qualification.requests.map(row => row.requestId)).toEqual([`${mail.gmail}/request-1`, `${mail.gmail}/request-2`]);
    expect(policyReads.count).toBe(0);
    // The stored reading of a manual handover is decided again the same way, with no policy read either.
    const input = events.find(event => event.kind === "inbound_confirmed")!;
    const manual = events.map(event => event.id === input.id ? { ...event, detail: { ...event.detail, relay: { kind: "owner_handover_mail", messageId: mail.messageId, ticketId: snapshot.ticketId } } } : event);
    expect((await caseInvestigationQualify(deps)(snapshot, manual as typeof events))?.admission.policy).toBeNull();
    expect(policyReads.count).toBe(0);
  });

  it("switch off, the same relay reads the policy first, exactly as before (the unreadable policy stops it)", async () => {
    const { deps, policyReads } = sources();
    const offDeps = { ...deps, approvedRules: v2EntryPolicySources({ SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" }).approvedRules };
    const ticketId = String(++seq), threadId = randomUUID(), messageId = randomUUID();
    await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER });
    await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "x",
      bodyCiphertext: encryptSavPayload({ text: "x" }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
    const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: 1, isCurrent: false, state: "observed", configHash: `off-${messageId}`, policyHash: "fixture",
      payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected" }) }).returning();
    await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runId: run!.id, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId,
      payloadCiphertext: encryptSavPayload({ plan: { decision: ticketDecision(messageId, threadId, ticketId, ["support"]) } }) });
    await expect(recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }), ...caseRelayAdmissionDeps(offDeps),
      env: { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" } })).rejects.toThrow("SAV_V2_ENTRY_ADMISSION_POLICY_JSON_INVALID");
    expect(policyReads.count).toBe(1);
    expect((await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, run!.id))).length).toBe(1);
  });
});
