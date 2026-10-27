import sharp from "sharp";
import zlib from "node:zlib";
import { attachmentSkeleton } from "../src/lib/sav/attachment-reader";
import { SAV_ATTACHMENT_READER_REVISION, type SavAttachmentMetadata, type SavAttachmentRead } from "../src/lib/sav/attachment-contract";
export const attachmentMessageId = "00000000-0000-4000-8000-000000000083";
export function attachmentMetadata(size = 100, partId = "1"): SavAttachmentMetadata {
  return { filename: "capture-fictive.png", mimeType: "image/png", size, reference: { version: 1, mailboxEmail: "contact@limova.ai", gmailMessageId: "gmail-fixture", gmailThreadId: "thread-fixture", partId, attachmentId: "attachment-fixture", contentId: null, disposition: "attachment" } };
}
export function attachmentRead(items: SavAttachmentMetadata[] = [attachmentMetadata()]): SavAttachmentRead {
  return { version: 1, readerRevision: SAV_ATTACHMENT_READER_REVISION, model: "gemini-3.6-flash", messageId: attachmentMessageId,
    mailboxId: "00000000-0000-4000-8000-000000000001", gmailMessageId: "gmail-fixture", selectionHash: "fixture", claimId: "00000000-0000-4000-8000-000000000002",
    state: "complete", startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(), observations: items.map(attachmentSkeleton) };
}
export function observedAttachment() {
  const read = attachmentRead();
  read.observations[0] = { ...read.observations[0], status: "analyzed", reason: "observed", text: "Erreur E42. Version 7.2.", fileHash: "a".repeat(64), width: 100, height: 100 };
  return read;
}
export function syntheticImage(format: "png" | "jpeg" | "webp" = "png") {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } }).toFormat(format).toBuffer();
}
/** SAV-43: synthetic PDFs built object by object (valid xref), no real document. */
export function syntheticPdf(options: { pages?: number; text?: string; scanned?: Buffer; encrypted?: boolean; objectStream?: "flate" | "lzw"; declaredCount?: number } = {}) {
  const pages = options.pages ?? 1, objects: (string | Buffer)[] = [];
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${options.declaredCount ?? pages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const imageId = 4 + pages * 2;
  pageIds.forEach((id, i) => {
    const resources = options.scanned ? `<< /XObject << /Im0 ${imageId} 0 R >> >>` : "<< /Font << /F1 3 0 R >> >>";
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${id + 1} 0 R >>`;
    const content = options.scanned ? "q 595 0 0 842 0 0 cm /Im0 Do Q" : `BT /F1 12 Tf 72 760 Td (${(options.text ?? "Erreur E42 page") + " " + (i + 1)}) Tj ET`;
    objects[id + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  if (options.scanned) objects[imageId] = Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 64 /Height 48 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${options.scanned.length} >>\nstream\n`, "latin1"), options.scanned, Buffer.from("\nendstream", "latin1")]);
  if (options.objectStream) {
    // Page objects moved into one compressed object stream, as modern writers do.
    const inner = pageIds.map(id => objects[id] as string), header = pageIds.map((id, i) => `${id} ${inner.slice(0, i).reduce((n, o) => n + o.length + 1, 0)}`).join(" ") + "\n";
    const raw = Buffer.from(header + inner.join("\n"), "latin1"), data = options.objectStream === "flate" ? zlib.deflateSync(raw) : raw;
    const id = objects.length;
    objects[id] = Buffer.concat([Buffer.from(`<< /Type /ObjStm /N ${pages} /First ${header.length} /Filter /${options.objectStream === "flate" ? "FlateDecode" : "LZWDecode"} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
    for (const pageId of pageIds) objects[pageId] = "null";
  }
  const encryptId = objects.length;
  if (options.encrypted) objects[encryptId] = "<< /Filter /Standard /V 2 /R 3 /Length 128 /O <00> /U <00> /P -4 >>";
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")], offsets: number[] = [];
  let length = parts[0].length;
  for (let id = 1; id < objects.length; id++) {
    if (objects[id] === undefined) continue;
    offsets[id] = length;
    const chunk = Buffer.concat([Buffer.from(`${id} 0 obj\n`, "latin1"), Buffer.isBuffer(objects[id]) ? objects[id] as Buffer : Buffer.from(objects[id] as string, "latin1"), Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk); length += chunk.length;
  }
  const xref = [`xref\n0 ${objects.length}\n0000000000 65535 f \n`, ...Array.from({ length: objects.length - 1 }, (_, i) => offsets[i + 1] === undefined ? "0000000000 65535 f \n" : `${String(offsets[i + 1]).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length} /Root 1 0 R${options.encrypted ? ` /Encrypt ${encryptId} 0 R /ID [<00><00>]` : ""} >>\nstartxref\n${length}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
export function pdfMetadata(size: number, partId = "1"): SavAttachmentMetadata {
  return { ...attachmentMetadata(size, partId), filename: "document-fictif.pdf", mimeType: "application/pdf" };
}
