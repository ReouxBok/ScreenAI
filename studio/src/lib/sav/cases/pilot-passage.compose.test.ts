// Lot C (4/11, LOCAL, SYN): the V1 -> SAV Pilote passage on the REAL pipeline, no ledger fixture: V1's planner, admission, executor and HTTP adapters create the ticket on the
// synthetic HubSpot, A's relay reads the owner through A10's reader, B investigates (synthetic model behind a port), C stores the proposal and sends through the same executor
// on the synthetic Gmail. Three scenarios (connection on an existing account, a ticket a person holds, a mixed out-of-scope mail) and the race of a person taking the ticket AFTER
// V1's verification, at each window. Every id is invented; no network, no paid model, nothing production. HubSpot has no conditional write: what these tests prove is that every
// window closes on « a person keeps it », not that the comparison is atomic. The residual window (R4) is measured, not hidden.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
// No model is ever dispatched here: V1's analysis and B's provider are ports; every function of the real dispatcher throws if called.
vi.mock("../intake/model-dispatch", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => { throw Error(`MODEL_DISPATCH_FORBIDDEN:${name}`); } : value]));
});
import { savCaseEffectExecutions, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { planSavIntake, savIntakeEvidenceContentHash } from "../intake/engine";
import { createIntakeExecutorAdapters } from "../intake/execution-adapters";
import { approveIntakeExecutionPolicy, executionPolicySchema, intakeExecutionConfig, type ExecutionPolicy } from "../intake/execution-policy";
import { admitIntakeExecution, getExecutionEffects } from "../intake/execution-store";
import type { ExecutionOptions } from "../intake/execution-types";
import { executeIntakePass, readIntakeExecutionProgress } from "../intake/executor";
import { createSavIntakeHubspotReaders } from "../intake/hubspot-readers";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash, savIntakeRuntimeConfig, SAV_INTAKE_RUNTIME_REVISION } from "../intake/runtime-contract";
import { claimSavIntakeRun, enqueueSavIntakeMessage, saveSavIntakeResult } from "../intake/runtime-store";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { caseTicketOwnerPortFromTransport, hubspotTicketOwnerReader, type CaseOwnerReadTransport } from "./admission-owner-reader";
import { markSavCaseCallDispatched, releaseSavCaseCall, reserveSavCaseCall, settleSavCaseCall } from "./case-calls";
import { createCaseEffectDriver, ownerBeforeClaim } from "./case-effect-driver";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply, enqueueApprovedCaseReply, submitCaseReplyProposal } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { listCaseEvents, readCase, readCaseByTicket } from "./case-store";
import type { CaseAdmissionQualification, CaseSnapshot, KnowledgeRef } from "./case-types";
import { recordCaseAfterConfirmedIntake, sweepCaseRelays, type CaseBoundaryDeps } from "./intake-boundary";
import { caseCallLedgerAdapter, type CaseCallLedgerPort } from "./investigation-call-ledger";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import { caseDecisionDraft } from "./investigation-intent";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput, runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";
import { v2OwnerAtCreationPort } from "./owner-attribution";
import { pilotProvenanceGate, readPilotReplyProvenance, type PilotActiveSource, type PilotProvenanceDeps } from "./pilot-passage-provenance";
import { readPilotPassage } from "./pilot-passage-read";

vi.setConfig({ testTimeout: 60_000 });
const AT = "2026-11-04T07:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000004", PILOT = "90000042", TEAM = "80000001", PERSON = "70000042", SENDER = "client@example.invalid", ACCESS = "https://new.limova.ai";
const ENV = { SAV_V2_HUBSPOT_OWNER_ID: PILOT, HUBSPOT_SAV_OWNER_ID: TEAM, SAV_CASE_RECORDING: "on" };
const POLICY = { revision: "policy-syn-access-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-syn-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-syn-access", revision: "r1", at: AT } });
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "101" } };
/** Test precondition, never a production setting: « access » for every request, finance included, so a sensitive V1 hint must still win. */
const readQualification = async (input: { requests: { requestId: string }[] }): Promise<CaseAdmissionQualification> =>
  ({ requests: input.requests.map(request => ruled(request.requestId)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] });
const template = "SYNTHETIC exact template.\nSignature kept exactly.";
const mutations: ExecutionPolicy["mutations"] = ["create_ticket", "create_ticket_v2_owner", "link_ticket", "set_ticket_new", "append_ticket_note", "associate_email", "send_identity_template", "send_case_reply", "append_case_note"];

let f: Awaited<ReturnType<typeof createSavTestDb>>, p: ReturnType<typeof executionProvider>, options: ExecutionOptions, environment: Record<string, string | undefined>;
let mailboxId = "", grant: { id: string; policyHash: string }, sends = 0, modelCalls = 0;

const transport: CaseOwnerReadTransport = async ({ path }) => (await p.network(`https://api.hubapi.com${path}`)).json();
/** The real reader, on the same synthetic HubSpot V1 wrote to. */
const reader = () => hubspotTicketOwnerReader(transport);
const ownerPort = () => caseTicketOwnerPortFromTransport({ transport, env: ENV });
const crmReading = async (ticketId: string) => { try { return await ownerPort()({ ticketId }); } catch { return "read_failed" as const; } };
const relayDeps = (over: Partial<CaseBoundaryDeps> = {}): CaseBoundaryDeps =>
  ({ env: ENV, readAdmissionPolicy: async () => POLICY, readQualification, readCreatedTicketOwner: reader(), readProgress: readIntakeExecutionProgress, ...over });
const personTakes = (ticketId: string) => { p.objects.tickets[ticketId]!.properties.hubspot_owner_id = PERSON; };
const posts = () => p.calls.filter(call => call.method === "POST" && call.path.endsWith("/tickets"));
const ownerWrites = () => p.calls.filter(call => call.method === "PATCH" && Object.hasOwn((call.body as { properties?: object })?.properties ?? {}, "hubspot_owner_id"));

/** A stored mail and V1's real analysis on the synthetic HubSpot: an accepted semantic record, as `analyseSavIntakeRuntime` leaves it, so the relay reads a real subject. */
async function v1Observed(kinds: string[], relation: "same" | null = null, text = "Synthétique : je n'arrive plus à me connecter à mon compte.") {
  const threadId = randomUUID(), gmail = `gm-${randomUUID()}`;
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Connexion", customerEmail: SENDER });
  const [message] = await f.db.insert(savMessages).values({ threadId, mailboxId, direction: "inbound", gmailMessageId: gmail, fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Connexion impossible",
    bodyCiphertext: encryptSavPayload({ text, headers: { "message-id": `<${gmail}@example.invalid>` }, attachments: [] }), receivedAt: new Date() }).returning();
  const messageId = message!.id;
  p.setGmail(gmail, `thread-${threadId}`);
  const runtime = options.runtime, id = (await enqueueSavIntakeMessage(messageId, runtime))!, lease = (await claimSavIntakeRun(id, runtime))!;
  const requests = kinds.map((kind, i) => ({ id: `r${i}`, kind, currentMessageId: messageId }));
  const analysis = { messageId, requests, ticketSummary: { title: "Connexion impossible", description: "Le code de connexion n'arrive pas.", requestIds: requests.map(request => request.id) } };
  const plan = await planSavIntake(lease.input, {
    ...createSavIntakeHubspotReaders({ network: p.network }),
    analyseMessage: async () => analysis as never,
    assessIssues: async ({ tickets, requests: asked }) => ({ investigationComplete: true, tickets: tickets.map(({ ticket }) => ({ ticketId: ticket.id, relation: relation ?? "different", requestIds: asked.map(request => request.id), evidenceIds: ["current", `ticket-${ticket.id}`, `history-${ticket.id}`] })) }) as never,
  }, runtime.policy, {}, () => new Date());
  const input = { message: { id: messageId }, attempt: 0 };
  await saveSavIntakeResult(lease, runtime, { revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected", plan, input: lease.input,
    semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION, records: [{ method: "analyseMessage", input, result: analysis, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(analysis), acceptedAt: AT }] } } as never, "observed");
  const row = await admitIntakeExecution(id, options);
  if (!row) throw Error("V1_NOT_ADMITTED");
  return { messageId, gmail, executionId: row.id };
}
async function v1Confirmed(kinds: string[] = ["support"], relation: "same" | null = null) {
  const mail = await v1Observed(kinds, relation);
  expect(await executeIntakePass(mail.executionId, options)).toMatchObject({ state: "confirmed" });
  const ticketId = (await readIntakeExecutionProgress(mail.messageId))!.ticketId!;
  return { ...mail, ticketId };
}

/** Invented dates, fixed so the export is reproducible; only the provenance reader judges them, on this clock. */
const SYN_VERIFIED_AT = "2026-10-25T09:00:00.000Z", SYN_NOW = new Date("2026-11-04T07:00:00.000Z"), daysBefore = (days: number) => new Date(SYN_NOW.getTime() - days * 86_400_000).toISOString();
const card = (id: string): SavRetrievalCandidate => ({ id, contentVersionId: `${id}-v1`, title: `Fiche ${id} (synthétique)`, content: "Procédure synthétique.", source: "fixture",
  verifiedAt: SYN_VERIFIED_AT, semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } });
const LOGIN = card("k-syn-login");
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });
/** Test precondition, invented, approved by nobody: the scope a pilot policy would carry, and the versions a reader would call active. No real sheet, no real approval. */
const synScope = (over: Record<string, unknown> = {}) => ({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: POLICY.revision, revision: "scope-syn-r1", family: "access", sources: [{ knowledgeId: LOGIN.id, contentVersionId: LOGIN.contentVersionId, use: "answer" }], ...over });
let scope: unknown = synScope(), activeSource: PilotActiveSource | null | "throw" = null;
const provenanceDeps: PilotProvenanceDeps = { accessScope: async () => scope, currentPolicyRevision: async () => POLICY.revision,
  readActiveSource: async () => { if (activeSource === "throw") throw Error("SYNTHETIC_READ_FAILED"); return activeSource; }, now: () => SYN_NOW };
const provenance = pilotProvenanceGate(provenanceDeps);
const backend: SavRetrievalBackend = { readRevision: async () => "kb-syn-r1", search: async queries => queries.map(query => /connexion/i.test(query) ? [LOGIN] : []) };
const realLedger: CaseCallLedgerPort = { reserve: reserveSavCaseCall, markDispatched: markSavCaseCallDispatched, settle: settleSavCaseCall, release: releaseSavCaseCall };
async function investigate(caseId: string) {
  const now = () => new Date(Date.now() + 6 * 60_000);
  const provider = async (request: CaseInvestigationModelRequest) => {
    modelCalls += 1;
    const snapshot: CaseSnapshot = request.snapshot, open = snapshot.body.openRequests.filter(row => row.status === "open");
    return { status: "ok" as const, output: { caseVersion: snapshot.version, understanding: { requests: open.map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
      nextAction: { kind: "answer", requestIds: [open[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: refOf(LOGIN) }], expectedResult: "La connexion fonctionne." },
      reply: { text: `Bonjour, voici la marche à suivre depuis ${ACCESS} : suivre la fiche.`, citations: [refOf(LOGIN)], impossibilityClaims: [], accountAdvice: "none" } } };
  };
  const ports = caseInvestigationStorePorts({
    readTicketOwner: ownerPort(), holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: caseCallLedgerAdapter({ ledger: realLedger, money: async () => ({ status: "allowed" }), provider, holder: "sav-v2-investigation", leaseSeconds: 60, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS }),
    admissionPolicyRevision: async () => POLICY.revision,
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      return latest ? { admission: { policy: POLICY, qualification: { requests: snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id)), identity: CONFIRMED, crmContext: "complete" as const, teamSignals: [] } }, sourceRef: latest.sourceRef } : null;
    },
  });
  return runCaseInvestigation(caseId, "observe", { ...ports, accessScope: async () => scope });
}
async function proposalOf(caseId: string, messageId: string): Promise<CaseReplyProposal> {
  const events = await listCaseEvents(caseId), read = readCaseInvestigationProgress(events, latestInvestigationInput(events)!);
  if (read.state !== "found") throw Error(`NO_RECORD:${read.state}`);
  const current = scope as { revision: string; policyRevision: string };
  const draft = caseDecisionDraft(caseId, read.record, events, { accessScope: { revision: current.revision, policyRevision: current.policyRevision } });
  if (!draft?.reply || !draft.triggerEventId) throw Error("NO_REPLY_DRAFTED");
  return { caseId, caseVersion: (await readCase(caseId))!.version, triggerEventId: draft.triggerEventId, inboundMessageId: messageId, recipient: SENDER, subject: "Accès à la plateforme", ...draft.reply, text: finalReplyText(draft.reply.text) };
}
const storeDeps = () => ({ env: () => environment, readTicketOwner: ownerPort(), currentPolicyRevision: async () => POLICY.revision, pilotProvenance: provenance });
const driver = () => createCaseEffectDriver({ env: () => environment, readTicketOwner: ownerPort(), currentPolicyRevision: async () => POLICY.revision, pilotProvenance: provenance });
const allowFixture: CaseReplyAuthorizer = () => ({ allowed: true, basis: "fixture.allow" });
const seenOf = (proposal: CaseReplyProposal) => ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient });
async function approve(validationId: string, proposal: CaseReplyProposal) {
  return decideCaseReply({ action: "approve", validationId, approverId: STAFF, seen: seenOf(proposal), authorizer: allowFixture, deps: storeDeps() });
}
/** Up to a reply queued by a person's approval, on the case the passage gave the agent. */
async function agentCase() {
  const mail = await v1Confirmed();
  const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps()) as { caseId: string; owner: string };
  expect(relayed.owner).toBe("agent");
  return { ...mail, caseId: relayed.caseId };
}
async function queued() {
  const mail = await agentCase();
  expect(await investigate(mail.caseId)).toMatchObject({ status: "recorded", outcome: "accepted" });
  const proposal = await proposalOf(mail.caseId, mail.messageId);
  const submitted = await submitCaseReplyProposal(proposal, storeDeps());
  if (!submitted.ok) throw Error(`SUBMIT_REFUSED:${submitted.code}`);
  const decided = await approve(submitted.id, proposal);
  if (!decided.ok) throw Error(`APPROVE_REFUSED:${decided.code}`);
  const enqueued = await enqueueApprovedCaseReply({ validationId: submitted.id, policy: { id: grant.id, hash: grant.policyHash }, deps: storeDeps() });
  if (!enqueued.ok) throw Error(`ENQUEUE_REFUSED:${enqueued.code}`);
  return { ...mail, proposal, validationId: submitted.id, replyExecutionId: enqueued.executionId };
}
const attributions = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "owner_changed" && (event.detail as { transition?: string }).transition === "v2_attribution");
const passage = async (ticketId: string) => readPilotPassage((await readCaseByTicket(ticketId))!, await crmReading(ticketId));
const counters = () => ({ modelCalls, ticketPosts: posts().length, ownerWrites: ownerWrites().length, mailsSent: sends });

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 120_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => { });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  await f.client.exec("TRUNCATE sav.cases, sav.case_events, sav.case_timers CASCADE; TRUNCATE sav.intake_identity_episodes,sav.intake_effect_journal,sav.intake_effects,sav.intake_occupations,sav.intake_executions,sav.intake_execution_policies,sav.intake_model_calls,sav.mailboxes CASCADE; DELETE FROM public.staff_users; TRUNCATE public.audit_logs; UPDATE sav.intake_execution_budget SET admitted=0; DELETE FROM sav.sync_state WHERE key='sav-intake-execution-scan-v1'");
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  await f.db.insert(savSyncState).values({ key: "sav-intake-execution-schema-v1", status: "installed" }).onConflictDoNothing();
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-passage-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
  state.user = { id: admin!.clerkId, primaryEmailAddress: { emailAddress: admin!.email, verification: { status: "verified" } } };
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
  const ref = { resourceId: "synthetic-template", revisionId: "v1", sha256: createHash("sha256").update(template).digest("hex") };
  const catalogue = [{ resource: ref, text: template, approvalId: "synthetic-approval", approvedBy: "synthetic-admin", approvedAt: new Date(Date.now() - 1000).toISOString(), status: "approved" }];
  const enginePolicy = { relationRevision: "synthetic-relations", admittedRelations: [{ category: "HUBSPOT_DEFINED", typeId: 449 }], resources: { identification: ref, registrationNotFound: ref } };
  environment = { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake", HUBSPOT_ACCESS_TOKEN: "fake", SAV_ENCRYPTION_KEY_V1: process.env.SAV_ENCRYPTION_KEY_V1,
    SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(enginePolicy), SAV_INTAKE_RUNTIME_RESOURCES: JSON.stringify(catalogue), SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId, createdAfter: new Date(Date.now() - 10000).toISOString(), receivedAfter: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(enginePolicy), resourcesHash: intakeRuntimeHash(catalogue), maxCalls: 30, maxNanoUsd: 3000000000 }) };
  const runtime = savIntakeRuntimeConfig(environment)!;
  const policy: ExecutionPolicy = executionPolicySchema.parse({ revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: runtime.codeRevision, enginePolicyHash: runtime.policyHash, resourcesHash: runtime.resourcesHash, createdAfter: runtime.createdAfter,
    receivedAfter: runtime.receivedAfter, expiresAt: runtime.expiresAt, maxDossiers: 10, mutations, admission: { kind: "automatic" } });
  grant = await approveIntakeExecutionPolicy(policy);
  environment = { ...environment, SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: grant.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: grant.policyHash, SAV_CASE_EFFECTS: "supervised" };
  p = executionProvider(SENDER); sends = 0; modelCalls = 0; scope = synScope();
  activeSource = { active: true, title: LOGIN.title, content: LOGIN.content, verifiedAt: LOGIN.verifiedAt };
  const adapters = createIntakeExecutorAdapters({ network: p.network, gmailRequest: async <T>(mailbox: string, path: string, init?: RequestInit) => { if (path === "messages/send") sends += 1; return p.gmail<T>(mailbox, path, init); }, gmailPermissions: async () => { }, env: () => environment });
  options = { runtime, policy, config: intakeExecutionConfig(environment)!, env: () => environment, signal: AbortSignal.timeout(50_000), adapters: { ...adapters, v2OwnerAtCreation: (input: Parameters<ReturnType<typeof v2OwnerAtCreationPort>>[0]) => v2OwnerAtCreationPort(relayDeps())(input) } };
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("production V1 adapter attributes only new, personally scoped login tickets", () => {
  it.each([
    ["Je ne reçois pas le code de connexion à mon compte.", "on", true, PILOT],
    ["Je souhaite exporter un tableau.", "on", true, null],
    ["Je ne peux pas me connecter et je veux modifier mon adresse mail.", "on", true, null],
    ["Je ne peux pas me connecter et je souhaite résilier.", "on", true, null],
    ["Impossible de me connecter, je veux inviter mon collaborateur.", "on", true, null],
    ["Je ne peux pas me connecter.", "off", true, null],
    ["Je ne peux pas me connecter.", "on", false, null],
  ] as const)("%s / entrée %s / droit %s", async (body, entry, permission, expected) => {
    Object.assign(environment, ENV, { SAV_V2_ENTRY: entry,
      SAV_V2_ADMISSION_POLICY_JSON: JSON.stringify({policy: POLICY, validFrom: "2025-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z"}),
      SAV_V2_ADAPTER_POLICY_JSON: JSON.stringify({revision: "r1", decidedBy: STAFF, identity: "sender_unique_crm_match"}),
      SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([{v1Kind: "support", family: "access", ruleId: "rule-syn-access", revision: "r1", at: AT}]),
    });
    options.adapters.v2OwnerAtCreation = createIntakeExecutorAdapters({env: () => environment}).v2OwnerAtCreation;
    if (!permission) options.policy = {...options.policy, mutations: options.policy.mutations.filter(m => m !== "create_ticket_v2_owner")};
    const mail = await v1Observed(["support"], null, body);
    expect(await executeIntakePass(mail.executionId, options)).toMatchObject({state: "confirmed"});
    expect(posts()).toHaveLength(1);
    expect((posts()[0].body as {properties: Record<string, unknown>}).properties.hubspot_owner_id ?? null).toBe(expected);
    expect(ownerWrites()).toEqual([]);
  });
});

/** One row of the SYN export for UX, from what the real pipeline left, without any random id or clock. The sources come from the recorded decision, never from the proposal. */
async function exported(ref: string, label: string, ticketId: string, proposal: CaseReplyProposal | null, extra: Record<string, unknown> = {}) {
  const view = await passage(ticketId);
  const read = proposal ? await readPilotReplyProvenance(proposal, provenanceDeps) : null;
  if (read && read.status !== "proven") throw Error(`EXPORT_UNPROVEN:${read.reasons.join(",")}`);
  return { ref, label, passage: { state: view.state, situation: view.situation, v2Work: view.v2Work, ownerWrite: view.ownerWrite, atomicOwnerCompare: view.atomicOwnerCompare, caseOwner: view.caseOwner, crmReading: view.crmReading, admission: view.admission },
    decision: read ? { status: "accepted", contract: read.decision.contract, decidedOn: read.decision.decidedOn, scope: read.scope } : null,
    sourcesStatus: read ? "proven_from_decision" : "no_search_case_with_team",
    sources: read ? read.sources.map(source => ({ knowledgeId: source.knowledgeId, contentVersionId: source.contentVersionId, permission: source.use, title: source.title, content: source.content, verifiedAt: source.verifiedAt, verification: source.verification, evaluatedAt: source.evaluatedAt })) : [],
    draft: proposal ? { status: "awaiting_validation", validatable: true, purpose: proposal.purpose, subject: proposal.subject, text: proposal.text } : null,
    counters: counters(), ...extra };
}
const FIXTURE = join(__dirname, "fixtures", "syn-pilot-passage.v1.json");
const exportRows: Record<string, unknown>[] = [];

describe("three scenarios on the real pipeline, each down to what a person would see; never a send without a person's approval", () => {
  it("SYN-P1 connection on an existing account: V1 POST carries the V2 owner, relay reads it, B investigates once, C stores a draft with the AI mention, unsent; once approved it leaves once", async () => {
    const mail = await v1Confirmed();
    expect(posts()).toHaveLength(1);
    expect((posts()[0]!.body as { properties: Record<string, unknown> }).properties.hubspot_owner_id).toBe(PILOT);
    expect(ownerWrites()).toEqual([]);
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps()) as { caseId: string };
    expect(relayed).toMatchObject({ created: true, owner: "agent", admission: { target: "agent" } });
    expect(await attributions(relayed.caseId)).toMatchObject([{ detail: { reason: "hubspot_owner_at_creation", proof: { ownerId: PILOT, ticketId: mail.ticketId } } }]);
    expect(await passage(mail.ticketId)).toMatchObject({ state: "agent_ready", v2Work: true, atomicOwnerCompare: "not_proven" });
    expect(await investigate(relayed.caseId)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    const proposal = await proposalOf(relayed.caseId, mail.messageId);
    expect(await readPilotReplyProvenance(proposal, provenanceDeps)).toMatchObject({ status: "proven", scope: { revision: "scope-syn-r1", policyRevision: POLICY.revision },
      sources: [{ knowledgeId: LOGIN.id, contentVersionId: LOGIN.contentVersionId, use: "answer", title: LOGIN.title }] });
    expect(proposal.text).toBe(finalReplyText(proposal.text));
    expect(proposal.text).toMatch(/IA/);
    const submitted = await submitCaseReplyProposal(proposal, storeDeps());
    if (!submitted.ok) throw Error(`SUBMIT_REFUSED:${submitted.code}`);
    expect(sends).toBe(0);
    exportRows.push(await exported("SYN-P1", "Connexion, compte existant, nouveau ticket", mail.ticketId, proposal));
    expect(await approve(submitted.id, proposal)).toMatchObject({ ok: true });
    expect(sends).toBe(0);
    const enqueued = await enqueueApprovedCaseReply({ validationId: submitted.id, policy: { id: grant.id, hash: grant.policyHash }, deps: storeDeps() });
    if (!enqueued.ok) throw Error(`ENQUEUE_REFUSED:${enqueued.code}`);
    expect(await executeIntakePass(enqueued.executionId, options, {}, driver())).toMatchObject({ state: "confirmed" });
    expect(sends).toBe(1);
    expect(await executeIntakePass(enqueued.executionId, options, {}, driver())).toEqual({ skipped: "occupied" });
    expect(sends).toBe(1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it("SYN-P2 an existing ticket a person holds: V1 attaches the mail, one owner read, team keeps it; no model call, no draft, the store refuses a forced one, no send", async () => {
    const ticketId = p.seedTicket({ ownerId: PERSON, stage: "open" as never });
    p.histories.length = 0;
    const mail = await v1Confirmed(["support"], "same");
    expect(mail.ticketId).toBe(ticketId);
    expect(posts()).toEqual([]);
    expect(ownerWrites()).toEqual([]);
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps()) as { caseId: string };
    expect(relayed).toMatchObject({ owner: "human", admission: { target: "agent" } });
    expect(await attributions(relayed.caseId)).toEqual([]);
    expect(await investigate(relayed.caseId)).toMatchObject({ status: "skipped", reason: "not_agent_owned", modelCalls: 0 });
    expect(await passage(mail.ticketId)).toMatchObject({ state: "team_person", v2Work: false, crmReading: "human" });
    const opened = (await readCase(relayed.caseId))!;
    const forced = await submitCaseReplyProposal({ caseId: relayed.caseId, caseVersion: opened.version, triggerEventId: `inbound:${mail.gmail}`, inboundMessageId: mail.messageId, purpose: "answer", recipient: SENDER, subject: "Accès", text: finalReplyText(`Bonjour, depuis ${ACCESS}.`) }, storeDeps());
    expect(forced).toMatchObject({ ok: false });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, relayed.caseId))).toHaveLength(0);
    exportRows.push(await exported("SYN-P2", "Ticket tenu par une personne", mail.ticketId, null, { refusedDraftCode: (forced as { code: string }).code }));
    expect(sends).toBe(0); expect(modelCalls).toBe(0);
  });
  it("SYN-P3 connection + billing in one mail: finance wins, POST without owner, team keeps it; no owner read by the relay, no model call, no draft, no send", async () => {
    const mail = await v1Confirmed(["support", "finance"]);
    expect(Object.keys((posts()[0]!.body as { properties: object }).properties)).not.toContain("hubspot_owner_id");
    const reads = vi.fn(reader());
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps({ readCreatedTicketOwner: reads })) as { caseId: string };
    expect(relayed).toMatchObject({ owner: "human", admission: { target: "team" } });
    expect(reads).not.toHaveBeenCalled();
    expect(await readCase(relayed.caseId)).toMatchObject({ sensitivity: "finance" });
    expect(await investigate(relayed.caseId)).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(await passage(mail.ticketId)).toMatchObject({ state: "team_out_of_scope", v2Work: false });
    exportRows.push(await exported("SYN-P3", "Mixte : connexion et facturation", mail.ticketId, null));
    expect(sends).toBe(0); expect(modelCalls).toBe(0);
  });
});

describe("the race: a person takes the ticket AFTER V1 verified its creation, at each window. No compare-and-set exists; every window ends with the person keeping it", () => {
  it("SYN-R1 before the relay reads: the fresh read sees the person, the case stays with the team, no attribution, no write", async () => {
    const mail = await v1Confirmed();
    personTakes(mail.ticketId);
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps()) as { caseId: string; owner: string };
    expect(relayed.owner).toBe("human");
    expect(await attributions(relayed.caseId)).toEqual([]);
    expect(await passage(mail.ticketId)).toMatchObject({ state: "team_person", v2Work: false });
    expect(ownerWrites()).toEqual([]);
  });
  it("SYN-R2 between the relay's read and its commit: the read says V2, the person wins just after: the post-commit read hands the case back to the team at once, and no new work ever starts", async () => {
    const mail = await v1Confirmed();
    const racing = vi.fn(async (ticketId: string) => { const owner = await reader()(ticketId); if (racing.mock.calls.length === 1) personTakes(ticketId); return owner; });
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps({ readCreatedTicketOwner: racing })) as { caseId: string; owner: string };
    expect(racing).toHaveBeenCalledTimes(2);
    expect(relayed.owner).toBe("human");
    expect(await readCaseByTicket(mail.ticketId)).toMatchObject({ owner: "human", phase: "human_owned" });
    expect(await passage(mail.ticketId)).toMatchObject({ state: "team_person", v2Work: false, crmReading: "human" });
    expect(await investigate(relayed.caseId)).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(sends).toBe(0); expect(ownerWrites()).toEqual([]);
    exportRows.push({ ref: "SYN-R2", label: "Prise humaine entre la lecture du relais et son enregistrement", passage: { state: "team_person", atomicOwnerCompare: "not_proven" }, counters: counters() });
  });
  it("SYN-R2b the post-commit read itself fails: the case stays locally the agent's, but it is unconfirmed, and every step refuses until the owner reads V2 again", async () => {
    const mail = await v1Confirmed();
    let n = 0;
    const failing = async (ticketId: string) => { n += 1; if (n === 2) { personTakes(ticketId); throw Error("SYNTHETIC_HTTP_503"); } return reader()(ticketId); };
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps({ readCreatedTicketOwner: failing })) as { caseId: string; owner: string };
    expect(relayed.owner).toBe("agent");
    expect(await passage(mail.ticketId)).toMatchObject({ state: "person_took_after_verification", v2Work: false, caseOwner: "agent", crmReading: "human" });
    expect(await investigate(relayed.caseId)).toMatchObject({ modelCalls: 0 });
    expect(modelCalls).toBe(0); expect(sends).toBe(0);
  });
  it("SYN-R3 after the approval, at each look before the provider: before the claim, between the marker and the last look: 0 mail, the reply is cancelled for good, nothing is written on the ticket", async () => {
    const beforeClaim = await queued();
    personTakes(beforeClaim.ticketId);
    expect(await ownerBeforeClaim(beforeClaim.replyExecutionId, ownerPort())).toMatchObject({ ok: false, code: "owner_human", ended: true });
    expect(sends).toBe(0);
    expect(ownerWrites()).toEqual([]);
  });
  it("SYN-R3b a person takes the ticket after the marker, before the last look: the marker is withdrawn, 0 mail", async () => {
    const mail = await queued();
    const result = await executeIntakePass(mail.replyExecutionId, options, { afterMarker: async () => { personTakes(mail.ticketId); } }, driver());
    expect(result).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_HUMAN" });
    expect(sends).toBe(0);
    expect((await getExecutionEffects(mail.replyExecutionId)).find(effect => effect.kind === "reply_send")).toMatchObject({ state: "planned" });
    expect(await passage(mail.ticketId)).toMatchObject({ v2Work: false, crmReading: "human" });
    exportRows.push({ ref: "SYN-R3", label: "Prise humaine après validation, avant le dernier contrôle", passage: { state: "person_took_after_verification", atomicOwnerCompare: "not_proven" }, counters: counters() });
  });
  it("SYN-R4 THE RESIDUAL WINDOW, measured: a person takes it after the last look, while the send is in transit: the mail leaves, once, is verified, never repeated, and the agent starts nothing more", async () => {
    const mail = await queued();
    const dispatch = options.adapters.dispatch;
    options.adapters.dispatch = async (intent, signal) => { if (intent.kind === "reply_send") personTakes(mail.ticketId); return dispatch(intent, signal); };
    await executeIntakePass(mail.replyExecutionId, options, {}, driver());
    options.adapters.dispatch = dispatch;
    expect(sends).toBe(1);
    expect((await getExecutionEffects(mail.replyExecutionId)).find(effect => effect.kind === "reply_send")).toMatchObject({ state: "confirmed" });
    await executeIntakePass(mail.replyExecutionId, options, {}, driver());
    expect(sends).toBe(1);
    expect(await passage(mail.ticketId)).toMatchObject({ state: "person_took_after_verification", v2Work: false, atomicOwnerCompare: "not_proven" });
    expect(ownerWrites()).toEqual([]);
    exportRows.push({ ref: "SYN-R4", label: "Fenêtre résiduelle : prise humaine pendant l'envoi", passage: { state: "person_took_after_verification", atomicOwnerCompare: "not_proven" }, residualWindow: true, counters: counters() });
  });
});

describe("Ugo 4/11, on the real pipeline: the ticket's owner already reads V2 and the connection mail is admitted. V1 attributes nothing; V2 still processes it", () => {
  const noWrite = () => { expect(ownerWrites()).toEqual([]); expect(sends).toBe(0); };
  const noReply = async (caseId: string) => expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, caseId))).toHaveLength(0);
  it("an existing ticket under the V2 owner: V1 attaches (no POST, no owner write), the real relay and store give it to the agent, one investigation; the replay and a new run call no model again; no mail, no draft", async () => {
    const ticketId = p.seedTicket({ ownerId: PILOT, stage: "open" as never });
    p.histories.length = 0;
    const mail = await v1Confirmed(["support"], "same");
    expect(mail.ticketId).toBe(ticketId);
    expect(posts()).toEqual([]);
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps()) as { caseId: string; owner: string };
    expect(relayed.owner).toBe("agent");
    expect(await attributions(relayed.caseId)).toMatchObject([{ detail: { reason: "hubspot_owner_read", proof: { kind: "hubspot_owner_read", messageId: mail.messageId, ticketId } } }]);
    expect(await passage(ticketId)).toMatchObject({ state: "agent_ready", v2Work: true, ownerWrite: false, atomicOwnerCompare: "not_proven" });
    expect(await investigate(relayed.caseId)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    const version = (await readCase(relayed.caseId))!.version;
    expect(await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps())).toMatchObject({ appended: false, owner: "agent" });
    expect((await sweepCaseRelays({ limit: 200, deps: relayDeps() }))).toMatchObject({ failed: {} });
    await investigate(relayed.caseId);
    expect(modelCalls).toBe(1);
    expect((await readCase(relayed.caseId))!.version).toBe(version);
    expect(await attributions(relayed.caseId)).toHaveLength(1);
    await noReply(relayed.caseId); noWrite();
  });
  it("a case already waiting after the relay (the read failed): the investigation refuses it, the sweep moves it once with no new event, then one investigation; no mail, no draft", async () => {
    const ticketId = p.seedTicket({ ownerId: PILOT, stage: "open" as never });
    const mail = await v1Confirmed(["support"], "same");
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps({ readCreatedTicketOwner: async () => { throw Error("SYNTHETIC_HTTP_503"); } })) as { caseId: string; owner: string };
    expect(relayed.owner).toBe("human");
    expect(await passage(ticketId)).toMatchObject({ state: "agent_pending_owner_read", v2Work: false });
    expect(await investigate(relayed.caseId)).toMatchObject({ status: "skipped", modelCalls: 0 });
    const inbound = async () => (await listCaseEvents(relayed.caseId)).filter(event => event.kind === "inbound_confirmed").length;
    expect(await inbound()).toBe(1);
    expect(await sweepCaseRelays({ limit: 200, deps: relayDeps() })).toMatchObject({ recovered: 1, failed: {} });
    expect(await inbound()).toBe(1);
    expect(await investigate(relayed.caseId)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    await sweepCaseRelays({ limit: 200, deps: relayDeps() });
    await investigate(relayed.caseId);
    expect(modelCalls).toBe(1);
    expect(await attributions(relayed.caseId)).toHaveLength(1);
    await noReply(relayed.caseId); noWrite();
  });
  it("a person takes the ticket after the move, before the investigation: the fresh read of the runner stops it, no model call", async () => {
    const ticketId = p.seedTicket({ ownerId: PILOT, stage: "open" as never });
    const mail = await v1Confirmed(["support"], "same");
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps()) as { caseId: string; owner: string };
    expect(relayed.owner).toBe("agent");
    personTakes(ticketId);
    expect(await investigate(relayed.caseId)).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(modelCalls).toBe(0);
    await noReply(relayed.caseId); noWrite();
  });
  it("a ticket nobody owns: not taken, one read, no write, no model call, also after the sweep", async () => {
    const ticketId = p.seedTicket({ ownerId: null as never, stage: "open" as never });
    const mail = await v1Confirmed(["support"], "same");
    const relayed = await recordCaseAfterConfirmedIntake(mail.messageId, relayDeps()) as { caseId: string; owner: string };
    expect(relayed.owner).toBe("human");
    await sweepCaseRelays({ limit: 200, deps: relayDeps() });
    expect(await passage(ticketId)).toMatchObject({ state: "team_waiting_owner", v2Work: false });
    expect(await investigate(relayed.caseId)).toMatchObject({ status: "skipped", modelCalls: 0 });
    await noReply(relayed.caseId); noWrite();
  });
});

describe("provenance of a pilot reply, recomputed from the recorded decision: no proof, not validatable, not queued, not sent", () => {
  /** A case up to a stored, unapproved proposal. */
  async function proposed() {
    const mail = await agentCase();
    expect(await investigate(mail.caseId)).toMatchObject({ status: "recorded", outcome: "accepted" });
    const proposal = await proposalOf(mail.caseId, mail.messageId), submitted = await submitCaseReplyProposal(proposal, storeDeps());
    if (!submitted.ok) throw Error(`SUBMIT_REFUSED:${submitted.code}`);
    return { ...mail, proposal, validationId: submitted.id };
  }
  it.each<[string, () => void, string]>([
    ["the scope changed since the decision", () => { scope = synScope({ revision: "scope-syn-r2" }); }, "access_scope_changed"],
    ["the scope cannot be read as one", () => { scope = { not: "a scope" }; }, "scope_invalid"],
    ["no scope", () => { scope = null; }, "scope_missing"],
    ["the scope belongs to another policy", () => { scope = synScope({ policyRevision: "policy-other" }); }, "scope_policy_mismatch"],
    ["the version is unknown to the reader", () => { activeSource = null; }, "source_version_unknown"],
    ["the reader fails", () => { activeSource = "throw"; }, "source_version_unknown"],
    ["the check date is absent", () => { activeSource = { ...activeSource as PilotActiveSource, verifiedAt: null }; }, "source_unverified"],
    ["the check date is in the future", () => { activeSource = { ...activeSource as PilotActiveSource, verifiedAt: "2026-11-05T07:00:00.000Z" }; }, "source_unverified"],
    ["the check date is a constant, not a date", () => { activeSource = { ...activeSource as PilotActiveSource, verifiedAt: "synthetic_10_days_before_the_run" }; }, "source_unverified"],
    ["the check date is a bare year", () => { activeSource = { ...activeSource as PilotActiveSource, verifiedAt: "2010" }; }, "source_unverified"],
    ["the check date is more than 90 days old, the existing limit", () => { activeSource = { ...activeSource as PilotActiveSource, verifiedAt: daysBefore(91) }; }, "source_stale"],
    ["the source was retired", () => { activeSource = { active: false, title: "x", content: "x", verifiedAt: null }; }, "source_retired"],
  ])("%s: the approval is refused with the reason, nothing is queued or sent; the draft can still be declined", async (_label, change, reason) => {
    const mail = await proposed();
    change();
    expect(await approve(mail.validationId, mail.proposal)).toMatchObject({ ok: false, code: "provenance_unproven", detail: reason });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, mail.caseId))).toHaveLength(0);
    expect(await decideCaseReply({ action: "decline", validationId: mail.validationId, approverId: STAFF, seen: seenOf(mail.proposal), authorizer: allowFixture, deps: storeDeps() })).toMatchObject({ ok: true });
    expect(sends).toBe(0);
  });
  it("a text the decision did not write proves nothing, even with a good scope: an edited draft is not validatable", async () => {
    const mail = await proposed();
    const edited = { ...mail.proposal, text: finalReplyText(`Bonjour, depuis ${ACCESS}, autre texte que la décision n'a pas écrit.`) };
    expect(await readPilotReplyProvenance(edited, provenanceDeps)).toMatchObject({ status: "unproven", reasons: ["reply_not_from_decision"] });
  });
  it.each<[string, Record<string, string>, string]>([
    ["orient only", { knowledgeId: LOGIN.id, contentVersionId: LOGIN.contentVersionId, use: "orient_only" }, "access_source_orient_only"],
    ["another version", { knowledgeId: LOGIN.id, contentVersionId: "k-syn-login-v0", use: "answer" }, "access_source_version_out_of_scope"],
    ["another sheet", { knowledgeId: "k-syn-other", contentVersionId: "v1", use: "answer" }, "access_source_out_of_scope"],
  ])("the decision's source is outside the scope (%s): the real validator refuses the answer, no reply is drafted, nothing can be proposed", async (_label, source, code) => {
    scope = synScope({ sources: [source] });
    const mail = await agentCase();
    const run = await investigate(mail.caseId);
    expect(run).toMatchObject({ status: "recorded", outcome: "needs_review", refusal: { codes: expect.arrayContaining([code]) } });
    await expect(proposalOf(mail.caseId, mail.messageId)).rejects.toThrow(/NO_REPLY_DRAFTED|NO_RECORD|NO_DRAFT/);
    expect(sends).toBe(0);
  });
  it("a decision recorded with no scope port has no stamp: unknown to a pilot consumer, not validatable", async () => {
    const mail = await agentCase();
    const saved = scope;
    expect(await investigate(mail.caseId)).toMatchObject({ status: "recorded" });
    const proposal = await proposalOf(mail.caseId, mail.messageId);
    scope = saved;
    const events = await listCaseEvents(mail.caseId), read = readCaseInvestigationProgress(events, latestInvestigationInput(events)!);
    if (read.state !== "found") throw Error("NO_RECORD");
    const unstamped = { ...read.record.decision!, accessScope: undefined };
    expect(caseDecisionDraft(mail.caseId, { ...read.record, decision: unstamped as never }, events, { accessScope: { revision: "scope-syn-r1", policyRevision: POLICY.revision } })).toMatchObject({ reply: null, replyLimit: "access_scope_unknown" });
    expect(proposal.purpose).toBe("answer");
  });
  it("the scope changes between the approval and the queue: nothing is queued, 0 mail", async () => {
    const before = await proposed();
    expect(await approve(before.validationId, before.proposal)).toMatchObject({ ok: true });
    scope = synScope({ revision: "scope-syn-r2" });
    expect(await enqueueApprovedCaseReply({ validationId: before.validationId, policy: { id: grant.id, hash: grant.policyHash }, deps: storeDeps() })).toMatchObject({ ok: false, code: "provenance_unproven", detail: "access_scope_changed" });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, before.caseId))).toHaveLength(0);
    expect(sends).toBe(0);
  });
  it("the source is retired after the marker, before the last look: 0 mail, the reply waits, it is not cancelled", async () => {
    const mail = await queued();
    const result = await executeIntakePass(mail.replyExecutionId, options, { afterMarker: async () => { activeSource = { active: false, title: "x", content: "x", verifiedAt: null }; } }, driver());
    expect(result).toMatchObject({ reason: "SAV_CASE_EFFECT_HOLD_PROVENANCE_UNPROVEN" });
    expect(sends).toBe(0);
    expect((await getExecutionEffects(mail.replyExecutionId)).find(effect => effect.kind === "reply_send")).toMatchObject({ state: "planned" });
  });
  it.each<[number, string]>([[10, "fresh"], [75, "revalidation_due"], [90, "revalidation_due"]])("a check %i days old is evaluated by the existing policy, and the exact date read is what comes out", async (days, verification) => {
    const mail = await proposed(), verifiedAt = daysBefore(days);
    activeSource = { ...activeSource as PilotActiveSource, verifiedAt };
    expect(await readPilotReplyProvenance(mail.proposal, provenanceDeps)).toMatchObject({ status: "proven", sources: [{ verifiedAt, verification, evaluatedAt: SYN_NOW.toISOString() }] });
  });
  it("a production-like consumer with no reader of active versions proves nothing", async () => {
    const mail = await proposed();
    expect(await readPilotReplyProvenance(mail.proposal, { ...provenanceDeps, readActiveSource: async () => null })).toMatchObject({ status: "unproven", reasons: ["source_version_unknown"] });
  });
});

describe("SYN export for UX", () => {
  it("the export is what the runs above produced, equal to the committed fixture; no real id, no real address", () => {
    const fixture = { schema: "sav-pilot-passage.syn.v1", simulated: true, atomicOwnerCompare: "not_proven", ids: "invented", sourcesAndScope: "invented_fixture_no_real_sheet_approved_by_nobody", model: "synthetic_port_no_paid_call", rows: exportRows };
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    expect(exportRows.map(row => row.ref)).toEqual(["SYN-P1", "SYN-P2", "SYN-P3", "SYN-R2", "SYN-R3", "SYN-R4"]);
    expect(text).not.toMatch(/@(?!example\.invalid)[a-z0-9.-]+\.[a-z]{2,}/i);
    if (process.env.SAV_PILOT_PASSAGE_WRITE === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE)).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });
});
