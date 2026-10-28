import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { syntheticImage, syntheticPdf } from "../../../test/sav-attachments";
import { admitSavAttachmentPdf, isSavAdmittedMedia } from "./attachment-pdf";
import { SAV_ATTACHMENT_PDF_LIMITS } from "./attachment-contract";

describe("SAV-43 PDF admission before any model call", () => {
  it("admits a text PDF with its structural page count and a stable hash", () => {
    const bytes = syntheticPdf({ pages: 2 }), first = admitSavAttachmentPdf(bytes, "application/pdf");
    expect(first).toMatchObject({ mimeType: "application/pdf", pages: 2 });
    expect(isSavAdmittedMedia(first)).toBe(true);
    expect(admitSavAttachmentPdf(bytes, "APPLICATION/PDF").hash).toBe(first.hash);
  });
  it("admits a scanned PDF (one page image, no text layer); reading it is the provider's job", async () => {
    expect(admitSavAttachmentPdf(syntheticPdf({ scanned: await syntheticImage("jpeg") }), "application/pdf").pages).toBe(1);
  });
  it("admits exactly five pages and refuses six, counted from page objects or the declared tree", () => {
    expect(admitSavAttachmentPdf(syntheticPdf({ pages: SAV_ATTACHMENT_PDF_LIMITS.pages }), "application/pdf").pages).toBe(5);
    expect(() => admitSavAttachmentPdf(syntheticPdf({ pages: 6 }), "application/pdf")).toThrow("page_limit");
    // A tree that declares more pages than the objects found is taken at its word.
    expect(() => admitSavAttachmentPdf(syntheticPdf({ pages: 1, declaredCount: 9 }), "application/pdf")).toThrow("page_limit");
  });
  it("counts pages hidden in a compressed object stream and refuses one it cannot decode", () => {
    expect(admitSavAttachmentPdf(syntheticPdf({ pages: 2, objectStream: "flate", declaredCount: 1 }), "application/pdf").pages).toBe(2);
    expect(() => admitSavAttachmentPdf(syntheticPdf({ pages: 6, objectStream: "flate", declaredCount: 1 }), "application/pdf")).toThrow("page_limit");
    expect(() => admitSavAttachmentPdf(syntheticPdf({ pages: 2, objectStream: "lzw", declaredCount: 1 }), "application/pdf")).toThrow("invalid_pdf");
  });
  it("bounds the inflate of a compressed stream (decompression bomb)", () => {
    // The bomb is the cross-reference stream itself, so it is decoded before anything else.
    const bomb = zlib.deflateSync(Buffer.alloc(SAV_ATTACHMENT_PDF_LIMITS.inflatedBytes + 1, 32));
    const body = Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /XRef /Size 2 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`, "latin1"), bomb,
      Buffer.from("\nendstream\nendobj\nstartxref\n9\n%%EOF\n", "latin1")]);
    expect(body.length).toBeLessThan(SAV_ATTACHMENT_PDF_LIMITS.bytes);
    expect(() => admitSavAttachmentPdf(body, "application/pdf")).toThrow("invalid_pdf");
  });
  it("refuses an encrypted PDF", () => {
    expect(() => admitSavAttachmentPdf(syntheticPdf({ encrypted: true }), "application/pdf")).toThrow("pdf_encrypted");
  });
  it("refuses corrupt, truncated, structureless and empty PDFs", () => {
    const bytes = syntheticPdf();
    expect(() => admitSavAttachmentPdf(bytes.subarray(0, bytes.length - 40), "application/pdf")).toThrow("invalid_pdf");
    expect(() => admitSavAttachmentPdf(Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"), "application/pdf")).toThrow("invalid_pdf");
    expect(() => admitSavAttachmentPdf(Buffer.from("not a pdf at all, %%EOF"), "application/pdf")).toThrow("invalid_pdf");
    expect(() => admitSavAttachmentPdf(Buffer.alloc(0), "application/pdf")).toThrow("byte_limit");
  });
  it("refuses an oversize PDF before parsing it", () => {
    expect(() => admitSavAttachmentPdf(Buffer.concat([syntheticPdf(), Buffer.alloc(SAV_ATTACHMENT_PDF_LIMITS.bytes)]), "application/pdf")).toThrow("byte_limit");
  });
  it("refuses a disguised file in either direction", async () => {
    expect(() => admitSavAttachmentPdf(syntheticPdf(), "image/png")).toThrow("type_mismatch");
    const png = await syntheticImage();
    expect(() => admitSavAttachmentPdf(png, "image/png")).toThrow("type_mismatch");
    expect(() => admitSavAttachmentPdf(png, "application/pdf")).toThrow("invalid_pdf");
  });
  it("never trusts a copied object as admitted", () => {
    expect(isSavAdmittedMedia({ ...admitSavAttachmentPdf(syntheticPdf(), "application/pdf") })).toBe(false);
  });
});

/** Hand-written object sets with a valid xref; an optional appended incremental section. */
function pdfFrom(objects: Record<number, string>, trailer: string, update?: { objects: Record<number, string>; trailer: string }) {
  let out = "%PDF-1.7\n";
  const section = (set: Record<number, string>, tail: string, prev?: number) => {
    const offsets: [number, number][] = [];
    for (const [id, body] of Object.entries(set)) { offsets.push([Number(id), out.length]); out += `${id} 0 obj\n${body}\nendobj\n`; }
    const start = out.length;
    out += `xref\n${offsets.map(([id, at]) => `${id} 1\n${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n${tail.replace(">>", `${prev === undefined ? "" : ` /Prev ${prev}`} >>`)}\nstartxref\n${start}\n%%EOF\n`;
    return start;
  };
  const first = section(objects, trailer);
  if (update) section(update.objects, update.trailer, first);
  return Buffer.from(out, "latin1");
}
const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>";
const tree = (ids: number[]) => `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(" ")}] /Count ${ids.length} >>`;

describe("SAV-43 review: structure is read, document text is not", () => {
  it("decodes # escapes in every structural name, not only in the reviewed spelling", () => {
    const objects = { 1: "<< /T#79pe /Cat#61log /P#61ges 2 0 R >>", 2: "<< /#54ype /#50ages /#4Bids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R 8 0 R] /C#6Funt 6 >>" } as Record<number, string>;
    for (let id = 3; id <= 8; id++) objects[id] = "<< /Type /P#61ge /Parent 2 0 R >>";
    expect(() => admitSavAttachmentPdf(pdfFrom(objects, "<< /Size 9 /R#6F#6Ft 1 0 R >>"), "application/pdf")).toThrow("page_limit");
  });
  it("counts only pages reachable from the catalog, not orphan page dictionaries or strings", () => {
    const objects: Record<number, string> = { 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: tree([3]), 3: page, 9: "<< /Title (/Type /Page /Encrypt 1 0 R) /Producer <2F456E6372797074> >>" };
    for (let id = 10; id < 16; id++) objects[id] = page;
    expect(admitSavAttachmentPdf(pdfFrom(objects, "<< /Size 16 /Root 1 0 R /Info 9 0 R >>"), "application/pdf").pages).toBe(1);
  });
  it("reads encryption from the trailer only, whatever its spelling, and from a cross-reference stream", () => {
    const base = { 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: tree([3]), 3: page, 4: "<< /Filter /Standard /V 2 /R 3 >>" };
    expect(() => admitSavAttachmentPdf(pdfFrom(base, "<< /Size 5 /Root 1 0 R /Encr#79pt 4 0 R >>"), "application/pdf")).toThrow("pdf_encrypted");
    expect(admitSavAttachmentPdf(pdfFrom({ ...base, 5: "<< /Encrypt 4 0 R >>" }, "<< /Size 6 /Root 1 0 R >>"), "application/pdf").pages).toBe(1);
    // The cross-reference stream is the trailer of its section: an Encrypt key there counts.
    expect(() => admitSavAttachmentPdf(syntheticPdf({ pages: 2, objectStream: "flate", encrypted: true }), "application/pdf")).toThrow("pdf_encrypted");
    // An XRef-typed object that no startxref or Prev designates is not a section.
    const stray = { ...base, 6: "<< /Type /XRef /Size 7 /Root 1 0 R /Encrypt 4 0 R /W [1 2 1] /Length 0 >>\nstream\n\nendstream" };
    expect(admitSavAttachmentPdf(pdfFrom(stray, "<< /Size 7 /Root 1 0 R >>"), "application/pdf").pages).toBe(1);
  });
  it("follows the latest incremental update of the page tree in both directions", () => {
    const one = { 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: tree([3]), 3: page };
    const six = { 2: tree([3, 4, 5, 6, 7, 8]), 4: page, 5: page, 6: page, 7: page, 8: page };
    expect(() => admitSavAttachmentPdf(pdfFrom(one, "<< /Size 4 /Root 1 0 R >>", { objects: six, trailer: "<< /Size 9 /Root 1 0 R >>" }), "application/pdf")).toThrow("page_limit");
    const back = { ...one, ...six }, shrink = { objects: { 2: tree([3, 4]) }, trailer: "<< /Size 9 /Root 1 0 R >>" };
    expect(admitSavAttachmentPdf(pdfFrom(back, "<< /Size 9 /Root 1 0 R >>", shrink), "application/pdf").pages).toBe(2);
  });
  it("stays bounded in time on a 4 MiB file of tokens or of nested arrays", () => {
    // The catalog the xref designates is the oversized value, so the reader has to parse it.
    const base = "%PDF-1.7\n1 0 obj\n[", room = SAV_ATTACHMENT_PDF_LIMITS.bytes - base.length - 200;
    const tail = (xref: number) => `]\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    for (const filler of ["0 ".repeat(room / 2), "[".repeat(room)]) {
      const started = performance.now(), body = base + filler;
      expect(() => admitSavAttachmentPdf(Buffer.from(body + tail(body.length + "]\nendobj\n".length), "latin1"), "application/pdf")).toThrow("invalid_pdf");
      expect(performance.now() - started).toBeLessThan(3000);
    }
  });
  it("refuses a cyclic, unresolved or rootless page tree instead of guessing a count", () => {
    const cyclic = { 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", 3: "<< /Type /Pages /Kids [2 0 R] /Count 1 >>" };
    expect(() => admitSavAttachmentPdf(pdfFrom(cyclic, "<< /Size 4 /Root 1 0 R >>"), "application/pdf")).toThrow("invalid_pdf");
    expect(() => admitSavAttachmentPdf(pdfFrom({ 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: tree([3]) }, "<< /Size 3 /Root 1 0 R >>"), "application/pdf")).toThrow("invalid_pdf");
    expect(() => admitSavAttachmentPdf(pdfFrom({ 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: tree([3]), 3: page }, "<< /Size 4 >>"), "application/pdf")).toThrow("invalid_pdf");
  });
});

describe("SAV-43 review c002a60: the cross-reference sections are the authority", () => {
  const six = () => { const objects: Record<number, string> = { 1: "<< /Type /Catalog /Pages 2 0 R >>", 2: tree([3, 4, 5, 6, 7, 8]) }; for (let id = 3; id <= 8; id++) objects[id] = page; return objects; };
  it("ends a stream exactly at its indirect Length; bytes inside it are never structure", () => {
    const content = `endstream\nendobj\n2 0 obj\n${tree([3])}\nendobj\ntrailer\n<< /Root 1 0 R >>\n`;
    const streamed = (length: number) => ({ ...six(), 3: `<< /Type /Page /Parent 2 0 R /Length 9 0 R >>\nstream\n${content}\nendstream`, 9: String(length) });
    expect(() => admitSavAttachmentPdf(pdfFrom(streamed(content.length), "<< /Size 10 /Root 1 0 R >>"), "application/pdf")).toThrow("page_limit");
    // A Length that does not land on endstream is refused, never repaired by a search.
    expect(() => admitSavAttachmentPdf(pdfFrom(streamed(9), "<< /Size 10 /Root 1 0 R >>"), "application/pdf")).toThrow("invalid_pdf");
  });
  it("reads an entry's object only with the number and generation the xref and the reference give", () => {
    const bytes = pdfFrom(six(), "<< /Size 9 /Root 1 0 R >>").toString("latin1");
    const offset = (id: number) => String(bytes.indexOf(`\n${id} 0 obj\n`) + 1).padStart(10, "0");
    // The entry of object 2 designates object 3: the xref is not qualifiable.
    expect(() => admitSavAttachmentPdf(Buffer.from(bytes.replace(`2 1\n${offset(2)}`, `2 1\n${offset(3)}`), "latin1"), "application/pdf")).toThrow("invalid_pdf");
    // A reference to another generation is the null object, not the live tree.
    expect(() => admitSavAttachmentPdf(pdfFrom({ ...six(), 1: "<< /Type /Catalog /Pages 2 1 R >>" }, "<< /Size 9 /Root 1 0 R >>"), "application/pdf")).toThrow("invalid_pdf");
  });
  it("refuses a file whose startxref or Prev chain cannot be followed", () => {
    const bytes = pdfFrom(six(), "<< /Size 9 /Root 1 0 R >>").toString("latin1");
    expect(() => admitSavAttachmentPdf(Buffer.from(bytes.replace(/startxref\n\d+/, "startxref\n12"), "latin1"), "application/pdf")).toThrow("invalid_pdf");
    const looped = pdfFrom(six(), "<< /Size 9 /Root 1 0 R >>").toString("latin1"), start = /startxref\n(\d+)/.exec(looped)![1];
    expect(() => admitSavAttachmentPdf(Buffer.from(looped.replace("/Root 1 0 R", `/Root 1 0 R /Prev ${start}`), "latin1"), "application/pdf")).toThrow("invalid_pdf");
  });
});
