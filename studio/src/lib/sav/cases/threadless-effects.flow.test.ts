import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));

import { savCases, savCaseEffectExecutions, savCaseReplyValidations, savIntakeEffects, savIntakeExecutions, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "../intake/execution-policy";
import { savIntakeSourceSnapshot } from "../intake/runtime-store";
import { ingestInboundMessage } from "../service";
import type { AdmissionPolicyRecord } from "./admission-runtime";
import type { CaseReplyProposal } from "./case-effects";
import { decideCaseReply, enqueueApprovedCaseReply } from "./case-reply-store";
import { runCaseEffectsPass } from "./case-runtime-effects";
import { listCaseEvents, readCase, readCaseThreadlessSource } from "./case-store";
import { readCustomerReturnFacts, routeCustomerReturn } from "./customer-return-store";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import { caseInvestigationReturnAwareQualify, caseReturnContentRule } from "./investigation-return-qualify";
import { THREADLESS_ADMIT_PERMISSION, THREADLESS_CRM_PERMISSION, THREADLESS_SEND_PERMISSION } from "./threadless-config";
import { startV2FromThreadlessTicket } from "./threadless-entry";
import { createThreadlessTransport, THREADLESS_MAILBOX } from "./threadless-transport";

const CUSTOMER = "customer@example.invalid";
const NOTE = "Note interne fictive. Contacter autre@example.invalid.";
const OWNER = "810002";
const CONTACT = "610003";
const REVISION = "threadless-effects-fixture";
const RULE = { ruleId: "access-fixture", revision: "synthetic-v1" };
const CODE_REVISION = "a".repeat(40);
const env = () => process.env;
const readTicketOwner = async () => "v2" as const;
const storeDeps = { env, readTicketOwner, currentPolicyRevision: async () => REVISION };
let f: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string;
let staffId: string;
let executionPolicy: ExecutionPolicy;
let grant: Awaited<ReturnType<typeof approveIntakeExecutionPolicy>>;
let seq = 820_000;

beforeAll(async () => {
  f = await createSavTestDb();
  state.db = f.db;
  const [staff] = await f.db.insert(staffUsers).values({
    clerkId: "threadless-fixture", name: "Synthetic reviewer", role: "admin", email: THREADLESS_MAILBOX, active: true,
  }).returning();
  staffId = staff!.id;
  state.user = { id: staff!.clerkId, primaryEmailAddress: { emailAddress: staff!.email, verification: { status: "verified" } } };
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: THREADLESS_MAILBOX, active: true }).returning();
  mailboxId = mailbox!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-threadless-fixture-key-32-characters");
  vi.spyOn(console, "info").mockImplementation(() => {});
  const before = new Date(Date.now() - 60 * 60_000).toISOString();
  const after = new Date(Date.now() + 60 * 60_000).toISOString();
  executionPolicy = {
    revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: CODE_REVISION, enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
    receivedAfter: before, createdAfter: before, expiresAt: after, maxDossiers: 40,
    mutations: [THREADLESS_ADMIT_PERMISSION, THREADLESS_SEND_PERMISSION, THREADLESS_CRM_PERMISSION], admission: { kind: "automatic" },
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
  })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
  const ticketId = String(++seq);
  const observedAt = new Date(Date.now() - 5_000).toISOString();
  const input = { ticketId, ownerTransitionKey: `fixture-owner-${ticketId}`, observedAt };
  const ack = { id: `sent-${ticketId}`, threadId: `gmail-thread-${ticketId}` };
  const crmId = String(seq + 20_000);
  const ticket = { id: ticketId, updatedAt: observedAt,
    properties: { subject: "Impossible de me connecter", content: "Je n’arrive pas à me connecter à mon compte.",
      hubspot_owner_id: OWNER, hs_pipeline: "0", hs_pipeline_stage: "1" } };
  const controls = {
    contacts: [CONTACT], existingCrmEmail: false, loseGmailAck: false, crmUnavailable: false,
    ticketAfterSend: null as "closed" | "unavailable" | null,
  };
  const counts = { crmReads: 0, crmPosts: 0, gmailPosts: 0, gmailSearches: 0, gmailPermissions: 0 };
  let storedCrmProperties: unknown, sentMail: { subject: string; rfcId: string; body: string; at: string } | undefined;
  const network: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "GET") counts.crmReads++;
    const ticketPath = `/crm/v4/objects/tickets/${ticketId}/associations`;
    if (path === `/crm/v3/objects/tickets/${ticketId}`) {
      if (sentMail && controls.ticketAfterSend === "unavailable") return Response.json({}, { status: 503 });
      if (sentMail && controls.ticketAfterSend === "closed")
        return Response.json({ ...ticket, properties: { ...ticket.properties, hs_pipeline_stage: SAV_HUBSPOT_SUPPORT.stages.closed } });
      return Response.json(ticket);
    }
    if (path === `${ticketPath}/emails`) return Response.json({ results: controls.existingCrmEmail ? [{ toObjectId: "740001" }] : [] });
    if (path === `${ticketPath}/contacts`) return Response.json({ results: controls.contacts.map(toObjectId => ({ toObjectId })) });
    if (path === `${ticketPath}/notes`) return Response.json({ results: [{ toObjectId: "123" }] });
    if (path === "/crm/v3/objects/notes/batch/read") return Response.json({ status: "COMPLETE", results: [
      { id: "123", properties: { hs_note_body: NOTE, hs_timestamp: observedAt } },
    ] });
    if (/^\/crm\/v3\/objects\/contacts\/\d+$/.test(path)) return Response.json({ id: path.split("/").at(-1), properties: { email: CUSTOMER } });
    if (path === "/crm/v4/associations/emails/tickets/labels") return Response.json({ results: [{ typeId: 212, category: "HUBSPOT_DEFINED", label: null }] });
    if (path === "/crm/v4/associations/emails/contacts/labels") return Response.json({ results: [{ typeId: 198, category: "HUBSPOT_DEFINED", label: null }] });
    if (path === "/crm/v3/objects/emails" && init?.method === "POST") {
      counts.crmPosts++;
      if (controls.crmUnavailable) return Response.json({}, { status: 503 });
      const request = JSON.parse(String(init.body));
      expect(request.associations.map((link: { to: { id: string } }) => link.to.id)).toEqual([ticketId, CONTACT]);
      storedCrmProperties = request.properties;
      return Response.json({ id: crmId });
    }
    if (path === `/crm/v3/objects/emails/${crmId}`) return Response.json({ id: crmId, properties: storedCrmProperties });
    if (path === `/crm/v4/objects/emails/${crmId}/associations/tickets`) return Response.json({ results: [{ toObjectId: ticketId }] });
    if (path === `/crm/v4/objects/emails/${crmId}/associations/contacts`) return Response.json({ results: [{ toObjectId: CONTACT }] });
    throw Error("UNEXPECTED_SYNTHETIC_HUBSPOT_PATH");
  };
  vi.stubGlobal("fetch", network);
  const gmailRequest: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    expect(mailbox).toBe(THREADLESS_MAILBOX);
    if (path === "messages/send" && init?.method === "POST") {
      counts.gmailPosts++;
      const request = JSON.parse(String(init.body)) as { raw: string };
      expect(Object.keys(request)).toEqual(["raw"]);
      const [head, body] = Buffer.from(request.raw, "base64url").toString("utf8").split("\r\n\r\n");
      expect(head).not.toMatch(/^(?:In-Reply-To|References|Cc|Bcc):/im);
      const headers = head!.replace(/\r\n /g, " ").split("\r\n");
      sentMail = {
        subject: headers.find(line => line.startsWith("Subject: "))!.slice(9),
        rfcId: headers.find(line => line.startsWith("Message-ID: "))!.slice(12),
        body: Buffer.from(body!, "base64").toString("utf8"), at: String(Date.now()),
      };
      if (controls.loseGmailAck) throw Error("SYNTHETIC_GMAIL_ACK_LOST");
      return ack as T;
    }
    if (path.startsWith("messages?")) {
      counts.gmailSearches++;
      expect(init?.method).toBeUndefined();
      const query = new URLSearchParams(path.split("?")[1]);
      expect(query.get("q")).toBe(`in:sent rfc822msgid:${sentMail?.rfcId}`);
      return { messages: sentMail ? [ack] : [] } as T;
    }
    if (path === `messages/${ack.id}?format=full` && sentMail) {
      return { ...ack, internalDate: sentMail.at, labelIds: ["SENT"], payload: {
        mimeType: "text/plain", body: { data: Buffer.from(sentMail.body).toString("base64url") },
        headers: [{ name: "From", value: THREADLESS_MAILBOX }, { name: "To", value: CUSTOMER },
          { name: "Subject", value: sentMail.subject }, { name: "Message-ID", value: sentMail.rfcId }],
      } } as T;
    }
    throw Error("UNEXPECTED_SYNTHETIC_GMAIL_PATH");
  };
  const gmailPermissions = async (mailbox: string) => {
    expect(mailbox).toBe(THREADLESS_MAILBOX);
    counts.gmailPermissions++;
  };
  const transport = createThreadlessTransport({ env, gmailRequest, network });
  const run = (executionId?: string) => runCaseEffectsPass({
    ...storeDeps, executionId, deadlineMs: Date.now() + 30_000, context: { runtime: {} as never, policy: executionPolicy },
    adapters: createIntakeExecutorAdapters({ env, gmailRequest, network, gmailPermissions }),
    threadless: { transport, gmailPermissions },
  });
  return { input, ack, crmId, controls, counts, run, network, sentMail: () => sentMail };
}

async function approveAndQueue(scenario: ReturnType<typeof fixture>) {
  const started = await startV2FromThreadlessTicket(scenario.input);
  expect(started).toMatchObject({ status: "started" });
  if (started.status !== "started") throw Error(`ENTRY_${started.status}`);
  const [validation] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, started.validationId));
  const { payloadHash, caseVersion, recipient, proposalCiphertext } = validation!;
  expect(await decideCaseReply({
    action: "approve", validationId: started.validationId, approverId: staffId, seen: { payloadHash, caseVersion, recipient },
    authorizer: () => ({ allowed: true, basis: "fixture.allow" }), deps: storeDeps,
  })).toMatchObject({ ok: true, state: "approved" });
  const queued = await enqueueApprovedCaseReply({ validationId: started.validationId, policy: { id: grant.id, hash: grant.policyHash }, deps: storeDeps });
  if (!queued.ok) throw Error(`ENQUEUE_${queued.code}`);
  return { ...started, executionId: queued.executionId, proposal: decryptSavPayload<CaseReplyProposal>(proposalCiphertext) };
}

const effects = (id: string) => f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, id));
const threadFor = async (scenario: ReturnType<typeof fixture>) => (await f.db.select().from(savThreads)
  .where(and(eq(savThreads.mailboxId, mailboxId), eq(savThreads.gmailThreadId, scenario.ack.threadId))))[0];
const onlyCase = (ticketId: string) => f.db.select().from(savCases).where(eq(savCases.ticketId, ticketId));
// Expire the test scheduler delay without clearing a marker, receipt, or attempt count.
const makeReadsDue = (id: string) => f.db.update(savIntakeEffects).set({ nextReconcileAt: new Date(Date.now() - 1000) })
  .where(eq(savIntakeEffects.executionId, id));

describe("SAV-96 new Gmail thread through entry, approval, effect and inbound return", () => {
  it.each(["closed", "unavailable"] as const)("lets the fourth CRM log progress behind three %s tickets", async status => {
    const oldest = Date.now() - (status === "closed" ? 60_000 : 120_000);
    const createPendingLog = async (position: number) => {
      const scenario = fixture(), start = await approveAndQueue(scenario);
      scenario.controls.ticketAfterSend = "unavailable";
      expect((await scenario.run(start.executionId)).supervised).toMatchObject([{ state: "waiting", reason: "new_thread_crm_pending" }]);
      const updatedAt = new Date(oldest + position * 1_000);
      await f.db.update(savCaseEffectExecutions).set({ updatedAt }).where(eq(savCaseEffectExecutions.id, start.executionId));
      return { scenario, start, updatedAt };
    };
    const first = await createPendingLog(0);
    const second = await createPendingLog(1);
    const third = await createPendingLog(2);
    const { scenario: healthy, start: healthyStart } = await createPendingLog(3);
    const blocked = [first, second, third];
    for (const { scenario } of blocked) scenario.controls.ticketAfterSend = status;
    healthy.controls.ticketAfterSend = null;
    const network: typeof fetch = (url, init) => {
      const ticketId = new URL(String(url)).pathname.match(/\/tickets\/(\d+)(?:\/|$)/)?.[1];
      const stalled = blocked.find(({ scenario }) => scenario.input.ticketId === ticketId);
      return (stalled?.scenario.network ?? healthy.network)(url, init);
    };
    vi.stubGlobal("fetch", network);

    const firstPass = (await healthy.run()).supervised;
    expect(firstPass.map(row => row.executionId)).toEqual(blocked.map(({ start }) => start.executionId));
    expect(healthy.counts.crmPosts).toBe(0);
    const secondPass = (await healthy.run()).supervised;
    expect(secondPass[0]).toEqual({ executionId: healthyStart.executionId, state: "confirmed", reason: null });
    expect(healthy.counts).toMatchObject({ gmailPosts: 1, crmPosts: 1 });
    if (status === "closed") {
      const selectedIds = secondPass.map(row => row.executionId);
      for (const { start } of blocked) expect(selectedIds).not.toContain(start.executionId);
    }

    for (const { scenario, start, updatedAt } of blocked) {
      expect(firstPass.find(row => row.executionId === start.executionId)).toMatchObject(status === "closed"
        ? { state: "refused", reason: "crm_skipped_ticket_closed" }
        : { state: "waiting", reason: "new_thread_crm_pending" });
      const [execution] = await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, start.executionId));
      expect(execution!.updatedAt.getTime()).toBeGreaterThan(updatedAt.getTime());
      expect(await effects(start.executionId)).toMatchObject([{ kind: "new_thread_send", state: "confirmed" }]);
      expect(await threadFor(scenario)).toMatchObject({ hubspotTicketId: scenario.input.ticketId });
      expect(scenario.counts).toMatchObject({ gmailPosts: 1, crmPosts: 0 });
    }
  });

  it("confirms only the approved mail, links it to the CRM ticket and lets V1 and V2 recognise the actual customer reply", async () => {
    const s = fixture(), start = await approveAndQueue(s);
    const before = await readCase(start.caseId);
    expect(before).toMatchObject({ owner: "agent", phase: "queued", threadIds: [] });
    expect(await threadFor(s)).toBeUndefined();
    const source = await readCaseThreadlessSource(f.db, start.caseId);
    expect(source?.source).toMatchObject({ kind: "hubspot_ticket", contact: { id: CONTACT, email: CUSTOMER }, notes: [{ body: NOTE }] });
    expect((await listCaseEvents(start.caseId)).some(event => event.kind === "inbound_confirmed")).toBe(false);

    expect((await s.run(start.executionId)).supervised).toMatchObject([{ state: "confirmed" }]);
    expect(s.counts).toMatchObject({ gmailPosts: 1, gmailPermissions: 1, crmPosts: 1 });
    expect((await effects(start.executionId)).map(row => [row.kind, row.permission, row.state]).sort()).toEqual([
      ["new_thread_crm_email", THREADLESS_CRM_PERMISSION, "confirmed"], ["new_thread_send", THREADLESS_SEND_PERMISSION, "confirmed"],
    ]);
    const thread = await threadFor(s);
    expect(thread).toMatchObject({ hubspotTicketId: s.input.ticketId, customerEmail: CUSTOMER, status: "awaiting_customer" });
    const [message] = await f.db.select().from(savMessages).where(eq(savMessages.threadId, thread!.id));
    expect(message).toMatchObject({ direction: "outbound", gmailMessageId: s.ack.id, hubspotEmailId: s.crmId, fromEmail: THREADLESS_MAILBOX, toEmails: [CUSTOMER] });
    expect(decryptSavPayload<{ text: string }>(message!.bodyCiphertext).text).toBe(s.sentMail()!.body);
    expect(s.sentMail()!.body).toBe(start.proposal.text);
    expect(s.sentMail()!.body).not.toContain(NOTE);
    expect(await readCase(start.caseId)).toMatchObject({ threadIds: [thread!.id], phase: "awaiting_customer" });
    expect(await f.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.ticketId, s.input.ticketId))).toEqual([]);

    const inbound = await ingestInboundMessage({
      mailboxEmail: THREADLESS_MAILBOX, gmailThreadId: s.ack.threadId, gmailMessageId: `inbound-${s.input.ticketId}`,
      from: CUSTOMER, to: [THREADLESS_MAILBOX], subject: `Re: ${message!.subject}`, bodyText: "Je n’arrive toujours pas à me connecter à mon compte.",
      headers: { "message-id": "<inbound@example.invalid>", "in-reply-to": s.sentMail()!.rfcId }, receivedAt: new Date(),
    }, "gmail_full");
    expect(inbound.message.threadId).toBe(thread!.id);
    const v1 = await savIntakeSourceSnapshot(f.db, inbound.message, new Date());
    expect(v1.threadTicketId).toBe(s.input.ticketId);
    expect(v1.input.conversation.data.map(mail => mail.direction)).toEqual(["outbound", "inbound"]);
    expect(await readCustomerReturnFacts(inbound.message.id, { env: env() })).toMatchObject({ case: { caseId: start.caseId }, facts: { link: "one_case" } });
    expect(await routeCustomerReturn(inbound.message.id, { env: env(), readTicketOwner: async () => OWNER }))
      .toMatchObject({ route: { route: "continue" }, caseId: start.caseId, written: true });
    const qualifyReturn = caseInvestigationReturnAwareQualify(async () => { throw Error("V1_FALLBACK_FORBIDDEN"); }, {
      readPolicyRecord: async () => JSON.parse(env().SAV_V2_ADMISSION_POLICY_JSON!) as AdmissionPolicyRecord,
      now: () => new Date(), returnRules: caseReturnContentRule(RULE, () => new Date()),
    });
    expect(await qualifyReturn((await readCase(start.caseId))!, await listCaseEvents(start.caseId))).toMatchObject({
      admission: { qualification: { identity: { status: "confirmed", source: { type: "hubspot_object", id: s.input.ticketId } }, crmContext: "complete",
        requests: [{ family: "access", provenance: { kind: "qualified_rule", ...RULE } }] } },
    });
    expect(await onlyCase(s.input.ticketId)).toHaveLength(1);
  });

  it("hands the case to a person if the associated contact changes even when the address stays unchanged", async () => {
    const s = fixture(), start = await approveAndQueue(s);
    s.controls.contacts = ["610004"];
    expect((await s.run(start.executionId)).supervised).toMatchObject([{ state: "refused", reason: "threadless_source_changed" }]);
    expect(await readCase(start.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending", threadIds: [] });
    expect(await effects(start.executionId)).toEqual([]);
    expect(s.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0, gmailPermissions: 1 });
  });

  it("recovers a lost Gmail ACK through its Message-ID and sends exactly once", async () => {
    const s = fixture(), start = await approveAndQueue(s);
    s.controls.loseGmailAck = true;
    expect((await s.run(start.executionId)).supervised).toMatchObject([{ state: "confirmed" }]);
    const mail = (await effects(start.executionId)).find(row => row.kind === "new_thread_send");
    expect(mail?.state).toBe("confirmed");
    expect(decryptSavPayload(mail!.verificationCiphertext!)).toMatchObject(s.ack);
    await s.run(start.executionId);
    expect(s.counts).toMatchObject({ gmailPosts: 1, gmailSearches: 1, crmPosts: 1 });
  });

  it("recovers after a failed local receipt transaction, without a second send or a partial ticket link", async () => {
    const s = fixture(), start = await approveAndQueue(s);
    // Induce a local write conflict after the provider accepted the mail.
    const [unlinked] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: s.ack.threadId, customerEmail: CUSTOMER }).returning();
    const [conflicting] = await f.db.insert(savMessages).values({
      threadId: unlinked!.id, mailboxId, gmailMessageId: s.ack.id, direction: "inbound", fromEmail: CUSTOMER,
      bodyCiphertext: encryptSavPayload({ text: "Synthetic conflict." }), receivedAt: new Date(),
    }).returning();
    await s.run(start.executionId);
    expect((await effects(start.executionId)).map(row => [row.state, Boolean(row.ackCiphertext)])).toEqual([["uncertain", true]]);
    expect((await threadFor(s))?.hubspotTicketId).toBeNull();
    expect((await readCase(start.caseId))?.threadIds).toEqual([]);
    expect(s.counts).toMatchObject({ gmailPosts: 1, crmPosts: 0 });

    await f.db.delete(savMessages).where(eq(savMessages.id, conflicting!.id));
    await makeReadsDue(start.executionId);
    vi.stubEnv("SAV_V2_NEW_THREAD", "off");
    await s.run();
    expect((await threadFor(s))?.hubspotTicketId).toBe(s.input.ticketId);
    expect((await readCase(start.caseId))?.threadIds).toEqual([unlinked!.id]);
    expect(s.counts).toMatchObject({ gmailPosts: 1, crmPosts: 0 });
    vi.stubEnv("SAV_V2_NEW_THREAD", "on");
    await s.run(start.executionId);
    expect(s.counts).toMatchObject({ gmailPosts: 1, gmailSearches: 2, crmPosts: 1 });
  });

  it("records a human wait with no proposal when the ticket has multiple contacts", async () => {
    const s = fixture();
    s.controls.contacts = [CONTACT, "610004"];
    const started = await startV2FromThreadlessTicket(s.input);
    expect(started).toMatchObject({ status: "human_wait", reason: "multiple_contacts" });
    const [row] = await onlyCase(s.input.ticketId);
    expect(await readCase(row!.id)).toMatchObject({ owner: "human", phase: "handoff_pending", threadIds: [],
      body: { waiting: { kind: "team", reasonCode: "multiple_contacts" } } });
    expect(await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, row!.id))).toEqual([]);
    expect(s.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0 });
  });

  it("requires its own signed send right even when ordinary replies are granted", async () => {
    grant = await approveIntakeExecutionPolicy({
      ...executionPolicy, mutations: [THREADLESS_ADMIT_PERMISSION, "send_case_reply", THREADLESS_CRM_PERMISSION],
    });
    vi.stubEnv("SAV_INTAKE_EXECUTION_POLICY_ID", grant.id);
    vi.stubEnv("SAV_INTAKE_EXECUTION_POLICY_SHA256", grant.policyHash);
    const s = fixture(), start = await approveAndQueue(s);
    expect((await s.run(start.executionId)).supervised).toMatchObject([{ state: "waiting", reason: "threadless_authority_unavailable" }]);
    expect(await effects(start.executionId)).toEqual([]);
    expect(s.counts).toMatchObject({ gmailPermissions: 0, gmailPosts: 0, crmPosts: 0 });
  });

  it("keeps the Gmail result and local link when CRM is unavailable, with separate verification only", async () => {
    const s = fixture(), start = await approveAndQueue(s);
    s.controls.crmUnavailable = true;
    await s.run(start.executionId);
    expect((await effects(start.executionId)).map(row => [row.kind, row.state]).sort()).toEqual([
      ["new_thread_crm_email", "uncertain"], ["new_thread_send", "confirmed"],
    ]);
    expect((await threadFor(s))?.hubspotTicketId).toBe(s.input.ticketId);
    const gmailSearches = s.counts.gmailSearches;
    s.controls.crmUnavailable = false;
    await makeReadsDue(start.executionId);
    await s.run(start.executionId);
    expect(s.counts).toMatchObject({ gmailPosts: 1, gmailSearches, crmPosts: 1 });
    const crm = (await effects(start.executionId)).find(row => row.kind === "new_thread_crm_email");
    expect(crm).toMatchObject({ state: "uncertain", reconcileAttempts: 2 });
  });

  it("returns early for an existing local or CRM association without opening a threadless case", async () => {
    const s = fixture();
    await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: "existing-local-thread", hubspotTicketId: s.input.ticketId, customerEmail: CUSTOMER });
    expect(await startV2FromThreadlessTicket(s.input)).toEqual({ status: "existing_thread" });
    expect(s.counts.crmReads).toBe(0);
    expect(await onlyCase(s.input.ticketId)).toEqual([]);
    const crm = fixture();
    crm.controls.existingCrmEmail = true;
    expect(await startV2FromThreadlessTicket(crm.input)).toEqual({ status: "existing_thread" });
    expect(await onlyCase(crm.input.ticketId)).toEqual([]);
    expect(crm.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0 });
  });

  it("with the feature off, reads no CRM input, opens no case and leaves an existing approved queue entry idle", async () => {
    const queued = fixture(), start = await approveAndQueue(queued);
    const off = fixture();
    vi.stubEnv("SAV_V2_NEW_THREAD", undefined);
    expect(await startV2FromThreadlessTicket(off.input)).toEqual({ status: "off" });
    expect(off.counts).toMatchObject({ crmReads: 0, gmailPosts: 0, crmPosts: 0 });
    expect(await onlyCase(off.input.ticketId)).toEqual([]);
    expect((await queued.run(start.executionId)).supervised).toEqual([]);
    expect(await effects(start.executionId)).toEqual([]);
    expect(queued.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0 });
  });
});

describe("SAV-123 (N8): the central hold before N8 is gone", () => {
  it("an approved first mail already queued is sent under SAV_V2_ENTRY_SMART=on exactly as with the switch off (a person approved it)", async () => {
    const s = fixture(), start = await approveAndQueue(s);
    vi.stubEnv("SAV_V2_ENTRY_SMART", "on");
    expect((await s.run(start.executionId)).supervised).toMatchObject([{ state: "confirmed" }]);
    expect(s.counts).toMatchObject({ gmailPosts: 1, crmPosts: 1 });
  });
});
