import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, start: vi.fn() }));
vi.mock("workflow/api", () => ({ start: state.start }));
vi.mock("@/workflows/sav-v2-owner-handover", () => ({ processSavV2OwnerHandoverWorkflow: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// The real executor must never be loaded here: every test injects its progress reader.
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
import { encryptSavPayload } from "../crypto";
import { listCaseEvents, readCaseByTicket } from "./case-store";
import type { CaseBoundaryDeps } from "./intake-boundary";
import { recordCaseAfterConfirmedIntake, sweepCaseRelays } from "./intake-boundary";

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
beforeEach(() => { state.start.mockReset(); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "intake-boundary-fixture-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(() => { vi.unstubAllEnvs(); });


import { isOwnerHandoverEvent, requestOwnerHandover, runOwnerHandover, ownerHandoverGraceOpen } from "./owner-handover";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { savSyncState } from "@/db/schema";
const ENV = { VERCEL_ENV: "production", SAV_CASE_RECORDING: "on", SAV_V2_ENTRY: "on", SAV_V2_OWNER_HANDOVER: "on", SAV_V2_HUBSPOT_OWNER_ID: "902", HUBSPOT_SAV_OWNER_ID: "901" };
const event = (id = String(++seq), at = Date.now()) => ({ subscriptionType: "ticket.propertyChange", propertyName: "hubspot_owner_id", propertyValue: "902", changeSource: "CRM_UI", portalId: Number(SAV_HUBSPOT_SUPPORT.portalId), occurredAt: at, objectId: id });
async function scheduled(id?: string) {
  const e = event(id); let token = "";
  await requestOwnerHandover(e, { env: ENV, start: async (_id, t) => { token = t; } });
  return { e, token, now: new Date(e.occurredAt + 305_000) };
}
const customer = async () => ({ owner: "902", pipeline: "0", lastEmailAt: Date.parse(RECEIVED), lastDirection: "customer" as const });
const marker = async (id: string) => (await f.db.select().from(auditLogs).where(eq(auditLogs.entityId, id)))[0]!.technicalMetadata;
it("filters source, portal, value, property and V1 owner", () => {
  expect(isOwnerHandoverEvent(event(), ENV)).toBe(true);
  expect(isOwnerHandoverEvent({ ...event(), changeSource: "MOBILE" }, ENV)).toBe(true);
  for (const patch of [{ changeSource: "API" }, { changeSource: "INTEGRATION" }, { changeSource: "WORKFLOWS" }, { changeSource: undefined }, { portalId: 1 }, { propertyValue: "901" }, { propertyName: "hs_pipeline_stage" }]) expect(isOwnerHandoverEvent({ ...event(), ...patch }, ENV)).toBe(false);
  expect(isOwnerHandoverEvent(event(), { ...ENV, SAV_V2_HUBSPOT_OWNER_ID: "901" })).toBe(false);
});
it("off or absent, entry off, wakes off and preview start nothing", async () => {
  const start = vi.fn();
  for (const patch of [{ SAV_V2_OWNER_HANDOVER: undefined }, { SAV_V2_OWNER_HANDOVER: "off" }, { SAV_V2_ENTRY: "off" }, { SAV_V2_WAKE_WORKFLOWS: "off" }, { VERCEL_ENV: "preview" }]) expect(await requestOwnerHandover(event(), { env: { ...ENV, ...patch }, start })).toEqual({ status: "off" });
  expect(start).not.toHaveBeenCalled();
});
it("duplicate receipts start once; wake is consumed once; grace is open before wake", async () => {
  const s = await scheduled(), id = s.e.objectId, readTicket = vi.fn(customer);
  expect(await ownerHandoverGraceOpen(id)).toBe(true);
  expect(await requestOwnerHandover(s.e, { env: ENV, start: vi.fn() })).toEqual({ status: "not_reserved" });
  expect(await runOwnerHandover(id, s.token, { env: ENV, now: s.now, readTicket })).toEqual({ status: "no_confirmed_v1_mail" });
  expect(await marker(id)).toMatchObject({ state: "rejected", outcome: "no_confirmed_v1_mail" });
  expect(await ownerHandoverGraceOpen(id)).toBe(false);
  expect(await runOwnerHandover(id, s.token, { env: ENV, now: s.now, readTicket })).toEqual({ status: "not_consumed" });
  expect(readTicket).toHaveBeenCalledTimes(1);
});
it("V2-human-V2 replaces the old wake and rejects old receipts", async () => {
  const s = await scheduled(), id = s.e.objectId, start = vi.fn(); let latest = "";
  await requestOwnerHandover({ ...s.e, occurredAt: s.e.occurredAt + 1, propertyValue: "901" }, { env: ENV, start });
  await requestOwnerHandover({ ...s.e, occurredAt: s.e.occurredAt + 2 }, { env: ENV, start: async (_id, token) => { latest = token; } });
  expect(await requestOwnerHandover(s.e, { env: ENV, start })).toEqual({ status: "not_reserved" });
  expect(await runOwnerHandover(id, s.token, { env: ENV, now: s.now, readTicket: customer })).toEqual({ status: "not_consumed" });
  expect(await runOwnerHandover(id, latest, { env: ENV, now: new Date(s.now.getTime() + 2), readTicket: customer })).toEqual({ status: "no_confirmed_v1_mail" });
});
it("rechecks owner and pipeline, team last, history and switch", async () => {
  for (const [patch, status] of [[{ owner: "901" }, "owner_or_pipeline_changed"], [{ pipeline: "1" }, "owner_or_pipeline_changed"], [{ lastDirection: "team" }, "team_replied_last"], [{ lastDirection: "unknown" }, "history_unavailable"]] as const) {
    const s = await scheduled();
    expect(await runOwnerHandover(s.e.objectId, s.token, { env: ENV, now: s.now, readTicket: async () => ({ ...await customer(), ...patch }) })).toEqual({ status });
  }
  const s = await scheduled();
  expect(await runOwnerHandover(s.e.objectId, s.token, { env: { ...ENV, SAV_V2_OWNER_HANDOVER: "off" }, now: s.now })).toEqual({ status: "off" });
});
it("pause prevents the CRM read", async () => {
  await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", cursor: "invalid-synthetic-pause" });
  const s = await scheduled(), readTicket = vi.fn(customer);
  expect(await runOwnerHandover(s.e.objectId, s.token, { env: ENV, now: s.now, readTicket })).toEqual({ status: "paused" });
  expect(readTicket).not.toHaveBeenCalled();
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
});
it("outside block and sensitive mail use real V1 admission and cannot duplicate the case", async () => {
  for (const classification of ["unknown", "finance", "cancellation"] as const) {
    const source = await intake({ classification }), s = await scheduled(source.ticketId), continuation = vi.fn();
    const relay: typeof recordCaseAfterConfirmedIntake = (id, deps) => recordCaseAfterConfirmedIntake(id, { ...deps, ...confirmed(source.ticketId), readAdmissionPolicy: async () => null, readQualification: async () => null });
    expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket: customer, relay, continuation })).toEqual({ status: "not_admitted" });
    expect((await readCaseByTicket(source.ticketId))?.owner).toBe("human");
    expect(await recordCaseAfterConfirmedIntake(source.messageId, confirmed(source.ticketId))).toMatchObject({ appended: false, created: false });
    expect(continuation).not.toHaveBeenCalled();
  }
});
it("sweep excludes a confirmed ticket during the grace", async () => {
  const source = await intake(); await scheduled(source.ticketId);
  await sweepCaseRelays({ deps: { env: ENV, ...confirmed(source.ticketId) } });
  expect(await readCaseByTicket(source.ticketId)).toBeNull();
});

it("delayed wake keeps the sweep blocked beyond its scheduled time", async () => {
  const source = await intake(), e = event(source.ticketId, Date.now() - 600_000);
  await requestOwnerHandover(e, { env: ENV, start: async () => {} });
  expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(true);
  await sweepCaseRelays({ deps: { env: ENV, ...confirmed(source.ticketId) } });
  expect(await readCaseByTicket(source.ticketId)).toBeNull();
});

it("sweep during CRM reading stays blocked until team-last is durable", async () => {
  const source = await intake(), s = await scheduled(source.ticketId);
  const readTicket = async () => {
    expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(true);
    await sweepCaseRelays({ deps: { env: ENV, ...confirmed(source.ticketId) } });
    expect(await readCaseByTicket(source.ticketId)).toBeNull();
    return { ...await customer(), lastDirection: "team" as const };
  };
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket })).toEqual({ status: "team_replied_last" });
  expect(await marker(source.ticketId)).toMatchObject({ state: "team_replied_last", teamLastAt: RECEIVED });
  await sweepCaseRelays({ deps: { env: ENV, ...confirmed(source.ticketId) } });
  expect(await readCaseByTicket(source.ticketId)).toBeNull();
});

it("an interrupted CRM read keeps a durable block instead of releasing the sweep", async () => {
  const source = await intake(), s = await scheduled(source.ticketId);
  await expect(runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket: async () => { throw Error("SYNTHETIC_CRM_FAILURE"); } })).rejects.toThrow("SYNTHETIC_CRM_FAILURE");
  expect(await marker(source.ticketId)).toMatchObject({ state: "consumed" });
  expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(true);
  await sweepCaseRelays({ deps: { env: ENV, ...confirmed(source.ticketId) } });
  expect(await readCaseByTicket(source.ticketId)).toBeNull();
});

it("team last also blocks sweep after the wake", async () => {
  const source = await intake(), s = await scheduled(source.ticketId);
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket: async () => ({ ...await customer(), lastDirection: "team" as const }) })).toEqual({ status: "team_replied_last" });
  await sweepCaseRelays({ deps: { env: ENV, ...confirmed(source.ticketId) } });
  expect(await readCaseByTicket(source.ticketId)).toBeNull();
});
it("admitted relay continues the agent case once", async () => {
  const source = await intake(), s = await scheduled(source.ticketId), caseId = randomUUID();
  const relay = vi.fn<typeof recordCaseAfterConfirmedIntake>(async () => {
    expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(true);
    await sweepCaseRelays({ deps: { env: ENV, ...confirmed(source.ticketId) } });
    expect(await readCaseByTicket(source.ticketId)).toBeNull();
    return { caseId, version: 1, created: false, appended: false, owner: "agent", relay: "intake_effects_confirmed", admission: null };
  });
  const continuation = vi.fn(async () => {
    expect(await marker(source.ticketId)).toMatchObject({ state: "admitted", caseId });
    expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(false);
    return { status: "queued" };
  });
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket: customer, relay, continuation })).toEqual({ status: "queued" });
  expect(relay.mock.calls[0]![0]).toBe(source.messageId);
  expect(continuation).toHaveBeenCalledTimes(1);
  expect(await marker(source.ticketId)).toMatchObject({ state: "admitted", caseId });
  await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket: customer, relay, continuation });
  expect(continuation).toHaveBeenCalledTimes(1);
});

async function expire(id: string) {
  const old = await marker(id);
  await f.db.update(auditLogs).set({ technicalMetadata: { ...old, recoverAt: new Date(Date.now() - 1).toISOString() } }).where(eq(auditLogs.entityId, id));
}
const sweep = (id: string) => sweepCaseRelays({ deps: { env: ENV, ...confirmed(id) } });
it("periodic sweep recovers a failed start without a webhook replay or duplicate wake", async () => {
  const source = await intake(), e = event(source.ticketId, Date.now() - 600_000);
  await expect(requestOwnerHandover(e, { env: ENV, start: async () => { throw Error("START_FAILED"); } })).rejects.toThrow("SAV_OWNER_HANDOVER_START_FAILED");
  const oldToken = String((await marker(source.ticketId)).token);
  const relay = vi.fn<typeof recordCaseAfterConfirmedIntake>(async (id, deps) => recordCaseAfterConfirmedIntake(id, { ...deps, ...confirmed(source.ticketId), readAdmissionPolicy: async () => null, readQualification: async () => null }));
  const continuation = vi.fn();
  const args = { env: ENV, readTicket: customer, relay, continuation };
  // Model the workflow service executing the wake it receives from the sweep.
  state.start.mockImplementation(async (_workflow, [id, token]: string[]) => runOwnerHandover(id!, token!, args));
  await expire(source.ticketId);
  await sweep(source.ticketId);
  const recovered = await marker(source.ticketId);
  expect(recovered).toMatchObject({ state: "rejected", outcome: "not_admitted", retries: 1 });
  expect(recovered.token).not.toBe(oldToken);
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(state.start.mock.calls[0]![1]).toEqual([source.ticketId, recovered.token, recovered.wakeAt]);
  expect(await runOwnerHandover(source.ticketId, oldToken, args)).toEqual({ status: "not_consumed" });
  await runOwnerHandover(source.ticketId, String(recovered.token), args);
  await sweep(source.ticketId);
  expect(relay).toHaveBeenCalledTimes(1);
  expect(continuation).not.toHaveBeenCalled();
  expect(await requestOwnerHandover(e, { env: ENV, start: vi.fn() })).toEqual({ status: "not_reserved" });
});

it("sweep retries a consumed CRM failure and fences the interrupted reader", async () => {
  const source = await intake(), e = event(source.ticketId, Date.now() - 600_000);
  let token = "";
  await requestOwnerHandover(e, { env: ENV, start: async (_id, t) => { token = t; } });
  const relay = vi.fn<typeof recordCaseAfterConfirmedIntake>();
  const readTicket = async () => {
    await expire(source.ticketId);
    await sweep(source.ticketId);
    expect(await readCaseByTicket(source.ticketId)).toBeNull();
    return customer();
  };
  expect(await runOwnerHandover(source.ticketId, token, { env: ENV, readTicket, relay })).toEqual({ status: "replaced" });
  expect(relay).not.toHaveBeenCalled();
  const recovered = await marker(source.ticketId);
  await expect(runOwnerHandover(source.ticketId, String(recovered.token), { env: ENV, readTicket: async () => { throw Error("CRM_DOWN"); } })).rejects.toThrow("CRM_DOWN");
  expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(true);
  state.start.mockImplementation(async (_workflow, [id, nextToken]: string[]) => runOwnerHandover(id!, nextToken!, { env: ENV, readTicket: async () => ({ ...await customer(), lastDirection: "team" }) }));
  await expire(source.ticketId);
  await sweep(source.ticketId);
  expect(await marker(source.ticketId)).toMatchObject({ state: "team_replied_last", retries: 2 });
  expect(state.start).toHaveBeenCalledTimes(2);
});
it("three failed recoveries abandon durably, then the ordinary V1 sweep relays once", async () => {
  const source = await intake({ classification: "finance" }), e = event(source.ticketId, Date.now() - 600_000);
  await requestOwnerHandover(e, { env: ENV, start: async () => {} });
  state.start.mockRejectedValue(Error("START_FAILED"));
  for (let retries = 1; retries <= 3; retries++) {
    await expire(source.ticketId);
    await sweep(source.ticketId);
    expect(await marker(source.ticketId)).toMatchObject({ state: "start_failed", retries });
    expect(await readCaseByTicket(source.ticketId)).toBeNull();
    expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(true);
  }
  await expire(source.ticketId);
  await sweep(source.ticketId);
  expect(await marker(source.ticketId)).toMatchObject({ state: "abandoned", outcome: "recovery_exhausted", retries: 3 });
  expect((await marker(source.ticketId)).abandonedAt).toEqual(expect.any(String));
  expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(false);
  expect((await readCaseByTicket(source.ticketId))?.owner).toBe("human");
  expect(state.start).toHaveBeenCalledTimes(3);
  expect(await sweep(source.ticketId)).toMatchObject({ relayed: 0 });
  expect(await requestOwnerHandover(e, { env: ENV, start: vi.fn() })).toEqual({ status: "not_reserved" });
});
it("concurrent periodic sweeps reserve only one replacement", async () => {
  const s = await scheduled();
  await expire(s.e.objectId);
  await Promise.all([sweep(s.e.objectId), sweep(s.e.objectId)]);
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(await marker(s.e.objectId)).toMatchObject({ retries: 1, state: "starting" });
});
it("early wake neither consumes the marker nor reads CRM", async () => {
  const s = await scheduled(), readTicket = vi.fn(customer);
  expect(await runOwnerHandover(s.e.objectId, s.token, { env: ENV, now: new Date(s.now.getTime() - 1), readTicket })).toEqual({ status: "not_consumed" });
  expect(await ownerHandoverGraceOpen(s.e.objectId)).toBe(true);
  expect(readTicket).not.toHaveBeenCalled();
});
it("new handover received during CRM reading stops the old passage", async () => {
  const source = await intake(), s = await scheduled(source.ticketId), relay = vi.fn<typeof recordCaseAfterConfirmedIntake>();
  const readTicket = async () => {
    await requestOwnerHandover({ ...s.e, occurredAt: s.e.occurredAt + 1 }, { env: ENV, start: async () => {} });
    return customer();
  };
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket, relay })).toEqual({ status: "replaced" });
  expect(relay).not.toHaveBeenCalled();
});

it("recovers legacy consumed markers without a recovery deadline", async () => {
  const s = await scheduled();
  const old = await marker(s.e.objectId);
  const { recoverAt: _deadline, ...legacy } = old;
  await f.db.update(auditLogs).set({ technicalMetadata: { ...legacy, state: "consumed", wakeAt: new Date(Date.now() - 600_000).toISOString() } }).where(eq(auditLogs.entityId, s.e.objectId));
  await sweep(s.e.objectId);
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(await marker(s.e.objectId)).toMatchObject({ state: "starting", retries: 1 });
});

it.each(["SAV_V2_OWNER_HANDOVER", "SAV_V2_ENTRY", "SAV_V2_WAKE_WORKFLOWS"])("%s off during grace abandons without retry; normal sweep relays once", async key => {
  const source = await intake({ classification: "finance" }), s = await scheduled(source.ticketId);
  const env = { ...ENV, [key]: "off" }, deps = { env, ...confirmed(source.ticketId) };
  // Not yet due: switching off must release even an otherwise healthy grace.
  await sweepCaseRelays({ deps });
  expect(await marker(source.ticketId)).toMatchObject({ state: "abandoned", outcome: "switch_off", retries: 0 });
  expect((await marker(source.ticketId)).abandonedAt).toEqual(expect.any(String));
  expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(false);
  const first = await readCaseByTicket(source.ticketId);
  expect(first?.owner).toBe("human");
  expect(first?.caseId).toEqual(expect.any(String));
  const readTicket = vi.fn(customer), relay = vi.fn<typeof recordCaseAfterConfirmedIntake>();
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket, relay })).toEqual({ status: "not_consumed" });
  expect(await sweepCaseRelays({ deps })).toMatchObject({ relayed: 0 });
  expect((await readCaseByTicket(source.ticketId))?.caseId).toBe(first?.caseId);
  expect(readTicket).not.toHaveBeenCalled();
  expect(relay).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
});

it.each(["SAV_V2_OWNER_HANDOVER", "SAV_V2_ENTRY", "SAV_V2_WAKE_WORKFLOWS"])("%s off at wake durably abandons and rejects a later wake", async key => {
  const source = await intake({ classification: "finance" }), s = await scheduled(source.ticketId);
  const readTicket = vi.fn(customer);
  expect(await runOwnerHandover(source.ticketId, s.token, { env: { ...ENV, [key]: "off" }, now: s.now, readTicket })).toEqual({ status: "off" });
  expect(await marker(source.ticketId)).toMatchObject({ state: "abandoned", outcome: "switch_off", retries: 0 });
  expect(await sweep(source.ticketId)).toMatchObject({ relayed: 1 });
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket })).toEqual({ status: "not_consumed" });
  expect(await sweep(source.ticketId)).toMatchObject({ relayed: 0 });
  expect(readTicket).not.toHaveBeenCalled();
});

it.each(["starting", "start_failed", "consumed"])("absolute event deadline ignores %s even with a future recovery time", async stateName => {
  const source = await intake({ classification: "finance" }), s = await scheduled(source.ticketId);
  const old = await marker(source.ticketId);
  await f.db.update(auditLogs).set({ technicalMetadata: { ...old, state: stateName,
    occurredAt: Date.now() - 3_600_001, recoverAt: new Date(Date.now() + 3_600_000).toISOString(), teamLastAt: RECEIVED } }).where(eq(auditLogs.entityId, source.ticketId));
  // Check the SQL filter itself before recovery can abandon the row.
  expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(false);
  const readTicket = vi.fn(customer), relay = vi.fn<typeof recordCaseAfterConfirmedIntake>();
  await runOwnerHandover(source.ticketId, s.token, { env: ENV, readTicket, relay });
  expect(await sweep(source.ticketId)).toMatchObject({ relayed: 1 });
  expect(await sweep(source.ticketId)).toMatchObject({ relayed: 0 });
  expect(readTicket).not.toHaveBeenCalled();
  expect(relay).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
});

it("a CRM read crossing the absolute deadline cannot relay after the normal sweep", async () => {
  const source = await intake({ classification: "finance" }), s = await scheduled(source.ticketId);
  const relay = vi.fn<typeof recordCaseAfterConfirmedIntake>(), continuation = vi.fn();
  const readTicket = async () => {
    const old = await marker(source.ticketId);
    await f.db.update(auditLogs).set({ technicalMetadata: { ...old, occurredAt: Date.now() - 3_600_001 } }).where(eq(auditLogs.entityId, source.ticketId));
    expect(await sweep(source.ticketId)).toMatchObject({ relayed: 1 });
    return customer();
  };
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket, relay, continuation })).toEqual({ status: "replaced" });
  expect(await marker(source.ticketId)).toMatchObject({ state: "abandoned", outcome: "expired", retries: 0 });
  expect(await sweep(source.ticketId)).toMatchObject({ relayed: 0 });
  expect(relay).not.toHaveBeenCalled();
  expect(continuation).not.toHaveBeenCalled();
});

it.each(["expired", "switch_off"])("rechecks %s after CRM reading before any relay", async reason => {
  const source = await intake({ classification: "finance" }), s = await scheduled(source.ticketId);
  const env = { ...ENV }, relay = vi.fn<typeof recordCaseAfterConfirmedIntake>(), continuation = vi.fn();
  const readTicket = async () => {
    if (reason === "switch_off") env.SAV_V2_OWNER_HANDOVER = "off";
    else {
      const old = await marker(source.ticketId);
      await f.db.update(auditLogs).set({ technicalMetadata: { ...old, occurredAt: Date.now() - 3_600_001 } }).where(eq(auditLogs.entityId, source.ticketId));
    }
    return customer();
  };
  expect(await runOwnerHandover(source.ticketId, s.token, { env, now: s.now, readTicket, relay, continuation })).toEqual({ status: reason === "expired" ? "expired" : "off" });
  expect(await marker(source.ticketId)).toMatchObject({ state: "abandoned", outcome: reason, retries: 0 });
  expect(await sweep(source.ticketId)).toMatchObject({ relayed: 1 });
  expect(await sweep(source.ticketId)).toMatchObject({ relayed: 0 });
  expect(relay).not.toHaveBeenCalled();
  expect(continuation).not.toHaveBeenCalled();
});

it("switch off recovery abandons an interrupted consumed wake without a second relay", async () => {
  const source = await intake({ classification: "finance" }), s = await scheduled(source.ticketId);
  const relay = vi.fn<typeof recordCaseAfterConfirmedIntake>();
  const readTicket = async () => {
    expect(await sweepCaseRelays({ deps: { env: { ...ENV, SAV_V2_ENTRY: "off" }, ...confirmed(source.ticketId) } })).toMatchObject({ relayed: 1 });
    return customer();
  };
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket, relay })).toEqual({ status: "replaced" });
  expect(await marker(source.ticketId)).toMatchObject({ state: "abandoned", outcome: "switch_off", retries: 0 });
  expect(await sweep(source.ticketId)).toMatchObject({ relayed: 0 });
  expect(relay).not.toHaveBeenCalled();
});


it("team-last blocks an admissible old mail beyond one hour until a newer confirmed customer mail", async () => {
  const source = await intake(), s = await scheduled(source.ticketId);
  const readCreatedTicketOwner = vi.fn(async () => "902");
  const deps: CaseBoundaryDeps = {
    env: ENV, ...confirmed(source.ticketId), readCreatedTicketOwner,
    readAdmissionPolicy: async () => ({ revision: "team-last-policy", admittedFamilies: ["usage"],
      qualifiedRules: [{ ruleId: "usage-rule", revision: "r1", families: ["usage"] }],
      approvedBy: "20000000-0000-4000-8000-000000000001", approvedAt: RECEIVED }),
    readQualification: async ({ requests }) => ({
      requests: requests.map(request => ({ requestId: request.requestId, family: "usage", provenance: {
        kind: "qualified_rule", ruleId: "usage-rule", revision: "r1", at: RECEIVED } })),
      identity: { status: "confirmed", source: { type: "hubspot_object", id: "synthetic-contact" } },
      crmContext: "complete", teamSignals: [],
    }),
  };
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now,
    readTicket: async () => ({ ...await customer(), lastDirection: "team" }) })).toEqual({ status: "team_replied_last" });
  const old = await marker(source.ticketId);
  await f.db.update(auditLogs).set({ technicalMetadata: { ...old, occurredAt: Date.now() - 3_600_001 } })
    .where(eq(auditLogs.entityId, source.ticketId));
  expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(true);
  await sweepCaseRelays({ deps });
  expect(await readCaseByTicket(source.ticketId)).toBeNull();
  expect(readCreatedTicketOwner).not.toHaveBeenCalled();
  expect(await marker(source.ticketId)).toMatchObject({ state: "team_replied_last" });

  // Equal timestamps and outbound mail do not prove a new customer message.
  const reply = await intake({ ticketId: source.ticketId, threadId: source.threadId });
  const outbound = await intake({ ticketId: source.ticketId, threadId: source.threadId, direction: "outbound" });
  await f.db.update(savMessages).set({ receivedAt: new Date(Date.parse(RECEIVED) + 1) }).where(eq(savMessages.id, outbound.messageId));
  expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(true);
  await sweepCaseRelays({ deps });
  expect(await readCaseByTicket(source.ticketId)).toBeNull();

  await f.db.update(savMessages).set({ receivedAt: new Date(Date.parse(RECEIVED) + 1) }).where(eq(savMessages.id, reply.messageId));
  expect(await ownerHandoverGraceOpen(source.ticketId)).toBe(false);
  await sweepCaseRelays({ deps });
  const current = (await readCaseByTicket(source.ticketId))!;
  expect(current).toMatchObject({ owner: "agent", admission: { target: "agent" } });
  expect((await listCaseEvents(current.caseId)).filter(event => event.kind === "inbound_confirmed")).toHaveLength(2);
  expect((await listCaseEvents(current.caseId)).filter(event => event.kind === "owner_changed")).toHaveLength(1);
  expect(await sweepCaseRelays({ deps })).toMatchObject({ relayed: 0, recovered: 0 });
  expect((await readCaseByTicket(source.ticketId))?.version).toBe(current.version);
  expect(state.start).not.toHaveBeenCalled();
});
