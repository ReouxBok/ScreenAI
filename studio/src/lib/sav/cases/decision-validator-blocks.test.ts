import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaseDecisionValidationContext } from "./decision-contract";
import { validateCaseDecision } from "./decision-validator";
import { accessLoginCodeFirstReply } from "./decision-validator-access";
import { caseBlockResolutionProof, SAV_CASE_ACCESS_RESOLUTION_PROOF, SAV_CASE_BLOCK_RESOLUTION_PROOFS, type CaseBlockResolutionProof } from "./case-block-resolution";
import { SAV_CASE_ACCESS_SCOPE_REVISION, SAV_CASE_BLOCK_SCOPE_REVISION, type CaseBlockScope } from "./investigation-access-scope";
import { SAV_CASE_ACCESS_URL } from "./decision-contract";

/*
 * 19/11, the validator per block (synthetic data only). A block other than Access (`syn-widget`, family `usage`) decided under its own scope:
 *   - is supported only by `answer` sources of ITS scope at the exact version; an `orient_only` source only orients;
 *   - never closes a request without the resolution proof the block declares (`case-block-resolution.ts`): none today, so no automatic closure;
 *   - has the kernel applied to OUR reply, whatever the Access skill switch says.
 * Access keeps its own rules, moved verbatim to `decision-validator-access.ts`; its decisions are unchanged.
 */
const now = new Date("2026-11-19T12:00:00Z");
const card = (id: string, version = `${id}-v1`) => ({ id, contentVersionId: version, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture",
  verifiedAt: "2026-11-01T00:00:00Z", semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } });
const ref = (id: string, version = `${id}-v1`) => ({ knowledgeId: id, contentVersionId: version });
const widgetScope: CaseBlockScope = { schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId: "syn-widget", family: "usage", policyRevision: "p1", revision: "scope-widget-r1",
  sources: [{ ...ref("k-answer"), use: "answer" }, { ...ref("k-orient"), use: "orient_only" }] };
const accessScope = { schema: SAV_CASE_ACCESS_SCOPE_REVISION, family: "access", policyRevision: "p1", revision: "scope-access-r1",
  sources: [{ ...ref("k-answer"), use: "answer" }] } as unknown as CaseDecisionValidationContext["accessScope"];
type Ctx = CaseDecisionValidationContext;
function context(patch: Partial<Ctx> & { latest?: string; family?: string } = {}): Ctx {
  const { latest = "Bonjour, le widget fonctionne maintenant, merci.", family = "usage", ...rest } = patch;
  return { caseId: "case-syn", caseVersion: 3, owner: "agent", admission: { admitted: true }, locale: "fr-FR", audience: "support", sensitiveCategories: [],
    requests: [{ id: "r1", family: family as Ctx["requests"][number]["family"], status: "open" }],
    sources: [{ ref: { type: "email", id: "m1" }, direction: "customer_inbound", at: "2026-11-18T08:00:00Z", order: 1 },
      { ref: { type: "email", id: "m2" }, direction: "customer_inbound", at: "2026-11-19T08:00:00Z", order: 2 }],
    customerTexts: { "email:m1": "Bonjour, je n'arrive pas à régler le widget.", "email:m2": latest },
    facts: [], questions: [], trials: [], handoffs: [], knowledge: [card("k-answer"), card("k-orient"), card("k-other")], accessScope: widgetScope, ...rest };
}
const understanding = (family = "usage") => ({ requests: [{ id: "r1", summary: "Régler le widget.", family, status: "open" }], newFacts: [] });
const answer = (source = ref("k-answer"), text = "Bonjour, suivez la fiche citée.", family = "usage") => ({ caseVersion: 3, understanding: understanding(family),
  nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Suivre la fiche citée.", knowledge: source }], expectedResult: "Le widget est réglé." },
  reply: { text, citations: [source], impossibilityClaims: [], accountAdvice: "none" } });
const confirm = (quote: string, source = "m2", family = "usage") => ({ caseVersion: 3, understanding: understanding(family),
  nextAction: { kind: "confirm_resolution", requestIds: ["r1"], evidence: [{ requestId: "r1", source: { type: "email", id: source }, trialId: null, quote }] } });
const rejections = (input: unknown, ctx: Ctx) => {
  const result = validateCaseDecision(input, ctx, now);
  return result.outcome === "needs_review" ? result.rejections.map(row => [row.code, row.detail ?? null]) : [];
};

afterEach(() => vi.unstubAllEnvs());

describe("a block's sources: `answer` of ITS scope at the exact version; `orient_only` only orients", () => {
  it("an `answer` source of the block's scope at its version supports the reply", () => {
    expect(validateCaseDecision(answer(), context(), now).outcome).toBe("accepted");
  });
  it("another version, an `orient_only` source, or a source the scope does not list are refused", () => {
    expect(rejections(answer(ref("k-answer", "k-answer-v2")), context({ knowledge: [card("k-answer", "k-answer-v2")] }))).toContainEqual(["access_source_version_out_of_scope", "k-answer"]);
    expect(rejections(answer(ref("k-orient")), context())).toContainEqual(["access_source_orient_only", "k-orient"]);
    expect(rejections(answer(ref("k-other")), context())).toContainEqual(["access_source_out_of_scope", "k-other"]);
  });
});

describe("closing a block's request needs the proof the block declares", () => {
  it("a block without a declared proof never closes, even on a clear statement in the customer's latest mail", () => {
    expect(caseBlockResolutionProof("syn-widget")).toBeNull();
    expect(rejections(confirm("le widget fonctionne maintenant"), context())).toContainEqual(["resolution_evidence_invalid", "block_resolution_proof_missing"]);
  });
  it("Access's proof is the first entry, found once; a double declaration is ambiguous, never guessed", () => {
    expect(SAV_CASE_BLOCK_RESOLUTION_PROOFS).toEqual([SAV_CASE_ACCESS_RESOLUTION_PROOF]);
    expect(caseBlockResolutionProof("access")).toBe(SAV_CASE_ACCESS_RESOLUTION_PROOF);
    const twice: CaseBlockResolutionProof[] = [SAV_CASE_ACCESS_RESOLUTION_PROOF, { ...SAV_CASE_ACCESS_RESOLUTION_PROOF, id: "other" }];
    expect(caseBlockResolutionProof("access", twice)).toBeNull();
  });
  it("Access unchanged: closed on the customer's latest statement that the access works again; a thanks alone or an older mail is refused", () => {
    const access = (latest: string) => context({ family: "access", latest, accessScope });
    expect(rejections(confirm("Je peux de nouveau utiliser Limova", "m2", "access"), access("Je peux de nouveau utiliser Limova. Merci !"))).toEqual([]);
    expect(rejections(confirm("merci", "m2", "access"), access("Merci !"))).toContainEqual(["resolution_evidence_invalid", "latest_customer_login_not_confirmed"]);
    const older = context({ family: "access", accessScope, customerTexts: { "email:m1": "Je peux de nouveau utiliser Limova.", "email:m2": "Et pour le widget ?" } });
    expect(rejections(confirm("Je peux de nouveau utiliser Limova", "m1", "access"), older).map(row => row[0])).toContain("resolution_evidence_invalid");
  });
});

describe("« le noyau dans notre réponse » for a block other than Access", () => {
  const kernelText = "Bonjour, pour résilier votre abonnement, suivez la fiche citée.";
  it("a kernel phrase in our reply for a block other than Access is refused, Access skill switch off", () => {
    vi.stubEnv("SAV_V2_ACCESS_SKILL", "off");
    expect(rejections(answer(ref("k-answer"), kernelText), context()).map(row => row[0])).toContain("reply_sensitive_wording");
  });
  it("Access with its skill switch off is judged as before (the kernel is its switch's)", () => {
    vi.stubEnv("SAV_V2_ACCESS_SKILL", "off");
    expect(rejections(answer(ref("k-answer"), kernelText, "access"), context({ family: "access", accessScope })).map(row => row[0])).not.toContain("reply_sensitive_wording");
  });
});

describe("Access's own rules live apart", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  it("the login address is data (no URL written in the generic validator); the code-first login template is the Access module's", () => {
    const generic = readFileSync(path.join(dir, "decision-validator.ts"), "utf8");
    expect(generic).not.toMatch(/https?:\/\//);
    expect(generic).toContain("accessLoginCodeFirstReply({ url: SAV_CASE_ACCESS_URL");
    const reply = accessLoginCodeFirstReply({ url: SAV_CASE_ACCESS_URL, spamAdvice: false });
    expect(reply).toContain(SAV_CASE_ACCESS_URL);
    expect(accessLoginCodeFirstReply({ url: "https://exemple.invalid/connexion", spamAdvice: true })).toContain("https://exemple.invalid/connexion");
  });
});
