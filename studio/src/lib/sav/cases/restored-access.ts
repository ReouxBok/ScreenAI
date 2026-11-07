import { splitSavMessageText } from "../message-context";

// A closing block the customer or the mail client adds under the statement: courtesy, a name, a role or company, a phone, a postal or web address, a mail client
// footer. Review F4 (7/11): such a block no longer hides « ça marche » or « toujours rien ». Only a block made ENTIRELY of these lines, at the very end, is set
// aside; a line that is not one of them (a sentence, a question, a request) stops the block, so everything from it on stays in the statement and is read.
// The block is only set aside for reading the meaning: callers still scan the whole mail, signature included, for a sensitive request.
const COURTESY = String.raw`(?:(?:bien |tres )?cordialement|(?:bien|tres bien) a (?:vous|toi|tous)|(?:sinceres |meilleures |bien )?salutations(?: distinguees)?|bonne (?:journee|soiree|fin de journee)|belle journee|a bientot|merci(?: beaucoup)?(?: d'avance| par avance)?|best regards|kind regards|regards|thanks)`;
const COURTESY_LINE = new RegExp(String.raw`^(?:--|${COURTESY})[,.! ]*$`);
const MOBILE_FOOTER = /^(?:envoye (?:a partir d[e'] ?|depuis |de )(?:mon |l')?(?:outlook (?:pour|sur) (?:ios|android)|iphone|ipad|smartphone|mobile|telephone)(?:\s*<?https:\/\/aka\.ms\/[a-z0-9_-]+>?)?|sent from my (?:iphone|ipad|phone|mobile))\.?$/;
// A name as people sign: one to five capitalised words or initials, with the usual particles. Read on the original casing.
const NAME_WORD = String.raw`(?:\p{Lu}[\p{Ll}'’-]+(?:-\p{Lu}[\p{Ll}'’-]+)?|\p{Lu}\.|\p{Lu}{2,}(?:[-'’]\p{Lu}+)*)`;
const NAME_LINE = new RegExp(String.raw`^${NAME_WORD}(?:\s+(?:${NAME_WORD}|de|du|des|la|le|van|von|di|da))*$`, "u");
// Words that are an answer, never a name: « Ça marche.\nNon » must not lose its « Non ».
const NOT_A_NAME = /^(?:non|oui|si|rien|toujours|jamais|pas|plus|mais|aucun|aucune|stop|bloque|bloquee|urgent|encore|pareil|idem|ah|oh|ok|bon|bof|super|merci|help|svp|bonjour|bonsoir|autre|question|probleme|souci|demande|aide|erreur|bug)$/;
const PHONE_LINE = /^(?:(?:tel|telephone|mobile|portable|fixe|ligne directe|standard|phone)\s*[.:]?\s*)?\+?\d[\d\s().\/-]{6,}$/;
const WEB_LINE = /^(?:(?:e-?mail|mail|site|web)\s*:\s*)?(?:[\w.+%-]+@[\w.-]+\.[a-z]{2,}|(?:https?:\/\/|www\.)\S+)$/;
const ADDRESS_LINE = /^(?:\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|av\.|bd|boulevard|place|chemin|allee|impasse|route|quai|cours)\b.{0,60}|\d{5}\s+[a-z' -]{2,40}|(?:cedex|france|belgique|suisse))$/;
// A role or company line: short, no sentence, no first or second person, no login words, nothing asked.
const ROLE_FORBIDDEN = /[?!]|\b(?:je|j'|tu|vous|nous|on|il|elle|me|m'|mon|ma|mes|ne|n'|pas|plus|toujours|rien|jamais|code|connect\w*|acces|marche|fonctionne|bloque\w*|merci|svp|aussi|contre|mais|est|sont|ai|as|a|veux|voudrais|souhaite|peux|pouvez|ps)\b/;

const plain = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
const nameLine = (line: string) => NAME_LINE.test(line) && line.split(/\s+/).every(word => !NOT_A_NAME.test(plain(word)));
const courtesyWithName = (line: string) => {
  const match = new RegExp(String.raw`^(${COURTESY})[,.!]?\s+(.+)$`).exec(plain(line));
  return Boolean(match && nameLine(line.slice(line.length - match[2]!.length).trim()));
};
const roleLine = (line: string) => line.length <= 60 && /^[\p{Lu}\d]/u.test(line) && line.split(/\s+/).length <= 7 && !/\.$/.test(line) && !ROLE_FORBIDDEN.test(plain(line));
type SignatureLine = "head" | "body" | null;
function signatureLine(line: string): SignatureLine {
  const value = plain(line);
  if (COURTESY_LINE.test(value) || MOBILE_FOOTER.test(value) || courtesyWithName(line)) return "head";
  if (nameLine(line)) return "head";
  if (PHONE_LINE.test(value) || WEB_LINE.test(value) || ADDRESS_LINE.test(value) || roleLine(line)) return "body";
  return null;
}

/** Index of the first line of the closing block at the end of `lines`, or `lines.length` when there is none. */
function closingBlockStart(lines: readonly string[]): number {
  let start = lines.length;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line) continue;
    if (!signatureLine(line)) break;
    start = index;
  }
  // The block must open on a closing line (courtesy, separator, footer or a name), never on a role or a phone, and a bare name only after a finished sentence
  // or a blank line: « Ça marche\nNon » keeps its last word.
  while (start < lines.length) {
    const head = lines[start]!.trim();
    if (!head) { start += 1; continue; }
    const kind = signatureLine(head), value = plain(head);
    const before = lines.slice(0, start), previous = before.filter(line => line.trim()).at(-1)?.trim() ?? "";
    const separated = before.length > 0 && (!before.at(-1)!.trim() || /[.!?…]$/.test(previous));
    const closing = COURTESY_LINE.test(value) || MOBILE_FOOTER.test(value) || courtesyWithName(head);
    if (kind === "head" && previous && (closing || separated)) return start;
    start += 1;
  }
  return lines.length;
}

export function loginCustomerStatement(parts: ReturnType<typeof splitSavMessageText>): string {
  const lines = [parts.currentText, parts.signatureText].filter(Boolean).join("\n").trimEnd().split("\n");
  // Outlook places its separator immediately before the quoted From/Sent/To headers.
  // Remove this last line only, once. Text on either side of an earlier divider remains.
  if (parts.parts.at(-1)?.kind === "quoted" && /^\s*(?:De|From)\s*:/i.test(parts.quotedText)
    && /^\s*_{8,}\s*$/.test(lines.at(-1) ?? "")) lines.pop();
  return lines.slice(0, closingBlockStart(lines)).join("\n").trim();
}

// This signal resumes investigation and ends the memory of earlier failed login attempts.
// Closure still needs a later customer source, every request resolved and an independent verdict.
const RESOLUTION_RETURN = /^(?:(?:bonjour|bonsoir|merci(?: beaucoup)?|c'est bon|super|parfait|top|genial)[\s,.!:;-]+)*(?:[cç]a (?:re)?(?:marche|fonctionne)|(?:tout|la connexion) (?:re)?fonctionne|j'ai (?:pu|reussi a) me (?:re)?connecter|je suis (?:bien )?(?:re)?connectee?)(?: (?:bien|maintenant|de nouveau|a nouveau))*(?: (?:depuis|sur|avec) (?:l'autre|un autre|le nouveau|ce) navigateur)?[\s,.!:;-]*(?:(?:merci(?: beaucoup)?|bonne journee)[\s,.!;-]*)*$/;
const RESTORED = /^(?:(?:bonjour|bonsoir|merci(?: beaucoup)?)[\s,.!:;-]+)*(?:(?:j'ai|nous avons) (?:retrouve|recupere) (?:(?:mon|notre) historique et )?(?:l'(?:utilisation|usage) de limova|(?:mon |notre |l')?acces (?:a limova|a (?:mon|notre) compte))|(?:je peux|nous pouvons) (?:a nouveau|de nouveau) utiliser limova)(?: (?:normalement|maintenant))?[\s,.!:;-]*(?:(?:merci(?: beaucoup)?|bonne journee)[\s,.!;-]*)*$/;

export function reportsRestoredAccess(ownCustomerWords: string): boolean {
  if (ownCustomerWords.length > 300) return false;
  const value = ownCustomerWords.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
  return RESOLUTION_RETURN.test(value) || RESTORED.test(value);
}

/** Only the whole statement can mean "same login issue". Additional topics must be qualified independently. */
export function reportsOngoingLoginFailure(value: string): boolean {
  return /^(?:(?:bonjour|bonsoir|merci(?: beaucoup)?)[\s,.!:;-]+)*(?:mais )?(?:[cç]a|cela) ne (?:marche|fonctionne) (?:toujours |encore )?pas[\s,.!:;-]*$/i.test(value.trim());
}
