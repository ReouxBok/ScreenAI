import { describe, expect, it } from "vitest";
import type { CorpusCase, RequestRoute } from "../../../skills/corpus-contract";
import { lintCorpus } from "../../../skills/corpus-lint";
import { qualificationVerdict, type QualificationCaseResult } from "../../../skills/qualification-verdict";
import type { SkillExample } from "../../../skills/skill-contract";
import { accessSkillKernelHits } from "../../access-skill/access-skill-kernel";
import { CHARLY_MAX_BLIND_SET, charlyMaxBlindSetSha256 } from "./charly-max-blind.fixture";
import { CHARLY_MAX_CORPUS, CHARLY_MAX_CORPUS_MINIMUMS, CHARLY_MAX_TRAIT_MINIMUMS, type CharlyMaxCorpusTrait } from "./charly-max-corpus.fixture";
import { CHARLY_MAX_BLOCK_META } from "./charly-max-manifest";
import { CHARLY_MAX_DECISION_SKILL } from "./charly-max-skill-decision";
import { CHARLY_MAX_ENTRY_SKILL } from "./charly-max-skill-entry";

const EXAMPLES: readonly SkillExample[] = [...CHARLY_MAX_ENTRY_SKILL.examples, ...CHARLY_MAX_DECISION_SKILL.examples];
const BLIND_SHA256 = "94a94e59f03afd3bb5651daa6b742cd64fc528ab22ed666fbc038af2a5abc9a6";
const byId = new Map(CHARLY_MAX_CORPUS.map(row => [row.id, row]));
const asExamples = (cases: readonly CorpusCase[]): SkillExample[] => cases.map(row => ({ id: row.id, subject: row.subject, text: row.text, verdict: "corpus", comment: "corpus" }));

describe("Charly Max, corpus fictif de 300 cas", () => {
  it("le lint N3 est vert : quotas, ids, disjonction avec les exemples des deux skills, aucune donnée réelle", () => {
    expect(lintCorpus({ cases: CHARLY_MAX_CORPUS, examples: EXAMPLES, minimums: CHARLY_MAX_CORPUS_MINIMUMS })).toEqual([]);
  });
  it("300 cas exactement, quotas du gabarit par groupe, textes tous différents", () => {
    expect(CHARLY_MAX_CORPUS.length).toBe(300);
    const counts = Object.fromEntries(Object.keys(CHARLY_MAX_CORPUS_MINIMUMS).map(group => [group, CHARLY_MAX_CORPUS.filter(row => row.group === group).length]));
    expect(counts).toEqual({ positive: 90, trap: 30, neighbour: 90, sensitive: 60, mixed: 30 });
    expect(new Set(CHARLY_MAX_CORPUS.map(row => `${row.subject}\n${row.text}`)).size).toBe(300);
  });
  it("quotas de traits tenus, et beaucoup de suites « Re: »", () => {
    for (const [trait, minimum] of Object.entries(CHARLY_MAX_TRAIT_MINIMUMS)) {
      expect(CHARLY_MAX_CORPUS.filter(row => row.traits.includes(trait as CharlyMaxCorpusTrait)).length, trait).toBeGreaterThanOrEqual(minimum!);
    }
    expect(CHARLY_MAX_CORPUS.filter(row => /^re:/i.test(row.subject)).length).toBeGreaterThanOrEqual(100);
    for (const row of CHARLY_MAX_CORPUS) expect(row.traits.includes("return"), row.id).toBe(row.purpose === "return");
  });
  it("au moins 40 paires proches, réciproques : le côté bloc est admis, le jumeau va à l'équipe ou à un voisin", () => {
    const paired = CHARLY_MAX_CORPUS.filter(row => row.pair);
    expect(paired.length / 2).toBeGreaterThanOrEqual(40);
    for (const row of paired) {
      const twin = byId.get(row.pair!);
      expect(twin?.pair, row.id).toBe(row.id);
      expect(row.expectedPipeline === "admit", row.id).not.toBe(twin!.expectedPipeline === "admit");
    }
    const twinGroups = new Set(paired.filter(row => row.expectedPipeline === "team").map(row => row.subgroup));
    for (const kind of ["access", "collaborators", "integrations", "commercial", "finance", "complaint", "subscription"]) expect(twinGroups.has(kind), kind).toBe(true);
  });
  it("chaque voisin a au moins 5 cas, les incertains et les questions de clarification existent", () => {
    for (const subgroup of ["access", "collaborators", "integrations", "commercial", "other", "unsure", "injection"]) {
      expect(CHARLY_MAX_CORPUS.filter(row => row.group === "neighbour" && row.subgroup === subgroup).length, subgroup).toBeGreaterThanOrEqual(5);
    }
    // « Add a user » without naming the section: the entry never asks (no `clarify` label), the team does.
    expect(CHARLY_MAX_CORPUS.filter(row => row.subgroup === "clarify" && row.requests.every(request => request.expected.kind === "team")).length).toBeGreaterThanOrEqual(4);
    expect(CHARLY_MAX_CORPUS.some(row => row.requests.some(request => request.expected.kind === "clarify"))).toBe(false);
  });
  it("noyau : aucun cas admis n'en contient une phrase ; au moins 20 sensibles en contiennent une", () => {
    for (const row of CHARLY_MAX_CORPUS.filter(item => item.expectedPipeline === "admit")) expect(accessSkillKernelHits(row.subject, row.text), row.id).toEqual([]);
    expect(CHARLY_MAX_CORPUS.filter(row => row.group === "sensitive" && accessSkillKernelHits(row.subject, row.text).length > 0).length).toBeGreaterThanOrEqual(20);
  });
  it("les fils longs dépassent la limite de lecture (12 000 caractères) et portent la demande sensible APRÈS la coupe", () => {
    const long = CHARLY_MAX_CORPUS.filter(row => row.traits.includes("truncated"));
    expect(long.length).toBeGreaterThanOrEqual(10);
    for (const row of long) {
      expect(row.text.length, row.id).toBeGreaterThan(12_000);
      expect(row.text.slice(0, 12_000), row.id).not.toContain("PS :");
      expect(row.requests.some(request => request.expected.kind === "sensitive"), row.id).toBe(true);
      expect(row.expectedPipeline).toBe("team");
    }
  });
  it("règle permanente : tout cas sensible ou mixte avec une demande sensible va à l'équipe, jamais « admis »", () => {
    for (const row of CHARLY_MAX_CORPUS) {
      if (row.group === "sensitive" || row.requests.some(request => request.expected.kind === "sensitive")) expect(row.expectedPipeline, row.id).toBe("team");
      if (row.traits.includes("injection")) expect(row.expectedPipeline, row.id).toBe("team");
    }
    expect(CHARLY_MAX_CORPUS.filter(row => row.expectedPipeline === "admit").length).toBe(120);
  });
});

describe("Charly Max, jeu aveugle gelé (60 cas)", () => {
  it("empreinte épinglée au gel, identique dans le manifeste", () => {
    expect(charlyMaxBlindSetSha256()).toBe(BLIND_SHA256);
    expect(CHARLY_MAX_BLIND_SET.length).toBe(60);
    expect(CHARLY_MAX_BLOCK_META.corpus.blindSetSha256).toBe(BLIND_SHA256);
  });
  it("disjoint des exemples ET du corpus, ids et données conformes (lint N3)", () => {
    expect(lintCorpus({ cases: CHARLY_MAX_BLIND_SET, examples: [...EXAMPLES, ...asExamples(CHARLY_MAX_CORPUS)], minimums: { positive: 18, neighbour: 18, sensitive: 12, mixed: 6, trap: 6 } })).toEqual([]);
    for (const row of CHARLY_MAX_BLIND_SET) expect(byId.has(row.id), row.id).toBe(false);
  });
});

// Scripted doubles (no model): the verdict must accept an honest router and refuse a lax one.
const honest = (row: CorpusCase): QualificationCaseResult => {
  const sensitive = row.group === "sensitive" || row.requests.some(request => request.expected.kind === "sensitive");
  return { caseId: row.id, status: "complete", requests: row.requests.map(({ requestId, expected }) => ({ requestId, route: sensitive || expected.kind === "sensitive" ? { kind: "team" } : expected as RequestRoute })) };
};
const charly: RequestRoute = { kind: "block", blockId: "charly_max" };

describe("Charly Max, verdict de qualification N3 sur doubles scriptés", () => {
  it.each([["corpus", CHARLY_MAX_CORPUS], ["jeu aveugle", CHARLY_MAX_BLIND_SET]] as const)("%s : un routeur honnête passe (0 sensible, voisins 100 %, rappel 100 %)", (_name, cases) => {
    const verdict = qualificationVerdict({ blockId: "charly_max", cases, results: cases.map(honest), budgetExhausted: false });
    expect(verdict).toMatchObject({ status: "pass", complete: true, sensitive: { admitted: 0 } });
    expect(verdict.neighbourRouting.hits).toBe(verdict.neighbourRouting.total);
    expect(verdict.blockRecall.hits).toBe(verdict.blockRecall.total);
  });
  it("un routeur qui admet tous les voisins dans Charly Max échoue", () => {
    const results = CHARLY_MAX_CORPUS.map(row => row.group === "neighbour" ? { ...honest(row), requests: row.requests.map(({ requestId }) => ({ requestId, route: charly })) } : honest(row));
    const verdict = qualificationVerdict({ blockId: "charly_max", cases: CHARLY_MAX_CORPUS, results, budgetExhausted: false });
    expect(verdict.status).toBe("fail");
    expect(verdict.neighbourRouting.hits).toBe(0);
  });
  it("un routeur qui admet un seul cas sensible échoue, même s'il s'arrête avant la fin", () => {
    const target = CHARLY_MAX_CORPUS.find(row => row.traits.includes("truncated"))!;
    const results = CHARLY_MAX_CORPUS.slice(0, 50).map(honest).concat([{ caseId: target.id, status: "complete", requests: target.requests.map(({ requestId }) => ({ requestId, route: charly })) }]);
    const verdict = qualificationVerdict({ blockId: "charly_max", cases: CHARLY_MAX_CORPUS, results, budgetExhausted: true });
    expect(verdict.status).toBe("fail");
    expect(verdict.sensitive.admittedCaseIds).toEqual([target.id]);
  });
  it("un routeur qui renvoie tout à l'équipe échoue sur le rappel", () => {
    const results = CHARLY_MAX_CORPUS.map(row => ({ caseId: row.id, status: "complete" as const, requests: row.requests.map(({ requestId }) => ({ requestId, route: { kind: "team" } as RequestRoute })) }));
    expect(qualificationVerdict({ blockId: "charly_max", cases: CHARLY_MAX_CORPUS, results, budgetExhausted: false })).toMatchObject({ status: "fail", blockRecall: { hits: 0 } });
  });
});
