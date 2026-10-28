import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { admitSavAttachmentPdf } from "./attachment-pdf";

// Fully indexed synthetic PDFs. Only the entries selected by the xref are live.
function fixture(kind: "baseline" | "duplicate" | "objstm" | "indirect-length", pages = 6) {
  let out = "%PDF-1.7\n";
  const offsets = new Map<number, number>();
  const append = (id: number, value: string, indexed = true) => {
    if (indexed) offsets.set(id, out.length);
    out += `${id} 0 obj\n${value}\nendobj\n`;
  };
  const tree = (ids: number[]) => `<< /Type /Pages /Count ${ids.length} /Kids [${ids.map(id => `${id} 0 R`).join(" ")}] >>`;
  append(1, "<< /Type /Catalog /Pages 2 0 R >>");
  append(2, tree(Array.from({ length: pages }, (_, i) => i + 3)));
  for (let id = 3; id < pages + 3; id++) append(id, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>");
  if (kind === "duplicate") append(2, tree([3]), false);
  if (kind === "objstm") {
    const header = "2 0 ", data = deflateSync(Buffer.from(header + tree([3])));
    append(20, `<< /Type /ObjStm /N 1 /First ${header.length} /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString("latin1")}\nendstream`);
  }
  if (kind === "indirect-length") {
    // Arbitrary metadata bytes: an indirect Length defines the real stream extent.
    const content = `prefix\nendstream\nendobj\n2 0 obj\n${tree([3])}\nendobj\nsuffix`;
    append(20, `<< /Length 21 0 R >>\nstream\n${content}\nendstream`);
    append(21, String(content.length));
  }
  const xref = out.length, size = Math.max(...offsets.keys()) + 1;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) out += offsets.has(id) ? `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n` : "0000000000 00000 f \n";
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = Buffer.from(out, "latin1");
  return bytes;
}

describe("REVIEWC002: authoritative PDF objects and stream extents", () => {
  it("keeps a six-page baseline refused", () => {
    expect(() => admitSavAttachmentPdf(fixture("baseline"), "application/pdf")).toThrow("page_limit");
  });
  it("cannot let an unindexed duplicate shrink a six-page indexed tree", () => {
    expect(() => admitSavAttachmentPdf(fixture("duplicate"), "application/pdf")).toThrow();
  });
  it("cannot replace a direct live tree with an unselected compressed object", () => {
    expect(() => admitSavAttachmentPdf(fixture("objstm"), "application/pdf")).toThrow();
  });
  it("does not read object declarations inside a stream with an indirect Length", () => {
    expect(() => admitSavAttachmentPdf(fixture("indirect-length"), "application/pdf")).toThrow();
  });
  it("still admits an ordinary one-page PDF", () => {
    expect(admitSavAttachmentPdf(fixture("baseline", 1), "application/pdf").pages).toBe(1);
  });
});
