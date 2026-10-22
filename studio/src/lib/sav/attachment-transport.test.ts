import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { requestSavGeminiJson, withSavAiBudget, withSavAttachmentReadBudget } from "./gemini-transport";
import { admitSavAttachmentImage } from "./attachment-image";
import { syntheticImage } from "../../../test/sav-attachments";
import { geminiFixture } from "../../../test/sav-understanding-fixtures";
const textBody = { contents: [{ role: "user", parts: [{ text: "Capture synthétique, aucune donnée réelle." }] }], generationConfig: { maxOutputTokens: 4096 } };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("admits a real image larger than the text JSON capacity through the typed path only", async () => {
  const raw = Buffer.alloc(512 * 512 * 3); let seed = 83;
  for (let i = 0; i < raw.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; raw[i] = seed >>> 24; }
  const image = await admitSavAttachmentImage(await sharp(raw, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer(), "image/png");
  expect(image.bytes.length).toBeGreaterThan(262144);
  const network = vi.fn<typeof fetch>(async () => geminiFixture({ ok: true }));
  await requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [image], fetch: network });
  const request = JSON.parse(String(network.mock.calls[0][1]!.body));
  expect(request.contents[0].parts[1].mediaResolution.level).toBe("MEDIA_RESOLUTION_HIGH"); expect(network).toHaveBeenCalledOnce();
  await expect(requestSavGeminiJson({ phase: "understanding", apiKey: "fixture", model: "gemini-3.6-flash", body: { ...textBody, contents: [{ parts: [{ inlineData: { data: image.bytes.toString("base64"), mimeType: "image/png" } }] }] }, fetch: network })).rejects.toThrow("SAV_AI_MEDIA_ADMISSION_REQUIRED");
  expect(network).toHaveBeenCalledOnce();
});
it("rejects invented media objects, altered bytes and unsupported model admission", async () => {
  const image = await admitSavAttachmentImage(await syntheticImage(), "image/png"), network = vi.fn();
  await expect(requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [{ ...image }], fetch: network })).rejects.toThrow("SAV_AI_MEDIA_ADMISSION_REQUIRED");
  await expect(requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "other-model", body: textBody, media: [image], fetch: network })).rejects.toThrow("SAV_AI_MEDIA_UNSUPPORTED_MODEL");
  image.bytes[30] ^= 1;
  await expect(requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [image], fetch: network })).rejects.toThrow("SAV_AI_MEDIA_ADMISSION_REQUIRED");
  expect(network).not.toHaveBeenCalled();
});
it("shares correlation and allowances, reserves continuation capacity, permits no second visual call", async () => {
  const image = await admitSavAttachmentImage(await syntheticImage(), "image/png"), network = vi.fn<typeof fetch>(async () => geminiFixture({ ok: true }));
  await withSavAiBudget(async () => {
    const visual = await requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [image], fetch: network });
    const next = await requestSavGeminiJson({ phase: "understanding", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, fetch: network });
    expect(visual.metadata.transport!.correlationId).toBe(next.metadata.transport!.correlationId);
    await expect(requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [image], fetch: network })).rejects.toThrow("SAV_AI_BUDGET_EXCEEDED");
  });
  expect(network).toHaveBeenCalledTimes(2);
});
it("preserves three following model calls by refusing a late visual admission", async () => {
  const image = await admitSavAttachmentImage(await syntheticImage(), "image/png"), network = vi.fn<typeof fetch>(async () => geminiFixture({ ok: true }));
  await withSavAiBudget(async () => {
    for (let i = 0; i < 3; i++) await requestSavGeminiJson({ phase: "ticket_matching", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, fetch: network });
    await expect(requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [image], fetch: network })).rejects.toThrow("SAV_AI_BUDGET_EXCEEDED");
  });
  expect(network).toHaveBeenCalledTimes(3);
});
it("counts download/decode time in the shared allowance and times out vision without retry", async () => {
  const image = await admitSavAttachmentImage(await syntheticImage(), "image/png");
  vi.useFakeTimers();
  const network = vi.fn<typeof fetch>((_, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("synthetic", "AbortError")))));
  const pending = withSavAiBudget(async () => {
    await withSavAttachmentReadBudget(() => new Promise(resolve => setTimeout(resolve, 11_000)));
    return requestSavGeminiJson({ phase: "attachment_reading", apiKey: "fixture", model: "gemini-3.6-flash", body: textBody, media: [image], fetch: network });
  });
  const rejected = expect(pending).rejects.toMatchObject({ message: "SAV_AI_TIMEOUT", metadata: { transport: { attempts: 1, retries: 0 } } });
  await vi.advanceTimersByTimeAsync(26_000); await rejected;
  expect(network).toHaveBeenCalledOnce();
});
