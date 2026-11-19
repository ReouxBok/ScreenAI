import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accessSkillKernelHits } from "../../access-skill/access-skill-kernel";
import type { RequestRoute } from "../../../skills/corpus-contract";
import { lintCorpus } from "../../../skills/corpus-lint";
import { qualificationVerdict, type QualificationCaseResult } from "../../../skills/qualification-verdict";
import type { SkillExample } from "../../../skills/skill-contract";
import { SAV_INTEGRATIONS_EVAL_CASES } from "../../../blocks/integrations-eval-cases";
import { SAV_INTEGRATIONS_BLIND_SET } from "./integrations-blind.fixture";
import { SAV_INTEGRATIONS_CORPUS, SAV_INTEGRATIONS_CORPUS_MINIMUMS, SAV_INTEGRATIONS_TRAIT_MINIMUMS } from "./integrations-corpus.fixture";
import { SAV_INTEGRATIONS_DECISION_SKILL } from "./integrations-decision-skill";
import { SAV_INTEGRATIONS_ENTRY_SKILL } from "./integrations-entry-skill";
import { SAV_INTEGRATIONS_MANIFEST_DETAILS } from "./integrations-manifest";
import { SAV_INTEGRATIONS_NEIGHBOURS, type IntegrationsCorpusCase } from "./integrations-scope";

/*
 * Block « Intégrations » (V3, 19/11): the 300-case fictional corpus, the frozen blind set, and a deterministic double harness on the N3 verdict
 * (no model, no network, no money): the honest double passes; lying doubles fail exactly where they should.
 */
const C = SAV_INTEGRATIONS_CORPUS;
const EXAMPLES: readonly SkillExample[] = [...SAV_INTEGRATIONS_ENTRY_SKILL.examples, ...SAV_INTEGRATIONS_DECISION_SKILL.examples];
const count = (predicate: (row: IntegrationsCorpusCase) => boolean, rows: readonly IntegrationsCorpusCase[] = C) => rows.filter(predicate).length;
const isAdmitted = (row: IntegrationsCorpusCase) => row.requests.every(request => request.expected.kind === "block" && request.expected.blockId === "integrations");
const isSensitive = (row: IntegrationsCorpusCase) => row.group === "sensitive" || row.requests.some(request => request.expected.kind === "sensitive");

describe("le corpus : 300 cas fictifs, quotas du gabarit, lint N3 vert", () => {
  it("300 cas, quotas de groupes exacts (90 positifs, 60 voisins, 60 sensibles, 30 mixtes, 60 pièges)", () => {
    expect(C).toHaveLength(300);
    for (const [group, minimum] of Object.entries(SAV_INTEGRATIONS_CORPUS_MINIMUMS)) expect(count(row => row.group === group), group).toBe(minimum);
  });
  it("le lint N3 ne trouve rien : ids, données réelles, disjonction avec les exemples des deux skills, quotas", () => {
    expect(lintCorpus({ cases: C, examples: EXAMPLES, minimums: SAV_INTEGRATIONS_CORPUS_MINIMUMS })).toEqual([]);
  });
  it("chaque trait tient son minimum ; un retour est un retour", () => {
    for (const [trait, minimum] of Object.entries(SAV_INTEGRATIONS_TRAIT_MINIMUMS)) expect(count(row => row.traits.includes(trait as never)), trait).toBeGreaterThanOrEqual(minimum);
    expect(count(row => row.purpose === "return")).toBe(count(row => row.traits.includes("return")));
  });
  it("au moins 40 paires proches réciproques : un jumeau admis, l'autre non", () => {
    const paired = C.filter(row => row.pair);
    expect(paired.length / 2).toBeGreaterThanOrEqual(40);
    for (const row of paired) {
      const twin = C.find(candidate => candidate.id === row.pair)!;
      expect(twin.pair, row.id).toBe(row.id);
      expect(isAdmitted(row) !== isAdmitted(twin), row.id).toBe(true);
    }
  });
  it("règle permanente : aucun cas admis ne contient une phrase du noyau ; ≥ 20 sensibles en contiennent une", () => {
    for (const row of C.filter(isAdmitted)) expect(accessSkillKernelHits(row.subject, row.text), row.id).toEqual([]);
    expect(count(row => row.group === "sensitive" && accessSkillKernelHits(row.subject, row.text).length > 0)).toBeGreaterThanOrEqual(20);
  });
  it("10 mails longs : la demande sensible est après 12 000 caractères, et le cas part à l'équipe", () => {
    const long = C.filter(row => row.traits.includes("long_cut"));
    expect(long).toHaveLength(10);
    for (const row of long) {
      expect(row.text.length, row.id).toBeGreaterThan(12_000);
      expect(row.text.lastIndexOf("PS : "), row.id).toBeGreaterThan(12_000);
      expect(isSensitive(row), row.id).toBe(true);
    }
  });
  it("chaque voisin a au moins 5 cas ; les CRM sont couverts ; les 40 cas de la PR #275 sont repris", () => {
    for (const neighbour of SAV_INTEGRATIONS_NEIGHBOURS) expect(count(row => row.neighbour === neighbour), neighbour).toBeGreaterThanOrEqual(5);
    expect(count(row => row.subfamily === "crm")).toBeGreaterThanOrEqual(15);
    for (const row of SAV_INTEGRATIONS_EVAL_CASES) expect(C.find(candidate => candidate.id === `pr-${row.id}`)?.text, row.id).toBe(row.text);
    expect(count(row => row.subfamily === "shopify" && row.expectedDecision === "answer")).toBe(0);
    expect(count(row => row.subfamily === "odoo" && row.expectedDecision === "answer")).toBe(0);
  });
  it("au moins 5 cas incertains volontaires et 10 injections, tous pour l'équipe", () => {
    expect(count(row => row.group === "trap" && !isAdmitted(row) && row.neighbour === null && !row.traits.includes("injection") && !row.traits.includes("negation"))).toBeGreaterThanOrEqual(5);
    for (const row of C.filter(row => row.traits.includes("injection"))) expect(isAdmitted(row), row.id).toBe(false);
  });
});

describe("le jeu aveugle gelé : 60 cas, empreinte épinglée, disjoint des exemples et du corpus", () => {
  it("l'empreinte est celle notée au gel (jamais modifié depuis)", () => {
    expect(SAV_INTEGRATIONS_BLIND_SET).toHaveLength(60);
    expect(createHash("sha256").update(JSON.stringify(SAV_INTEGRATIONS_BLIND_SET)).digest("hex")).toBe(SAV_INTEGRATIONS_MANIFEST_DETAILS.corpus.blindSetSha256);
  });
  it("lint N3 vert et disjoint des exemples ET du corpus", () => {
    const corpusAsExamples: SkillExample[] = C.map(row => ({ id: `corpus-${row.id}`, text: row.text, verdict: "corpus", comment: "corpus" }));
    expect(lintCorpus({ cases: SAV_INTEGRATIONS_BLIND_SET, examples: [...EXAMPLES, ...corpusAsExamples], minimums: { positive: 18, neighbour: 12, sensitive: 12, mixed: 6, trap: 12 } })).toEqual([]);
    expect(new Set([...C, ...SAV_INTEGRATIONS_BLIND_SET].map(row => row.id)).size).toBe(360);
  });
});

/** The route each request must take: a sensitive mail keeps every request with the team. */
const honestRoute = (row: IntegrationsCorpusCase, expected: IntegrationsCorpusCase["requests"][number]["expected"]): RequestRoute =>
  isSensitive(row) || expected.kind === "sensitive" ? { kind: "team" } : expected;
const results = (rows: readonly IntegrationsCorpusCase[], route: (row: IntegrationsCorpusCase, expected: IntegrationsCorpusCase["requests"][number]["expected"]) => RequestRoute): QualificationCaseResult[] =>
  rows.map(row => ({ caseId: row.id, status: "complete", requests: row.requests.map(request => ({ requestId: request.requestId, route: route(row, request.expected) })) }));
const verdict = (rows: readonly IntegrationsCorpusCase[], route: Parameters<typeof results>[1]) =>
  qualificationVerdict({ blockId: "integrations", cases: rows, results: results(rows, route), budgetExhausted: false });
const INTEGRATIONS: RequestRoute = { kind: "block", blockId: "integrations" };

describe("double harnais sur le verdict N3 (aucun modèle)", () => {
  it.each([["corpus", C], ["jeu aveugle", SAV_INTEGRATIONS_BLIND_SET]] as const)("%s : le double honnête passe tous les seuils", (_name, rows) => {
    const result = verdict(rows, honestRoute);
    expect(result.status).toBe("pass");
    expect(result.sensitive.admitted).toBe(0);
    expect(result.neighbourRouting.hits).toBe(result.neighbourRouting.total);
    expect(result.blockRecall.hits).toBe(result.blockRecall.total);
  });
  it("corpus : chiffres exacts du double honnête", () => {
    const result = verdict(C, honestRoute);
    expect({ sensitive: result.sensitive.total, neighbours: result.neighbourRouting.total, recall: result.blockRecall.total, traps: result.traps.total })
      .toEqual({ sensitive: 76, neighbours: 60, recall: 139, traps: 60 });
  });
  it("un juge qui admet tous les voisins échoue (le harnais ne l'accepte pas)", () => {
    const result = verdict(C, (row, expected) => row.group === "neighbour" ? INTEGRATIONS : honestRoute(row, expected));
    expect(result.status).toBe("fail");
    expect(result.neighbourRouting).toEqual({ hits: 0, total: 60 });
  });
  it("un juge qui admet tout : chaque sensible admis est compté, échec dur", () => {
    const result = verdict(C, () => INTEGRATIONS);
    expect(result.status).toBe("fail");
    expect(result.sensitive.admitted).toBe(result.sensitive.total);
  });
  it("un juge qui admet tout, derrière le seul noyau de phrases : le noyau ne suffit pas, la contre-lecture reste indispensable", () => {
    const kernelOnly = (row: IntegrationsCorpusCase): RequestRoute => accessSkillKernelHits(row.subject, row.text).length > 0 || row.text.length > 12_000 ? { kind: "team" } : INTEGRATIONS;
    const result = verdict(C, row => kernelOnly(row));
    expect(result.status).toBe("fail");
    expect(result.sensitive.admitted).toBeGreaterThan(0);
  });
  it("un juge en panne (aucun résultat) donne « incomplet », jamais « réussi »", () => {
    expect(qualificationVerdict({ blockId: "integrations", cases: C, results: [], budgetExhausted: false }).status).toBe("incomplete");
  });
});
