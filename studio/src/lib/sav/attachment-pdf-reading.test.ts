/** SAV-43: PDFs join the existing visual read (same provider, slots, bytes and call budget). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySavAttachmentVisualResult, prepareSavAttachmentSelection, savVisualMediaInput } from "./attachment-reader";
import { requestSavGeminiJson, savGeminiWireBody, withSavAiBudget } from "./gemini-transport";
import { admitSavAttachmentPdf } from "./attachment-pdf";
import { SAV_ATTACHMENT_PDF_LIMITS } from "./attachment-contract";
import { attachmentMetadata, pdfMetadata, syntheticImage, syntheticPdf } from "../../../test/sav-attachments";
import { geminiFixture } from "../../../test/sav-understanding-fixtures";

const expected = { mailboxEmail: "contact@limova.ai", gmailMessageId: "gmail-fixture", gmailThreadId: "thread-fixture" };
const textBody = { contents: [{ role: "user", parts: [{ text: "Document synthétique, aucune donnée réelle." }] }], generationConfig: { maxOutputTokens: 4096 } };
const visual = (index: number, readability = "readable", text = "Facture fictive F-001. Erreur E42.") => ({ index, readability, text, uncertainties: [], regions: [] });
afterEach(() => vi.restoreAllMocks());

describe("selection", () => {
  it("keeps PDFs unread and undownloaded while the switch is off (SAV-42 behaviour)", async () => {
    const bytes = syntheticPdf(), download = vi.fn(async () => bytes);
    const prepared = await withSavAiBudget(() => prepareSavAttachmentSelection({ metadata: [pdfMetadata(bytes.length)], expected }, { download }));
    expect(download).not.toHaveBeenCalled();
    expect(prepared.observations[0]).toMatchObject({ status: "unsupported", reason: "unsupported_type", fileHash: null });
    expect(prepared.selected).toHaveLength(0);
  });
  it("admits a text PDF and a scanned PDF as visual files without image dimensions", async () => {
    const files = [syntheticPdf({ pages: 2 }), syntheticPdf({ scanned: await syntheticImage("jpeg") })];
    const download = vi.fn().mockResolvedValueOnce(files[0]).mockResolvedValueOnce(files[1]);
    const prepared = await withSavAiBudget(() => prepareSavAttachmentSelection({ pdf: true, metadata: files.map((f, i) => pdfMetadata(f.length, String(i + 1))), expected }, { download }));
    expect(prepared.selected).toHaveLength(2);
    expect(prepared.observations.map(o => [o.width, o.height, o.reason])).toEqual([[null, null, "in_progress"], [null, null, "in_progress"]]);
    expect(prepared.uniqueImages.map(savVisualMediaInput)).toEqual([{ index: 0, kind: "pdf", pages: 2 }, { index: 1, kind: "pdf", pages: 1 }]);
  });
  it("records encrypted, corrupt, too long and oversize PDFs with their precise durable reason", async () => {
    const good = syntheticPdf(), files = [syntheticPdf({ encrypted: true }), good.subarray(0, good.length - 40), syntheticPdf({ pages: 6 })];
    // Declared oversize first: refused before download, it takes no slot (a downloaded file does).
    const metadata = [pdfMetadata(SAV_ATTACHMENT_PDF_LIMITS.bytes + 1, "4"), ...files.map((f, i) => pdfMetadata(f.length, String(i + 1)))];
    const download = vi.fn().mockResolvedValueOnce(files[0]).mockResolvedValueOnce(files[1]).mockResolvedValueOnce(files[2]);
    const prepared = await withSavAiBudget(() => prepareSavAttachmentSelection({ pdf: true, metadata, expected }, { download }));
    expect(download).toHaveBeenCalledTimes(3);
    expect(prepared.observations.map(o => [o.status, o.reason, o.fileHash])).toEqual([["not_read", "byte_limit", null], ["not_read", "pdf_encrypted", null], ["not_read", "invalid_pdf", null], ["not_read", "page_limit", null]]);
    expect(prepared.selected).toHaveLength(0);
  });
  it("shares the three visual slots and the byte total between images and PDFs, in mail order", async () => {
    const image = await syntheticImage(), pdf = syntheticPdf();
    const metadata = [attachmentMetadata(image.length, "1"), pdfMetadata(pdf.length, "2"), attachmentMetadata(image.length, "3"), pdfMetadata(pdf.length, "4")];
    const download = vi.fn(async (_ref: unknown, _size: number, _signal: AbortSignal, mime?: string) => mime === "application/pdf" ? pdf : image);
    const prepared = await withSavAiBudget(() => prepareSavAttachmentSelection({ pdf: true, metadata, expected }, { download }));
    expect(prepared.selected.map(s => s.image.mimeType)).toEqual(["image/png", "application/pdf", "image/png"]);
    expect(prepared.observations[3].reason).toBe("image_limit");
    // Identical image bytes are sent once; the PDF keeps its own index.
    expect(prepared.uniqueImages.map(m => m.mimeType)).toEqual(["image/png", "application/pdf"]);
  });
});

describe("transport", () => {
  it("sends an admitted PDF inline as application/pdf at medium resolution and reserves per page", async () => {
    const pdf = admitSavAttachmentPdf(syntheticPdf({ pages: 3 }), "application/pdf"), image = await (await import("./attachment-image")).admitSavAttachmentImage(await syntheticImage(), "image/png");
    const wire = savGeminiWireBody({ phase: "understanding", model: "gemini-3.6-flash", body: textBody, media: [image, pdf] });
    const parts = JSON.parse(wire.body).contents[0].parts;
    expect(parts.slice(1).map((p: { inlineData: { mimeType: string }; mediaResolution: { level: string } }) => [p.inlineData.mimeType, p.mediaResolution.level]))
      .toEqual([["image/png", "MEDIA_RESOLUTION_HIGH"], ["application/pdf", "MEDIA_RESOLUTION_MEDIUM"]]);
    expect(Buffer.from(parts[2].inlineData.data, "base64").equals(pdf.bytes)).toBe(true);
    expect(wire.mediaAllowance).toBe(4096 + 3 * 2048);
  });
  it("rejects a copied PDF object (its page count cannot be raised on the frozen admitted one) and altered bytes", async () => {
    const pdf = admitSavAttachmentPdf(syntheticPdf(), "application/pdf"), network = vi.fn();
    expect(Object.isFrozen(pdf)).toBe(true);
    await expect(requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [{ ...pdf, pages: 9 }], fetch: network })).rejects.toThrow("SAV_AI_MEDIA_ADMISSION_REQUIRED");
    pdf.bytes[20] ^= 1;
    await expect(requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [pdf], fetch: network })).rejects.toThrow("SAV_AI_MEDIA_ADMISSION_REQUIRED");
    expect(network).not.toHaveBeenCalled();
  });
  it("counts a PDF in the single visual call of an analysis budget", async () => {
    const pdf = admitSavAttachmentPdf(syntheticPdf(), "application/pdf"), network = vi.fn<typeof fetch>(async () => geminiFixture({ ok: true }));
    await withSavAiBudget(async () => {
      await requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [pdf], fetch: network });
      await expect(requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [pdf], fetch: network })).rejects.toThrow("SAV_AI_BUDGET_EXCEEDED");
    });
    expect(network).toHaveBeenCalledOnce();
  });
});

describe("observations", () => {
  async function prepared() {
    const bytes = syntheticPdf({ pages: 2 });
    return withSavAiBudget(() => prepareSavAttachmentSelection({ pdf: true, metadata: [pdfMetadata(bytes.length)], expected }, { download: async () => bytes }));
  }
  it("masks personal and banking data and keeps an unreadable scan empty, never read", async () => {
    const read = applySavAttachmentVisualResult(await prepared(), { images: [visual(0, "readable", "Facture F-001 pour client@example.test, IBAN FR76 3000 6000 0112 3456 7890 189, mot de passe: secret-fictif")] });
    expect(read[0]).toMatchObject({ status: "analyzed", reason: "observed" });
    expect(read[0].text).toContain("Facture F-001");
    expect(read[0].text).not.toMatch(/client@example\.test|3456 7890|secret-fictif/);
    const unreadable = applySavAttachmentVisualResult(await prepared(), { images: [visual(0, "unreadable", "Montant supposé 120 €")] });
    expect(unreadable[0]).toMatchObject({ status: "unreadable", reason: "unreadable_content", text: "", regions: [] });
  });
  it("keeps a partly readable PDF partial and refuses an extract above the bound instead of truncating it silently", async () => {
    expect(applySavAttachmentVisualResult(await prepared(), { images: [visual(0, "partial")] })[0]).toMatchObject({ status: "partial", reason: "partial_content" });
    const again = await prepared();
    expect(() => applySavAttachmentVisualResult(again, { images: [visual(0, "readable", "x".repeat(4001))] })).toThrow();
  });
});
