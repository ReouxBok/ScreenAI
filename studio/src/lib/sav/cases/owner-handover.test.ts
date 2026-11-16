import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// The real executor must never be loaded here: every test injects its progress reader.
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
import { encryptSavPayload } from "../crypto";
import { readCaseByTicket } from "./case-store";
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
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "intake-boundary-fixture-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
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

it("team last also blocks sweep after the wake", async () => {
  const source = await intake(), s = await scheduled(source.ticketId);
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket: async () => ({ ...await customer(), lastDirection: "team" as const }) })).toEqual({ status: "team_replied_last" });
  await sweepCaseRelays({ deps: { env: ENV, ...confirmed(source.ticketId) } });
  expect(await readCaseByTicket(source.ticketId)).toBeNull();
});
it("admitted relay continues the agent case once", async () => {
  const source = await intake(), s = await scheduled(source.ticketId), caseId = randomUUID();
  const relay = vi.fn<typeof recordCaseAfterConfirmedIntake>(async () => ({ caseId, version: 1, created: false, appended: false, owner: "agent", relay: "intake_effects_confirmed", admission: null }));
  const continuation = vi.fn(async () => ({ status: "queued" }));
  expect(await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket: customer, relay, continuation })).toEqual({ status: "queued" });
  expect(relay.mock.calls[0]![0]).toBe(source.messageId);
  expect(continuation).toHaveBeenCalledTimes(1);
  await runOwnerHandover(source.ticketId, s.token, { env: ENV, now: s.now, readTicket: customer, relay, continuation });
  expect(continuation).toHaveBeenCalledTimes(1);
});

it("failed workflow start retains grace and can be retried by the same receipt", async () => {
  const e = event(), failing = vi.fn(async () => { throw Error("SYNTHETIC_START_FAILED"); });
  await expect(requestOwnerHandover(e, { env: ENV, start: failing })).rejects.toThrow("SAV_OWNER_HANDOVER_START_FAILED");
  expect(await ownerHandoverGraceOpen(e.objectId)).toBe(true);
  const start = vi.fn(async () => {});
  expect(await requestOwnerHandover(e, { env: ENV, start })).toMatchObject({ status: "scheduled" });
  expect(start).toHaveBeenCalledTimes(1);
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
