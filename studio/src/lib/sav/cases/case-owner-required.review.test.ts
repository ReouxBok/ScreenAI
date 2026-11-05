import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { savCaseEffectExecutions, savCaseReplyValidations, savIntakeEffects, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "../intake/execution-policy";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { executeIntakePass } from "../intake/executor";
import { getExecutionEffects } from "../intake/execution-store";
import type { ExecutionOptions, ExecutorAdapters } from "../intake/execution-types";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { createCaseEffectDriver } from "./case-effect-driver";
import { pendingCaseEffectRecoveries } from "./case-effect-recovery";
import { recordConfirmedCaseReply } from "./case-effect-outcomes";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { caseReplyFinalTextProblem, readCaseReplyDisclosure } from "./case-reply-outbound";
import type { CaseDecisionDraft } from "./investigation-intent";
import { decideCaseReply, type CaseEffectNote } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import {
  describeCaseReplyForReview, listCaseEffectsNeedingPerson, proposeCaseReplyFromDraft, queueValidatedCaseReply, resolveCaseReplyLanguage, runCaseEffectsPass,
  type CaseReplyDraftInput,
} from "./case-runtime-effects";
import { nextJ2Slot } from "./j2-calendar";

// SAV-10 (pole C), C-NIGHT-REPLY-RECOVERY-RACCORD: the injectable entrypoints on the REAL executor, ledger, validation store and case store, with the synthetic provider
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
const synOwner = async ({ ticketId }: { ticketId: string }) => {
  const owner = p.objects.tickets[ticketId]?.properties.hubspot_owner_id;
  return owner === "SYN_AGENT" ? "v2" as const : owner === "SYN_HUMAN" ? "human" as const : owner == null ? "none" as const : "unknown" as const;
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
const allow: CaseReplyAuthorizer = () => ({ allowed: true, basis: "fixture.allow" });
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
  const decided = await decideCaseReply({ action: "approve", validationId, approverId: APPROVER, seen: seenOf(proposal), authorizer: allow, deps: storeDeps() });
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
const pass = (overrides: Partial<Parameters<typeof runCaseEffectsPass>[0]> = {}) => runCaseEffectsPass({
  env: () => environment, readTicketOwner: synOwner, currentPolicyRevision: async () => POLICY, adapters: options.adapters, deadlineMs: Date.now() + 60_000,
  context: { runtime: options.runtime, policy: options.policy }, ...overrides,
});
const run = (id: string, d = driver(), opts: ExecutionOptions = options) => executeIntakePass(id, opts, {}, d);
const execution = async (id: string) => (await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, id)))[0]!;
const effectsOf = (id: string) => getExecutionEffects(id);
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
const outbound = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed");
const providerCalls = () => Object.values(counts).reduce((a, b) => a + b, 0);
const takeover = (caseId: string) => readCase(caseId).then(snapshot => transitionCaseOwner({ caseId, expectedVersion: snapshot!.version, transition: "human_takeover", actor: staff, commandKey: `cmd-${randomUUID()}`, reason: "fixture" }));
const newCustomerMail = (s: Scenario) =>
  openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`runtime-${randomUUID()}`), sourceRef: { type: "email", id: "runtime" }, occurredAt: "2026-10-28T07:45:00.000Z" });
const expireLease = (id: string) => f.client.exec(`UPDATE sav.case_effect_executions SET lease_until = now() - interval '1 second' WHERE id = '${id}'`);
/** The ledger says confirmed, the case recorded nothing: a pass that died between the confirmation and its finish. */
async function crashBeforeFinish(s: Scenario) {
  const { id } = await admit(s);
  const crashing = { ...driver(), finish: async () => { throw Error("SAV_TEST_CRASH_AFTER_CONFIRMED"); } };
  expect(await run(id, crashing)).toMatchObject({ state: "waiting" });
  expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
  expect(await outbound(s.caseId)).toEqual([]);
  expect(await listCaseTimers(s.caseId)).toEqual([]);
  return id;
}
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
  // Each test starts from an empty queue: what earlier tests left open is closed (a refused execution is never listed nor claimed).
  await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused' WHERE state NOT IN ('confirmed','refused')");
});
afterEach(async () => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled(); // transport réseau = 0
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setPause("v2", null); await setPause("intake", null);
});


const remoteReads = (ticketId: string) => p.calls.filter(c => c.method === "GET" && c.path === `/crm/v3/objects/tickets/${ticketId}`).length;
const remoteOwner = (ticketId: string, value: string|null) => { p.objects.tickets[ticketId]!.properties.hubspot_owner_id=value; };

describe("independent required owner port and last local fence",()=>{
 it.each(["absent","human","none","unknown","error"])("%s provider refuses direct-driver new work",async mode=>{
  const s=await scenario("answer");remoteOwner(s.ticketId,"SYN_AGENT");const {id}=await admit(s);
  const readTicketOwner = mode==="absent" ? undefined : async()=>{if(mode==="error")throw Error("SYN_READ_FAILED");return mode;};
  const d=createCaseEffectDriver({env:()=>environment,currentPolicyRevision:async()=>POLICY,readTicketOwner} as never);
  await run(id,d);expect(sends).toBe(0);expect((await effectsOf(id)).every(e=>e.state==="planned")).toBe(true);
 });
 it("known local HUMAN after marker must stop dispatch even when remote owner still v2",async()=>{
  const s=await scenario("answer");remoteOwner(s.ticketId,"SYN_AGENT");const {id}=await admit(s);let marker=0;
  await executeIntakePass(id,options,{afterMarker:async()=>{marker++;await takeover(s.caseId);}},driver());
  const observed={marker,local:(await readCase(s.caseId))!.owner,sends,events:(await outbound(s.caseId)).length};
  console.log("SYN_LAST_LOCAL_OWNER",JSON.stringify(observed));expect(observed).toMatchObject({marker:1,local:"human",sends:0,events:0});
 });
 it("uncertain historical send remains verify-only with owner port absent",async()=>{
  const s=await scenario("answer");remoteOwner(s.ticketId,"SYN_AGENT");const id=await lostAck(s);await letReconcile();
  const d=createCaseEffectDriver({env:()=>environment,currentPolicyRevision:async()=>POLICY} as never);await run(id,d);
  expect(sends).toBe(1);expect((await effectsOf(id)).map(e=>e.state)).toEqual(["confirmed"]);
 });
});
