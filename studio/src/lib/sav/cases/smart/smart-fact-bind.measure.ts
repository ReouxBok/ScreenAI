import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { buildSavBenchVariants } from "../../bench/bench-variants";
import { SAV_SMART_BENCH_MULTITURN } from "./smart-bench-multiturn.fixture";
import { smartBindableSentence, smartFactSentenceInReply } from "./smart-checks";

/** SAV-122 (bench v11): the free measure of the fact binding on the bench's keyFacts (1 302 since the injection turns hand over and the LinkedIn quota turn answers, 21/11) (used by the test; fictional texts only). */
const cap = (value: string) => value.charAt(0).toLocaleUpperCase("fr") + value.slice(1);
const low = (value: string) => value.charAt(0).toLocaleLowerCase("fr") + value.slice(1);
// PORTE 2G: only what keeps the same words in the same order is « light »; everything else must be refused.
export const SMART_BIND_LIGHT: Record<string, (fact: string) => string | null> = {
  article: fact => { for (const [from, to] of [[" le ", " un "], [" la ", " une "], [" les ", " des "], [" un ", " le "], [" une ", " la "]] as const) if (fact.includes(from)) return fact.replace(from, to); return null; },
  ponctuation: fact => fact.includes(", ") ? fact.replace(", ", " ") : `${fact} !`,
  premiere_lettre: fact => /^\p{Ll}/u.test(fact) ? cap(fact) : low(fact),
  accord: fact => { const word = fact.match(/(?<![\p{L}'])\p{L}{5,}(?<![sx])(?![\p{L}'])/u)?.[0]; return word ? fact.replace(word, `${word}s`) : null; },
};
export const SMART_BIND_FALSE: Record<string, (fact: string) => string | null> = {
  chiffre: fact => /\d+/.test(fact) ? fact.replace(/\d+/, digits => String(Number(digits) + 1)) : null,
  // A negation added, or every negation word of the fact removed (« ne jamais transmettre » → « transmettre »).
  negation: fact => /(^|[^\p{L}])(ne|n'|pas|jamais|aucun|aucune|sans|rien)($|[^\p{L}])/u.test(fact)
    ? fact.replace(/(?<!\p{L})(?:ne |n'|pas |jamais |aucun |aucune |sans |rien )/gu, "") : `Il ne faut pas ${low(fact)}`,
  // One significant word replaced by another (« Contacts » → « Contrats »).
  mot_change: fact => { const word = fact.match(/(?<![\p{L}'])\p{L}{5,}(?![\p{L}'])/u)?.[0]; return word ? fact.replace(word, word.toLowerCase().startsWith("contr") ? "Paramètres" : "Contrats") : null; },
  ordre: fact => { const at = fact.indexOf(", "); return at > 0 ? `${cap(fact.slice(at + 2))}, ${low(fact.slice(0, at))}` : null; },
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
