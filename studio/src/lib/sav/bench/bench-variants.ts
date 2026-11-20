import { SAV_BENCH_VARIANTS_A } from "./bench-corpus-variants-a.fixture";
import { SAV_BENCH_VARIANTS_B } from "./bench-corpus-variants-b.fixture";
import { SAV_BENCH_VARIANTS_C } from "./bench-corpus-variants-c.fixture";
import { SAV_BENCH_VARIANTS_D } from "./bench-corpus-variants-d.fixture";
import { SAV_BENCH_VARIANTS_M } from "./bench-corpus-variants-m.fixture";
import { SAV_BENCH_LIMOVA_DOMAINS, savBenchSimilarity } from "./bench-checks";
import { savBenchConversationSchema, savBenchNormalize, savBenchTeamOutcome, type SavBenchConversation, type SavBenchVariantInput } from "./bench-types";

/*
 * Bench variants (Ugo 20/11): the SAME scenarios as the 132 conversations of the self-test, worded differently (very short and badly written,
 * long and angry or anxious, English, a quoted previous thread with a signature and a legal footer, formal). Written by agents other than the
 * original authors. A variant carries ONLY wording (customer, subject, the customer's texts); everything the bench judges (family, cards,
 * allowed domains, canary, risky flag, and each turn's `expect` and conditional replies' `when`/`expect`) is COPIED from its origin here, so a
 * variant can never drift from the expectation of the scenario it rewords. `bench-corpus.test.ts` keeps them valid and fictional.
 */
export const SAV_BENCH_VARIANTS_REVISION = "sav-bench-variants-2026-11-20.v1";
export const SAV_BENCH_VARIANT_SOURCES: readonly (readonly SavBenchVariantInput[])[] = [SAV_BENCH_VARIANTS_A, SAV_BENCH_VARIANTS_B, SAV_BENCH_VARIANTS_C, SAV_BENCH_VARIANTS_D, SAV_BENCH_VARIANTS_M];

/** Families whose turn sequence IS the scenario: a variant keeps every turn. */
const SEQUENCE_FAMILIES = new Set(["piege_toujours_pareil", "changement_sujet", "piege_bug_resolu"]);
/** The new agent's memory and progress cases (`smart-bench-multiturn.fixture.ts`): their turn sequence is the point too. */
const SEQUENCE_ID = /^multi-(?:memoire|progres)-/;

/**
 * The fewest turns a variant of `origin` may keep: all of them for a sequence scenario (the families above, the memory and progress cases); otherwise up
 * to the last turn that hands the case to the team (a sensitive or handoff turn is the point of the scenario), at least one.
 */
export function savBenchVariantMinTurns(origin: SavBenchConversation): number {
  if (SEQUENCE_FAMILIES.has(origin.family) || SEQUENCE_ID.test(origin.id)) return origin.turns.length;
  let min = 1;
  origin.turns.forEach((turn, index) => {
    const outcomes = [turn.expect.outcome, ...turn.variants.map(variant => variant.expect?.outcome ?? [])].flat();
    if (outcomes.length && outcomes.every(savBenchTeamOutcome)) min = Math.max(min, index + 1);
    if (outcomes.includes("equipe_sensible")) min = Math.max(min, index + 1);
  });
  return min;
}

/** Builds one variant from its origin: wording from the variant, every expectation from the origin. Throws on an inconsistent variant. */
export function buildSavBenchVariant(variant: SavBenchVariantInput, origin: SavBenchConversation): SavBenchConversation {
  if (variant.origin !== origin.id || !new RegExp(`^${origin.id.replace(/[.]/g, "\\.")}-v[1-4]$`).test(variant.id)) throw Error(`SAV_BENCH_VARIANT_ID:${variant.id}`);
  const min = savBenchVariantMinTurns(origin);
  if (variant.turns.length < min || variant.turns.length > origin.turns.length) throw Error(`SAV_BENCH_VARIANT_TURNS:${variant.id}`);
  const turns = variant.turns.map((raw, index) => {
    const source = origin.turns[index]!, own = typeof raw === "string" ? { text: raw, alt: undefined } : raw;
    if (own.alt && own.alt.length !== source.variants.length) throw Error(`SAV_BENCH_VARIANT_ALT:${variant.id}`);
    return { text: own.text, expect: source.expect, variants: source.variants.map((conditional, i) => ({ ...conditional, text: own.alt?.[i] ?? conditional.text })) };
  });
  if (origin.canary && !turns.some(turn => [turn.text, ...turn.variants.map(v => v.text)].some(text => savBenchNormalize(text).includes(savBenchNormalize(origin.canary!)))))
    throw Error(`SAV_BENCH_VARIANT_CANARY:${variant.id}`);
  return savBenchConversationSchema.parse({
    id: variant.id, family: origin.family, title: `${origin.title} (variante ${variant.style})`.slice(0, 160), customer: variant.customer, subject: variant.subject,
    knowledge: origin.knowledge, allowedDomains: origin.allowedDomains, ...(origin.canary ? { canary: origin.canary } : {}), risky: origin.risky, turns,
  });
}

/** Every variant built against `origins` (the self-test's 132 conversations). Throws if a variant names an unknown origin. */
export function buildSavBenchVariants(origins: readonly SavBenchConversation[], sources = SAV_BENCH_VARIANT_SOURCES): SavBenchConversation[] {
  const byId = new Map(origins.map(row => [row.id, row]));
  return sources.flat().map(variant => {
    const origin = byId.get(variant.origin);
    if (!origin) throw Error(`SAV_BENCH_VARIANT_ORIGIN:${variant.id}`);
    return buildSavBenchVariant(variant, origin);
  });
}

/** The variant's origin id (`nylas-01-v2` → `nylas-01`), or null for a base conversation. */
export const savBenchVariantOrigin = (id: string) => /^(.+)-v[1-4]$/.exec(id)?.[1] ?? null;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** A phone number shape (French or international): never in a fictional corpus. */
const PHONE = /(?:\+\d{2}[\s.]?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/;
const DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|fr|net|org|io|ai|eu|co|app|dev|be|ch|de|uk|us|info|biz|invalid)\b/gi;
const textsOf = (row: SavBenchConversation) => [row.subject, ...row.turns.flatMap(turn => [turn.text, ...turn.variants.map(variant => variant.text)])];

/**
 * Hygiene of a built variant against its origin, as closed codes (empty = clean): fictional addresses only, no phone number, no domain other
 * than `.invalid`, Limova's, the origin's allowed ones or one the origin already names, and really reworded (first mail word overlap < 0.7).
 */
export function savBenchVariantProblems(variant: SavBenchConversation, origin: SavBenchConversation): string[] {
  const problems: string[] = [], texts = textsOf(variant), originText = textsOf(origin).join(" ").toLowerCase();
  if (!/@exemple\.invalid$/.test(variant.customer.email)) problems.push("customer_email");
  for (const text of texts) {
    for (const email of text.match(EMAIL) ?? []) if (!/@exemple\.invalid$/i.test(email)) problems.push(`email:${email}`);
    if (PHONE.test(text)) problems.push("phone");
    for (const domain of text.match(DOMAIN) ?? []) {
      const host = domain.toLowerCase();
      const ok = host.endsWith(".invalid") || originText.includes(host) || [...SAV_BENCH_LIMOVA_DOMAINS, ...origin.allowedDomains].some(allowed => host === allowed || host.endsWith(`.${allowed}`));
      if (!ok) problems.push(`domain:${host}`);
    }
  }
  if (savBenchSimilarity(variant.turns[0]!.text, origin.turns[0]!.text) >= 0.7) problems.push("not_reworded");
  return problems;
}
