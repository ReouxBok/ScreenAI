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
  it("bounds the inflate of an object stream (decompression bomb)", () => {
    const bomb = zlib.deflateSync(Buffer.alloc(SAV_ATTACHMENT_PDF_LIMITS.inflatedBytes + 1, 32));
    const body = Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`, "latin1"), bomb,
      Buffer.from("\nendstream\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1")]);
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
