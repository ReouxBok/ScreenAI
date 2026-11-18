// SAV-94: the plain-text layout of a V2 reply body, applied ONCE when the proposal is prepared (`caseReplyBody` in `case-reply-outbound.ts`), so the text that is
// stored, shown, hashed, approved and sent is the laid-out one. Never in `reply-format.ts`: V1 and a person's own replies keep their shared format, and texts already
// stored (and hashed) stay valid there.
// SAFE by construction: it only moves line breaks, turns a "1)" step into "1.", and removes Markdown bold markers ("**x**", "__x__") and leading "#" headings.
// It never changes, reorders, drops or splits a word, never touches a link, an email address or a code, and leaves anything it is unsure about as is.
// Pure and idempotent: layout(layout(x)) === layout(x).

/** A numbered step at the very start of a line: "1. text" or "1) text". */
const STEP = /^(\d{1,2})[.)][ \t]+(?=\S)/;
const HEADING = /^#{1,6}[ \t]+(?=\S)/;
/** Links, addresses and anything glued to them: protected as a whole, so a "*" or "_" inside them is never read as Markdown. */
const PROTECTED = /(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/gi;
/** What may close a bold pair: the end, a space, or punctuation itself followed by a space or the end (so "__init__.py" or "**a**.b" is a code, kept). */
const CLOSE = String.raw`(?=$|\s|[.,;:!?)»"'’”](?:\s|$))`;
/** A bold marker pair around words without "*" (resp. "_") inside, opened after a space or an opening punctuation. */
const BOLD_STAR = new RegExp(String.raw`(^|[\s(«"'’“])\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*` + CLOSE, "g");
const BOLD_UNDERSCORE = new RegExp(String.raw`(^|[\s(«"'’“])__([^_\s](?:[^_\n]*[^_\s])?)__` + CLOSE, "g");

function stripMarkdown(line: string): string {
  if (line.includes("\u0000")) return line;
  const kept: string[] = [];
  let text = line.replace(PROTECTED, match => `\u0000${kept.push(match) - 1}\u0000`);
  text = text.replace(HEADING, "");
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(BOLD_STAR, "$1$2").replace(BOLD_UNDERSCORE, "$1$2");
  }
  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => kept[Number(index)]!);
}

function layoutOnce(text: string): string {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = stripMarkdown(raw.replace(/[ \t]+$/, ""));
    const step = STEP.exec(line);
    if (step) {
      line = `${step[1]}.${line.slice(step[1]!.length + 1)}`;
      // One blank line before every step: between a paragraph and its list, and between two steps.
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    }
    lines.push(line);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The laid-out body. Words, their order and links are unchanged; only blank lines, "1)" -> "1." and Markdown bold/heading markers move. */
export function layoutCaseReplyBody(text: string): string {
  let current = layoutOnce(String(text ?? ""));
  for (let pass = 0; pass < 8; pass++) {
    const next = layoutOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}
