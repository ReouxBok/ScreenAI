import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { fakeSlack } from "../../../../test/sav-handoff-fakes";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { savCaseEffectExecutions, savCaseReplyValidations, savIntakeEffectJournal, savIntakeEffects, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "../intake/execution-policy";
import type { GmailRequest } from "../intake/execution-adapters";
import type { ExecutionOptions } from "../intake/execution-types";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { caseAdmissionStatus, type CaseAdmissionInput } from "./admission-policy";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { readCaseReplyDisclosure } from "./case-reply-outbound";
import { decideCaseReply } from "./case-reply-store";
import { proposeCaseReplyFromDraft, queueValidatedCaseReply, runCaseEffectsPass } from "./case-runtime-effects";
import { runCaseTicketStagePass } from "./case-ticket-stage-store";
import { TICKET_STAGE_KEY_PREFIX } from "./case-ticket-stage";
import { createCaseTicketOwnerPort, createCaseV2WakeDeps } from "./case-v2-wake-ports";
import { runCaseV2Wake, type CaseV2WakeDeps } from "./case-v2-wake";
import { enqueueHandoffNotices } from "./case-handoff-notice-store";
import { recordConfirmedCaseReply } from "./case-effect-outcomes";
import { applyProvenResolution, applyProvenResolutions } from "./case-resolution";
import { HANDOFF_NOTICE_KEY_PREFIX, type HandoffCrmReading } from "./case-handoff-notice";
import { accessAutoReplyAuthorizer, routeCustomerReturn } from "./customer-return-store";
import { ACCESS_AUTO_APPROVAL_BASIS } from "./customer-return";
import { caseDecisionDraft } from "./investigation-intent";
import { readCaseInvestigationProgress } from "./investigation-record";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationModelResult } from "./investigation-runner";
import { caseInvestigationReturnAwareQualify, caseReturnContentRule } from "./investigation-return-qualify";
import { caseInvestigationStorePorts } from "./investigation-store-ports";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseRequestSubject, type CaseSnapshot, type KnowledgeRef } from "./case-types";

/*
 * The V2 wake on the REAL pieces, SYN data only (pole C lot « wiring »): B's real investigation runner and validator → B's draft → the proposal in the automated FORMAT →
 * A's access rule through `decideCaseReply` (the persisted authorization basis) → the queue → `runCaseV2Wake` → the existing executor with the real Gmail / HubSpot / Slack
 * ADAPTERS on synthetic transports (a function-shaped network and a synthetic Gmail provider; no socket). Test doubles, each named: the knowledge search, the model, the
 * facts reader of the auto rule (the repo has no real one), the CRM reading of the handoff notice, the synthetic providers. Nothing reaches a real provider.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, policyHash: string, policy: ExecutionPolicy, ticketSeq = 9_700_000, options: ExecutionOptions;
let slack = fakeSlack(), p = executionProvider(), environment: Record<string, string | undefined> = {}, sends = 0, loseAck = false, sentBodies: string[] = [];
const STAFF = "20000000-0000-4000-8000-000000000002", RULE = "20000000-0000-4000-8000-0000000000aa", AT = "2026-11-04T09:00:00.000Z", ACCESS = "https://new.limova.ai";
const CUSTOMER = "customer@example.invalid", CHANNEL = "CSYNCHANNEL1", TOKEN = "xoxb-" + "TEST".repeat(4), PORTAL = "1234567", V2_OWNER = "424242", TEAM_OWNER = "999111";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-syn" } };
const qualification = (requests: CaseAdmissionQualification["requests"]): CaseAdmissionQualification => ({ requests, identity: CONFIRMED, crmContext: "complete", teamSignals: [] });
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
const byRule = (...requestIds: string[]): CaseAdmissionInput => ({ policy: POLICY, qualification: qualification(requestIds.map(ruled)) });
const recent = () => new Date(Date.now() - 10 * 86_400_000).toISOString();
const card = (id: string, version: string): SavRetrievalCandidate => ({
  id, contentVersionId: version, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture", verifiedAt: recent(), semanticScore: null,
  resolution: { steps: ["Étape synthétique"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });
const LOGIN = card("syn-login", "syn-login-v1");
const kb = { cards: [] as SavRetrievalCandidate[] };
const backend: SavRetrievalBackend = { readRevision: async () => "kb-r1", search: async queries => queries.map(() => kb.cards) };
const subject = (text: string): CaseRequestSubject => ({ status: "available", text, provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
  runId: "30000000-0000-4000-8000-000000000001", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: AT } });
const texts: Record<string, string> = {};

type Made = { ticketId: string; threadId: string; gmailMessageId: string; gmailThreadId: string; caseId: string; requestId: string };
/** A customer mail relayed by V1 (a REAL thread and message row carrying the customer's address) and the synthetic ticket the pilot owns, in the Support pipeline. */
async function newCase(gmail: string, stage: "new" | "waiting" = "new"): Promise<Made> {
  const ticketId = String(++ticketSeq), threadId = randomUUID(), gmailThreadId = `gmail-thread-${threadId}`, requestId = caseRequestId(gmail, "r1");
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId, customerEmail: CUSTOMER });
  const [origin] = await f.db.insert(savMessages).values({ threadId, mailboxId, direction: "inbound", gmailMessageId: gmail, fromEmail: CUSTOMER, toEmails: ["support@example.invalid"], subject: "Connexion impossible",
    bodyCiphertext: encryptSavPayload({ text: "Bonjour, je n'arrive plus à me connecter.", headers: { "message-id": `<${gmail}@example.invalid>` }, attachments: [] }), receivedAt: new Date() }).returning({ id: savMessages.id });
  texts[`email:${gmail}`] = "Bonjour, je n'arrive plus à me connecter.";
  const opened = (await openCaseEvent({ ticketId, threadId, admission: byRule(requestId), detail: { messageId: origin!.id, relay: { kind: "intake_effects_confirmed", messageId: origin!.id } }, opens: [{ id: requestId, summary: `Demande « support » relevée par l'analyse V1 du mail ${gmail}.`,
    subject: subject("Connexion impossible à la plateforme."), }], kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
  p.setGmail(gmail, gmailThreadId); p.seedTicket({ id: ticketId, ownerId: V2_OWNER, stage: stage === "waiting" ? "open" : stage });
  return { ticketId, threadId, gmailMessageId: gmail, gmailThreadId, caseId: opened.caseId, requestId };
}
/** A cheap case for the sweeps: no mail row is needed. */
async function bareCase(gmail: string) {
  const ticketId = String(++ticketSeq), threadId = randomUUID(), requestId = caseRequestId(gmail, "r1");
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `gmail-thread-${threadId}`, customerEmail: CUSTOMER });
  return (await openCaseEvent({ ticketId, threadId, admission: byRule(requestId), opens: [{ id: requestId, summary: "Demande support.", subject: subject("Connexion impossible.") }],
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
}
/** A later customer mail on the same case that opens no new request. */
async function storeLaterMail(made: Made, gmail: string, text: string) {
  const [mail] = await f.db.insert(savMessages).values({ threadId: made.threadId, mailboxId, direction: "inbound", gmailMessageId: gmail, fromEmail: CUSTOMER, toEmails: ["support@example.invalid"], subject: "Re: Connexion impossible",
    bodyCiphertext: encryptSavPayload({ text, headers: { "message-id": `<${gmail}@example.invalid>` }, attachments: [] }), receivedAt: new Date() }).returning({ id: savMessages.id });
  texts[`email:${gmail}`] = text;
  return mail!.id;
}
async function laterMail(made: Made, gmail: string, text: string) {
  await storeLaterMail(made, gmail, text);
  return (await openCaseEvent({ ticketId: made.ticketId, threadId: made.threadId, admission: byRule(made.requestId), kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail),
    sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
}

async function routeLaterMail(made: Made, gmail: string, text: string) {
  const messageId = await storeLaterMail(made, gmail, text);
  const deps = { env: { ...environment, SAV_CASE_RECORDING: "on" }, readTicketOwner: async (ticketId: string) => ticketProps(ticketId).hubspot_owner_id };
  expect(await routeCustomerReturn(messageId, deps)).toMatchObject({ route: { route: "continue" }, caseId: made.caseId, written: true });
  expect(await routeCustomerReturn(messageId, deps)).toMatchObject({ route: { route: "already_recorded" }, caseId: made.caseId, written: false });
}

type Answer = (request: CaseInvestigationModelRequest) => CaseInvestigationModelResult;
const understood = (snapshot: CaseSnapshot) => ({ requests: snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] });
const answer: Answer = request => {
  const u = understood(request.snapshot), cited = refOf(LOGIN);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "answer", requestIds: [u.requests[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: cited }], expectedResult: "La connexion fonctionne." },
    reply: { text: `Bonjour, voici la marche à suivre depuis ${ACCESS} : suivre la fiche.`, citations: [cited], impossibilityClaims: [], accountAdvice: "none" } } };
};
const ask: Answer = request => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "ask", questions: [{ text: "Quel message s'affiche ?", requestId: u.requests[0]!.id, reducesUncertainty: "Précise le blocage.", seeks: [{ kind: "observed_result" }] }] },
    reply: { text: `Bonjour, depuis ${ACCESS}, quel message s'affiche ?`, citations: [], impossibilityClaims: [], accountAdvice: "none" } } };
};
const handoff: Answer = request => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "handoff", reason: "knowledge_missing", requestIds: [u.requests[0]!.id], report: { need: "Le client n'arrive plus à se connecter.", expected: null, observed: null,
      trialIds: [], hypotheses: [], missingInformation: [], expectedIntervention: "Vérifier le compte du client et le rappeler.", knowledge: [] } } } };
};
const confirmResolution = (mail: string, trialId: string, quote: string): Answer => request => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "confirm_resolution", requestIds: [u.requests[0]!.id], evidence: [{ requestId: u.requests[0]!.id, source: { type: "email", id: mail }, trialId, quote }] } } };
};
const resolvedVerdict: Answer = request => ({ status: "ok", output: { verdicts: understood(request.snapshot).requests.map(row => ({ requestId: row.id, verdict: "resolved" })) } });

const currentAdmissionPolicy = async () => ({ policy: POLICY, validFrom: new Date(Date.now() - 3_600_000).toISOString(), validUntil: new Date(Date.now() + 3_600_000).toISOString() });
const readOwner = () => createCaseTicketOwnerPort({ env: () => environment, network: route });
/** The runner on the stores of pole A; the owner is read from the (synthetic) HubSpot by the canonical port. */
async function investigate(caseId: string, answers: Answer[]) {
  const now = () => new Date(Date.now() + 6 * 60_000);
  const ports = caseInvestigationStorePorts({
    readTicketOwner: readOwner(), holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, texts[`${row.type}:${row.id}`] ?? "Bonjour."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => answers.shift()?.(request) ?? { status: "failed", uncertain: false },
    admissionPolicyRevision: async () => "policy-r1",
    qualify: caseInvestigationReturnAwareQualify(async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id));
      return latest ? { admission: { policy: POLICY, qualification: qualification(requests) }, sourceRef: latest.sourceRef } : null;
    }, { now, readPolicyRecord: currentAdmissionPolicy, returnRules: caseReturnContentRule({ ruleId: "rule-access", revision: "r1" }, now) }),
  });
  return runCaseInvestigation(caseId, "observe", ports);
}

// --- the B -> C path -----------------------------------------------------------------------------------------------------------------------------------------
const storeDeps = () => ({ env: () => environment, readTicketOwner: readOwner(), currentPolicyRevision: async () => "policy-r1" });
/** Test double: the repo has NO real facts reader for the auto rule. It reads the persisted case and decision, never the text; the two checks B owns (scope, shown sources) are asserted true. */
const readFacts = async (request: { caseId: string }) => {
  const snapshot = (await readCase(request.caseId))!, events = await listCaseEvents(request.caseId);
  const inputKey = (events.filter(event => event.kind === "observation_recorded").at(-1)?.detail?.record as { inputKey: string }).inputKey;
  const read = readCaseInvestigationProgress(events, inputKey);
  const decision = read.state === "found" ? read.record.decision : null;
  const kind = decision?.validation.outcome === "accepted" ? decision.validation.decision.nextAction.kind : "none";
  return { case: { owner: snapshot.owner, sensitivity: snapshot.sensitivity, admitted: caseAdmissionStatus(snapshot, "policy-r1").admitted },
    openFamilies: snapshot.body.openRequests.filter(row => row.status === "open").map(row => row.family),
    decision: { accepted: decision?.validation.outcome === "accepted", scopeCurrent: true, shownSourcesVerified: true, nextAction: kind }, ownerNow: await readOwner()(snapshot) };
};
const authorizer = () => accessAutoReplyAuthorizer({ env: environment, readFacts });
async function draftOf(caseId: string, pilot = false) {
  const events = await listCaseEvents(caseId);
  const inputKey = (events.filter(event => event.kind === "observation_recorded").at(-1)?.detail?.record as { inputKey: string }).inputKey;
  const read = readCaseInvestigationProgress(events, inputKey);
  if (read.state !== "found") throw Error("NO_RECORD");
  return caseDecisionDraft(caseId, read.record, events, pilot ? { accessScope: null } : undefined)!;
}
/** Proposal in the AUTOMATED format -> approval by the rule (A's authorizer, the persisted basis) -> queue. Returns each step so a test can stop anywhere. */
async function autoReply(caseId: string, over: { format?: "human" | "automated"; authorizerOverride?: Parameters<typeof decideCaseReply>[0]["authorizer"]; approver?: string } = {}) {
  const draft = await draftOf(caseId);
  const proposed = await proposeCaseReplyFromDraft({ caseId, triggerEventId: draft.triggerEventId, decidedOn: draft.decidedOn, reply: draft.reply, language: { code: "fr", proven: true }, validation: over.format ?? "automated" }, storeDeps());
  if (!proposed.ok) return { draft, proposed } as const;
  const decided = await decideCaseReply({ action: "approve", validationId: proposed.validationId, approverId: over.approver ?? RULE, authorizer: "authorizerOverride" in over ? over.authorizerOverride : authorizer(),
    seen: { payloadHash: proposed.payloadHash, caseVersion: proposed.caseVersion, recipient: proposed.recipient }, deps: storeDeps() });
  if (!decided.ok) return { draft, proposed, decided } as const;
  const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
  return { draft, proposed, decided, queued } as const;
}
const validationOf = async (id: string) => (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, id)))[0]!;

// --- the wake ------------------------------------------------------------------------------------------------------------------------------------------------
const route: typeof fetch = (input, init) => new URL(String(input)).hostname === "slack.com" ? slack.network(input, init) : p.network(input, init);
const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
  if (path === "messages/send") { sends += 1; sentBodies.push(String(init?.body ?? "")); }
  const result = await p.gmail<T>(mailbox, path, init);
  if (path === "messages/send" && loseAck) throw Error("SAV_TEST_ACK_LOST");
  return result;
};
let crmReading: HandoffCrmReading = { ticket: null, contacts: [] };
let since = new Date();
function wakeDeps(over: { deadlineMs?: number; env?: Record<string, string | undefined> } = {}): CaseV2WakeDeps {
  const deps = createCaseV2WakeDeps({
    env: () => over.env ?? environment, policy: { id: policyId, hash: policyHash }, since, deadlineMs: over.deadlineMs ?? Date.now() + 60_000, network: route, gmail: { request: gmail, permissions: async () => { } },
    readPolicyRecord: currentAdmissionPolicy,
  });
  const context = { runtime: options.runtime, policy: options.policy };
  // Only the pins of the V1 environment and the CRM reading of the handoff notice are replaced; every other port is the canonical adapter.
  return { ...deps, replies: { ...deps.replies, context }, handoff: { ...deps.handoff, context, crm: async () => crmReading }, stages: { ...deps.stages, context } };
}
const wake = (over: Parameters<typeof wakeDeps>[0] = {}) => runCaseV2Wake(wakeDeps(over));
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
const stageRows = (caseId: string) => f.db.select().from(savCaseEffectExecutions).where(and(eq(savCaseEffectExecutions.caseId, caseId), like(savCaseEffectExecutions.replyKey, `${TICKET_STAGE_KEY_PREFIX}%`)));
const noticeRows = () => f.db.select().from(savCaseEffectExecutions).where(like(savCaseEffectExecutions.replyKey, `${HANDOFF_NOTICE_KEY_PREFIX}%`));
const replyRows = (caseId: string) => f.db.select().from(savCaseEffectExecutions).where(and(eq(savCaseEffectExecutions.caseId, caseId), like(savCaseEffectExecutions.replyKey, "reply:%")));
const ticketProps = (ticketId: string) => p.objects.tickets[ticketId]!.properties;
const patches = () => p.calls.filter(call => call.method === "PATCH");
const posts = () => slack.state.calls.filter(call => call.url.pathname === "/api/chat.postMessage");
const mimeText = (body: string) => {
  const mime = Buffer.from((JSON.parse(body) as { raw: string }).raw, "base64url").toString("utf8");
  return Buffer.from(mime.slice(mime.indexOf("\r\n\r\n") + 4).replace(/\s+/g, ""), "base64").toString("utf8");
};
const setPause = async (agent: "intake" | "v2", level: "actions_paused" | "fully_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, `sav-agent-pause.v1:${agent}`));
  if (level) await f.db.insert(savSyncState).values({ key: `sav-agent-pause.v1:${agent}`, status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent, level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
};
/** A case whose automatic access answer is queued, ready for the wake. */
async function queuedAnswer(gmail: string, model: Answer = answer) {
  const made = await newCase(gmail);
  expect(await investigate(made.caseId, [model])).toMatchObject({ status: "recorded", outcome: "accepted" });
  const step = await autoReply(made.caseId);
  const queued = "queued" in step ? step.queued : undefined;
  if (!queued?.ok) throw Error(`NOT_QUEUED:${JSON.stringify(step).slice(0, 300)}`);
  return { ...made, ...step, executionId: queued.executionId };
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-wake-encryption-key-32-characters-long"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.spyOn(console, "info").mockImplementation(() => { });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  if (!policyId) {
    const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
    state.user = { id: admin!.clerkId, primaryEmailAddress: { emailAddress: admin!.email, verification: { status: "verified" } } };
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
    policy = {
      revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
      createdAfter: new Date(Date.now() - 10_000).toISOString(), receivedAfter: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxDossiers: 100, mutations: ["send_case_reply", "append_case_note", "notify_case_handoff", "set_case_ticket_stage"], admission: { kind: "automatic" },
    };
    const grant = await approveIntakeExecutionPolicy(policy);
    policyId = grant.id; policyHash = grant.policyHash;
    options = { runtime: {} as never, policy, config: { policyId, policyHash, codeRevision: "a".repeat(40) }, env: () => environment, signal: AbortSignal.timeout(60_000), adapters: undefined as never };
  }
  environment = {
    SAV_CASE_EFFECTS: "supervised", SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash, SAV_CODE_REVISION: "a".repeat(40),
    HUBSPOT_ACCESS_TOKEN: "synthetic-hubspot-token", SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: RULE, SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, HUBSPOT_SAV_OWNER_ID: TEAM_OWNER,
    SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "2", SAV_V2_STAGE_CLOSED: "4",
    SAV_HANDOFF_NOTICE: "on", SAV_HANDOFF_SLACK_BOT_TOKEN: TOKEN, SAV_HANDOFF_SLACK_CHANNEL_ID: CHANNEL, SAV_HANDOFF_TEAM_OWNER_ID: TEAM_OWNER, HUBSPOT_PORTAL_ID: PORTAL,
  };
  slack = fakeSlack(); p = executionProvider(); sends = 0; loseAck = false; sentBodies = []; kb.cards = [LOGIN]; since = new Date(Date.now() - 1000);
  crmReading = { ticket: null, contacts: [] };
  await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused' WHERE state NOT IN ('confirmed', 'refused')");
  await f.client.exec("DELETE FROM sav.sync_state WHERE key LIKE 'sav-v2-sweep.v1:%'");
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setPause("v2", null); await setPause("intake", null); });

describe("the automatic access reply, from the real investigation to the ticket state", () => {
  it("B's accepted answer -> automated format -> A's rule -> queue -> wake: ONE mail, identical text / hash / MIME, the rule's basis counted on the single ledger, the ticket « waiting »", async () => {
    const made = await queuedAnswer("gm-wake-1");
    const validation = await validationOf(made.proposed.ok ? made.proposed.validationId : "");
    // The right is the persisted row, written by the rule through the authorizer; the format is only the mention.
    expect(validation).toMatchObject({ state: "approved", decidedBy: RULE, authorizationBasis: ACCESS_AUTO_APPROVAL_BASIS });
    const stored = decryptSavPayload<CaseReplyProposal>(validation.proposalCiphertext);
    expect(readCaseReplyDisclosure(stored.text)?.mode).toBe("automated");

    const result = await wake();
    expect(result.failures).toEqual([]);
    expect(result.replies).toMatchObject({ skipped: null, supervised: [{ executionId: made.executionId, state: "confirmed" }] });
    expect(sends).toBe(1);
    // The text a rule approved, the text hashed, the text stored and the MIME body that left are the same bytes.
    const sentText = mimeText(sentBodies[0]!);
    expect(sentText).toBe(stored.text);
    expect(caseReplyPayloadHash({ ...stored, text: sentText })).toBe(validation.payloadHash);
    expect(made.proposed.ok && made.proposed.payloadHash).toBe(validation.payloadHash);
    expect(readCaseReplyDisclosure(sentText)?.mode).toBe("automated");

    // Single ledger: the admission, the effect, the journal. No parallel counter.
    const journal = await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, made.executionId));
    expect(journal.filter(row => row.kind === "case_effect_admitted")).toHaveLength(1);
    const [effect] = await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, made.executionId));
    expect(effect).toMatchObject({ kind: "reply_send", permission: "send_case_reply", state: "confirmed" });

    // « waiting for the customer »: queued with the confirmed reply, moved by the stage pass of the same wake: one PATCH of the stage alone.
    const stages = await stageRows(made.caseId);
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ state: "confirmed", replyKey: expect.stringMatching(/^case-stage:[^:]+:waiting_customer:/) });
    expect(ticketProps(made.ticketId)).toMatchObject({ hs_pipeline: "0", hs_pipeline_stage: "2", hubspot_owner_id: V2_OWNER });
    expect(patches()).toEqual([expect.objectContaining({ body: { properties: { hs_pipeline_stage: "2" } } })]);

    // Replay: nothing is sent, written or queued twice.
    for (let n = 0; n < 2; n++) await wake();
    expect(sends).toBe(1);
    expect(patches()).toHaveLength(1);
    expect(await stageRows(made.caseId)).toHaveLength(1);
    expect(await replyRows(made.caseId)).toHaveLength(1);
  });

  it("a question runs J2 from the VERIFIED sentAt; an answer plans none", async () => {
    const made = await queuedAnswer("gm-wake-q", ask);
    await wake();
    const timers = await listCaseTimers(made.caseId);
    expect(timers).toHaveLength(1);
    const outbound = (await listCaseEvents(made.caseId)).filter(event => event.kind === "outbound_observed");
    expect(outbound).toHaveLength(1);
    expect(timers[0]).toMatchObject({ state: "scheduled", sentAt: expect.any(String) });
    expect(Math.abs(Date.parse(timers[0]!.sentAt) - Date.parse(outbound[0]!.occurredAt))).toBeLessThan(5_000);
    const answered = await queuedAnswer("gm-wake-a");
    await wake();
    expect(await listCaseTimers(answered.caseId)).toEqual([]);
  });

  it("the format grants nothing: every incompatible (basis, mention) pair is refused with NO row queued and NO mail", async () => {
    // 1. automated text, human approval (the fixture authorizer's basis)
    const a = await newCase("gm-mode-1");
    await investigate(a.caseId, [answer]);
    const human = await autoReply(a.caseId, { authorizerOverride: () => ({ allowed: true, basis: "fixture.allow" }), approver: "20000000-0000-4000-8000-000000000003" });
    expect(human).toMatchObject({ decided: { ok: false, code: expect.stringMatching(/proposal_invalid|ai_notice_mode/) } });
    // 2. manual text, approval by the rule
    const b = await newCase("gm-mode-2");
    await investigate(b.caseId, [answer]);
    const manual = await autoReply(b.caseId, { format: "human" });
    expect(manual).toMatchObject({ decided: { ok: false } });
    // 3. no authorizer wired, and a refusing rule (facts unread): the default denies
    const c = await newCase("gm-mode-3");
    await investigate(c.caseId, [answer]);
    expect(await autoReply(c.caseId, { authorizerOverride: undefined })).toMatchObject({ decided: { ok: false, code: "authorizer_missing" } });
    expect(await autoReply(c.caseId, { authorizerOverride: accessAutoReplyAuthorizer({ env: environment }) })).toMatchObject({ decided: { ok: false } });
    // 4. the wrong mode word
    expect(await autoReply(c.caseId, { format: "automatic" as never })).toMatchObject({ proposed: { ok: false, code: "validation_invalid" } });
    await wake();
    expect(sends).toBe(0);
    for (const made of [a, b, c]) expect(await replyRows(made.caseId)).toEqual([]);
  });

  it("a falsified basis is caught at the marker: an approved automated reply whose stored basis is rewritten as human (and the reverse) is NOT sent", async () => {
    let guarded = 0;
    for (const [gmail, from, to, format] of [["gm-fake-1", ACCESS_AUTO_APPROVAL_BASIS, "fixture.human", "automated"], ["gm-fake-2", "fixture.human", ACCESS_AUTO_APPROVAL_BASIS, "human"]] as const) {
      const made = await newCase(gmail);
      await investigate(made.caseId, [answer]);
      const step = await autoReply(made.caseId, { format, ...(format === "human" ? { authorizerOverride: () => ({ allowed: true, basis: "fixture.human" }), approver: "20000000-0000-4000-8000-000000000003" } : {}) });
      expect(step).toMatchObject({ queued: { ok: true } });
      const id = (step as { proposed: { validationId: string } }).proposed.validationId;
      expect((await validationOf(id)).authorizationBasis).toBe(from);
      // The row guard may refuse the rewrite outright (then the guard is the proof and the untouched reply is legitimately sent); otherwise the executor must refuse.
      const rewritten = await f.client.query("UPDATE sav.case_reply_validations SET authorization_basis = $1 WHERE id = $2", [to, id]).then(() => true, () => false);
      const before = sends;
      await wake();
      if (rewritten) { expect(sends).toBe(before); expect((await replyRows(made.caseId))[0]!.state).not.toBe("confirmed"); }
      guarded += rewritten ? 0 : 1;
    }
    expect(sends).toBe(guarded);
  });

  it("uncertain = verify only: a lost acknowledgement never resends; the mail that left is found once, and the stage follows once", async () => {
    const made = await queuedAnswer("gm-lost");
    loseAck = true;
    const first = await wake();
    expect(sends).toBe(1);
    expect(first.replies?.supervised[0]?.state).not.toBe("confirmed");
    expect(patches()).toHaveLength(0);
    loseAck = false;
    await letReconcile();
    const second = await wake();
    expect(second.failures).toEqual([]);
    expect(sends).toBe(1);
    expect((await replyRows(made.caseId))[0]!.state).toBe("confirmed");
    expect(await stageRows(made.caseId)).toHaveLength(1);
    await wake(); await wake();
    expect(sends).toBe(1);
    expect(patches()).toHaveLength(1);
  });
});

describe("the ticket state: only the pilot's Support ticket, only while the case still asks for it", () => {
  async function confirmedReply(gmail: string) {
    const made = await queuedAnswer(gmail);
    const replies = await runCaseEffectsPass(wakeDeps().replies);
    expect(replies.supervised[0]).toMatchObject({ state: "confirmed" });
    expect(await stageRows(made.caseId)).toHaveLength(1);
    return made;
  }

  it("a customer mail received after the reply cancels « waiting »: zero PATCH, the execution is closed for good", async () => {
    const made = await confirmedReply("gm-stage-new");
    await laterMail(made, "gm-stage-new-2", "Merci, je regarde.");
    await wake();
    expect(patches()).toHaveLength(0);
    expect((await stageRows(made.caseId))[0]).toMatchObject({ state: "refused", reason: expect.stringContaining("NEW_INPUT") });
    expect(ticketProps(made.ticketId).hs_pipeline_stage).toBe("1");
  });

  it("a person who took the ticket in HubSpot: zero PATCH; the pilot's ownership is the condition, read now", async () => {
    const made = await confirmedReply("gm-stage-owner");
    ticketProps(made.ticketId).hubspot_owner_id = TEAM_OWNER;
    await wake();
    expect(patches()).toHaveLength(0);
    expect((await stageRows(made.caseId))[0]).toMatchObject({ state: "refused", reason: expect.stringContaining("OWNER_CHANGED") });
  });

  it("a pause holds it (no PATCH, nothing lost); once lifted it moves exactly once", async () => {
    const made = await confirmedReply("gm-stage-pause");
    await setPause("v2", "actions_paused");
    expect(await runCaseTicketStagePass({ ...wakeDeps().stages, env: () => environment, deadlineMs: Date.now() + 60_000, readTicketOwner: readOwner() })).toMatchObject({ skipped: expect.any(String) });
    expect(patches()).toHaveLength(0);
    await setPause("v2", null);
    await wake(); await wake();
    expect(patches()).toHaveLength(1);
    expect(ticketProps(made.ticketId).hs_pipeline_stage).toBe("2");
  });

  it("OFF by default: without SAV_V2_TICKET_STAGES=on a confirmed reply queues no stage and touches no ticket", async () => {
    environment = { ...environment, SAV_V2_TICKET_STAGES: undefined };
    const made = await queuedAnswer("gm-stage-off");
    await wake();
    expect(sends).toBe(1);
    expect(await stageRows(made.caseId)).toEqual([]);
    expect(patches()).toHaveLength(0);
  });

  it("a ticket outside the Support pipeline that the pilot owns is never written, whatever the case says", async () => {
    const made = await confirmedReply("gm-stage-pipe");
    ticketProps(made.ticketId).hs_pipeline = "77777777";
    await wake(); await wake();
    expect(patches()).toHaveLength(0);
    expect(ticketProps(made.ticketId).hs_pipeline_stage).toBe("1");
  });
});

describe("proven resolution: the only way a V2 case ends resolved and a ticket is closed", () => {
  /** The trial is the one the confirmed Gmail receipt opened: read back from the stored case, never written by the test. */
  const realTrial = async (caseId: string) => {
    const { trials } = (await readCase(caseId))!.body;
    expect(trials).toHaveLength(1);
    return trials[0]!;
  };
  async function answeredAndThanked(gmail: string, thanks = "Merci, ça remarche depuis l'autre navigateur !") {
    const made = await queuedAnswer(gmail);
    await wake();
    const trial = await realTrial(made.caseId);
    await laterMail(made, `${gmail}-thanks`, thanks);
    return { ...made, trial };
  }

  it("« merci, ça remarche » read twice by the real runner (decision + second reading = soft_close) -> case resolved -> ticket closed, ONE closing, no message sent", async () => {
    const sent = await queuedAnswer("gm-res-ok");
    expect((await wake()).replies).toMatchObject({ supervised: [{ executionId: sent.executionId, state: "confirmed" }] });
    expect(ticketProps(sent.ticketId).hs_pipeline_stage).toBe("2");
    const made = { ...sent, trial: await realTrial(sent.caseId) };
    await routeLaterMail(made, "gm-res-ok-thanks", "Merci, ça remarche depuis l’autre navigateur !");
    const outbound = (await listCaseEvents(made.caseId)).filter(event => event.kind === "outbound_observed");
    expect(outbound).toHaveLength(1);
    expect(made.trial).toEqual({ id: expect.stringMatching(/^trial:/), requestId: made.requestId, procedure: refOf(LOGIN), askedAt: outbound[0]!.occurredAt, outcome: "pending", resultAt: null });
    const report = await investigate(made.caseId, [confirmResolution("gm-res-ok-thanks", made.trial.id, "ça remarche"), resolvedVerdict]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", closure: "soft_close" });
    const mailsBefore = sends;
    const first = await wake();
    expect(first.closures).toMatchObject({ resolved: 1 });
    expect((await readCase(made.caseId))).toMatchObject({ phase: "resolved", body: { cycle: { number: 1, endedBy: "resolved" } } });
    const thanked = (await listCaseEvents(made.caseId)).find(event => event.sourceRef.id === "gm-res-ok-thanks")!;
    expect((await readCase(made.caseId))!.body.trials).toEqual([{ ...made.trial, outcome: "succeeded", resultAt: thanked.occurredAt, result: { text: "ça remarche", source: { type: "email", id: "gm-res-ok-thanks" } } }]);
    const closing = (await stageRows(made.caseId)).filter(row => row.replyKey.includes(":closed:"));
    expect(closing).toHaveLength(1);
    await wake();
    expect(ticketProps(made.ticketId).hs_pipeline_stage).toBe("4");
    for (let n = 0; n < 2; n++) await wake();
    expect(sends).toBe(mailsBefore);
    expect(patches().filter(call => (call.body as { properties: { hs_pipeline_stage: string } }).properties.hs_pipeline_stage === "4")).toHaveLength(1);
    expect((await stageRows(made.caseId)).filter(row => row.replyKey.includes(":closed:"))).toHaveLength(1);
  });

  it("a thanks for a transfer, an unreadable second reading or a case a person owns closes nothing", async () => {
    const transfer = await answeredAndThanked("gm-res-transfer", "Merci de votre retour, je transmets à mon collègue.");
    const unsupportedClosure = confirmResolution("gm-res-transfer-thanks", transfer.trial.id, "Merci de votre retour");
    const report = await investigate(transfer.caseId, [unsupportedClosure, request => {
      expect(request.purpose).toBe("decision");
      expect(request.feedback).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "resolution_evidence_invalid", detail: "latest_customer_login_not_confirmed" }),
      ]));
      return unsupportedClosure(request);
    }]);
    expect(report).toMatchObject({
      outcome: "needs_review", closure: null, modelCalls: 2,
      refusal: { codes: ["resolution_evidence_invalid"] },
    });
    const unreadable = await answeredAndThanked("gm-res-unread");
    await investigate(unreadable.caseId, [confirmResolution("gm-res-unread-thanks", unreadable.trial.id, "ça remarche"), () => ({ status: "ok", output: { nothing: true } })]);
    await wake();
    for (const made of [transfer, unreadable]) {
      expect((await readCase(made.caseId))!.phase).not.toBe("resolved");
      expect(await realTrial(made.caseId)).toMatchObject({ id: made.trial.id, outcome: "pending" });
      expect((await stageRows(made.caseId)).filter(row => row.replyKey.includes(":closed:"))).toEqual([]);
    }
    const stageClosed = patches().filter(call => (call.body as { properties: { hs_pipeline_stage: string } }).properties.hs_pipeline_stage === "4");
    expect(stageClosed).toHaveLength(0);
  });

  it("a lost acknowledgement: the trial is opened once, by the verification that proves the mail left, never by the send itself", async () => {
    const made = await queuedAnswer("gm-trial-lost");
    loseAck = true;
    await wake();
    expect(sends).toBe(1);
    expect((await readCase(made.caseId))!.body.trials).toEqual([]);
    loseAck = false;
    await letReconcile();
    await wake(); await wake();
    expect(sends).toBe(1);
    const trial = await realTrial(made.caseId);
    expect(trial.askedAt).toBe((await listCaseEvents(made.caseId)).filter(event => event.kind === "outbound_observed").at(-1)!.occurredAt);
  });

  it("a crash after the Gmail receipt, before and inside its transaction, leaves no half: the recovery completes one event, one trial, one stage, with no second mail", async () => {
    const made = await queuedAnswer("gm-trial-crash");
    // Before the transaction: the policy read of the receipt fails. Inside it: the trial is already written when the stage queue reads a failing configuration, so all of it rolls back.
    const crash = (deps: CaseV2WakeDeps, at: "before" | "inside"): CaseV2WakeDeps => {
      // For the whole wake: its recovery may try the same execution twice, and a second try that succeeded would hide the crash.
      const env = () => { if (at === "inside" && new Error().stack?.includes("enqueueCaseTicketStage")) throw Error("SAV_TEST_CRASH_INSIDE"); return environment; };
      const currentPolicyRevision = async () => { if (at === "before" && new Error().stack?.includes("commitReceipt")) throw Error("SAV_TEST_CRASH_BEFORE"); return "policy-r1"; };
      return { ...deps, replies: { ...deps.replies, env, currentPolicyRevision } };
    };
    const freeLease = () => f.client.exec("UPDATE sav.case_effect_executions SET lease_until = NULL, lease_token = NULL WHERE state NOT IN ('confirmed', 'refused')");
    const nothingRecorded = async () => {
      expect(sends).toBe(1);
      expect((await replyRows(made.caseId))[0]!.state).not.toBe("confirmed");
      expect((await listCaseEvents(made.caseId)).filter(event => event.kind === "outbound_observed")).toEqual([]);
      expect((await readCase(made.caseId))!.body.trials).toEqual([]);
      expect(await stageRows(made.caseId)).toEqual([]);
    };
    await runCaseV2Wake(crash(wakeDeps(), "before"));
    await nothingRecorded();
    await freeLease();
    const inside = await runCaseV2Wake(crash(wakeDeps(), "inside"));
    expect(inside.replies?.recovery.some(row => "reason" in row && row.reason === "SAV_TEST_CRASH_INSIDE")).toBe(true);
    await nothingRecorded();
    await freeLease();
    await wake(); await wake(); await wake();
    expect(sends).toBe(1);
    expect((await replyRows(made.caseId))[0]!.state).toBe("confirmed");
    expect((await listCaseEvents(made.caseId)).filter(event => event.kind === "outbound_observed")).toHaveLength(1);
    await realTrial(made.caseId);
    expect(await stageRows(made.caseId)).toHaveLength(1);
    expect(patches()).toHaveLength(1);
  });

  it("a replayed receipt adds nothing, and two steps of one answer open one trial per card, closed by the proof they were not cited in", async () => {
    const second = card("syn-other", "syn-other-v1");
    kb.cards = [LOGIN, second];
    const twoSteps: Answer = request => {
      const output = (answer(request) as { output: { nextAction: { steps: unknown[] } } }).output;
      return { status: "ok", output: { ...output, nextAction: { ...output.nextAction, steps: [{ text: "Suivre la fiche citée.", knowledge: refOf(LOGIN) }, { text: "Puis l'autre fiche.", knowledge: refOf(second) }] } } };
    };
    const made = await queuedAnswer("gm-trial-two", twoSteps);
    await wake();
    const proposal = (made.proposed.ok ? decryptSavPayload<CaseReplyProposal>((await validationOf(made.proposed.validationId)).proposalCiphertext) : null)!;
    expect(proposal.procedures).toEqual([{ requestId: made.requestId, procedure: refOf(LOGIN) }, { requestId: made.requestId, procedure: refOf(second) }]);
    const { trials } = (await readCase(made.caseId))!.body;
    expect(trials.map(row => row.procedure)).toEqual([refOf(LOGIN), refOf(second)]);
    const effect = (await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, made.executionId)))[0]!;
    const sentAt = new Date(trials[0]!.askedAt), version = (await readCase(made.caseId))!.version;
    const replay = { proposal, effectId: effect.id, gmailMessageId: (await listCaseEvents(made.caseId)).find(event => event.kind === "outbound_observed")!.sourceRef.id, gmailThreadId: made.gmailThreadId, sentAt, currentPolicyRevision: "policy-r1" };
    expect(await recordConfirmedCaseReply(replay)).toMatchObject({ event: "already_recorded", trials: "already_recorded" });
    expect((await readCase(made.caseId))!.version).toBe(version);
    await laterMail(made, "gm-trial-two-thanks", "Merci, ça remarche !");
    await investigate(made.caseId, [confirmResolution("gm-trial-two-thanks", trials[0]!.id, "ça remarche"), resolvedVerdict]);
    await wake();
    expect((await readCase(made.caseId))!.body.trials.map(row => row.outcome)).toEqual(["succeeded", "unknown"]);
  });

  it("a person who takes the case while the mail is in flight stops it: the mail stays real, no event, no trial, no stage, and no later thanks closes anything", async () => {
    const made = await queuedAnswer("gm-owner-flight");
    loseAck = true;
    await wake();
    loseAck = false;
    const held = (await readCase(made.caseId))!;
    await transitionCaseOwner({ caseId: made.caseId, expectedVersion: held.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: "take-gm-owner-flight", reason: "TAKEN" });
    await letReconcile();
    await wake(); await wake();
    expect(sends).toBe(1);
    expect((await readCase(made.caseId))!.body.trials).toEqual([]);
    expect(await stageRows(made.caseId)).toEqual([]);
    expect((await replyRows(made.caseId))[0]!.state).toBe("refused");
    await laterMail(made, "gm-owner-flight-thanks", "Merci, ça remarche !");
    await wake();
    expect((await readCase(made.caseId))!.phase).not.toBe("resolved");
    expect(patches()).toEqual([]);
  });

  it("a person who takes the ticket in HubSpot after the double reading stops the closure: case not resolved, trial still pending, zero PATCH; given back, it closes once", async () => {
    const made = await answeredAndThanked("gm-owner-crm");
    expect(await investigate(made.caseId, [confirmResolution("gm-owner-crm-thanks", made.trial.id, "ça remarche"), resolvedVerdict])).toMatchObject({ closure: "soft_close" });
    const before = patches().length;
    ticketProps(made.ticketId).hubspot_owner_id = TEAM_OWNER;
    const taken = await wake();
    expect(taken.closures).toMatchObject({ resolved: 0, refused: { owner_human: 1 } });
    await wake();
    expect((await readCase(made.caseId))!.phase).not.toBe("resolved");
    expect(await realTrial(made.caseId)).toMatchObject({ outcome: "pending" });
    expect(patches()).toHaveLength(before);
    // The ticket comes back: the sweep examines the case again and closes it, with no new model call.
    ticketProps(made.ticketId).hubspot_owner_id = V2_OWNER;
    expect((await wake()).closures).toMatchObject({ resolved: 1 });
    await wake(); await wake();
    expect(patches().filter(call => (call.body as { properties: { hs_pipeline_stage: string } }).properties.hs_pipeline_stage === "4")).toHaveLength(1);
    expect(await realTrial(made.caseId)).toMatchObject({ outcome: "succeeded" });
  });

  it("procedures belong to an answer: a question that carries one is refused before any row exists", async () => {
    const made = await newCase("gm-proc-question");
    await investigate(made.caseId, [ask]);
    const draft = await draftOf(made.caseId);
    const proposed = await proposeCaseReplyFromDraft({ caseId: made.caseId, triggerEventId: draft.triggerEventId, decidedOn: draft.decidedOn, reply: { ...draft.reply!, procedures: [{ requestId: made.requestId, procedure: refOf(LOGIN) }] }, language: { code: "fr", proven: true } }, storeDeps());
    expect(proposed).toEqual({ ok: false, code: "proposal_invalid", detail: "procedures" });
    expect(await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, made.caseId))).toEqual([]);
  });

  it("the closure refuses without its owner port (the default denies, nothing is written)", async () => {
    const made = await answeredAndThanked("gm-owner-noport");
    await investigate(made.caseId, [confirmResolution("gm-owner-noport-thanks", made.trial.id, "ça remarche"), resolvedVerdict]);
    const refused = await applyProvenResolution({ caseId: made.caseId, policy: { id: policyId, hash: policyHash }, env: () => environment, currentPolicyRevision: async () => "policy-r1", readTicketOwner: undefined });
    expect(refused).toEqual({ ok: false, code: "owner_port_absent" });
    expect((await readCase(made.caseId))!.phase).not.toBe("resolved");
  });
});

describe("handoff: after an accepted, exhausted plan only, once", () => {
  const goodCrm = (ticketId: string): HandoffCrmReading => ({ ticket: { id: ticketId, archived: false }, contacts: [{ id: "777", firstname: "Camille", lastname: "Synthétique", emails: [CUSTOMER], archived: false }] });

  it("an explicit failure of the procedure sent to this customer goes to the Studio team and posts one notice on replay", async () => {
    const made = await queuedAnswer("gm-return-failed");
    expect((await wake()).replies).toMatchObject({ supervised: [{ executionId: made.executionId, state: "confirmed" }] });
    expect(ticketProps(made.ticketId).hs_pipeline_stage).toBe("2");
    const [trial] = (await readCase(made.caseId))!.body.trials;
    expect(trial).toMatchObject({ requestId: made.requestId, outcome: "pending", procedure: refOf(LOGIN) });
    const report = "J’ai suivi toutes les étapes, mais je ne reçois toujours pas le code.";
    const mail = "gm-return-failed-result";
    await routeLaterMail(made, mail, report);
    expect((await readCase(made.caseId))!.body.trials).toMatchObject([{ id: trial!.id, outcome: "failed", result: { source: { type: "email", id: mail } } }]);
    crmReading = goodCrm(made.ticketId);
    const exhausted: Answer = request => ({ status: "ok", output: { caseVersion: request.snapshot.version, understanding: understood(request.snapshot),
      nextAction: { kind: "handoff", reason: "diagnosis_out_of_tools", requestIds: [made.requestId], report: {
        need: "Se connecter à la plateforme.", expected: "Recevoir le code.", observed: report, trialIds: [trial!.id], hypotheses: [], missingInformation: [],
        expectedIntervention: "Examiner la distribution du code de connexion.", knowledge: [refOf(LOGIN)] } } } });
    expect(await investigate(made.caseId, [exhausted])).toMatchObject({ status: "recorded", outcome: "accepted" });
    await wake();
    await wake();
    expect(await readCase(made.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending" });
    expect((await noticeRows()).filter(row => row.caseId === made.caseId)).toMatchObject([{ state: "confirmed" }]);
    expect(posts()).toHaveLength(1);
    expect(sends).toBe(1);
    expect(ticketProps(made.ticketId).hs_pipeline_stage).not.toBe("4");
  });

  it("a handoff decision reaches Slack once through the wake (sweep + pass); an answer, a question and a waiting case post nothing; replays post nothing more", async () => {
    const answered = await queuedAnswer("gm-ho-answer");
    const asked = await queuedAnswer("gm-ho-ask", ask);
    const handed = await newCase("gm-ho-handoff");
    crmReading = goodCrm(handed.ticketId);
    expect(await investigate(handed.caseId, [handoff])).toMatchObject({ status: "recorded", outcome: "accepted" });
    for (let n = 0; n < 3; n++) await wake();
    expect(posts()).toHaveLength(1);
    expect((await noticeRows()).filter(row => row.caseId === handed.caseId)).toHaveLength(1);
    expect((await noticeRows()).filter(row => row.caseId === answered.caseId || row.caseId === asked.caseId)).toEqual([]);
    expect(sends).toBe(2);
  });
});

describe("the sweeps do not starve case 51, stop between cases on the deadline and never double an effect", () => {
  it("51 cases, a limit of 50: the first call reads 50 and changes nothing for them, the second reads the 51st; the handoff notice is queued ONCE whichever it is; laps change nothing", async () => {
    since = new Date();
    const cases = [];
    for (let n = 0; n < 50; n++) cases.push(await bareCase(`gm-sweep-${n}`));
    const target = await newCase("gm-sweep-target");
    crmReading = { ticket: { id: target.ticketId, archived: false }, contacts: [] };
    expect(await investigate(target.caseId, [handoff])).toMatchObject({ outcome: "accepted" });
    const input = { policy: { id: policyId, hash: policyHash }, env: () => environment, since };
    const first = await enqueueHandoffNotices(input), second = await enqueueHandoffNotices(input);
    expect([first.examined, second.examined]).toEqual([50, 1]);
    expect([first.windowEnded, second.windowEnded]).toEqual([false, true]);
    expect(first.created + second.created).toBe(1);
    expect(first.existing + second.existing).toBe(0);
    for (let n = 0; n < 4; n++) expect((await enqueueHandoffNotices(input)).created).toBe(0);
    expect((await noticeRows()).filter(row => row.caseId === target.caseId)).toHaveLength(1);
    // The resolution sweep walks the same window with its own cursor and closes nothing here.
    const resolution = { ...input, currentPolicyRevision: async () => "policy-r1" as string | null, readTicketOwner: readOwner() };
    const r1 = await applyProvenResolutions(resolution), r2 = await applyProvenResolutions(resolution);
    expect([r1.examined, r2.examined]).toEqual([50, 1]);
    expect(r1.resolved + r2.resolved).toBe(0);
  });

  it("the deadline stops a sweep BETWEEN cases: nothing is lost, the next call resumes after the last handled case, no duplicate", async () => {
    since = new Date();
    for (let n = 0; n < 12; n++) await bareCase(`gm-dl-${n}`);
    const target = await newCase("gm-dl-target");
    expect(await investigate(target.caseId, [handoff])).toMatchObject({ outcome: "accepted" });
    const input = { policy: { id: policyId, hash: policyHash }, env: () => environment, since };
    // Already past: not one case is started and the cursor does not move.
    const none = await enqueueHandoffNotices({ ...input, deadlineMs: Date.now() - 1 });
    expect(none).toMatchObject({ examined: 0, stoppedByDeadline: true, windowEnded: false });
    // The budget ends after exactly five cases (the injected clock is read once per case).
    let reads = 0;
    const cut = await enqueueHandoffNotices({ ...input, deadlineMs: 1_000, limit: 200, now: () => (reads++ < 5 ? 0 : 2_000) });
    expect(cut).toMatchObject({ examined: 5, stoppedByDeadline: true, windowEnded: false });
    // The cursor stopped after the fifth: the next call reads the other eight, from the sixth on, and nothing twice.
    const rest = await enqueueHandoffNotices({ ...input, limit: 200 });
    expect(rest).toMatchObject({ examined: 8, stoppedByDeadline: false, windowEnded: true });
    expect(cut.created + rest.created).toBe(1);
    expect((await noticeRows()).filter(row => row.caseId === target.caseId)).toHaveLength(1);
    // The resolution sweep stops the same way and resumes where it stopped.
    let more = 0;
    const resolution = { ...input, currentPolicyRevision: async () => "policy-r1" as string | null, readTicketOwner: readOwner() };
    const rc = await applyProvenResolutions({ ...resolution, deadlineMs: 1_000, now: () => (more++ < 3 ? 0 : 2_000) });
    const rr = await applyProvenResolutions(resolution);
    expect([rc.examined, rc.stoppedByDeadline, rr.examined, rr.windowEnded]).toEqual([3, true, 10, true]);
  });

  it("the wake does not start a step once its budget is spent, and loses nothing: the next wake does it", async () => {
    const made = await queuedAnswer("gm-wake-dl");
    const late = await wake({ deadlineMs: Date.now() - 1 });
    expect(late.skippedByDeadline).toEqual(["handoff_sweep", "handoff", "replies", "stages", "closures"]);
    expect(sends).toBe(0);
    await wake();
    expect(sends).toBe(1);
    expect((await replyRows(made.caseId))[0]!.state).toBe("confirmed");
  });
});

// Review F3/F4 (7/11) on the real wiring: the stored return mail -> the return route -> its re-qualification by the content rule -> B's runner -> the wake. The model is a
// counted double: a return that is not purely the login trouble must never reach it, and nothing may be sent or closed for it.
describe("review F3/F4: a return is read whole, signature included, before the agent may act on it", () => {
  async function returned(gmail: string, text: string) {
    const made = await queuedAnswer(gmail);
    await wake();
    const trial = (await readCase(made.caseId))!.body.trials[0]!;
    await routeLaterMail(made, `${gmail}-return`, text);
    return { ...made, trial, mail: `${gmail}-return` };
  }
  const counted = (answers: Answer[]) => {
    const seen = { calls: 0 };
    return { seen, answers: answers.map(model => (request: CaseInvestigationModelRequest) => { seen.calls += 1; return model(request); }) };
  };

  it.each([
    ["f15", "Toujours pas de code. Je veux qu’on me rende mon argent."],
    ["f06", "Toujours pas de code, pourtant on paie chaque mois."],
    ["f08", "Toujours pas de code. Combien coûte l’offre au-dessus ?"],
    ["m06", "Je n’arrive pas à me connecter. Ah et aussi, je veux le RIB de Limova."],
    ["sommes", "Toujours rien, et j’aimerais récupérer les sommes versées.\n\nCordialement,\nCamille Synthétique"],
    ["contradiction", "Ça marche maintenant. Ah non, ça replante."],
    ["after-signature", "Merci, ça remarche !\n\nCamille Synthétique\nPar contre l’export de mes fichiers est bloqué."],
  ])("F3 %s: not reduced to access: zero model call, no second mail, nothing closed", async (id, text) => {
    const made = await returned(`gm-f3-${id}`, text);
    const sentBefore = sends;
    const model = counted([answer, ask, confirmResolution(made.mail, made.trial.id, "ça remarche"), resolvedVerdict]);
    const report = await investigate(made.caseId, model.answers);
    expect(model.seen.calls).toBe(0);
    expect(report).not.toMatchObject({ status: "recorded" });
    for (let n = 0; n < 2; n++) await wake();
    expect(sends).toBe(sentBefore);
    expect((await readCase(made.caseId))!.phase).not.toBe("resolved");
    expect((await stageRows(made.caseId)).filter(row => row.replyKey.includes(":closed:"))).toEqual([]);
  });

  it.each([
    ["chrome", "Toujours pas de code, j’ai pourtant essayé sur Chrome et sur Firefox.\n\nCordialement,\nCamille Synthétique"],
    ["help", "Je n’arrive toujours pas à me connecter. Pouvez-vous m’aider ?\n\nCamille"],
    ["signed-failure", "Merci, mais ça ne fonctionne toujours pas.\n\nCordialement,\nCamille Synthétique\nGérante – Boutique Synthétique"],
  ])("witness %s: a real access return, signed, still reaches the agent", async (id, text) => {
    const made = await returned(`gm-f3-ok-${id}`, text);
    const model = counted([ask]);
    await investigate(made.caseId, model.answers);
    expect(model.seen.calls).toBe(1);
  });

  it("F4: « merci, ça remarche » with a full signature closes the case once, on the customer's words, and sends nothing", async () => {
    const signed = "Merci, ça remarche !\n\nCordialement,\nCamille Synthétique\nGérante – Boutique Synthétique\n01 23 45 67 89";
    const made = await returned("gm-f4-signed", signed);
    const sentBefore = sends;
    const report = await investigate(made.caseId, [confirmResolution(made.mail, made.trial.id, "ça remarche"), resolvedVerdict]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", closure: "soft_close" });
    expect((await wake()).closures).toMatchObject({ resolved: 1 });
    await wake();
    expect(await readCase(made.caseId)).toMatchObject({ phase: "resolved", body: { cycle: { endedBy: "resolved" } } });
    expect((await readCase(made.caseId))!.body.trials).toMatchObject([{ id: made.trial.id, outcome: "succeeded", result: { source: { type: "email", id: made.mail } } }]);
    expect((await stageRows(made.caseId)).filter(row => row.replyKey.includes(":closed:"))).toHaveLength(1);
    expect(sends).toBe(sentBefore);
  });
});
