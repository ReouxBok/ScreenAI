import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { buildSavBenchVariants } from "../../bench/bench-variants";
import { SAV_SMART_BENCH_MULTITURN } from "./smart-bench-multiturn.fixture";
import { smartBindableSentence, smartFactSentenceInReply } from "./smart-checks";

/** SAV-122 (bench v11): the free measure of the fact binding on the bench's 1 334 keyFacts (used by the test; fictional texts only). */
const cap = (value: string) => value.charAt(0).toLocaleUpperCase("fr") + value.slice(1);
const low = (value: string) => value.charAt(0).toLocaleLowerCase("fr") + value.slice(1);
const SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [/\bcliquez\b/, "appuyez"], [/\bcliquer\b/, "appuyer"], [/\bouvrez\b/, "affichez"], [/\bouvrir\b/, "afficher"], [/\bvérifiez\b/, "contrôlez"], [/\bvérifier\b/, "contrôler"],
  [/\bchoisissez\b/, "sélectionnez"], [/\bchoisir\b/, "sélectionner"], [/\bcoller\b/, "insérer"], [/\bcollez\b/, "insérez"], [/\butiliser\b/, "employer"], [/\bajouter\b/, "insérer"],
];
export const SMART_BIND_LIGHT: Record<string, (fact: string) => string | null> = {
  article: fact => { for (const [from, to] of [[" le ", " un "], [" la ", " une "], [" les ", " des "], [" un ", " le "], [" une ", " la "]] as const) if (fact.includes(from)) return fact.replace(from, to); return null; },
  ordre: fact => { const at = fact.indexOf(", "); return at > 0 ? `${cap(fact.slice(at + 2))}, ${low(fact.slice(0, at))}` : null; },
  synonyme: fact => { for (const [from, to] of SYNONYMS) if (from.test(fact)) return fact.replace(from, to); return null; },
};
export const SMART_BIND_FALSE: Record<string, (fact: string) => string | null> = {
  chiffre: fact => /\d+/.test(fact) ? fact.replace(/\d+/, digits => String(Number(digits) + 1)) : null,
  // A negation added, or every negation word of the fact removed (« ne jamais transmettre » → « transmettre »).
  negation: fact => /(^|[^\p{L}])(ne|n'|pas|jamais|aucun|aucune|sans|rien)($|[^\p{L}])/u.test(fact)
    ? fact.replace(/(?<!\p{L})(?:ne |n'|pas |jamais |aucun |aucune |sans |rien )/gu, "") : `Il ne faut pas ${low(fact)}`,
};
export function smartBindMeasure() {
  const origins = [...SAV_BENCH_CORPUS, ...SAV_SMART_BENCH_MULTITURN], all = [...origins, ...buildSavBenchVariants(origins)];
  const facts = all.flatMap(conversation => conversation.turns.flatMap(turn => turn.expect.keyFacts));
  const count = (forms: Record<string, (fact: string) => string | null>) => Object.fromEntries(Object.entries(forms).map(([name, form]) => {
    let applicable = 0, accepted = 0;
    for (const fact of facts) {
      const declared = form(fact);
      if (!declared || declared === fact) continue;
      applicable++;
      const reply = `Bonjour,\n\n${cap(fact)}.\n\nBelle journée.`;
      if (smartFactSentenceInReply(reply, declared) || smartBindableSentence(reply, declared)) accepted++;
    }
    return [name, { applicable, accepted, refused: applicable - accepted }];
  }));
  return { total: facts.length, light: count(SMART_BIND_LIGHT), wrong: count(SMART_BIND_FALSE) };
}
