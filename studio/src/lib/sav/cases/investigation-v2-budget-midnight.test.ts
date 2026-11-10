import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import type { SavRetrievalCandidate } from "../request-retrieval";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { markSavCaseCallDispatched, releaseSavCaseCall, reserveSavCaseCall, settleSavCaseCall } from "./case-calls";
import { openCaseEvent } from "./case-store";
import { caseDedupeKey, emptyCaseBody, SAV_CASE_ADMISSION_REVISION, SAV_CASE_CONTRACT_REVISION, type CaseBody, type CaseEvent, type CaseSnapshot } from "./case-types";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import { caseCallLedgerAdapter, type CaseCallLedgerPort } from "./investigation-call-ledger";
import { runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest, type CaseInvestigationPorts, type CaseInvestigationProgress, type CaseInvestigationRecord } from "./investigation-runner";
import { caseV2ModelSpend, readCaseV2SpendDay, SAV_V2_SPEND_POLICY_ENV, type CaseV2ModelTransport } from "./investigation-v2-spend";

/*
 * B (4/11, SYN): the V2 model budget at the change of UTC day, and the proof of what was NOT sent. Real spend register and real ledger on a synthetic database; the provider is a
 * counted double, nothing leaves this file. A day is a budget: a reservation belongs to the day it was made, whatever the clock says when it ends.
 */

const D = "2026-11-04", NEXT = "2026-11-05", BEFORE = new Date(`${D}T23:59:59.000Z`), AFTER = new Date(`${NEXT}T00:00:01.000Z`);
const POLICY = JSON.stringify({ revision: "spend-syn-r1", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00.000Z",
  embedding: { dailyCapMicroUsd: 1000, reserveMicroUsdPerCall: 1000, microUsdPerMillionInputTokens: 1 },
  // One call a day: the reservation alone fills the cap, and a reported usage of 1000 input tokens costs the same.
  model: { dailyCapMicroUsd: 1000, reserveMicroUsdPerCall: 1000, microUsdPerMillionInputTokens: 1_000_000, microUsdPerMillionOutputTokens: 0 } });
let f: Awaited<ReturnType<typeof createSavTestDb>>, clock = BEFORE, ticketSeq = 7_800_000;
const spendDeps = { env: () => ({ [SAV_V2_SPEND_POLICY_ENV]: POLICY }), now: () => clock };
const realLedger: CaseCallLedgerPort = { reserve: reserveSavCaseCall, markDispatched: markSavCaseCallDispatched, settle: settleSavCaseCall, release: releaseSavCaseCall };

async function newCase() {
  const gmail = `gm-budget-${randomUUID()}`;
  const qualification = { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000001", at: "2026-10-30T09:00:00.000Z" } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] };
  const { case: c } = await openCaseEvent({ ticketId: String(++ticketSeq), threadId: randomUUID(), admission: { policy: null, qualification },
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: "2026-10-30T09:00:00.000Z" });
  return c.caseId;
}
const request = (caseId: string, call = 1, input = "in:e1"): CaseInvestigationModelRequest => {
  const subjectKey = `sav-case:${caseId}:${input}`;
  return { purpose: "decision", caseId, caseVersion: 1, inputKey: input, call, subjectKey, callKey: `${subjectKey}:call${call}`, caseBudgetKey: `sav-case:${caseId}`, snapshot: {} as never, events: [], knowledge: [], coverage: null, feedback: [], closure: [] };
};
const paid = (output: unknown = { ok: true }): Awaited<ReturnType<CaseV2ModelTransport>> => ({ result: { status: "ok", output }, usage: { inputTokens: 1000, outputTokens: 0 } });
function adapter(transport: CaseV2ModelTransport, ledger: CaseCallLedgerPort = realLedger, deps = spendDeps) {
  const spend = caseV2ModelSpend(deps);
  return caseCallLedgerAdapter({ ledger, money: spend.money, releaseMoney: spend.release, provider: spend.provider(transport), holder: "budget-test", leaseSeconds: 60, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS });
}
const day = readCaseV2SpendDay.bind(null, "model");

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "budget-midnight-fixture-key-32-chars!"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  clock = BEFORE;
  await f.client.exec("DELETE FROM sav.sync_state WHERE key LIKE 'sav-v2-spend.v1:%'");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("the V2 model budget across midnight", () => {
  it("a call reserved before midnight and answered after it is settled on the day it was reserved; the new day owes nothing", async () => {
    const transport = vi.fn<CaseV2ModelTransport>(async () => { clock = AFTER; return paid(); });
    expect(await adapter(transport)(request(await newCase()))).toMatchObject({ status: "ok" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await day(D)).toEqual({ settledMicroUsd: 1000, heldMicroUsd: 0, open: 0, settled: 1 });
    expect(await day(NEXT)).toBeNull();
  });
  it("an uncertain call across midnight keeps the reserved amount on its own day, never settled as free", async () => {
    const transport = vi.fn<CaseV2ModelTransport>(async () => { clock = AFTER; throw Error("LOST"); });
    expect(await adapter(transport)(request(await newCase()))).toEqual({ status: "failed", uncertain: true });
    expect(await day(D)).toMatchObject({ settledMicroUsd: 1000, open: 0 });
    expect(await day(NEXT)).toBeNull();
  });
  it("the mark fails after midnight: the provider was proven not called, the reservation goes back to ITS day, today's is untouched", async () => {
    const transport = vi.fn<CaseV2ModelTransport>(async () => paid());
    const lost: CaseCallLedgerPort = { ...realLedger, markDispatched: async () => { clock = AFTER; throw Error("MARK_LOST"); } };
    await expect(adapter(transport, lost)(request(await newCase()))).rejects.toThrow("MARK_LOST");
    expect(transport).not.toHaveBeenCalled();
    expect(await day(D)).toEqual({ settledMicroUsd: 0, heldMicroUsd: 0, open: 0, settled: 0 });
    expect(await day(NEXT)).toBeNull();
  });
  it("a failed mark with no release wired stays held: nothing is given back without its port", async () => {
    const spend = caseV2ModelSpend(spendDeps), transport = vi.fn<CaseV2ModelTransport>(async () => paid());
    const call = caseCallLedgerAdapter({ ledger: { ...realLedger, markDispatched: async () => { throw Error("MARK_LOST"); } }, money: spend.money, provider: spend.provider(transport), holder: "budget-test", leaseSeconds: 60, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS });
    await expect(call(request(await newCase()))).rejects.toThrow("MARK_LOST");
    expect(await day(D)).toMatchObject({ heldMicroUsd: 1000, open: 1 });
  });
  it("the cap reached: deferred, proven not sent, the key free again; after midnight the same call goes out on the new day and the closed day is unchanged", async () => {
    const transport = vi.fn<CaseV2ModelTransport>(async () => paid()), first = await newCase(), second = await newCase();
    expect(await adapter(transport)(request(first))).toMatchObject({ status: "ok" });
    const spent = await day(D);
    const call = adapter(transport);
    expect(await call(request(second))).toEqual({ status: "deferred" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await day(D)).toEqual(spent);
    clock = AFTER;
    expect(await call(request(second))).toMatchObject({ status: "ok" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await day(D)).toEqual(spent);
    expect(await day(NEXT)).toEqual({ settledMicroUsd: 1000, heldMicroUsd: 0, open: 0, settled: 1 });
  });
  it("a settled call is not paid again after midnight: the ledger answers, the new day is not touched", async () => {
    const transport = vi.fn<CaseV2ModelTransport>(async () => paid({ first: true })), caseId = await newCase();
    await adapter(transport)(request(caseId));
    clock = AFTER;
    expect(await adapter(transport)(request(caseId))).toEqual({ status: "ok", output: { first: true } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await day(NEXT)).toBeNull();
  });
  it("a provider with no reservation sends nothing: no paid call can escape the register", async () => {
    const transport = vi.fn<CaseV2ModelTransport>(async () => paid());
    expect(await caseV2ModelSpend(spendDeps).provider(transport)(request(randomUUID()))).toMatchObject({ status: "failed", uncertain: false });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("A09 on the runner, with the real budget", () => {
  const A09 = "J’ai déjà essayé le bon lien et la bonne adresse e-mail, mais je ne reçois aucun code. J’ai déjà vérifié les spams. L’écran affiche l’erreur « identifiant introuvable ».";
  const REF = { knowledgeId: "k-login", contentVersionId: "k-login-v1" };
  const card = (escalation: string): SavRetrievalCandidate => ({ id: REF.knowledgeId, contentVersionId: REF.contentVersionId, title: "Connexion synthétique", content: "Ouvrir new.limova.ai puis saisir le code reçu.", source: "fixture",
    verifiedAt: "2026-11-01T00:00:00Z", semanticScore: null, resolution: { steps: ["Ouvrir new.limova.ai."], escalation },
    availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } });
  const understanding = { requests: [{ id: "r1", summary: "Connexion", family: "access", status: "open" }], newFacts: [] };
  const restart = { caseVersion: 2, understanding, nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Suivre la fiche.", knowledge: REF, newFactIds: [] }], expectedResult: "Accès." },
    reply: { text: "Appliquer la procédure : https://new.limova.ai", citations: [REF], impossibilityClaims: [], accountAdvice: "none" } };
  const handoff = { caseVersion: 2, understanding, nextAction: { kind: "handoff", reason: "diagnosis_out_of_tools", requestIds: ["r1"], report: { need: "Connexion bloquée.", expected: null, observed: null, trialIds: [], hypotheses: [], missingInformation: [], expectedIntervention: "Reprendre.", knowledge: [REF] } } };
  const snapshot = (caseId: string): CaseSnapshot => ({ contractRevision: SAV_CASE_CONTRACT_REVISION, caseId, ticketId: "ticket-1", threadIds: ["thread-1"], version: 2, owner: "agent", phase: "queued", sensitivity: "none",
    createdAt: "2026-11-04T09:00:01Z", updatedAt: "2026-11-04T09:00:01Z", admissionInputVersion: 1,
    body: { ...emptyCaseBody(), openRequests: [{ id: "r1", summary: "Connexion", family: "access", status: "open", openedAt: "2026-11-04T09:00:00Z" }] } as CaseBody,
    admission: { revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none", families: ["access"], sensitivity: "none", policyRevision: "policy-r1", decidedAt: "2026-11-04T09:00:02Z", version: 2, inputVersion: 1,
      qualification: { requests: [{ requestId: "r1", family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-syn", revision: "r1", at: "2026-11-04T09:00:02Z" } }], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] } } });
  function ports(caseId: string, escalation: string, transport: CaseV2ModelTransport) {
    const events: CaseEvent[] = [{ id: "e1", caseId, kind: "inbound_confirmed", dedupeKey: "inbound:m1", caseVersion: 1, direction: "customer_inbound", occurredAt: "2026-11-04T09:00:00Z", sourceRef: { type: "email", id: "m1" }, detail: null, createdAt: "2026-11-04T09:00:01Z" }];
    const progress = new Map<string, CaseInvestigationProgress>(), records: CaseInvestigationRecord[] = [];
    const value: CaseInvestigationPorts = { scope: { locale: "fr-FR", audience: "support" }, pauseState: async () => "running", readCase: async () => ({ snapshot: snapshot(caseId), events }), admissionPolicyRevision: async () => "policy-r1",
      reevaluateAdmission: async () => "version_moved", claim: async () => ({ token: "lease", actionsPaused: false }), release: async () => {}, knowledge: async () => [card(escalation)], customerTexts: async () => ({ "email:m1": A09 }),
      revisions: async () => ({ rules: "r", playbookId: "p", model: "m", prompt: "x" }), callModel: adapter(transport),
      progress: { load: async (_c, key) => structuredClone(progress.get(key) ?? null), save: async (_c, key, row) => { progress.set(key, structuredClone(row)); } }, record: async row => { records.push(row); }, now: () => clock, readTicketOwner: async () => "v2",
      accessScope: async () => ({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: "policy-r1", revision: "scope-syn", family: "access", sources: [{ ...REF, use: "answer", firstReply: "login_code_steps" }] }) };
    return { value, records };
  }
  const RELAY = "Si le client reste bloqué, transmettre à l’équipe.";

  it("the relay costs nothing: one paid call, the day's budget then full, the handoff is still recorded", async () => {
    const transport = vi.fn<CaseV2ModelTransport>(async () => paid(restart)), { value, records } = ports(await newCase(), RELAY, transport);
    expect(await runCaseInvestigation((await value.readCase("x"))!.snapshot.caseId, "observe", value)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await day(D)).toMatchObject({ settledMicroUsd: 1000, settled: 1 });
    const validation = records[0]!.validation;
    expect(validation.outcome === "accepted" && validation.decision.nextAction.kind).toBe("handoff");
    expect(validation.signals).toContain("login_procedure_refused_routed");
  });
  it("no relay in the card: the correction waits for the budget, proven not sent; after midnight it goes out on the new day and the refusal is corrected", async () => {
    const answers = [restart, handoff], transport = vi.fn<CaseV2ModelTransport>(async () => paid(answers.shift()));
    const caseId = await newCase(), { value, records } = ports(caseId, "Lire le message disponible.", transport);
    expect(await runCaseInvestigation(caseId, "observe", value)).toMatchObject({ status: "deferred_budget", modelCalls: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(records).toEqual([]);
    const closed = await day(D);
    clock = AFTER;
    expect(await runCaseInvestigation(caseId, "observe", value)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]![0].feedback.map(row => row.code)).toEqual(["login_procedure_redundant"]);
    expect(await day(D)).toEqual(closed);
    expect(await day(NEXT)).toMatchObject({ settledMicroUsd: 1000, settled: 1 });
  });
  it("no relay and a model that insists: stopped at the same refusal twice, recorded refused for the team, no third call", async () => {
    clock = new Date(`${D}T12:00:00.000Z`);
    const rich = () => ({ env: () => ({ [SAV_V2_SPEND_POLICY_ENV]: POLICY.replace('"dailyCapMicroUsd":1000,"reserveMicroUsdPerCall":1000,"microUsdPerMillionInputTokens":1000000', '"dailyCapMicroUsd":100000,"reserveMicroUsdPerCall":1000,"microUsdPerMillionInputTokens":1000000') }), now: () => clock });
    const transport = vi.fn<CaseV2ModelTransport>(async () => paid(restart)), caseId = await newCase(), { value, records } = ports(caseId, "Lire le message disponible.", transport);
    const report = await runCaseInvestigation(caseId, "observe", { ...value, callModel: adapter(transport, realLedger, rich()) });
    expect(report).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: 2 });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(records[0]!.flags.sameRefusalRepeated).toBe(true);
    expect(records[0]!.refusal?.codes).toEqual(["login_procedure_redundant"]);
  });
});
