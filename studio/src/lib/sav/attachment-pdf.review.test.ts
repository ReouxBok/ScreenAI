import { describe, expect, it } from "vitest";
import { admitSavAttachmentPdf } from "./attachment-pdf";
import { syntheticPdf } from "../../../test/sav-attachments";

// Rebuild offsets after a legal PDF name spelling change; no stale xref fixture.
function rewritePdf(bytes: Buffer, rewrite: (body: string, id: number) => string) {
  const entries = [...bytes.toString("latin1").matchAll(/^(\d+) 0 obj\n([\s\S]*?)\nendobj$/gm)];
  const parts = ["%PDF-1.7\n"], offsets = new Map<number, number>();
  let length = parts[0].length;
  for (const entry of entries) {
    const id = Number(entry[1]); offsets.set(id, length);
    const part = `${id} 0 obj\n${rewrite(entry[2], id)}\nendobj\n`;
    parts.push(part); length += Buffer.byteLength(part, "latin1");
  }
  const count = Math.max(...offsets.keys()) + 1;
  parts.push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) parts.push(offsets.has(id) ? `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n");
  parts.push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`);
  return Buffer.from(parts.join(""), "latin1");
}

describe("REVIEW962 PDF admission", () => {
  it("refuses six pages even when five Page names and the Count name use legal # escapes", () => {
    let firstPage = true;
    const bytes = rewritePdf(syntheticPdf({ pages: 6 }), body => body
      .replace(/\/Count\b/g, "/Co#75nt")
      .replace(/\/Page\b/g, () => { if (firstPage) { firstPage = false; return "/Page"; } return "/Pag#65"; }));
    expect(() => admitSavAttachmentPdf(bytes, "application/pdf")).toThrow("page_limit");
  });
  it("does not count PDF content-string text as actual page dictionaries", () => {
    const bytes = syntheticPdf({ pages: 1, text: "/Type /Page /Type /Page /Type /Page /Type /Page /Type /Page /Type /Page" });
    expect(admitSavAttachmentPdf(bytes, "application/pdf").pages).toBe(1);
  });
  it("does not classify an unencrypted document as encrypted because of visible text", () => {
    const bytes = syntheticPdf({ text: "Error /Encrypt unsupported" });
    expect(admitSavAttachmentPdf(bytes, "application/pdf").pages).toBe(1);
  });
  it("control: ordinary six-page input is refused", () => {
    expect(() => admitSavAttachmentPdf(syntheticPdf({ pages: 6 }), "application/pdf")).toThrow("page_limit");
  });
  it("control: escaped spelling does not change the catalog's six children", () => {
    const bytes = rewritePdf(syntheticPdf({ pages: 6 }), body => body.replace(/\/Count\b/g, "/Co#75nt"));
    expect(() => admitSavAttachmentPdf(bytes, "application/pdf")).toThrow("page_limit");
  });
});
