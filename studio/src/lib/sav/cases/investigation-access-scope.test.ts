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
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseRequestFamily, type CaseRequestSubject, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import type { CaseDecisionValidationContext } from "./decision-contract";
import { validateCaseDecision } from "./decision-validator";
import { caseAccessScopeStampProblem, caseAccessSourceProblem, parseCaseAccessScope, readCaseAccessScope, SAV_CASE_ACCESS_SCOPE_REVISION, type CaseAccessScope } from "./investigation-access-scope";
import { caseDecisionDraft, caseShownSources } from "./investigation-intent";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { readCaseInvestigationProgress } from "./investigation-record";
import { runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationModelResult } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * Pilot ACCÈS (3/11), CT-A1..A4 and the two refusals ROOT asked for, on pole A's real store (PGlite) and B's real runner
 * and validator. The scope of sources is a SYNTHETIC policy datum injected by each test: no real article id or version is
 * written anywhere. Doubles: the search backend, the model, the rules, the owner read and the clock. Nothing is sent.
 * Reproduced error: pole A relays « change my sign-in address » (identity, sensitive) as an `access` request.
 * ROOT (3/11, after review A of B): `access` is the only admissible family of this pilot, whatever the policy admits; a scope
 * is bound to the policy in force; a consumed verdict carries the scope it was validated under, unknown is closed.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_900_000;
const STAFF = "20000000-0000-4000-8000-000000000002", AT = "2026-11-03T09:00:00.000Z", ACCESS = "https://new.limova.ai";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
type Identity = CaseAdmissionQualification["identity"];
const CONFIRMED: Identity = { status: "confirmed", source: { type: "hubspot_object", id: "contact-syn" } };
const qualification = (requests: CaseAdmissionQualification["requests"], identity = CONFIRMED): CaseAdmissionQualification =>
  ({ requests, identity, crmContext: "complete", teamSignals: [] });
const ruled = (requestId: string, family: CaseRequestFamily = "access") => ({ requestId, family, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
// Review A, B-1: a policy that also admits `usage` (as V1's synthetic policy does), same revision as the one in force.
const POLICY_WIDE = { ...POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access", "usage"] }] };

const recent = () => new Date(Date.now() - 10 * 86_400_000).toISOString();
const card = (id: string, version: string): SavRetrievalCandidate => ({
  id, contentVersionId: version, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture", verifiedAt: recent(), semanticScore: null,
  resolution: { steps: ["Étape synthétique"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });
// SYN sources: a sign-in help the scope allows, a sign-in address change it does not list, a topic still pending.
const LOGIN = card("syn-login", "syn-login-v1"), LOGIN_V2 = card("syn-login", "syn-login-v2");
const ADDRESS = card("syn-address-change", "syn-address-v1"), PENDING = card("syn-code-refused", "syn-pending-v1");
const SCOPE: CaseAccessScope = { schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: "policy-r1", revision: "syn-scope-r1", family: "access", sources: [
  { knowledgeId: LOGIN.id, contentVersionId: "syn-login-v1", use: "answer" },
  { knowledgeId: PENDING.id, contentVersionId: PENDING.contentVersionId, use: "orient_only" },
] };

const kb = { searches: 0, cards: [] as Array<{ match: RegExp; card: SavRetrievalCandidate }> };
const backend: SavRetrievalBackend = {
  readRevision: async () => "kb-r1",
  search: async queries => { kb.searches += 1; return queries.map(query => kb.cards.filter(row => row.match.test(query)).map(row => row.card)); },
};

const subject = (text: string): CaseRequestSubject => ({ status: "available", text, provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
  runId: "30000000-0000-4000-8000-000000000003", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: AT } });
/** One mail relayed by V1, its single request recorded as `access` by pole A's rule, whatever the subject really is. */
async function accessCase(gmail: string, about: string, identity = CONFIRMED, family: CaseRequestFamily = "access") {
  const admission: CaseAdmissionInput = { policy: family === "access" ? POLICY : POLICY_WIDE, qualification: qualification([ruled(caseRequestId(gmail, "r1"), family)], identity) };
  return (await openCaseEvent({ ticketId: String(++ticketSeq), threadId: randomUUID(), admission, opens: [{ id: caseRequestId(gmail, "r1"),
    summary: `Demande « support » relevée par l'analyse V1 du mail ${gmail}.`, subject: subject(about) }],
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
}

type Answer = (request: CaseInvestigationModelRequest) => CaseInvestigationModelResult;
const understood = (snapshot: CaseSnapshot) => ({ requests: snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ id: row.id, summary: "Accès au compte.", family: "access", status: "open" })), newFacts: [] });
const answerWith = (cited: KnowledgeRef): Answer => request => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "answer", requestIds: [u.requests[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: cited }], expectedResult: "Le client accède à son compte." },
    reply: { text: `Bonjour, depuis ${ACCESS} : suivre la fiche.`, citations: [cited], impossibilityClaims: [], accountAdvice: "none" } } };
};
/** The source may orient a handoff: it is reported to the team, never used as an answer. */
const handoffWith = (reported: KnowledgeRef): Answer => request => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "handoff", reason: "sensitive_request", requestIds: [u.requests[0]!.id], report: { need: "Le client veut modifier l'accès à son compte.", expected: null, observed: null,
      trialIds: [], hypotheses: [], missingInformation: [], expectedIntervention: "Traitement par l'équipe.", knowledge: [reported] } } } };
};
const askMessage: Answer = request => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "ask", questions: [{ text: "Quel message s'affiche ?", requestId: u.requests[0]!.id, reducesUncertainty: "Précise le blocage.", seeks: [{ kind: "observed_result" }] }] },
    reply: { text: `Bonjour, depuis ${ACCESS}, quel message s'affiche ?`, citations: [], impossibilityClaims: [], accountAdvice: "none" } } };
};

async function investigate(caseId: string, answers: Answer[], options: { scope?: () => Promise<unknown>; identity?: Identity } = {}) {
  const calls: CaseInvestigationModelRequest[] = [];
  const now = () => new Date(Date.now() + 6 * 60_000);
  const ports = caseInvestigationStorePorts({
    readTicketOwner: async () => "v2",
    holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, question sur l'accès à mon compte."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => { calls.push(structuredClone(request)); return answers.shift()?.(request) ?? { status: "failed", uncertain: false }; },
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id));
      return latest ? { admission: { policy: POLICY, qualification: qualification(requests, options.identity ?? CONFIRMED) }, sourceRef: latest.sourceRef } : null;
    },
  });
  const scope = "scope" in options ? options.scope : async () => structuredClone(SCOPE);
  return { report: await runCaseInvestigation(caseId, "observe", { ...ports, ...(scope ? { accessScope: scope } : {}) }), calls };
}
const recorded = async (caseId: string) => {
  const events = await listCaseEvents(caseId);
  const inputKey = (events.filter(event => event.kind === "observation_recorded").at(-1)?.detail?.record as { inputKey: string } | undefined)?.inputKey;
  if (!inputKey) return null;
  const read = readCaseInvestigationProgress(events, inputKey);
  return read.state === "found" ? read.record : null;
};
/** The same output, with the family the model gives to the first request replaced. */
const renamedTo = (family: string, inner: Answer): Answer => request => {
  const result = inner(request) as { status: "ok"; output: { understanding: { requests: Array<{ family: string }> } } };
  result.output.understanding.requests[0]!.family = family;
  return result as CaseInvestigationModelResult;
};
const feedback = (calls: CaseInvestigationModelRequest[], index: number) => calls[index]!.feedback.map(row => [row.code, row.path, row.detail]);

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "access-scope-fixture-key-32-chars!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  Object.assign(kb, { searches: 0, cards: [] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("pilot ACCÈS scope: a datum, read closed", () => {
  it("no scope, a malformed one, an ambiguous one (a source listed twice) or a failed read is never a scope", async () => {
    expect(parseCaseAccessScope(null, "policy-r1")).toEqual({ ok: false, problem: "scope_missing" });
    expect(parseCaseAccessScope(undefined, "policy-r1")).toEqual({ ok: false, problem: "scope_missing" });
    const unversioned: Record<string, unknown> = { ...SCOPE };
    delete unversioned.schema;
    for (const bad of [{ ...SCOPE, family: "usage" }, { ...SCOPE, sources: [] }, { ...SCOPE, extra: true }, { ...SCOPE, sources: [{ ...SCOPE.sources[0]!, use: "maybe" }] },
      { ...SCOPE, sources: [SCOPE.sources[0]!, { ...SCOPE.sources[0]!, contentVersionId: "other" }] }, "syn-login",
      // Review A, B-4: a free revision is not enough: the schema is required, and identifiers are read as written.
      unversioned, { ...SCOPE, schema: "sav-case-access-scope-other" }, { ...SCOPE, sources: [{ ...SCOPE.sources[0]!, knowledgeId: " syn-login" }] }])
      expect(parseCaseAccessScope(bad, "policy-r1")).toEqual({ ok: false, problem: "scope_invalid" });
    expect(await readCaseAccessScope(async () => { throw Error("POLICY_READ_FAILED"); }, "policy-r1")).toEqual({ ok: false, problem: "scope_unreadable" });
    expect(await readCaseAccessScope(async () => SCOPE, "policy-r1")).toEqual({ ok: true, scope: SCOPE });
  });

  it("review A, B-4: a scope approved with another admission policy, or with no policy in force, is no scope", () => {
    expect(parseCaseAccessScope(SCOPE, "policy-r2")).toEqual({ ok: false, problem: "scope_policy_mismatch" });
    expect(parseCaseAccessScope(SCOPE, null)).toEqual({ ok: false, problem: "scope_policy_mismatch" });
    expect(parseCaseAccessScope({ ...SCOPE, policyRevision: "policy-r2" }, "policy-r1")).toEqual({ ok: false, problem: "scope_policy_mismatch" });
  });

  it("a cited source supports an answer only when listed for answers, at that exact version", () => {
    expect(caseAccessSourceProblem(SCOPE, refOf(LOGIN))).toBeNull();
    expect(caseAccessSourceProblem(null, refOf(LOGIN))).toBe("access_scope_missing");
    expect(caseAccessSourceProblem(SCOPE, refOf(ADDRESS))).toBe("access_source_out_of_scope");
    expect(caseAccessSourceProblem(SCOPE, refOf(LOGIN_V2))).toBe("access_source_version_out_of_scope");
    expect(caseAccessSourceProblem(SCOPE, refOf(PENDING))).toBe("access_source_orient_only");
  });
});

describe("refused before any search: no proof of identity or of risk", () => {
  it("CT-A4: an access request with no approved scope (missing, malformed, unreadable) is not searched and no model is called", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    for (const [gmail, scope, problem] of [["gm-as-none", async () => null, "scope_missing"], ["gm-as-bad", async () => ({ ...SCOPE, family: "usage" }), "scope_invalid"],
      ["gm-as-throw", async () => { throw Error("POLICY_READ_FAILED"); }, "scope_unreadable"]] as const) {
      const c = await accessCase(gmail, "Connexion impossible à la plateforme.");
      const { report, calls } = await investigate(c.caseId, [answerWith(refOf(LOGIN))], { scope });
      expect(report).toMatchObject({ status: "skipped", reason: "access_scope_missing", detail: problem, modelCalls: 0 });
      expect({ calls: calls.length, recorded: await recorded(c.caseId) }).toEqual({ calls: 0, recorded: null });
    }
    expect(kb.searches).toBe(0);
  });

  it("the misfiled address change with an unconfirmed identity: the team keeps it, even with a valid scope; no search, no call", async () => {
    kb.cards = [{ match: /adresse/i, card: ADDRESS }];
    const c = await accessCase("gm-as-identity", "Changer l'adresse e-mail de connexion du compte.", { status: "ambiguous" } as Identity);
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(ADDRESS))], { identity: { status: "ambiguous" } as Identity });
    expect(report).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect({ calls: calls.length, searches: kb.searches, recorded: await recorded(c.caseId) }).toEqual({ calls: 0, searches: 0, recorded: null });
  });
});

describe("refused before any answer: source or version outside the scope", () => {
  it("witness: a source listed for answers, at its version, supports the answer; the scope changes nothing on the good path", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const c = await accessCase("gm-as-ok", "Connexion impossible à la plateforme.");
    const { report } = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect((await recorded(c.caseId))!.decision).toMatchObject({ knowledge: [refOf(LOGIN)] });
  });

  it("CT-A1: the misfiled address change retrieves a source outside the scope: the answer is refused, the handoff that reports it is accepted", async () => {
    kb.cards = [{ match: /adresse/i, card: ADDRESS }];
    const c = await accessCase("gm-as-a1", "Changer l'adresse e-mail de connexion du compte.");
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(ADDRESS)), handoffWith(refOf(ADDRESS))]);
    expect(calls[0]!.coverage).toMatchObject([{ family: "access", status: "covered", knowledge: [refOf(ADDRESS)] }]);
    expect(feedback(calls, 1)).toEqual([["access_source_out_of_scope", "nextAction.steps.0.knowledge", ADDRESS.id], ["access_source_out_of_scope", "reply.citations.0", ADDRESS.id]]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
    expect((await recorded(c.caseId))!.decision!.validation).toMatchObject({ outcome: "accepted", decision: { nextAction: { kind: "handoff", report: { knowledge: [refOf(ADDRESS)] } } } });
  });

  it("CT-A1 bis: renaming the request's family in the proposal does not leave the scope", async () => {
    kb.cards = [{ match: /adresse/i, card: ADDRESS }];
    const c = await accessCase("gm-as-a1b", "Changer l'adresse e-mail de connexion du compte.");
    const { calls } = await investigate(c.caseId, [renamedTo("usage", answerWith(refOf(ADDRESS))), askMessage]);
    expect(feedback(calls, 1)).toContainEqual(["access_source_out_of_scope", "nextAction.steps.0.knowledge", ADDRESS.id]);
  });

  it("CT-A1 ter: a step on the listed source does not carry a citation outside the scope to the customer", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }, { match: /adresse/i, card: ADDRESS }];
    const c = await accessCase("gm-as-a1t", "Connexion impossible avec mon adresse e-mail.");
    const mixed: Answer = request => { const result = answerWith(refOf(LOGIN))(request) as { status: "ok"; output: { reply: { citations: KnowledgeRef[] } } };
      result.output.reply.citations = [refOf(LOGIN), refOf(ADDRESS)]; return result as CaseInvestigationModelResult; };
    const { report, calls } = await investigate(c.caseId, [mixed, answerWith(refOf(LOGIN))]);
    expect(feedback(calls, 1)).toEqual([["access_source_out_of_scope", "reply.citations.1", ADDRESS.id]]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
  });

  it("CT-A2: the listed source at another version (the search returns a newer one) cannot support the answer", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN_V2 }];
    const c = await accessCase("gm-as-a2", "Connexion impossible à la plateforme.");
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(LOGIN_V2)), askMessage]);
    expect(feedback(calls, 1)).toEqual([["access_source_version_out_of_scope", "nextAction.steps.0.knowledge", LOGIN.id], ["access_source_version_out_of_scope", "reply.citations.0", LOGIN.id]]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
    expect((await recorded(c.caseId))!.decision!.validation).toMatchObject({ outcome: "accepted", decision: { nextAction: { kind: "ask" } } });
  });

  it("CT-A3: a source found for a topic still pending (orient only) gives no answer; a targeted question is accepted", async () => {
    kb.cards = [{ match: /code/i, card: PENDING }];
    const c = await accessCase("gm-as-a3", "Le code de connexion reçu est refusé.");
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(PENDING)), askMessage]);
    expect(feedback(calls, 1)).toEqual([["access_source_orient_only", "nextAction.steps.0.knowledge", PENDING.id], ["access_source_orient_only", "reply.citations.0", PENDING.id]]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
  });
});

describe("ROOT 3/11 after review A: access is the only admissible family of the pilot; verdicts are bound to their scope", () => {
  it("CT-R1 (B-1): a request pole A recorded as `usage` under a policy that admits it never reaches the model in the pilot; alone or mixed with access", async () => {
    kb.cards = [{ match: /adresse/i, card: ADDRESS }, { match: /connexion/i, card: LOGIN }];
    const alone = await accessCase("gm-as-r1", "Changer l'adresse e-mail de connexion du compte.", CONFIRMED, "usage");
    const { report, calls } = await investigate(alone.caseId, [answerWith(refOf(ADDRESS))]);
    expect(report).toMatchObject({ status: "skipped", reason: "pilot_family_not_access", detail: "usage", modelCalls: 0 });
    const gmail = "gm-as-r1m", mixed = (await openCaseEvent({ ticketId: String(++ticketSeq), threadId: randomUUID(),
      admission: { policy: POLICY_WIDE, qualification: qualification([ruled(caseRequestId(gmail, "r1")), ruled(caseRequestId(gmail, "r2"), "usage")]) },
      opens: [{ id: caseRequestId(gmail, "r1"), summary: "Demande relevée par V1.", subject: subject("Connexion impossible à la plateforme.") },
        { id: caseRequestId(gmail, "r2"), summary: "Demande relevée par V1.", subject: subject("Changer l'adresse e-mail du compte.") }],
      kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
    expect((await investigate(mixed.caseId, [answerWith(refOf(LOGIN))])).report).toMatchObject({ status: "skipped", reason: "pilot_family_not_access", detail: "usage", modelCalls: 0 });
    expect({ calls: calls.length, searches: kb.searches }).toEqual({ calls: 0, searches: 0 });
  });

  it("CT-R2 (B-2): the model may not move an access request to another ordinary family, even citing a listed source; to a sensitive one it may only hand off", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const c = await accessCase("gm-as-r2", "Connexion impossible à la plateforme.");
    const { report, calls } = await investigate(c.caseId, [renamedTo("usage", answerWith(refOf(LOGIN))), renamedTo("identity", handoffWith(refOf(LOGIN)))]);
    expect(feedback(calls, 1)).toEqual([["pilot_family_out_of_scope", "understanding.requests.0.family", "usage"]]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
    expect((await recorded(c.caseId))!.decision!.validation).toMatchObject({ outcome: "accepted", decision: { nextAction: { kind: "handoff" } } });
    // A question is no way out either: `technical` is refused, the same question on `access` is accepted.
    const q = await accessCase("gm-as-r2q", "Connexion impossible à la plateforme.");
    const asked = await investigate(q.caseId, [renamedTo("technical", askMessage), askMessage]);
    expect(feedback(asked.calls, 1)).toEqual([["pilot_family_out_of_scope", "understanding.requests.0.family", "technical"]]);
    expect(asked.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
  });

  it("CT-R3 (B-3): a request the case handed off or resolved cannot be reopened by the proposal and answered", () => {
    for (const closed of ["handed_off", "resolved"] as const) {
      const context: CaseDecisionValidationContext = { caseId: "case-syn", caseVersion: 3, owner: "agent", admission: { admitted: true }, locale: "fr-FR", audience: "support",
        sensitiveCategories: [], requests: [{ id: "r1", family: "access", status: closed }, { id: "r2", family: "access", status: "open" }],
        sources: [{ ref: { type: "email", id: "m1" }, direction: "customer_inbound", at: "2026-11-03T08:00:00Z", order: 1 }], customerTexts: {},
        facts: [], questions: [], trials: [], handoffs: [], knowledge: [LOGIN], accessScope: SCOPE };
      const proposal = { caseVersion: 3, understanding: { requests: ["r1", "r2"].map(id => ({ id, summary: "Accès au compte.", family: "access", status: "open" })), newFacts: [] },
        nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Suivre la fiche citée.", knowledge: refOf(LOGIN) }], expectedResult: "Le client accède à son compte." },
        reply: { text: `Bonjour, depuis ${ACCESS} : suivre la fiche.`, citations: [refOf(LOGIN)], impossibilityClaims: [], accountAdvice: "none" } };
      const result = validateCaseDecision(proposal, context, new Date());
      expect(result.outcome).toBe("needs_review");
      expect(result.outcome === "needs_review" ? result.rejections.map(row => [row.code, row.path, row.detail]) : []).toContainEqual(["request_not_open", "nextAction.requestIds.0", closed]);
    }
  });

  it("CT-R4 (B-5): the verdict carries the scope it was validated under; a pilot consumer gets a reply only under that same scope, never for an older decision without one", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const c = await accessCase("gm-as-r4", "Connexion impossible à la plateforme.");
    expect((await investigate(c.caseId, [answerWith(refOf(LOGIN))])).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    const stored = (await recorded(c.caseId))!, events = await listCaseEvents(c.caseId), stamp = { revision: "syn-scope-r1", policyRevision: "policy-r1" };
    expect(stored.decision!.accessScope).toEqual(stamp);
    expect(caseDecisionDraft(c.caseId, stored, events, { accessScope: stamp })).toMatchObject({ reply: { purpose: "answer" }, replyLimit: null, accessScope: stamp, shownSources: [refOf(LOGIN)] });
    for (const [current, limit] of [[{ ...stamp, revision: "syn-scope-r2" }, "access_scope_changed"], [{ ...stamp, policyRevision: "policy-r2" }, "access_scope_changed"], [null, "access_scope_unknown"]] as const)
      expect(caseDecisionDraft(c.caseId, stored, events, { accessScope: current })).toMatchObject({ reply: null, replyLimit: limit });
    // A stamped verdict read without the pilot's current scope is closed too.
    expect(caseDecisionDraft(c.caseId, stored, events)).toMatchObject({ reply: null, replyLimit: "access_scope_unknown" });
    // An older decision, recorded before any scope: unknown, so closed for a pilot consumer.
    const older = structuredClone(stored);
    delete (older.decision as { accessScope?: unknown }).accessScope;
    expect(caseDecisionDraft(c.caseId, older, events, { accessScope: stamp })).toMatchObject({ reply: null, replyLimit: "access_scope_unknown" });
    expect(caseAccessScopeStampProblem(undefined, stamp)).toBe("access_scope_unknown");
  });
});

describe("C §13: the draft lists every source shown to the customer, not only the reply's citations", () => {
  it("answer steps, reply citations and impossibility claims, one entry per exact version, sorted; nothing for a question without advice", () => {
    const step = (ref: KnowledgeRef) => ({ text: "Suivre la fiche.", knowledge: ref });
    const reply = (citations: KnowledgeRef[], claims: KnowledgeRef[] = []) => ({ text: "Bonjour.", citations, accountAdvice: "none" as const,
      impossibilityClaims: claims.map(knowledge => ({ requestId: "r1", statement: "Impossible depuis le compte.", knowledge })) });
    const answer = (steps: KnowledgeRef[]) => ({ kind: "answer", requestIds: ["r1"], steps: steps.map(step), expectedResult: "Accès rétabli." });
    // An answer that cites its source in its steps only: `citations` is empty, the shown list is not.
    expect(caseShownSources({ nextAction: answer([refOf(LOGIN)]), reply: reply([]) } as never)).toEqual([refOf(LOGIN)]);
    expect(caseShownSources({ nextAction: answer([refOf(PENDING), refOf(LOGIN)]), reply: reply([refOf(LOGIN), refOf(LOGIN_V2)], [refOf(ADDRESS)]) } as never))
      .toEqual([refOf(ADDRESS), refOf(PENDING), refOf(LOGIN), refOf(LOGIN_V2)].sort((a, b) => `${a.knowledgeId}\u0000${a.contentVersionId}` < `${b.knowledgeId}\u0000${b.contentVersionId}` ? -1 : 1));
    expect(caseShownSources({ nextAction: { kind: "ask", questions: [] }, reply: reply([]) } as never)).toEqual([]);
    expect(caseShownSources({ nextAction: { kind: "observe_only" }, reply: undefined } as never)).toEqual([]);
  });
});
