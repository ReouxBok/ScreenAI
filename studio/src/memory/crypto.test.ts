import { beforeEach, describe, expect, it } from "vitest";
import { decryptMemory, encryptMemory, memoryFingerprint } from "./crypto";

describe("copilot memory encryption", () => {
  beforeEach(() => {
    process.env.MEMORY_ENCRYPTION_KEY_V1 = "test-encryption-key-that-is-longer-than-thirty-two-characters";
    process.env.MEMORY_IDENTITY_SECRET_V1 = "test-identity-key-that-is-longer-than-thirty-two-characters";
  });

  it("round-trips authenticated encrypted data without plaintext leakage", () => {
    const encrypted = encryptMemory({ firstName: "Camille", goal: "Connecter HubSpot" });
    expect(encrypted).not.toContain("Camille");
    expect(decryptMemory(encrypted)).toEqual({ firstName: "Camille", goal: "Connecter HubSpot" });
  });

  it("rejects modified ciphertext", () => {
    const encrypted = encryptMemory({ value: "stable" });
    expect(() => decryptMemory(`${encrypted.slice(0, -1)}x`)).toThrow();
  });

  it("uses deterministic opaque fingerprints", () => {
    expect(memoryFingerprint("  Mon objectif LinkedIn ")).toBe(memoryFingerprint("mon objectif linkedin"));
    expect(memoryFingerprint("Mon objectif LinkedIn")).not.toContain("LinkedIn");
  });
});
