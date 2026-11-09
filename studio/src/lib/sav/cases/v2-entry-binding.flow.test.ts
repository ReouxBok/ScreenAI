import type { CaseInvestigationModelRequest } from "./investigation-runner";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import {
  contentChunks, contentItems, contentVersions, savCaseCalls, savCaseEffectExecutions, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns,
  savMailboxes, savMessages, savSyncState, savThreads, staffUsers, savKnowledgeActivations, activeKnowledge, knowledgeRevisions, reviewEvents, savCaseReplyValidations,
} from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));

// V1's model dispatcher is imported by C's module graph: every function of it throws if called (V2 never uses V1's model path or budget).
vi.mock("../intake/model-dispatch", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => { throw Error(`MODEL_DISPATCH_FORBIDDEN:${name}`); } : value]));
});
// No SDK either: the V1 embedding helper must never be reached by V2.
vi.mock("@/lib/embeddings", () => ({ embedTexts: () => { throw Error("V1_EMBEDDING_FORBIDDEN"); } }));
import { encryptSavPayload } from "../crypto";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import { readCase } from "./case-store";
import type { CaseAdmissionQualification } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import { runCaseInvestigationRuntime } from "./investigation-runtime";
import { createCaseInvestigationToReplyPlan, createCaseInvestigationV2Deps, type CaseInvestigationV2Input } from "./investigation-v2-factory";
import { caseGeminiDecisionProvider, caseHubspotOwnerReadTransport } from "./investigation-v2-providers";
import { readCaseV2SpendDay, readCaseV2SpendPolicy, releaseCaseV2Spend, reserveCaseV2Spend, settleCaseV2Spend } from "./investigation-v2-spend";

/*
 * B (4/11, SYN): the V2 investigation on its REAL adapters, built by the factory A and the wake call. Real database (synthetic), real index
 * query, real ledger, real spend register, real owner reader; the ONLY double is the network (Gemini and HubSpot answer from this file,
 * any other URL throws). Every key, model, amount and id is synthetic and named so; nothing is sent anywhere.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 8_990_000;
const AT = "2026-10-31T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000004", V2_OWNER = "90000001";
const ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" };
const SENDER = "client@example.invalid";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } };
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
const readQualification = async (input: { requests: { requestId: string }[] }): Promise<CaseAdmissionQualification> =>
  ({ requests: input.requests.map(request => ruled(request.requestId)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] });

/** One stored V1 mail on a ticket, relayed by A. `ownerEffect`: V1's confirmed V2 owner effect on it (historic ledger row). */
async function v1Mail(options: { ticketId?: string; threadId?: string; ownerEffect: boolean }) {
  const ticketId = options.ticketId ?? String(++seq), threadId = options.threadId ?? randomUUID(), messageId = randomUUID();
  if (!options.threadId) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Bonjour, je ne reçois pas le code de connexion.", headers: { "message-id": `<gm-${messageId}@example.invalid>` } }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
  const runVersion = (await f.db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, threadId))).length + 1;
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: [{ id: "r0", kind: "support" }] } } }) }).returning();
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: [{ id: "r0", kind: "support", currentMessageId: messageId }], ticketSummary: { title: "Connexion impossible", description: "Le code n'arrive pas.", requestIds: ["r0"] } };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: runVersion, isCurrent: false, state: "observed", configHash: `runtime-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
      records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  await f.db.update(savIntakeExecutions).set({ runId: run!.id, runVersion }).where(eq(savIntakeExecutions.id, execution!.id));
  if (options.ownerEffect) {
    const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
    await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
      intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
  }
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }),
    readAdmissionPolicy: async () => POLICY, readQualification, env: ENV }) as { caseId: string; appended: boolean; owner: string };
  return { ticketId, threadId, gmail: `gm-${messageId}`, caseId: relayed.caseId, relayed };
}


/** SYN spend policy: invented amounts for this test only, approved by nobody. */
const SPEND = { revision: "spend-syn-r1", approvedBy: STAFF, approvedAt: AT,
  embedding: { dailyCapMicroUsd: 10_000, reserveMicroUsdPerCall: 100, microUsdPerMillionInputTokens: 150 },
  model: { dailyCapMicroUsd: 1_000_000, reserveMicroUsdPerCall: 50_000, microUsdPerMillionInputTokens: 300, microUsdPerMillionOutputTokens: 2_500 } };
const V2_KEY = "syn-v2-key", V1_KEY = "syn-v1-key-never-used";
let card = { id: "", contentVersionId: "" };
const scopeJson = () => JSON.stringify({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: POLICY.revision, revision: "scope-syn-r1", family: "access",
  sources: [{ knowledgeId: card.id, contentVersionId: card.contentVersionId, use: "answer" }] });
const environment = (over: Record<string, string | undefined> = {}) => ({ ...ENV, SAV_V2_INVESTIGATION: "observe", SAV_V2_GEMINI_API_KEY: V2_KEY, SAV_GEMINI_API_KEY: V1_KEY,
  SAV_V2_EMBEDDING_MODEL: "syn-embedding", SAV_V2_MODEL: "syn-model", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(SPEND), SAV_V2_ACCESS_SCOPE_JSON: scopeJson(),
  HUBSPOT_ACCESS_TOKEN: "syn-hubspot-token", SAV_CASE_EFFECTS: "supervised", ...over });
const readPolicyRecord = async () => ({ policy: POLICY, validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2027-12-31T00:00:00.000Z" });
const UNIT = () => [1, ...new Array<number>(767).fill(0)];

type Call = { url: string; headers: Record<string, string>; body: unknown };
/** The ONLY double: Gemini and HubSpot over `network`. `generate` answers the decision; anything else throws. */
function network(options: { generate?: (body: unknown) => Response; owner?: string; embedStatus?: number } = {}) {
  const calls: Call[] = [];
  const net = async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries()), body = init.body ? JSON.parse(String(init.body)) as unknown : null;
    calls.push({ url, headers, body });
    if (url === "https://generativelanguage.googleapis.com/v1beta/models/syn-embedding:batchEmbedContents") {
      if (options.embedStatus) return new Response("{}", { status: options.embedStatus });
      const requests = (body as { requests: unknown[] }).requests;
      return Response.json({ embeddings: requests.map(() => ({ values: UNIT() })) });
    }
    if (url === "https://generativelanguage.googleapis.com/v1beta/models/syn-model:generateContent") return (options.generate ?? decision)(body);
    const owner = /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/tickets\/(\d+)\?properties=hubspot_owner_id$/.exec(url);
    if (owner) return Response.json({ id: owner[1], properties: { hubspot_owner_id: options.owner ?? V2_OWNER } });
    throw Error(`NETWORK_FORBIDDEN:${url}`);
  };
  return { net, calls };
}
/** The synthetic model's answer: an accepted procedure citing the seeded card, with the official link; usage 1 000 in / 200 out. */
function decision(body: unknown) {
  const payload = JSON.parse((body as { contents: { parts: { text: string }[] }[] }).contents[0]!.parts[0]!.text) as { caseVersion: number; openRequests: { id: string }[] };
  const ref = { knowledgeId: card.id, contentVersionId: card.contentVersionId };
  const output = { caseVersion: payload.caseVersion, understanding: { requests: payload.openRequests.map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
    nextAction: { kind: "answer", requestIds: [payload.openRequests[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: ref }], expectedResult: "La connexion fonctionne." },
    reply: { text: "Bonjour, voici la marche à suivre depuis https://new.limova.ai : suivre la fiche.", citations: [ref], impossibilityClaims: [], accountAdvice: "none" } };
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 200 } });
}
async function seedCard() {
  await f.client.exec("TRUNCATE content_items, active_knowledge, knowledge_revisions CASCADE");
  await f.db.insert(knowledgeRevisions).values({ id: "kb-syn", actorEmail: "staff@example.invalid" });
  await f.db.insert(activeKnowledge).values({ singleton: true, revisionId: "kb-syn" });
  const verified = new Date(Date.now() - 2 * 86_400_000);
  const [item] = await f.db.insert(contentItems).values({ slug: "syn-login", type: "article", title: "Fiche connexion synthétique", ownerEmail: "staff@example.invalid", status: "published",
    agentKey: "sav", aiEnabled: true, locale: "fr-FR", verifiedAt: verified }).returning();
  const body = "Procédure synthétique : ouvrir new.limova.ai, saisir l'adresse, puis le code reçu.";
  const [version] = await f.db.insert(contentVersions).values({ itemId: item!.id, version: 1, bodyMarkdown: body, metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "",
    troubleshooting: "", resolution: { audience: "support", symptoms: ["connexion"], steps: ["Ouvrir new.limova.ai.", "Saisir le code reçu."], exceptions: [], escalation: "Revue", productVersion: "test", supersedes: [], conflictsWith: [] } },
    changeNote: "Fixture", authorEmail: "staff@example.invalid", createdAt: verified }).returning();
  await f.db.update(contentItems).set({ publishedVersionId: version!.id }).where(eq(contentItems.id, item!.id));
  await f.db.insert(savKnowledgeActivations).values({ itemId: item!.id, versionId: version!.id, title: "Fiche connexion synthétique", activatedBy: "fixture", activatedAt: verified });
  await f.db.insert(reviewEvents).values({ itemId: item!.id, versionId: version!.id, action: "approved", actorEmail: "staff@example.invalid", createdAt: verified } as typeof reviewEvents.$inferInsert);
  await f.db.insert(contentChunks).values({ itemId: item!.id, versionId: version!.id, ordinal: 0, heading: "Connexion", content: body, embedding: UNIT() } as typeof contentChunks.$inferInsert);
  card = { id: item!.id, contentVersionId: version!.id };
}
const input = (net: ReturnType<typeof network>, over: Partial<CaseInvestigationV2Input> = {}, env = environment()): CaseInvestigationV2Input =>
  ({ env: () => env, readPolicyRecord, network: net.net, now: () => new Date(Date.now() + 6 * 60_000), ...over });
/** Only V2 spend rows: the store's own markers in `sav.sync_state` (schema, cursors) stay. */
const clearSpend = () => f.db.delete(savSyncState).where(like(savSyncState.key, "sav-v2-spend.v1:%"));
const today = () => new Date(Date.now() + 6 * 60_000).toISOString().slice(0, 10);


import { loadCaseContinuationPoint } from "./v2-entry-binding";
import { routeCustomerReturn } from "./customer-return-store";
import { executionPolicySchema } from "../intake/execution-policy";
import { decryptSavPayload } from "../crypto";
import { runCaseEffectsPass } from "./case-runtime-effects";
import { createCaseV2WakeDeps } from "./case-v2-wake-ports";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { readCaseReplyDisclosure } from "./case-reply-outbound";
import { SAV_CASE_INBOUND_SETTLE_SECONDS } from "./case-types";
import type { CaseReplyProposal } from "./case-effects";
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});

let policyHash = "", adminId = "", executionPolicy: ReturnType<typeof executionPolicySchema.parse>;
async function executionEnv(): Promise<Record<string, string | undefined>> {
  const policy = executionPolicySchema.parse({
    revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
    createdAfter: new Date(Date.now() - 60_000).toISOString(), receivedAfter: new Date(Date.now() - 3600_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    maxDossiers: 100, mutations: ["send_case_reply"], admission: { kind: "automatic" },
  });
  policyHash = intakeRuntimeHash(policy); executionPolicy = policy;
  await f.db.update(savIntakeExecutionPolicies).set({ policyHash, payloadCiphertext: encryptSavPayload(policy) }).where(eq(savIntakeExecutionPolicies.id, policyId));
  return environment({
    SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: STAFF,
    SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId,
    SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash, SAV_CODE_REVISION: "a".repeat(40),
    SAV_V2_ADMISSION_POLICY_JSON: JSON.stringify(await readPolicyRecord()),
    SAV_V2_RETURN_RULE_JSON: JSON.stringify({ ruleId: "rule-access", revision: "r1" }),
  });
}
async function returnedCase(env: Record<string, string | undefined>, text = "Toujours pas de code.") {
  const made = await v1Mail({ ownerEffect: true });
  const id = randomUUID(), gmail = `gm-${id}`;
  await f.db.insert(savMessages).values({ id, threadId: made.threadId, mailboxId, direction: "inbound", gmailMessageId: gmail,
    fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Re: Synthétique",
    bodyCiphertext: encryptSavPayload({ text, headers: { "message-id": `<${gmail}@example.invalid>` } }), receivedAt: new Date() });
  expect(await routeCustomerReturn(id, { env, readTicketOwner: async () => V2_OWNER })).toMatchObject({ route: { route: "continue" }, written: true });
  return { ...made, gmail };
}
/** The store waits SAV_CASE_INBOUND_SETTLE_SECONDS after the last recorded customer mail before any claim (a burst of mails
 * is analysed once). The loader reads the real clock, so a case is continued as the next pass would: after that window. */
const afterSettle = () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + (SAV_CASE_INBOUND_SETTLE_SECONDS + 60) * 1000); };
const effectRows = (id: string) => f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId,id));

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-runtime-proof-key-32-chars!!");
  f = await createSavTestDb(); state.db = f.db;
  // This is the application's allowlisted address in an isolated synthetic staff row; no Clerk account or real mailbox is used.
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-binding-admin", email: "contact@limova.ai", role: "admin", active: true }).returning();
  adminId = admin!.id;
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  mailboxId = mailbox!.id;
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: adminId, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-runtime-proof-key-32-chars!!"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  await clearSpend(); await seedCard();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("actual continuation loader: real factory and authorizer, synthetic transport only", () => {
  it("return -> loader -> queued automated reply -> one verified send, replay sends nothing more", async () => {
    const env = await executionEnv(), made = await returnedCase(env), net = network();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    const point = await loadCaseContinuationPoint();
    // Inside the settle window the claim is refused: the owner is read first (Ugo 31/10), no model or embedding call.
    expect(await point({ caseId: made.caseId, trigger: "customer_return", env })).toEqual({ status: "claim_refused" });
    expect(net.calls.filter(call => call.url.includes("generativelanguage"))).toEqual([]);
    afterSettle();
    expect(await point({ caseId: made.caseId, trigger: "customer_return", env })).toEqual({ status: "queued" });
    const validations = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, made.caseId));
    expect(validations).toHaveLength(1);
    expect(validations[0]).toMatchObject({ state: "approved" });
    const proposal = decryptSavPayload<CaseReplyProposal>(validations[0]!.proposalCiphertext);
    expect(readCaseReplyDisclosure(proposal.text)?.mode).toBe("automated");
    expect(await effectRows(made.caseId)).toHaveLength(1);
    const provider = executionProvider(); provider.setGmail(made.gmail, `thread-${made.threadId}`); provider.seedTicket({ id: made.ticketId, ownerId: V2_OWNER, stage: "new" });
    let sends = 0;
    const deps = createCaseV2WakeDeps({ env: () => env, policy: { id: policyId, hash: policyHash }, readPolicyRecord,
      since: new Date(Date.now() - 60_000), deadlineMs: Date.now() + 60_000,
      network: provider.network as typeof fetch,
      gmail: { request: async (mailbox, path, init) => { if (path.replace(/^\//, "") === "messages/send") sends++; return provider.gmail(mailbox,path,init); }, permissions: async () => {} },
    });
    // As in case-v2-wake.flow: only the pins of the V1 observation environment are replaced, every other port is the canonical adapter.
    const replies = { ...deps.replies, context: { runtime: {} as never, policy: executionPolicy } };
    const report = await runCaseEffectsPass(replies);
    expect(report.supervised).toEqual(expect.arrayContaining([expect.objectContaining({ state: "confirmed" })]));
    expect(sends).toBe(1);
    await point({ caseId: made.caseId, trigger: "sweep", env });
    await runCaseEffectsPass(replies);
    expect(sends).toBe(1);
    expect(await effectRows(made.caseId)).toHaveLength(1);
  });
  it("missing return rule does not call the model or queue a reply", async () => {
    const env = await executionEnv(), made = await returnedCase(env), net = network();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url),init)));
    delete env.SAV_V2_RETURN_RULE_JSON;
    afterSettle(); // outside the settle window, so that only the missing rule can stop the run
    expect(await (await loadCaseContinuationPoint())({ caseId: made.caseId, trigger: "customer_return", env })).not.toEqual({ status: "claim_refused" });
    expect(net.calls.filter(call => call.url.includes("generativelanguage"))).toEqual([]);
    expect(await effectRows(made.caseId)).toEqual([]);
  });
  it("disabled investigation makes no provider call", async () => {
    const point = await loadCaseContinuationPoint();
    expect(await point({ caseId: randomUUID(), trigger: "sweep", env: {} })).toEqual({status:"investigation_off"});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("malformed return policy never reaches a provider", async () => {
    const env=await executionEnv(); env.SAV_V2_RETURN_RULE_JSON="{";
    await expect((await loadCaseContinuationPoint())({caseId:randomUUID(),trigger:"customer_return",env})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

/*
 * Lot 2 (V2 access release, 9/11): auto ON on a customer return, through the actual loader and its real controls
 * (admission, family, access scope, owner, pause, authorizer). Only the network and Gmail are doubles.
 * A case that must not be answered automatically is checked at every exit: no approved validation, no effect row, no send.
 */
import { savAgentPauseKey, SAV_AGENT_PAUSE_REVISION } from "../intake/agent-pause";

/** The return as recorded, without presuming its route: a mixed or sensitive return may well leave the access path. */
async function returnOnly(env: Record<string, string | undefined>, text: string) {
  const made = await v1Mail({ ownerEffect: true });
  const id = randomUUID(), gmail = `gm-${id}`;
  await f.db.insert(savMessages).values({ id, threadId: made.threadId, mailboxId, direction: "inbound", gmailMessageId: gmail,
    fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Re: Synthétique",
    bodyCiphertext: encryptSavPayload({ text, headers: { "message-id": `<${gmail}@example.invalid>` } }), receivedAt: new Date() });
  const routed = await routeCustomerReturn(id, { env, readTicketOwner: async () => V2_OWNER });
  return { ...made, gmail, routed };
}
const approvedValidations = async (caseId: string) =>
  (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, caseId))).filter(row => row.state === "approved");
/** Every pass a deployment could run on the case: the loader on each trigger, then the effects pass. Returns what was attempted. */
async function everyPass(made: { caseId: string; gmail: string; threadId: string; ticketId: string }, env: Record<string, string | undefined>, net: ReturnType<typeof network>) {
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
  const point = await loadCaseContinuationPoint(), statuses: string[] = [];
  for (const trigger of ["customer_return", "sweep"] as const) {
    try { statuses.push((await point({ caseId: made.caseId, trigger, env })).status); } catch (error) { statuses.push(`threw:${(error as Error).message}`); }
  }
  const provider = executionProvider(); provider.setGmail(made.gmail, `thread-${made.threadId}`); provider.seedTicket({ id: made.ticketId, ownerId: V2_OWNER, stage: "new" });
  let sends = 0;
  const deps = createCaseV2WakeDeps({ env: () => env, policy: { id: policyId, hash: policyHash }, readPolicyRecord, since: new Date(Date.now() - 60_000), deadlineMs: Date.now() + 60_000,
    network: provider.network as typeof fetch,
    gmail: { request: async (mailbox, path, init) => { if (path.replace(/^\//, "") === "messages/send") sends++; return provider.gmail(mailbox, path, init); }, permissions: async () => {} } });
  await runCaseEffectsPass({ ...deps.replies, context: { runtime: {} as never, policy: executionPolicy } });
  return { statuses, sends, modelCalls: net.calls.filter(call => call.url.includes(":generateContent")).length };
}
async function expectNoAutomatedAnswer(made: { caseId: string; gmail: string; threadId: string; ticketId: string }, env: Record<string, string | undefined>, net = network()) {
  const result = await everyPass(made, env, net);
  expect(result.statuses).not.toContain("queued");
  expect(await approvedValidations(made.caseId)).toEqual([]);
  expect(await effectRows(made.caseId)).toEqual([]);
  expect(result.sends).toBe(0);
  return result;
}

describe("auto ON on a customer return (G-AUTO-1): a request that is not only access is never answered automatically", () => {
  // Control of this harness: the same passes DO answer a return that is only access, so a green refusal below is a real refusal.
  it("control — a return that is only access is answered once by the same passes", async () => {
    const env = await executionEnv(), made = await returnOnly(env, "Toujours pas de code.");
    expect(made.routed).toMatchObject({ route: { route: "continue" }, written: true });
    afterSettle();
    const result = await everyPass(made, env, network());
    expect(result.statuses[0]).toBe("queued");
    expect(await approvedValidations(made.caseId)).toHaveLength(1);
    expect(await effectRows(made.caseId)).toHaveLength(1);
    expect(result.sends).toBe(1);
  });
  // Q1 (review 70f, S02/S05/S07): a request written under the name, shaped like a job title, must not vanish behind « ça marche ».
  it.each([
    ["finance under the signature", "Ça marche, merci !\n\nJean Dupont\nDeux sommes prises en octobre"],
    ["termination under the signature", "Ça marche.\n\nJean\nFermez tout au 30"],
    ["account holder under the signature", "Ça marche, merci !\n\nJean Dupont\nNouveau propriétaire du compte : Paul Martin"],
    ["export under the signature", "Ça marche.\n\nMarie Martin\nExport des conversations vide"],
  ])("Q1 — %s: no automated reply, no closing proof", async (_name, text) => {
    const env = await executionEnv(), made = await returnOnly(env, text);
    afterSettle();
    await expectNoAutomatedAnswer(made, env);
    expect((await readCase(made.caseId))?.phase).not.toBe("resolved");
  });
  it("mixed return (F3): still no code AND a double debit -> no automated reply", async () => {
    const env = await executionEnv(), made = await returnOnly(env, "Toujours pas de code. Par ailleurs vous m'avez prélevé deux fois ce mois-ci, merci de me rembourser.");
    afterSettle();
    await expectNoAutomatedAnswer(made, env);
  });
  it("a plain thank-you is not a resolution: no automated reply, the case is not resolved", async () => {
    const env = await executionEnv(), made = await returnOnly(env, "Merci.");
    afterSettle();
    await expectNoAutomatedAnswer(made, env);
    expect((await readCase(made.caseId))?.phase).not.toBe("resolved");
  });
});

describe("auto ON: the real controls of the loader refuse before any automated reply (G-AUTO-3)", () => {
  it("an access scope approved for another policy revision is stale: no model call, nothing queued", async () => {
    const env = await executionEnv(), made = await returnedCase(env);
    env.SAV_V2_ACCESS_SCOPE_JSON = JSON.stringify({ ...JSON.parse(scopeJson()), policyRevision: "policy-r0" });
    afterSettle();
    const result = await expectNoAutomatedAnswer(made, env);
    expect(result.modelCalls).toBe(0);
  });
  it("an access scope that does not list the cited card: the reply is never approved automatically", async () => {
    const env = await executionEnv(), made = await returnedCase(env);
    env.SAV_V2_ACCESS_SCOPE_JSON = JSON.stringify({ ...JSON.parse(scopeJson()), sources: [{ knowledgeId: randomUUID(), contentVersionId: randomUUID(), use: "answer" }] });
    afterSettle();
    await expectNoAutomatedAnswer(made, env);
  });
  it("a person owns the ticket in HubSpot: no model call, nothing queued", async () => {
    const env = await executionEnv(), made = await returnedCase(env);
    afterSettle();
    const result = await expectNoAutomatedAnswer(made, env, network({ owner: "70000007" }));
    expect(result.modelCalls).toBe(0);
  });
  it("the console pause of the SAV agent stops the V2 claim: no model call, nothing queued", async () => {
    const env = await executionEnv(), made = await returnedCase(env);
    const pause = { revision: SAV_AGENT_PAUSE_REVISION, agent: "intake", level: "fully_paused", setBy: "staff@example.invalid", setAt: new Date().toISOString(), reason: "Pause synthétique" };
    await f.db.insert(savSyncState).values({ key: savAgentPauseKey("intake"), cursor: encryptSavPayload(pause), status: "active", updatedAt: new Date() });
    try {
      afterSettle();
      const result = await expectNoAutomatedAnswer(made, env);
      expect(result.modelCalls).toBe(0);
    } finally { await f.db.delete(savSyncState).where(eq(savSyncState.key, savAgentPauseKey("intake"))); }
  });
});

describe("auto ON: after the automated approval, the send respects people and uncertain results", () => {
  async function queuedCase() {
    const env = await executionEnv(), made = await returnedCase(env), net = network();
    afterSettle();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    expect(await (await loadCaseContinuationPoint())({ caseId: made.caseId, trigger: "customer_return", env })).toEqual({ status: "queued" });
    expect(await effectRows(made.caseId)).toHaveLength(1);
    return { env, made };
  }
  function effects(env: Record<string, string | undefined>, made: { gmail: string; threadId: string; ticketId: string }, options: { owner?: string; loseAck?: () => boolean } = {}) {
    const provider = executionProvider(); provider.setGmail(made.gmail, `thread-${made.threadId}`); provider.seedTicket({ id: made.ticketId, ownerId: options.owner ?? V2_OWNER, stage: "new" });
    const counter = { sends: 0 };
    const deps = createCaseV2WakeDeps({ env: () => env, policy: { id: policyId, hash: policyHash }, readPolicyRecord, since: new Date(Date.now() - 60_000), deadlineMs: Date.now() + 60_000,
      network: provider.network as typeof fetch,
      gmail: { request: async (mailbox, path, init) => {
        const send = path.replace(/^\//, "") === "messages/send";
        if (send) counter.sends++;
        const result = await provider.gmail(mailbox, path, init);
        if (send && options.loseAck?.()) throw Error("SAV_TEST_ACK_LOST");
        return result;
      }, permissions: async () => {} } });
    return { provider, counter, pass: () => runCaseEffectsPass({ ...deps.replies, context: { runtime: {} as never, policy: executionPolicy } }) };
  }
  it("a person takes the ticket between the approval and the send: nothing is sent, the execution ends for the person", async () => {
    const { env, made } = await queuedCase();
    const run = effects(env, made, { owner: "70000007" });
    const report = await run.pass();
    expect(report.supervised).toEqual([expect.objectContaining({ state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_HUMAN" })]);
    await run.pass();
    expect(run.counter.sends).toBe(0);
  });
  it("a lost Gmail acknowledgement is an uncertain result: it is verified, never sent again", async () => {
    const { env, made } = await queuedCase();
    let first = true;
    const run = effects(env, made, { loseAck: () => { const lose = first; first = false; return lose; } });
    await run.pass();
    expect(run.counter.sends).toBe(1);
    await f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
    await run.pass(); await run.pass();
    expect(run.counter.sends).toBe(1);
    expect(await effectRows(made.caseId)).toHaveLength(1);
  });
});
