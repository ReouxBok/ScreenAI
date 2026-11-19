// SAV-99 (Ugo 19/11): a ticket a person gave the Agent SAV, without any mail. The HubSpot category never decides; the content does (taken when it is an
// Access request, to the team when it is sensitive). Real entry and case store on PGlite; only HubSpot is a fake (any write or Gmail call fails the test).
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));

import { savCases, savCaseEffectExecutions, savCaseReplyValidations, savMailboxes, staffUsers } from "@/db/schema";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "../intake/execution-policy";
import { readCase } from "./case-store";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import { THREADLESS_ADMIT_PERMISSION, THREADLESS_CRM_PERMISSION, THREADLESS_SEND_PERMISSION } from "./threadless-config";
import { startV2FromThreadlessTicket } from "./threadless-entry";
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
    mutations: [THREADLESS_ADMIT_PERMISSION, THREADLESS_SEND_PERMISSION, THREADLESS_CRM_PERMISSION],
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
  })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A ticket without any mail, given to the Agent SAV, with this content and this (possibly wrong) category. */
function ticket(content: { subject: string; content: string }, category: string, contacts: string[] = [CONTACT]) {
  const ticketId = String(++seq);
  const observedAt = new Date(Date.now() - 5_000).toISOString();
  const input = { ticketId, ownerTransitionKey: `fixture-owner-${ticketId}`, observedAt };
  const record = { id: ticketId, updatedAt: observedAt,
    properties: { ...content, hubspot_owner_id: OWNER, hs_pipeline: "0", hs_pipeline_stage: SAV_HUBSPOT_SUPPORT.stages.new, hs_ticket_category: category } };
  const counts = { gmail: 0, writes: 0 };
  vi.stubGlobal("fetch", (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if ((init?.method ?? "GET") !== "GET" && path !== "/crm/v3/objects/notes/batch/read") { counts.writes++; throw Error("UNEXPECTED_SYNTHETIC_WRITE"); }
    if (/gmail/.test(String(url))) { counts.gmail++; throw Error("UNEXPECTED_SYNTHETIC_GMAIL"); }
    const associations = `/crm/v4/objects/tickets/${ticketId}/associations`;
    if (path === `/crm/v3/objects/tickets/${ticketId}`) return Response.json(record);
    if (path === `${associations}/emails`) return Response.json({ results: [] });
    if (path === `${associations}/contacts`) return Response.json({ results: contacts.map(toObjectId => ({ toObjectId })) });
    if (path === `${associations}/notes`) return Response.json({ results: [] });
    if (/^\/crm\/v3\/objects\/contacts\/\d+$/.test(path)) return Response.json({ id: path.split("/").at(-1), properties: { email: CUSTOMER } });
    throw Error(`UNEXPECTED_SYNTHETIC_HUBSPOT_PATH ${path}`);
  }) as typeof fetch);
  return { input, counts };
}

const caseOf = async (ticketId: string) => (await f.db.select().from(savCases).where(eq(savCases.ticketId, ticketId)))[0];
const executionsOf = (caseId: string) => f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, caseId));

describe("SAV-99: an assigned ticket without mail, the category never decides", () => {
  it.each([SAV_HUBSPOT_SUPPORT.categories.technical, SAV_HUBSPOT_SUPPORT.categories.other, ""])("Access content with the wrong category %j: the agent takes it", async category => {
    const s = ticket(ACCESS_CONTENT, category);
    expect(await startV2FromThreadlessTicket(s.input)).toMatchObject({ status: "started" });
    const row = await caseOf(s.input.ticketId);
    expect(await readCase(row!.id)).toMatchObject({ owner: "agent", phase: "queued" });
    expect(s.counts).toEqual({ gmail: 0, writes: 0 });
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
    expect(s.counts).toEqual({ gmail: 0, writes: 0 });
  });

  it("LIMIT (documented, not fixed here): content outside Access with the category « Acces » is refused by its content, but nothing gives the ticket back to the team", async () => {
    const s = ticket({ subject: "Export de mes contacts", content: "Comment exporter la liste de mes contacts au format CSV ?" }, SAV_HUBSPOT_SUPPORT.categories.access);
    expect(await startV2FromThreadlessTicket(s.input)).toEqual({ status: "out_of_scope" });
    // No case, no proposal, no mail, no HubSpot write: the ticket stays in the agent's name (see the report: the hand-back needs a migration).
    expect(await caseOf(s.input.ticketId)).toBeUndefined();
    expect(s.counts).toEqual({ gmail: 0, writes: 0 });
  });
});
