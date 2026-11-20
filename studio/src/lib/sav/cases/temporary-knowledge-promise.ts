/*
 * SAV-105: refuse affirmative commitments in a temporary message or in a reply informed by one. Pure, no import: the validator, the temporary-message schema and the
 * pre-send provenance check share it. Politeness (« À bientôt. ») and caution (« Nous ne pouvons pas garantir de délai. ») pass; a dated delivery, a promise after
 * « mais », an announced price or an outcome stated as certain is refused. Not knowing a date (« Nous ignorons quand… », « nous ne savons pas encore si… ») is
 * caution, not a promise; the support's own near-future action (« Nous allons ajouter… », « on va corriger… ») is a commitment like the simple future.
 */
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`]/g, "'");
const sentencesOf = (text: string) => text.split(/[!?;\n]+|\.+(?![a-z0-9])/).map(sentence => sentence.trim()).filter(Boolean);

const EXPLICIT_COMMITMENT = /\b(?:(?:je|nous|on) (?:te |vous |le )?(?:promets?|promettons|garantis?|garantissons|m engage a|nous engageons a)|(?:i|we) (?:can |will )?(?:promise|guarantee))(?!\s+(?:pas|plus|not|nothing|aucun\w*|rien)\b)\b/;
const NON_COMMITTAL_OUTCOME = /\b(?:ne (?:pouvons|peut|peux) pas (?:garantir|promettre|confirmer)|(?:cannot|can t) (?:guarantee|promise|confirm))\b/;
const UNKNOWN_DATE = /\b(?:ignor(?:e|ons|ent)|ne (?:sai[st]|savons|savent) (?:toujours )?pas|(?:do not|don t) (?:yet )?know|not sure)(?: encore| toujours| yet)? (?:quand|si|a quelle date|combien de temps|when|if|whether)\b/;
const COMMITTED_ACTION = /\b(?:(?:je|nous|on) (?:te |vous |le |la |les )?(?:livrer|corriger|resoudr|retablir|ajouter|integrer|deployer|activer|rembourser)(?:ai|a|ons)|(?:i|we) will (?:deliver|fix|resolve|restore|release|add|enable|refund))\b/;
const NEAR_FUTURE_ACTION = /\b(?:(?:je|nous|on) (?:vais|allons|va) (?:te |vous |le |la |les |l )?(?:livrer|corriger|resoudre|retablir|ajouter|integrer|deployer|activer|rembourser)|(?:i|we) (?:are|re|am|m) going to (?:deliver|fix|resolve|restore|release|add|enable|refund))\b/;
const COMMITTED_OUTCOME = /\b(?:sera|seront|will be|va etre) (?:pret\w*|disponible\w*|corrige\w*|resolu\w*|retabli\w*|livre\w*|ajoute\w*|integre\w*|gratuit\w*|ready|available|fixed|resolved|delivered|added|free)\b/;
const COMMITTED_PRICE = /\b(?:prix|tarif|price) (?:sera de|will be) \d/;

const isPromise = (clause: string, outcomeUncertain: boolean) =>
  COMMITTED_ACTION.test(clause) || NEAR_FUTURE_ACTION.test(clause) || (!outcomeUncertain && COMMITTED_OUTCOME.test(clause)) || COMMITTED_PRICE.test(clause);

/* The uncertainty covers only the proposition it governs: what comes before it (« sera disponible vendredi, même si nous ignorons quand… ») is still examined.
 * After an « ignorons quand » of the same sentence, a stated outcome is part of what is unknown; a committed action is not. */
function clauseIsPromise(clause: string, outcomeUncertain: boolean) {
  if (EXPLICIT_COMMITMENT.test(clause)) return true;
  if (NON_COMMITTAL_OUTCOME.test(clause)) return false;
  const unknown = UNKNOWN_DATE.exec(clause);
  return isPromise(unknown ? clause.slice(0, unknown.index) : clause, outcomeUncertain);
}

export function temporaryKnowledgePromise(text: string) {
  return sentencesOf(text).some(sentence => {
    let outcomeUncertain = false;
    return sentence.split(",").some(part => {
      const clauses = normalize(part).replace(/[^\p{L}\p{N}]+/gu, " ").split(/\b(?:mais|but)\b/);
      const promise = clauses.some(clause => clauseIsPromise(clause, outcomeUncertain));
      if (clauses.some(clause => UNKNOWN_DATE.test(clause))) outcomeUncertain = true;
      return promise;
    });
  });
}
