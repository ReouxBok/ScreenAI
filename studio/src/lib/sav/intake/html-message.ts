/** Some senders put a whole HTML document in their text/plain part. Derive
 * readable text without loading HTML, images or links. Ordinary text/fragments
 * are untouched; a missing closing document is never repaired as complete. */
export function intakeHtmlQuotedHistory(raw: string) {
  return /<blockquote\b|<(?:div|section|span)[^>]*\b(?:class|id)\s*=\s*(?:["'][^"']*\b)?(?:gmail_quote|yahoo_quoted|moz-cite-prefix|divRplyFwdMsg)\b/i.test(raw);
}
const documentStart = (raw: string) => /^\s*(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s[^>]*)?>/i.test(raw);
const documentEnd = (raw: string) => /<body(?:\s[^>]*)?>[\s\S]*<\/body\s*>[\s\S]*<\/html\s*>\s*$/i.test(raw);
export function intakeHtmlDocumentComplete(raw: string) {
  return !documentStart(raw) || documentEnd(raw) && !intakeHtmlQuotedHistory(raw);
}
export function intakeHtmlDocumentText(raw: string) {
  if (!documentStart(raw) || !intakeHtmlDocumentComplete(raw)) return raw;
  return raw.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (_, name: string) => ({nbsp:" ",amp:"&",lt:"<",gt:">",quot:'"',apos:"'","#39":"'"})[name.toLowerCase()]!)
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
