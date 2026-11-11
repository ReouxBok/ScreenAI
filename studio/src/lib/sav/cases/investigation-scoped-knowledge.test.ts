import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { readSavAgentPause } from "../intake/agent-pause";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Strict local ports: importing HubSpot, the model dispatcher or the call ledger fails the file; fetch throws.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
vi.mock("../intake/runtime-store", () => { throw Error("LEDGER_IMPORTED"); });
import type { CaseAdmissionInput } from "./admission-policy";
import { listCaseEvents, openCaseEvent } from "./case-store";
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { SAV_CASE_ACCESS_URL } from "./decision-contract";
import { SAV_CASE_ACCESS_SCOPE_REVISION, type CaseBlockScope } from "./investigation-access-scope";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { arrangeCaseScopedKnowledge, caseRequestCardRelevance, trimCaseScopedKnowledge } from "./investigation-knowledge-ranking";
import { caseAccessScopeConfigReader, SAV_V2_ACCESS_SCOPE_ENV } from "./investigation-pilot-readers";
import { readCaseInvestigationProgress } from "./investigation-record";
import { runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationModelResult, type CaseInvestigationPorts } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * Scope-first, ranked knowledge (11/11), SYN only, on pole A's real store (PGlite) and B's real runner, retrieval and validator. The Access
 * scope lists ONE synthetic login card; the search returns it with two synthetic integration cards of low score (the shape seen on 11/11),
 * a relevant second card, or not at all. Proven: the scope card goes first and is never dropped, a missing scope card is read at its exact
 * version, low-score out-of-scope cards are left out, a relevant one is kept, the input bound drops out-of-scope cards first, and a case
 * without a scope is unchanged. Doubles: the search backend's scores, the exact read, the model, the preflight, the owner read, the clock.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 9_200_000;
const STAFF = "20000000-0000-4000-8000-000000000011", AT = "2026-11-11T09:00:00.000Z";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-syn" } };

const card = (id: string, title: string, semanticScore: number | null): SavRetrievalCandidate => ({
  id, contentVersionId: `${id}-v1`, title, content: `Procédure synthétique ${id}.`, source: "fixture", verifiedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), semanticScore,
  resolution: { steps: [`Étape synthétique ${id}`] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });
const ACCESS = card("syn-access-code", "Se connecter par code à usage unique", 0.8);
const WEBFLOW = card("syn-webflow", "Connecter Webflow (V3)", 0.62), WIX = card("syn-wix", "Connecter Wix (V3)", 0.61);
const CODE = card("syn-code-delivery", "Recevoir le code de connexion", 0.9);
const FILLERS = [card("syn-filler-a", "Exporter une facture", 0.5), card("syn-filler-b", "Changer de forfait", 0.48), card("syn-filler-c", "Paramétrer un agent", 0.45)];
const ACCESS_SCOPE = { schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: "policy-r1", revision: "syn-scope-r1", family: "access", sources: [{ ...refOf(ACCESS), use: "answer" }] };
const SCOPE_ENV = { [SAV_V2_ACCESS_SCOPE_ENV]: JSON.stringify(ACCESS_SCOPE) };
const ABOUT = "Je n'arrive pas à me connecter à mon compte";

const kb = { searches: 0, batch: [] as SavRetrievalCandidate[] };
const backend: SavRetrievalBackend = { readRevision: async () => "kb-r1", search: async queries => { kb.searches += 1; return queries.map(() => kb.batch); } };
const subject = (text: string) => ({ status: "available" as const, text, provenance: { source: "v1_accepted_analysis" as const, field: "ticketSummary" as const,
  runId: "30000000-0000-4000-8000-000000000003", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: AT } });

async function accessCase(gmail: string) {
  const id = caseRequestId(gmail, "r1");
  const admission: CaseAdmissionInput = { policy: POLICY, qualification: { requests: [{ requestId: id, family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-access", revision: "r1", at: AT } }],
    identity: CONFIRMED, crmContext: "complete", teamSignals: [] } };
  return (await openCaseEvent({ ticketId: String(++ticketSeq), threadId: randomUUID(), admission,
    opens: [{ id, summary: `Demande « support » relevée par l'analyse V1 du mail ${gmail}.`, subject: subject(ABOUT) }],
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
}

const answerWith = (cited: KnowledgeRef) => (request: CaseInvestigationModelRequest): CaseInvestigationModelResult => {
  const requests = request.snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ id: row.id, summary: "Demande du client.", family: "access", status: "open" }));
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: { requests, newFacts: [] },
    nextAction: { kind: "answer", requestIds: [requests[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: cited }], expectedResult: "Le client est débloqué." },
    reply: { text: `Bonjour, depuis ${SAV_CASE_ACCESS_URL} : suivez la fiche citée.`, citations: [cited], impossibilityClaims: [], accountAdvice: "none" } } };
};

type Extra = Partial<Pick<CaseInvestigationPorts, "readScopeCards" | "preflight">> & { scope?: boolean };
async function investigate(snapshot: CaseSnapshot, cited: KnowledgeRef, extra: Extra = {}) {
  const calls: CaseInvestigationModelRequest[] = [];
  const now = () => new Date(Date.now() + 6 * 60_000);
  const ports = caseInvestigationStorePorts({
    readTicketOwner: async () => "v2",
    holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: current => selectCaseKnowledge(current, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, `Bonjour, ${ABOUT}.`])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => { calls.push(structuredClone(request)); return answerWith(cited)(request); },
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async () => null,
  });
  const { scope = true, ...more } = extra;
  const report = await runCaseInvestigation(snapshot.caseId, "observe", { ...ports, ...(scope ? { accessScope: caseAccessScopeConfigReader(() => SCOPE_ENV) } : {}), ...more });
  return { report, calls, sent: (index = 0) => calls[index]?.knowledge.map(row => row.id) };
}
async function recordedCoverage(caseId: string) {
  const events = await listCaseEvents(caseId);
  const inputKey = (events.filter(event => event.kind === "observation_recorded").at(-1)?.detail?.record as { inputKey: string } | undefined)?.inputKey;
  const read = inputKey ? readCaseInvestigationProgress(events, inputKey) : null;
  return read?.state === "found" ? read.record.decision?.coverage ?? null : null;
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "scoped-knowledge-fixture-key-32-chars!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  Object.assign(kb, { searches: 0, batch: [] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("scope-first, ranked knowledge on the Access pilot", () => {
  it("the Access card and two low-score integration cards (11/11 shape): only the Access card is sent, the two drops are recorded by id", async () => {
    kb.batch = [ACCESS, WEBFLOW, WIX, ...FILLERS];
    const c = await accessCase("gm-scoped-low");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { report, calls, sent } = await investigate(c, refOf(ACCESS));
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(calls).toHaveLength(1);
    expect(sent()).toEqual([ACCESS.id]);
    expect(calls[0]!.coverage).toEqual([expect.objectContaining({ status: "covered", knowledge: [refOf(ACCESS)] })]);
    // What the model read carries no new code; the record names each drop (ids and codes, never content).
    expect(calls[0]!.coverage![0]!.limitations.some(code => code.startsWith("knowledge_dropped"))).toBe(false);
    expect((await recordedCoverage(c.caseId))?.[0]?.limitations).toEqual(expect.arrayContaining([`knowledge_dropped:low_relevance:${WEBFLOW.id}`, `knowledge_dropped:low_relevance:${WIX.id}`]));
    const logged = log.mock.calls.find(([name]) => name === "sav_v2_knowledge_selection")?.[1] as { dropped: unknown; sent: unknown };
    expect(logged).toMatchObject({ sent: [ACCESS.id], dropped: [{ ...refOf(WEBFLOW), code: "low_relevance" }, { ...refOf(WIX), code: "low_relevance" }] });
    expect(JSON.stringify(logged)).not.toContain("Procédure synthétique");
  });

  it("a second card of high score (ranked above the Access card): both are sent, the Access card first", async () => {
    kb.batch = [CODE, ACCESS, WEBFLOW, ...FILLERS];
    const c = await accessCase("gm-scoped-high");
    const { report, sent } = await investigate(c, refOf(ACCESS));
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(sent()).toEqual([ACCESS.id, CODE.id]);
  });

  it("the scope card not returned by the search: read at its exact version, sent first, linked to the request, and citable", async () => {
    kb.batch = [WEBFLOW, WIX, ...FILLERS];
    const asked: KnowledgeRef[][] = [];
    const c = await accessCase("gm-scoped-missing");
    const { report, calls, sent } = await investigate(c, refOf(ACCESS), { readScopeCards: async refs => { asked.push(refs); return [ACCESS]; } });
    expect(asked).toEqual([[refOf(ACCESS)]]);
    expect(sent()![0]).toBe(ACCESS.id);
    expect(calls[0]!.coverage![0]!.knowledge).toContainEqual(refOf(ACCESS));
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect((await recordedCoverage(c.caseId))?.[0]?.limitations).toContain(`block_scope_source_added:${ACCESS.id}`);
  });

  it("an exact read that answers another version or a card no longer valid: not sent; a read that fails: a technical wait, no call", async () => {
    kb.batch = [WEBFLOW, WIX, ...FILLERS];
    const stale = { ...ACCESS, verifiedAt: new Date(Date.now() - 200 * 86_400_000).toISOString() };
    for (const [gmail, answer] of [["gm-scoped-other-version", { ...ACCESS, contentVersionId: "syn-access-code-v2" }], ["gm-scoped-stale", stale]] as const) {
      const { calls } = await investigate(await accessCase(gmail), refOf(WEBFLOW), { readScopeCards: async () => [answer] });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.flatMap(call => call.knowledge.map(row => `${row.id}:${row.contentVersionId}`))).not.toContain(`${ACCESS.id}:${answer.contentVersionId}`);
    }
    const failing = await accessCase("gm-scoped-read-fails");
    const { report, calls } = await investigate(failing, refOf(ACCESS), { readScopeCards: async () => { throw Error("DB_DOWN"); } });
    expect(report).toMatchObject({ status: "technical_wait", modelCalls: 0 });
    expect(calls).toHaveLength(0);
  });

  it("over the input bound: the out-of-scope card is dropped first and logged; the scope card is never dropped", async () => {
    kb.batch = [CODE, ACCESS, WEBFLOW, ...FILLERS];
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const tooLarge = (limit: number) => (request: CaseInvestigationModelRequest) => request.knowledge.length > limit
      ? { stage: "preflight" as const, code: "input_too_large" as const, networkAttempted: false, knowledgeCards: request.knowledge.length } : null;
    const fits = await accessCase("gm-scoped-budget");
    const { report, sent } = await investigate(fits, refOf(ACCESS), { preflight: tooLarge(1) });
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(sent()).toEqual([ACCESS.id]);
    const logged = log.mock.calls.find(([name]) => name === "sav_v2_knowledge_selection")?.[1] as { dropped: unknown };
    expect(logged.dropped).toEqual([{ ...refOf(WEBFLOW), code: "low_relevance" }, { ...refOf(CODE), code: "input_budget" }]);
    expect((await recordedCoverage(fits.caseId))?.[0]?.limitations).toContain(`knowledge_dropped:input_budget:${CODE.id}`);
    // Even when nothing fits, the scope card stays: the transport's own refusal (input_too_large) remains the answer, never a silent omission.
    const never = await accessCase("gm-scoped-budget-never");
    const { sent: sentNever } = await investigate(never, refOf(ACCESS), { preflight: tooLarge(0) });
    expect(sentNever()).toEqual([ACCESS.id]);
  });

  it("no scope (not the pilot): the cards and their order are exactly the search's, no exact read, no preflight trim", async () => {
    kb.batch = [ACCESS, WEBFLOW, WIX, ...FILLERS];
    const c = await accessCase("gm-scoped-none");
    const readScopeCards = vi.fn(async () => [ACCESS]), preflight = vi.fn(() => null);
    const { calls, sent } = await investigate(c, refOf(ACCESS), { scope: false, readScopeCards, preflight });
    const searched = await selectCaseKnowledge(c, backend, { locale: "fr-FR", audience: "support", now: new Date(Date.now() + 6 * 60_000) });
    expect(searched.status).toBe("ready");
    if (searched.status !== "ready") return;
    expect(sent()).toEqual(searched.selection.cards.map(row => row.id));
    expect(sent()).toEqual([ACCESS.id, WEBFLOW.id, WIX.id]);
    expect(calls[0]!.coverage).toEqual(searched.selection.coverage);
    expect(readScopeCards).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
  });
});

describe("relevance verdicts (pure)", () => {
  const context = { locale: "fr-FR", audience: "support", now: new Date() };
  it("the request's first card is always kept; low scores against the returned population are `low`", () => {
    expect(caseRequestCardRelevance(ABOUT, [ACCESS, WEBFLOW, WIX], [ACCESS, WEBFLOW, WIX, ...FILLERS], context)).toEqual(["top", "low", "low"]);
    expect(caseRequestCardRelevance(ABOUT, [CODE, ACCESS, WEBFLOW], [CODE, ACCESS, WEBFLOW, ...FILLERS], context)).toEqual(["top", "relevant", "low"]);
  });
  it("no usable score (too few candidates, no semantic score, the first card unscored): kept, as today", () => {
    expect(caseRequestCardRelevance(ABOUT, [ACCESS, WEBFLOW, WIX], [ACCESS, WEBFLOW, WIX], context)).toEqual(["top", "unscored", "unscored"]);
    const unscored = { ...WEBFLOW, semanticScore: null };
    expect(caseRequestCardRelevance(ABOUT, [ACCESS, unscored, WIX], [ACCESS, unscored, WIX, ...FILLERS], context)).toEqual(["top", "unscored", "low"]);
    expect(caseRequestCardRelevance(ABOUT, [{ ...ACCESS, semanticScore: null }, WEBFLOW], [ACCESS, WEBFLOW, WIX, ...FILLERS], context)).toEqual(["top", "unscored"]);
  });
  it("a card relevant to a second request is kept even when low for the first; a request never loses its last card", () => {
    const scope: CaseBlockScope = { schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: "policy-r1", revision: "syn-scope-r1", family: "access", sources: [{ ...refOf(ACCESS), use: "answer" }] };
    const coverage = [
      { requestId: "q1", family: "access" as const, status: "covered" as const, knowledge: [refOf(ACCESS), refOf(WEBFLOW)], limitations: [] },
      // Another family: the Access scope card is not linked to it.
      { requestId: "q2", family: "usage" as const, status: "covered" as const, knowledge: [refOf(WEBFLOW)], limitations: [] },
    ];
    const arranged = arrangeCaseScopedKnowledge({ cards: [ACCESS, WEBFLOW], coverage, scope, fetched: [], relevance: [
      { ...refOf(ACCESS), requestId: "q1", rank: 0, verdict: "top" }, { ...refOf(WEBFLOW), requestId: "q1", rank: 1, verdict: "low" },
      { ...refOf(WEBFLOW), requestId: "q2", rank: 0, verdict: "top" }] });
    expect(arranged.knowledge.map(row => row.id)).toEqual([ACCESS.id, WEBFLOW.id]);
    expect(arranged.dropped).toEqual([]);
    // Over budget, q2's only card goes: q2 is then « not searched » for a context budget, never a gap of the base.
    const trimmed = trimCaseScopedKnowledge(arranged, cards => cards.length <= 1);
    expect(trimmed.coverage[1]).toMatchObject({ status: "not_searched", knowledge: [], limitations: ["source_context_budget"] });
    expect(trimmed.knowledge.map(row => row.id)).toEqual([ACCESS.id]);
  });
});
