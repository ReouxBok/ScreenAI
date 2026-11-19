import { loginCustomerStatement } from "./restored-access";
import { splitSavMessageText } from "../message-context";
import type { CaseDecisionSourceRef, CaseDecisionValidationContext } from "./decision-contract";

/*
 * The shared text primitives of the decision validator (`decision-validator.ts`) and of its Access rules (`decision-validator-access.ts`), moved here
 * verbatim on 19/11 so the Access rules live apart from the generic ones. Pure: no model, network, database or clock.
 * The customer-statement patterns (`LOGIN_STATED`, `LOGIN_DOUBT`, `LOGIN_WORKS`) keep their historical names: the generic « step already done » reading uses them too.
 */

export const at = (value: string) => Date.parse(value);
export const sourceKey = (ref: CaseDecisionSourceRef) => `${ref.type}:${ref.id}`;
export const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`]/g, "'");
export const squash = (value: string) => normalize(value).replace(/[«»“”"]/g, "").replace(/\s+/g, " ").trim();
export const LOGIN_DOUBT = /\b(?:peut-etre|si|doute|pas sure?|pas certaine?|je ne sais pas|je crois|il me semble|vais|faut-il|dois-je)\b/;
export const LOGIN_STATED = /\b(?:j'ai (?:bien |deja |aussi |meme )*(?:essaye|utilise|verifie|ouvert|saisi|renseigne|entre|tape)|je suis (?:bien |deja )*passee? par)\b/;
export const LOGIN_WORKS = /\b(?:je suis (?:bien )?connectee?|j'ai (?:pu|reussi a) me connecter|ca (?:re)?(?:marche|fonctionne)(?! pas| plus| toujours)|c'est (?:bon|regle|resolu)|probleme (?:est )?resolu)\b/;
export const QUOTED = /[«"“][^»"”]*[»"”]/g;
/** The customer's own new words of a stored mail: never what they quote from us or from earlier mails. Review Q1 (8/11): read like the latest mail, a proven
 * signature (courtesy, name, phone, address, footer) set aside and anything else kept, so the history and the closure read the same words. */
export const ownCustomerWords = (raw: string) => normalize(loginCustomerStatement(splitSavMessageText(raw)));
// Contre-recette Q3-4/5/6 (9/11): a dot inside a web address (« le bon lien new.limova.ai et la bonne adresse ») does not end the sentence, or the address
// confirmed in the same sentence was lost and the step already done was given again.
export const sentencesOf = (text: string) => text.split(/[!?;\n]+|\.+(?![a-z0-9])/).map(sentence => sentence.trim()).filter(Boolean);
// Explicit opt-in only. Missing, false and unrecognised values keep the historical path.
export const smartValidator = () => process.env.SAV_V2_SMART_VALIDATOR === "true";

/** The customer's latest mail and their own statement in it (quoted history and signature set aside), when nothing from a person came after it.
 * Null: no such mail, not an e-mail, unreadable or too long. Moved verbatim from the Access login reading (`latestLoginMail`): every block's resolution proof reads it. */
export function latestCustomerMail(context: CaseDecisionValidationContext) {
  const latest = context.sources.filter(row => row.direction === "customer_inbound").sort((a, b) => b.order - a.order)[0];
  if (!latest || latest.ref.type !== "email" || context.sources.some(row => row.direction === "human_outbound" && row.order > latest.order)) return null;
  const raw = context.customerTexts[sourceKey(latest.ref)];
  if (!raw || raw.length > 100_000) return null;
  const parts = splitSavMessageText(raw);
  return { source: latest.ref, quote: loginCustomerStatement(parts) };
}
