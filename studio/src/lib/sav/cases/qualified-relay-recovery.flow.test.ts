// SAV-81 (SYN): the recovery of a mail V1 already confirmed on the ticket it created, while the qualification scope had bound no thread (the subject
// did not match at the creation). Real database, real V1 records, real relay, real sweep, real admission sources read from the environment, real V1
// context reader, real binding and real owner reader; the ONLY double is the HubSpot network (GET of the ticket owner). Every id, address, subject
// and owner is synthetic. No CRM write, no model, no mail.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeHumanEvents, savIntakeRuns, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// V1's model path must never be reached by the relay or its catch-up.
vi.mock("../intake/model-dispatch", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => { throw Error(`MODEL_DISPATCH_FORBIDDEN:${name}`); } : value]));
});
vi.mock("@/lib/embeddings", () => ({ embedTexts: () => { throw Error("EMBEDDING_FORBIDDEN"); } }));
import { encryptSavPayload } from "../crypto";
import { savAgentPauseKey } from "../intake/agent-pause";
import { SAV_INTAKE_CONTRACT_REVISION, savIntakeDecisionSchema, type SavIntakeDecision } from "../intake/contract";
import { listCaseEvents, readCaseByTicket, transitionCaseOwner, v1IntentHash } from "./case-store";
import { recordCaseAfterConfirmedIntake, sweepCaseRelays } from "./intake-boundary";
import { firstPersonalLoginRequest } from "./investigation-return-qualify";
import { SAV_V2_QUALIFICATION_SCOPE_SCHEMA, savV2QualificationCaseAllowed, savV2QualificationMessageAllowed } from "./qualification-scope";
import { v2EntryRelayDeps } from "./v2-entry";
import { manualQualificationPorts } from "./manual-qualification-runtime";
import { manualQualification } from "./manual-qualification";

const STAFF = "20000000-0000-4000-8000-000000000081", AT = "2026-11-01T09:00:00.000Z";
const V2_OWNER = "90000081", TEAM = "80000081", PERSON = "70000081", CONTACT = "100000081";
// One sender per test: the earlier tests' cases, still waiting in the shared database, never match a later test's scope (one scope = one sender).
let SENDER = "client.recovery@example.invalid";
const SUBJECT = "Connexion impossible", PREFIXED = "[SYN-81] Connexion impossible";
const BODY = "Bonjour, je n'arrive pas à me connecter à mon compte.";
const POLICY = { revision: "policy-syn-81", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-syn-81", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const BASE = {
  SAV_CASE_RECORDING: "on", SAV_V2_ENTRY: "on", SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, HUBSPOT_SAV_OWNER_ID: TEAM, HUBSPOT_ACCESS_TOKEN: "syn-token-not-real",
  SAV_V2_ADMISSION_POLICY_JSON: JSON.stringify({ policy: POLICY, validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2027-12-31T00:00:00.000Z" }),
  SAV_V2_ADAPTER_POLICY_JSON: JSON.stringify({ revision: "adapter-syn-81", decidedBy: "synthetic-decision", identity: "sender_unique_crm_match" }),
  SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([{ ruleId: "rule-syn-81", revision: "r1", v1Kind: "support", family: "access", at: AT }]),
};
let windowStart = 0, revision = 0;
/** The private scope as root sets it: by default the REAL subject of the mail (root adapts it before activating the fix), a new revision each time. */
const scope = (over: Record<string, unknown> = {}) => JSON.stringify({ schema: SAV_V2_QUALIFICATION_SCOPE_SCHEMA, revision: `q-syn-81-${++revision}`, senderEmail: SENDER,
  hubspotContactId: CONTACT, initialSubject: SUBJECT, notBefore: new Date(windowStart - 30 * 60_000).toISOString(), expiresAt: new Date(windowStart + 60 * 60_000).toISOString(), ...over });
const env = (over: Record<string, string | undefined> = {}, json = scope()) => ({ ...BASE, SAV_V2_SCOPE_MODE: "qualification", SAV_V2_QUALIFICATION_SCOPE_JSON: json, ...over });

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 8_810_000;
/** HubSpot as it stands: the owner of each ticket (`fail`: 403), every request logged. */
const owners = new Map<string, string | null | "fail" | "missing">(), requests: { url: string; method: string }[] = [];
/** Called on each owner read, before it answers: a pause or a person acting while the relay runs. */
let onOwnerRead: ((ticketId: string, count: number) => Promise<void>) | null = null;
const network = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, method: init?.method ?? "GET" });
  const ticket = /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/tickets\/(\d+)\?properties=hubspot_owner_id$/.exec(url);
  if (!ticket) throw Error(`NETWORK_FORBIDDEN:${url}`);
  if (onOwnerRead) await onOwnerRead(ticket[1]!, requests.filter(r => r.url === url).length);
  const owner = owners.get(ticket[1]!);
  if (owner === "fail") return new Response("{}", { status: 403 });
  return Response.json({ id: ticket[1], properties: owner === "missing" ? {} : { hubspot_owner_id: owner ?? null } });
}) as typeof fetch;
const deps = (e: Record<string, string | undefined>) => v2EntryRelayDeps(e, { network });

const evidence = (id: string, source: "current_message" | "crm_contact" | "crm_ticket", sourceId: string) => ({ id, source, sourceId, observedAt: AT, contentHash: "a".repeat(43) });
/** V1's current decision that CREATED a ticket for the unique primary contact of the sender: one support request. */
function creation(messageId: string, threadId: string, contact = CONTACT): SavIntakeDecision {
  return {
    revision: SAV_INTAKE_CONTRACT_REVISION, messageId, latestInboundMessageId: messageId, threadId, receivedAt: AT, classification: "support",
    requests: [{ id: "request-1", kind: "support", evidenceIds: ["current"] }],
    evidence: [evidence("current", "current_message", messageId), evidence("contact", "crm_contact", contact)],
    disposition: {
      kind: "ticket", target: { operation: "create", contactId: contact, predecessor: null, selection: { kind: "retained_email_match" } }, requestIds: ["request-1"],
      contactScope: { primaryContactId: contact, contacts: [{ origin: "email_lookup", addressOrigin: "sender", contactId: contact, evidenceIds: ["contact"] }], complete: true },
      search: "complete", history: "complete",
      identity: { kind: "unique_crm_match_for_intake", addressOrigin: "sender", scope: "intake_only", evidenceIds: ["current", "contact"] },
      sameIssueEvidenceIds: ["current"], requiredPermissions: ["create_ticket", "associate_email"], multiTicketNote: { openTicketIdsOnTargetContact: [] }, note: null,
      learning: "eligible_after_confirmed_effect", evidenceIds: ["current", "contact"],
    },
  } as SavIntakeDecision;
}
type Mail = { messageId: string; threadId: string; ticketId: string; executionId: string; gmail: string };
/** The real test's shape, synthetic: a first mail opening its thread, V1's run, its confirmed execution and the three confirmed effects of the creation. */
async function v1Mail(options: { decision?: (d: SavIntakeDecision) => SavIntakeDecision; createState?: string; ackTicket?: string; subject?: string; receivedAt?: Date; from?: string } = {}): Promise<Mail> {
  const threadId = randomUUID(), messageId = randomUUID(), ticketId = String(++seq), gmail = `gm-${messageId}`;
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: options.subject ?? SUBJECT, customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: options.from ?? SENDER, toEmails: ["support@example.invalid"],
    subject: options.subject ?? SUBJECT, bodyCiphertext: encryptSavPayload({ text: BODY, attachments: [], headers: {} }), receivedAt: options.receivedAt ?? new Date(windowStart - 60_000), gmailMessageId: gmail });
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: 1, isCurrent: false, state: "observed", configHash: "syn", policyHash: "syn", payloadCiphertext: encryptSavPayload({}) }).returning();
  const decision = (options.decision ?? (d => d))(creation(messageId, threadId));
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runId: run!.id, runVersion: 1, policyId, policyHash: "syn", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision } }) }).returning();
  const effect = async (kind: string, intent: Record<string, unknown>, stateValue = "confirmed", ack: unknown = { id: `${kind}-${messageId}` }) =>
    f.db.insert(savIntakeEffects).values({ businessKey: String(intent.key), executionId: execution!.id, kind, permission: String(intent.permission), state: stateValue,
      intentHash: v1IntentHash(intent), intentCiphertext: encryptSavPayload(intent), ackCiphertext: encryptSavPayload(ack), confirmedAt: new Date(), dispatchedAt: new Date() });
  // The creation carries NO owner: the V2 owner port refused it (subject outside the scope), exactly as in the real test.
  await effect("ticket_create", { kind: "ticket_create", permission: "create_ticket", key: `create:${messageId}`, sourceMessageId: messageId, contactId: CONTACT, marker: "0".repeat(64),
    properties: { subject: "Connexion impossible", content: "Synthétique", hs_pipeline: "0", hs_pipeline_stage: "1", source_type: "EMAIL" } }, options.createState, { id: options.ackTicket ?? ticketId });
  await effect("email_create", { kind: "email_create", permission: "associate_email", key: `email:${messageId}` });
  await effect("email_associate", { kind: "email_associate", permission: "associate_email", key: `email-assoc:${messageId}` });
  return { messageId, threadId, ticketId, executionId: execution!.id, gmail };
}
const bindings = () => f.db.select().from(savSyncState).where(like(savSyncState.key, "sav-v2-qualification-thread.v1:%"));
const intakeEffects = async (executionId: string) => (await f.db.select({ id: savIntakeEffects.id }).from(savIntakeEffects).where(eq(savIntakeEffects.executionId, executionId))).length;
const attributions = async (caseId: string) => (await listCaseEvents(caseId)).filter(e => e.kind === "owner_changed" && (e.detail as { transition?: string }).transition === "v2_attribution");
const inbounds = async (caseId: string) => (await listCaseEvents(caseId)).filter(e => e.kind === "inbound_confirmed");
const ownerReads = (ticketId: string) => requests.filter(r => r.url.includes(`/tickets/${ticketId}?`));
async function sweep(e: Record<string, string | undefined>) {
  const outcome = await sweepCaseRelays({ limit: 200, deps: deps(e) });
  if (!("failed" in outcome)) throw Error(`SWEEP_SKIPPED_${outcome.skipped}`);
  return outcome;
}
/**
 * The state ROOT observed on the real case: V1 confirmed, the case recorded and ADMITTED for the agent (access), but held by the team (handoff_pending,
 * awaiting the V2 owner), because the scope did not cover the mail when it was relayed: no owner read, no attribution, no binding.
 */
async function waitingCase(options: Parameters<typeof v1Mail>[0] = {}) {
  const m = await v1Mail(options);
  owners.set(m.ticketId, null);
  const relayed = await recordCaseAfterConfirmedIntake(m.messageId, deps(env({}, scope({ initialSubject: PREFIXED }))));
  expect(relayed).toMatchObject({ created: true, appended: true, owner: "human", admission: { target: "agent" } });
  const waiting = (await readCaseByTicket(m.ticketId))!;
  expect(waiting).toMatchObject({ owner: "human", phase: "handoff_pending", admission: { target: "agent" }, body: { handoff: { reason: "awaiting_v2_attribution" } } });
  return { ...m, caseId: waiting.caseId, version: waiting.version };
}
async function setPause(agent: "intake" | "v2", level: "actions_paused" | "fully_paused" | null) {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, savAgentPauseKey(agent)));
  if (level) await f.db.insert(savSyncState).values({ key: savAgentPauseKey(agent), status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent, level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
}

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "sav-81-recovery-fixture-key-32-characters");
  f = await createSavTestDb(); state.db = f.db;
  const run = randomUUID();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: `syn-81-${run}`, email: `admin-81-${run}@example.invalid`, role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-81-${run}@example.invalid` }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "syn", state: "approved", administratorId: admin!.id, policyHash: "syn", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "sav-81-recovery-fixture-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  windowStart = Date.now(); requests.length = 0; owners.clear(); onOwnerRead = null; SENDER = `client.recovery.${randomUUID().slice(0, 8)}@example.invalid`;
  // One scope revision binds one thread: every test starts with no binding, as the real scope does.
  await f.db.delete(savSyncState).where(like(savSyncState.key, "sav-v2-qualification-thread.v1:%"));
  await setPause("intake", null); await setPause("v2", null);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("fixtures are what they claim", () => {
  it("the synthetic decision is a valid current V1 creation, and the synthetic mail is a first personal login request", () => {
    expect(savIntakeDecisionSchema.safeParse(creation(randomUUID(), randomUUID())).success).toBe(true);
    expect(firstPersonalLoginRequest(BODY, SUBJECT)).toBe(true);
  });
});

describe("SAV-81: the case V1 confirmed while no thread was bound, recovered by the existing relay sweep", () => {
  it("the old deadlock, reproduced: the owner set to V2 by hand changes nothing while the scope does not cover the mail (no read, no binding)", async () => {
    const w = await waitingCase();
    owners.set(w.ticketId, V2_OWNER);
    await sweep(env({}, scope({ initialSubject: PREFIXED })));
    expect(ownerReads(w.ticketId)).toEqual([]);
    expect(await bindings()).toEqual([]);
    expect(await readCaseByTicket(w.ticketId)).toMatchObject({ owner: "human", phase: "handoff_pending", version: w.version });
  });
  it("scope on the real subject + owner put under V2 by an operator: bound, then the SAME case goes to the agent; no new ticket, mail, note, request or model; only GETs", async () => {
    const w = await waitingCase(), effectsBefore = await intakeEffects(w.executionId);
    owners.set(w.ticketId, V2_OWNER);
    const e = env();
    expect((await savV2QualificationMessageAllowed(e, w.messageId)).allowed).toBe(false);
    const outcome = await sweep(e);
    expect(outcome.recovered).toBe(1);
    const after = (await readCaseByTicket(w.ticketId))!;
    expect(after).toMatchObject({ caseId: w.caseId, owner: "agent", phase: "queued" });
    const [binding] = await bindings();
    expect(JSON.parse(binding!.cursor!)).toMatchObject({ threadId: w.threadId, messageId: w.messageId });
    expect((await savV2QualificationMessageAllowed(e, w.messageId)).allowed).toBe(true);
    expect(await attributions(w.caseId)).toEqual([expect.objectContaining({ detail: expect.objectContaining({ proof: expect.objectContaining({ kind: "hubspot_owner_read", messageId: w.messageId, ticketId: w.ticketId, ownerId: V2_OWNER }) }) })]);
    expect(await inbounds(w.caseId)).toHaveLength(1);
    expect(after.body.openRequests).toHaveLength(1);
    expect(await intakeEffects(w.executionId)).toBe(effectsBefore);
    expect(requests.every(r => r.method === "GET")).toBe(true);
    // The read that gave it, then the read after the commit.
    expect(ownerReads(w.ticketId)).toHaveLength(2);
  });
  it("replay and two racing sweeps: one binding, one attribution, one inbound event, nothing read once it is the agent's", async () => {
    const w = await waitingCase();
    owners.set(w.ticketId, V2_OWNER);
    const e = env();
    await Promise.all([sweep(e), sweep(e), recordCaseAfterConfirmedIntake(w.messageId, deps(e))]);
    const version = (await readCaseByTicket(w.ticketId))!.version;
    requests.length = 0;
    await sweep(e); await recordCaseAfterConfirmedIntake(w.messageId, deps(e));
    expect(ownerReads(w.ticketId)).toEqual([]);
    expect((await readCaseByTicket(w.ticketId))!).toMatchObject({ owner: "agent", version });
    expect(await bindings()).toHaveLength(1);
    expect(await attributions(w.caseId)).toHaveLength(1);
    expect(await inbounds(w.caseId)).toHaveLength(1);
  });
});

describe("SAV-81 counter-proofs: the owner as read now", () => {
  it.each<[string, string | null | "fail" | "missing"]>([["a person", PERSON], ["the V1 team owner", TEAM], ["nobody", null], ["unreadable (403)", "fail"], ["no owner property", "missing"]])(
    "owner %s: read once, never bound, the case stays with the team", async (_name, owner) => {
      const w = await waitingCase();
      owners.set(w.ticketId, owner);
      await sweep(env());
      expect(ownerReads(w.ticketId).length).toBeGreaterThanOrEqual(1);
      expect(await bindings()).toEqual([]);
      expect(await readCaseByTicket(w.ticketId)).toMatchObject({ owner: "human", phase: "handoff_pending" });
      expect(await attributions(w.caseId)).toEqual([]);
    });
  it.each<["intake" | "v2", "actions_paused" | "fully_paused"]>([["v2", "actions_paused"], ["intake", "fully_paused"]])("a %s pause (%s): no read, no binding; after it, recovered once", async (agent, level) => {
    const w = await waitingCase();
    owners.set(w.ticketId, V2_OWNER);
    await setPause(agent, level);
    const e = env();
    await sweep(e);
    expect(ownerReads(w.ticketId)).toEqual([]);
    expect(await bindings()).toEqual([]);
    await setPause(agent, null);
    await sweep(e);
    expect(await readCaseByTicket(w.ticketId)).toMatchObject({ owner: "agent" });
  });
});

describe("SAV-81: what happens while the recovery runs", () => {
  it("a pause set during the owner read: the binding is not written, the case stays with the team", async () => {
    const w = await waitingCase();
    owners.set(w.ticketId, V2_OWNER);
    onOwnerRead = async () => { await setPause("v2", "fully_paused"); };
    await sweep(env());
    expect(ownerReads(w.ticketId)).toHaveLength(1);
    expect(await bindings()).toEqual([]);
    expect(await readCaseByTicket(w.ticketId)).toMatchObject({ owner: "human", phase: "handoff_pending" });
    expect(await attributions(w.caseId)).toEqual([]);
  });
  it("a person takes the ticket in HubSpot right after the commit: the read after the commit hands the case back at once (human takeover)", async () => {
    const w = await waitingCase();
    owners.set(w.ticketId, V2_OWNER);
    onOwnerRead = async (ticketId, count) => { if (count === 2) owners.set(ticketId, PERSON); };
    await sweep(env());
    expect(ownerReads(w.ticketId)).toHaveLength(2);
    expect(await readCaseByTicket(w.ticketId)).toMatchObject({ owner: "human" });
    expect((await listCaseEvents(w.caseId)).filter(e => e.kind === "owner_changed").map(e => (e.detail as { transition?: string }).transition)).toEqual(["v2_attribution", "human_takeover"]);
  });
});

describe("SAV-81 counter-proofs: scope, V1 source, thread — refused BEFORE any owner read, nothing bound", () => {
  const refusedWithoutRead = async (w: Awaited<ReturnType<typeof waitingCase>>, e: Record<string, string | undefined>) => {
    owners.set(w.ticketId, V2_OWNER);
    requests.length = 0;
    await sweep(e);
    expect(ownerReads(w.ticketId)).toEqual([]);
    expect(await bindings()).toEqual([]);
    expect(await readCaseByTicket(w.ticketId)).toMatchObject({ owner: "human", phase: "handoff_pending" });
  };
  it.each<[string, () => Record<string, string | undefined>]>([
    ["no scope mode (scope JSON left)", () => env({ SAV_V2_SCOPE_MODE: undefined })],
    ["invalid scope JSON", () => env({}, "{not json")],
    ["expired scope", () => env({}, scope({ notBefore: new Date(windowStart - 120 * 60_000).toISOString(), expiresAt: new Date(windowStart - 30 * 60_000).toISOString() }))],
    ["scope not open yet", () => env({}, scope({ notBefore: new Date(windowStart + 30 * 60_000).toISOString(), expiresAt: new Date(windowStart + 90 * 60_000).toISOString() }))],
    ["another contact", () => env({}, scope({ hubspotContactId: "100000082" }))],
    ["another sender", () => env({}, scope({ senderEmail: "other@example.invalid" }))],
    ["another subject", () => env({}, scope({ initialSubject: "Autre objet" }))],
    ["mail received before the window", () => env({}, scope({ notBefore: new Date(windowStart).toISOString() }))],
  ])("%s", async (_name, make) => refusedWithoutRead(await waitingCase(), make()));
  it("another thread already bound for this revision: refused, the first binding untouched", async () => {
    const json = scope(), e = env({}, json), first = await waitingCase(), second = await waitingCase();
    owners.set(first.ticketId, V2_OWNER);
    await recordCaseAfterConfirmedIntake(first.messageId, deps(e));
    expect(await readCaseByTicket(first.ticketId)).toMatchObject({ owner: "agent" });
    owners.set(second.ticketId, V2_OWNER); requests.length = 0;
    await recordCaseAfterConfirmedIntake(second.messageId, deps(e));
    expect(ownerReads(second.ticketId)).toEqual([]);
    expect(await readCaseByTicket(second.ticketId)).toMatchObject({ owner: "human" });
    expect((await bindings()).map(row => JSON.parse(row.cursor!).threadId)).toEqual([first.threadId]);
  });
  it("a binding of this revision made under another configuration (hash): refused, never reinterpreted", async () => {
    const w = await waitingCase(), json = scope(), rev = JSON.parse(json).revision as string;
    await f.db.insert(savSyncState).values({ key: `sav-v2-qualification-thread.v1:${rev}`, status: "bound", cursor: JSON.stringify({ threadId: w.threadId, messageId: w.messageId, configHash: "f".repeat(64), boundAt: AT }) });
    owners.set(w.ticketId, V2_OWNER);
    await sweep(env({}, json));
    expect(ownerReads(w.ticketId)).toEqual([]);
    expect(await readCaseByTicket(w.ticketId)).toMatchObject({ owner: "human" });
  });
  it("a new customer mail on the thread since: refused", async () => {
    const w = await waitingCase();
    await f.db.insert(savMessages).values({ threadId: w.threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: `Re: ${SUBJECT}`,
      bodyCiphertext: encryptSavPayload({ text: "Toujours bloqué." }), receivedAt: new Date(windowStart), gmailMessageId: `gm-${randomUUID()}` });
    await refusedWithoutRead(w, env());
  });
  it("the thread paused by a person: refused", async () => {
    const w = await waitingCase();
    await f.db.update(savThreads).set({ aiPaused: true }).where(eq(savThreads.id, w.threadId));
    await refusedWithoutRead(w, env());
  });
  it("a person's decision recorded on the mail in the intake console: refused", async () => {
    const w = await waitingCase();
    const [run] = await f.db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(eq(savIntakeRuns.messageId, w.messageId));
    await f.db.insert(savIntakeHumanEvents).values({ commandKey: randomUUID(), threadId: w.threadId, messageId: w.messageId, parentRunId: run!.id, parentVersion: 1, baseConfigHash: "syn",
      sourceHash: "syn", kind: "classify", state: "applied", payloadCiphertext: encryptSavPayload({ revision: "sav-intake-human.v1", actor: { id: STAFF, email: "staff@example.invalid" } }) });
    await refusedWithoutRead(w, env());
  });
  it("the mail handled outside Studio (external completion): refused", async () => {
    const w = await waitingCase();
    await f.db.insert(auditLogs).values({ actorEmail: "ugo@limova.ai", action: "sav_dossier_completed_externally", entityType: "sav_message", entityId: w.messageId,
      technicalMetadata: { version: 1, threadId: w.threadId, batchId: randomUUID(), receivedBefore: new Date(windowStart + 60_000).toISOString(), reason: "processed_outside_studio" } });
    await refusedWithoutRead(w, env());
  });
  it("the case left the wait (a person took it in Studio): not in the recovery queue, no read, no binding", async () => {
    const w = await waitingCase();
    await transitionCaseOwner({ caseId: w.caseId, expectedVersion: w.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `syn-take-${w.caseId}`,
      reason: "staff_takeover", sourceRef: { type: "hubspot_object", id: w.ticketId } }).catch(async () => {
      // Whatever the transition's exact vocabulary, the case must stop waiting for the test to mean anything.
      throw Error("FIXTURE_TAKEOVER_REFUSED");
    });
    owners.set(w.ticketId, V2_OWNER); requests.length = 0;
    await sweep(env());
    expect(ownerReads(w.ticketId)).toEqual([]);
    expect(await bindings()).toEqual([]);
    expect(await readCaseByTicket(w.ticketId)).toMatchObject({ owner: "human", phase: "human_owned" });
    expect(await attributions(w.caseId)).toEqual([]);
  });
  it("a newer V1 run of the mail (the confirmed source is stale): refused", async () => {
    const w = await waitingCase();
    await f.db.insert(savIntakeRuns).values({ threadId: w.threadId, messageId: w.messageId, version: 2, isCurrent: true, state: "pending", configHash: "syn-2", policyHash: "syn", payloadCiphertext: encryptSavPayload({}) });
    await refusedWithoutRead(w, env());
  });
  it("V1's ticket_create no longer confirmed for this ticket (reconciled as another ticket): refused", async () => {
    const w = await waitingCase();
    const [create] = await f.db.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, w.executionId), eq(savIntakeEffects.kind, "ticket_create")));
    await f.db.update(savIntakeEffects).set({ ackCiphertext: encryptSavPayload({ id: "999999999" }) }).where(eq(savIntakeEffects.id, create!.id));
    await refusedWithoutRead(w, env());
  });
  it("V1 linked the mail to an existing ticket (no creation proof): refused", async () => {
    const w = await waitingCase({ decision: d => {
      if (d.disposition.kind !== "ticket") throw Error("FIXTURE");
      return { ...d, disposition: { ...d.disposition, target: { operation: "reopen", contactId: CONTACT, ticketId: "1", preserveOwnerId: null, ticketEvidenceId: "current", contactAssociationEvidenceId: "contact" } } } as SavIntakeDecision;
    } }).catch(() => null);
    // A decision the contract refuses cannot even be relayed as admitted: the reader treats it as unavailable. Either way nothing is bound.
    if (w) await refusedWithoutRead(w, env());
    expect(await bindings()).toEqual([]);
  });
  it("a sensitive mail (finance): never admitted for the agent, so never in the recovery queue; no read, no binding", async () => {
    const m = await v1Mail({ decision: d => ({ ...d, classification: "finance", requests: [{ id: "request-1", kind: "finance", evidenceIds: ["current"] }],
      disposition: { ...d.disposition, learning: "excluded" } }) as SavIntakeDecision });
    owners.set(m.ticketId, V2_OWNER);
    const e = env();
    await recordCaseAfterConfirmedIntake(m.messageId, deps(e));
    await sweep(e);
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "human" });
    expect(await readCaseByTicket(m.ticketId)).not.toMatchObject({ admission: { target: "agent" } });
    expect(ownerReads(m.ticketId)).toEqual([]);
    expect(await bindings()).toEqual([]);
  });
});

describe("M9 (SAV-80 survivor): the relay itself, out of scope, never reads the owner nor attributes", () => {
  it.each<[string, () => Record<string, string | undefined>]>([
    ["subject outside the scope (the real test's relay)", () => env({}, scope({ initialSubject: PREFIXED }))],
    ["scope expired", () => env({}, scope({ notBefore: new Date(windowStart - 120 * 60_000).toISOString(), expiresAt: new Date(windowStart - 30 * 60_000).toISOString() }))],
    ["scope JSON without the mode", () => env({ SAV_V2_SCOPE_MODE: undefined })],
  ])("%s: a first relay of an admitted mail under the V2 owner records it for the team, zero CRM read, zero binding", async (_name, make) => {
    const m = await v1Mail();
    owners.set(m.ticketId, V2_OWNER);
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(make()))).toMatchObject({ created: true, owner: "human", admission: { target: "agent" } });
    expect(requests).toEqual([]);
    expect(await bindings()).toEqual([]);
  });
  it("control: open mode (no scope at all) attributes as before, with the owner read", async () => {
    const m = await v1Mail();
    owners.set(m.ticketId, V2_OWNER);
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps({ ...BASE }))).toMatchObject({ created: true, owner: "agent" });
    expect(ownerReads(m.ticketId).length).toBeGreaterThanOrEqual(1);
    expect(await bindings()).toEqual([]);
  });
});


describe("manual qualification renewal on an already agent-owned case", () => {
  async function agentCase() {
    const w = await waitingCase(); owners.set(w.ticketId, V2_OWNER);
    const previous = env(); await recordCaseAfterConfirmedIntake(w.messageId, deps(previous));
    expect((await savV2QualificationCaseAllowed(previous, w.caseId)).allowed).toBe(true);
    const before = (await readCaseByTicket(w.ticketId))!;
    const old = (await bindings())[0]!;
    return { w, before, old, next: env() };
  }
  it("binds the new exact scope through fresh owner proof, without another attribution, event or effect", async () => {
    const { w, before, old, next } = await agentCase();
    const effects = await intakeEffects(w.executionId); requests.length = 0;
    vi.stubGlobal("fetch", network);
    expect(await manualQualificationPorts(next).relay(w.messageId)).toMatchObject({ caseId: w.caseId, owner: "agent" });
    expect(await savV2QualificationCaseAllowed(next, w.caseId)).toEqual({ allowed: true });
    expect(await readCaseByTicket(w.ticketId)).toMatchObject({ caseId: w.caseId, owner: "agent", version: before.version });
    const bound = await bindings(); expect(bound).toHaveLength(2);
    expect(bound.find(b => b.key === old.key)?.cursor).toBe(old.cursor);
    expect(await attributions(w.caseId)).toHaveLength(1); expect(await inbounds(w.caseId)).toHaveLength(1);
    expect(await intakeEffects(w.executionId)).toBe(effects); expect(requests.every(r => r.method === "GET")).toBe(true);
    expect(ownerReads(w.ticketId)).toHaveLength(1);
    // Repeating the relay on an already-bound revision leaves both binding and owner intact, without another CRM read.
    await manualQualificationPorts(next).relay(w.messageId);
    expect(await bindings()).toHaveLength(2); expect(ownerReads(w.ticketId)).toHaveLength(1);
  });
  it("the real operator preview is read-only and its run binds before the scope-checking continuation double", async () => {
    const { w, next } = await agentCase(); vi.stubGlobal("fetch", network);
    const e = { ...next, SAV_V2_INVESTIGATION: "observe" };
    const ports = manualQualificationPorts(e);
    const continuation = vi.fn(async (caseId: string) => ({ status: (await savV2QualificationCaseAllowed(e, caseId)).allowed ? "qualified_no_model_fixture" : "qualification_out_of_scope" }));
    ports.continue = continuation;
    const preview = await manualQualification({ operation: "preview", messageId: w.messageId }, e, ports);
    expect(preview.status).toBe("ready"); if (preview.status !== "ready") throw Error("PREVIEW_NOT_READY");
    expect(await bindings()).toHaveLength(1); expect(continuation).not.toHaveBeenCalled();
    expect(await manualQualification({ operation: "run", messageId: w.messageId, expected: preview.expected }, e, ports)).toMatchObject({ status: "attempted", outcome: "qualified_no_model_fixture" });
    expect(continuation).toHaveBeenCalledExactlyOnceWith(w.caseId); expect(await bindings()).toHaveLength(2);
  });
  it("a human takeover during the owner read prevents binding the renewed scope", async () => {
    const { w, next, before } = await agentCase(); vi.stubGlobal("fetch", network);
    onOwnerRead = async () => { await transitionCaseOwner({ caseId: w.caseId, expectedVersion: before.version,
      transition: "human_takeover", actor: { type: "system" }, commandKey: `synthetic-renewal-${w.caseId}`, reason: "synthetic_human", sourceRef: { type: "hubspot_object", id: w.ticketId } }); };
    expect(await manualQualificationPorts(next).relay(w.messageId)).not.toMatchObject({ owner: "agent" });
    expect(await bindings()).toHaveLength(1); expect(await readCaseByTicket(w.ticketId)).toMatchObject({ owner: "human" });
  });
  it.each([PERSON, TEAM, null, "fail", "missing"] as const)("does not bind an agent case when its fresh CRM owner is %s", async owner => {
    const { w, next, old } = await agentCase(); owners.set(w.ticketId, owner); vi.stubGlobal("fetch", network);
    expect(await manualQualificationPorts(next).relay(w.messageId)).not.toMatchObject({ owner: "agent" });
    expect(await savV2QualificationCaseAllowed(next, w.caseId)).toEqual({ allowed: false, reason: "qualification_thread_unbound" });
    expect(await bindings()).toHaveLength(1); expect((await bindings())[0]!.cursor).toBe(old.cursor);
  });
  it("does not bind when the agent is paused during the fresh owner read", async () => {
    const { w, next } = await agentCase(); vi.stubGlobal("fetch", network);
    onOwnerRead = async () => { await setPause("v2", "fully_paused"); };
    expect(await manualQualificationPorts(next).relay(w.messageId)).not.toMatchObject({ owner: "agent" });
    expect(await bindings()).toHaveLength(1);
  });
});
