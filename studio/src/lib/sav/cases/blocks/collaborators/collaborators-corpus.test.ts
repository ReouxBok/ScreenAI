import { describe, expect, it } from "vitest";
import { savEvidenceContains } from "../../../evidence-text";
import type { CorpusGroup } from "../../../skills/corpus-contract";
import { lintCorpus } from "../../../skills/corpus-lint";
import { qualificationVerdict, type QualificationCaseResult } from "../../../skills/qualification-verdict";
import { accessSkillKernelHits } from "../../access-skill/access-skill-kernel";
import { SAV_COLLABORATORS_CORPUS, type CollaboratorsCorpusCase, type CollaboratorsCorpusTrait } from "./collaborators-corpus.fixture";
import { SAV_COLLABORATORS_DECISION_EXAMPLES } from "./collaborators-decision-skill";
import { collaboratorsEntryRoutes, SAV_COLLABORATORS_CONFIRM_TEXT_MAX } from "./collaborators-entry-rule";
import { SAV_COLLABORATORS_ENTRY_EXAMPLES } from "./collaborators-entry-skill";

const corpus = SAV_COLLABORATORS_CORPUS;
const count = (predicate: (row: CollaboratorsCorpusCase) => boolean) => corpus.filter(predicate).length;
const withTrait = (trait: CollaboratorsCorpusTrait) => count(row => row.traits.includes(trait));
const examples = [...SAV_COLLABORATORS_ENTRY_EXAMPLES, ...SAV_COLLABORATORS_DECISION_EXAMPLES];
const SAV_COLLABORATORS_CORPUS_MINIMUMS = { positive: 90, neighbour: 60, sensitive: 60, mixed: 30, trap: 60 } satisfies Record<CorpusGroup, number>;
const admitted = (row: CollaboratorsCorpusCase) => row.requests.every(({ expected }) => expected.kind === "block" && expected.blockId === "collaborators");

describe("collaborators corpus: 300 fictional mails, N3 lint green", () => {
  it("passes the N3 lint: quotas, ids, request ids, disjoint from both skills' examples, no real data", () => {
    expect(lintCorpus({ cases: corpus, examples, minimums: SAV_COLLABORATORS_CORPUS_MINIMUMS })).toEqual([]);
  });
  it("holds exactly the group quotas of the template mapped to N3 groups", () => {
    expect(corpus).toHaveLength(300);
    expect(Object.fromEntries((["positive", "neighbour", "sensitive", "mixed", "trap"] as const).map(group => [group, count(row => row.group === group)])))
      .toEqual({ positive: 90, neighbour: 60, sensitive: 60, mixed: 30, trap: 60 });
    expect(count(row => row.group === "trap" && admitted(row))).toBe(30);
  });
  it("holds the trait quotas", () => {
    const minimum: Record<CollaboratorsCorpusTrait, number> = {
      english: 30, typo: 30, forwarded: 15, signature_ps: 15, sensitive_ps: 5, old_subject: 15, return: 30, negation: 15, injection: 10, long: 10, unsure: 5,
    };
    for (const [trait, value] of Object.entries(minimum)) expect(withTrait(trait as CollaboratorsCorpusTrait), trait).toBeGreaterThanOrEqual(value);
    expect(count(row => row.purpose === "return")).toBe(withTrait("return"));
  });
  it("has at least 40 reciprocal near pairs whose twins take another route", () => {
    const pairs = corpus.filter(row => row.pair);
    expect(pairs.length).toBeGreaterThanOrEqual(80);
    for (const row of pairs) {
      const twin = corpus.find(candidate => candidate.id === row.pair)!;
      expect(twin.pair, row.id).toBe(row.id);
      expect(JSON.stringify(twin.requests), row.id).not.toBe(JSON.stringify(row.requests));
    }
  });
  it("gives every neighbour at least 5 cases and holds at least 20 sensitive mails with a kernel phrase", () => {
    for (const blockId of ["access", "charly_max", "integrations"]) {
      expect(count(row => row.requests.length === 1 && row.requests[0].expected.kind === "block" && row.requests[0].expected.blockId === blockId), blockId).toBeGreaterThanOrEqual(5);
    }
    for (const subgroup of ["commercial", "workspace", "roles_explanation", "do_it_for_me", "cancel_invitation"] as const) {
      expect(count(row => row.subgroup === subgroup), subgroup).toBeGreaterThanOrEqual(subgroup === "cancel_invitation" || subgroup === "roles_explanation" ? 3 : 5);
    }
    expect(count(row => row.group === "sensitive" && accessSkillKernelHits(row.subject, row.text).length > 0)).toBeGreaterThanOrEqual(20);
    for (const family of ["rights", "identity", "finance", "cancellation", "subscription"] as const) expect(count(row => row.subgroup === family), family).toBeGreaterThanOrEqual(2);
  });
  it("quotes verbatim; admits no kernel phrase; puts every long mail past the read bound with its sensitive request after the cut", () => {
    for (const row of corpus) {
      expect(savEvidenceContains(row.text, row.quote) || savEvidenceContains(row.subject ?? "", row.quote), row.id).toBe(true);
      if (admitted(row)) {
        expect(accessSkillKernelHits(row.subject, row.text), row.id).toEqual([]);
        expect(row.text.length, row.id).toBeLessThanOrEqual(SAV_COLLABORATORS_CONFIRM_TEXT_MAX);
      }
      if (row.group === "sensitive" || row.requests.some(({ expected }) => expected.kind === "sensitive")) {
        expect(row.requests.every(({ expected }) => expected.kind === "team" || expected.kind === "sensitive"), row.id).toBe(true);
      }
    }
    const long = corpus.filter(row => row.traits.includes("long"));
    expect(long).toHaveLength(10);
    for (const row of long) {
      expect(row.text.length, row.id).toBeGreaterThan(SAV_COLLABORATORS_CONFIRM_TEXT_MAX);
      expect(row.text.lastIndexOf("PS"), row.id).toBeGreaterThan(SAV_COLLABORATORS_CONFIRM_TEXT_MAX);
    }
  });
});

/*
 * Double harness (no model, no network, no money). The honest double reads the labels; the adversarial double is a judge that admits every
 * request as « collaborators » and hides every sensitive mention. The shared counter-read stays honest in both (it is another, independent call).
 */
type Double = "honest" | "lying_judge" | "lying_judge_and_counter_read";
function run(double: Double, cases: readonly CollaboratorsCorpusCase[]): QualificationCaseResult[] {
  return cases.map(row => {
    const sensitive = row.requests.some(({ expected }) => expected.kind === "sensitive");
    const judgment = {
      mail: { sensitive: double === "honest" && sensitive ? "request" : "none", commercial: "none", instructionLike: double === "honest" && row.traits.includes("injection") },
      requests: row.requests.map(({ requestId, expected }) => ({
        requestId, quote: row.quote, reason: "lecture du double", confidence: "high",
        verdict: double !== "honest" ? "collaborators" : expected.kind === "block" ? expected.blockId : expected.kind === "sensitive" ? "sensitive" : row.traits.includes("unsure") ? "unsure" : "other",
        family: double === "honest" && expected.kind === "sensitive" ? "rights" : null,
      })),
      sensitiveMentions: [],
    };
    const input = { purpose: row.purpose, subject: row.subject ?? "", text: row.text, requests: row.requests.map(({ requestId }) => ({ requestId, words: null })) };
    const outcome = collaboratorsEntryRoutes(input, judgment, sensitive && double !== "lying_judge_and_counter_read" ? "yes" : "no");
    return { caseId: row.id, status: "complete", requests: outcome.routes };
  });
}

describe("double harness on the corpus", () => {
  it("honest double: the chain meets every threshold (0 sensitive admitted, neighbours, recall and traps)", () => {
    const verdict = qualificationVerdict({ blockId: "collaborators", cases: corpus, results: run("honest", corpus), budgetExhausted: false });
    expect(verdict).toMatchObject({
      status: "pass", complete: true, cases: { completed: 300, total: 300 },
      sensitive: { admitted: 0, total: 78 }, neighbourRouting: { hits: 60, total: 60 }, blockRecall: { hits: 127, total: 127 }, traps: { hits: 60, total: 60 },
    });
  });
  it("lying judge: the harness refuses it, and the exact count of what the barriers still catch is pinned", () => {
    const verdict = qualificationVerdict({ blockId: "collaborators", cases: corpus, results: run("lying_judge", corpus), budgetExhausted: false });
    expect(verdict.status).toBe("fail");
    expect({ sensitiveAdmitted: verdict.sensitive.admitted, neighbourRouting: verdict.neighbourRouting, traps: verdict.traps })
      .toEqual({ sensitiveAdmitted: 0, neighbourRouting: { hits: 0, total: 60 }, traps: { hits: 30, total: 60 } });
  });
  it("lying judge AND lying counter-read: only the kernel, the read bound and the quote check remain; the residue is counted exactly", () => {
    const verdict = qualificationVerdict({ blockId: "collaborators", cases: corpus, results: run("lying_judge_and_counter_read", corpus), budgetExhausted: false });
    expect(verdict.status).toBe("fail");
    expect({ sensitiveAdmitted: verdict.sensitive.admitted, total: verdict.sensitive.total }).toEqual({ sensitiveAdmitted: 45, total: 78 });
  });
});
