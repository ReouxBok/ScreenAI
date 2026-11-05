import { splitSavMessageText } from "../message-context";

// A transport may append its name (e.g. Outlook) to an otherwise unambiguous statement.
// Remove only complete known footer lines at the end; preserve any personal name or new
// sentence so that a retraction or an additional request is never silently discarded.
const COURTESY_LINE = /^(?:--|(?:bien )?cordialement|bien à(?: (?:vous|toi|tous|à))?|best regards|kind regards)[,.! ]*$/i;
const MOBILE_FOOTER = /^envoyé (?:à partir d[e’'] ?|depuis |de )(?:mon |l['’])?outlook (?:pour|sur) (?:ios|android)(?:\s*<?https:\/\/aka\.ms\/[a-z0-9_-]+>?)?\.?$/i;

export function loginCustomerStatement(parts: ReturnType<typeof splitSavMessageText>): string {
  const lines = [parts.currentText, parts.signatureText].filter(Boolean).join("\n").trimEnd().split("\n");
  // Outlook places its separator immediately before the quoted From/Sent/To headers.
  // Remove this last line only, once. Text on either side of an earlier divider remains.
  if (parts.parts.at(-1)?.kind === "quoted" && /^\s*(?:De|From)\s*:/i.test(parts.quotedText)
    && /^\s*_{8,}\s*$/.test(lines.at(-1) ?? "")) lines.pop();
  while (lines.length) {
    const last = lines[lines.length - 1]!.trim();
    if (last && !MOBILE_FOOTER.test(last) && !COURTESY_LINE.test(last)) break;
    lines.pop();
  }
  return lines.join("\n").trim();
}

// This signal resumes investigation and ends the memory of earlier failed login attempts.
// Closure still needs a later customer source, every request resolved and an independent verdict.
const RESOLUTION_RETURN = /^(?:(?:bonjour|merci(?: beaucoup)?)[\s,.!:;-]+)*(?:[cç]a (?:re)?(?:marche|fonctionne)|(?:tout|la connexion) (?:re)?fonctionne|j'ai (?:pu|reussi a) me (?:re)?connecter|je suis (?:bien )?(?:re)?connectee?)(?: (?:bien|maintenant|de nouveau|a nouveau))*(?: (?:depuis|sur|avec) (?:l'autre|un autre|le nouveau|ce) navigateur)?[\s,.!:;-]*(?:(?:merci(?: beaucoup)?|bonne journee)[\s,.!;-]*)*$/;
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
