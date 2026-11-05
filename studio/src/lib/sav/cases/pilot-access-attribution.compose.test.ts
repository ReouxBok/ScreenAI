// Pole A, pilot access (3/11, SYN): the access family relayed from V1 to V2 with the dedicated owner, on the real relay, case store,
// claim and A10 owner reader, over V1 tables. Test preconditions, never production settings or Ugo's decisions: the admission policy
// (P1 « access »), the qualification port (P2), the owner ids (P4: dedicated 90000042, team 80000001, a person 70000042) and a JSON
// GET transport returning synthetic tickets. V1's `ticket_create` carrying the dedicated owner is a FIXTURE of the proposed V1 change
// (route 3A): today V1 creates every ticket without an owner and its verification requires it empty. No network, no write, no model.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
import { encryptSavPayload } from "../crypto";
import { caseTicketOwnerPortFromTransport, caseTicketOwnerReadPath, hubspotTicketOwnerReader, type CaseOwnerReadTransport } from "./admission-owner-reader";
import { claimCaseForDecision, listCaseEvents, openCaseEvent, readCaseByTicket, transitionCaseOwner, v1IntentHash } from "./case-store";
import { describeCaseOwnerSituation, type CaseOwnerReadingInput } from "./case-owner-situation";
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification } from "./case-types";
import { recordCaseAfterConfirmedIntake, sweepCaseRelays, type CaseBoundaryDeps } from "./intake-boundary";
import { observeTicketCrmChange } from "./owner-attribution";

const RECEIVED = "2026-11-03T08:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000002";
const PILOT = "90000042", TEAM = "80000001", PERSON = "70000042";
const ENV = { SAV_V2_HUBSPOT_OWNER_ID: PILOT, HUBSPOT_SAV_OWNER_ID: TEAM, SAV_CASE_RECORDING: "on" };
/** P1: a synthetic approved policy admitting « access » only. */
const POLICY = { revision: "policy-syn-access-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-syn-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: RECEIVED };
/** P2: « access » for EVERY request, finance included (a sensitive V1 hint must still win); identity as asked. */
const qualify = (identity: "confirmed" | "unknown" = "confirmed") => vi.fn(async (input: { requests: { requestId: string }[] }): Promise<CaseAdmissionQualification> => ({
  requests: input.requests.map(request => ({ requestId: request.requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-syn-access", revision: "r1", at: RECEIVED } })),
  identity: identity === "confirmed" ? { status: "confirmed", source: { type: "hubspot_object", id: "syn-contact-42" } } : { status: "unknown" }, crmContext: "complete", teamSignals: [],
}));

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, seq = 8_800_000;
type Mail = { messageId: string; threadId: string; ticketId: string; executionId: string; effectId?: string };
/** A mail V1 confirmed (every required effect). `created`: V1 created the ticket; `owner` is the owner IN the creation (undefined:
 * none, as V1 does today). Otherwise V1 attached the mail to an existing ticket (the John shape). */
async function mail(options: { created?: boolean; owner?: string; ticketId?: string; threadId?: string; requests?: string[]; effectState?: string; ackTicket?: string } = {}): Promise<Mail> {
  const threadId = options.threadId ?? randomUUID(), messageId = randomUUID(), ticketId = options.ticketId ?? String(++seq);
  if (!options.threadId) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Connexion", customerEmail: "client@example.invalid" });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"], subject: "Connexion",
    bodyCiphertext: encryptSavPayload({ text: "Synthétique : je n'arrive pas à me connecter." }), receivedAt: new Date(RECEIVED), gmailMessageId: `gm-${messageId}` });
  const requests = options.requests ?? ["support"];
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: requests.map((kind, i) => ({ id: `r${i}`, kind })) } } }) }).returning();
  if (!options.created) return { messageId, threadId, ticketId, executionId: execution!.id };
  const key = `create:${messageId}`;
  const intent = { kind: "ticket_create", permission: "create_ticket", key, sourceMessageId: messageId, contactId: "syn-contact-42", marker: "0".repeat(64),
    properties: { subject: "Connexion impossible", content: "Synthétique", hs_pipeline: "0", hs_pipeline_stage: "1", source_type: "EMAIL", ...(options.owner ? { hubspot_owner_id: options.owner } : {}) } };
  const [effect] = await f.db.insert(savIntakeEffects).values({ businessKey: key, executionId: execution!.id, kind: "ticket_create", permission: "create_ticket", state: options.effectState ?? "confirmed",
    intentHash: v1IntentHash(intent), intentCiphertext: encryptSavPayload(intent), ackCiphertext: encryptSavPayload({ id: options.ackTicket ?? ticketId }) }).returning();
  return { messageId, threadId, ticketId, executionId: execution!.id, effectId: effect!.id };
}
const progress = vi.fn(async (messageId: string) => {
  const [row] = await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId));
  return row ? { state: row.state, ticketId: row.ticketId, confirmed: row.state === "confirmed", effects: [{}] } : null;
});

/** The CRM as it stands (`owners`; `missing`: answers without the owner property; `down`: 403), every GET logged, read by A10. */
function crm(env: Record<string, string> = ENV) {
  const owners = new Map<string, string | null>(), missing = new Set<string>(), down = new Set<string>(), requests: { method: string; path: string }[] = [];
  const transport: CaseOwnerReadTransport = async request => {
    requests.push(request);
    const id = /tickets\/([0-9]+)\?/.exec(request.path)![1]!;
    if (down.has(id)) throw Error("SYNTHETIC_HTTP_403");
    return { id, archived: false, properties: missing.has(id) ? {} : { hubspot_owner_id: owners.get(id) ?? null } };
  };
  const port = caseTicketOwnerPortFromTransport({ env, transport });
  const read = async (ticketId: string): Promise<CaseOwnerReadingInput> => { try { return await port({ ticketId }); } catch { return "read_failed"; } };
  return { owners, missing, down, requests, read, reader: hubspotTicketOwnerReader(transport) };
}
const deps = (c: ReturnType<typeof crm> | null, over: Partial<CaseBoundaryDeps> = {}): CaseBoundaryDeps =>
  ({ env: ENV, readProgress: progress, readAdmissionPolicy: async () => POLICY, readQualification: qualify(), ...(c ? { readCreatedTicketOwner: c.reader } : {}), ...over });
/** The catch-up's outcome, failing the test if it was skipped as a whole. */
async function sweep(c: ReturnType<typeof crm>) {
  const outcome = await sweepCaseRelays({ limit: 200, deps: deps(c) });
  if (!("failed" in outcome)) throw Error(`SWEEP_SKIPPED_${outcome.skipped}`);
  return outcome;
}
const events = async (ticketId: string) => listCaseEvents((await readCaseByTicket(ticketId))!.caseId);
const attributions = async (ticketId: string) => (await events(ticketId)).filter(e => e.kind === "owner_changed" && (e.detail as { transition?: string }).transition === "v2_attribution");
const situation = async (ticketId: string, c: ReturnType<typeof crm>) => describeCaseOwnerSituation((await readCaseByTicket(ticketId))!, await c.read(ticketId));
async function setPause(agent: "intake" | "v2", level: "running" | "actions_paused" | "fully_paused" | "invalid" | null) {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, `sav-agent-pause.v1:${agent}`));
  if (!level) return;
  await f.db.insert(savSyncState).values({ key: `sav-agent-pause.v1:${agent}`, status: "installed", cursor: level === "invalid" ? "not-a-ciphertext"
    : encryptSavPayload({ revision: "sav-agent-pause.v1", agent, level, setBy: "fixture@example.invalid", setAt: RECEIVED, reason: "pause fictive" }) });
}

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "pilot-access-fixture-key-32-characters!!");
  f = await createSavTestDb(); state.db = f.db;
  const run = randomUUID();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: `synthetic-pilot-admin-${run}`, email: `pilot-admin-${run}@example.invalid`, role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-${run}@example.invalid` }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "pilot-access-fixture-key-32-characters!!"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_NOT_ALLOWED"); }));
  await setPause("intake", null); await setPause("v2", null);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("pilot access: the dedicated owner as read now — confirmed, empty, another person, unknown", () => {
  it("confirmed: a ticket V1 created with the dedicated owner, still read as it, goes to the agent once (2 GET: the read, then the check after the commit; system actor, no write)", async () => {
    const c = crm(), m = await mail({ created: true, owner: PILOT });
    c.owners.set(m.ticketId, PILOT);
    const relayed = await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    expect(relayed).toMatchObject({ created: true, owner: "agent", admission: { target: "agent" } });
    expect(c.requests).toEqual([{ method: "GET", path: caseTicketOwnerReadPath(m.ticketId) }, { method: "GET", path: caseTicketOwnerReadPath(m.ticketId) }]);
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "agent", phase: "queued", body: { handoff: null } });
    expect(await attributions(m.ticketId)).toMatchObject([{ detail: { transition: "v2_attribution", actor: { type: "system" }, reason: "hubspot_owner_at_creation",
      proof: { kind: "hubspot_owner_at_creation", executionId: m.executionId, effectId: m.effectId, ticketId: m.ticketId, ownerId: PILOT } } }]);
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "agent", v2Work: true, ownerWrite: false });
    const current = (await readCaseByTicket(m.ticketId))!;
    expect(await claimCaseForDecision({ caseId: current.caseId, expectedVersion: current.version, holder: "syn-runner", currentPolicyRevision: POLICY.revision, ttlSeconds: 60, settleSeconds: 0 }))
      .toMatchObject({ claimed: true, actionsPaused: false });
  });
  it("empty: the dedicated owner removed since the creation is not put back; the team keeps the case (situation: take blocked)", async () => {
    const c = crm(), m = await mail({ created: true, owner: PILOT });
    c.owners.set(m.ticketId, null);
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c))).toMatchObject({ owner: "human", admission: { target: "agent" } });
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "awaiting_v2_attribution" } } });
    expect(await attributions(m.ticketId)).toEqual([]);
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "admitted_take_blocked", v2Work: false });
  });
  it("another person: whoever holds the new ticket keeps it, a later mail does not move it; only the owner set to V2 in HubSpot, on a case still waiting, does (Ugo 4/11)", async () => {
    const c = crm(), m = await mail({ created: true, owner: PILOT });
    c.owners.set(m.ticketId, PERSON);
    await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "human_owner", v2Work: false });
    const next = await mail({ ticketId: m.ticketId, threadId: m.threadId });
    await recordCaseAfterConfirmedIntake(next.messageId, deps(c));
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "human" });
    expect(await attributions(m.ticketId)).toEqual([]);
    const third = await mail({ ticketId: m.ticketId, threadId: m.threadId });
    c.owners.set(m.ticketId, PILOT);
    await recordCaseAfterConfirmedIntake(third.messageId, deps(c));
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "agent" });
    expect(await attributions(m.ticketId)).toHaveLength(1);
  });
  it("the team owner (V1) is another person, never the dedicated one", async () => {
    const c = crm(), m = await mail({ created: true, owner: PILOT });
    c.owners.set(m.ticketId, TEAM);
    await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "human_owner" });
  });
  it("unknown: no owner property, or a failed read, records nothing; the catch-up isolates that mail and relays it once readable", async () => {
    const c = crm(), m = await mail({ created: true, owner: PILOT }), other = await mail();
    c.missing.add(m.ticketId);
    await expect(recordCaseAfterConfirmedIntake(m.messageId, deps(c))).rejects.toThrow("SAV_CASE_CREATED_OWNER_UNREAD");
    c.missing.delete(m.ticketId); c.down.add(m.ticketId);
    await expect(recordCaseAfterConfirmedIntake(m.messageId, deps(c))).rejects.toThrow("SYNTHETIC_HTTP_403");
    expect(await readCaseByTicket(m.ticketId)).toBeNull();
    expect((await sweep(c)).failed).toEqual({ unexpected: 1 });
    expect(await readCaseByTicket(other.ticketId)).not.toBeNull();
    expect(await readCaseByTicket(m.ticketId)).toBeNull();
    c.down.delete(m.ticketId); c.owners.set(m.ticketId, PILOT);
    expect((await sweep(c)).failed).toEqual({});
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "agent" });
    expect(await sweep(c)).toMatchObject({ relayed: 0, failed: {} });
    expect(await attributions(m.ticketId)).toHaveLength(1);
  });
});

describe("pilot access: what never reads the owner and never reaches the agent", () => {
  it("an existing ticket nobody owns (the John shape) stays with the team after one read: nothing is taken", async () => {
    const c = crm(), m = await mail();
    c.owners.set(m.ticketId, null);
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c))).toMatchObject({ owner: "human", admission: { target: "agent" } });
    expect(c.requests).toEqual([{ method: "GET", path: caseTicketOwnerReadPath(m.ticketId) }]);
    expect(await attributions(m.ticketId)).toEqual([]);
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "admitted_take_blocked" });
  });
  it("an uncertain creation or a creation of another ticket is no V1 confirmation: the V2 owner read now moves nothing", async () => {
    const c = crm();
    for (const m of [await mail({ created: true, owner: PILOT, effectState: "uncertain" }), await mail({ created: true, owner: PILOT, ackTicket: "8899999" }), await mail({ created: true, effectState: "uncertain" })]) {
      c.owners.set(m.ticketId, PILOT);
      expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c))).toMatchObject({ owner: "human" });
      expect(await attributions(m.ticketId)).toEqual([]);
    }
    expect(c.requests.every(request => request.method === "GET")).toBe(true);
  });
  it("without the owner reader (production today) an admitted creation waits with the team: no read, no attribution", async () => {
    const m = await mail({ created: true, owner: PILOT });
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(null))).toMatchObject({ owner: "human", admission: { target: "agent" } });
    expect(await attributions(m.ticketId)).toEqual([]);
  });
  it("access + billing goes to the team as finance, uncertain identity back to qualification: zero CRM read, zero attribution", async () => {
    const c = crm();
    const mixed = await mail({ created: true, owner: PILOT, requests: ["support", "finance"] }), unsure = await mail({ created: true, owner: PILOT });
    c.owners.set(mixed.ticketId, PILOT); c.owners.set(unsure.ticketId, PILOT);
    expect(await recordCaseAfterConfirmedIntake(mixed.messageId, deps(c))).toMatchObject({ owner: "human", admission: { target: "team" } });
    const doubtful = await recordCaseAfterConfirmedIntake(unsure.messageId, deps(c, { readQualification: qualify("unknown") })) as { owner: string; admission: { target: string; reasons: string[] } };
    expect(doubtful).toMatchObject({ owner: "human", admission: { target: "qualification" } });
    expect(doubtful.admission.reasons).toContain("identity_unconfirmed");
    expect(c.requests).toEqual([]);
    expect(await readCaseByTicket(mixed.ticketId)).toMatchObject({ sensitivity: "finance" });
    expect(await situation(mixed.ticketId, c)).toMatchObject({ situation: "excluded_sensitive" });
    expect(await situation(unsure.ticketId, c)).toMatchObject({ situation: "team_not_admitted" });
    expect([...await attributions(mixed.ticketId), ...await attributions(unsure.ticketId)]).toEqual([]);
  });
  it("mapping: a dedicated id equal to the team owner, or malformed, configures no V2 owner at all", async () => {
    for (const env of [{ ...ENV, SAV_V2_HUBSPOT_OWNER_ID: TEAM }, { ...ENV, SAV_V2_HUBSPOT_OWNER_ID: "SAV Pilote" }, { ...ENV, SAV_V2_HUBSPOT_OWNER_ID: "" }]) {
      const c = crm(env), m = await mail({ created: true, owner: PILOT });
      c.owners.set(m.ticketId, PILOT);
      expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c, { env }))).toMatchObject({ owner: "human" });
      expect(c.requests).toEqual([]);
      expect(await c.read(m.ticketId)).toBe("human");
    }
  });
});

describe("Ugo 4/11, the ordinary case: the current owner already reads V2 and the mail is admitted. Attribution is not processing: one read, no write, no V1 owner effect", () => {
  const moved = (reason = "hubspot_owner_read") => expect.objectContaining({ detail: expect.objectContaining({ transition: "v2_attribution", actor: { type: "system" }, reason }) });
  const get = (ticketId: string) => ({ method: "GET", path: caseTicketOwnerReadPath(ticketId) });
  it.each<[string, { created?: boolean }]>([["an existing ticket V1 attached the mail to", {}], ["a ticket V1 created without any owner, set to V2 since", { created: true }]])("%s goes to the agent, once; only GET requests", async (_label, shape) => {
    const c = crm(), m = await mail(shape);
    c.owners.set(m.ticketId, PILOT);
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c))).toMatchObject({ created: true, appended: true, owner: "agent", admission: { target: "agent" } });
    expect(c.requests).toEqual([get(m.ticketId), get(m.ticketId)]);
    expect(await attributions(m.ticketId)).toEqual([moved()]);
    expect((await attributions(m.ticketId))[0]!.detail).toMatchObject({ proof: { kind: "hubspot_owner_read", messageId: m.messageId, ticketId: m.ticketId, ownerId: PILOT } });
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "agent", phase: "queued", body: { handoff: null } });
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "agent", v2Work: true, ownerWrite: false });
  });
  it("the wake, its replay, the sweep and two racing relays: one event, one attribution, one request, no read once it is the agent's", async () => {
    const c = crm(), m = await mail();
    c.owners.set(m.ticketId, PILOT);
    const raced = await Promise.all([recordCaseAfterConfirmedIntake(m.messageId, deps(c)), recordCaseAfterConfirmedIntake(m.messageId, deps(c))]);
    expect(raced.filter(result => "appended" in result && result.appended)).toHaveLength(1);
    const version = (await readCaseByTicket(m.ticketId))!.version;
    c.requests.length = 0;
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c))).toMatchObject({ appended: false, owner: "agent" });
    await sweep(c);
    expect(c.requests.filter(request => request.path === get(m.ticketId).path)).toEqual([]);
    expect((await readCaseByTicket(m.ticketId))!.version).toBe(version);
    expect(await attributions(m.ticketId)).toHaveLength(1);
    expect((await events(m.ticketId)).filter(event => event.kind === "inbound_confirmed")).toHaveLength(1);
    expect((await readCaseByTicket(m.ticketId))!.body.openRequests).toHaveLength(1);
  });
  it.each<[string, (c: ReturnType<typeof crm>, ticketId: string) => void]>([
    ["the read failed", (c, id) => { c.down.add(id); }], ["the owner property was missing", (c, id) => { c.missing.add(id); }], ["the owner was empty and is set to V2 since", (c, id) => { c.owners.set(id, null); }],
  ])("recovery of a case already waiting (%s): the mail is recorded, the sweep moves it once, no new event, no new request", async (_label, first) => {
    const c = crm(), m = await mail();
    first(c, m.ticketId);
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c))).toMatchObject({ appended: true, owner: "human" });
    const waiting = (await readCaseByTicket(m.ticketId))!;
    expect(waiting).toMatchObject({ phase: "handoff_pending", body: { handoff: { reason: "awaiting_v2_attribution" } } });
    c.down.delete(m.ticketId); c.missing.delete(m.ticketId); c.owners.set(m.ticketId, PILOT);
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "v2_owner_read_pending", v2Work: false, ownerWrite: false });
    expect((await sweep(c)).recovered).toBeGreaterThanOrEqual(1);
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "agent", phase: "queued" });
    await sweep(c);
    expect(await attributions(m.ticketId)).toHaveLength(1);
    expect((await events(m.ticketId)).filter(event => event.kind === "inbound_confirmed")).toHaveLength(1);
    expect((await readCaseByTicket(m.ticketId))!.body.openRequests).toHaveLength(1);
  });
  it("the sweep reads no owner without the reader, and moves nothing: a case waits (production today)", async () => {
    const m = await mail();
    await recordCaseAfterConfirmedIntake(m.messageId, deps(null));
    expect(await sweepCaseRelays({ limit: 200, deps: deps(null) })).toMatchObject({ recovered: 0 });
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "human" });
  });
  it.each<["intake" | "v2", "actions_paused" | "fully_paused" | "invalid"]>([["v2", "actions_paused"], ["intake", "fully_paused"], ["v2", "invalid"]])("a pause (%s %s): no read, the mail is recorded, nothing moves, not even from the sweep; it moves once the pause ends", async (agent, level) => {
    const c = crm(), m = await mail();
    c.owners.set(m.ticketId, PILOT);
    await setPause(agent, level);
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c))).toMatchObject({ owner: "human" });
    await sweep(c);
    expect(c.requests).toEqual([]);
    expect(await attributions(m.ticketId)).toEqual([]);
    await setPause(agent, null);
    await sweep(c);
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "agent" });
    expect(await attributions(m.ticketId)).toHaveLength(1);
  });
  it("a pause set while the relay runs stops the move under the ticket lock: the mail is not lost, the sweep records it without moving it", async () => {
    const c = crm(), m = await mail();
    c.owners.set(m.ticketId, PILOT);
    const reading = c.reader;
    const racing = deps(c, { readCreatedTicketOwner: async ticketId => { const owner = await reading(ticketId); await setPause("v2", "fully_paused"); return owner; } });
    await expect(recordCaseAfterConfirmedIntake(m.messageId, racing)).rejects.toThrow("SAV_CASE_RELAY_PAUSED");
    expect(await readCaseByTicket(m.ticketId)).toBeNull();
    await sweep(c);
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "human" });
    expect(await attributions(m.ticketId)).toEqual([]);
  });
  it.each<[string, string[]]>([["finance", ["finance"]], ["cancellation", ["cancellation"]], ["connection + billing", ["support", "finance"]], ["connection + cancellation", ["support", "cancellation"]]])("%s under the V2 owner: to the team, zero read, zero move", async (_label, requests) => {
    const c = crm(), m = await mail({ requests });
    c.owners.set(m.ticketId, PILOT);
    expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c))).toMatchObject({ owner: "human" });
    await sweep(c);
    expect(c.requests.filter(request => request.path === get(m.ticketId).path)).toEqual([]);
    expect(await attributions(m.ticketId)).toEqual([]);
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "excluded_sensitive", v2Work: false });
  });
  it("unqualified (uncertain identity), or no policy, under the V2 owner: to the team, zero read, zero move", async () => {
    const c = crm(), unsure = await mail(), noPolicy = await mail();
    c.owners.set(unsure.ticketId, PILOT); c.owners.set(noPolicy.ticketId, PILOT);
    await recordCaseAfterConfirmedIntake(unsure.messageId, deps(c, { readQualification: qualify("unknown") }));
    await recordCaseAfterConfirmedIntake(noPolicy.messageId, deps(c, { readAdmissionPolicy: async () => null }));
    expect(c.requests).toEqual([]);
    expect(await attributions(unsure.ticketId)).toEqual([]);
    expect(await attributions(noPolicy.ticketId)).toEqual([]);
  });
  it("a person holds the ticket, or the team owner does: the case stays with the team; a person's takeover is never undone by the V2 owner read later", async () => {
    const c = crm(), m = await mail(), team = await mail();
    c.owners.set(m.ticketId, PERSON); c.owners.set(team.ticketId, TEAM);
    await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    await recordCaseAfterConfirmedIntake(team.messageId, deps(c));
    expect(await attributions(m.ticketId)).toEqual([]); expect(await attributions(team.ticketId)).toEqual([]);
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "human_owner" });
    const taken = await mail(); c.owners.set(taken.ticketId, PILOT);
    await recordCaseAfterConfirmedIntake(taken.messageId, deps(c));
    const current = (await readCaseByTicket(taken.ticketId))!;
    await transitionCaseOwner({ caseId: current.caseId, expectedVersion: current.version, transition: "human_takeover", actor: { type: "system" }, commandKey: `syn-takeover.${taken.ticketId}`, reason: "hubspot_owner_human", sourceRef: { type: "hubspot_object", id: taken.ticketId } });
    const next = await mail({ ticketId: taken.ticketId, threadId: taken.threadId });
    c.requests.length = 0;
    await recordCaseAfterConfirmedIntake(next.messageId, deps(c));
    await sweep(c);
    expect(c.requests.filter(request => request.path === get(taken.ticketId).path)).toEqual([]);
    expect(await readCaseByTicket(taken.ticketId)).toMatchObject({ owner: "human" });
    expect(await attributions(taken.ticketId)).toHaveLength(1);
  });
  it("freshness: a person takes it between the read and the commit: the read after the commit gives it back at once; that read failing leaves it unconfirmed, no new step", async () => {
    const c = crm(), m = await mail(), n = await mail();
    c.owners.set(m.ticketId, PILOT); c.owners.set(n.ticketId, PILOT);
    let reads = 0;
    const flip = deps(c, { readCreatedTicketOwner: async ticketId => { reads += 1; if (reads === 2) c.owners.set(ticketId, PERSON); return c.reader(ticketId); } });
    expect(await recordCaseAfterConfirmedIntake(m.messageId, flip)).toMatchObject({ owner: "human" });
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "human_owner", v2Work: false });
    reads = 0;
    const failing = deps(c, { readCreatedTicketOwner: async ticketId => { reads += 1; if (reads === 2) { c.owners.set(ticketId, PERSON); throw Error("SYNTHETIC_HTTP_503"); } return c.reader(ticketId); } });
    expect(await recordCaseAfterConfirmedIntake(n.messageId, failing)).toMatchObject({ owner: "agent" });
    expect(await situation(n.ticketId, c)).toMatchObject({ situation: "agent_unconfirmed", v2Work: false });
  });
  it("a person's takeover recorded between the read and the ticket lock wins: the store, under its lock, does not move a case that stopped waiting", async () => {
    const c = crm(), m = await mail();
    c.owners.set(m.ticketId, null);
    await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    c.owners.set(m.ticketId, PILOT);
    const racing = deps(c, { readCreatedTicketOwner: async ticketId => {
      const owner = await c.reader(ticketId), current = (await readCaseByTicket(ticketId))!;
      if (current.owner === "human" && !current.body.handoff?.humanSince) await transitionCaseOwner({ caseId: current.caseId, expectedVersion: current.version, transition: "human_takeover", actor: { type: "system" }, commandKey: `syn-race.${ticketId}`, reason: "hubspot_owner_human", sourceRef: { type: "hubspot_object", id: ticketId } });
      return owner;
    } });
    expect(await recordCaseAfterConfirmedIntake(m.messageId, racing)).toMatchObject({ appended: false, owner: "human" });
    expect(await attributions(m.ticketId)).toEqual([]);
  });
  it("a made-up reading proof, for a mail V1 did not confirm on this ticket, moves nothing in the store", async () => {
    const c = crm(), m = await mail(), other = await mail();
    await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    const before = (await readCaseByTicket(m.ticketId))!;
    await openCaseEvent({ ticketId: m.ticketId, threadId: m.threadId, kind: "inbound_confirmed", dedupeKey: `inbound:gm-${m.messageId}`, direction: "customer_inbound", occurredAt: RECEIVED, sourceRef: { type: "email", id: `gm-${m.messageId}` },
      admissionMode: "exclusions_only", admission: { policy: POLICY, qualification: await qualify()({ requests: [{ requestId: "r0" }] }) }, attribution: { kind: "hubspot_owner_read", messageId: other.messageId, ticketId: m.ticketId, ownerId: PILOT } });
    expect((await readCaseByTicket(m.ticketId))!.owner).toBe(before.owner);
    expect(await attributions(m.ticketId)).toEqual([]);
  });
});

describe("pilot access: acquired ownership against a person, and the ledger checked again by the store", () => {
  it("a person who takes the agent's ticket keeps it: takeover recorded, a new mail does not free it, no claim", async () => {
    const c = crm(), m = await mail({ created: true, owner: PILOT });
    c.owners.set(m.ticketId, PILOT);
    await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    c.owners.set(m.ticketId, PERSON);
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "agent_unconfirmed", v2Work: false });
    expect(await observeTicketCrmChange({ ticketId: m.ticketId, ownerId: PERSON, hubspotUpdatedAt: "2026-11-03T08:05:00.000Z", env: ENV })).toMatchObject({ takeover: true, case: { owner: "human", phase: "human_owned" } });
    c.owners.set(m.ticketId, PILOT);
    const next = await mail({ ticketId: m.ticketId, threadId: m.threadId });
    await recordCaseAfterConfirmedIntake(next.messageId, deps(c));
    const current = (await readCaseByTicket(m.ticketId))!;
    expect(current).toMatchObject({ owner: "human", phase: "human_owned" });
    expect(await situation(m.ticketId, c)).toMatchObject({ situation: "human_owner" });
    expect(await claimCaseForDecision({ caseId: current.caseId, expectedVersion: current.version, holder: "syn-runner", currentPolicyRevision: POLICY.revision, ttlSeconds: 60, settleSeconds: 0 }))
      .toMatchObject({ claimed: false });
    expect(await attributions(m.ticketId)).toHaveLength(1);
  });
  it("the wake, its replay, the catch-up and two racing relays attribute once", async () => {
    const c = crm(), m = await mail({ created: true, owner: PILOT });
    c.owners.set(m.ticketId, PILOT);
    await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    await sweepCaseRelays({ limit: 200, deps: deps(c) });
    await Promise.all([recordCaseAfterConfirmedIntake(m.messageId, deps(c)), recordCaseAfterConfirmedIntake(m.messageId, deps(c))]);
    expect((await events(m.ticketId)).filter(e => e.dedupeKey === caseDedupeKey.inbound(`gm-${m.messageId}`))).toHaveLength(1);
    expect(await attributions(m.ticketId)).toHaveLength(1);
  });
  it("a made-up creation proof (other owner, other hash, other ticket, not confirmed) moves nothing; the true one does", async () => {
    const m = await mail({ created: true, owner: PILOT }), other = await mail({ created: true, owner: PILOT });
    const [effect] = await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, m.effectId!));
    const requestId = caseRequestId(`gm-${m.messageId}`, "r0");
    const admission = { policy: POLICY, qualification: { requests: [{ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-syn-access", revision: "r1", at: RECEIVED } }],
      identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "syn-contact-42" } }, crmContext: "complete" as const, teamSignals: [] } };
    const proof = { kind: "hubspot_owner_at_creation" as const, executionId: m.executionId, effectId: m.effectId!, ticketId: m.ticketId, ownerId: PILOT, intentHash: effect!.intentHash };
    let n = 0;
    const open = (attribution: typeof proof) => openCaseEvent({ ticketId: m.ticketId, threadId: m.threadId, admission, attribution, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`gm-forged-${++n}`),
      sourceRef: { type: "email", id: `gm-forged-${n}` }, occurredAt: RECEIVED });
    for (const forged of [{ ...proof, ownerId: "90000043" }, { ...proof, intentHash: "f".repeat(64) }, { ...proof, executionId: other.executionId, effectId: other.effectId! }]) {
      expect((await open(forged)).case).toMatchObject({ owner: "human", body: { handoff: { reason: "awaiting_v2_attribution" } } });
    }
    await f.db.update(savIntakeEffects).set({ state: "uncertain" }).where(eq(savIntakeEffects.id, m.effectId!));
    expect((await open(proof)).case).toMatchObject({ owner: "human" });
    await f.db.update(savIntakeEffects).set({ state: "confirmed" }).where(eq(savIntakeEffects.id, m.effectId!));
    expect((await open(proof)).case).toMatchObject({ owner: "agent", phase: "queued" });
  });
});

describe("pilot access: the pause between relay, catch-up and processing", () => {
  it("any pause on either agent (the console's intake one included), or an unreadable one: the mail is recorded, not given to the agent, no owner read, while the pause lasts; afterwards the sweep reads the owner and moves it once", async () => {
    const c = crm(), tickets: string[] = [];
    for (const [agent, level] of [["intake", "fully_paused"], ["intake", "actions_paused"], ["v2", "actions_paused"], ["v2", "fully_paused"], ["intake", "invalid"]] as const) {
      const m = await mail({ created: true, owner: PILOT });
      c.owners.set(m.ticketId, PILOT); tickets.push(m.ticketId);
      await setPause(agent, level);
      expect(await recordCaseAfterConfirmedIntake(m.messageId, deps(c))).toMatchObject({ created: true, appended: true, owner: "human" });
      expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "human", body: { handoff: { reason: "awaiting_v2_attribution" } } });
      expect(await sweep(c)).toMatchObject({ failed: {} });
      expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "human" });
      expect(await attributions(m.ticketId)).toEqual([]);
      expect(c.requests.filter(r => tickets.some(ticketId => r.path === caseTicketOwnerReadPath(ticketId)))).toEqual([]);
      await setPause(agent, null);
      expect(await sweep(c)).toMatchObject({ failed: {} });
      expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "agent" });
      expect(await attributions(m.ticketId)).toHaveLength(1);
      c.requests.length = 0;
    }
  });
  it("a pause set while the relay runs stops the attribution under the ticket lock; the catch-up then records the mail for the team", async () => {
    const c = crm(), m = await mail({ created: true, owner: PILOT });
    c.owners.set(m.ticketId, PILOT);
    // The console's pause lands while the owner is being read: after the first look, before the ticket lock.
    const pausing = vi.fn(async (ticketId: string) => { const owner = await c.reader(ticketId); await setPause("intake", "fully_paused"); return owner; });
    await expect(recordCaseAfterConfirmedIntake(m.messageId, deps(c, { readCreatedTicketOwner: pausing }))).rejects.toThrow("SAV_CASE_RELAY_PAUSED");
    expect(pausing).toHaveBeenCalledTimes(1);
    expect(await readCaseByTicket(m.ticketId)).toBeNull();
    expect((await sweep(c)).failed).toEqual({});
    expect(await readCaseByTicket(m.ticketId)).toMatchObject({ owner: "human", body: { handoff: { reason: "awaiting_v2_attribution" } } });
    expect(await attributions(m.ticketId)).toEqual([]);
  });
  it("a case relayed before the pause: the console's pause refuses the claim, an actions pause claims to observe only", async () => {
    const c = crm(), m = await mail({ created: true, owner: PILOT });
    c.owners.set(m.ticketId, PILOT);
    await recordCaseAfterConfirmedIntake(m.messageId, deps(c));
    const current = (await readCaseByTicket(m.ticketId))!;
    const claim = () => claimCaseForDecision({ caseId: current.caseId, expectedVersion: current.version, holder: `syn-${randomUUID().slice(0, 8)}`, currentPolicyRevision: POLICY.revision, ttlSeconds: 30, settleSeconds: 0 });
    for (const level of ["fully_paused", "invalid"] as const) {
      await setPause("intake", level);
      expect(await claim()).toMatchObject({ claimed: false, reason: "agent_paused" });
    }
    await setPause("intake", "actions_paused");
    expect(await claim()).toMatchObject({ claimed: true, actionsPaused: true });
  });
});

describe("pilot access: no owner id, API identity or author profile in the code", () => {
  it("non-test case and intake code names no owner id: the dedicated owner is only ever read from the injected env", () => {
    const roots = [join(__dirname), join(__dirname, "../intake")];
    const offenders: string[] = [];
    for (const root of roots) for (const name of readdirSync(root)) {
      if (!name.endsWith(".ts") || name.includes(".test.")) continue;
      const text = readFileSync(join(root, name), "utf8");
      if (/hubspot_owner_id["']?\s*[:=]\s*["'`]\d/.test(text) || /SAV_V2_HUBSPOT_OWNER_ID\s*(\?\?|\|\|)\s*["'`]/.test(text) || /SAV Pilote/i.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
