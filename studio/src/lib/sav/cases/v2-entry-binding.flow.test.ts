import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import {
  contentChunks, contentItems, contentVersions, savCaseEffectExecutions, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns,
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
  transport: { model: "syn-model", embeddingModel: "syn-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 131072, maxOutputTokens: 1024,
    maxInputBytes: 100_000, embeddingMaxInputTokens: 8192, embeddingMaxTexts: 3, embeddingMaxTextBytes: 4000 },
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
/** Only V2 spend rows: the store's own markers in `sav.sync_state` (schema, cursors) stay. */
const clearSpend = () => f.db.delete(savSyncState).where(like(savSyncState.key, "sav-v2-spend.v1:%"));


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
async function executionEnv(mutations: string[] = ["send_case_reply"]): Promise<Record<string, string | undefined>> {
  const policy = executionPolicySchema.parse({
    revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
    createdAfter: new Date(Date.now() - 60_000).toISOString(), receivedAfter: new Date(Date.now() - 3600_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    maxDossiers: 100, mutations, admission: { kind: "automatic" },
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
    expect(await point({ caseId: made.caseId, trigger: "customer_return", env })).toMatchObject({ status: "claim_refused" });
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
    expect((await (await loadCaseContinuationPoint())({ caseId: made.caseId, trigger: "customer_return", env })).status).not.toBe("claim_refused");
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
  // Soft: a failure reports every exit that leaked (queue, approval, effect, send), not only the first one.
  expect.soft(result.statuses).not.toContain("queued");
  expect.soft(await approvedValidations(made.caseId)).toEqual([]);
  expect.soft(await effectRows(made.caseId)).toEqual([]);
  expect.soft(result.sends).toBe(0);
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
      gmail: { request: async <T,>(mailbox: string, path: string, init?: RequestInit) => {
        const send = path.replace(/^\//, "") === "messages/send";
        if (send) counter.sends++;
        const result = await provider.gmail<T>(mailbox, path, init);
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

import { runCaseV2Wake } from "./case-v2-wake";
describe("auto ON: « ça remarche » after the automated answer closes the ticket once, through the actual loader", () => {
  it("answer sent -> thanks with a quote -> decision and a distinct second reading -> case resolved, ONE closing, no mail, replays add nothing", async () => {
    // Ticket stages ON and granted by the execution policy, as case-v2-wake.flow: without them the proven resolution refuses ("stages_off") and closes nothing.
    const env = { ...await executionEnv(["send_case_reply", "set_case_ticket_stage"]), SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "2", SAV_V2_STAGE_CLOSED: "4" }, made = await returnedCase(env);
    afterSettle();
    const provider = executionProvider(); provider.setGmail(made.gmail, `thread-${made.threadId}`); provider.seedTicket({ id: made.ticketId, ownerId: V2_OWNER, stage: "new" });
    let sends = 0;
    const wakeDeps = () => {
      const deps = createCaseV2WakeDeps({ env: () => env, policy: { id: policyId, hash: policyHash }, readPolicyRecord, since: new Date(Date.now() - 600_000), deadlineMs: Date.now() + 60_000,
        network: provider.network as typeof fetch,
        gmail: { request: async (mailbox, path, init) => { if (path.replace(/^\//, "") === "messages/send") sends++; return provider.gmail(mailbox, path, init); }, permissions: async () => {} } });
      const context = { runtime: {} as never, policy: executionPolicy };
      return { ...deps, replies: { ...deps.replies, context }, handoff: { ...deps.handoff, context, crm: async () => ({ ticket: null, contacts: [] }) }, stages: { ...deps.stages, context } };
    };
    // 1. The automated answer, then the wake that sends it (the trial is opened by the confirmed receipt, never by this test).
    let net = network();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    const point = await loadCaseContinuationPoint();
    expect(await point({ caseId: made.caseId, trigger: "customer_return", env })).toEqual({ status: "queued" });
    await runCaseV2Wake(wakeDeps());
    expect(sends).toBe(1);
    const trials = (await readCase(made.caseId))!.body.trials;
    expect(trials).toHaveLength(1);
    // 2. A minute later (the faked clock does not run by itself), the customer confirms in words that can be quoted.
    vi.setSystemTime(Date.now() + 60_000);
    const thanksId = randomUUID(), thanks = `gm-${thanksId}`;
    await f.db.insert(savMessages).values({ id: thanksId, threadId: made.threadId, mailboxId, direction: "inbound", gmailMessageId: thanks, fromEmail: SENDER, toEmails: ["support@example.invalid"],
      subject: "Re: Synthétique", bodyCiphertext: encryptSavPayload({ text: "Merci, ça remarche depuis l'autre navigateur !", headers: { "message-id": `<${thanks}@example.invalid>` } }), receivedAt: new Date() });
    expect(await routeCustomerReturn(thanksId, { env, readTicketOwner: async () => V2_OWNER })).toMatchObject({ route: { route: "continue" }, written: true });
    vi.setSystemTime(Date.now() + (SAV_CASE_INBOUND_SETTLE_SECONDS + 60) * 1000);
    // 3. The model proposes the closure citing the customer's words; a distinct second reading confirms it (both synthetic).
    const purposes: string[] = [];
    net = network({ generate: body => {
      const payload = JSON.parse((body as { contents: { parts: { text: string }[] }[] }).contents[0]!.parts[0]!.text) as { caseVersion: number; purpose: string; openRequests: { id: string }[] };
      purposes.push(payload.purpose);
      const ids = payload.openRequests.map(row => row.id);
      const output = payload.purpose === "resolution_check"
        ? { verdicts: ids.map(requestId => ({ requestId, verdict: "resolved" })) }
        : { caseVersion: payload.caseVersion, understanding: { requests: ids.map(id => ({ id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
          nextAction: { kind: "confirm_resolution", requestIds: [ids[0]], evidence: [{ requestId: ids[0], source: { type: "email", id: thanks }, trialId: trials[0]!.id, quote: "ça remarche" }] } };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 200 } });
    } });
    const closing = await point({ caseId: made.caseId, trigger: "customer_return", env });
    expect(purposes).toEqual(["decision", "resolution_check"]);
    expect(closing.status).not.toBe("queued");
    // 4. The wake closes the case and the ticket once; later wakes and a replay of the loader add nothing and send nothing.
    const first = await runCaseV2Wake(wakeDeps());
    expect(first.closures).toMatchObject({ resolved: 1 });
    expect(await readCase(made.caseId)).toMatchObject({ phase: "resolved" });
    for (let n = 0; n < 3; n++) await runCaseV2Wake(wakeDeps());
    await point({ caseId: made.caseId, trigger: "sweep", env });
    await runCaseV2Wake(wakeDeps());
    const closed = (await effectRows(made.caseId)).filter(row => row.replyKey.includes(":closed:"));
    expect(closed).toHaveLength(1);
    expect(provider.objects.tickets[made.ticketId]!.properties.hs_pipeline_stage).toBe("4");
    expect(provider.calls.filter(call => call.method === "PATCH" && (call.body as { properties?: { hs_pipeline_stage?: string } })?.properties?.hs_pipeline_stage === "4")).toHaveLength(1);
    expect(sends).toBe(1);
  });
});

import { continueCaseAfterCommit, customerReturnGate } from "./v2-entry";
import { bindSavV2QualificationThread, SAV_V2_QUALIFICATION_SCOPE_SCHEMA } from "./qualification-scope";
/*
 * SAV-80 on the real chain (same real database, loader, factory, ledger and effect driver as above; the network is the only double): the qualification scope
 * narrows V2 to ONE bound thread. Synthetic values only (example.invalid sender, invented contact id). Slack, stages and J2 stay OFF as root decided.
 */
describe("SAV-80 qualification scope: one bound thread, closed for everything else, uncertain results still verified", () => {
  const CONTACT = "100000001";
  let windowStart = 0;
  const scoped = (env: Record<string, string | undefined>, over: Record<string, string> = {}) => ({ ...env, SAV_V2_SCOPE_MODE: "qualification",
    SAV_V2_QUALIFICATION_SCOPE_JSON: JSON.stringify({ schema: SAV_V2_QUALIFICATION_SCOPE_SCHEMA, revision: `q-syn-${windowStart}`, senderEmail: SENDER, hubspotContactId: CONTACT,
      initialSubject: "Synthétique", notBefore: new Date(windowStart - 30 * 60_000).toISOString(), expiresAt: new Date(windowStart + 15 * 60_000).toISOString(), ...over }) });
  /** The opening mail of a thread, bound as the owner at creation would (the only binder), then a return on it routed by V2. */
  async function boundCase(env: Record<string, string | undefined>) {
    const made = await returnedCase(env);
    const [first] = await f.db.select({ id: savMessages.id }).from(savMessages).where(eq(savMessages.threadId, made.threadId)).orderBy(savMessages.receivedAt).limit(1);
    expect(await bindSavV2QualificationThread(env, { messageId: first!.id, primaryContactId: CONTACT })).toEqual({ allowed: true });
    return made;
  }
  const continued = async (env: Record<string, string | undefined>, caseId: string) =>
    continueCaseAfterCommit(caseId, "customer_return", { env, continuation: await loadCaseContinuationPoint() });
  function effectsFor(env: Record<string, string | undefined>, made: { gmail: string; threadId: string; ticketId: string }, loseAck?: () => boolean) {
    const provider = executionProvider(); provider.setGmail(made.gmail, `thread-${made.threadId}`); provider.seedTicket({ id: made.ticketId, ownerId: V2_OWNER, stage: "new" });
    const counter = { sends: 0 };
    const pass = () => {
      const deps = createCaseV2WakeDeps({ env: () => env, policy: { id: policyId, hash: policyHash }, readPolicyRecord, since: new Date(Date.now() - 600_000), deadlineMs: Date.now() + 60_000,
        network: provider.network as typeof fetch,
        gmail: { request: async <T,>(mailbox: string, path: string, init?: RequestInit) => {
          const send = path.replace(/^\//, "") === "messages/send";
          if (send) counter.sends++;
          const result = await provider.gmail<T>(mailbox, path, init);
          if (send && loseAck?.()) throw Error("SAV_TEST_ACK_LOST");
          return result;
        }, permissions: async () => {} } });
      return runCaseEffectsPass({ ...deps.replies, context: { runtime: {} as never, policy: executionPolicy } });
    };
    return { counter, pass };
  }
  beforeEach(() => { windowStart = Date.now(); });

  it("the bound thread: investigated and answered once, exactly as without the scope", async () => {
    const env = scoped(await executionEnv()), made = await boundCase(env), net = network();
    afterSettle();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    expect(await continued(env, made.caseId)).toEqual({ status: "queued" });
    const run = effectsFor(env, made);
    await run.pass(); await run.pass();
    expect(run.counter.sends).toBe(1);
  });
  it.each([
    ["no thread bound yet", false],
    ["the scope expired", true],
    ["another thread is bound", "other"],
  ] as const)("%s: no model call, nothing queued, nothing marked", async (_name, bind) => {
    const base = await executionEnv(), env = scoped(base), net = network();
    if (bind === "other") await boundCase(env);
    const made = bind === true ? await boundCase(env) : await returnedCase(env);
    afterSettle();
    if (bind === true) vi.setSystemTime(windowStart + 20 * 60_000);
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    expect(await continued(env, made.caseId)).toEqual({ status: "qualification_out_of_scope" });
    expect(net.calls).toEqual([]);
    expect(await effectRows(made.caseId)).toHaveLength(0);
  });
  it.each([
    ["before the embedding", (url: string) => url.startsWith("https://api.hubapi.com/"), ":batchEmbedContents"],
    ["after the embedding, before the model call", (url: string) => url.endsWith(":batchEmbedContents"), ":generateContent"],
  ] as const)("the scope expires during the investigation, %s: no further provider call, nothing queued", async (_name, expiresAt, never) => {
    const env = scoped(await executionEnv()), made = await boundCase(env), net = network();
    afterSettle();
    let advanced = false;
    // The clock moves past the window while the entry is already passed: on the owner read (before retrieval) or on the embedding answer (before generation).
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const response = await net.net(String(url), init);
      if (!advanced && expiresAt(String(url))) { advanced = true; vi.setSystemTime(windowStart + 20 * 60_000); }
      return response;
    }));
    const outcome = await continued(env, made.caseId);
    expect(advanced).toBe(true);
    expect(outcome.status).not.toBe("queued");
    expect(net.calls.filter(call => call.url.endsWith(never))).toEqual([]);
    expect(net.calls.filter(call => call.url.endsWith(":generateContent"))).toEqual([]);
    expect(await effectRows(made.caseId)).toHaveLength(0);
  });
  it.each([["control: the scope stays open", false], ["the scope expires between the first model call and its correction", true]] as const)("%s", async (_name, expire) => {
    const env = scoped(await executionEnv()), made = await boundCase(env);
    let generations = 0;
    // First answer: a stale case version (a correctable refusal), then the valid decision: two model calls in one pass when nothing stops it.
    const net = network({ generate: body => {
      generations++;
      if (generations > 1) return decision(body);
      const text = (body as { contents: { parts: { text: string }[] }[] }).contents[0]!.parts[0]!.text, payload = JSON.parse(text) as { caseVersion: number };
      return decision({ contents: [{ parts: [{ text: JSON.stringify({ ...payload, caseVersion: payload.caseVersion + 7 }) }] }] });
    } });
    afterSettle();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const response = await net.net(String(url), init);
      if (expire && String(url).endsWith(":generateContent")) vi.setSystemTime(windowStart + 20 * 60_000);
      return response;
    }));
    const outcome = await continued(env, made.caseId);
    expect(generations).toBe(expire ? 1 : 2);
    expect(outcome.status === "queued").toBe(!expire);
    // The corrected reply of the control goes all the way (and leaves nothing queued for the next cases); the expired one has nothing to send.
    const run = effectsFor(env, made);
    await run.pass();
    expect(run.counter.sends).toBe(expire ? 0 : 1);
  });
  it("a scope JSON without the mode is refused (no silent fallback to the open behaviour)", async () => {
    const env = scoped(await executionEnv()), made = await boundCase(env), net = network();
    afterSettle();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    expect(await continued({ ...env, SAV_V2_SCOPE_MODE: undefined }, made.caseId)).toEqual({ status: "qualification_out_of_scope" });
    expect(net.calls).toEqual([]);
  });
  it.each([
    ["the contact", { hubspotContactId: "100000002" }], ["the sender", { senderEmail: "other@example.invalid" }], ["the subject", { initialSubject: "Autre objet" }],
  ])("%s changed after the plan, before the dispatch: the queued reply is cancelled, nothing is sent", async (_name, change) => {
    const env = scoped(await executionEnv()), made = await boundCase(env), net = network();
    afterSettle();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    expect(await continued(env, made.caseId)).toEqual({ status: "queued" });
    const run = effectsFor(scoped(env, change), made);
    const report = await run.pass();
    expect(report.supervised).toEqual([expect.objectContaining({ state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_QUALIFICATION_SCOPE" })]);
    await run.pass();
    expect(run.counter.sends).toBe(0);
  });
  it("the scope expires between the plan and the dispatch: no new send", async () => {
    const env = scoped(await executionEnv()), made = await boundCase(env), net = network();
    afterSettle();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    expect(await continued(env, made.caseId)).toEqual({ status: "queued" });
    vi.setSystemTime(windowStart + 20 * 60_000);
    const run = effectsFor(env, made);
    expect((await run.pass()).supervised).toEqual([expect.objectContaining({ state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_QUALIFICATION_SCOPE" })]);
    expect(run.counter.sends).toBe(0);
  });
  it("the mode removed after the plan (scope JSON left): the reply is held, never sent", async () => {
    const env = scoped(await executionEnv()), made = await boundCase(env), net = network();
    afterSettle();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    expect(await continued(env, made.caseId)).toEqual({ status: "queued" });
    const run = effectsFor({ ...env, SAV_V2_SCOPE_MODE: undefined }, made);
    expect(JSON.stringify((await run.pass()).supervised)).toContain("SAV_CASE_EFFECT_HOLD_QUALIFICATION_SCOPE");
    expect(run.counter.sends).toBe(0);
  });
  it("an uncertain send, then the scope expires: it is still verified, never sent again", async () => {
    const env = scoped(await executionEnv()), made = await boundCase(env), net = network();
    afterSettle();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    expect(await continued(env, made.caseId)).toEqual({ status: "queued" });
    let first = true;
    const run = effectsFor(env, made, () => { const lose = first; first = false; return lose; });
    await run.pass();
    expect(run.counter.sends).toBe(1);
    const [uncertain] = await f.db.select().from(savIntakeEffects).where(like(savIntakeEffects.businessKey, `%${made.caseId}%`));
    vi.setSystemTime(windowStart + 20 * 60_000);
    await f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
    await run.pass(); await run.pass();
    expect(run.counter.sends).toBe(1);
    // The read-only reconciliation of an engaged effect never passes the scope gate: verified with Gmail, confirmed, the case's execution completed.
    expect(uncertain?.state).toBe("uncertain");
    const [verified] = await f.db.select({ state: savIntakeEffects.state }).from(savIntakeEffects).where(eq(savIntakeEffects.businessKey, uncertain!.businessKey));
    expect(verified?.state).toBe("confirmed");
    expect(await f.db.select({ state: savCaseEffectExecutions.state }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, made.caseId))).toEqual([{ state: "confirmed" }]);
  });
  it("customer return gate: a mail on another thread is never consumed by V2 (V1 goes on)", async () => {
    const env = { ...scoped(await executionEnv()), SAV_V2_ENTRY: "on" }, bound = await boundCase(env);
    const other = await v1Mail({ ownerEffect: true });
    const id = randomUUID();
    await f.db.insert(savMessages).values({ id, threadId: other.threadId, mailboxId, direction: "inbound", gmailMessageId: `gm-${id}`, fromEmail: SENDER, toEmails: ["support@example.invalid"],
      subject: "Re: Synthétique", bodyCiphertext: encryptSavPayload({ text: "Toujours pas de code." }), receivedAt: new Date() });
    const [run] = await f.db.insert(savIntakeRuns).values({ threadId: other.threadId, messageId: id, version: 99, isCurrent: true, state: "pending", configHash: "syn", policyHash: "syn",
      payloadCiphertext: encryptSavPayload({}) }).returning();
    expect(await customerReturnGate(run!.id, { env })).toBeNull();
    const [after] = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, run!.id));
    expect(after).toMatchObject({ state: "pending", isCurrent: true });
    expect(bound.caseId).not.toBe(other.caseId);
  });
});

import { caseV2EffectsWithTestPorts, sendQueuedCaseReplyNow } from "./v2-effects-binding";
import type { ImmediateCaseReplySend } from "./immediate-send-budget";
import { intakeRuntimeHash as runtimeHash, savIntakeRuntimeConfig } from "../intake/runtime-contract";
// The production path of the immediate send (no injected transport or context) reaches Gmail only through these two boundaries; by default they are
// the real modules (and the network is forbidden), a test routes them to the synthetic provider.
const gmailBoundary = vi.hoisted(() => ({ request: null as null | ((mailbox: string, path: string, init?: RequestInit) => Promise<unknown>), permissions: null as null | (() => Promise<unknown>) }));
vi.mock("../gmail", async importOriginal => {
  const real = await importOriginal<typeof import("../gmail")>();
  return { ...real, requestSavGmail: (mailbox: string, path: string, init?: RequestInit) => gmailBoundary.request ? gmailBoundary.request(mailbox, path, init) : (real.requestSavGmail as (...a: unknown[]) => unknown)(mailbox, path, init) };
});
vi.mock("../gmail-permissions", async importOriginal => {
  const real = await importOriginal<typeof import("../gmail-permissions")>();
  return { ...real, readSavGmailPermissions: () => gmailBoundary.permissions ? gmailBoundary.permissions() : real.readSavGmailPermissions() };
});
/*
 * Immediate send (11/11) on the same real chain: the loader queues the automated reply and, when its CALLER gives a deadline with enough time left, sends it
 * AT ONCE through the catch-up's own guards, claim and lease; then the catch-up (`reconcileCaseV2Effects`) finds nothing more to send. The network and the
 * Gmail transport are the only doubles, shared by both paths so that every send is counted once, whoever makes it.
 */
describe("immediate send: the queued reply leaves at once within the caller's budget, under the catch-up's own guards, and never twice", () => {
  const immediateEnv = async () => ({ ...await executionEnv(), SAV_V2_ENTRY: "on" });
  const callerDeadline = () => Date.now() + 120_000;
  function rig(env: Record<string, string | undefined>, made: { gmail: string; threadId: string; ticketId: string }) {
    const provider = executionProvider(); provider.setGmail(made.gmail, `thread-${made.threadId}`); provider.seedTicket({ id: made.ticketId, ownerId: V2_OWNER, stage: "new" });
    const counter = { sends: 0, inner: null as unknown };
    let duringSend: (() => Promise<unknown>) | null = null;
    const gmail = { request: async <T,>(mailbox: string, path: string, init?: RequestInit) => {
      if (path.replace(/^\//, "") === "messages/send") {
        counter.sends++;
        // The other path runs WHILE this one holds the lease, between its marker and the provider's answer.
        const hook = duringSend; duringSend = null;
        if (hook) counter.inner = await hook();
      }
      return provider.gmail<T>(mailbox, path, init);
    }, permissions: async () => {} };
    const test = caseV2EffectsWithTestPorts({ gmail, network: provider.network as typeof fetch, context: { runtime: {} as never, policy: executionPolicy } });
    const sendNow: ImmediateCaseReplySend = input => test.sendNow(input);
    const catchUp = () => test.reconcile({ env, deadlineMs: Date.now() + 60_000 });
    return { provider, counter, sendNow, catchUp, during: (hook: () => Promise<unknown>) => { duringSend = hook; } };
  }
  async function queued(sendNow: ImmediateCaseReplySend | null | undefined, rigOf?: (env: Record<string, string | undefined>, made: { gmail: string; threadId: string; ticketId: string }) => ReturnType<typeof rig>, envOf = immediateEnv) {
    const env = await envOf(), made = await returnedCase(env), net = network();
    afterSettle();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => net.net(String(url), init)));
    const r = (rigOf ?? rig)(env, made);
    const point = await loadCaseContinuationPoint(sendNow === undefined ? {} : { sendNow });
    return { env, made, r, net, point };
  }
  const openStates = ["pending", "running", "waiting"];
  // Each test starts from an empty queue: what earlier describes left open is closed (a refused execution is never listed nor claimed), as in case-runtime-effects.
  beforeEach(async () => { await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused', lease_until = NULL, lease_token = NULL WHERE state NOT IN ('confirmed','refused')"); });
  afterEach(() => { gmailBoundary.request = null; gmailBoundary.permissions = null; });

  it("queued with a caller deadline -> sent at once (ONE send, execution confirmed) -> the catch-up and a replay of the loader send nothing more", async () => {
    let r!: ReturnType<typeof rig>;
    const q = await queued(input => r.sendNow(input), (env, made) => (r = rig(env, made)));
    expect(await q.point({ caseId: q.made.caseId, trigger: "customer_return", env: q.env, deadlineMs: callerDeadline() })).toEqual({ status: "queued" });
    expect(r.counter.sends).toBe(1);
    expect(await effectRows(q.made.caseId)).toEqual([expect.objectContaining({ state: "confirmed" })]);
    await r.catchUp();
    expect(await q.point({ caseId: q.made.caseId, trigger: "relay", env: q.env, deadlineMs: callerDeadline() })).toMatchObject({ status: expect.any(String) });
    await r.catchUp();
    expect(r.counter.sends).toBe(1);
    expect(await effectRows(q.made.caseId)).toHaveLength(1);
  });

  it("the caller's budget: no deadline (the shared worker) never sends here; a deadline too close is refused BEFORE any read; the catch-up sends once", async () => {
    let r!: ReturnType<typeof rig>;
    const calls: unknown[] = [];
    const q = await queued(async input => { const outcome = await r.sendNow(input); calls.push({ input, outcome }); return outcome; }, (env, made) => (r = rig(env, made)));
    expect(await q.point({ caseId: q.made.caseId, trigger: "customer_return", env: q.env })).toEqual({ status: "queued" });
    expect(calls).toEqual([]);
    expect(await q.point({ caseId: q.made.caseId, trigger: "relay", env: q.env, deadlineMs: Date.now() + 59_000 })).toMatchObject({ status: "queued" });
    expect(calls).toEqual([{ input: expect.objectContaining({ callerDeadlineMs: expect.any(Number) }), outcome: { skipped: "caller_budget" } }]);
    expect(r.provider.calls).toEqual([]); // not even the owner read
    expect(r.counter.sends).toBe(0);
    expect(openStates).toContain((await effectRows(q.made.caseId))[0]!.state);
    await r.catchUp();
    expect(r.counter.sends).toBe(1);
  });

  it("continueCaseAfterCommit carries the caller's deadline to the point; without it (the worker) nothing is sent at once", async () => {
    let r!: ReturnType<typeof rig>;
    const seen: (number | undefined)[] = [];
    const q = await queued(input => { seen.push(input.callerDeadlineMs); return r.sendNow(input); }, (env, made) => (r = rig(env, made)));
    const point = async (input: Parameters<typeof q.point>[0]) => { seen.push(input.deadlineMs); return q.point(input); };
    expect(await continueCaseAfterCommit(q.made.caseId, "customer_return", { env: q.env, continuation: point })).toEqual({ status: "queued" });
    expect(seen).toEqual([undefined]);
    expect(r.counter.sends).toBe(0);
    const deadline = callerDeadline();
    await continueCaseAfterCommit(q.made.caseId, "customer_return", { env: q.env, continuation: point, immediateDeadlineMs: deadline });
    expect(seen).toEqual([undefined, deadline, deadline]);
    expect(r.counter.sends).toBe(1);
  });

  it("race: the catch-up holds the lease when the immediate send runs -> the immediate pass selects nothing; ONE send in all", async () => {
    let r!: ReturnType<typeof rig>;
    const q = await queued(null, (env, made) => (r = rig(env, made)));
    expect(await q.point({ caseId: q.made.caseId, trigger: "customer_return", env: q.env, deadlineMs: callerDeadline() })).toEqual({ status: "queued" });
    expect(r.counter.sends).toBe(0);
    const [execution] = await effectRows(q.made.caseId);
    r.during(() => r.sendNow({ env: q.env, executionId: execution!.id, callerDeadlineMs: callerDeadline() }));
    await r.catchUp();
    expect(r.counter.inner).toMatchObject({ pass: { skipped: null, supervised: [] } });
    await r.sendNow({ env: q.env, executionId: execution!.id, callerDeadlineMs: callerDeadline() });
    expect(r.counter.sends).toBe(1);
    expect(await effectRows(q.made.caseId)).toEqual([expect.objectContaining({ state: "confirmed" })]);
  });

  it("race: the immediate send holds the lease when the catch-up runs -> the catch-up sends nothing; ONE send in all", async () => {
    let r!: ReturnType<typeof rig>;
    const q = await queued(null, (env, made) => (r = rig(env, made)));
    expect(await q.point({ caseId: q.made.caseId, trigger: "customer_return", env: q.env, deadlineMs: callerDeadline() })).toEqual({ status: "queued" });
    const [execution] = await effectRows(q.made.caseId);
    r.during(() => r.catchUp());
    expect(await r.sendNow({ env: q.env, executionId: execution!.id, callerDeadlineMs: callerDeadline() })).toMatchObject({ pass: { supervised: [{ executionId: execution!.id, state: "confirmed" }] } });
    expect(r.counter.inner).toMatchObject({ replies: { supervised: [] } });
    await r.catchUp();
    expect(r.counter.sends).toBe(1);
  });

  it("race: two immediate sends and the catch-up started together -> ONE send", async () => {
    let r!: ReturnType<typeof rig>;
    const q = await queued(null, (env, made) => (r = rig(env, made)));
    expect(await q.point({ caseId: q.made.caseId, trigger: "customer_return", env: q.env, deadlineMs: callerDeadline() })).toEqual({ status: "queued" });
    const [execution] = await effectRows(q.made.caseId);
    const now = { env: q.env, executionId: execution!.id, callerDeadlineMs: callerDeadline() };
    await Promise.all([r.sendNow(now), r.catchUp(), r.sendNow(now)]);
    await r.catchUp();
    expect(r.counter.sends).toBe(1);
    expect(await effectRows(q.made.caseId)).toEqual([expect.objectContaining({ state: "confirmed" })]);
  });

  it("a closed guard (agent fully paused at the immediate send) sends nothing and keeps the reply queued; the catch-up sends it once after the pause", async () => {
    let r!: ReturnType<typeof rig>;
    const pause = { revision: SAV_AGENT_PAUSE_REVISION, agent: "intake", level: "fully_paused", setBy: "staff@example.invalid", setAt: new Date().toISOString(), reason: "Pause synthétique" };
    const outcomes: unknown[] = [];
    const q = await queued(async input => {
      await f.db.insert(savSyncState).values({ key: savAgentPauseKey("intake"), cursor: encryptSavPayload(pause), status: "active", updatedAt: new Date() });
      try { const outcome = await r.sendNow(input); outcomes.push(outcome); return outcome; } finally { await f.db.delete(savSyncState).where(eq(savSyncState.key, savAgentPauseKey("intake"))); }
    }, (env, made) => (r = rig(env, made)));
    expect(await q.point({ caseId: q.made.caseId, trigger: "customer_return", env: q.env, deadlineMs: callerDeadline() })).toEqual({ status: "queued" });
    expect(outcomes).toEqual([{ skipped: "SAV_INTAKE_AGENT_FULLY_PAUSED" }]);
    expect(r.counter.sends).toBe(0);
    expect(openStates).toContain((await effectRows(q.made.caseId))[0]!.state);
    await r.catchUp();
    expect(r.counter.sends).toBe(1);
    expect(await effectRows(q.made.caseId)).toEqual([expect.objectContaining({ state: "confirmed" })]);
  });

  it("a failing immediate send (CRM owner unreadable) changes neither the report nor the queue; the catch-up sends once", async () => {
    let r!: ReturnType<typeof rig>;
    const outcomes: unknown[] = [];
    const failing = caseV2EffectsWithTestPorts({ network: (async () => { throw Error("SYNTHETIC_CRM_DOWN"); }) as typeof fetch, context: { runtime: {} as never, policy: executionPolicy } });
    const q = await queued(async input => { const outcome = await failing.sendNow(input); outcomes.push(outcome); return outcome; }, (env, made) => (r = rig(env, made)));
    expect(await q.point({ caseId: q.made.caseId, trigger: "customer_return", env: q.env, deadlineMs: callerDeadline() })).toEqual({ status: "queued" });
    expect(JSON.stringify(outcomes)).toMatch(/HOLD|failed/);
    expect(r.counter.sends).toBe(0);
    expect(openStates).toContain((await effectRows(q.made.caseId))[0]!.state);
    await r.catchUp();
    expect(r.counter.sends).toBe(1);
  });

  it("a sender that throws never fails the passage; the sweep (a catch-up inside the shared worker) never sends at once", async () => {
    const thrower = vi.fn(async () => { throw Error("SYNTHETIC_IMMEDIATE_CRASH"); });
    const q = await queued(thrower);
    expect(await q.point({ caseId: q.made.caseId, trigger: "customer_return", env: q.env, deadlineMs: callerDeadline() })).toEqual({ status: "queued" });
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(openStates).toContain((await effectRows(q.made.caseId))[0]!.state);
    await q.point({ caseId: q.made.caseId, trigger: "sweep", env: q.env, deadlineMs: callerDeadline() });
    expect(thrower).toHaveBeenCalledTimes(1);
  });

  /** A real runtime configuration (V1 observation pins) and the signed grant that matches it: what production reads when nothing is injected. */
  async function productionEnv() {
    const enginePolicy = { relationRevision: "synthetic", admittedRelations: [], resources: {} };
    const runtimeEnv = { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_AI_MODEL: "gemini-3.6-flash", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(enginePolicy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
      SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId, createdAfter: new Date(Date.now() - 60_000).toISOString(), receivedAfter: new Date(Date.now() - 3600_000).toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: runtimeHash(enginePolicy), resourcesHash: runtimeHash([]), maxCalls: 30, maxNanoUsd: 3000000000 }) };
    const base = await immediateEnv(), env = { ...base, ...runtimeEnv, SAV_ENCRYPTION_KEY_V1: process.env.SAV_ENCRYPTION_KEY_V1 };
    const runtime = savIntakeRuntimeConfig(env)!;
    expect(runtime).not.toBeNull();
    const policy = executionPolicySchema.parse({ ...executionPolicy, enginePolicyHash: runtime.policyHash, resourcesHash: runtime.resourcesHash, codeRevision: runtime.codeRevision });
    const hash = runtimeHash(policy);
    await f.db.update(savIntakeExecutionPolicies).set({ policyHash: hash, payloadCiphertext: encryptSavPayload(policy) }).where(eq(savIntakeExecutionPolicies.id, policyId));
    executionPolicy = policy; policyHash = hash;
    return { ...env, SAV_INTAKE_EXECUTION_POLICY_SHA256: hash };
  }

  it("the PRODUCTION immediate sender (no injected transport or context): configuration and grant read from the environment, ONE send through the Gmail boundary", async () => {
    const env = await productionEnv(), made = await returnedCase(env), net = network();
    afterSettle();
    const provider = executionProvider(); provider.setGmail(made.gmail, `thread-${made.threadId}`); provider.seedTicket({ id: made.ticketId, ownerId: V2_OWNER, stage: "new" });
    // HubSpot answers from the provider, Gemini from the synthetic model; anything else is refused.
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => String(url).startsWith("https://api.hubapi.com/") ? provider.network(String(url), init) : net.net(String(url), init)));
    let sends = 0;
    gmailBoundary.request = async (mailbox, path, init) => { if (path.replace(/^\//, "") === "messages/send") sends++; return provider.gmail(mailbox, path, init); };
    gmailBoundary.permissions = async () => ({ ok: true, mailboxEmail: "support@example.invalid", sendScopeGranted: true });
    const point = await loadCaseContinuationPoint(); // the real sender: sendQueuedCaseReplyNow
    expect(await point({ caseId: made.caseId, trigger: "customer_return", env, deadlineMs: callerDeadline() })).toEqual({ status: "queued" });
    expect(sends).toBe(1);
    expect(await effectRows(made.caseId)).toEqual([expect.objectContaining({ state: "confirmed" })]);
    const [execution] = await effectRows(made.caseId);
    expect(await sendQueuedCaseReplyNow({ env, executionId: execution!.id, callerDeadlineMs: callerDeadline() })).toMatchObject({ pass: { skipped: null, supervised: [] } });
    expect(sends).toBe(1);
  });

  it("the test ports are refused in a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => caseV2EffectsWithTestPorts({})).toThrow("SAV_V2_TEST_PORTS_FORBIDDEN");
  });
});
