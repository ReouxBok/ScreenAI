import "server-only";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { SAV_ATTACHMENT_PDF_LIMITS } from "./attachment-contract";
import { isSavAdmittedImage, type SavAdmittedImage } from "./attachment-image";

export type SavAdmittedPdf = Readonly<{ bytes: Buffer; mimeType: "application/pdf"; pages: number; hash: string }>;
/** A file admitted for the visual call: a decoded image or a structurally checked PDF. */
export type SavAdmittedMedia = SavAdmittedImage | SavAdmittedPdf;
const admitted = new WeakSet<object>();
export function isSavAdmittedPdf(pdf: object) { return admitted.has(pdf); }
export function isSavPdfMedia(media: SavAdmittedMedia): media is SavAdmittedPdf { return media.mimeType === "application/pdf"; }
export function isSavAdmittedMedia(media: SavAdmittedMedia) { return isSavPdfMedia(media) ? isSavAdmittedPdf(media) : isSavAdmittedImage(media); }

/** Structural bounds of the reader below; anything beyond them is refused, never guessed. */
const PARSE = Object.freeze({ tokens: 2_000_000, objects: 100_000, depth: 64, stringBytes: 65_536, pageNodes: 10_000 });
const invalid = (): never => { throw new Error("invalid_pdf"); };

type Value = { t: "num"; v: number } | { t: "name"; v: string } | { t: "str" } | { t: "kw"; v: string } | { t: "ref"; id: number }
  | { t: "arr"; v: Value[] } | { t: "dict"; v: Map<string, Value> };
type Token = Value | { t: "<<" | ">>" | "[" | "]" };
const WHITE = new Set([0, 9, 10, 12, 13, 32]), DELIM = new Set([..."()<>[]{}/%"].map(c => c.charCodeAt(0)));

/** Tokens of the PDF syntax. Comments, literal/hex strings and #-escaped names are
 * read as the specification defines them, so document text never passes for structure. */
class Lexer {
  pos = 0; private count = 0;
  constructor(readonly s: string) {}
  next(): Token | null {
    const s = this.s;
    if (++this.count > PARSE.tokens) invalid();
    for (;;) {
      while (this.pos < s.length && WHITE.has(s.charCodeAt(this.pos))) this.pos++;
      if (s[this.pos] !== "%") break;
      while (this.pos < s.length && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++;
    }
    if (this.pos >= s.length) return null;
    const c = s[this.pos];
    if (c === "(") {
      const start = this.pos;
      for (let depth = 0; this.pos < s.length; this.pos++) {
        if (this.pos - start > PARSE.stringBytes) invalid();
        if (s[this.pos] === "\\") { this.pos++; continue; }
        if (s[this.pos] === "(") depth++;
        else if (s[this.pos] === ")" && --depth === 0) { this.pos++; return { t: "str" }; }
      }
      return invalid();
    }
    if (c === "<" && s[this.pos + 1] === "<") { this.pos += 2; return { t: "<<" }; }
    if (c === ">" && s[this.pos + 1] === ">") { this.pos += 2; return { t: ">>" }; }
    if (c === "<") {
      const end = s.indexOf(">", this.pos);
      if (end < 0 || end - this.pos > PARSE.stringBytes) invalid();
      this.pos = end + 1; return { t: "str" };
    }
    if (c === "[" || c === "]") { this.pos++; return { t: c }; }
    if ("{})>".includes(c)) { this.pos++; return { t: "kw", v: c }; }
    const start = c === "/" ? ++this.pos : this.pos;
    while (this.pos < s.length && !WHITE.has(s.charCodeAt(this.pos)) && !DELIM.has(s.charCodeAt(this.pos))) this.pos++;
    const raw = s.slice(start, this.pos);
    if (c === "/") return { t: "name", v: raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) };
    return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw) ? { t: "num", v: Number(raw) } : { t: "kw", v: raw };
  }
  /** One complete value; "n g R" becomes a reference. */
  value(token = this.next(), depth = 0): Value {
    if (!token || depth > PARSE.depth) return invalid();
    if (token.t === "<<") {
      const map = new Map<string, Value>();
      for (let key = this.next(); key?.t !== ">>"; key = this.next()) {
        if (key?.t !== "name") return invalid();
        map.set(key.v, this.value(undefined, depth + 1));
      }
      return { t: "dict", v: map };
    }
    if (token.t === "[") {
      const items: Value[] = [];
      for (let item = this.next(); item?.t !== "]"; item = this.next()) items.push(this.value(item, depth + 1));
      return { t: "arr", v: items };
    }
    if (token.t === ">>" || token.t === "]") return invalid();
    if (token.t === "num" && Number.isInteger(token.v) && token.v >= 0) {
      const saved = this.pos, gen = this.next(), r = this.next();
      if (gen?.t === "num" && Number.isInteger(gen.v) && r?.t === "kw" && r.v === "R") return { t: "ref", id: token.v };
      this.pos = saved;
    }
    return token as Value;
  }
}

type Definition = { at: number; value: Value; stream?: { start: number; end: number } };
const dict = (value: Value | undefined) => value?.t === "dict" ? value.v : undefined;
const name = (value: Value | undefined) => value?.t === "name" ? value.v : undefined;

/** Indirect objects (the latest definition wins, as in an incremental update), trailers
 * and stream extents. Stream contents are skipped, never read as structure. */
function readObjects(text: string) {
  const lexer = new Lexer(text), objects = new Map<number, Definition>(), trailers: { at: number; value: Map<string, Value> }[] = [];
  for (let token = lexer.next(); token; token = lexer.next()) {
    if (token.t === "kw" && token.v === "trailer") { const at = lexer.pos, value = dict(lexer.value()); if (value) trailers.push({ at, value }); continue; }
    if (token.t !== "num" || !Number.isInteger(token.v)) continue;
    const at = lexer.pos, gen = lexer.next(), keyword = lexer.next();
    if (gen?.t !== "num" || keyword?.t !== "kw" || keyword.v !== "obj") { lexer.pos = at; continue; }
    const value = lexer.value(), after = lexer.pos, follow = lexer.next();
    let stream: Definition["stream"];
    if (follow?.t === "kw" && follow.v === "stream") {
      let start = lexer.pos;
      if (text[start] === "\r") start++;
      if (text[start] === "\n") start++;
      const length = dict(value)?.get("Length"), direct = length?.t === "num" ? start + length.v : -1;
      const end = direct >= start && /^\s*endstream/.test(text.slice(direct, direct + 32)) ? direct : text.indexOf("endstream", start);
      if (end < 0) invalid();
      lexer.pos = end + "endstream".length;
      stream = { start, end };
    } else lexer.pos = after;
    if (objects.size >= PARSE.objects && !objects.has(token.v)) invalid();
    if ((objects.get(token.v)?.at ?? -1) < at) objects.set(token.v, { at, value, stream });
    // A cross-reference stream carries the trailer keys of its section.
    if (name(dict(value)?.get("Type")) === "XRef") trailers.push({ at, value: dict(value)! });
  }
  return { objects, trailers };
}

/** Compressed object streams (one Flate filter, no predictor) are expanded within the
 * inflate bound; their objects take the stream's position. Others stay unresolved. */
function expandObjectStreams(bytes: Buffer, objects: Map<number, Definition>) {
  let inflated = 0, streams = 0;
  for (const definition of [...objects.values()]) {
    const header = dict(definition.value);
    if (!definition.stream || !header || name(header.get("Type")) !== "ObjStm") continue;
    if (++streams > SAV_ATTACHMENT_PDF_LIMITS.objectStreams) invalid();
    const filter = header.get("Filter"), count = header.get("N"), first = header.get("First");
    const flate = name(filter) === "FlateDecode" || filter?.t === "arr" && filter.v.length === 1 && name(filter.v[0]) === "FlateDecode";
    if (!flate || header.has("DecodeParms") || count?.t !== "num" || first?.t !== "num" || count.v > PARSE.objects) continue;
    let decoded: string;
    try {
      const data = inflateSync(bytes.subarray(definition.stream.start, definition.stream.end), { maxOutputLength: SAV_ATTACHMENT_PDF_LIMITS.inflatedBytes - inflated });
      inflated += data.length; decoded = data.toString("latin1");
    } catch { return invalid(); }
    const lexer = new Lexer(decoded), entries: [number, number][] = [];
    for (let i = 0; i < count.v; i++) {
      const id = lexer.next(), offset = lexer.next();
      if (id?.t !== "num" || offset?.t !== "num") return invalid();
      entries.push([id.v, offset.v]);
    }
    for (const [id, offset] of entries) {
      lexer.pos = first.v + offset;
      const at = definition.at + 1, value = lexer.value();
      if ((objects.get(id)?.at ?? -1) < at) objects.set(id, { at, value });
    }
  }
}

/** Pages actually reachable from the document catalog. An unresolved node, a cycle or a
 * declared Count above the leaves found are all handled on the refusing side. */
function countPages(objects: Map<number, Definition>, root: Value | undefined) {
  const resolve = (value: Value | undefined) => value?.t === "ref" ? objects.get(value.id)?.value : value;
  const top = dict(resolve(root))?.get("Pages") ?? invalid(), seen = new Set<number>();
  let leaves = 0, nodes = 0;
  const walk = (reference: Value, depth: number): void => {
    if (reference.t === "ref") { if (seen.has(reference.id)) invalid(); seen.add(reference.id); }
    const node = dict(resolve(reference)) ?? invalid(), type = name(node.get("Type")), kids = resolve(node.get("Kids"));
    if (depth > PARSE.depth || ++nodes > PARSE.pageNodes) invalid();
    if (type === "Page" || type !== "Pages" && !kids) { leaves++; return; }
    if (kids?.t !== "arr") return invalid();
    for (const kid of kids.v) { walk(kid, depth + 1); if (leaves > SAV_ATTACHMENT_PDF_LIMITS.pages) return; }
  };
  walk(top, 0);
  const declared = resolve(dict(resolve(top))?.get("Count"));
  return Math.max(leaves, declared?.t === "num" ? declared.v : 0);
}

/** Admission before any model call: PDF signature and declared type, size, intact end of
 * file, then a bounded structural read: encryption from the trailers, pages from the
 * catalog's page tree. Nothing is rendered or executed locally. */
export function admitSavAttachmentPdf(bytes: Buffer, declaredMime: string): SavAdmittedPdf {
  if (!bytes.length || bytes.length > SAV_ATTACHMENT_PDF_LIMITS.bytes) throw new Error("byte_limit");
  if (bytes.toString("latin1", 0, 5) !== "%PDF-") throw new Error(declaredMime.toLowerCase() === "application/pdf" ? "invalid_pdf" : "type_mismatch");
  if (declaredMime.toLowerCase() !== "application/pdf") throw new Error("type_mismatch");
  const text = bytes.toString("latin1");
  if (!/%%EOF\s*$/.test(text.slice(-1024))) throw new Error("invalid_pdf");
  const { objects, trailers } = readObjects(text);
  if (!trailers.length) throw new Error("invalid_pdf");
  if (trailers.some(trailer => trailer.value.has("Encrypt"))) throw new Error("pdf_encrypted");
  expandObjectStreams(bytes, objects);
  const root = [...trailers].sort((a, b) => b.at - a.at).find(trailer => trailer.value.has("Root"))?.value.get("Root");
  const pages = countPages(objects, root);
  if (!pages) throw new Error("invalid_pdf");
  if (pages > SAV_ATTACHMENT_PDF_LIMITS.pages) throw new Error("page_limit");
  const result = Object.freeze({ bytes, mimeType: "application/pdf" as const, pages, hash: createHash("sha256").update(bytes).digest("hex") });
  admitted.add(result);
  return result;
}
