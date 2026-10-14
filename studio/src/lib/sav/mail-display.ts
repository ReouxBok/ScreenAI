import { splitSavMessageText } from "./message-context";

/** Display only. Forwarded originals and interleaved answers are not disposable
 * quote history. Analysis/storage keep the unchanged email and their own parser. */
export function savMailDisplay(raw: string) {
  const split = splitSavMessageText(raw);
  const forwarded = /^\s*(?:[- ]*(?:Forwarded message|Message transféré|Original Message|Message d['’]origine)[- :]*|Begin forwarded message:)\s*$/im.test(raw);
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const quotedStart = split.parts.find(part => part.kind === "quoted")?.startLine;
  const tail = quotedStart ? lines.slice(quotedStart - 1) : [];
  const firstPrefixedQuote = tail.findIndex(line => /^\s*>/.test(line));
  const interleaved = firstPrefixedQuote >= 0 && tail.slice(firstPrefixedQuote + 1).some(line => line.trim() && !/^\s*>/.test(line));
  const ambiguous = forwarded || interleaved;
  return { text: ambiguous ? raw.trim().slice(0, 100_000) : split.currentText,
    warning: ambiguous ? "Ce message contient un transfert ou des réponses intercalées. Le texte est conservé pour ne pas masquer une partie de la demande." : raw.length > 100_000 ? "L’aperçu est limité. Le texte intégral reste accessible dans la conversation." : null,
    ambiguous };
}
