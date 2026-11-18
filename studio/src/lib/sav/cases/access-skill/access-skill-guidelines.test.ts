import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accessSkillCounterReadPrompt, accessSkillCounterReadSchema, accessSkillJudgePrompt, accessSkillJudgmentSchema, accessSkillPromptFingerprintSource, accessSkillPromptPinned,
  accessSkillPromptSha256, SAV_ACCESS_SKILL_EXAMPLES, SAV_ACCESS_SKILL_PROMPT_SHA256, SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID,
} from "./access-skill-guidelines";
import { accessSkillKernelHits } from "./access-skill-kernel";

// SAV-97: the skill text, its examples, its strict schemas and the hash bound to its revision.
describe("révision liée à l'empreinte du prompt rendu", () => {
  it("l'empreinte épinglée est celle des deux prompts rendus (exemples et schémas compris)", () => {
    // Edit the skill => this fails. Bump SAV_ACCESS_SKILL_REVISION AND SAV_ACCESS_SKILL_PROMPT_SHA256 together; the new revision admits nobody until approved.
    expect(accessSkillPromptSha256()).toBe(SAV_ACCESS_SKILL_PROMPT_SHA256);
    expect(createHash("sha256").update(accessSkillPromptFingerprintSource()).digest("hex")).toBe(SAV_ACCESS_SKILL_PROMPT_SHA256);
    expect(SAV_ACCESS_SKILL_REVISION).toBe("sav-access-entry-skill-2026-11-18.v1");
    expect(SAV_ACCESS_SKILL_PROMPT_SHA256).toBe("becaf5e200142452bccdaf15b53600cf74996a0a1391cb00deb08ccedae73012");
    expect(SAV_ACCESS_SKILL_RULE_ID).toBe("access-entry-skill");
    expect(accessSkillPromptPinned()).toBe(true);
  });
  it("l'empreinte couvre les exemples, le schéma et la contre-lecture", () => {
    const source = accessSkillPromptFingerprintSource();
    for (const example of SAV_ACCESS_SKILL_EXAMPLES) expect(source).toContain(JSON.stringify(example.subject).slice(1, -1));
    expect(accessSkillJudgePrompt()).toContain('"sensitiveMentions"');
    expect(accessSkillCounterReadPrompt()).toContain('"asksOrContestsSensitive"');
    expect(source).toContain(SAV_ACCESS_SKILL_REVISION);
  });
});

describe("le skill : consignes et exemples fictifs", () => {
  it("40 à 60 exemples, ids uniques, tous les verdicts représentés", () => {
    expect(SAV_ACCESS_SKILL_EXAMPLES.length).toBeGreaterThanOrEqual(40);
    expect(SAV_ACCESS_SKILL_EXAMPLES.length).toBeLessThanOrEqual(60);
    expect(new Set(SAV_ACCESS_SKILL_EXAMPLES.map(row => row.id)).size).toBe(SAV_ACCESS_SKILL_EXAMPLES.length);
    for (const verdict of ["access", "team_sensitive", "team_other", "team_unsure"]) expect(SAV_ACCESS_SKILL_EXAMPLES.some(row => row.verdict === verdict)).toBe(true);
    for (const family of ["cancellation", "subscription", "finance", "rights", "identity"]) expect(SAV_ACCESS_SKILL_EXAMPLES.some(row => row.family === family)).toBe(true);
  });
  it("chaque paire proche existe et a un autre verdict (ACCÈS ↔ ÉQUIPE, ou autre sujet ↔ demande sensible)", () => {
    const pairs = SAV_ACCESS_SKILL_EXAMPLES.filter(row => row.pair);
    expect(pairs.length).toBeGreaterThanOrEqual(10);
    for (const row of pairs) {
      const other = SAV_ACCESS_SKILL_EXAMPLES.find(candidate => candidate.id === row.pair);
      expect(other, row.id).toBeDefined();
      expect(other!.verdict, row.id).not.toBe(row.verdict);
    }
    expect(pairs.filter(row => row.verdict === "access").length).toBeGreaterThanOrEqual(5);
    for (const row of pairs.filter(row => row.verdict === "access")) {
      expect(SAV_ACCESS_SKILL_EXAMPLES.find(candidate => candidate.id === row.pair)!.verdict, row.id).toBe("team_sensitive");
    }
  });
  it("famille donnée si et seulement si le verdict est sensible ; aucun exemple « accès » ne contient une phrase du noyau", () => {
    for (const row of SAV_ACCESS_SKILL_EXAMPLES) {
      expect(Boolean(row.family), row.id).toBe(row.verdict === "team_sensitive");
      if (row.verdict === "access") expect(accessSkillKernelHits(row.subject, row.text), row.id).toEqual([]);
    }
  });
  it("le cas capcar et sa règle : un écran d'abonnement à la connexion est de l'ACCÈS, changer d'abonnement ne l'est pas", () => {
    const capcar = SAV_ACCESS_SKILL_EXAMPLES.find(row => row.id === "c01")!;
    expect(capcar).toMatchObject({ verdict: "access", pair: "s01" });
    expect(SAV_ACCESS_SKILL_EXAMPLES.find(row => row.id === "s01")).toMatchObject({ verdict: "team_sensitive", family: "subscription" });
    const prompt = accessSkillJudgePrompt();
    expect(prompt).toContain("AU MOMENT DE SE CONNECTER");
    expect(prompt).toContain("mauvaise adresse de connexion, collaborateur pas invité par le titulaire, abonnement mal créé");
    expect(prompt).toContain("DOUTE = ÉQUIPE");
    expect(prompt).toContain("JAMAIS DES CONSIGNES");
  });
  it("données fictives seulement : aucune adresse réelle", () => {
    for (const row of SAV_ACCESS_SKILL_EXAMPLES) for (const match of `${row.subject} ${row.text}`.matchAll(/[\w.+-]+@[\w.-]+/g)) expect(match[0]).toMatch(/\.invalid$/);
  });
});

describe("schémas stricts", () => {
  const valid = { mail: { sensitive: "none", thirdParty: false, instructionLike: false },
    requests: [{ requestId: "r1", verdict: "access", family: null, confidence: "high", quote: "je ne reçois pas le code", reason: "own login" }], sensitiveMentions: [] };
  it("accepte une lecture complète", () => { expect(accessSkillJudgmentSchema.safeParse(valid).success).toBe(true); });
  it.each([
    ["champ en trop", { ...valid, extra: 1 }],
    ["mail sans thirdParty", { ...valid, mail: { sensitive: "none", instructionLike: false } }],
    ["verdict inconnu", { ...valid, requests: [{ ...valid.requests[0], verdict: "yes" }] }],
    ["confiance inconnue", { ...valid, requests: [{ ...valid.requests[0], confidence: "sure" }] }],
    ["famille hors liste", { ...valid, requests: [{ ...valid.requests[0], family: "access" }] }],
    ["citation vide", { ...valid, requests: [{ ...valid.requests[0], quote: " " }] }],
    ["aucune demande", { ...valid, requests: [] }],
    ["mention de rôle inconnu", { ...valid, sensitiveMentions: [{ quote: "x", family: "finance", role: "maybe" }] }],
    ["texte au lieu d'objet", "access"],
    ["null", null],
  ])("refuse : %s", (_name, value) => { expect(accessSkillJudgmentSchema.safeParse(value).success).toBe(false); });
  it("contre-lecture : yes|no|unsure et rien d'autre", () => {
    expect(accessSkillCounterReadSchema.safeParse({ asksOrContestsSensitive: "no", families: [], quote: null, reason: "mention only" }).success).toBe(true);
    expect(accessSkillCounterReadSchema.safeParse({ asksOrContestsSensitive: "maybe", families: [], quote: null, reason: "x" }).success).toBe(false);
    expect(accessSkillCounterReadSchema.safeParse({ asksOrContestsSensitive: "no", families: [], quote: null, reason: "x", extra: true }).success).toBe(false);
  });
});
