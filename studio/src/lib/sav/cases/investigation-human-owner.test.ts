import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savCaseCalls, savCaseEffectExecutions, savCaseReplyValidations, savCases, savCaseTimers, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Strict local ports: no V1 executor, no model dispatcher, and fetch throws.
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { listCaseEvents, readCase } from "./case-store";
import type { CaseAdmissionQualification, CaseSnapshot, KnowledgeRef } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { caseDecisionDraft } from "./investigation-intent";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput, runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationTicketOwner } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";
import { observeTicketCrmChange } from "./owner-attribution";

/*
 * Ugo's decision (31/10): a ticket owned by a person is not handled by V2. No knowledge search, no model call, no
 * proposal, no reply, no follow-up; a new mail does not free it. Synthetic mails on A's real store and relay, B's runner
 * with counting doubles for knowledge and the model. The case keeps every inbound event for the person; nothing is
 * taken from them and nothing is given to V2.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 8_950_000;
const AT = "2026-10-31T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000004", V2_OWNER = "90000001", PERSON = "70000001";
const ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" };
const SENDER = "client@example.invalid";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } };
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
const readQualification = async (input: { requests: { requestId: string }[] }): Promise<CaseAdmissionQualification> =>
  ({ requests: input.requests.map(request => ruled(request.requestId)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] });

/** One stored V1 mail on a ticket, relayed by A. `ownerEffect`: V1's confirmed V2 owner effect on it (historic ledger row). */
async function v1Mail(options: { ticketId?: string; threadId?: string; ownerEffect: boolean }) {
  const ticketId = options.ticketId ?? String(++seq), threadId = options.threadId ?? randomUUID(), messageId = randomUUID();
  if (!options.threadId) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Corps synthétique" }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
  const runVersion = (await f.db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, threadId))).length + 1;
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: [{ id: "r0", kind: "support" }] } } }) }).returning();
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: [{ id: "r0", kind: "support", currentMessageId: messageId }], ticketSummary: { title: "Connexion impossible", description: "Le code n'arrive pas.", requestIds: ["r0"] } };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: runVersion, isCurrent: false, state: "observed", configHash: `human-owner-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
      records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  await f.db.update(savIntakeExecutions).set({ runId: run!.id, runVersion }).where(eq(savIntakeExecutions.id, execution!.id));
  if (options.ownerEffect) {
    const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
    await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
      intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
  }
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }),
    readAdmissionPolicy: async () => POLICY, readQualification, env: ENV }) as { caseId: string; appended: boolean; owner: string };
  return { ticketId, threadId, gmail: `gm-${messageId}`, caseId: relayed.caseId, relayed };
}

const card: SavRetrievalCandidate = { id: "k-login", contentVersionId: "k-login-v1", title: "Fiche connexion", content: "Procédure synthétique.", source: "fixture",
  verifiedAt: new Date(Date.now() - 864_000_000).toISOString(), semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
const ref: KnowledgeRef = { knowledgeId: card.id, contentVersionId: card.contentVersionId };
const answer = (request: CaseInvestigationModelRequest) => {
  const snapshot: CaseSnapshot = request.snapshot, open = snapshot.body.openRequests.filter(row => row.status === "open");
  return { status: "ok" as const, output: { caseVersion: snapshot.version,
    understanding: { requests: open.map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
    nextAction: { kind: "answer", requestIds: [open[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: ref }], expectedResult: "La connexion fonctionne." },
    reply: { text: "Bonjour, voici la marche à suivre depuis https://new.limova.ai : suivre la fiche.", citations: [ref], impossibilityClaims: [], accountAdvice: "none" } } };
};

type OwnerRead = CaseInvestigationTicketOwner | "throws";
/** B's runner on A's store; every port that would search, read texts, re-qualify, call the model or ask the owner is counted.
 * `owners`: the HubSpot owner answers in order (the last repeats); `absent`: no owner read port. */
async function investigate(caseId: string, owners: OwnerRead | OwnerRead[] | "absent") {
  const counts = { knowledge: 0, customerTexts: 0, model: 0, ownerReads: 0, qualify: 0 };
  const answers = owners === "absent" ? [] : Array.isArray(owners) ? [...owners] : [owners];
  const now = () => new Date(Date.now() + 6 * 60_000);
  const ports = caseInvestigationStorePorts({
    holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => "running",
    knowledge: async () => { counts.knowledge++; return [card]; },
    customerTexts: async (_caseId, refs) => { counts.customerTexts++; return Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])); },
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => { counts.model++; return answer(request); },
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async (snapshot, events) => {
      counts.qualify++;
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id));
      return latest ? { admission: { policy: POLICY, qualification: { requests, identity: CONFIRMED, crmContext: "complete" as const, teamSignals: [] } }, sourceRef: latest.sourceRef } : null;
    },
    ...(owners === "absent" ? {} : { readTicketOwner: async () => {
      counts.ownerReads++;
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (answer === "throws") throw Error("CRM_UNREADABLE");
      return answer;
    } }),
  });
  return { report: await runCaseInvestigation(caseId, "observe", ports), counts };
}

/** Everything V2 could have left behind for this case: lease, calls, decision, proposal, reply, follow-up. */
async function traces(caseId: string) {
  const events = await listCaseEvents(caseId), input = latestInvestigationInput(events);
  const progress = input ? readCaseInvestigationProgress(events, input) : null;
  const record = progress?.state === "found" ? progress.record : null;
  const [row] = await f.db.select({ claim: savCases.claimToken }).from(savCases).where(eq(savCases.id, caseId));
  const count = async (table: typeof savCaseCalls | typeof savCaseEffectExecutions | typeof savCaseReplyValidations | typeof savCaseTimers) =>
    (await f.db.select().from(table).where(eq(table.caseId, caseId))).length;
  return { claim: row!.claim, observations: events.filter(event => event.kind === "observation_recorded").length,
    draft: record ? caseDecisionDraft(caseId, record, events) : null,
    calls: await count(savCaseCalls), effects: await count(savCaseEffectExecutions), validations: await count(savCaseReplyValidations), timers: await count(savCaseTimers) };
}
const NOTHING = { claim: null, observations: 0, draft: null, calls: 0, effects: 0, validations: 0, timers: 0 };

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "human-owner-fixture-key-32-chars!!!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-human-owner-admin", email: "human-owner-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "human-owner-fixture-key-32-chars!!!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("a ticket owned by a person is not handled by V2, even after a new mail", () => {
  it("a case the team holds (no verified V2 owner) stays with it on a new mail: no search, no call, no proposal, no reply, no follow-up", async () => {
    const first = await v1Mail({ ownerEffect: false });
    expect(await readCase(first.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending" });
    const second = await v1Mail({ ticketId: first.ticketId, threadId: first.threadId, ownerEffect: false });
    expect(second.relayed).toMatchObject({ caseId: first.caseId, appended: true, owner: "human" });
    // The new mail is kept for the person.
    expect((await listCaseEvents(first.caseId)).filter(event => event.kind === "inbound_confirmed").map(event => event.dedupeKey)).toEqual([`inbound:${first.gmail}`, `inbound:${second.gmail}`]);
    const { report, counts } = await investigate(first.caseId, "human");
    expect(report).toMatchObject({ status: "skipped", reason: "not_agent_owned", detail: "human", modelCalls: 0 });
    expect(counts).toEqual({ knowledge: 0, customerTexts: 0, model: 0, ownerReads: 0, qualify: 0 });
    expect(await traces(first.caseId)).toEqual(NOTHING);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("a person who took the ticket keeps it: a later mail carrying V1's verified V2 owner effect does not give it to V2", async () => {
    const first = await v1Mail({ ownerEffect: true });
    expect(await readCase(first.caseId)).toMatchObject({ owner: "agent" });
    const taken = await observeTicketCrmChange({ ticketId: first.ticketId, ownerId: PERSON, hubspotUpdatedAt: new Date(Date.now() - 60_000).toISOString(), env: ENV });
    expect(taken).toMatchObject({ takeover: true, case: { owner: "human", phase: "human_owned" } });
    const second = await v1Mail({ ticketId: first.ticketId, threadId: first.threadId, ownerEffect: true });
    expect(second.relayed).toMatchObject({ caseId: first.caseId, appended: true, owner: "human" });
    expect(await readCase(first.caseId)).toMatchObject({ owner: "human", phase: "human_owned" });
    const { report, counts } = await investigate(first.caseId, "v2");
    expect(report).toMatchObject({ status: "skipped", reason: "not_agent_owned", modelCalls: 0 });
    expect(counts).toEqual({ knowledge: 0, customerTexts: 0, model: 0, ownerReads: 0, qualify: 0 });
    expect(await traces(first.caseId)).toEqual(NOTHING);
  });

  it("an agent case whose ticket a person now owns, not yet observed by V2: the owner read stops it before the lease, and takes nothing", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const before = (await readCase(mail.caseId))!;
    expect(before.owner).toBe("agent");
    for (const [owner, reason] of [["human", "ticket_owner_human"], ["none", "ticket_owner_unverified"], ["unknown", "ticket_owner_unverified"], ["throws", "ticket_owner_unverified"]] as const) {
      const { report, counts } = await investigate(mail.caseId, owner);
      expect(report).toMatchObject({ status: "skipped", reason, modelCalls: 0 });
      expect(counts).toEqual({ knowledge: 0, customerTexts: 0, model: 0, ownerReads: 1, qualify: 0 });
      expect(await traces(mail.caseId)).toEqual(NOTHING);
      // No takeover written by the runner: the owner change stays the CRM observation's (observeTicketCrmChange).
      expect(await readCase(mail.caseId)).toMatchObject({ owner: "agent", version: before.version });
    }
    // Witness: the ticket explicitly carries the V2 owner at every read (before the lease, the call and the record).
    const { report, counts } = await investigate(mail.caseId, "v2");
    expect(report).toMatchObject({ status: "recorded", modelCalls: 1 });
    expect(counts).toMatchObject({ knowledge: 1, model: 1, ownerReads: 4 });
  });

  it("no owner read wired: fail closed, the agent case is not investigated and nothing is written", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const before = (await readCase(mail.caseId))!;
    const { report, counts } = await investigate(mail.caseId, "absent");
    expect(report).toEqual({ status: "skipped", caseId: mail.caseId, caseVersion: before.version, reason: "ticket_owner_unverified", detail: "owner_read_unavailable", modelCalls: 0 });
    expect(counts).toEqual({ knowledge: 0, customerTexts: 0, model: 0, ownerReads: 0, qualify: 0 });
    expect(await traces(mail.caseId)).toEqual(NOTHING);
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "agent", version: before.version });
  });

  it("a new mail on an agent case whose ticket a person owns: no re-evaluation write, no lease, the mail is kept", async () => {
    const first = await v1Mail({ ownerEffect: true });
    const second = await v1Mail({ ticketId: first.ticketId, threadId: first.threadId, ownerEffect: false });
    expect(second.relayed).toMatchObject({ caseId: first.caseId, appended: true });
    const before = (await readCase(first.caseId))!;
    expect(before.owner).toBe("agent");
    for (const owner of ["human", "throws"] as const) {
      const { report, counts } = await investigate(first.caseId, owner);
      expect(report).toMatchObject({ status: "skipped", reason: owner === "human" ? "ticket_owner_human" : "ticket_owner_unverified", modelCalls: 0 });
      expect(counts).toEqual({ knowledge: 0, customerTexts: 0, model: 0, ownerReads: 1, qualify: 0 });
      expect(await traces(first.caseId)).toEqual(NOTHING);
      expect(await readCase(first.caseId)).toMatchObject({ owner: "agent", version: before.version, admissionInputVersion: before.admissionInputVersion });
    }
    expect((await listCaseEvents(first.caseId)).filter(event => event.kind === "inbound_confirmed")).toHaveLength(2);
  });

  it.each(["human", "throws"] as const)("the ticket goes to %s while the lease is taken: no search, no text read, no call, the lease is released, the owner untouched", async change => {
    const mail = await v1Mail({ ownerEffect: true });
    const before = (await readCase(mail.caseId))!;
    const { report, counts } = await investigate(mail.caseId, ["v2", change]);
    expect(report).toMatchObject({ status: "ticket_owner_stop", reason: change === "human" ? "ticket_owner_human" : "ticket_owner_unverified", modelCalls: 0 });
    expect(counts).toEqual({ knowledge: 0, customerTexts: 0, model: 0, ownerReads: 2, qualify: 0 });
    expect(await traces(mail.caseId)).toEqual(NOTHING);
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "agent", version: before.version });
  });

  it.each(["human", "throws"] as const)("the ticket goes to %s after the lease and the search: no call, no proposal, the lease is released, the owner untouched", async change => {
    const mail = await v1Mail({ ownerEffect: true });
    const before = (await readCase(mail.caseId))!;
    const { report, counts } = await investigate(mail.caseId, ["v2", "v2", change]);
    expect(report).toMatchObject({ status: "ticket_owner_stop", reason: change === "human" ? "ticket_owner_human" : "ticket_owner_unverified", modelCalls: 0 });
    expect(counts).toEqual({ knowledge: 1, customerTexts: 1, model: 0, ownerReads: 3, qualify: 0 });
    expect(await traces(mail.caseId)).toEqual(NOTHING);
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "agent", version: before.version });
  });

  it("the ticket goes to a person after the call: the decision is not recorded and no proposal exists; the call made stays in the progress", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const { report, counts } = await investigate(mail.caseId, ["v2", "v2", "v2", "human"]);
    expect(report).toMatchObject({ status: "ticket_owner_stop", reason: "ticket_owner_human", modelCalls: 1 });
    expect(counts).toMatchObject({ model: 1, ownerReads: 4 });
    const events = await listCaseEvents(mail.caseId), progress = readCaseInvestigationProgress(events, latestInvestigationInput(events)!);
    expect(progress).toMatchObject({ state: "found", record: { decision: null, progress: { modelCalls: 1, recordedOn: null } } });
    expect(await traces(mail.caseId)).toEqual({ ...NOTHING, observations: 1 });
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "agent" });
  });
});
