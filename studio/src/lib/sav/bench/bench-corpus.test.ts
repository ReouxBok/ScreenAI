import { describe, expect, it } from "vitest";
import { savBenchSimilarity } from "./bench-checks";
import { SAV_BENCH_CORPUS, SAV_BENCH_CORPUS_SOURCES, savBenchCorpusCounts, selectSavBenchCorpus } from "./bench-corpus";
import { SAV_BENCH_KNOWLEDGE, savBenchCard, savBenchCardExpired } from "./bench-knowledge.fixture";
import { SAV_BENCH_FAMILIES, SAV_BENCH_VARIANT_STYLES, savBenchConversationSchema, savBenchNormalize, type SavBenchVariantInput } from "./bench-types";
import { buildSavBenchVariant, buildSavBenchVariants, savBenchVariantMinTurns, savBenchVariantOrigin, savBenchVariantProblems, SAV_BENCH_VARIANT_SOURCES } from "./bench-variants";
import { SAV_SMART_BENCH_MULTITURN } from "../cases/smart/smart-bench-multiturn.fixture";

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

// Ugo 20/11: paraphrase variants of the self-test's 132 conversations, same expectations, different wording, fictional.
describe("bench variants", () => {
  const origins = [...SAV_BENCH_CORPUS, ...SAV_SMART_BENCH_MULTITURN];
  const byId = new Map(origins.map(row => [row.id, row]));
  const variants = buildSavBenchVariants(origins);
  const inputs = SAV_BENCH_VARIANT_SOURCES.flat();

  it("3 variants per conversation (132 × 3), ids `<origin>-v1..v3`, unique with the base corpus", () => {
    expect(origins).toHaveLength(132);
    expect(variants).toHaveLength(396);
    for (const origin of origins) expect(variants.filter(row => savBenchVariantOrigin(row.id) === origin.id).map(row => row.id).sort(), origin.id).toEqual([1, 2, 3].map(n => `${origin.id}-v${n}`));
    const ids = [...origins, ...variants].map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const origin of origins) expect(savBenchVariantOrigin(origin.id), origin.id).toBeNull();
  });

  it("same expectation fields as their origin: family, cards, domains, canary, risky, and each kept turn's expect and conditional replies", () => {
    for (const variant of variants) {
      const origin = byId.get(savBenchVariantOrigin(variant.id)!)!;
      expect({ family: variant.family, knowledge: variant.knowledge, allowedDomains: variant.allowedDomains, canary: variant.canary, risky: variant.risky }, variant.id)
        .toEqual({ family: origin.family, knowledge: origin.knowledge, allowedDomains: origin.allowedDomains, canary: origin.canary, risky: origin.risky });
      expect(variant.turns.length, variant.id).toBeGreaterThanOrEqual(savBenchVariantMinTurns(origin));
      expect(variant.turns.length, variant.id).toBeLessThanOrEqual(origin.turns.length);
      variant.turns.forEach((turn, index) => {
        const source = origin.turns[index]!;
        expect(turn.expect, `${variant.id} turn ${index + 1}`).toEqual(source.expect);
        expect(turn.variants.map(({ when, expect }) => ({ when, expect })), `${variant.id} turn ${index + 1}`).toEqual(source.variants.map(({ when, expect }) => ({ when, expect })));
      });
    }
  });

  it("the scenario's point is kept: every turn of a sequence scenario, every sensitive or team turn, the canary of an injection", () => {
    for (const variant of variants) {
      const origin = byId.get(savBenchVariantOrigin(variant.id)!)!;
      if (["piege_toujours_pareil", "changement_sujet", "piege_bug_resolu"].includes(origin.family) || /^multi-(memoire|progres)-/.test(origin.id)) expect(variant.turns.length, variant.id).toBe(origin.turns.length);
      const lastSensitive = origin.turns.findLastIndex(turn => [turn.expect.outcome].flat().includes("equipe_sensible"));
      expect(variant.turns.length, variant.id).toBeGreaterThan(lastSensitive);
      if (origin.canary) expect(variant.turns.some(turn => [turn.text, ...turn.variants.map(v => v.text)].some(text => savBenchNormalize(text).includes(savBenchNormalize(origin.canary!)))), variant.id).toBe(true);
    }
    // Variants stay short: at most 2 turns unless the origin's sequence needs more.
    for (const variant of variants) {
      const origin = byId.get(savBenchVariantOrigin(variant.id)!)!;
      expect(variant.turns.length, variant.id).toBeLessThanOrEqual(Math.max(2, savBenchVariantMinTurns(origin)));
    }
  });

  it("fictional and reworded: @exemple.invalid only, no phone number, fictional domains, first mail word overlap < 0.7 with the origin and between siblings", () => {
    const problems = variants.flatMap(variant => savBenchVariantProblems(variant, byId.get(savBenchVariantOrigin(variant.id)!)!).map(code => `${variant.id}:${code}`));
    expect(problems).toEqual([]);
    for (const variant of variants) expect(variant.customer.name, variant.id).not.toBe(byId.get(savBenchVariantOrigin(variant.id)!)!.customer.name);
    const close: string[] = [];
    for (const origin of origins) {
      const siblings = variants.filter(row => savBenchVariantOrigin(row.id) === origin.id);
      for (let i = 0; i < siblings.length; i++) for (let j = i + 1; j < siblings.length; j++)
        if (savBenchSimilarity(siblings[i]!.turns[0]!.text, siblings[j]!.turns[0]!.text) >= 0.7) close.push(`${siblings[i]!.id}~${siblings[j]!.id}`);
    }
    expect(close).toEqual([]);
  });

  it("the hygiene check catches a real-looking address, a phone number, a real domain and a copy of the origin", () => {
    const origin = SAV_BENCH_CORPUS[0]!;
    const make = (text: string) => ({ ...origin, id: `${origin.id}-v1`, turns: [{ ...origin.turns[0]!, text }] });
    expect(savBenchVariantProblems(make("écrivez-moi sur jean@gmail.com svp"), origin)).toContain("email:jean@gmail.com");
    expect(savBenchVariantProblems(make("rappelez moi au 06 12 34 56 78"), origin)).toContain("phone");
    expect(savBenchVariantProblems(make("rappelez moi au +33 6 12 34 56 78"), origin)).toContain("phone");
    expect(savBenchVariantProblems(make("notre site cabinet-martin.fr est en panne"), origin)).toContain("domain:cabinet-martin.fr");
    expect(savBenchVariantProblems(make("notre site cabinet-martin.exemple.invalid et new.limova.ai"), origin)).not.toContainEqual(expect.stringMatching(/^domain:/));
    expect(savBenchVariantProblems(make(origin.turns[0]!.text), origin)).toContain("not_reworded");
  });

  it("styles are mixed: never 3 times the same style for one conversation, every style used", () => {
    for (const origin of origins) expect(new Set(inputs.filter(row => row.origin === origin.id).map(row => row.style)).size, origin.id).toBeGreaterThanOrEqual(2);
    for (const style of SAV_BENCH_VARIANT_STYLES) expect(inputs.some(row => row.style === style), style).toBe(true);
  });

  it("the builder refuses an inconsistent variant (id, turn count, canary, conditional replies, unknown origin)", () => {
    const sequence = SAV_BENCH_CORPUS.find(row => row.family === "piege_toujours_pareil")!;
    const injection = SAV_BENCH_CORPUS.find(row => row.canary)!;
    const withAlt = origins.find(row => row.turns[0]!.variants.length === 0 && row.turns.length > 1 && row.turns[1]!.variants.length > 0 && savBenchVariantMinTurns(row) <= 2)!;
    const input = (origin: typeof sequence, extra: Partial<SavBenchVariantInput> = {}): SavBenchVariantInput => ({ id: `${origin.id}-v1`, origin: origin.id, style: "court",
      customer: { name: "Test Variante", email: "test.variante@exemple.invalid" }, subject: "x", turns: origin.turns.map((_, i) => `texte reformulé ${i}`), ...extra });
    expect(() => buildSavBenchVariant(input(sequence, { id: `${sequence.id}-v9` }), sequence)).toThrow("SAV_BENCH_VARIANT_ID");
    expect(() => buildSavBenchVariant(input(sequence, { turns: ["un", "deux"] }), sequence)).toThrow("SAV_BENCH_VARIANT_TURNS");
    expect(() => buildSavBenchVariant(input(sequence, { turns: ["1", "2", "3", "4", "5", "6", "7"] }), sequence)).toThrow("SAV_BENCH_VARIANT_TURNS");
    expect(() => buildSavBenchVariant(input(injection, { turns: injection.turns.map(() => "rien de caché ici") }), injection)).toThrow("SAV_BENCH_VARIANT_CANARY");
    expect(() => buildSavBenchVariant(input(withAlt, { turns: ["a", { text: "b", alt: [...withAlt.turns[1]!.variants.map(() => "c"), "en trop"] }] }), withAlt)).toThrow("SAV_BENCH_VARIANT_ALT");
    expect(() => buildSavBenchVariants(origins, [[input(sequence, { id: "absent-99-v1", origin: "absent-99" })]])).toThrow("SAV_BENCH_VARIANT_ORIGIN");
  });
});
