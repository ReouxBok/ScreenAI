import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ message: null as null | { body: string; subject: string; receivedAt: Date }, reads: 0 }));
// The entry reads one stored mail; nothing else of the database is reachable from this file.
vi.mock("@/db", () => ({ requireDb: () => ({ select: () => ({ from: () => ({ where: async () => { state.reads += 1; return state.message ? [state.message] : []; } }) }) }) }));
import { encryptSavPayload } from "../crypto";
import { firstFollowupRequest } from "../blocks/followups-decision";
import { SAV_FOLLOWUPS_TEST_PHRASES } from "../blocks/followups-phrases";
import { caseBlockCandidates, selectCaseBlockRule, type CaseEntryRule } from "./case-blocks";
import { SAV_CASE_BLOCK_REGISTRY, SAV_CASE_FOLLOWUPS_BLOCK_DETECTOR, SAV_CASE_FOLLOWUPS_BLOCK_SWITCH, savCaseBlockRegistry, savFollowupsBlockRegistered } from "./case-block-registry";
import { SAV_CASE_BLOCK_SCOPE_REVISION } from "./investigation-access-scope";
import { SAV_V2_BLOCK_SCOPES_ENV } from "./investigation-pilot-readers";
import { firstPersonalLoginRequest } from "./investigation-return-qualify";
import { firstBlockEvidence } from "./v2-entry";

/*
 * SAV-92, followups block registration (SYN only): ONE switch, `SAV_V2_FOLLOWUPS_BLOCK=on`. Off (absent or any other value) the live registry is the
 * very same Access-only registry as before; on, the followups detector is added and the block is still admitted only by an approved rule with a valid scope.
 */
const AT = "2026-11-16T09:00:00.000Z", POLICY_REVISION = "policy-syn-followups-r1";
const ACCESS_RULE: CaseEntryRule = { ruleId: "rule-syn-access", revision: "r1", v1Kind: "support", family: "access", at: AT };
const FOLLOWUPS_RULE: CaseEntryRule = { ruleId: "rule-syn-followups", revision: "r1", v1Kind: "support", family: "usage", at: AT, blockId: "followups" };
const POLICY = { revision: POLICY_REVISION, admittedFamilies: ["access", "usage"], approvedBy: "20000000-0000-4000-8000-000000000012", approvedAt: AT,
  qualifiedRules: [{ ruleId: "rule-syn-access", revision: "r1", families: ["access"] }, { ruleId: "rule-syn-followups", revision: "r1", families: ["usage"], blockId: "followups" }] };
const SCOPE = { schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId: "followups", family: "usage", policyRevision: POLICY_REVISION, revision: "scope-syn-followups-r1",
  sources: [{ knowledgeId: "k-syn-followups", contentVersionId: "k-syn-followups-v1", use: "answer" }] };
const CONFIG = { SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([ACCESS_RULE, FOLLOWUPS_RULE]),
  SAV_V2_ADMISSION_POLICY_JSON: JSON.stringify({ policy: POLICY, validFrom: "2025-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" }),
  [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([SCOPE]) };
const ON = { [SAV_CASE_FOLLOWUPS_BLOCK_SWITCH]: "on" };
const request = [{ requestId: "gm-syn/r1", kind: "support" }] as Parameters<typeof firstBlockEvidence>[3];
const mail = (text: string, subject: string) => { state.message = { body: encryptSavPayload({ text }), subject, receivedAt: new Date(AT) }; };
// No registry argument: the entry's default is the live registry of this environment.
const evidence = (env: Record<string, string>) => firstBlockEvidence(env, "message-syn", "gm-syn", request);

beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "followups-registry-key-32-chars!!!!"); state.message = null; state.reads = 0; });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the followups switch: absent or anything but `on` is off, identical to main", () => {
  it.each([[{}], [{ SAV_V2_FOLLOWUPS_BLOCK: "" }], [{ SAV_V2_FOLLOWUPS_BLOCK: "ON" }], [{ SAV_V2_FOLLOWUPS_BLOCK: "true" }], [{ SAV_V2_FOLLOWUPS_BLOCK: " on" }],
    [{ SAV_V2_FOLLOWUPS_BLOCK: "followups" }], [{ ...CONFIG }]])("off: %j", env => {
    expect(SAV_CASE_FOLLOWUPS_BLOCK_SWITCH).toBe("SAV_V2_FOLLOWUPS_BLOCK");
    expect(savFollowupsBlockRegistered(env)).toBe(false);
    expect(savCaseBlockRegistry(env)).toBe(SAV_CASE_BLOCK_REGISTRY);
    expect(SAV_CASE_BLOCK_REGISTRY.map(block => [block.blockId, block.family])).toEqual([["access", "access"]]);
    expect(caseBlockCandidates([ACCESS_RULE, FOLLOWUPS_RULE], savCaseBlockRegistry(env)).map(row => row.block.blockId)).toEqual(["access"]);
  });

  it("on: Access first and unchanged, then the followups detector of the family `usage`", () => {
    const registry = savCaseBlockRegistry(ON);
    expect(registry.map(block => [block.blockId, block.family])).toEqual([["access", "access"], ["followups", "usage"]]);
    expect(registry[0]).toBe(SAV_CASE_BLOCK_REGISTRY[0]);
    expect(registry[0]!.firstRequest).toBe(firstPersonalLoginRequest);
    expect(registry[1]).toBe(SAV_CASE_FOLLOWUPS_BLOCK_DETECTOR);
    expect(Object.isFrozen(registry) && Object.isFrozen(SAV_CASE_BLOCK_REGISTRY)).toBe(true);
    expect(caseBlockCandidates([ACCESS_RULE, FOLLOWUPS_RULE], registry).map(row => [row.rule.ruleId, row.block.blockId])).toEqual([["rule-syn-access", "access"], ["rule-syn-followups", "followups"]]);
    // A followups rule of another family, or one claiming `access`, is never a candidate.
    expect(caseBlockCandidates([{ ...FOLLOWUPS_RULE, family: "access" }, { ...FOLLOWUPS_RULE, family: "technical" }], registry)).toEqual([]);
  });
});

describe("the followups detector: a bare acknowledgement or waiting mail only, never Access's", () => {
  it.each(SAV_FOLLOWUPS_TEST_PHRASES)("$id [$kind]: $text", row => {
    // Positives are exactly the bare acknowledgement / waiting phrases; every trap and neighbour is refused.
    expect(firstFollowupRequest(row.text, "")).toBe(row.kind === "positive");
    // Never two blocks for one mail: Access and followups never both claim it.
    const registry = savCaseBlockRegistry(ON);
    expect(selectCaseBlockRule(caseBlockCandidates([ACCESS_RULE, FOLLOWUPS_RULE], registry), row.text, "").reason).not.toBe("ambiguous_block");
  });

  it("a sensitive subject, a suffix or a signature stops it", () => {
    expect(firstFollowupRequest("Merci.", "Résiliation")).toBe(false);
    expect(firstFollowupRequest("Merci.", "Facture")).toBe(false);
    expect(firstFollowupRequest("Merci.\nCordialement", "")).toBe(false);
    expect(firstFollowupRequest("Merci. Autre question ?", "")).toBe(false);
    expect(firstFollowupRequest("Merci.", "Re: votre demande")).toBe(true);
  });
});

describe("entry with the live registry (no registry argument)", () => {
  it("off: a thank-you with a full followups configuration admits nobody, exactly as main", async () => {
    mail("Merci beaucoup.", "Re: votre demande");
    expect(await evidence(CONFIG)).toEqual([]);
    // Access is admitted exactly as before.
    mail("Bonjour, je ne reçois pas le code de connexion à mon compte.", "Connexion impossible");
    expect(await evidence(CONFIG)).toEqual([{ requestId: "gm-syn/r1", family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-syn-access", revision: "r1", at: AT } }]);
  });

  it("on: a bare thank-you is the followups block's (blockId recorded); a thank-you with a request is nobody's; Access unchanged", async () => {
    mail("Merci beaucoup.", "Re: votre demande");
    expect(await evidence({ ...CONFIG, ...ON })).toEqual([{ requestId: "gm-syn/r1", family: "usage",
      provenance: { kind: "qualified_rule", ruleId: "rule-syn-followups", revision: "r1", at: AT, blockId: "followups" } }]);
    mail("Merci, et sinon comment exporter mes documents ?", "Re: votre demande");
    expect(await evidence({ ...CONFIG, ...ON })).toEqual([]);
    mail("Bonjour, je ne reçois pas le code de connexion à mon compte.", "Connexion impossible");
    expect(await evidence({ ...CONFIG, ...ON })).toMatchObject([{ family: "access", provenance: { ruleId: "rule-syn-access" } }]);
  });

  it("on, but without its approved rule or without its scope: nobody is admitted", async () => {
    mail("Merci beaucoup.", "Re: votre demande");
    expect(await evidence({ ...CONFIG, ...ON, SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([ACCESS_RULE]) })).toEqual([]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await evidence({ ...CONFIG, ...ON, [SAV_V2_BLOCK_SCOPES_ENV]: "[]" })).toEqual([]);
    expect(logged).toHaveBeenCalledWith("sav_v2_entry_block_not_admitted", expect.objectContaining({ blockId: "followups", reason: "block_scope_unavailable" }));
  });
});
