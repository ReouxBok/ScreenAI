import { afterEach, describe, expect, it } from "vitest";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";

const previousKey = process.env.SAV_ENCRYPTION_KEY_V1;

afterEach(() => {
  if (previousKey === undefined) delete process.env.SAV_ENCRYPTION_KEY_V1;
  else process.env.SAV_ENCRYPTION_KEY_V1 = previousKey;
});

describe("SAV encryption", () => {
  it("encrypts customer content and decrypts it with the dedicated key", () => {
    process.env.SAV_ENCRYPTION_KEY_V1 = "sav-test-key-that-is-longer-than-thirty-two-characters";
    const encrypted = encryptSavPayload({ body: "Contenu client confidentiel" });
    expect(encrypted).not.toContain("confidentiel");
    expect(decryptSavPayload(encrypted)).toEqual({ body: "Contenu client confidentiel" });
  });

  it("rejects missing encryption configuration", () => {
    delete process.env.SAV_ENCRYPTION_KEY_V1;
    expect(() => encryptSavPayload("secret")).toThrow("SAV_ENCRYPTION_KEY_V1_MISSING");
  });

  it("produces stable hashes for idempotency", () => {
    expect(savContentHash({ id: "same" })).toBe(savContentHash({ id: "same" }));
    expect(savContentHash({ id: "same" })).not.toBe(savContentHash({ id: "other" }));
  });
});
