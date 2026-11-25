import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));

import { savCaseReplyValidations, savCases, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload } from "../../crypto";
import { ingestInboundMessage } from "../../service";
import { createIntakeExecutorAdapters, type GmailRequest } from "../../intake/execution-adapters";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "../../intake/execution-policy";
import type { SavRetrievalCandidate } from "../../request-retrieval";
import { APP_TICKET_TRANSITION_PREFIX } from "../app-tickets-config";
import type { CaseReplyProposal } from "../case-effects";
import { readCaseReplyDisclosure } from "../case-reply-outbound";
import { runCaseEffectsPass } from "../case-runtime-effects";
import { listCaseEvents, readCase } from "../case-store";
import { isSmartSupportProvenance, SAV_SMART_ENTRY_FAMILY, SAV_SMART_NO_THREAD_WAIT, type KnowledgeRef } from "../case-types";
import { readCustomerReturnFacts, routeCustomerReturn } from "../customer-return-store";
import type { CaseEmbeddingSpendPort, CaseEmbeddingTransport, CaseKnowledgeVectorSearch } from "../investigation-budgeted-retrieval";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import { caseCallLedgerOnStore, type CaseInvestigationRuntimeDeps } from "../investigation-runtime";
import { caseInvestigationReturnAwareQualify } from "../investigation-return-qualify";
import { pilotProvenanceGate, type PilotProvenanceDeps } from "../pilot-passage-provenance";
import { THREADLESS_ADMIT_PERMISSION, THREADLESS_CRM_PERMISSION, THREADLESS_SEND_PERMISSION } from "../threadless-config";
import { startV2FromThreadlessTicket, type ThreadlessFirstMailPort } from "../threadless-entry";
import { readThreadlessAccessSkill } from "../threadless-source";
import { createThreadlessTransport, THREADLESS_MAILBOX } from "../threadless-transport";
import { composeThreadlessFirstMail, type ThreadlessFirstMailDeps } from "./threadless-first-mail";

/*
 * SAV-138 (Ugo 25/11), on the real stores (PGlite): an app ticket (no mail thread) the app-tickets pass assigned → the smart brain writes its first mail →
 * ONE mail on a new Gmail thread from contact@ to the HubSpot contact → the customer's reply comes back to the same case, still smart. Doubles only for the
 * transports (HubSpot, Gmail), the decision model, the vector index and the embedding. Every value is fictional.
 */

const CUSTOMER = "client-app-fictif@example.invalid";
const OWNER = "810138";
const CONTACT = "610138";
const APPROVER = "30000000-0000-4000-8000-000000000138";
const CODE_REVISION = "e".repeat(40);
const QUESTION = "Bonjour, mon export Google Sheet ne se remplit plus depuis hier. Comment le relancer ?";
const SUBJECT = "Export Google Sheet";
const card: SavRetrievalCandidate = { id: "fixture-knowledge-138", contentVersionId: "fixture-version-138", title: "Fiche export fictive", content: "Procédure fictive de relance d’un export.",
  source: "fixture", verifiedAt: new Date(Date.now() - 864_000_000).toISOString(), semanticScore: null, resolution: { steps: ["Relancer l’export depuis l’onglet Intégrations."] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
const ref: KnowledgeRef = { knowledgeId: card.id, contentVersionId: card.contentVersionId };
const FIRST_MAIL = "Bonjour,\n\nPour relancer votre export Google Sheet, ouvrez l’onglet Intégrations puis cliquez sur « Relancer l’export ».";

let f: Awaited<ReturnType<typeof createSavTestDb>>;
let mailboxId: string;
let grant: Awaited<ReturnType<typeof approveIntakeExecutionPolicy>>;
let executionPolicy: ExecutionPolicy;
let seq = 970_000;

beforeAll(async () => {
  f = await createSavTestDb();
  state.db = f.db;
  const [staff] = await f.db.insert(staffUsers).values({ clerkId: "app-ticket-fixture", name: "Relecteur fictif", role: "admin", email: THREADLESS_MAILBOX, active: true }).returning();
  state.user = { id: staff!.clerkId, primaryEmailAddress: { emailAddress: staff!.email, verification: { status: "verified" } } };
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: THREADLESS_MAILBOX, active: true }).returning();
  mailboxId = mailbox!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f?.client.close(); });

type Mode = Readonly<{ app?: "live" | "shadow" | "off" }>;
async function configure(mode: Mode = {}) {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-app-ticket-fixture-key-32-chars");
  vi.spyOn(console, "info").mockImplementation(() => {});
  const before = new Date(Date.now() - 60 * 60_000).toISOString(), after = new Date(Date.now() + 60 * 60_000).toISOString();
  executionPolicy = {
    revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: CODE_REVISION, enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
    receivedAfter: before, createdAfter: before, expiresAt: after, maxDossiers: 40,
    mutations: [THREADLESS_ADMIT_PERMISSION, THREADLESS_SEND_PERMISSION, THREADLESS_CRM_PERMISSION], admission: { kind: "automatic" },
  };
  grant = await approveIntakeExecutionPolicy(executionPolicy);
  for (const [key, value] of Object.entries({
    VERCEL_ENV: "production", SAV_APP_TICKETS_MODE: mode.app ?? "live",
    SAV_V2_ENTRY_SMART: "on", SAV_V2_SMART_SUPPORT_MODE: "auto",
    // The Access first mail's own switch stays off: the smart first mail of an app ticket does not rest on it.
    SAV_V2_NEW_THREAD: "on", SAV_V2_NEW_THREAD_AUTO: "off", SAV_V2_ACCESS_SKILL: "off",
    SAV_CASE_RECORDING: "on", SAV_V2_ENTRY: "on", SAV_CASE_EFFECTS: "supervised",
    SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: APPROVER,
    SAV_V2_HUBSPOT_OWNER_ID: OWNER, HUBSPOT_ACCESS_TOKEN: "synthetic",
    SAV_V2_ADMISSION_RULES_JSON: "[]", SAV_V2_ADMISSION_POLICY_JSON: undefined, SAV_V2_ACCESS_SCOPE_JSON: undefined,
    SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash,
    SAV_CODE_REVISION: CODE_REVISION, VERCEL_GIT_COMMIT_SHA: undefined, SAV_V2_SCOPE_MODE: undefined, SAV_V2_QUALIFICATION_SCOPE_JSON: undefined,
    SAV_TEST_MODE: "false", SAV_WRITES_DISABLED: "false", SAV_INTAKE_EXECUTION_KILL_SWITCH: "0",
  })) vi.stubEnv(key, value);
}
const provenanceDeps: PilotProvenanceDeps = {
  accessScope: async () => null, currentPolicyRevision: async () => "no-policy", now: () => new Date(), env: () => process.env,
  readActiveSource: async () => ({ active: true, title: card.title, content: card.content, verifiedAt: card.verifiedAt! }),
};
beforeEach(async () => { await configure(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Ticket = Readonly<{ content?: string; subject?: string; contacts?: string[]; email?: string; app?: boolean }>;
function fixture(ticketInput: Ticket = {}) {
  const ticketId = String(++seq);
  const observedAt = new Date(Date.now() - 5_000).toISOString();
  const ownerTransitionKey = ticketInput.app === false ? `fixture-owner-${ticketId}` : `${APP_TICKET_TRANSITION_PREFIX}${ticketId}:${Date.parse(observedAt)}:none`;
  const input = { ticketId, ownerTransitionKey, observedAt };
  const ack = { id: `sent-${ticketId}`, threadId: `gmail-thread-${ticketId}` };
  const crmId = String(seq + 20_000);
  const ticket = { id: ticketId, updatedAt: observedAt,
    properties: { subject: ticketInput.subject ?? SUBJECT, content: ticketInput.content ?? QUESTION, hubspot_owner_id: OWNER, hs_pipeline: "0", hs_pipeline_stage: "1" } };
  const controls = { contacts: ticketInput.contacts ?? [CONTACT] };
  const counts = { crmPosts: 0, gmailPosts: 0, network: 0 };
  let storedCrmProperties: unknown, sentMail: { to: string; subject: string; rfcId: string; body: string; at: string } | undefined;
  const hubspot: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const ticketPath = `/crm/v4/objects/tickets/${ticketId}/associations`;
    if (path === `/crm/v3/objects/tickets/${ticketId}`) return Response.json(ticket);
    if (path === `${ticketPath}/emails`) return Response.json({ results: [] });
    if (path === `${ticketPath}/contacts`) return Response.json({ results: controls.contacts.map(toObjectId => ({ toObjectId })) });
    if (path === `${ticketPath}/notes`) return Response.json({ results: [] });
    if (/^\/crm\/v3\/objects\/contacts\/\d+$/.test(path)) return Response.json({ id: path.split("/").at(-1), properties: { email: ticketInput.email ?? CUSTOMER } });
    if (path === "/crm/v4/associations/emails/tickets/labels") return Response.json({ results: [{ typeId: 212, category: "HUBSPOT_DEFINED", label: null }] });
    if (path === "/crm/v4/associations/emails/contacts/labels") return Response.json({ results: [{ typeId: 198, category: "HUBSPOT_DEFINED", label: null }] });
    if (path === "/crm/v3/objects/emails" && init?.method === "POST") {
      counts.crmPosts++;
      storedCrmProperties = JSON.parse(String(init.body)).properties;
      return Response.json({ id: crmId });
    }
    if (path === `/crm/v3/objects/emails/${crmId}`) return Response.json({ id: crmId, properties: storedCrmProperties });
    if (path === `/crm/v4/objects/emails/${crmId}/associations/tickets`) return Response.json({ results: [{ toObjectId: ticketId }] });
    if (path === `/crm/v4/objects/emails/${crmId}/associations/contacts`) return Response.json({ results: [{ toObjectId: CONTACT }] });
    throw Error("UNEXPECTED_SYNTHETIC_HUBSPOT_PATH");
  };
  // No judge, no other model on the network: the smart first mail is the decision model's alone.
  vi.stubGlobal("fetch", (async (url, init) => { counts.network++; return hubspot(url, init); }) as typeof fetch);
  const gmailRequest: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    expect(mailbox).toBe(THREADLESS_MAILBOX);
    if (path === "messages/send" && init?.method === "POST") {
      counts.gmailPosts++;
      const [head, body] = Buffer.from((JSON.parse(String(init.body)) as { raw: string }).raw, "base64url").toString("utf8").split("\r\n\r\n");
      const headers = head!.replace(/\r\n /g, " ").split("\r\n");
      sentMail = { to: headers.find(line => line.startsWith("To: "))!.slice(4), subject: headers.find(line => line.startsWith("Subject: "))!.slice(9),
        rfcId: headers.find(line => line.startsWith("Message-ID: "))!.slice(12), body: Buffer.from(body!, "base64").toString("utf8"), at: String(Date.now()) };
      return ack as T;
    }
    if (path.startsWith("messages?")) return { messages: sentMail ? [ack] : [] } as T;
    if (path === `messages/${ack.id}?format=full` && sentMail) {
      return { ...ack, internalDate: sentMail.at, labelIds: ["SENT"], payload: { mimeType: "text/plain", body: { data: Buffer.from(sentMail.body).toString("base64url") },
        headers: [{ name: "From", value: THREADLESS_MAILBOX }, { name: "To", value: sentMail.to }, { name: "Subject", value: sentMail.subject }, { name: "Message-ID", value: sentMail.rfcId }] } } as T;
    }
    throw Error("UNEXPECTED_SYNTHETIC_GMAIL_PATH");
  };
  const gmailPermissions = async () => undefined;
  const transport = createThreadlessTransport({ env: () => process.env, gmailRequest, network: hubspot });
  const run = (executionId?: string) => runCaseEffectsPass({
    env: () => process.env, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "no-policy",
    executionId, deadlineMs: Date.now() + 30_000, context: { runtime: {} as never, policy: executionPolicy },
    adapters: createIntakeExecutorAdapters({ env: () => process.env, gmailRequest, network: hubspot, gmailPermissions }),
    threadless: { transport, gmailPermissions }, pilotProvenance: pilotProvenanceGate(provenanceDeps),
  });
  return { input, ack, crmId, counts, run, sentMail: () => sentMail };
}

/** The smart decision model: what it receives, and its decision (a fictional answer by default, or a hand-over to the team). */
function decisionModel(kind: "answer" | "team" = "answer") {
  const requests: CaseInvestigationModelRequest[] = [];
  const provider: NonNullable<CaseInvestigationRuntimeDeps["model"]["provider"]> = async request => {
    requests.push(request);
    const open = request.snapshot.body.openRequests.filter(row => row.status === "open");
    const understanding = { requests: open.map(row => ({ id: row.id, summary: "Export Google Sheet arrêté.", family: SAV_SMART_ENTRY_FAMILY, status: "open" })), newFacts: [] };
    if (kind === "team") return { status: "ok" as const, output: { caseVersion: request.snapshot.version, understanding,
      nextAction: { kind: "handoff", reason: "sensitive_request", requestIds: [open[0]!.id], report: { need: "Contestation d’un prélèvement.", expected: null, observed: null,
        trialIds: [], hypotheses: [], missingInformation: [], expectedIntervention: "Vérifier le paiement.", knowledge: [] } } } };
    return { status: "ok" as const, output: { caseVersion: request.snapshot.version, understanding,
      nextAction: { kind: "answer", requestIds: [open[0]!.id], steps: [{ text: "Relancer l’export depuis l’onglet Intégrations.", knowledge: ref }], expectedResult: "L’export se remplit." },
      reply: { text: FIRST_MAIL, citations: [ref], impossibilityClaims: [], accountAdvice: "none" } } };
  };
  return { provider, requests };
}

const DIM = 8;
function firstMailDeps(model = decisionModel()): ThreadlessFirstMailDeps {
  const vectors: CaseKnowledgeVectorSearch = { dimension: DIM, readRevision: async () => "kb-syn-r1", available: async () => true, search: async queries => queries.map(() => [card]) };
  const embed: CaseEmbeddingTransport = async ({ texts }) => ({ vectors: texts.map((_, i) => Array.from({ length: DIM }, (__, j) => (i + 1) / (j + 3))), usage: null });
  const spend: CaseEmbeddingSpendPort = { reserve: async () => ({ status: "allowed", reservationId: `res-${Date.now()}` }), settle: async () => undefined, release: async () => undefined };
  const investigation: CaseInvestigationRuntimeDeps = {
    mode: "observe", holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now: () => new Date(Date.now() + 6 * 60_000), leaseSeconds: 60,
    pauseState: async () => "running", readTicketOwner: async () => "v2", smartSupport: () => process.env.SAV_V2_ENTRY_SMART === "on",
    accessScope: (async () => null) as CaseInvestigationRuntimeDeps["accessScope"], admissionPolicyRevision: async () => "no-policy",
    qualify: async () => null, customerTexts: async () => ({}),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    ledger: caseCallLedgerOnStore, knowledge: { vectors, embed, spend },
    model: { money: async () => ({ status: "allowed" }), provider: model.provider },
  };
  return { env: () => process.env, investigation, provenance: provenanceDeps, readTicketOwner: async () => "v2",
    executionPolicy: { id: grant.id, hash: grant.policyHash }, accessSkill: source => readThreadlessAccessSkill(source, process.env, false) };
}
const port = (deps: ThreadlessFirstMailDeps): ThreadlessFirstMailPort => caseId => composeThreadlessFirstMail(caseId, deps);
const validations = (caseId: string) => f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, caseId));
const caseOf = async (ticketId: string) => (await f.db.select().from(savCases).where(eq(savCases.ticketId, ticketId)))[0];
const threadFor = async (s: ReturnType<typeof fixture>) => (await f.db.select().from(savThreads)
  .where(and(eq(savThreads.mailboxId, mailboxId), eq(savThreads.gmailThreadId, s.ack.threadId))))[0];

describe("SAV-138 : le premier mail d'un ticket créé depuis l'app, écrit par le cerveau smart", () => {
  it("premier tour : UN mail, une seule fois, au contact HubSpot, sur un nouveau fil ; le retour du client revient au même case, toujours smart", async () => {
    const s = fixture(), model = decisionModel();
    const started = await startV2FromThreadlessTicket(s.input, { firstMail: port(firstMailDeps(model)) });
    expect(started).toMatchObject({ status: "queued" });
    if (started.status !== "queued") throw Error("NOT_QUEUED");
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.customerContext?.latestMessage).toMatchObject({ text: QUESTION, subject: SUBJECT });
    expect(await readCase(started.caseId)).toMatchObject({ owner: "agent", admission: { admission: "smart_support" } });

    const [row, ...more] = await validations(started.caseId);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ state: "approved", decidedBy: APPROVER, executionId: started.executionId });
    const proposal = decryptSavPayload<CaseReplyProposal>(row!.proposalCiphertext);
    expect(proposal).toMatchObject({ recipient: CUSTOMER, subject: SUBJECT, inboundMessageId: null, ticketSource: { kind: "hubspot_ticket" } });
    expect(readCaseReplyDisclosure(proposal.text)?.mode).toBe("automated");
    expect(proposal.text).toContain("onglet Intégrations");

    expect((await s.run(started.executionId)).supervised).toMatchObject([{ state: "confirmed" }]);
    expect(s.counts).toMatchObject({ gmailPosts: 1, crmPosts: 1 });
    expect(s.sentMail()).toMatchObject({ to: CUSTOMER, subject: SUBJECT, body: proposal.text });
    const thread = await threadFor(s);
    expect(thread).toMatchObject({ hubspotTicketId: s.input.ticketId, customerEmail: CUSTOMER });
    expect(await readCase(started.caseId)).toMatchObject({ threadIds: [thread!.id], phase: "awaiting_customer" });
    // Idempotent: a second pass, and a second entry of the same ticket, send nothing more.
    await s.run(started.executionId);
    expect(await startV2FromThreadlessTicket(s.input, { firstMail: port(firstMailDeps(model)) })).toMatchObject({ status: "existing_thread" });
    expect(s.counts).toMatchObject({ gmailPosts: 1, crmPosts: 1 });
    expect(model.requests).toHaveLength(1);

    // The customer's reply on that new thread comes back to the same case (#362: it stays smart, the smart brain reads it).
    const [sent] = await f.db.select().from(savMessages).where(eq(savMessages.threadId, thread!.id));
    const inbound = await ingestInboundMessage({
      mailboxEmail: THREADLESS_MAILBOX, gmailThreadId: s.ack.threadId, gmailMessageId: `inbound-${s.input.ticketId}`,
      from: CUSTOMER, to: [THREADLESS_MAILBOX], subject: `Re: ${sent!.subject}`, bodyText: "Merci, mais l’export reste vide après la relance.",
      headers: { "message-id": "<inbound-app@example.invalid>", "in-reply-to": s.sentMail()!.rfcId }, receivedAt: new Date(),
    }, "gmail_full");
    expect(inbound.message.threadId).toBe(thread!.id);
    expect(await readCustomerReturnFacts(inbound.message.id, { env: process.env })).toMatchObject({ case: { caseId: started.caseId }, facts: { link: "one_case" } });
    expect(await routeCustomerReturn(inbound.message.id, { env: process.env, readTicketOwner: async () => OWNER }))
      .toMatchObject({ route: { route: "continue" }, caseId: started.caseId, written: true });
    const qualifyReturn = caseInvestigationReturnAwareQualify(async () => { throw Error("V1_FALLBACK_FORBIDDEN"); },
      { readPolicyRecord: async () => null, now: () => new Date(), smartSupport: () => true });
    const requalified = await qualifyReturn((await readCase(started.caseId))!, await listCaseEvents(started.caseId));
    expect(requalified?.admission.qualification.requests.length).toBeGreaterThan(0);
    expect(requalified!.admission.qualification.requests.every(request => isSmartSupportProvenance(request.provenance))).toBe(true);
    // The sender is recognised as the verified recipient of OUR first send (its subject is the ticket's own): identity and CRM context carry over.
    expect(requalified!.admission.qualification).toMatchObject({ identity: { status: "confirmed", source: { type: "hubspot_object", id: s.input.ticketId } }, crmContext: "complete" });
    expect(await f.db.select().from(savCases).where(eq(savCases.ticketId, s.input.ticketId))).toHaveLength(1);
  });

  it("sujet sensible (le cerveau smart passe la main) : rien n'est envoyé, le ticket va à l'équipe", async () => {
    const s = fixture({ content: "Bonjour, je conteste un prélèvement sur ma carte." }), model = decisionModel("team");
    const started = await startV2FromThreadlessTicket(s.input, { firstMail: port(firstMailDeps(model)) });
    expect(started).toMatchObject({ status: "human_wait" });
    expect(model.requests).toHaveLength(1);
    const opened = await caseOf(s.input.ticketId);
    expect(await validations(opened!.id)).toEqual([]);
    expect(await readCase(opened!.id)).toMatchObject({ owner: "human" });
    expect(s.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0 });
  });

  it("contact sans e-mail valide : à l'équipe, aucun appel au modèle, aucun mail", async () => {
    const s = fixture({ email: "pas-une-adresse" }), model = decisionModel();
    const started = await startV2FromThreadlessTicket(s.input, { firstMail: port(firstMailDeps(model)) });
    expect(started).toMatchObject({ status: "human_wait" });
    expect(model.requests).toHaveLength(0);
    expect(s.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0 });
  });

  it("réponse smart automatique non autorisée (SAV_V2_SMART_SUPPORT_MODE absent) : pas de brouillon en attente, le ticket va à l'équipe, aucun mail", async () => {
    vi.stubEnv("SAV_V2_SMART_SUPPORT_MODE", undefined);
    const s = fixture();
    const started = await startV2FromThreadlessTicket(s.input, { firstMail: port(firstMailDeps()) });
    expect(started).toMatchObject({ status: "human_wait" });
    expect(await readCase((started as { caseId: string }).caseId)).toMatchObject({ owner: "human", threadIds: [] });
    expect(s.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0 });
  });

  it.each(["shadow", "off"] as const)("mode %s : aucun premier mail (le case attend une personne, comme aujourd'hui)", async app => {
    await configure({ app });
    const s = fixture(), model = decisionModel(), firstMail = vi.fn<ThreadlessFirstMailPort>(port(firstMailDeps(model)));
    const started = await startV2FromThreadlessTicket(s.input, { firstMail });
    expect(started).toMatchObject({ status: "human_wait", reason: SAV_SMART_NO_THREAD_WAIT });
    expect(firstMail).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(0);
    expect(s.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0 });
  });

  it("ticket sans fil attribué par une personne (pas le marqueur app) : inchangé, smart_no_thread, aucun mail", async () => {
    const s = fixture({ app: false }), model = decisionModel(), firstMail = vi.fn<ThreadlessFirstMailPort>(port(firstMailDeps(model)));
    const started = await startV2FromThreadlessTicket(s.input, { firstMail });
    expect(started).toMatchObject({ status: "human_wait", reason: SAV_SMART_NO_THREAD_WAIT });
    expect(firstMail).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(0);
    expect(s.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0 });
  });

  it("le mode repasse à shadow entre l'approbation et l'envoi : rien ne part, le case va à l'équipe", async () => {
    const s = fixture();
    const started = await startV2FromThreadlessTicket(s.input, { firstMail: port(firstMailDeps()) });
    if (started.status !== "queued") throw Error("NOT_QUEUED");
    vi.stubEnv("SAV_APP_TICKETS_MODE", "shadow");
    expect((await s.run(started.executionId)).supervised).toMatchObject([{ state: "refused" }]);
    expect(s.counts).toMatchObject({ gmailPosts: 0, crmPosts: 0 });
    expect(await readCase(started.caseId)).toMatchObject({ owner: "human", threadIds: [] });
  });
});
