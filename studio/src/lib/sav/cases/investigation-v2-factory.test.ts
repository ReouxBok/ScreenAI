import type { CaseInvestigationModelRequest } from "./investigation-runner";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import {
  contentChunks, contentItems, contentVersions, savCaseCalls, savCaseEffectExecutions, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns,
  savMailboxes, savMessages, savSyncState, savThreads, staffUsers, savKnowledgeActivations, activeKnowledge, knowledgeRevisions, reviewEvents,
} from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../intake/executor", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
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
    bodyCiphertext: encryptSavPayload({ text: "Corps synthétique" }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
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

describe("factory: precise refusals, nothing built without every proof", () => {
  it("OFF by default and every missing proof named; V1's key alone is not V2's", () => {
    const net = network();
    expect(createCaseInvestigationV2Deps({ env: () => ({ SAV_GEMINI_API_KEY: V1_KEY }), readPolicyRecord: undefined, network: net.net }))
      .toEqual({ ok: false, refusals: ["v2_investigation_off", "admission_policy_reader_absent", "v2_gemini_key_absent", "v2_embedding_model_absent", "v2_model_absent", "v2_spend_policy_absent"] });
    for (const [over, reason] of [[{ SAV_V2_SPEND_POLICY_JSON: "{" }, "v2_spend_policy_invalid"],
      [{ SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...SPEND, approvedBy: "someone" }) }, "v2_spend_policy_invalid"],
      [{ SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...SPEND, model: { ...SPEND.model, reserveMicroUsdPerCall: 0 } }) }, "v2_spend_policy_invalid"],
      [{ SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...SPEND, embedding: undefined }) }, "v2_spend_policy_invalid"]] as const) {
      expect(createCaseInvestigationV2Deps(input(net, {}, environment(over)))).toEqual({ ok: false, refusals: [reason] });
    }
    expect(net.calls).toEqual([]);
  });
  it("the binding for A and the wake refuses the same way, and builds when every proof is there", () => {
    const net = network(), store = { env: () => environment(), readTicketOwner: async () => "v2" as const };
    expect(createCaseInvestigationToReplyPlan({ ...input(net, {}, environment({ SAV_V2_INVESTIGATION: undefined })), store, executionPolicy: null })).toEqual({ ok: false, refusals: ["v2_investigation_off"] });
    expect(createCaseInvestigationToReplyPlan({ ...input(net), store, executionPolicy: { id: policyId, hash: "fixture" } }).ok).toBe(true);
  });
});

describe("V2 spend register: two budgets, approved amounts only, never free", () => {
  const deps = (over: Record<string, unknown> = {}) => ({ env: () => environment({ SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...SPEND, ...over }) }), now: () => new Date("2026-11-04T10:00:00Z") });
  beforeEach(async () => { await clearSpend(); });
  it("reserve is idempotent per call, settle uses the reported usage under the same revision, a second settle is a no-op", async () => {
    const first = await reserveCaseV2Spend(deps(), "model", "call-a");
    expect(first).toEqual({ status: "allowed", reservationId: "model:2026-11-04:call-a", amountMicroUsd: 50_000 });
    expect(await reserveCaseV2Spend(deps(), "model", "call-a")).toEqual(first);
    expect(await settleCaseV2Spend(deps(), { reservationId: first.status === "allowed" ? first.reservationId : "", usage: { inputTokens: 1_000, outputTokens: 200 }, uncertain: false }))
      .toEqual({ settled: true, costMicroUsd: 1, fromUsage: true });
    expect(await settleCaseV2Spend(deps(), { reservationId: "model:2026-11-04:call-a", usage: "unknown", uncertain: true })).toEqual({ settled: false, reason: "already_settled" });
    expect(await reserveCaseV2Spend(deps(), "model", "call-a")).toEqual({ status: "refused", reason: "v2_spend_call_already_settled" });
    expect(await readCaseV2SpendDay("model", "2026-11-04")).toEqual({ settledMicroUsd: 1, heldMicroUsd: 0, open: 0, settled: 1 });
  });
  it("unknown usage, an uncertain call or a changed policy keep the reserved amount; release frees only an unsent call", async () => {
    await reserveCaseV2Spend(deps(), "model", "u1"); await reserveCaseV2Spend(deps(), "model", "u2"); await reserveCaseV2Spend(deps(), "model", "u3"); await reserveCaseV2Spend(deps(), "model", "u4");
    expect(await settleCaseV2Spend(deps(), { reservationId: "model:2026-11-04:u1", usage: "unknown", uncertain: false })).toMatchObject({ costMicroUsd: 50_000, fromUsage: false });
    expect(await settleCaseV2Spend(deps(), { reservationId: "model:2026-11-04:u2", usage: { inputTokens: 10, outputTokens: 10 }, uncertain: true })).toMatchObject({ costMicroUsd: 50_000 });
    expect(await settleCaseV2Spend(deps({ revision: "spend-syn-r2" }), { reservationId: "model:2026-11-04:u3", usage: { inputTokens: 10, outputTokens: 10 }, uncertain: false })).toMatchObject({ costMicroUsd: 50_000 });
    expect(await releaseCaseV2Spend({ reservationId: "model:2026-11-04:u4" })).toEqual({ released: true });
    expect(await releaseCaseV2Spend({ reservationId: "model:2026-11-04:u1" })).toEqual({ released: false });
    expect(await readCaseV2SpendDay("model", "2026-11-04")).toEqual({ settledMicroUsd: 150_000, heldMicroUsd: 0, open: 0, settled: 3 });
  });
  it("the daily cap refuses before any call; the model budget never consumes the embedding one", async () => {
    const tight = deps({ model: { ...SPEND.model, dailyCapMicroUsd: 100_000 } });
    expect((await reserveCaseV2Spend(tight, "model", "c1")).status).toBe("allowed");
    expect((await reserveCaseV2Spend(tight, "model", "c2")).status).toBe("allowed");
    expect(await reserveCaseV2Spend(tight, "model", "c3")).toEqual({ status: "refused", reason: "v2_spend_model_daily_cap_reached" });
    expect((await reserveCaseV2Spend(tight, "embedding", "e1")).status).toBe("allowed");
    expect(await reserveCaseV2Spend({ env: () => ({}), now: () => new Date() }, "embedding", "e2")).toEqual({ status: "refused", reason: "v2_spend_policy_absent" });
    expect(readCaseV2SpendPolicy({ SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...SPEND, extra: 1 }) })).toEqual({ ok: false, reason: "v2_spend_policy_invalid" });
  });
});

describe("real adapters over the network double", () => {
  it("decision provider: V2 key and model only, one request; 4xx consumed nothing, 503 or a lost connection is uncertain, non-JSON is a failure with its usage", async () => {
    const request = { purpose: "decision", snapshot: { version: 3, body: { openRequests: [], facts: [], questions: [], trials: [] } }, knowledge: [], coverage: null, feedback: [], closure: [] } as never;
    const answer = (response: Response | Error) => caseGeminiDecisionProvider({ env: () => environment(), network: async () => { if (response instanceof Error) throw response; return response; } })(request);
    expect(await answer(new Response("{}", { status: 401 }))).toEqual({ result: { status: "failed", uncertain: false }, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(await answer(new Response("{}", { status: 503 }))).toEqual({ result: { status: "failed", uncertain: true }, usage: null });
    expect(await answer(new Error("ECONNRESET"))).toEqual({ result: { status: "failed", uncertain: true }, usage: null });
    expect(await answer(Response.json({ candidates: [{ content: { parts: [{ text: "pas du json" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } })))
      .toEqual({ result: { status: "failed", uncertain: false }, usage: { inputTokens: 5, outputTokens: 2 } });
    const net = network();
    await caseGeminiDecisionProvider({ env: () => environment(), network: net.net })(request);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.headers["x-goog-api-key"]).toBe(V2_KEY);
    expect(JSON.stringify(net.calls[0]!.body)).not.toContain(V1_KEY);
    const reports = { correctLinkReported: true, ownAddressReported: true, missingCodeReported: true,
      spamCheckedReported: false, screenReport: null, latestIsReminder: true };
    const withHistory = { ...(request as CaseInvestigationModelRequest), customerReportedLogin: reports };
    await caseGeminiDecisionProvider({ env: () => environment(), network: net.net })(withHistory);
    const wire = net.calls[1]!.body as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(JSON.parse(wire.contents[0]!.parts[0]!.text).customerReportedLogin).toEqual(reports);
    const restoredAccessReported = { source: { type: "email" as const, id: "last-mail" }, quote: "Je peux de nouveau utiliser Limova." };
    const finalCheck = { ...withHistory, purpose: "resolution_check" as const, customerReportedLogin: { restoredAccessReported } };
    await caseGeminiDecisionProvider({ env: () => environment(), network: net.net })(finalCheck);
    const closureWire = net.calls[2]!.body as typeof wire & { systemInstruction: { parts: { text: string }[] } };
    expect(JSON.parse(closureWire.contents[0]!.parts[0]!.text).customerReportedLogin).toEqual({ restoredAccessReported });
    const schema = JSON.parse(closureWire.systemInstruction.parts[0]!.text.split("Schéma JSON de la réponse :\n")[1]!);
    expect(schema.required).toEqual(["verdicts"]);


  });
  it("owner read: GET of exactly the owner path, token read at each request, absent token or another path refused", async () => {
    const net = network();
    expect(await caseHubspotOwnerReadTransport({ env: () => environment(), network: net.net })({ method: "GET", path: "/crm/v3/objects/tickets/42?properties=hubspot_owner_id" }))
      .toEqual({ id: "42", properties: { hubspot_owner_id: V2_OWNER } });
    expect(net.calls[0]!.headers.authorization).toBe("Bearer syn-hubspot-token");
    await expect(caseHubspotOwnerReadTransport({ env: () => ({}), network: net.net })({ method: "GET", path: "/crm/v3/objects/tickets/42?properties=hubspot_owner_id" })).rejects.toThrow("SAV_V2_HUBSPOT_TOKEN_ABSENT");
    await expect(caseHubspotOwnerReadTransport({ env: () => environment(), network: net.net })({ method: "GET", path: "/crm/v3/objects/contacts/1" })).rejects.toThrow("SAV_V2_OWNER_READ_PATH_INVALID");
    expect(net.calls).toHaveLength(1);
  });
});

describe("the canonical runtime on the factory's real adapters (network double only)", () => {
  beforeEach(async () => { await seedCard(); await clearSpend(); });
  it("an admitted access case: one embedding and one generation, both through the ledger and their own V2 budget, decision recorded", async () => {
    const mail = await v1Mail({ ownerEffect: true }), net = network();
    const built = createCaseInvestigationV2Deps(input(net));
    if (!built.ok) throw Error(built.refusals.join(","));
    expect(await runCaseInvestigationRuntime(mail.caseId, built.deps)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(net.calls.map(call => call.url.replace(/tickets\/\d+/, "tickets/<id>"))).toEqual(expect.arrayContaining([
      "https://generativelanguage.googleapis.com/v1beta/models/syn-embedding:batchEmbedContents", "https://generativelanguage.googleapis.com/v1beta/models/syn-model:generateContent"]));
    expect(net.calls.filter(call => call.url.includes("generativelanguage")).every(call => call.headers["x-goog-api-key"] === V2_KEY)).toBe(true);
    expect(net.calls.filter(call => call.url.includes("generativelanguage"))).toHaveLength(2);
    const ledger = await f.db.select({ purpose: savCaseCalls.purpose, state: savCaseCalls.state }).from(savCaseCalls).where(eq(savCaseCalls.caseId, mail.caseId));
    expect(ledger.map(row => row.state).sort()).toEqual(["settled", "settled"]);
    // Embedding: no usage reported, the reserved amount stays; model: 1 000 in x 300 + 200 out x 2 500 per million = 0.8 -> 1 micro-dollar.
    expect(await readCaseV2SpendDay("embedding", today())).toEqual({ settledMicroUsd: 100, heldMicroUsd: 0, open: 0, settled: 1 });
    expect(await readCaseV2SpendDay("model", today())).toEqual({ settledMicroUsd: 1, heldMicroUsd: 0, open: 0, settled: 1 });
  });
  it("model budget reached: nothing generated, the ledger key released, the decision deferred; the embedding was its own budget", async () => {
    const mail = await v1Mail({ ownerEffect: true }), net = network();
    const env = environment({ SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...SPEND, model: { ...SPEND.model, dailyCapMicroUsd: 50_000 } }) });
    await reserveCaseV2Spend({ env: () => env, now: () => new Date(Date.now() + 6 * 60_000) }, "model", "someone-else");
    const built = createCaseInvestigationV2Deps(input(net, {}, env));
    if (!built.ok) throw Error(built.refusals.join(","));
    const report = await runCaseInvestigationRuntime(mail.caseId, built.deps);
    expect(report.modelCalls).toBe(0);
    expect(net.calls.some(call => call.url.endsWith(":generateContent"))).toBe(false);
    expect(await readCaseV2SpendDay("embedding", today())).toMatchObject({ settled: 1 });
  });
  it("embedding budget absent for the day: no embedding call, no generation", async () => {
    const mail = await v1Mail({ ownerEffect: true }), net = network();
    const env = environment({ SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...SPEND, embedding: { ...SPEND.embedding, dailyCapMicroUsd: 100 } }) });
    await reserveCaseV2Spend({ env: () => env, now: () => new Date(Date.now() + 6 * 60_000) }, "embedding", "someone-else");
    const built = createCaseInvestigationV2Deps(input(net, {}, env));
    if (!built.ok) throw Error(built.refusals.join(","));
    const report = await runCaseInvestigationRuntime(mail.caseId, built.deps);
    expect(report.modelCalls).toBe(0);
    expect(net.calls.filter(call => call.url.includes("generativelanguage"))).toEqual([]);
  });
  it("a person holds the ticket (real owner read): no embedding, no generation, nothing reserved", async () => {
    const mail = await v1Mail({ ownerEffect: true }), net = network({ owner: "70000042" });
    const built = createCaseInvestigationV2Deps(input(net));
    if (!built.ok) throw Error(built.refusals.join(","));
    expect(await runCaseInvestigationRuntime(mail.caseId, built.deps)).toMatchObject({ status: "skipped", reason: "ticket_owner_human", modelCalls: 0 });
    expect(net.calls.filter(call => call.url.includes("generativelanguage"))).toEqual([]);
    expect(await readCaseV2SpendDay("model", today())).toBeNull();
  });
  it("A's whole path through the factory's binding: investigated on real adapters, then proposed for a person (auto off)", async () => {
    const mail = await v1Mail({ ownerEffect: true }), net = network();
    const bound = createCaseInvestigationToReplyPlan({ ...input(net), executionPolicy: { id: policyId, hash: "fixture" },
      store: { env: () => environment(), readTicketOwner: async () => "v2" } });
    if (!bound.ok) throw Error("NOT_BOUND");
    const report = await bound.run(mail.caseId);
    expect(report.investigation).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(report.reply).toMatchObject({ status: "awaiting_person", reasons: ["auto_disabled"] });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, mail.caseId))).toEqual([]);
    expect((await readCase(mail.caseId))!.owner).toBe("agent");
  });
});

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "runtime-journey-fixture-key-32-chars!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-runtime-admin", email: "runtime-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "runtime-journey-fixture-key-32-chars!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
