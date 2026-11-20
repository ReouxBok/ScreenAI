/*
 * SAV-117 review P1B (finding 1), SYNTHETIC only: the harness of `owner-handover.test.ts` (real stores on PGlite, HubSpot and Gmail transports simulated, the
 * hand-back permission granted). Under `SAV_V2_ENTRY_SMART=on`, a ticket a person gave the agent, with its linked mail, is read by the smart entry: before N8 it
 * waits (`owner_handover_smart_pending`). Proven: 0 hand-back, 0 HubSpot write (every CRM call is a read), 0 Gmail send, no case recorded.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import {
  savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages,
  savSyncState, savThreads, savWebhookReceipts, staffUsers,
} from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import type { ExecutionPolicy } from "../intake/execution-policy";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { readCaseByTicket } from "./case-store";
import type { CaseBoundaryDeps } from "./intake-boundary";
import { runSavOwnerHandover } from "./owner-handover";
import { smartSupportProvenance } from "./smart-entry-switch";
import {
  OWNER_HANDOVER_DELAY_MS, observeSavOwnerHandoverEvents, type OwnerHandoverTransition,
} from "./owner-handover-markers";

const fixture = vi.hoisted(() => ({
  db: null as unknown,
  after: [] as Array<() => Promise<unknown>>,
  refresh: vi.fn(),
  start: vi.fn<(_workflow: unknown, args: [OwnerHandoverTransition, string]) => Promise<unknown>>(),
  gmail: vi.fn(),
  continueCase: vi.fn(),
  threadless: vi.fn(),
  handBack: vi.fn(),
  blockEvidence: vi.fn(),
  relayDeps: {} as CaseBoundaryDeps,
}));
vi.mock("@/db", () => ({ requireDb: () => fixture.db }));
vi.mock("next/server", async original => ({
  ...await original<typeof import("next/server")>(), after: (callback: () => Promise<unknown>) => fixture.after.push(callback),
}));
vi.mock("workflow/api", () => ({ start: fixture.start }));
vi.mock("../observations", async original => ({
  ...await original<typeof import("../observations")>(), hasSavTicketObservation: async () => true,
  refreshSavTicketObservations: fixture.refresh,
}));
vi.mock("../gmail", async original => ({ ...await original<typeof import("../gmail")>(), requestSavGmail: fixture.gmail }));
vi.mock("./v2-entry", async original => ({
  ...await original<typeof import("./v2-entry")>(), v2EntryRelayDeps: () => fixture.relayDeps, continueCaseAfterCommit: fixture.continueCase,
  firstBlockEvidence: fixture.blockEvidence,
}));
// The hand-back itself (team case, stage, note, Slack) is the flow of threadless-handback.flow.test.ts; here only who is handed back, why, and once.
vi.mock("./threadless-entry", async original => {
  const { startV2FromThreadlessTicket } = await original<typeof import("./threadless-entry")>();
  return { startV2FromThreadlessTicket: fixture.threadless.mockImplementation(startV2FromThreadlessTicket), handBackOwnerHandoverTicket: fixture.handBack };
});

const MAILBOX = "contact@limova.ai", CLIENT = "client@example.invalid";
const SETTLED_EVENT_AT = Date.now() - OWNER_HANDOVER_DELAY_MS - 1_000;
const INBOUND_AT = SETTLED_EVENT_AT - 3_600_000;
const DUE = SETTLED_EVENT_AT + OWNER_HANDOVER_DELAY_MS;
const OWNER = "7001";
const CODE_REVISION = "a".repeat(40), SECRET = "synthetic-webhook-secret";
const URL = "https://studio.example.invalid/api/webhooks/hubspot";
const PORTAL = Number(SAV_HUBSPOT_SUPPORT.portalId);
const ACCESS = SAV_HUBSPOT_SUPPORT.categories.access;

let database: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string, administratorId: string, policyId: string, policyHash: string;
let nextTicket = Date.now() * 100;
const testTickets = new Set<string>();

function ownerEvent(ticketId: string, options: { at?: number; owner?: string; source?: string; portal?: number } = {}) {
  testTickets.add(ticketId);
  return {
    subscriptionType: "ticket.propertyChange", propertyName: "hubspot_owner_id", objectId: ticketId,
    occurredAt: options.at ?? SETTLED_EVENT_AT, propertyValue: options.owner ?? OWNER, changeSource: options.source ?? "CRM_UI",
    portalId: options.portal ?? PORTAL,
  };
}

function liveTicket(ticketId: string, options: {
  at?: number; owner?: string; stage?: string; category?: string; categoryOnRecheck?: string; source?: string;
  emailBatch?: { id: string; properties: { hs_timestamp: string | null; hs_email_direction: string } }[];
  paginateEmails?: boolean;
  conversations?: { active?: unknown[]; archived?: unknown[] };
  crmDenied?: boolean;
  /** SAV-99: the ticket's one contact (manual handover of a mail V1 never executed). */
  contact?: string;
} = {}) {
  const owner = options.owner ?? OWNER, at = options.at ?? SETTLED_EVENT_AT;
  let ticketReads = 0;
  const read = vi.fn(async (url: string, init?: RequestInit) => {
    const request = new globalThis.URL(url);
    if (request.pathname === `/crm/v4/objects/tickets/${ticketId}/associations/emails`) {
      expect(init?.method ?? "GET").toBe("GET");
      if (options.crmDenied) return Response.json({}, { status: 403 });
      const results = options.emailBatch?.map(email => ({ toObjectId: Number(email.id) })) ?? [];
      if (options.paginateEmails) {
        if (!request.searchParams.has("after")) return Response.json({ results: results.slice(0, 1), paging: { next: { after: "next" } } });
        expect(request.searchParams.get("after")).toBe("next");
        return Response.json({ results: results.slice(1) });
      }
      return Response.json({ results });
    }
    if (request.pathname === `/crm/v4/objects/tickets/${ticketId}/associations/contacts`) return Response.json({ results: options.contact ? [{ toObjectId: 901 }] : [] });
    if (request.pathname === "/crm/v3/objects/contacts/901") return Response.json({ id: "901", properties: { email: options.contact } });
    if (request.pathname === "/crm/v3/objects/emails/batch/read") {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        inputs: options.emailBatch?.map(({ id }) => ({ id })),
        properties: ["hs_timestamp", "hs_email_direction"],
      });
      return Response.json({ status: "COMPLETE", results: options.emailBatch });
    }
    if (request.pathname === "/conversations/v3/conversations/threads") {
      expect(init?.method ?? "GET").toBe("GET");
      expect(request.searchParams.get("associatedTicketId")).toBe(ticketId);
      expect(request.searchParams.get("association")).toBe("TICKET");
      const threads = request.searchParams.get("archived") === "true" ? options.conversations?.archived : options.conversations?.active;
      return Response.json({ results: threads ?? [] });
    }
    expect(request.pathname).toBe(`/crm/v3/objects/tickets/${ticketId}`);
    expect(request.searchParams.get("propertiesWithHistory")).toBe("hubspot_owner_id");
    expect(request.searchParams.get("properties")?.split(",")).toContain("hs_ticket_category");
    expect(init?.method ?? "GET").toBe("GET");
    const category = ++ticketReads > 1 ? options.categoryOnRecheck ?? options.category : options.category;
    return Response.json({
      id: ticketId, archived: false, properties: { hubspot_owner_id: owner, hs_pipeline: "0", hs_pipeline_stage: options.stage ?? "1", hs_ticket_category: category ?? ACCESS },
      propertiesWithHistory: { hubspot_owner_id: [{ timestamp: new Date(at).toISOString(), sourceType: options.source ?? "CRM_UI", value: owner }] },
    });
  });
  vi.stubGlobal("fetch", read);
  return read;
}

async function scheduled(ticketId = String(++nextTicket)) {
  await observeSavOwnerHandoverEvents([ownerEvent(ticketId)]);
  return fixture.start.mock.lastCall![1][0];
}

function wake(input: OwnerHandoverTransition, at = DUE) {
  return runSavOwnerHandover(input, { now: () => new Date(at), deadlineMs: DUE + 240_000 });
}

async function storedMail(ticketId: string, teamLast = false, text = "Demande synthétique.", kinds: string[] = ["support"]) {
  const threadId = randomUUID(), messageId = randomUUID(), gmailThreadId = `thread-${threadId}`, gmailId = `message-${messageId}`;
  const receivedAt = new Date(INBOUND_AT);
  await database.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId, customerEmail: CLIENT, hubspotTicketId: ticketId });
  await database.db.insert(savMessages).values({
    id: messageId, threadId, mailboxId, gmailMessageId: gmailId, direction: "inbound", fromEmail: CLIENT, toEmails: [MAILBOX],
    receivedAt, bodyCiphertext: encryptSavPayload({ text }),
  });
  const decision = { classification: kinds.includes("cancellation") ? "cancellation" : "support", requests: kinds.map((kind, i) => ({ id: `request-${i + 1}`, kind })),
    disposition: { kind: "ticket", target: { operation: "link", ticketId, alreadyNew: true } } };
  const [execution] = await database.db.insert(savIntakeExecutions).values({
    messageId, threadId, runVersion: 1, policyId, policyHash, state: "confirmed", ticketId, payloadCiphertext: encryptSavPayload({ plan: { decision } }),
  }).returning();
  await database.db.insert(savIntakeEffects).values(["email_create", "email_associate"].map(kind => ({
    executionId: execution!.id, kind, permission: "associate_email", businessKey: `${kind}-${messageId}`, state: "confirmed",
    intentCiphertext: encryptSavPayload({ kind }), intentHash: "synthetic",
  })));
  fixture.gmail.mockResolvedValue({ id: gmailThreadId, messages: [
    { id: gmailId, threadId: gmailThreadId, internalDate: String(receivedAt.getTime()), payload: { headers: [{ name: "From", value: CLIENT }] } },
    ...(teamLast ? [{ id: "synthetic-sent", threadId: gmailThreadId, labelIds: ["SENT"], internalDate: String(receivedAt.getTime() + 1000),
      payload: { headers: [{ name: "From", value: MAILBOX }] } }] : []),
  ] });
  return { threadId, messageId, gmailThreadId, gmailId };
}

function admission(family: "access" | "usage" = "access"): CaseBoundaryDeps {
  const at = new Date(SETTLED_EVENT_AT).toISOString();
  return {
    env: process.env, readCreatedTicketOwner: async () => OWNER,
    readAdmissionPolicy: async () => ({ revision: "synthetic-policy", admittedFamilies: ["access", "usage"], qualifiedRules: [], approvedBy: administratorId, approvedAt: at }),
    readQualification: async ({ requests }) => ({
      requests: requests.map(({ requestId }) => ({ requestId, family, provenance: { kind: "human", staffUserId: administratorId, at } })),
      identity: { status: "confirmed", source: { type: "hubspot_object", id: "123" } }, crmContext: "complete", teamSignals: [],
    }),
  };
}

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-owner-handover-fixture-key-32");
  database = await createSavTestDb();
  fixture.db = database.db;
  const [mailbox] = await database.db.insert(savMailboxes).values({ email: MAILBOX }).returning();
  const [administrator] = await database.db.insert(staffUsers).values({ clerkId: "synthetic-owner-admin", email: MAILBOX, role: "admin" }).returning();
  mailboxId = mailbox!.id;
  administratorId = administrator!.id;
  async function policyWith(mutations: ExecutionPolicy["mutations"]) {
    const policy: ExecutionPolicy = {
      revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: CODE_REVISION, enginePolicyHash: "e".repeat(64),
      resourcesHash: "f".repeat(64), receivedAfter: "2026-01-01T00:00:00Z", createdAfter: "2026-01-01T00:00:00Z",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxDossiers: 1, mutations, admission: { kind: "automatic" },
    };
    const policyHash = intakeRuntimeHash(policy);
    const [row] = await database.db.insert(savIntakeExecutionPolicies).values({
      revision: policy.revision, administratorId, state: "approved", policyHash, payloadCiphertext: encryptSavPayload(policy),
    }).returning();
    return [row!.id, policyHash] as const;
  }
  [policyId, policyHash] = await policyWith(["start_case_owner_handover", "send_case_reply"]);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  fixture.start.mockResolvedValue({});
  fixture.after.length = 0;
  fixture.relayDeps = admission();
  fixture.handBack.mockImplementation(async (_input: unknown, reason: string) => ({ status: "human_wait", caseId: randomUUID(), reason }));
  fixture.blockEvidence.mockImplementation(async (_env: unknown, _messageId: string, _gmailId: string, requests: { requestId: string }[]) => requests.map(({ requestId }) =>
    ({ requestId, family: "access", provenance: { kind: "human", staffUserId: administratorId, at: new Date(SETTLED_EVENT_AT).toISOString() } })));
  const env = {
    VERCEL_ENV: "production", SAV_CASE_RECORDING: "on", SAV_V2_ENTRY: "on", SAV_V2_OWNER_HANDOVER: "on",
    SAV_V2_HUBSPOT_OWNER_ID: OWNER, SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash,
    VERCEL_GIT_COMMIT_SHA: CODE_REVISION, HUBSPOT_ACCESS_TOKEN: "synthetic-token", HUBSPOT_CLIENT_SECRET: SECRET, HUBSPOT_WEBHOOK_PUBLIC_URL: URL,
    SAV_ENCRYPTION_KEY_V1: "synthetic-owner-handover-fixture-key-32",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("Unexpected external call"); }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  const ids = [...testTickets];
  await database.db.delete(savWebhookReceipts).where(and(eq(savWebhookReceipts.provider, "hubspot"),
    inArray(sql`${savWebhookReceipts.payload}->>'objectId'`, ids)));
  await database.db.delete(savSyncState).where(inArray(savSyncState.key, ids.map(id => `sav-v2-owner-handover:${id}`)));
  testTickets.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => { await database.client.close(); });

/** Every simulated HubSpot call is a read (a GET, or the batch READ of emails); every Gmail call is a thread metadata read. */
function onlyReads(read: ReturnType<typeof liveTicket>) {
  for (const [url, init] of read.mock.calls) {
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    expect([String(url).replace(/\?.*$/, ""), method === "GET" || String(url).includes("/batch/read")]).toEqual([String(url).replace(/\?.*$/, ""), true]);
  }
  for (const [, path] of fixture.gmail.mock.calls) expect(String(path)).toMatch(/^threads\/[^/]+\?format=metadata/);
}

/** The smart entry's reading (what `v2-entry.ts` returns under the switch): every request support, `other`, smart provenance. */
function smartReading(): CaseBoundaryDeps {
  const at = new Date(SETTLED_EVENT_AT).toISOString();
  return { ...admission(), readQualification: async ({ requests }) => ({
    requests: requests.map(({ requestId }) => ({ requestId, family: "other", provenance: smartSupportProvenance(at) })),
    identity: { status: "confirmed", source: { type: "hubspot_object", id: "123" } }, crmContext: "complete", teamSignals: [],
  }) };
}

describe("SAV_V2_ENTRY_SMART=on before N8: a handed-over ticket read by the smart entry waits, nothing is handed back or written", () => {
  // Switch off, nothing produces a smart reading, so the hand-back paths of `owner-handover.test.ts` are unchanged (that file is untouched and green).
  beforeEach(() => { vi.stubEnv("SAV_V2_ENTRY_SMART", "on"); });

  it("a linked mail V1 executed (formerly an Access ticket, now `other`): smart pending, 0 hand-back, 0 HubSpot write, 0 Gmail send, no case", async () => {
    const input = await scheduled();
    await storedMail(input.ticketId);
    const read = liveTicket(input.ticketId);
    fixture.relayDeps = smartReading();
    await expect(wake(input)).resolves.toEqual({ status: "owner_handover_smart_pending" });
    expect(fixture.handBack).not.toHaveBeenCalled();
    expect(fixture.continueCase).not.toHaveBeenCalled();
    expect(await readCaseByTicket(input.ticketId)).toBeNull();
    onlyReads(read);
  });

  it("a mail V1 never executed (manual handover): smart pending as well, 0 hand-back, 0 HubSpot write, 0 Gmail send, no case", async () => {
    const input = await scheduled();
    const mail = await storedMail(input.ticketId);
    await database.db.delete(savIntakeEffects).where(inArray(savIntakeEffects.executionId,
      database.db.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, mail.messageId))));
    await database.db.delete(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, mail.messageId));
    const read = liveTicket(input.ticketId, { contact: CLIENT });
    fixture.blockEvidence.mockImplementation(async (_env: unknown, _messageId: string, _gmailId: string, requests: { requestId: string }[]) =>
      requests.map(({ requestId }) => ({ requestId, family: "other", provenance: smartSupportProvenance(new Date(SETTLED_EVENT_AT).toISOString()) })));
    await expect(wake(input)).resolves.toEqual({ status: "owner_handover_smart_pending" });
    expect(fixture.handBack).not.toHaveBeenCalled();
    expect(await readCaseByTicket(input.ticketId)).toBeNull();
    onlyReads(read);
  });

  it("review 1D: 14 support requests + 1 cancellation (the smart entry leaves the whole mail to the team): still waits, 0 hand-back, 0 HubSpot write, no case", async () => {
    const input = await scheduled();
    await storedMail(input.ticketId, false, undefined, [...Array(14).fill("support"), "cancellation"]);
    const read = liveTicket(input.ticketId);
    // What the entry's rule port gives such a mail under the switch: no request of its own (V1's hints stay, a sensitive one included).
    fixture.relayDeps = { ...admission(), readQualification: async () => ({ requests: [], identity: { status: "confirmed", source: { type: "hubspot_object", id: "123" } },
      crmContext: "complete", teamSignals: [] }) };
    await expect(wake(input)).resolves.toEqual({ status: "owner_handover_smart_pending" });
    expect(fixture.handBack).not.toHaveBeenCalled();
    expect(fixture.continueCase).not.toHaveBeenCalled();
    expect(await readCaseByTicket(input.ticketId)).toBeNull();
    onlyReads(read);
  });

  it("review 1D: manual handover the smart entry leaves to the team (no request of its own, mixed mail): waits, 0 hand-back (no `no_block_match`), 0 HubSpot write", async () => {
    const input = await scheduled();
    const mail = await storedMail(input.ticketId);
    await database.db.delete(savIntakeEffects).where(inArray(savIntakeEffects.executionId,
      database.db.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, mail.messageId))));
    await database.db.delete(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, mail.messageId));
    const read = liveTicket(input.ticketId, { contact: CLIENT });
    fixture.blockEvidence.mockResolvedValue([]);
    await expect(wake(input)).resolves.toEqual({ status: "owner_handover_smart_pending" });
    expect(fixture.handBack).not.toHaveBeenCalled();
    expect(await readCaseByTicket(input.ticketId)).toBeNull();
    onlyReads(read);
  });

  it("review 1D: switch off, the same mixed mail is handed back as before (out_of_scope)", async () => {
    vi.stubEnv("SAV_V2_ENTRY_SMART", "");
    const input = await scheduled();
    await storedMail(input.ticketId, false, undefined, [...Array(14).fill("support"), "cancellation"]);
    liveTicket(input.ticketId);
    fixture.relayDeps = { ...admission(), readQualification: async () => ({ requests: [], identity: { status: "confirmed", source: { type: "hubspot_object", id: "123" } },
      crmContext: "complete", teamSignals: [] }) };
    await expect(wake(input)).resolves.toEqual({ status: "handed_back:out_of_scope" });
    expect(fixture.handBack).toHaveBeenCalledExactlyOnceWith(input, "out_of_scope");
  });

  /** « Traité hors Studio »: no V1 execution for the mail (SAV-99's manual handover). */
  async function manualMail(ticketId: string, text?: string) {
    const mail = await storedMail(ticketId, false, text);
    await database.db.delete(savIntakeEffects).where(inArray(savIntakeEffects.executionId,
      database.db.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, mail.messageId))));
    await database.db.delete(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, mail.messageId));
    return mail;
  }
  const smartEvidence = async (_env: unknown, _messageId: string, _gmailId: string, requests: { requestId: string }[]) =>
    requests.map(({ requestId }) => ({ requestId, family: "other", provenance: smartSupportProvenance(new Date(SETTLED_EVENT_AT).toISOString()) }));

  it("SAV-118: a manual handover worded « résilier » is not handed back on words (the smart brain judges): smart pending, nothing written", async () => {
    const input = await scheduled();
    await manualMail(input.ticketId, "Bonjour, je veux résilier et mon Google Sheet est vide.");
    const read = liveTicket(input.ticketId, { contact: CLIENT });
    fixture.blockEvidence.mockImplementation(smartEvidence);
    await expect(wake(input)).resolves.toEqual({ status: "owner_handover_smart_pending" });
    expect(fixture.handBack).not.toHaveBeenCalled();
    onlyReads(read);
  });

  it("SAV-118: a manual handover on a ticket with no contact goes back to the team with `crm_missing_primary` (the existing hand-back only)", async () => {
    const input = await scheduled();
    await manualMail(input.ticketId);
    liveTicket(input.ticketId);
    fixture.blockEvidence.mockImplementation(smartEvidence);
    await expect(wake(input)).resolves.toEqual({ status: "handed_back:crm_missing_primary" });
    expect(fixture.handBack).toHaveBeenCalledExactlyOnceWith(input, "crm_missing_primary");
    expect(fixture.blockEvidence).not.toHaveBeenCalled();
  });

  it("SAV-118: switch off, the same mails keep their historical hand-backs (words, `no_contact`)", async () => {
    vi.stubEnv("SAV_V2_ENTRY_SMART", "");
    const worded = await scheduled();
    await manualMail(worded.ticketId, "Bonjour, je veux résilier.");
    liveTicket(worded.ticketId, { contact: CLIENT });
    await expect(wake(worded)).resolves.toEqual({ status: "handed_back:sensitive_request" });
    const none = await scheduled();
    await manualMail(none.ticketId);
    liveTicket(none.ticketId);
    await expect(wake(none)).resolves.toEqual({ status: "handed_back:no_contact" });
  });
});
