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
const PARSE = Object.freeze({ tokens: 2_000_000, objects: 100_000, depth: 64, stringBytes: 65_536, pageNodes: 10_000, sections: 64 });
function invalid(): never { throw new Error("invalid_pdf"); }

type Value = { t: "num"; v: number } | { t: "name"; v: string } | { t: "str" } | { t: "kw"; v: string } | { t: "ref"; id: number; gen: number }
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
      if (gen?.t === "num" && Number.isInteger(gen.v) && r?.t === "kw" && r.v === "R") return { t: "ref", id: token.v, gen: gen.v };
      this.pos = saved;
    }
    return token as Value;
  }
}

type Entry = { at: number; gen: number } | { stream: number; index: number } | null;
type Definition = { value: Value; stream?: { start: number; end: number } };
const NULL: Value = { t: "kw", v: "null" };
const dict = (value: Value | undefined) => value?.t === "dict" ? value.v : undefined;
const name = (value: Value | undefined) => value?.t === "name" ? value.v : undefined;
const integer = (value: Value | Token | null | undefined) => value?.t === "num" && Number.isInteger(value.v) && value.v >= 0 ? value.v : invalid();

/** The document as its cross-reference sections define it. Only the object an entry
 * designates, at its offset and with its number and generation, is ever read: a
 * definition the xref does not select has no effect, and a stream ends exactly where its
 * Length says, or the file is refused. Nothing is searched for in the bytes. */
class PdfDocument {
  readonly trailers: Map<string, Value>[] = [];
  private readonly lexer: Lexer;
  private readonly entries = new Map<number, Entry>();
  private readonly cache = new Map<number, Definition>();
  private readonly resolving = new Set<number>();
  private readonly objectStreams = new Map<number, { lexer: Lexer; first: number; pairs: [number, number][] }>();
  private inflated = 0;

  constructor(private readonly bytes: Buffer, private readonly text: string) {
    this.lexer = new Lexer(text);
    const tail = text.lastIndexOf("startxref");
    if (tail < 0 || tail < text.length - 1024) invalid();
    this.lexer.pos = tail + "startxref".length;
    const visited = new Set<number>();
    const visit = (at: number) => { if (visited.has(at) || visited.size >= PARSE.sections) invalid(); visited.add(at); };
    // Newest section first: an entry already known is never overridden by an older one.
    for (let at: number | undefined = integer(this.lexer.next()); at !== undefined;) {
      visit(at);
      const trailer = this.section(at, false), hybrid = trailer.get("XRefStm"), prev = trailer.get("Prev");
      if (hybrid) { visit(integer(hybrid)); this.section(integer(hybrid), true); }
      at = prev === undefined ? undefined : integer(prev);
    }
  }

  resolve(value: Value | undefined): Value | undefined {
    return value?.t === "ref" ? this.object(value.id, value.gen).value : value;
  }

  /** One cross-reference section: a classic table with its trailer, or a cross-reference
   * stream whose dictionary is the trailer. */
  private section(at: number, streamOnly: boolean) {
    if (at >= this.text.length) invalid();
    const lexer = this.lexer, entries = new Map<number, Entry>(), add = (id: number, entry: Entry) => {
      if (entries.has(id) || this.entries.size + entries.size >= PARSE.objects) invalid();
      entries.set(id, entry);
    };
    lexer.pos = at;
    const keyword = lexer.next();
    let trailer: Map<string, Value>;
    if (!streamOnly && keyword?.t === "kw" && keyword.v === "xref") {
      for (;;) {
        const token = lexer.next();
        if (token?.t === "kw" && token.v === "trailer") { trailer = dict(lexer.value()) ?? invalid(); break; }
        const start = integer(token), count = integer(lexer.next());
        for (let i = 0; i < count; i++) {
          const offset = integer(lexer.next()), gen = integer(lexer.next()), kind = lexer.next();
          if (kind?.t !== "kw" || kind.v !== "n" && kind.v !== "f") invalid();
          add(start + i, kind.v === "n" ? { at: offset, gen } : null);
        }
      }
    } else {
      const definition = this.parse(at, undefined, true);
      trailer = dict(definition.value) ?? invalid();
      if (name(trailer.get("Type")) !== "XRef" || !definition.stream) invalid();
      const widths = trailer.get("W"), size = integer(trailer.get("Size")), index = trailer.get("Index") ?? { t: "arr", v: [{ t: "num", v: 0 }, { t: "num", v: size }] };
      if (widths?.t !== "arr" || widths.v.length !== 3 || index.t !== "arr" || index.v.length % 2) invalid();
      const w = widths.v.map(integer), width = w[0] + w[1] + w[2], data = this.decode(trailer, definition.stream);
      if (w.some(n => n > 8) || !width) invalid();
      let row = 0;
      for (let k = 0; k < index.v.length; k += 2) {
        const start = integer(index.v[k]), count = integer(index.v[k + 1]);
        for (let i = 0; i < count; i++, row++) {
          if ((row + 1) * width > data.length) invalid();
          let at = row * width;
          const field = (n: number, fallback: number) => { if (!n) return fallback; let v = 0; for (let b = 0; b < n; b++) v = v * 256 + data[at++]; return v; };
          const type = field(w[0], 1), a = field(w[1], 0), b = field(w[2], 0);
          add(start + i, type === 1 ? { at: a, gen: b } : type === 2 ? { stream: a, index: b } : null);
        }
      }
    }
    for (const [id, entry] of entries) if (!this.entries.has(id)) this.entries.set(id, entry);
    this.trailers.push(trailer);
    return trailer;
  }

  /** The live definition of an object. A reference whose generation is not the selected
   * one, or that a section frees, is the null object, as the specification defines. */
  private object(id: number, gen: number): Definition {
    const entry = this.entries.get(id);
    if (!entry || ("at" in entry ? entry.gen : 0) !== gen) return { value: NULL };
    const cached = this.cache.get(id);
    if (cached) return cached;
    if (this.resolving.has(id) || this.cache.size >= PARSE.objects) invalid();
    this.resolving.add(id);
    const definition = "at" in entry ? this.parse(entry.at, { id, gen }, false) : { value: this.compressed(id, entry) };
    this.resolving.delete(id);
    this.cache.set(id, definition);
    return definition;
  }

  /** "id gen obj" at the designated offset, with exactly the expected number and generation. */
  private parse(at: number, expected: { id: number; gen: number } | undefined, directLength: boolean): Definition {
    const lexer = this.lexer;
    lexer.pos = at;
    const id = integer(lexer.next()), gen = integer(lexer.next()), keyword = lexer.next();
    if (keyword?.t !== "kw" || keyword.v !== "obj" || expected && (id !== expected.id || gen !== expected.gen)) invalid();
    const value = lexer.value(), follow = lexer.next();
    if (follow?.t !== "kw" || follow.v !== "stream") return { value };
    let start = lexer.pos;
    if (this.text[start] === "\r") start++;
    if (this.text[start] === "\n") start++;
    const length = (dict(value) ?? invalid()).get("Length");
    const end = start + integer(directLength ? length : this.resolve(length));
    if (end > this.text.length || !/^[\0\t\n\f\r ]{0,8}endstream/.test(this.text.slice(end, end + 18))) invalid();
    return { value, stream: { start, end } };
  }

  /** An object stored in an object stream, checked against the stream's own index. */
  private compressed(id: number, entry: { stream: number; index: number }) {
    let set = this.objectStreams.get(entry.stream);
    if (!set) {
      const container = this.entries.get(entry.stream);
      if (!container || !("at" in container) || this.objectStreams.size >= SAV_ATTACHMENT_PDF_LIMITS.objectStreams) invalid();
      const definition = this.object(entry.stream, 0), header = dict(definition.value) ?? invalid();
      if (!definition.stream || name(header.get("Type")) !== "ObjStm") invalid();
      const count = integer(header.get("N")), first = integer(header.get("First"));
      if (count > PARSE.objects) invalid();
      const lexer = new Lexer(this.decode(header, definition.stream).toString("latin1")), pairs: [number, number][] = [];
      for (let i = 0; i < count; i++) pairs.push([integer(lexer.next()), integer(lexer.next())]);
      set = { lexer, first, pairs };
      this.objectStreams.set(entry.stream, set);
    }
    const pair = set.pairs[entry.index];
    if (!pair || pair[0] !== id) invalid();
    set.lexer.pos = set.first + pair[1];
    return set.lexer.value();
  }

  /** Stream data: unfiltered, or one Flate filter within the shared inflate bound, with an
   * optional PNG predictor (as cross-reference streams use). Anything else is refused. */
  private decode(header: Map<string, Value>, extent: { start: number; end: number }) {
    const raw = this.bytes.subarray(extent.start, extent.end), filter = header.get("Filter"), parms = header.get("DecodeParms");
    const filters = filter === undefined ? [] : filter.t === "arr" ? filter.v : [filter];
    if (!filters.length && parms === undefined) return raw;
    if (filters.length !== 1 || name(filters[0]) !== "FlateDecode") return invalid();
    const options = parms === undefined ? new Map<string, Value>() : dict(parms.t === "arr" && parms.v.length === 1 ? parms.v[0] : parms) ?? invalid();
    let data: Buffer;
    try { data = inflateSync(raw, { maxOutputLength: SAV_ATTACHMENT_PDF_LIMITS.inflatedBytes - this.inflated }); } catch { return invalid(); }
    this.inflated += data.length;
    const setting = (key: string, fallback: number) => options.has(key) ? integer(options.get(key)) : fallback;
    const predictor = setting("Predictor", 1);
    if (predictor === 1) return data;
    if (predictor < 10 || predictor > 15 || setting("Colors", 1) !== 1 || setting("BitsPerComponent", 8) !== 8) invalid();
    return unpredict(data, setting("Columns", 1));
  }
}

/** PNG row filters, one byte per pixel. */
function unpredict(data: Buffer, columns: number) {
  const row = columns + 1;
  if (!columns || data.length % row) invalid();
  const out = Buffer.alloc(data.length / row * columns);
  for (let r = 0; r * row < data.length; r++) {
    const type = data[r * row], at = r * columns;
    for (let c = 0; c < columns; c++) {
      const a = c ? out[at + c - 1] : 0, b = r ? out[at - columns + c] : 0, d = r && c ? out[at - columns + c - 1] : 0;
      const p = a + b - d, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - d);
      const base = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : d) : invalid();
      out[at + c] = (data[r * row + 1 + c] + base) & 255;
    }
  }
  return out;
}

/** Pages actually reachable from the document catalog. An unresolved node, a cycle or a
 * declared Count above the leaves found are all handled on the refusing side. */
function countPages(document: PdfDocument, root: Value | undefined) {
  const top = dict(document.resolve(root))?.get("Pages") ?? invalid(), seen = new Set<number>();
  let leaves = 0, nodes = 0;
  const walk = (reference: Value, depth: number): void => {
    if (reference.t === "ref") { if (seen.has(reference.id)) invalid(); seen.add(reference.id); }
    const node = dict(document.resolve(reference)) ?? invalid(), type = name(node.get("Type")), kids = document.resolve(node.get("Kids"));
    if (depth > PARSE.depth || ++nodes > PARSE.pageNodes) invalid();
    if (type === "Page" || type !== "Pages" && !kids) { leaves++; return; }
    if (kids?.t !== "arr") return invalid();
    for (const kid of kids.v) { walk(kid, depth + 1); if (leaves > SAV_ATTACHMENT_PDF_LIMITS.pages) return; }
  };
  walk(top, 0);
  const declared = document.resolve(dict(document.resolve(top))?.get("Count"));
  return Math.max(leaves, declared?.t === "num" ? declared.v : 0);
}

/** Admission before any model call: PDF signature and declared type, size, intact end of
 * file, then a bounded structural read through the cross-reference sections: encryption
 * from their trailers, pages from the catalog's page tree. A structure whose authority
 * cannot be established is refused as an unread file. Nothing is rendered or executed. */
export function admitSavAttachmentPdf(bytes: Buffer, declaredMime: string): SavAdmittedPdf {
  if (!bytes.length || bytes.length > SAV_ATTACHMENT_PDF_LIMITS.bytes) throw new Error("byte_limit");
  if (bytes.toString("latin1", 0, 5) !== "%PDF-") throw new Error(declaredMime.toLowerCase() === "application/pdf" ? "invalid_pdf" : "type_mismatch");
  if (declaredMime.toLowerCase() !== "application/pdf") throw new Error("type_mismatch");
  const text = bytes.toString("latin1");
  if (!/%%EOF\s*$/.test(text.slice(-1024))) throw new Error("invalid_pdf");
  const document = new PdfDocument(bytes, text);
  if (document.trailers.some(trailer => trailer.has("Encrypt"))) throw new Error("pdf_encrypted");
  const pages = countPages(document, document.trailers.find(trailer => trailer.has("Root"))?.get("Root"));
  if (!pages) throw new Error("invalid_pdf");
  if (pages > SAV_ATTACHMENT_PDF_LIMITS.pages) throw new Error("page_limit");
  const result = Object.freeze({ bytes, mimeType: "application/pdf" as const, pages, hash: createHash("sha256").update(bytes).digest("hex") });
  admitted.add(result);
  return result;
}
