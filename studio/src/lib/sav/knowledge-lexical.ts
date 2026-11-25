/*
 * Lexical recall of SAV cards (25/11, Agent SAV in production: « LinkedIn programmer posts » found no card while « Créer une automatisation de création
 * de post » and « Connecter LinkedIn pour prospecter ou publier » were active). Pure, bounded and deterministic: no model, embedding, network or clock.
 *
 *   terms     the query's words, accents and case folded, French plural folded (a trailing « s » or « x » on a word of more than three letters:
 *             « posts » = « post », « messages » = « message »), stop words dropped, each term once, at most SAV_LEXICAL_MAX_TERMS;
 *   match     ANY term counts: a card holds at least one term (two from a three-term query on, `savLexicalMinTerms`), ranked by the number of
 *             distinct terms found in its title and symptoms (strong), then in title, symptoms and body (total). Words of one or two letters and
 *             a small stop list (articles, prepositions, « compte », « limova », politeness) are never terms. A light normalisation, not an
 *             intent: no keyword list decides what the customer wants.
 */

export const SAV_LEXICAL_MAX_TERMS = 40;
const STOP_WORDS = new Set([
  "au", "aux", "avec", "ce", "ces", "cet", "cette", "comment", "dans", "de", "des", "du", "elle", "en", "est", "et", "il", "je", "la", "le", "les", "leur", "leurs",
  "ma", "mais", "me", "mes", "moi", "mon", "ne", "nos", "notre", "nous", "on", "ou", "par", "pas", "plus", "pour", "qu", "que", "qui", "quoi", "sa", "se", "ses",
  "son", "sont", "sur", "ta", "te", "tes", "ton", "tu", "un", "une", "vos", "votre", "vous", "faire", "peut", "bonjour", "merci", "cordialement", "limova",
  "compte", "comptes", "aussi", "alors", "car", "donc", "puis", "tout", "tous", "toute", "toutes", "tres", "bien", "fait", "fais", "suis", "ai", "as", "avez", "avons",
  "ont", "etre", "avoir", "lui", "eux", "ete", "via", "ici", "souhaite", "voudrais", "veux", "besoin", "aide", "aider", "probleme", "marche", "fonctionne", "ca", "cela", "ceci", "non", "oui",
  "the", "and", "with", "how", "for", "to", "of", "my", "is",
]);
/** A word of one or two letters is never a term; the common three-letter words are in the stop list (« api », « sms », « pdf » stay terms). */
const MIN_TERM_LENGTH = 3;

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");
/** One word, plural folded: a trailing « s » or « x » is dropped on a word of more than three letters. */
const singular = (word: string) => word.length > 3 && /[sx]$/.test(word) ? word.slice(0, -1) : word;

/** The distinct searchable terms of a text, in their order of appearance, bounded. */
export function savLexicalTerms(text: string): string[] {
  const words = fold(String(text ?? "")).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter(word => word.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(word)).map(singular).filter(word => !STOP_WORDS.has(word)))].slice(0, SAV_LEXICAL_MAX_TERMS);
}

export type SavLexicalFields = Readonly<{ title: string; symptoms?: readonly string[]; body?: string }>;
export type SavLexicalMatch = Readonly<{ strong: number; total: number }>;

/** How many distinct query terms a card holds: in its title and symptoms (`strong`), and anywhere in title, symptoms and body (`total`). */
export function savLexicalMatch(query: string | readonly string[], fields: SavLexicalFields): SavLexicalMatch {
  const terms = typeof query === "string" ? savLexicalTerms(query) : query;
  if (!terms.length) return { strong: 0, total: 0 };
  const head = new Set(savLexicalTerms([fields.title, ...(fields.symptoms ?? [])].join(" ")));
  const all = new Set([...head, ...savLexicalTerms(fields.body ?? "")]);
  return { strong: terms.filter(term => head.has(term)).length, total: terms.filter(term => all.has(term)).length };
}

/**
 * The fewest distinct terms a card must hold for a query (review of e617a17f): one when the query has one or two terms, two from three terms on, so one
 * shared word of a long mail (« connecter mon compte » / « Connecter LinkedIn ») never makes a card relevant.
 */
export const savLexicalMinTerms = (terms: readonly string[]) => terms.length >= 3 ? 2 : 1;

/**
 * The items matching enough query terms (`savLexicalMinTerms`), best first: most terms in title and symptoms, then most terms overall, then their given order (stable).
 * `minStrong`: the fewest terms the title and symptoms must hold (0 by default: a body match is enough). At most `limit` items.
 */
export function savLexicalRank<T>(query: string, items: readonly T[], fieldsOf: (item: T) => SavLexicalFields, options: Readonly<{ limit: number; minStrong?: number }>): T[] {
  const terms = savLexicalTerms(query), minStrong = options.minStrong ?? 0;
  if (!terms.length || options.limit < 1) return [];
  return items.map((item, index) => ({ item, index, match: savLexicalMatch(terms, fieldsOf(item)) }))
    .filter(row => row.match.total >= savLexicalMinTerms(terms) && row.match.strong >= minStrong)
    .sort((a, b) => b.match.strong - a.match.strong || b.match.total - a.match.total || a.index - b.index)
    .slice(0, options.limit).map(row => row.item);
}
