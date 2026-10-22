import "server-only";
import { createHash } from "node:crypto";
import { SAV_ATTACHMENT_LIMITS } from "./attachment-contract";

export type SavAdmittedImage = Readonly<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number; hash: string }>;
const admitted = new WeakSet<object>();
export function isSavAdmittedImage(image: SavAdmittedImage) { return admitted.has(image); }

/** Bound compressed input before the decoder; libvips enforces pixels before raster allocation.
 * stats forces a full pixel decode without returning a second raster buffer. Never logs decoder errors. */
export async function admitSavAttachmentImage(bytes: Buffer, declaredMime: string): Promise<SavAdmittedImage> {
  if (!bytes.length || bytes.length > SAV_ATTACHMENT_LIMITS.imageBytes) throw new Error("byte_limit");
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : null;
  if (!mimeType) throw new Error("invalid_image");
  if (mimeType !== declaredMime.toLowerCase()) throw new Error("type_mismatch");
  if (mimeType === "image/png" && bytes.length >= 24 && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > SAV_ATTACHMENT_LIMITS.pixels) throw new Error("pixel_limit");
  if (mimeType === "image/png") {
    for (let offset = 8, chunks = 0; offset + 12 <= bytes.length; chunks++) {
      if (chunks > 10_000) throw new Error("invalid_image");
      const length = bytes.readUInt32BE(offset), name = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length) throw new Error("invalid_image");
      if (name === "acTL" || name === "fcTL") throw new Error("pixel_limit");
      offset += length + 12;
    }
  }
  if (mimeType === "image/webp") {
    if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length - 8) throw new Error("invalid_image");
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = bytes.readUInt32LE(offset + 4), name = bytes.toString("ascii", offset, offset + 4);
      if (offset + length + 8 > bytes.length) throw new Error("invalid_image");
      if (name === "ANIM" || name === "ANMF" || name === "VP8X" && length > 0 && (bytes[offset + 8] & 2)) throw new Error("pixel_limit");
      offset += length + 8 + (length % 2);
    }
  }
  try {
    const { default: sharp } = await import("sharp");
    const image = sharp(bytes, { limitInputPixels: SAV_ATTACHMENT_LIMITS.pixels, failOn: "warning", sequentialRead: true, pages: 1 }).timeout({ seconds: 3 });
    const metadata = await image.metadata();
    const { width, height } = metadata;
    if (!width || !height || width * height > SAV_ATTACHMENT_LIMITS.pixels || (metadata.pages ?? 1) !== 1) throw new Error("pixel_limit");
    await image.stats();
    const result = Object.freeze({ bytes, mimeType, width, height, hash: createHash("sha256").update(bytes).digest("hex") });
    admitted.add(result);
    return result;
  } catch (error) { throw new Error(error instanceof Error && /pixel|limit/i.test(error.message) ? "pixel_limit" : "invalid_image"); }
}
