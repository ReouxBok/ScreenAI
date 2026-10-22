import { expect, it } from "vitest";
import sharp from "sharp";
import { syntheticImage } from "../../../test/sav-attachments";
import { admitSavAttachmentImage } from "./attachment-image";
import { SAV_ATTACHMENT_LIMITS } from "./attachment-contract";
it.each(["png", "jpeg", "webp"] as const)("fully decodes a synthetic %s with bounded pixels and stable hash", async format => {
  const bytes = await syntheticImage(format), mime = `image/${format}`;
  const first = await admitSavAttachmentImage(bytes, mime);
  expect(first).toMatchObject({ width: 64, height: 48, mimeType: mime });
  expect((await admitSavAttachmentImage(bytes, mime)).hash).toBe(first.hash);
});
it("rejects empty, malformed, truncated and disguised images", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("<svg>malicious</svg>"), (await syntheticImage()).subarray(0, 40)]) await expect(admitSavAttachmentImage(bytes, "image/png")).rejects.toThrow(/byte_limit|invalid_image/);
  await expect(admitSavAttachmentImage(await syntheticImage("jpeg"), "image/png")).rejects.toThrow("type_mismatch");
});
it("checks compressed and raster bounds before allocating the claimed giant raster", async () => {
  await expect(admitSavAttachmentImage(Buffer.alloc(SAV_ATTACHMENT_LIMITS.imageBytes + 1), "image/png")).rejects.toThrow("byte_limit");
  const png = await syntheticImage(); png.writeUInt32BE(100_000, 16); png.writeUInt32BE(100_000, 20);
  await expect(admitSavAttachmentImage(png, "image/png")).rejects.toThrow("pixel_limit");
});
it("accepts a rotated JPEG without pretending its text has been read", async () => {
  const bytes = await sharp(await syntheticImage("jpeg")).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  expect(await admitSavAttachmentImage(bytes, "image/jpeg")).toMatchObject({ width: 64, height: 48 });
});
it("rejects declared APNG and actual animated WebP instead of silently reading only the first frame", async () => {
  const png = await syntheticImage();
  const animation = Buffer.alloc(20); animation.writeUInt32BE(8, 0); animation.write("acTL", 4, "ascii");
  const apng = Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]);
  await expect(admitSavAttachmentImage(apng, "image/png")).rejects.toThrow("pixel_limit");
  const pixels = Buffer.alloc(8 * 16 * 3, 255); pixels.fill(0, 8 * 8 * 3);
  const webp = await sharp(pixels, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  await expect(admitSavAttachmentImage(webp, "image/webp")).rejects.toThrow("pixel_limit");
});
it("admits the exact 16-million-pixel boundary through a real decode", async () => {
  const bytes = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
  expect(await admitSavAttachmentImage(bytes, "image/png")).toMatchObject({ width: 4000, height: 4000 });
});
