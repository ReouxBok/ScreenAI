// Pole A (3/11, SYN): the console's three cases on the real relay, case store, CRM observation and A10 owner reader, over V1 tables.
// Test preconditions, never production settings or Ugo's decisions: the admission policy (P1) and the qualification port (P2) below,
// the V2 owner id (P4) and a JSON GET transport returning synthetic tickets. No network, no provider write, no model.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
import { encryptSavPayload } from "../crypto";
import { caseTicketOwnerPortFromTransport, caseTicketOwnerReadPath } from "./admission-owner-reader";
import { claimCaseForDecision, listCaseEvents, readCaseByTicket } from "./case-store";
import { describeCaseOwnerSituation, SAV_CASE_OWNER_SITUATIONS, type CaseOwnerReadingInput } from "./case-owner-situation";
import { caseDedupeKey, emptyCaseBody, type CaseAdmissionQualification, type CaseSnapshot } from "./case-types";
import { recordCaseAfterConfirmedIntake, sweepCaseRelays, type CaseBoundaryDeps } from "./intake-boundary";
import { observeTicketCrmChange } from "./owner-attribution";

const RECEIVED = "2026-11-03T08:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000001";
const V2_OWNER = "90000001", HUMAN_OWNER = "70000001", V2_ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" };
/** P1: a synthetic approved policy admitting « usage » (a video import is a usage question). */
const POLICY = { revision: "policy-syn-r1", admittedFamilies: ["usage"], qualifiedRules: [{ ruleId: "rule-syn-usage", revision: "r1", families: ["usage"] }], approvedBy: STAFF, approvedAt: RECEIVED };
/** P2: a qualification port that says « usage » for EVERY request, finance included: a sensitive V1 hint must still win. */
const qualifyAllAsUsage = vi.fn(async (input: { requests: { requestId: string }[] }): Promise<CaseAdmissionQualification> => ({
  requests: input.requests.map(request => ({ requestId: request.requestId, family: "usage" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-syn-usage", revision: "r1", at: RECEIVED } })),
  identity: { status: "confirmed", source: { type: "hubspot_object", id: "syn-contact-1" } }, crmContext: "complete", teamSignals: [],
}));

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, seq = 8_700_000;
/** A mail V1 attached and confirmed (every required effect), as the V1 executor leaves it. */
async function attached(options: { ticketId?: string; threadId?: string; requests?: string[]; at?: string } = {}) {
  const threadId = options.threadId ?? randomUUID(), messageId = randomUUID(), ticketId = options.ticketId ?? String(++seq);
  if (!options.threadId) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Import vidéo", customerEmail: "client@example.invalid" });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"], subject: "Import vidéo",
    bodyCiphertext: encryptSavPayload({ text: "Synthétique : ma vidéo ne s'importe pas." }), receivedAt: new Date(options.at ?? RECEIVED), gmailMessageId: `gm-${messageId}` });
  const requests = options.requests ?? ["support"];
  await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: requests.map((kind, i) => ({ id: `r${i}`, kind })) } } }) });
  return { messageId, threadId, ticketId };
}
/** V1's own progress, read from its execution row, as the sweep's default reader would. */
const progress = vi.fn(async (messageId: string) => {
  const [row] = await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId));
  return row ? { state: row.state, ticketId: row.ticketId, confirmed: row.state === "confirmed", effects: [{}] } : null;
});
const deps = (over: Partial<CaseBoundaryDeps> = {}): CaseBoundaryDeps => ({ env: V2_ENV, readProgress: progress, readAdmissionPolicy: async () => POLICY, readQualification: qualifyAllAsUsage, ...over });

/** The A10 reader on a synthetic JSON GET transport: `owners` is the CRM as it stands; every request is logged. */
function crm() {
  const owners = new Map<string, string | null>(), requests: { method: string; path: string }[] = [];
  const port = caseTicketOwnerPortFromTransport({ env: V2_ENV, transport: async request => {
    requests.push(request);
    const id = /tickets\/([0-9]+)\?/.exec(request.path)![1]!;
    return { id, archived: false, properties: { hubspot_owner_id: owners.get(id) ?? null } };
  } });
  const read = async (ticketId: string): Promise<CaseOwnerReadingInput> => { try { return await port({ ticketId }); } catch { return "read_failed"; } };
  return { owners, requests, read };
}
const situationOf = async (ticketId: string, read: (ticketId: string) => Promise<CaseOwnerReadingInput>) => describeCaseOwnerSituation((await readCaseByTicket(ticketId))!, await read(ticketId));
const inbound = async (ticketId: string, gmailId: string) => (await listCaseEvents((await readCaseByTicket(ticketId))!.caseId)).filter(e => e.dedupeKey === caseDedupeKey.inbound(gmailId));

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "owner-situation-fixture-key-32-characters!");
  f = await createSavTestDb(); state.db = f.db;
  const run = randomUUID();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: `synthetic-situation-admin-${run}`, email: `situation-admin-${run}@example.invalid`, role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: `support-${run}@example.invalid` }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "owner-situation-fixture-key-32-characters!"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_NOT_ALLOWED"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("describeCaseOwnerSituation (pure)", () => {
  const admitted = { target: "agent", reasons: ["admitted"] } as unknown as CaseSnapshot["admission"];
  const awaiting: Pick<CaseSnapshot, "owner" | "phase" | "body" | "sensitivity" | "admission"> = { owner: "human", phase: "handoff_pending", sensitivity: "none", admission: admitted,
    body: { ...emptyCaseBody(), handoff: { reason: "awaiting_v2_attribution" } } };
  it("tells case 1 from case 2 only by the current reading; unknown or a failed read is never « nobody »", () => {
    const by = (reading: CaseOwnerReadingInput) => describeCaseOwnerSituation(awaiting, reading).situation;
    expect(by("none")).toBe("admitted_take_blocked");
    expect(by("human")).toBe("human_owner");
    expect(by("v2")).toBe("v2_owner_read_pending");
    for (const reading of ["unknown", "read_failed", "not_read"] as const) expect(by(reading)).toBe("owner_unknown");
  });
  it("sensitivity first, a person's takeover before the reading, the agent only on a V2 reading; no situation ever writes an owner", () => {
    const sensitive = { ...awaiting, sensitivity: "finance" as const };
    for (const reading of ["none", "v2", "human", "not_read"] as const) expect(describeCaseOwnerSituation(sensitive, reading).situation).toBe("excluded_sensitive");
    expect(describeCaseOwnerSituation({ ...awaiting, admission: { target: "team", reasons: ["mixed_sensitive"] } as unknown as CaseSnapshot["admission"] }, "none").situation).toBe("excluded_sensitive");
    const taken = { ...awaiting, body: { ...emptyCaseBody(), handoff: { reason: "hubspot_owner_human", humanSince: RECEIVED } } };
    expect(describeCaseOwnerSituation(taken, "none").situation).toBe("human_owner");
    expect(describeCaseOwnerSituation({ ...awaiting, phase: "human_owned" }, "none").situation).toBe("human_owner");
    expect(describeCaseOwnerSituation({ ...awaiting, admission: { target: "qualification", reasons: ["policy_missing"] } as unknown as CaseSnapshot["admission"], body: { ...emptyCaseBody(), handoff: { reason: "policy_missing" } } }, "none").situation).toBe("team_not_admitted");
    const agent = { ...awaiting, owner: "agent" as const, phase: "queued" as const, body: emptyCaseBody() };
    expect(describeCaseOwnerSituation(agent, "v2")).toMatchObject({ situation: "agent", v2Work: true });
    for (const reading of ["none", "human", "unknown", "read_failed", "not_read"] as const) expect(describeCaseOwnerSituation(agent, reading)).toMatchObject({ situation: "agent_unconfirmed", v2Work: false });
    expect(describeCaseOwnerSituation({ ...agent, owner: "system_hold" }, "v2").situation).toBe("system_hold");
    const seen = new Set<string>();
    for (const current of [awaiting, sensitive, taken, agent, { ...agent, owner: "system_hold" as const }, { ...awaiting, body: { ...emptyCaseBody(), handoff: { reason: "policy_missing" } } }])
      for (const reading of ["v2", "human", "none", "unknown", "read_failed", "not_read"] as const) {
        const described = describeCaseOwnerSituation(current, reading);
        expect(described.ownerWrite).toBe(false);
        expect(described.v2Work).toBe(described.situation === "agent");
        seen.add(described.situation);
      }
    expect([...seen].sort()).toEqual([...SAV_CASE_OWNER_SITUATIONS].sort());
  });
});

describe("console cases on the real relay (SYN)", () => {
  it("case 1: a video-import mail V1 attached to a ticket nobody owns is admitted and stays with the team; the take is blocked and nothing is written", async () => {
    const c = crm(), source = await attached();
    const relayed = await recordCaseAfterConfirmedIntake(source.messageId, deps());
    expect(relayed).toMatchObject({ created: true, appended: true, owner: "human", relay: "intake_effects_confirmed", admission: { target: "agent", reasons: ["admitted"] } });
    expect(await readCaseByTicket(source.ticketId)).toMatchObject({ owner: "human", phase: "handoff_pending", sensitivity: "none", body: { handoff: { reason: "awaiting_v2_attribution" } } });
    expect(await situationOf(source.ticketId, c.read)).toMatchObject({ situation: "admitted_take_blocked", v2Work: false, ownerWrite: false });
    // One owner read, a GET of this ticket's owner only; B cannot claim the case.
    expect(c.requests).toEqual([{ method: "GET", path: caseTicketOwnerReadPath(source.ticketId) }]);
    const stored = (await readCaseByTicket(source.ticketId))!;
    expect(await claimCaseForDecision({ caseId: stored.caseId, expectedVersion: stored.version, holder: "pole-b-runner", currentPolicyRevision: POLICY.revision, ttlSeconds: 300, now: new Date(Date.now() + 6 * 60_000) }))
      .toMatchObject({ claimed: false, reason: "owner_not_agent" });
  });
  it("case 1 race: a person takes the ticket after the relay; the observation hands the case to the person for good, and the next mail does not free it", async () => {
    const c = crm(), source = await attached();
    await recordCaseAfterConfirmedIntake(source.messageId, deps());
    c.owners.set(source.ticketId, HUMAN_OWNER);
    // Before V2 even observes the change, the current reading already stops everything: there was no write to undo.
    expect(await situationOf(source.ticketId, c.read)).toMatchObject({ situation: "human_owner", v2Work: false });
    expect(await observeTicketCrmChange({ ticketId: source.ticketId, ownerId: HUMAN_OWNER, hubspotUpdatedAt: "2026-11-03T08:05:00.000Z", env: V2_ENV })).toMatchObject({ takeover: true });
    expect(await readCaseByTicket(source.ticketId)).toMatchObject({ owner: "human", phase: "human_owned" });
    // The person lets go in the CRM, then the customer writes again: the case stays the person's.
    c.owners.set(source.ticketId, null);
    expect(await observeTicketCrmChange({ ticketId: source.ticketId, ownerId: null, hubspotUpdatedAt: "2026-11-03T08:10:00.000Z", env: V2_ENV })).toMatchObject({ takeover: false });
    const next = await attached({ ticketId: source.ticketId, threadId: source.threadId, at: "2026-11-03T08:20:00.000Z" });
    expect(await recordCaseAfterConfirmedIntake(next.messageId, deps())).toMatchObject({ appended: true, owner: "human" });
    expect(await situationOf(source.ticketId, c.read)).toMatchObject({ situation: "human_owner", v2Work: false });
    expect(c.requests.every(request => request.method === "GET")).toBe(true);
  });
  it("case 2: the same mail on a ticket a person holds gets no V2 work at all", async () => {
    const c = crm(), one = await attached(), two = await attached();
    c.owners.set(two.ticketId, HUMAN_OWNER);
    for (const source of [one, two]) await recordCaseAfterConfirmedIntake(source.messageId, deps());
    expect(await situationOf(one.ticketId, c.read)).toMatchObject({ situation: "admitted_take_blocked" });
    expect(await situationOf(two.ticketId, c.read)).toMatchObject({ situation: "human_owner", v2Work: false, ownerWrite: false });
    expect(await observeTicketCrmChange({ ticketId: two.ticketId, ownerId: HUMAN_OWNER, hubspotUpdatedAt: "2026-11-03T08:05:00.000Z", env: V2_ENV })).toMatchObject({ takeover: true });
    expect(await readCaseByTicket(two.ticketId)).toMatchObject({ owner: "human", phase: "human_owned" });
    // The first case did not move.
    expect(await readCaseByTicket(one.ticketId)).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "awaiting_v2_attribution" } } });
  });
  it("case 3: an incident plus a billing question is closed to V2 before any owner read, even when the qualification port calls everything « usage »", async () => {
    const c = crm(), source = await attached({ requests: ["support", "finance"] });
    expect(await recordCaseAfterConfirmedIntake(source.messageId, deps())).toMatchObject({ owner: "human", admission: { target: "team" } });
    const stored = (await readCaseByTicket(source.ticketId))!;
    expect(stored).toMatchObject({ owner: "human", sensitivity: "finance", phase: "handoff_pending" });
    expect(["sensitive_family", "mixed_sensitive", "case_sensitive"]).toContain(stored.admission!.reasons[0]);
    for (const reading of ["none", "v2", "not_read"] as const) expect(describeCaseOwnerSituation(stored, reading)).toMatchObject({ situation: "excluded_sensitive", v2Work: false });
    expect(c.requests).toEqual([]);
  });
});

describe("relay durability (SYN): cut after attachment, duplicates", () => {
  it("a relay cut after V1 attached the mail writes nothing, and the catch-up relays it once", async () => {
    const source = await attached();
    const down = vi.fn(async () => { throw Error("SYNTHETIC_QUALIFICATION_DOWN"); });
    await expect(recordCaseAfterConfirmedIntake(source.messageId, deps({ readQualification: down }))).rejects.toThrow("SYNTHETIC_QUALIFICATION_DOWN");
    expect(await readCaseByTicket(source.ticketId)).toBeNull();
    const first = await sweepCaseRelays({ limit: 200, deps: deps() });
    expect(first).toMatchObject({ relayed: expect.any(Number) });
    expect(await inbound(source.ticketId, `gm-${source.messageId}`)).toHaveLength(1);
    expect(await sweepCaseRelays({ limit: 200, deps: deps() })).toMatchObject({ relayed: 0 });
    expect(await inbound(source.ticketId, `gm-${source.messageId}`)).toHaveLength(1);
  });
  it("the wake, its replay, the catch-up and two racing relays of one mail leave one case and one event", async () => {
    const source = await attached();
    const first = await recordCaseAfterConfirmedIntake(source.messageId, deps()) as { caseId: string; version: number };
    await recordCaseAfterConfirmedIntake(source.messageId, deps());
    await sweepCaseRelays({ limit: 200, deps: deps() });
    const raced = await Promise.all([recordCaseAfterConfirmedIntake(source.messageId, deps()), recordCaseAfterConfirmedIntake(source.messageId, deps())]);
    expect(raced.map(result => "appended" in result && result.appended)).toEqual([false, false]);
    expect(await inbound(source.ticketId, `gm-${source.messageId}`)).toHaveLength(1);
    expect(await readCaseByTicket(source.ticketId)).toMatchObject({ caseId: first.caseId, version: first.version });
  });
});
