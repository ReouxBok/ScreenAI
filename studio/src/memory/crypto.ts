import "server-only";

import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

function secret(name: string) {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error(`${name}_MISSING`);
  return value;
}

function encryptionKey(version = VERSION) {
  if (version !== VERSION) throw new Error("MEMORY_KEY_VERSION_UNSUPPORTED");
  return createHash("sha256").update(secret("MEMORY_ENCRYPTION_KEY_V1"), "utf8").digest();
}

export function encryptMemory(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptMemory<T>(payload: string): T {
  const [version, iv, tag, ciphertext, extra] = String(payload || "").split(".");
  if (!version || !iv || !tag || !ciphertext || extra) throw new Error("MEMORY_CIPHERTEXT_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(version), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function memoryFingerprint(value: string) {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("fr").replace(/\s+/g, " ").trim();
  return createHmac("sha256", secret("MEMORY_IDENTITY_SECRET_V1"))
    .update(`memory-fingerprint:${normalized}`)
    .digest("base64url");
}
