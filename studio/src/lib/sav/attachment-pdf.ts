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

const PAGE = /\/Type\s*\/Page(?![A-Za-z0-9#])/g;
const COUNT = /\/Type\s*\/Pages(?![A-Za-z0-9#])[\s\S]{0,400}?\/Count\s+(\d{1,7})|\/Count\s+(\d{1,7})[\s\S]{0,400}?\/Type\s*\/Pages(?![A-Za-z0-9#])/g;

/** Structural pages of one decoded text: page objects or the largest declared page-tree count,
 * whichever is higher. Incremental updates may count a page twice; that only refuses more. */
function pagesIn(text: string) {
  const objects = [...text.matchAll(PAGE)].length;
  let declared = 0;
  for (const match of text.matchAll(COUNT)) declared = Math.max(declared, Number(match[1] ?? match[2]));
  return Math.max(objects, declared);
}

/** Page objects hidden in compressed object streams are decoded with a bounded inflate.
 * Any object stream that cannot be decoded leaves the page count unknown: refused. */
function objectStreamTexts(text: string, bytes: Buffer) {
  const texts: string[] = [];
  let inflated = 0, streams = 0;
  for (const match of text.matchAll(/(?<!end)stream\r?\n/g)) {
    const start = match.index! + match[0].length, head = text.slice(Math.max(0, match.index! - 4096), match.index!);
    const dictionary = head.slice(head.lastIndexOf(" obj") + 1);
    if (!/\/Type\s*\/ObjStm(?![A-Za-z0-9#])/.test(dictionary)) continue;
    if (++streams > SAV_ATTACHMENT_PDF_LIMITS.objectStreams) throw new Error("invalid_pdf");
    let end = text.indexOf("endstream", start);
    if (end > start && text[end - 1] === "\n") end -= text[end - 2] === "\r" ? 2 : 1;
    // A single Flate filter without predictor; any other encoding is not decoded here.
    if (end < 0 || /\/DecodeParms/.test(dictionary) || !/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])(?![A-Za-z0-9#])/.test(dictionary)) throw new Error("invalid_pdf");
    try {
      const decoded = inflateSync(bytes.subarray(start, end), { maxOutputLength: SAV_ATTACHMENT_PDF_LIMITS.inflatedBytes - inflated });
      inflated += decoded.length;
      texts.push(decoded.toString("latin1"));
    } catch { throw new Error("invalid_pdf"); }
  }
  return texts;
}

/** Admission before any model call: PDF signature and declared type, size, intact end
 * of file, no encryption, a page count read from the structure within the bound.
 * Nothing is rendered or executed locally; content is only read by the provider. */
export function admitSavAttachmentPdf(bytes: Buffer, declaredMime: string): SavAdmittedPdf {
  if (!bytes.length || bytes.length > SAV_ATTACHMENT_PDF_LIMITS.bytes) throw new Error("byte_limit");
  if (bytes.toString("latin1", 0, 5) !== "%PDF-") throw new Error(declaredMime.toLowerCase() === "application/pdf" ? "invalid_pdf" : "type_mismatch");
  if (declaredMime.toLowerCase() !== "application/pdf") throw new Error("type_mismatch");
  const text = bytes.toString("latin1");
  if (!/%%EOF\s*$/.test(text.slice(-1024))) throw new Error("invalid_pdf");
  if (/\/Encrypt(?![A-Za-z0-9#])/.test(text)) throw new Error("pdf_encrypted");
  const pages = Math.max(pagesIn(text), ...objectStreamTexts(text, bytes).map(pagesIn));
  if (!pages) throw new Error("invalid_pdf");
  if (pages > SAV_ATTACHMENT_PDF_LIMITS.pages) throw new Error("page_limit");
  const result = Object.freeze({ bytes, mimeType: "application/pdf" as const, pages, hash: createHash("sha256").update(bytes).digest("hex") });
  admitted.add(result);
  return result;
}
