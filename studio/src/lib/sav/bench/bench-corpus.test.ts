import { describe, expect, it } from "vitest";
import { savBenchSimilarity } from "./bench-checks";
import { SAV_BENCH_CORPUS, SAV_BENCH_CORPUS_SOURCES, savBenchCorpusCounts, selectSavBenchCorpus } from "./bench-corpus";
import { SAV_BENCH_KNOWLEDGE, savBenchCard, savBenchCardExpired } from "./bench-knowledge.fixture";
import { SAV_BENCH_FAMILIES, savBenchConversationSchema, savBenchNormalize } from "./bench-types";

// SAV-109: the corpus stays valid, fictional and diverse.
describe("SAV-109 bench corpus", () => {
  it("120 conversations, 6 per family, every family present", () => {
    const counts = savBenchCorpusCounts();
    expect(counts.conversations).toBe(120);
    for (const family of SAV_BENCH_FAMILIES) expect(counts.byFamily[family]).toBe(6);
  });

  it("every row passes the schema and names known cards only", () => {
    for (const row of SAV_BENCH_CORPUS_SOURCES.flat()) {
      expect(() => savBenchConversationSchema.parse(row)).not.toThrow();
      for (const id of row.knowledge) expect(savBenchCard(id), `${row.id}: ${id}`).toBeDefined();
    }
  });

  it("unique ids", () => {
    expect(new Set(SAV_BENCH_CORPUS.map(row => row.id)).size).toBe(SAV_BENCH_CORPUS.length);
  });

  it("fictional data only: every email address in the corpus and the cards is @exemple.invalid", () => {
    const texts = [...SAV_BENCH_CORPUS.flatMap(row => [row.customer.email, row.subject, ...row.turns.flatMap(turn => [turn.text, ...turn.variants.map(variant => variant.text)])]),
      ...SAV_BENCH_KNOWLEDGE.map(card => `${card.content} ${card.steps.join(" ")}`)];
    for (const text of texts) for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) expect(email.toLowerCase()).toMatch(/@exemple\.invalid$/);
  });

  it("no near duplicate: first mails differ pairwise (word overlap < 0.7)", () => {
    const first = SAV_BENCH_CORPUS.map(row => ({ id: row.id, text: row.turns[0]!.text }));
    const close: string[] = [];
    for (let i = 0; i < first.length; i++) for (let j = i + 1; j < first.length; j++)
      if (savBenchSimilarity(first[i]!.text, first[j]!.text) >= 0.7) close.push(`${first[i]!.id}~${first[j]!.id}`);
    expect(close).toEqual([]);
  });

  it("the traps are really there", () => {
    const rows = (family: string) => SAV_BENCH_CORPUS.filter(row => row.family === family);
    // Every injection case names its canary, and the canary is in the customer's text.
    for (const row of rows("piege_injection")) {
      expect(row.canary, row.id).toBeDefined();
      expect(row.turns.some(turn => [turn.text, ...turn.variants.map(v => v.text)].some(text => savBenchNormalize(text).includes(savBenchNormalize(row.canary!)))), row.id).toBe(true);
    }
    // A hidden cancellation or refund: the turn expects the team, sensitive.
    for (const row of rows("piege_resiliation_ps")) expect(row.turns.some(turn => [turn.expect.outcome].flat().includes("equipe_sensible")), row.id).toBe(true);
    // « Toujours pareil »: three turns, the last one goes to the team.
    for (const row of rows("piege_toujours_pareil")) { expect(row.turns.length).toBe(3); expect([row.turns[2]!.expect.outcome].flat()).toContain("passer_la_main"); }
    // Expired knowledge: each such conversation is given at least one expired card.
    for (const row of rows("piege_connaissance_expiree")) expect(row.knowledge.some(id => savBenchCardExpired(savBenchCard(id)!)), row.id).toBe(true);
    // Every trap is in the risky subset.
    for (const row of SAV_BENCH_CORPUS.filter(row => row.family.startsWith("piege_"))) expect(row.risky, row.id).toBe(true);
    // Multi-turn and customer replies that depend on the agent.
    expect(SAV_BENCH_CORPUS.filter(row => row.turns.length > 1).length).toBeGreaterThanOrEqual(50);
    expect(SAV_BENCH_CORPUS.filter(row => row.turns.some(turn => turn.variants.length)).length).toBeGreaterThanOrEqual(30);
    // Sensitive turns exist outside the PS family too (mixes, topic changes).
    expect(SAV_BENCH_CORPUS.filter(row => !row.family.startsWith("piege_resiliation") && row.turns.some(turn => [turn.expect.outcome].flat().includes("equipe_sensible"))).length).toBeGreaterThanOrEqual(8);
  });

  it("selects the risky subset, families and ids", () => {
    expect(selectSavBenchCorpus({ subset: "risky" }).every(row => row.risky)).toBe(true);
    expect(selectSavBenchCorpus({ families: ["piege_injection"] })).toHaveLength(6);
    expect(selectSavBenchCorpus({ ids: [SAV_BENCH_CORPUS[0]!.id] })).toHaveLength(1);
    expect(selectSavBenchCorpus({ limit: 5 })).toHaveLength(5);
  });
});
