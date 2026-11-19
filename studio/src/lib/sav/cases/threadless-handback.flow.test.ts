// SAV-99 (Ugo 19/11): a ticket a person gave the Agent SAV, without any mail. The HubSpot category never decides; the content does (taken when it is an
// Access request, to the team when it is sensitive). Real entry and case store on PGlite; only HubSpot is a fake (any write or Gmail call fails the test).
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));

import { savCases, savCaseEffectExecutions, savCaseReplyValidations, savIntakeEffects, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import type { EffectIntent } from "../intake/execution-types";
import { enqueueHandoffNotices, runHandoffNoticePass } from "./case-handoff-notice-store";
import { enqueueHandoffStages } from "./case-handoff-stage";
import { SAV_CASE_EFFECT_PERMISSIONS } from "./case-effects";
import { runCaseTicketStagePass } from "./case-ticket-stage-store";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "../intake/execution-policy";
import { readCase } from "./case-store";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import { THREADLESS_ADMIT_PERMISSION, THREADLESS_CRM_PERMISSION, THREADLESS_SEND_PERMISSION } from "./threadless-config";
import { handBackOwnerHandoverTicket, startV2FromThreadlessTicket } from "./threadless-entry";
import { THREADLESS_MAILBOX } from "./threadless-transport";

const CUSTOMER = "customer@example.invalid";
const OWNER = "810102";
const CONTACT = "610103";
const REVISION = "threadless-handback-fixture";
const RULE = { ruleId: "access-fixture", revision: "synthetic-v1" };
const CODE_REVISION = "a".repeat(40);
const ACCESS_CONTENT = { subject: "Impossible de me connecter", content: "Je n’arrive pas à me connecter à mon compte." };
let f: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string;
let staffId: string;
let executionPolicy: ExecutionPolicy;
let grant: Awaited<ReturnType<typeof approveIntakeExecutionPolicy>>;
let seq = 830_000;

beforeAll(async () => {
  f = await createSavTestDb();
  state.db = f.db;
  const [staff] = await f.db.insert(staffUsers).values({ clerkId: "threadless-handback", name: "Synthetic reviewer", role: "admin", email: THREADLESS_MAILBOX, active: true }).returning();
  staffId = staff!.id;
  state.user = { id: staff!.clerkId, primaryEmailAddress: { emailAddress: staff!.email, verification: { status: "verified" } } };
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: THREADLESS_MAILBOX, active: true }).returning();
  mailboxId = mailbox!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-threadless-handback-key-32-characters");
  vi.spyOn(console, "info").mockImplementation(() => {});
  const before = new Date(Date.now() - 60 * 60_000).toISOString();
  const after = new Date(Date.now() + 60 * 60_000).toISOString();
  executionPolicy = {
    revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: CODE_REVISION, enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
    receivedAfter: before, createdAfter: before, expiresAt: after, maxDossiers: 40,
    mutations: [THREADLESS_ADMIT_PERMISSION, THREADLESS_SEND_PERMISSION, THREADLESS_CRM_PERMISSION,
      SAV_CASE_EFFECT_PERMISSIONS.stage, SAV_CASE_EFFECT_PERMISSIONS.note, SAV_CASE_EFFECT_PERMISSIONS.handoff],
    admission: { kind: "automatic" },
  };
  grant = await approveIntakeExecutionPolicy(executionPolicy);
  const entryRule = { ...RULE, family: "access", v1Kind: "support", at: before };
  const admission = { revision: REVISION, admittedFamilies: ["access"], approvedBy: staffId, approvedAt: before,
    qualifiedRules: [{ ruleId: entryRule.ruleId, revision: entryRule.revision, families: ["access"] }] };
  for (const [key, value] of Object.entries({
    SAV_V2_NEW_THREAD: "on", SAV_CASE_RECORDING: "on", SAV_V2_ENTRY: "on", SAV_CASE_EFFECTS: "supervised",
    SAV_V2_HUBSPOT_OWNER_ID: OWNER, HUBSPOT_ACCESS_TOKEN: "synthetic",
    SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([entryRule]),
    SAV_V2_ADMISSION_POLICY_JSON: JSON.stringify({ policy: admission, validFrom: before, validUntil: after }),
    SAV_V2_ACCESS_SCOPE_JSON: JSON.stringify({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: REVISION, revision: "fixture-access-scope",
      family: "access", sources: [{ knowledgeId: "fixture-knowledge", contentVersionId: "fixture-version", use: "answer" }] }),
    SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash,
    SAV_CODE_REVISION: CODE_REVISION, VERCEL_GIT_COMMIT_SHA: undefined, SAV_V2_SCOPE_MODE: undefined, SAV_V2_QUALIFICATION_SCOPE_JSON: undefined,
    SAV_TEST_MODE: "false", SAV_WRITES_DISABLED: "false", SAV_INTAKE_EXECUTION_KILL_SWITCH: "0",
    // The hand-back (SAV-99): the existing hand-over stage, its note and the Slack hand-over notice, under their own switches.
    SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "5", SAV_V2_STAGE_CLOSED: "4", SAV_V2_HANDOFF_STAGE: "on", SAV_V2_REPLY_NOTE: "on",
    SAV_HANDOFF_NOTICE: "on", SAV_HANDOFF_SLACK_BOT_TOKEN: "xoxb-" + "TEST".repeat(4), SAV_HANDOFF_SLACK_CHANNEL_ID: "CSYNCHANNEL1",
  })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A ticket without any mail, given to the Agent SAV, with this content and this (possibly wrong) category. */
function ticket(content: { subject: string; content: string }, category: string, contacts: string[] = [CONTACT], options: { mails?: number; stage?: string } = {}) {
  const ticketId = String(++seq);
  const observedAt = new Date(Date.now() - 5_000).toISOString();
  const input = { ticketId, ownerTransitionKey: `fixture-owner-${ticketId}`, observedAt };
  const record = { id: ticketId, updatedAt: observedAt,
    properties: { ...content, hubspot_owner_id: OWNER as string | null, hs_pipeline: "0", hs_pipeline_stage: options.stage ?? SAV_HUBSPOT_SUPPORT.stages.new, hs_ticket_category: category } };
  const counts = { gmail: 0, writes: 0, stageWrites: [] as unknown[] };
  vi.stubGlobal("fetch", (async (url, init) => {
    const path = new URL(String(url)).pathname;
    // SAV-99: the hand-over stage's one write (its own adapter): stage « Nouveau », owner cleared.
    if (init?.method === "PATCH" && path === `/crm/v3/objects/tickets/${ticketId}`) {
      const { properties } = JSON.parse(String(init.body)) as { properties: Record<string, string> };
      counts.stageWrites.push(properties);
      // HubSpot reads a cleared owner back as null.
      Object.assign(record.properties, properties, properties.hubspot_owner_id === "" ? { hubspot_owner_id: null } : {});
      return Response.json({ id: ticketId, properties: record.properties });
    }
    if ((init?.method ?? "GET") !== "GET" && path !== "/crm/v3/objects/notes/batch/read") { counts.writes++; throw Error("UNEXPECTED_SYNTHETIC_WRITE"); }
    if (/gmail/.test(String(url))) { counts.gmail++; throw Error("UNEXPECTED_SYNTHETIC_GMAIL"); }
    const associations = `/crm/v4/objects/tickets/${ticketId}/associations`;
    if (path === `/crm/v3/objects/tickets/${ticketId}`) return Response.json(record);
    if (path === `${associations}/emails`) return Response.json({ results: Array.from({ length: options.mails ?? 0 }, (_, i) => ({ toObjectId: 700 + i })) });
    if (path === `${associations}/contacts`) return Response.json({ results: contacts.map(toObjectId => ({ toObjectId })) });
    if (path === `${associations}/notes`) return Response.json({ results: [] });
    if (/^\/crm\/v3\/objects\/contacts\/\d+$/.test(path)) return Response.json({ id: path.split("/").at(-1), properties: { email: CUSTOMER } });
    throw Error(`UNEXPECTED_SYNTHETIC_HUBSPOT_PATH ${path}`);
  }) as typeof fetch);
  return { input, counts, record };
}

/** The wake's hand-back steps, on the canonical stage and notice passes; only HubSpot notes and Slack are fakes (each call recorded). */
async function runHandBack(owner: () => "v2" | "human" | "none", ticketId: string) {
  const policy = { id: grant.id, hash: grant.policyHash }, env = () => process.env, since = new Date(Date.now() - 3_600_000), context = { runtime: {} as never, policy: executionPolicy };
  const notes: EffectIntent[] = [], slack: EffectIntent[] = [];
  const confirmed = async (_intent: EffectIntent, ack: { id?: string } | null) => ({ confirmed: true, attributed: true, ack: ack ?? undefined });
  const hubspotNotes = { dispatch: async (intent: EffectIntent) => { notes.push(intent); return { id: String(900_000 + notes.length) }; }, verify: confirmed };
  const stageQueue = await enqueueHandoffStages({ policy, env, since });
  const stage = await runCaseTicketStagePass({ env, network: fetch, deadlineMs: Date.now() + 60_000, readTicketOwner: async () => owner(), context, hubspotNotes,
    schemaInstalled: async () => true, limit: 5 });
  const noticeQueue = await enqueueHandoffNotices({ policy, env, since });
  const notice = await runHandoffNoticePass({ env, network: fetch, deadlineMs: Date.now() + 60_000, context, schemaInstalled: async () => true, limit: 5,
    crm: async () => ({ ticket: null, contacts: [] }),
    adapters: { dispatch: async (intent: EffectIntent) => { slack.push(intent); return { id: `ts-${slack.length}`, channel: "CSYNCHANNEL1" }; }, verify: confirmed } });
  // The sweeps also give back the team cases of the tests above: only this ticket's calls are looked at.
  const mine = (intent: EffectIntent) => intent.ticketId === ticketId || JSON.stringify(intent).includes(`/${ticketId}`);
  return { stageQueue, stage, noticeQueue, notice, notes: notes.filter(mine), slack: slack.filter(mine) };
}

const caseOf = async (ticketId: string) => (await f.db.select().from(savCases).where(eq(savCases.ticketId, ticketId)))[0];
const executionsOf = (caseId: string) => f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, caseId));

describe("SAV-99: an assigned ticket without mail, the category never decides", () => {
  it.each([SAV_HUBSPOT_SUPPORT.categories.technical, SAV_HUBSPOT_SUPPORT.categories.other, ""])("Access content with the wrong category %j: the agent takes it", async category => {
    const s = ticket(ACCESS_CONTENT, category);
    expect(await startV2FromThreadlessTicket(s.input)).toMatchObject({ status: "started" });
    const row = await caseOf(s.input.ticketId);
    expect(await readCase(row!.id)).toMatchObject({ owner: "agent", phase: "queued" });
    expect(s.counts).toMatchObject({ gmail: 0, writes: 0 });
  });

  it.each([
    ["résiliation", { subject: "Résiliation", content: "Je veux résilier mon abonnement et je n'arrive plus à me connecter." }],
    ["facturation", { subject: "Remboursement", content: "Je demande le remboursement de ma dernière facture, je n'arrive plus à me connecter." }],
  ])("sensitive content (%s) with the category « Acces »: a team case, never taken, no mail, once", async (_topic, content) => {
    const s = ticket(content, SAV_HUBSPOT_SUPPORT.categories.access);
    expect(await startV2FromThreadlessTicket(s.input)).toMatchObject({ status: "human_wait", reason: "sensitive_request" });
    const row = await caseOf(s.input.ticketId);
    expect(await readCase(row!.id)).toMatchObject({ owner: "human", phase: "handoff_pending", threadIds: [] });
    // The poll replayed: the same case, nothing more.
    expect(await startV2FromThreadlessTicket(s.input)).toMatchObject({ status: "existing_case" });
    expect(await f.db.select().from(savCases).where(eq(savCases.ticketId, s.input.ticketId))).toHaveLength(1);
    expect(await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, row!.id))).toEqual([]);
    expect(await executionsOf(row!.id)).toEqual([]);
    expect(s.counts).toMatchObject({ gmail: 0, writes: 0 });
  });

  it("content outside Access with the category « Acces »: given back to the team ONCE (note, « Nouveau » with no owner, Slack), never a mail", async () => {
    const s = ticket({ subject: "Export de mes contacts", content: "Comment exporter la liste de mes contacts au format CSV ?" }, SAV_HUBSPOT_SUPPORT.categories.access);
    expect(await startV2FromThreadlessTicket(s.input)).toMatchObject({ status: "human_wait", reason: "no_block_match" });
    const row = await caseOf(s.input.ticketId);
    expect(await readCase(row!.id)).toMatchObject({ owner: "human", phase: "handoff_pending", threadIds: [], body: { handoff: { reason: "no_block_match" } } });
    let owner: "v2" | "none" = "v2";
    const first = await runHandBack(() => owner, s.input.ticketId);
    // The note BEFORE the stage (the stage removes the V2 owner every write needs), then the stage: « Nouveau », owner cleared.
    expect(first.notes.map(intent => intent.kind)).toEqual(["note_create", "note_associate"]);
    const noteText = JSON.stringify(first.notes[0]);
    expect(noteText).toContain("Ticket attribué à l'Agent SAV mais non pris en charge");
    expect(noteText).toContain("Aucun mail envoyé au client");
    expect(noteText).not.toContain("CSV");
    expect(s.counts.stageWrites).toEqual([{ hs_pipeline_stage: SAV_HUBSPOT_SUPPORT.stages.new, hubspot_owner_id: "" }]);
    owner = "none";
    // The Slack hand-over notice, once, its own fixed reason; no second HubSpot note from the notice.
    expect(first.slack).toHaveLength(1);
    const posted = JSON.stringify(first.slack[0]);
    expect(posted).toContain("ticket attribué à l'agent, qui ne l'a pas pris en charge");
    expect(posted).toContain("Aucun mail n'a été envoyé au client");
    expect(posted).not.toContain("CSV");
    const executions = await executionsOf(row!.id);
    expect(executions.map(execution => [execution.replyKey.split(":")[0], execution.threadId, execution.state]).sort()).toEqual([["case-stage", null, "confirmed"], ["handoff-notice", null, "confirmed"]]);
    // Replays (the poll, the wake): nothing new anywhere.
    expect(await startV2FromThreadlessTicket(s.input)).toMatchObject({ status: "owner_changed" });
    const again = await runHandBack(() => owner, s.input.ticketId);
    expect([again.notes, again.slack, s.counts.stageWrites.length]).toEqual([[], [], 1]);
    expect(await executionsOf(row!.id)).toHaveLength(2);
    expect(await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.kind, "new_thread_send"))).toEqual([]);
    expect(await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, row!.id))).toEqual([]);
    expect([s.counts.gmail, s.counts.writes]).toEqual([0, 0]);
  });

  it("a ticket WITH a mail the agent does not take (linked thread, sensitive...) is handed back the same way, once, with no mail", async () => {
    const s = ticket(ACCESS_CONTENT, SAV_HUBSPOT_SUPPORT.categories.access, [CONTACT], { mails: 1, stage: SAV_HUBSPOT_SUPPORT.stages.awaitingContact });
    const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `gmail-${s.input.ticketId}`, customerEmail: CUSTOMER, hubspotTicketId: s.input.ticketId }).returning();
    await f.db.insert(savMessages).values({ threadId: thread!.id, mailboxId, direction: "inbound", gmailMessageId: `m-${s.input.ticketId}`, fromEmail: CUSTOMER, toEmails: [THREADLESS_MAILBOX],
      receivedAt: new Date(), bodyCiphertext: encryptSavPayload({ text: "Je veux résilier." }) });
    // The entry itself never takes a ticket with mail.
    expect(await startV2FromThreadlessTicket(s.input)).toEqual({ status: "existing_thread" });
    expect(await handBackOwnerHandoverTicket(s.input, "sensitive_request")).toMatchObject({ status: "human_wait", reason: "sensitive_request" });
    expect(await handBackOwnerHandoverTicket(s.input, "sensitive_request")).toEqual({ status: "existing_case" });
    const row = await caseOf(s.input.ticketId);
    expect(await readCase(row!.id)).toMatchObject({ owner: "human", phase: "handoff_pending", threadIds: [] });
    let owner: "v2" | "none" = "v2";
    const done = await runHandBack(() => owner, s.input.ticketId);
    owner = "none";
    expect(done.notes.map(intent => intent.kind)).toEqual(["note_create", "note_associate"]);
    expect(JSON.stringify(done.notes[0])).toContain("demande sensible");
    expect(s.counts.stageWrites).toEqual([{ hs_pipeline_stage: SAV_HUBSPOT_SUPPORT.stages.new, hubspot_owner_id: "" }]);
    expect(done.slack).toHaveLength(1);
    const again = await runHandBack(() => owner, s.input.ticketId);
    expect([again.notes, again.slack, s.counts.stageWrites.length]).toEqual([[], [], 1]);
    expect([s.counts.gmail, s.counts.writes]).toEqual([0, 0]);
  });

  it("a ticket the V2 owner no longer holds (a person took it back) is never moved: the stage holds, nothing is written", async () => {
    const s = ticket({ subject: "Export", content: "Comment exporter mes contacts ?" }, "");
    expect(await startV2FromThreadlessTicket(s.input)).toMatchObject({ status: "human_wait" });
    s.record.properties.hubspot_owner_id = "999";
    const done = await runHandBack(() => "human", s.input.ticketId);
    expect([done.notes, s.counts.stageWrites]).toEqual([[], []]);
  });
});
