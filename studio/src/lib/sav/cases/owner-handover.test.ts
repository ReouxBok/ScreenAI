import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import {
  savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savMailboxes, savMessages,
  savSyncState, savThreads, savWebhookReceipts, staffUsers,
} from "@/db/schema";
import { POST } from "@/app/api/webhooks/hubspot/route";
import { encryptSavPayload } from "../crypto";
import { processPendingHubspotReceipts } from "../hubspot";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { savAgentPauseKey } from "../intake/agent-pause";
import type { ExecutionPolicy } from "../intake/execution-policy";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { listCaseEvents, readCaseByTicket } from "./case-store";
import { recordCaseAfterConfirmedIntake, type CaseBoundaryDeps } from "./intake-boundary";
import { runSavOwnerHandover, sweepDueOwnerHandovers } from "./owner-handover";
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
}));
vi.mock("./threadless-entry", async original => {
  const module = await original<typeof import("./threadless-entry")>();
  return { startV2FromThreadlessTicket: fixture.threadless.mockImplementation(module.startV2FromThreadlessTicket) };
});

const MAILBOX = "contact@limova.ai", CLIENT = "client@example.invalid";
const SETTLED_EVENT_AT = Date.now() - OWNER_HANDOVER_DELAY_MS - 1_000;
const DUE = SETTLED_EVENT_AT + OWNER_HANDOVER_DELAY_MS;
const OWNER = "7001", HUMAN = "7002";
const CODE_REVISION = "a".repeat(40), SECRET = "synthetic-webhook-secret";
const URL = "https://studio.example.invalid/api/webhooks/hubspot";
const PORTAL = Number(SAV_HUBSPOT_SUPPORT.portalId);
const ACCESS = SAV_HUBSPOT_SUPPORT.categories.access;

let database: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string, administratorId: string, policyId: string, policyHash: string, restrictedId: string, restrictedHash: string;
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

function liveTicket(ticketId: string, options: { at?: number; owner?: string; stage?: string; category?: string; source?: string } = {}) {
  const owner = options.owner ?? OWNER, at = options.at ?? SETTLED_EVENT_AT;
  const read = vi.fn(async (url: string, init?: RequestInit) => {
    const request = new globalThis.URL(url);
    expect(request.pathname).toBe(`/crm/v3/objects/tickets/${ticketId}`);
    expect(request.searchParams.get("propertiesWithHistory")).toBe("hubspot_owner_id");
    expect(init?.method ?? "GET").toBe("GET");
    return Response.json({
      id: ticketId, archived: false, properties: { hubspot_owner_id: owner, hs_pipeline: "0", hs_pipeline_stage: options.stage ?? "1", hs_ticket_category: options.category ?? ACCESS },
      propertiesWithHistory: { hubspot_owner_id: [{ timestamp: new Date(at).toISOString(), sourceType: options.source ?? "CRM_UI", value: owner }] },
    });
  });
  vi.stubGlobal("fetch", read);
  return read;
}

function signedRequest(events: unknown[], signatureValid = true) {
  const body = JSON.stringify(events), timestamp = String(Date.now());
  const signature = createHmac("sha256", SECRET).update(`POST${URL}${body}${timestamp}`).digest("base64");
  return new Request(URL, { method: "POST", body, headers: {
    "x-hubspot-request-timestamp": timestamp, "x-hubspot-signature-v3": signatureValid ? signature : "wrong",
  } });
}

async function scheduled(ticketId = String(++nextTicket)) {
  await observeSavOwnerHandoverEvents([ownerEvent(ticketId)]);
  return fixture.start.mock.lastCall![1][0];
}

function wake(input: OwnerHandoverTransition, at = DUE) {
  return runSavOwnerHandover(input, { now: () => new Date(at), deadlineMs: DUE + 240_000 });
}

async function storedMail(ticketId: string, teamLast = false) {
  const threadId = randomUUID(), messageId = randomUUID(), gmailThreadId = `thread-${threadId}`, gmailId = `message-${messageId}`;
  const receivedAt = new Date(SETTLED_EVENT_AT - 3600_000);
  await database.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId, customerEmail: CLIENT, hubspotTicketId: ticketId });
  await database.db.insert(savMessages).values({
    id: messageId, threadId, mailboxId, gmailMessageId: gmailId, direction: "inbound", fromEmail: CLIENT, toEmails: [MAILBOX],
    receivedAt, bodyCiphertext: encryptSavPayload({ text: "Demande synthétique." }),
  });
  const decision = { classification: "support", requests: [{ id: "request-1", kind: "support" }],
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
  [restrictedId, restrictedHash] = await policyWith(["send_case_reply"]);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  fixture.start.mockResolvedValue({});
  fixture.after.length = 0;
  fixture.relayDeps = admission();
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

describe("owner handover from HubSpot's existing webhook", () => {
  it("rejects an invalid v3 signature before a receipt or a workflow", async () => {
    expect((await POST(signedRequest([ownerEvent(String(++nextTicket))], false))).status).toBe(401);
    expect(fixture.after).toHaveLength(0);
    expect(await database.db.select().from(savWebhookReceipts)).toEqual([]);
  });

  it("considers owner events behind newer unrelated properties in the signed batch, and deduplicates retries", async () => {
    const ticketId = String(++nextTicket), owner = ownerEvent(ticketId);
    const body = [
      { ...owner, propertyName: "hs_pipeline_stage", occurredAt: SETTLED_EVENT_AT + 2000 },
      owner,
      { ...owner, attemptNumber: 1 },
      ownerEvent(String(++nextTicket), { source: "INTEGRATION" }),
      ownerEvent(String(++nextTicket), { portal: PORTAL + 1 }),
    ];
    expect((await POST(signedRequest(body))).status).toBe(204);
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.after).toHaveLength(1);
    await fixture.after[0]!();
    expect(fixture.refresh).toHaveBeenCalledTimes(3);
    expect(fixture.start).toHaveBeenCalledExactlyOnceWith(expect.any(Function), [
      { ticketId, ownerTransitionKey: `hubspot-owner:${ticketId}:${SETTLED_EVENT_AT}:${OWNER}`, observedAt: new Date(SETTLED_EVENT_AT).toISOString() },
      new Date(DUE).toISOString(),
    ]);
    expect((await POST(signedRequest(body))).status).toBe(204);
    expect(fixture.after).toHaveLength(1);
  });

  it("does not replace a more recent human owner with an older event delivered last", async () => {
    const ticketId = String(++nextTicket);
    await observeSavOwnerHandoverEvents([ownerEvent(ticketId, { at: SETTLED_EVENT_AT + 1000, owner: HUMAN })]);
    await observeSavOwnerHandoverEvents([ownerEvent(ticketId)]);
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("treats concurrent transitions as one wake, claim and threadless entry at +305 seconds", async () => {
    const ticketId = String(++nextTicket);
    liveTicket(ticketId, { source: "MOBILE" });
    await Promise.all([1, 2, 3].map(() => observeSavOwnerHandoverEvents([ownerEvent(ticketId, { source: "MOBILE" })])));
    expect(fixture.start).toHaveBeenCalledTimes(1);
    const input = fixture.start.mock.lastCall![1][0];
    await expect(wake(input, DUE - 1)).resolves.toEqual({ status: "not_due_or_claimed" });
    expect(fixture.threadless).not.toHaveBeenCalled();
    const outcomes = await Promise.all([wake(input), wake(input)]);
    expect(outcomes.map(result => result.status).sort()).toEqual(["not_due_or_claimed", "threadless_not_enabled"]);
    expect(fixture.threadless).toHaveBeenCalledExactlyOnceWith(input);
    expect(fixture.gmail).not.toHaveBeenCalled();
  });

  it("catches up a due marker when the Workflow start fails, without dispatching another workflow", async () => {
    const ticketId = String(++nextTicket);
    liveTicket(ticketId);
    fixture.start.mockRejectedValueOnce(Error("synthetic start failed"));
    await scheduled(ticketId);
    await expect(sweepDueOwnerHandovers(Date.now() + 240_000)).resolves.toEqual({ threadless_not_enabled: 1 });
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.threadless).toHaveBeenCalledTimes(1);
  });

  it("supersedes a scheduled wake with a newer owner event in the meantime", async () => {
    const input = await scheduled();
    await observeSavOwnerHandoverEvents([ownerEvent(input.ticketId, { at: SETTLED_EVENT_AT + 1000, owner: HUMAN })]);
    await expect(wake(input)).resolves.toEqual({ status: "not_due_or_claimed" });
    expect(fixture.threadless).not.toHaveBeenCalled();
  });

  it.each([
    ["owner_changed", { owner: HUMAN }],
    ["owner_transition_changed", { at: SETTLED_EVENT_AT + 1000 }],
    ["ticket_closed", { stage: "4" }],
    ["outside_access", { category: SAV_HUBSPOT_SUPPORT.categories.billing }],
  ] as const)("refuses a fresh CRM read with the result %s", async (status, properties) => {
    const input = await scheduled();
    liveTicket(input.ticketId, properties);
    await expect(wake(input)).resolves.toEqual({ status });
    expect(fixture.threadless).not.toHaveBeenCalled();
    expect(fixture.continueCase).not.toHaveBeenCalled();
  });

  it("consumes a wake while paused without reading HubSpot or calling either entry", async () => {
    const input = await scheduled();
    await database.db.insert(savSyncState).values({ key: savAgentPauseKey("v2"), cursor: "synthetic-unreadable-pause" });
    try {
      await expect(wake(input)).resolves.toEqual({ status: "paused" });
      expect(fetch).not.toHaveBeenCalled();
      expect(fixture.threadless).not.toHaveBeenCalled();
    } finally {
      await database.db.delete(savSyncState).where(eq(savSyncState.key, savAgentPauseKey("v2")));
    }
  });

  it("requires the new grant on the signed execution policy", async () => {
    const input = await scheduled();
    liveTicket(input.ticketId);
    vi.stubEnv("SAV_INTAKE_EXECUTION_POLICY_ID", restrictedId);
    vi.stubEnv("SAV_INTAKE_EXECUTION_POLICY_SHA256", restrictedHash);
    await expect(wake(input)).resolves.toEqual({ status: "permission_missing" });
    expect(fixture.threadless).not.toHaveBeenCalled();
  });

  it("gives the existing relay the original V1-confirmed Gmail thread after the wake, once", async () => {
    const input = await scheduled();
    const mail = await storedMail(input.ticketId);
    liveTicket(input.ticketId);
    await expect(wake(input)).resolves.toEqual({ status: "relayed" });
    const current = (await readCaseByTicket(input.ticketId))!;
    expect(current).toMatchObject({ owner: "agent", phase: "queued", threadIds: [mail.threadId] });
    const events = await listCaseEvents(current.caseId);
    expect(events[0]).toMatchObject({ kind: "inbound_confirmed", sourceRef: { id: mail.gmailId }, detail: { relay: { messageId: mail.messageId } } });
    expect(fixture.gmail).toHaveBeenCalledExactlyOnceWith(MAILBOX, `threads/${mail.gmailThreadId}?format=metadata&metadataHeaders=From`);
    expect(fixture.continueCase).toHaveBeenCalledExactlyOnceWith(current.caseId, "relay", { env: process.env, immediateDeadlineMs: DUE + 240_000 });
    expect(fixture.threadless).not.toHaveBeenCalled();
    await expect(wake(input)).resolves.toEqual({ status: "not_due_or_claimed" });
    const newerAt = SETTLED_EVENT_AT + 1000;
    await observeSavOwnerHandoverEvents([ownerEvent(input.ticketId, { at: newerAt })]);
    liveTicket(input.ticketId, { at: newerAt });
    await expect(wake(fixture.start.mock.lastCall![1][0], DUE + 1000)).resolves.toEqual({ status: "case_preserved" });
    expect(await readCaseByTicket(input.ticketId)).toEqual(current);
    expect(fixture.continueCase).toHaveBeenCalledTimes(1);
  });

  it("makes the first V2 attribution await the customer when the latest Gmail message is from the team", async () => {
    const input = await scheduled();
    await storedMail(input.ticketId, true);
    liveTicket(input.ticketId);
    await expect(wake(input)).resolves.toEqual({ status: "awaiting_customer" });
    const current = (await readCaseByTicket(input.ticketId))!;
    expect(current).toMatchObject({ owner: "agent", phase: "awaiting_customer" });
    expect((await listCaseEvents(current.caseId)).at(-1)).toMatchObject({ kind: "owner_changed", detail: { toPhase: "awaiting_customer" } });
    expect(fixture.continueCase).not.toHaveBeenCalled();
  });

  it("refuses a linked mail whose existing admission proves a family other than Access", async () => {
    const input = await scheduled();
    await storedMail(input.ticketId);
    liveTicket(input.ticketId);
    fixture.relayDeps = admission("usage");
    await expect(wake(input)).resolves.toEqual({ status: "owner_handover_out_of_scope" });
    expect(await readCaseByTicket(input.ticketId)).toBeNull();
    expect(fixture.continueCase).not.toHaveBeenCalled();
  });

  it("does not treat an unreadable existing thread as threadless", async () => {
    const input = await scheduled();
    await storedMail(input.ticketId);
    liveTicket(input.ticketId);
    fixture.gmail.mockRejectedValueOnce(Error("synthetic 404"));
    await expect(wake(input)).resolves.toEqual({ status: "read_or_relay_failed" });
    expect(fixture.threadless).not.toHaveBeenCalled();
  });

  it("reuses the same marker when confirmation of the stored inbound arrives after the first wake", async () => {
    const input = await scheduled();
    const mail = await storedMail(input.ticketId);
    liveTicket(input.ticketId);
    const execution = eq(savIntakeExecutions.messageId, mail.messageId);
    await database.db.update(savIntakeExecutions).set({ state: "running" }).where(execution);
    await expect(wake(input)).resolves.toEqual({ status: "read_or_relay_failed" });
    expect(await readCaseByTicket(input.ticketId)).toBeNull();
    await database.db.update(savIntakeExecutions).set({ state: "confirmed" }).where(execution);
    await expect(wake(input, DUE + 120_000)).resolves.toEqual({ status: "relayed" });
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.continueCase).toHaveBeenCalledTimes(1);
  });

  it("blocks the original V1 owner shortcut before notification delivery when the switch is on", async () => {
    const ticketId = String(++nextTicket), mail = await storedMail(ticketId);
    liveTicket(ticketId);
    await expect(recordCaseAfterConfirmedIntake(mail.messageId, admission())).resolves.toMatchObject({ owner: "human" });
    expect(fixture.start).not.toHaveBeenCalled();
    const input = await scheduled(ticketId);
    await expect(wake(input)).resolves.toEqual({ status: "relayed" });
    expect((await readCaseByTicket(ticketId))?.owner).toBe("agent");
  });

  it("does no handover work with the switch absent, and preserves legacy webhook and V1 relay behavior", async () => {
    const pending = await scheduled();
    fixture.start.mockClear();
    vi.stubEnv("SAV_V2_OWNER_HANDOVER", undefined);
    const ticketId = String(++nextTicket);
    const mail = await storedMail(ticketId);
    expect((await POST(signedRequest([ownerEvent(ticketId)]))).status).toBe(204);
    await fixture.after[0]!();
    expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith(ticketId);
    await expect(processPendingHubspotReceipts()).resolves.toEqual([]);
    await expect(wake(pending)).resolves.toEqual({ status: "off" });
    expect(fixture.start).not.toHaveBeenCalled();
    await expect(recordCaseAfterConfirmedIntake(mail.messageId, admission())).resolves.toMatchObject({ owner: "agent" });
    expect(fixture.gmail).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
