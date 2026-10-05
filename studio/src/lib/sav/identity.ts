export type SavIdentityHints = { names: string[]; phones: string[] };
export type SavIdentityCandidate = { contactId: string; name: string; email: string; phoneHint: string; matchedBy: "name" | "phone"; confirmed: false };
export function extractSavIdentityHints(body: string, displayName = ""): SavIdentityHints {
  const names = [displayName.trim(), ...Array.from(body.matchAll(/(?:^|\n)\s*(?:nom\s*:|je m['’]appelle|mon nom est)\s+([\p{L}'’ -]{3,100})(?=\r?\n|$)/giu), (match) => match[1].trim())]
    .filter((name) => /^[\p{L}'’ -]{3,100}$/u.test(name) && name.split(/\s+/).length >= 2).slice(0, 2);
  const phones = Array.from(body.matchAll(/(?:tél(?:éphone)?|tel(?:ephone)?|mobile|joignable|numéro)\s*[:=]?\s*(\+?[\d ()\.-]{9,24})/giu), (match) => match[1].replace(/\D/g, ""))
    .filter((value) => value.length >= 9 && value.length <= 15).slice(0, 2);
  return { names: [...new Set(names)], phones: [...new Set(phones)] };
}
export function phoneMatchesHint(stored: string, hint: string) {
  const digits = stored.replace(/\D/g, "");
  return digits.length >= 9 && hint.length >= 9 && digits.slice(-9) === hint.slice(-9);
}
