import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savCaseEffectExecutions, savCaseReplyValidations, savCaseTimers, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Strict local ports: no V1 executor, no model dispatcher, and fetch throws.
vi.mock("../intake/executor", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
vi.mock("../intake/model-dispatch", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => { throw Error(`MODEL_DISPATCH_FORBIDDEN:${name}`); } : value]));
});
// The forward store is observed, not run (its protocol has its own tests): the gate order is what this file proves.
const forward = vi.hoisted(() => ({ order: [] as string[], authority: async () => undefined as void, enqueue: null as null | ((input: unknown) => Promise<unknown>), enqueued: [] as unknown[], synced: [] as string[], facts: true }));
vi.mock("./commercial-forward-store", () => ({
  commercialForwardAuthority: async () => forward.authority(),
  enqueueCommercialForward: async (input: unknown) => { forward.order.push("enqueue"); forward.enqueued.push(input); return forward.enqueue ? forward.enqueue(input) : { ok: true, key: "k", created: forward.enqueued.length === 1 }; },
  readCommercialForwardFacts: async () => forward.facts ? { asks: ["x"], source: {} } : null,
  syncCommercialForward: async (key: string) => { forward.synced.push(key); return { final: "confirmed" }; },
  commercialForwardDeps: () => ({}),
}));
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { listCaseEvents } from "./case-store";
import { smartSupportProvenance, type CaseAdmissionQualification } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { readCaseInvestigationProgress } from "./investigation-record";
import { passCaseInvestigationToReplyPlan, type CaseReplyPassageDeps } from "./investigation-reply-passage";
import { latestInvestigationInput } from "./investigation-runner";
import { caseCallLedgerOnStore, runCaseInvestigationRuntime, type CaseInvestigationRuntimeDeps } from "./investigation-runtime";
import { caseGeminiDecisionProvider } from "./investigation-v2-providers";
import { pilotProvenanceGate, type PilotProvenanceDeps } from "./pilot-passage-provenance";
import { smartCaseDecisionProvider } from "./smart/smart-case-provider";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel } from "./smart/smart-test-doubles";

/*
 * Ugo 26/11, SYNTHETIC only, real stores on PGlite (the wiring of `smart-circuit.passage.flow.test.ts`): a mixed mail (a usage question + a commercial one)
 * decided by the smart brain with `SAV_V2_SMART_COMMERCIAL_SPLIT=on` and `SAV_V2_SMART_COMMERCIAL_FORWARD=on` → the decision recorded with its commercial part →
 * B's passage queues the forward to sales BEFORE it proposes the reply, and proposes nothing when it cannot. The reply never mentions the commercial question.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 9_123_000;
const AT = new Date(Date.now() - 60_000).toISOString(), V2_OWNER = "90000123", APPROVER = "30000000-0000-4000-8000-000000000123";
const SMART = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on", SAV_V2_ENTRY_SMART: "on", SAV_V2_SMART_COMMERCIAL_SPLIT: "on", SAV_V2_SMART_COMMERCIAL_FORWARD: "on" };
const AUTO = { SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: APPROVER };
const SENDER = "client@example.invalid";
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } };
const policy = { revision: "synthetic", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00Z",
  transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-12-01T00:00:00Z", maxInputTokens: 131072, maxOutputTokens: 1024, maxInputBytes: 100_000, embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1024 },
  model: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 200_000, microUsdPerMillionInputTokens: 1_000_000, microUsdPerMillionOutputTokens: 1_000_000 },
  embedding: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 10_000, microUsdPerMillionInputTokens: 1_000_000 } };
const GEMINI_ENV = { SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(policy), SAV_V2_GEMINI_API_KEY: "synthetic-v2-key" };

const SHEET_CARD: SavRetrievalCandidate = { id: "fiche-sheet", contentVersionId: "v2", title: "Fiche Google Sheet", source: "fixture", semanticScore: null,
  content: "Pour remplir le Google Sheet, ouvrez l'onglet Intégrations puis reconnectez Google Sheets avec le compte propriétaire du fichier.",
  verifiedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
const SHEET_TEXT = "Bonjour, mon agent ne remplit plus mon Google Sheet depuis hier. Merci de votre aide.";
const SHEET_REPLY = "Bonjour,\n\nVotre Google Sheet ne se remplit plus. Ouvrez l'onglet Intégrations puis reconnectez Google Sheets avec le compte propriétaire du fichier.\n\nSi cela bloque encore, dites-nous ce qui s'affiche.\n\nBelle journée.";
const SHEET_AND_OFFER = `${SHEET_TEXT} Et quelle offre me conseillez-vous pour 3 personnes ?`;
const COMMERCIAL_ASK = "savoir quelle offre choisir pour 3 personnes";
const SCRIPT = {
  understand: { output: smartReading({ needs: [{ id: "n1", ask: "faire remplir son Google Sheet", alreadyDone: [], theme: "intégrations", search: "google sheet ne se remplit pas" },
    { id: "n2", ask: COMMERCIAL_ASK, alreadyDone: [], theme: "offre", search: null, commercial: true }], sensible: { famille: "aucune", preuve: "quelle offre me conseillez-vous pour 3 personnes ?" } }) },
  decide: { output: smartGoodDecision({ reply: SHEET_REPLY, coverage: [{ needId: "n1", status: "answered" }, { needId: "n2", status: "handed" }],
    teamNote: { raison: "other", besoin: "Choix d'offre pour 3 personnes.", compris: "", verifie: [], essaye: [], hypotheses: [], prochaineVerification: "Le recontacter.", ditAuClient: null },
    facts: [{ sentence: "Ouvrez l'onglet Intégrations puis reconnectez Google Sheets avec le compte propriétaire du fichier.", needId: "n1",
    type: "fait_limova", sourceKind: "fiche", cardId: "fiche-sheet", version: "v2", excerpt: "ouvrez l'onglet Intégrations puis reconnectez Google Sheets avec le compte propriétaire du fichier" }] }) },
  verify: { output: SMART_CONFORME },
};

/** One stored support mail V1 confirmed (with its V2 owner effect), relayed by A under the smart entry: every request `other`, smart provenance, no policy. */
async function smartMail() {
  const ticketId = String(++seq), threadId = randomUUID(), messageId = randomUUID();
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Google Sheet vide", customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Google Sheet vide",
    bodyCiphertext: encryptSavPayload({ text: SHEET_AND_OFFER, headers: { "message-id": `<${messageId}@example.invalid>` } }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: [{ id: "r0", kind: "support" }] } } }) }).returning();
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: [{ id: "r0", kind: "support", currentMessageId: messageId }], ticketSummary: { title: "Google Sheet vide", description: "Le Google Sheet ne se remplit plus.", requestIds: ["r0"] } };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: 1, isCurrent: false, state: "observed", configHash: `smart-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
      records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  await f.db.update(savIntakeExecutions).set({ runId: run!.id }).where(eq(savIntakeExecutions.id, execution!.id));
  const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
  await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
    intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }), env: SMART,
    readAdmissionPolicy: async () => { throw Error("POLICY_READ_FORBIDDEN"); },
    readQualification: async ({ requests }) => ({ requests: requests.map(({ requestId }) => ({ requestId, family: "other" as const, provenance: smartSupportProvenance(AT) })),
      identity: CONFIRMED, crmContext: "complete", teamSignals: [] }) }) as { caseId: string; owner: string };
  return { ticketId, caseId: relayed.caseId, owner: relayed.owner };
}

/** The production wiring of the runtime, with only the transports doubled: no scope, no block policy, the smart switch, the real provider selection. */
function wiring() {
  const counts = { brain: [] as string[], gemini: 0, money: 0 };
  const env = { ...GEMINI_ENV, ...SMART };
  const brain = smartScriptedModel(SCRIPT);
  const smart = smartCaseDecisionProvider({ model: async call => { counts.brain.push(call.kind); return brain.model(call); }, env: () => env, now: () => new Date(), maxInputBytes: () => 100_000 });
  const transport = caseGeminiDecisionProvider({ env: () => env, network: (async () => { counts.gemini++; throw Error("GEMINI_FORBIDDEN"); }) as typeof fetch, smart });
  const deps: CaseInvestigationRuntimeDeps = {
    mode: "observe", holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now: () => new Date(Date.now() + 6 * 60_000), leaseSeconds: 60,
    pauseState: async () => "running", readTicketOwner: async () => "v2",
    // Exactly what the factory wires: the pilot scope reader (no scope configured) and the block policy revision (none), plus the smart switch.
    accessScope: async () => null, admissionPolicyRevision: async () => null, smartSupport: () => env.SAV_V2_ENTRY_SMART === "on",
    qualify: async () => { throw Error("REEVALUATION_NOT_EXPECTED"); },
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, SHEET_AND_OFFER])),
    customerContext: async () => ({ revision: "sav-case-customer-context-2026-11-12.v1", notice: "DONNÉES CLIENT", latestMessage: { at: AT, from: "customer", text: SHEET_AND_OFFER, truncated: false,
      subject: "Google Sheet vide", instructionLikeText: false }, thread: [], threadOmitted: 0, crm: null, missing: [] }) as never,
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "synthetic-model", prompt: "prompt-r1" }),
    ledger: caseCallLedgerOnStore,
    knowledge: {
      vectors: { dimension: 8, readRevision: async () => "kb-syn-r1", available: async () => true, search: async queries => queries.map(() => [SHEET_CARD]) },
      embed: async ({ texts }) => ({ vectors: texts.map((_, i) => Array.from({ length: 8 }, (__, j) => (i + 1) / (j + 3))), usage: null }),
      spend: { reserve: async () => ({ status: "allowed", reservationId: randomUUID() }), settle: async () => undefined, release: async () => undefined },
    },
    model: { money: async () => { counts.money++; return { status: "allowed" }; }, provider: async request => (await transport(request)).result },
  };
  return { deps, counts };
}

const fresh = async () => ({ active: true, title: SHEET_CARD.title, content: SHEET_CARD.content, verifiedAt: SHEET_CARD.verifiedAt! });
function passage(options: { env?: Record<string, string | undefined>; readActiveSource?: PilotProvenanceDeps["readActiveSource"] } = {}): CaseReplyPassageDeps {
  const env = { SAV_CASE_EFFECTS: "supervised", ...SMART, ...AUTO, ...options.env };
  const provenance: PilotProvenanceDeps = { accessScope: async () => null, currentPolicyRevision: async () => null, now: () => new Date(), env: () => env,
    readActiveSource: options.readActiveSource ?? fresh };
  return { store: { env: () => env, currentPolicyRevision: async () => null, readTicketOwner: async () => "v2", pilotProvenance: pilotProvenanceGate(provenance) },
    provenance, policy: { id: policyId, hash: "fixture" } };
}
async function decided() {
  const mail = await smartMail();
  const { deps, counts } = wiring();
  const report = await runCaseInvestigationRuntime(mail.caseId, deps);
  return { mail, report, counts };
}
async function rows(caseId: string) {
  const count = async (table: typeof savCaseEffectExecutions | typeof savCaseReplyValidations | typeof savCaseTimers) => (await f.db.select().from(table).where(eq(table.caseId, caseId))).length;
  return { effects: await count(savCaseEffectExecutions), validations: await count(savCaseReplyValidations), timers: await count(savCaseTimers) };
}

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-passage-fixture-key-32-chars!!!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-smart-admin", email: "smart-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  const [row] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = row!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-passage-fixture-key-32-chars!!!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  // The process switch the V2 actors read (`caseAdmissionStatus`): on, as in a deployment that turned the smart entry on.
  vi.stubEnv("SAV_V2_ENTRY_SMART", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  forward.order = []; forward.enqueued = []; forward.synced = []; forward.enqueue = null; forward.authority = async () => undefined; forward.facts = true;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("26/11 B : la partie commerciale est mise en file pour les commerciaux AVANT toute proposition de réponse", () => {
  it("la décision enregistrée répond à l'usage et porte la seule question commerciale ; la réponse n'en dit rien", async () => {
    const { mail, report, counts } = await decided();
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(counts.brain).toEqual(["understand", "decide", "verify"]);
    const events = await listCaseEvents(mail.caseId), read = readCaseInvestigationProgress(events, latestInvestigationInput(events)!);
    if (read.state !== "found" || read.record.decision?.validation.outcome !== "accepted") throw Error("ACCEPTED_REQUIRED");
    const decision = read.record.decision.validation.decision;
    expect(decision.nextAction.kind).toBe("answer");
    expect(decision.commercialPart).toEqual({ asks: [COMMERCIAL_ASK] });
    expect(decision.reply?.text).toBe(SHEET_REPLY);
    expect(decision.reply?.text).not.toMatch(/offre|démo|commercial|transmis/i);
  });

  it("passage : la transmission est mise en file (et lancée) avant la proposition ; une seule fois au rejeu ; la proposition au client n'en dit rien", async () => {
    const { mail } = await decided();
    const first = await passCaseInvestigationToReplyPlan(mail.caseId, passage());
    expect(first).toMatchObject({ status: "awaiting_person" });
    expect(forward.enqueued).toEqual([expect.objectContaining({ caseId: mail.caseId, asks: [COMMERCIAL_ASK], triggerEventId: expect.stringMatching(/^inbound:/) })]);
    expect(forward.synced).toEqual(["k"]);
    const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, mail.caseId));
    const text = decryptSavPayload<{ text: string }>(row!.proposalCiphertext).text;
    expect(text).toContain("reconnectez Google Sheets");
    expect(text).not.toMatch(/offre|démo|commercial|transmis à notre équipe/i);
    // Replay: the same proposal; the queue answers « already there », nothing launched again.
    expect(await passCaseInvestigationToReplyPlan(mail.caseId, passage())).toEqual(first);
    expect(forward.synced).toEqual(["k"]);
  });

  it.each([
    ["la mise en file échoue", () => { forward.enqueue = async () => ({ ok: false, code: "trigger_not_inbound" }); }],
    ["la base refuse l'écriture", () => { forward.enqueue = async () => { throw Error("DB_DOWN"); }; }],
    ["le mail d'origine est introuvable dans contact@ (revue L3)", () => { forward.facts = false; }],
    ["aucune autorité pour transmettre (droit route_intake_mail absent, agent en pause)", () => { forward.authority = async () => { throw Error("SAV_COMMERCIAL_FORWARD_PERMISSION_MISSING"); }; }],
  ])("%s : AUCUNE proposition (jamais une réponse qui oublie la question commerciale) ; attente bornée de la partie équipe", async (_label, arrange) => {
    const { mail } = await decided();
    arrange();
    expect(await passCaseInvestigationToReplyPlan(mail.caseId, passage()))
      .toEqual({ status: "proposal_refused", caseId: mail.caseId, code: "team_part_handoff_unavailable", detail: "commercial_forward_unavailable" });
    expect(await rows(mail.caseId)).toEqual({ effects: 0, validations: 0, timers: 0 });
  });

  it("sous-interrupteur éteint après la décision : aucune proposition, rien mis en file (attente bornée puis tout le mail à l'équipe)", async () => {
    const { mail } = await decided();
    expect(await passCaseInvestigationToReplyPlan(mail.caseId, passage({ env: { SAV_V2_SMART_COMMERCIAL_FORWARD: undefined } })))
      .toEqual({ status: "proposal_refused", caseId: mail.caseId, code: "team_part_handoff_unavailable", detail: "commercial_forward_unavailable" });
    expect(forward.enqueued).toHaveLength(0);
    expect(await rows(mail.caseId)).toEqual({ effects: 0, validations: 0, timers: 0 });
  });
});
