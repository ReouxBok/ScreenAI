import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ message: null as null | { body: string; subject: string }, reads: 0 }));
// The entry reads one stored mail; nothing else of the database is reachable from this file.
vi.mock("@/db", () => ({ requireDb: () => ({ select: () => ({ from: () => ({ where: async () => { state.reads += 1; return state.message ? [state.message] : []; } }) }) }) }));
import { encryptSavPayload } from "../crypto";
import { caseBlockCandidates, caseOpenBlockId, caseRequestBlockId, selectCaseBlockRule, type CaseBlockDetector, type CaseEntryRule } from "./case-blocks";
import { SAV_CASE_BLOCK_REGISTRY } from "./case-block-registry";
import { caseAdmissionQualificationSchema, SAV_CASE_ACCESS_BLOCK_ID, SAV_CASE_ADMISSIBLE_FAMILIES, SAV_CASE_BLOCK_ID, type CaseSnapshot } from "./case-types";
import { decideAccessAutoApproval, readAccessAutoApprovalConfig } from "./customer-return";
import type { CaseDecisionValidationContext } from "./decision-contract";
import { validateCaseDecision } from "./decision-validator";
import {
  caseAccessScopeStamp, caseAccessScopeStampProblem, parseCaseAccessScope, parseCaseBlockScopeList, readCaseAccessScope, SAV_CASE_ACCESS_SCOPE_REVISION, SAV_CASE_BLOCK_SCOPE_FAMILIES,
  SAV_CASE_BLOCK_SCOPE_REVISION, type CaseBlockScope,
} from "./investigation-access-scope";
import { caseAccessScopeConfigReader, SAV_V2_ACCESS_SCOPE_ENV, SAV_V2_BLOCK_SCOPES_ENV } from "./investigation-pilot-readers";
import { firstPersonalLoginRequest } from "./investigation-return-qualify";
import { firstBlockEvidence } from "./v2-entry";

/*
 * Treatment blocks (11/11), SYN only: the block `syn-widget` exists in this file and nowhere else. Its detector, rule, scope and sources are
 * synthetic. What is proven: Access with its rule alone admits exactly as before; a second block's rule never stops Access; a mail is admitted
 * by exactly one block or by none; the legacy Access scope datum is read unchanged, and a second block's scope never changes Access's.
 */

const AT = "2026-11-11T09:00:00.000Z", POLICY_REVISION = "policy-syn-r1";
const ACCESS_RULE: CaseEntryRule = { ruleId: "rule-syn-access", revision: "r1", v1Kind: "support", family: "access", at: AT };
const WIDGET_RULE: CaseEntryRule = { ruleId: "rule-syn-widget", revision: "r1", v1Kind: "support", family: "usage", at: AT, blockId: "syn-widget" };
const WIDGET: CaseBlockDetector = { blockId: "syn-widget", family: "usage", firstRequest: text => /\bwidget synthétique\b/i.test(text) };
const REGISTRY: readonly CaseBlockDetector[] = [...SAV_CASE_BLOCK_REGISTRY, WIDGET];
const LOGIN_TEXT = "Bonjour, je ne reçois pas le code de connexion à mon compte.", LOGIN_SUBJECT = "Connexion impossible";
const WIDGET_TEXT = "Bonjour, comment configurer le widget synthétique de mon espace ?", WIDGET_SUBJECT = "Question widget";
const OTHER_TEXT = "Bonjour, pouvez-vous m'envoyer la documentation générale ?", OTHER_SUBJECT = "Documentation";

const env = (rules: readonly unknown[]) => ({ SAV_V2_ADMISSION_RULES_JSON: JSON.stringify(rules) });
const request = [{ requestId: "gm-syn/r1", kind: "support" }] as Parameters<typeof firstBlockEvidence>[3];
const mail = (text: string, subject: string) => { state.message = { body: encryptSavPayload({ text }), subject }; };
const evidence = (rules: readonly unknown[], registry: readonly CaseBlockDetector[] = REGISTRY) => firstBlockEvidence(env(rules), "message-syn", "gm-syn", request, registry);

beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-blocks-fixture-key-32-chars!!!");
  state.message = null; state.reads = 0;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the code registry: one detector per block, the family `access` is Access's alone", () => {
  it("ships Access only, with its existing detector", () => {
    expect(SAV_CASE_BLOCK_REGISTRY.map(block => [block.blockId, block.family])).toEqual([["access", "access"]]);
    expect(SAV_CASE_BLOCK_REGISTRY[0]!.firstRequest).toBe(firstPersonalLoginRequest);
    // Preconditions of the fixtures below: the texts are read by the real detector.
    expect([firstPersonalLoginRequest(LOGIN_TEXT, LOGIN_SUBJECT), firstPersonalLoginRequest(WIDGET_TEXT, WIDGET_SUBJECT), firstPersonalLoginRequest(OTHER_TEXT, OTHER_SUBJECT)]).toEqual([true, false, false]);
  });
  it("the pure scope module keeps case-types' values: block id pattern, Access's id, the admissible families other than access", () => {
    expect(SAV_CASE_BLOCK_SCOPE_FAMILIES).toEqual(SAV_CASE_ADMISSIBLE_FAMILIES.filter(family => family !== "access"));
    const scope = (blockId: string) => ({ schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId, family: "usage", policyRevision: "p", revision: "r", sources: [{ knowledgeId: "k", contentVersionId: "v", use: "answer" }] });
    for (const blockId of ["syn-widget", "a1", "x".repeat(40), "Syn", "1abc", "a", "x".repeat(41), "access"])
      expect([blockId, parseCaseBlockScopeList([scope(blockId)], "p", blockId).ok]).toEqual([blockId, SAV_CASE_BLOCK_ID.test(blockId) && blockId !== SAV_CASE_ACCESS_BLOCK_ID]);
  });
  it("a rule is a candidate only for a known block of its own family; a rule written before blocks is Access's only for `access`", () => {
    const rules: CaseEntryRule[] = [ACCESS_RULE, WIDGET_RULE, { ...WIDGET_RULE, ruleId: "rule-no-block", blockId: undefined }, { ...WIDGET_RULE, ruleId: "rule-unknown", blockId: "syn-unknown" },
      { ...WIDGET_RULE, ruleId: "rule-wrong-family", family: "technical" }, { ...ACCESS_RULE, ruleId: "rule-access-as-widget", blockId: "syn-widget" }, { ...WIDGET_RULE, ruleId: "rule-not-support", v1Kind: "billing" }];
    expect(caseBlockCandidates(rules, REGISTRY).map(row => [row.rule.ruleId, row.block.blockId])).toEqual([["rule-syn-access", "access"], ["rule-syn-widget", "syn-widget"]]);
  });
});

describe("entry: every approved rule is evaluated, exactly one block admits", () => {
  it("(a) Access with only its rule admits exactly as before: same family, same provenance bytes (no blockId), one mail read", async () => {
    mail(LOGIN_TEXT, LOGIN_SUBJECT);
    const admitted = await evidence([ACCESS_RULE], SAV_CASE_BLOCK_REGISTRY);
    expect(admitted).toEqual([{ requestId: "gm-syn/r1", family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-syn-access", revision: "r1", at: AT } }]);
    expect(JSON.stringify(admitted[0]!.provenance)).toBe(JSON.stringify({ kind: "qualified_rule", ruleId: "rule-syn-access", revision: "r1", at: AT }));
    expect(state.reads).toBe(1);
    mail(OTHER_TEXT, OTHER_SUBJECT);
    expect(await evidence([ACCESS_RULE], SAV_CASE_BLOCK_REGISTRY)).toEqual([]);
    // As before: no rule, or a request that is not one support request, reads no mail and admits nobody.
    state.reads = 0;
    expect(await evidence([], SAV_CASE_BLOCK_REGISTRY)).toEqual([]);
    expect(await firstBlockEvidence(env([ACCESS_RULE]), "message-syn", "gm-syn", [...request, { requestId: "gm-syn/r2", kind: "support" }] as never)).toEqual([]);
    expect(state.reads).toBe(0);
  });

  it("(b) Access + a second block: an Access mail is Access's, the block's mail is the block's (blockId recorded), a mail of neither is nobody's", async () => {
    mail(LOGIN_TEXT, LOGIN_SUBJECT);
    expect(await evidence([ACCESS_RULE, WIDGET_RULE])).toEqual([{ requestId: "gm-syn/r1", family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-syn-access", revision: "r1", at: AT } }]);
    mail(WIDGET_TEXT, WIDGET_SUBJECT);
    const widget = await evidence([ACCESS_RULE, WIDGET_RULE]);
    expect(widget).toEqual([{ requestId: "gm-syn/r1", family: "usage", provenance: { kind: "qualified_rule", ruleId: "rule-syn-widget", revision: "r1", at: AT, blockId: "syn-widget" } }]);
    // The recorded qualification accepts the block's provenance, and still refuses anything else.
    const qualification = { requests: widget, identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] };
    expect(caseAdmissionQualificationSchema.safeParse(qualification).success).toBe(true);
    expect(caseAdmissionQualificationSchema.safeParse({ ...qualification, requests: [{ ...widget[0], provenance: { ...widget[0]!.provenance, blockId: "Not A Block" } }] }).success).toBe(false);
    mail(OTHER_TEXT, OTHER_SUBJECT);
    expect(await evidence([ACCESS_RULE, WIDGET_RULE])).toEqual([]);
    // A configured rule whose block has no detector in this build (the production registry) never stops Access.
    mail(LOGIN_TEXT, LOGIN_SUBJECT);
    expect(await evidence([ACCESS_RULE, WIDGET_RULE], SAV_CASE_BLOCK_REGISTRY)).toMatchObject([{ family: "access", provenance: { ruleId: "rule-syn-access" } }]);
    // Before blocks, a second `support` rule of another family admitted nobody, Access included; it is now ignored.
    expect(await evidence([ACCESS_RULE, { ...WIDGET_RULE, blockId: undefined }], SAV_CASE_BLOCK_REGISTRY)).toMatchObject([{ family: "access" }]);
  });

  it("(c) a mail two rules claim (two blocks, or Access configured twice) is not admitted, with a closed reason", async () => {
    const greedy: CaseBlockDetector = { blockId: "syn-greedy", family: "usage", firstRequest: text => /connexion/i.test(text) };
    const greedyRule: CaseEntryRule = { ...WIDGET_RULE, ruleId: "rule-syn-greedy", blockId: "syn-greedy" };
    const registry = [...SAV_CASE_BLOCK_REGISTRY, greedy];
    expect(selectCaseBlockRule(caseBlockCandidates([ACCESS_RULE, greedyRule], registry), LOGIN_TEXT, LOGIN_SUBJECT)).toEqual({ reason: "ambiguous_block", blockIds: ["access", "syn-greedy"] });
    expect(selectCaseBlockRule(caseBlockCandidates([ACCESS_RULE, { ...ACCESS_RULE, ruleId: "rule-syn-access-2" }], registry), LOGIN_TEXT, LOGIN_SUBJECT)).toEqual({ reason: "ambiguous_block", blockIds: ["access"] });
    expect(selectCaseBlockRule(caseBlockCandidates([ACCESS_RULE, greedyRule], registry), OTHER_TEXT, OTHER_SUBJECT)).toEqual({ reason: "no_block_match", blockIds: [] });
    expect(selectCaseBlockRule(caseBlockCandidates([WIDGET_RULE], SAV_CASE_BLOCK_REGISTRY), WIDGET_TEXT, WIDGET_SUBJECT)).toEqual({ reason: "no_block_rule", blockIds: [] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mail(LOGIN_TEXT, LOGIN_SUBJECT);
    expect(await evidence([ACCESS_RULE, greedyRule], registry)).toEqual([]);
    expect(logged).toHaveBeenCalledWith("sav_v2_entry_block_ambiguous", { messageId: "message-syn", blockIds: ["access", "syn-greedy"] });
  });
});

describe("a request's block comes from the admission that recorded it, never guessed", () => {
  const snapshot = (requests: Array<{ id: string; family: "access" | "usage"; blockId?: string; status?: "open" | "resolved" }>) => ({
    body: { openRequests: requests.map(row => ({ id: row.id, family: row.family, status: row.status ?? "open" })) },
    admission: { qualification: { requests: requests.map(row => ({ requestId: row.id, family: row.family,
      provenance: { kind: "qualified_rule", ruleId: "rule-syn", revision: "r1", at: AT, ...(row.blockId ? { blockId: row.blockId } : {}) } })) } },
  }) as unknown as CaseSnapshot;
  it("access is Access's; another family needs the block its rule recorded; mixed or unnamed is no single block", () => {
    expect(caseOpenBlockId(snapshot([{ id: "r1", family: "access" }]))).toBe("access");
    expect(caseOpenBlockId(snapshot([{ id: "r1", family: "usage", blockId: "syn-widget" }]))).toBe("syn-widget");
    expect(caseOpenBlockId(snapshot([{ id: "r1", family: "usage" }]))).toBeNull();
    expect(caseOpenBlockId(snapshot([{ id: "r1", family: "access" }, { id: "r2", family: "usage", blockId: "syn-widget" }]))).toBeNull();
    expect(caseOpenBlockId(snapshot([{ id: "r1", family: "access", status: "resolved" }, { id: "r2", family: "usage", blockId: "syn-widget" }]))).toBe("syn-widget");
    expect(caseOpenBlockId(snapshot([]))).toBeNull();
    expect(caseRequestBlockId({ admission: null }, { id: "r1", family: "usage" })).toBeNull();
  });
});

describe("(d) scopes per block: the legacy Access datum alone works unchanged; a second block's scope never changes Access", () => {
  const accessScope = { schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: POLICY_REVISION, revision: "scope-syn-access-r1", family: "access",
    sources: [{ knowledgeId: "k-syn-login", contentVersionId: "k-syn-login-v1", use: "answer", firstReply: "login_code_steps" }] };
  const widgetScope = { schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId: "syn-widget", family: "usage", policyRevision: POLICY_REVISION, revision: "scope-syn-widget-r1",
    sources: [{ knowledgeId: "k-syn-widget", contentVersionId: "k-syn-widget-v1", use: "answer", firstReply: "procedure_steps" }] };
  const port = (values: Record<string, string | undefined>) => caseAccessScopeConfigReader(() => values);
  const read = (values: Record<string, string | undefined>, blockId?: string) => readCaseAccessScope(port(values), POLICY_REVISION, blockId);
  const legacy = { [SAV_V2_ACCESS_SCOPE_ENV]: JSON.stringify(accessScope) };

  it("legacy only: the same raw value as before, Access read as before, no other block has a scope", async () => {
    expect(await port(legacy)()).toEqual(accessScope);
    expect(await read(legacy)).toEqual({ ok: true, scope: accessScope });
    expect(await read(legacy)).toEqual(parseCaseAccessScope(accessScope, POLICY_REVISION));
    expect(await read(legacy, "syn-widget")).toEqual({ ok: false, problem: "scope_missing" });
  });

  it("with a block list: Access identical, the block reads its own entry; a broken list or entry voids that block only", async () => {
    const both = { ...legacy, [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([widgetScope]) };
    expect(await read(both)).toEqual(await read(legacy));
    expect(await read(both, "syn-widget")).toEqual({ ok: true, scope: widgetScope });
    for (const broken of ["{not json", " ".repeat(140_000) + "[]"]) {
      expect(await read({ ...legacy, [SAV_V2_BLOCK_SCOPES_ENV]: broken })).toEqual(await read(legacy));
      expect(await read({ ...legacy, [SAV_V2_BLOCK_SCOPES_ENV]: broken }, "syn-widget")).toEqual({ ok: false, problem: "scope_unreadable" });
    }
    const invalid = (entry: unknown) => read({ ...legacy, [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([entry, { ...widgetScope, blockId: "syn-other" }]) }, "syn-widget");
    // Another block may not take Access's family nor its login template; one source twice, an unknown field or a missing schema is no scope.
    for (const bad of [{ ...widgetScope, family: "access" }, { ...widgetScope, sources: [{ ...widgetScope.sources[0], firstReply: "login_code_steps" }] },
      { ...widgetScope, sources: [widgetScope.sources[0], widgetScope.sources[0]] }, { ...widgetScope, extra: true }, { ...widgetScope, schema: SAV_CASE_ACCESS_SCOPE_REVISION }])
      expect(await invalid(bad)).toEqual({ ok: false, problem: "scope_invalid" });
    expect(await read({ ...legacy, [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([widgetScope, widgetScope]) }, "syn-widget")).toEqual({ ok: false, problem: "scope_invalid" });
    expect(await read({ ...legacy, [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([{ ...widgetScope, policyRevision: "policy-other" }]) }, "syn-widget")).toEqual({ ok: false, problem: "scope_policy_mismatch" });
    expect(await read({ ...legacy, [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify({ scopes: [widgetScope] }) }, "syn-widget")).toEqual({ ok: false, problem: "scope_invalid" });
    // A configured datum shaped like the internal bundle is only a datum: Access's schema refuses it, and it gives no block a scope.
    const forged = JSON.stringify({ bundle: "sav-case-block-scopes-bundle-2026-11-11.v1", access: { state: "read", value: accessScope }, blocks: { state: "read", value: [widgetScope] } });
    expect(await read({ [SAV_V2_ACCESS_SCOPE_ENV]: forged })).toEqual({ ok: false, problem: "scope_invalid" });
    expect(await read({ [SAV_V2_ACCESS_SCOPE_ENV]: forged }, "syn-widget")).toEqual({ ok: false, problem: "scope_missing" });
    // Access is configured by its own datum only: an `access` entry of the list is never read, for Access or as a block.
    const hijack = { ...accessScope, schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId: "access", revision: "scope-hijack" };
    expect(await read({ ...legacy, [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([hijack, widgetScope]) })).toEqual(await read(legacy));
    expect(await read({ [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([hijack, widgetScope]) })).toEqual({ ok: false, problem: "scope_missing" });
    // A broken Access datum voids Access, not the other block.
    expect(await read({ [SAV_V2_ACCESS_SCOPE_ENV]: "{not json", [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([widgetScope]) })).toEqual({ ok: false, problem: "scope_unreadable" });
    expect(await read({ [SAV_V2_ACCESS_SCOPE_ENV]: "{not json", [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([widgetScope]) }, "syn-widget")).toEqual({ ok: true, scope: widgetScope });
  });

  it("a verdict's stamp names its block (Access's stamp is unchanged); a stamp of another block is never current for this one", () => {
    expect(caseAccessScopeStamp(accessScope as never)).toEqual({ revision: "scope-syn-access-r1", policyRevision: POLICY_REVISION });
    const widgetStamp = caseAccessScopeStamp(widgetScope as never);
    expect(widgetStamp).toEqual({ revision: "scope-syn-widget-r1", policyRevision: POLICY_REVISION, blockId: "syn-widget" });
    expect(caseAccessScopeStampProblem(widgetStamp, widgetStamp)).toBeNull();
    expect(caseAccessScopeStampProblem({ ...widgetStamp, blockId: undefined }, widgetStamp)).toBe("access_scope_changed");
    expect(caseAccessScopeStampProblem(widgetStamp, { ...widgetStamp, blockId: "syn-other" })).toBe("access_scope_changed");
  });
});

describe("(e, validator) a block's requests are checked against ITS scope; a block with no scope is refused", () => {
  const card = { id: "k-syn-widget", contentVersionId: "k-syn-widget-v1", title: "Fiche widget", content: "Procédure synthétique.", source: "fixture", verifiedAt: new Date(Date.now() - 86_400_000).toISOString(),
    semanticScore: null, resolution: { steps: ["Étape synthétique"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
  const ref = { knowledgeId: card.id, contentVersionId: card.contentVersionId };
  const scope: CaseBlockScope = { schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId: "syn-widget", family: "usage", policyRevision: POLICY_REVISION, revision: "scope-syn-widget-r1", sources: [{ ...ref, use: "answer" }] };
  const context = (accessScope: CaseDecisionValidationContext["accessScope"]): CaseDecisionValidationContext => ({ caseId: "case-syn", caseVersion: 3, owner: "agent", admission: { admitted: true },
    locale: "fr-FR", audience: "support", sensitiveCategories: [], requests: [{ id: "r1", family: "usage", status: "open" }],
    sources: [{ ref: { type: "email", id: "m1" }, direction: "customer_inbound", at: "2026-11-11T08:00:00Z", order: 1 }], customerTexts: {},
    facts: [], questions: [], trials: [], handoffs: [], knowledge: [card], accessScope });
  const proposal = (family: string) => ({ caseVersion: 3, understanding: { requests: [{ id: "r1", summary: "Configurer le widget.", family, status: "open" }], newFacts: [] },
    nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Suivre la fiche citée.", knowledge: ref }], expectedResult: "Le widget est configuré." },
    reply: { text: "Bonjour, suivez la fiche.", citations: [ref], impossibilityClaims: [], accountAdvice: "none" } });
  const codes = (result: ReturnType<typeof validateCaseDecision>) => result.outcome === "needs_review" ? result.rejections.map(row => [row.code, row.path, row.detail]) : [];

  it("under its own scope a block's answer is accepted; moved to `access` it leaves the scope", () => {
    expect(validateCaseDecision(proposal("usage"), context(scope), new Date()).outcome).toBe("accepted");
    expect(codes(validateCaseDecision(proposal("access"), context(scope), new Date()))).toContainEqual(["pilot_family_out_of_scope", "understanding.requests.0.family", "access"]);
  });
  it("with no scope (the pilot wired, none for this block) the same answer is refused, as before blocks", () => {
    const refused = codes(validateCaseDecision(proposal("usage"), context(null), new Date()));
    expect(refused).toContainEqual(["pilot_family_out_of_scope", "understanding.requests.0.family", "usage"]);
    expect(refused).toContainEqual(["access_scope_missing", "nextAction.steps.0.knowledge", card.id]);
  });
});

describe("(f) auto approval stays Access's only", () => {
  it("a block of any other family never qualifies, whatever its scope says", () => {
    const config = readAccessAutoApprovalConfig({ SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-0000000000aa" });
    const facts = { case: { owner: "agent", sensitivity: "none", admitted: true }, openFamilies: ["access"], ownerNow: "v2",
      decision: { accepted: true, scopeCurrent: true, shownSourcesVerified: true, nextAction: "answer" } } as const;
    const decide = (openFamilies: string[]) => decideAccessAutoApproval({ config, action: "approve", approverId: "30000000-0000-4000-8000-0000000000aa", purpose: "answer", facts: { ...facts, openFamilies } });
    expect(decide(["access"]).allowed).toBe(true);
    expect(decide(["usage"])).toEqual({ allowed: false, reason: "not_access_only" });
    expect(decide(["access", "usage"])).toEqual({ allowed: false, reason: "not_access_only" });
    expect(readAccessAutoApprovalConfig({ SAV_V2_AUTO_REPLY: "syn-widget", SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-0000000000aa" })).toEqual({ mode: "off", why: "disabled" });
  });
});
