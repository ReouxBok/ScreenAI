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
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseRequestFamily, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { SAV_CASE_ACCESS_URL } from "./decision-contract";
import { caseDecisionDraft } from "./investigation-intent";
import { SAV_CASE_ACCESS_SCOPE_REVISION, SAV_CASE_BLOCK_SCOPE_REVISION } from "./investigation-access-scope";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { caseAccessScopeConfigReader, SAV_V2_ACCESS_SCOPE_ENV, SAV_V2_BLOCK_SCOPES_ENV } from "./investigation-pilot-readers";
import { readCaseInvestigationProgress } from "./investigation-record";
import { runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationModelResult } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * Treatment blocks (11/11), SYN only, on pole A's real store (PGlite) and B's real runner and validator. The block `syn-widget` (family `usage`)
 * exists in this file only: its rule, scope and source are synthetic. Proven: the runner checks a block's case against that block's own scope
 * (absent: refused before any search or call), Access's case is checked and stamped exactly as before with a second block configured, and
 * a case mixing Access and another block keeps the Access pilot's refusal. Doubles: the search backend, the model, the owner read, the clock.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 9_100_000;
const STAFF = "20000000-0000-4000-8000-000000000011", AT = "2026-11-11T09:00:00.000Z";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access", "usage"], qualifiedRules: [
  { ruleId: "rule-access", revision: "r1", families: ["access"] }, { ruleId: "rule-syn-widget", revision: "r1", families: ["usage"], blockId: "syn-widget" },
  // A rule approved before blocks, of another family: its requests name no block.
  { ruleId: "rule-syn-usage", revision: "r1", families: ["usage"] }], approvedBy: STAFF, approvedAt: AT };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-syn" } };
const ruled = (requestId: string, family: CaseRequestFamily, blockId?: string) => ({ requestId, family,
  provenance: { kind: "qualified_rule" as const, ruleId: family === "access" ? "rule-access" : blockId ? "rule-syn-widget" : "rule-syn-usage", revision: "r1", at: AT, ...(blockId ? { blockId } : {}) } });

const card = (id: string, version: string): SavRetrievalCandidate => ({
  id, contentVersionId: version, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture", verifiedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), semanticScore: null,
  resolution: { steps: ["Étape synthétique"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });
const LOGIN = card("syn-login", "syn-login-v1"), WIDGET = card("syn-widget-card", "syn-widget-v1");
const ACCESS_SCOPE = { schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: "policy-r1", revision: "syn-scope-r1", family: "access", sources: [{ ...refOf(LOGIN), use: "answer" }] };
const WIDGET_SCOPE = { schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId: "syn-widget", family: "usage", policyRevision: "policy-r1", revision: "syn-widget-scope-r1", sources: [{ ...refOf(WIDGET), use: "answer" }] };
const LEGACY_ENV = { [SAV_V2_ACCESS_SCOPE_ENV]: JSON.stringify(ACCESS_SCOPE) };
const BOTH_ENV = { ...LEGACY_ENV, [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([WIDGET_SCOPE]) };

const kb = { searches: 0, cards: [] as Array<{ match: RegExp; card: SavRetrievalCandidate }> };
const backend: SavRetrievalBackend = {
  readRevision: async () => "kb-r1",
  search: async queries => { kb.searches += 1; return queries.map(query => kb.cards.filter(row => row.match.test(query)).map(row => row.card)); },
};
const subject = (text: string) => ({ status: "available" as const, text, provenance: { source: "v1_accepted_analysis" as const, field: "ticketSummary" as const,
  runId: "30000000-0000-4000-8000-000000000003", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: AT } });

/** One relayed mail; each request recorded by pole A with the rule (and block) given. */
async function relayedCase(gmail: string, requests: Array<{ family: CaseRequestFamily; blockId?: string; about: string }>) {
  const ids = requests.map((_, index) => caseRequestId(gmail, `r${index + 1}`));
  const admission: CaseAdmissionInput = { policy: POLICY, qualification: { requests: requests.map((row, index) => ruled(ids[index]!, row.family, row.blockId)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] } };
  return (await openCaseEvent({ ticketId: String(++ticketSeq), threadId: randomUUID(), admission,
    opens: requests.map((row, index) => ({ id: ids[index]!, summary: `Demande « support » relevée par l'analyse V1 du mail ${gmail}.`, subject: subject(row.about) })),
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
}

type Answer = (request: CaseInvestigationModelRequest) => CaseInvestigationModelResult;
const answerWith = (cited: KnowledgeRef, family: string): Answer => request => {
  const requests = request.snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ id: row.id, summary: "Demande du client.", family, status: "open" }));
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: { requests, newFacts: [] },
    nextAction: { kind: "answer", requestIds: [requests[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: cited }], expectedResult: "Le client est débloqué." },
    // The Access block requires its official link in the text (its own check); the other block's text is the same without it.
    reply: { text: family === "access" ? `Bonjour, depuis ${SAV_CASE_ACCESS_URL} : suivez la fiche citée.` : "Bonjour, suivez la fiche citée.", citations: [cited], impossibilityClaims: [], accountAdvice: "none" } } };
};

async function investigate(snapshot: CaseSnapshot, answers: Answer[], values: Record<string, string | undefined>) {
  const calls: CaseInvestigationModelRequest[] = [];
  const now = () => new Date(Date.now() + 6 * 60_000);
  const ports = caseInvestigationStorePorts({
    readTicketOwner: async () => "v2",
    holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: current => selectCaseKnowledge(current, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, une question synthétique."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => { calls.push(structuredClone(request)); return answers.shift()?.(request) ?? { status: "failed", uncertain: false }; },
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async () => null,
  });
  // The production configuration reader, on the synthetic environment of the test.
  return { report: await runCaseInvestigation(snapshot.caseId, "observe", { ...ports, accessScope: caseAccessScopeConfigReader(() => values) }), calls };
}
const recorded = async (caseId: string) => {
  const events = await listCaseEvents(caseId);
  const inputKey = (events.filter(event => event.kind === "observation_recorded").at(-1)?.detail?.record as { inputKey: string } | undefined)?.inputKey;
  if (!inputKey) return null;
  const read = readCaseInvestigationProgress(events, inputKey);
  return read.state === "found" ? { record: read.record, events } : null;
};

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "block-scope-fixture-key-32-chars!!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  Object.assign(kb, { searches: 0, cards: [{ match: /connexion/i, card: LOGIN }, { match: /widget/i, card: WIDGET }] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("(d) Access with a second block configured: searched, validated and stamped exactly as with its legacy datum alone", () => {
  it("same report, same decision, same stamp (no blockId), legacy alone or with the block list", async () => {
    const outcomes = [];
    for (const [gmail, values] of [["gm-blk-access-legacy", LEGACY_ENV], ["gm-blk-access-both", BOTH_ENV]] as const) {
      const c = await relayedCase(gmail, [{ family: "access", about: "Connexion impossible à la plateforme." }]);
      const { report, calls } = await investigate(c, [answerWith(refOf(LOGIN), "access")], values);
      const stored = (await recorded(c.caseId))!;
      outcomes.push({ report: { ...report, caseId: null }, calls: calls.length, scope: stored.record.decision!.accessScope, knowledge: stored.record.decision!.knowledge });
    }
    expect(outcomes[0]).toEqual({ report: { status: "recorded", caseId: null, caseVersion: expect.any(Number), outcome: "accepted", refusal: null, closure: null, modelCalls: 1, actionsPaused: false, callSignal: null },
      calls: 1, scope: { revision: "syn-scope-r1", policyRevision: "policy-r1" }, knowledge: [refOf(LOGIN)] });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});

describe("(e, runner) a block's case is checked against ITS scope; a block with no scope is refused before any search or call", () => {
  it("the block's scope configured: its source supports the answer, and the verdict is stamped with its block", async () => {
    const c = await relayedCase("gm-blk-widget-ok", [{ family: "usage", blockId: "syn-widget", about: "Configurer le widget synthétique." }]);
    const { report, calls } = await investigate(c, [answerWith(refOf(WIDGET), "usage")], BOTH_ENV);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(calls).toHaveLength(1);
    const stored = (await recorded(c.caseId))!, stamp = { revision: "syn-widget-scope-r1", policyRevision: "policy-r1", blockId: "syn-widget" };
    expect(stored.record.decision!.accessScope).toEqual(stamp);
    // A consumer reading the block's scope gets the reply; under Access's stamp (another block) it gets none.
    expect(caseDecisionDraft(c.caseId, stored.record, stored.events, { accessScope: stamp })).toMatchObject({ reply: { purpose: "answer" }, replyLimit: null });
    expect(caseDecisionDraft(c.caseId, stored.record, stored.events, { accessScope: { revision: "syn-widget-scope-r1", policyRevision: "policy-r1" } })).toMatchObject({ reply: null, replyLimit: "access_scope_changed" });
  });

  it("no scope for the block (legacy Access datum only, or a list without it): skipped, no search, no call, nothing recorded", async () => {
    for (const [gmail, values, detail] of [["gm-blk-widget-legacy", LEGACY_ENV, "syn-widget:scope_missing"],
      ["gm-blk-widget-other", { ...LEGACY_ENV, [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([{ ...WIDGET_SCOPE, blockId: "syn-other" }]) }, "syn-widget:scope_missing"],
      ["gm-blk-widget-bad", { ...LEGACY_ENV, [SAV_V2_BLOCK_SCOPES_ENV]: "{not json" }, "syn-widget:scope_unreadable"]] as const) {
      const c = await relayedCase(gmail, [{ family: "usage", blockId: "syn-widget", about: "Configurer le widget synthétique." }]);
      const { report, calls } = await investigate(c, [answerWith(refOf(WIDGET), "usage")], values);
      expect(report).toMatchObject({ status: "skipped", reason: "block_scope_missing", detail, modelCalls: 0 });
      expect({ calls: calls.length, recorded: await recorded(c.caseId) }).toEqual({ calls: 0, recorded: null });
    }
    expect(kb.searches).toBe(0);
  });

  it("a request of another family with no block recorded, or Access mixed with a block: the Access pilot's refusal, unchanged", async () => {
    const unnamed = await relayedCase("gm-blk-unnamed", [{ family: "usage", about: "Configurer le widget synthétique." }]);
    expect((await investigate(unnamed, [answerWith(refOf(WIDGET), "usage")], BOTH_ENV)).report).toMatchObject({ status: "skipped", reason: "pilot_family_not_access", detail: "usage", modelCalls: 0 });
    const mixed = await relayedCase("gm-blk-mixed", [{ family: "access", about: "Connexion impossible à la plateforme." }, { family: "usage", blockId: "syn-widget", about: "Configurer le widget synthétique." }]);
    expect((await investigate(mixed, [answerWith(refOf(LOGIN), "access")], BOTH_ENV)).report).toMatchObject({ status: "skipped", reason: "pilot_family_not_access", detail: "usage", modelCalls: 0 });
    expect(kb.searches).toBe(0);
  });

  it("the block's scope never lets its case cite Access's source, nor the model move it to `access`", async () => {
    const c = await relayedCase("gm-blk-widget-cross", [{ family: "usage", blockId: "syn-widget", about: "Configurer le widget synthétique et la connexion." }]);
    const { report, calls } = await investigate(c, [answerWith(refOf(LOGIN), "usage"), answerWith(refOf(WIDGET), "access"), answerWith(refOf(WIDGET), "usage")], BOTH_ENV);
    const feedback = (index: number) => calls[index]!.feedback.map(row => [row.code, row.path, row.detail]);
    expect(feedback(1)).toContainEqual(["access_source_out_of_scope", "nextAction.steps.0.knowledge", LOGIN.id]);
    expect(feedback(2)).toContainEqual(["pilot_family_out_of_scope", "understanding.requests.0.family", "access"]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 3 });
  });
});
