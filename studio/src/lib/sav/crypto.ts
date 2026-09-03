import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const CURRENT_VERSION = "v1";

function encryptionKey(version = CURRENT_VERSION) {
  if (version !== CURRENT_VERSION) throw new Error("SAV_KEY_VERSION_UNSUPPORTED");
  const secret = process.env.SAV_ENCRYPTION_KEY_V1;
  if (!secret || secret.length < 32) throw new Error("SAV_ENCRYPTION_KEY_V1_MISSING");
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSavPayload(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    CURRENT_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSavPayload<T>(payload: string): T {
  const [version, iv, tag, ciphertext, extra] = String(payload || "").split(".");
  if (!version || !iv || !tag || !ciphertext || extra) throw new Error("SAV_CIPHERTEXT_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(version), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function savContentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("base64url");
}
