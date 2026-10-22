/**
 * Limova AI - Other sites
 * Pure helpers to recognise web pages outside Limova and to decide when a
 * request asks for content that Charly should create inside Limova.
 */

const LIMOVA_APP_ORIGIN = 'https://new.limova.ai';

// Writing verbs always ask for an output; generic verbs ("fais", "make") only
// do when they come with something to produce, so "fais défiler" stays a page action.
const OUTPUT_VERBS = /(?<![\p{L}])(écris|ecris|écrire|ecrire|rédige|redige|rédiger|rediger|génère|genere|générer|generer|résume|resume|résumer|resumer|traduis|traduire|reformule|write|draft|generate|summari[sz]e|translate|rewrite|escribe|redacta|genera|resume|traduce)(?![\p{L}])/iu;
const GENERIC_VERBS = /(?<![\p{L}])(fais|fait|faire|crée|cree|créer|creer|prépare|prepare|préparer|preparer|propose|proposer|transforme|make|create|prepare|haz|crea|prepara)(?![\p{L}])/iu;
const OUTPUT_NOUNS = /(?<![\p{L}])(posts?|publications?|articles?|e-?mails?|mails?|messages?|réponses?|reponses?|résumés?|resumes?|synthèses?|syntheses?|comptes?[- ]rendus?|newsletters?|tweets?|threads?|carrousels?|carousels?|scripts?|présentations?|presentations?|slides?|fiches?|briefs?|annonces?|offres?|lettres?|descriptions?|légendes?|legendes?|captions?|summary|summaries|reply|replies|letters?|copy|correos?|respuestas?|resúmenes|resumen)(?![\p{L}])/iu;

function siteOriginOf(url) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    if (parsed.origin === LIMOVA_APP_ORIGIN) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isLimovaOutputRequest(text) {
  const value = String(text || '');
  if (OUTPUT_VERBS.test(value)) return true;
  return GENERIC_VERBS.test(value) && OUTPUT_NOUNS.test(value);
}
