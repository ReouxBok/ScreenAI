import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertReanalysisApproval, reanalysisClaimId, reanalysisHash, reanalysisManifestSchema, validateReanalysisRuntime,
  type ReanalysisApproval, type ReanalysisManifest } from "./reanalysis-contract";

export function sampleManifest(count = 1): ReanalysisManifest {
  const now = Date.now();
  return { version: 1, batchId: randomUUID(), mode: "candidate_only", target: { projectId: "fixture", teamId: "fixture", databaseHash: "a".repeat(64),
    codeRevision: "b".repeat(40), promptRevision: "fixture", model: "fixture", resourcesHash: "c".repeat(64) },
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), since: "2026-10-15T22:00:00Z", until: new Date(now - 1000).toISOString(),
    items: Array.from({ length: count }, () => ({ threadId: randomUUID(), messageId: randomUUID(), receivedAt: "2026-10-16T10:00:00Z", view: "to_process", baselineHash: "d".repeat(64) })) };
}
export function sampleApproval(m: ReanalysisManifest): ReanalysisApproval {
  return { version: 1, batchId: m.batchId, manifestHash: reanalysisHash(m), actor: "ugo@limova.ai", mode: "candidate_only", codeRevision: m.target.codeRevision,
    expiresAt: m.expiresAt, messageIds: m.items.map(i => i.messageId), stage: "first" };
}
describe("reanalysis approval contract", () => {
  it("requires exact target, manifest, actor, mode, selection and expiry", () => {
    const m = sampleManifest(), a = sampleApproval(m);
    expect(() => assertReanalysisApproval(m, a, m.target)).not.toThrow();
    for (const patch of [{ manifestHash: "a".repeat(64) }, { codeRevision: "a".repeat(40) }, { batchId: randomUUID() }, { messageIds: [randomUUID()] },
      { expiresAt: "2026-01-01T00:00:00Z" }, { messageIds: [m.items[0].messageId, m.items[0].messageId] }, { actor: "someone@example.invalid" }, { mode: "apply" }]) {
      expect(() => assertReanalysisApproval(m, { ...a, ...patch } as ReanalysisApproval, m.target)).toThrow();
    }
    expect(() => assertReanalysisApproval(m, a, { ...m.target, resourcesHash: "e".repeat(64) })).toThrow();
  });
  it("limits the first tranche to five and continuation to twenty with a separate reviewed batch", () => {
    const m = sampleManifest(6), a = sampleApproval(m);
    expect(() => assertReanalysisApproval(m, a, m.target)).toThrow();
    expect(() => assertReanalysisApproval(m, { ...a, stage: "continuation" }, m.target)).toThrow();
    expect(() => assertReanalysisApproval(m, { ...a, stage: "continuation", reviewedPreviousBatch: randomUUID() }, m.target)).not.toThrow();
    expect(() => assertReanalysisApproval(sampleManifest(21), sampleApproval(sampleManifest(21)), m.target)).toThrow();
  });
  it("rejects duplicate threads/messages, oversized or widening windows", () => {
    const m = sampleManifest();
    expect(() => reanalysisManifestSchema.parse({ ...m, items: [m.items[0], m.items[0]] })).toThrow();
    expect(() => reanalysisManifestSchema.parse(sampleManifest(217))).toThrow();
    expect(() => reanalysisManifestSchema.parse({ ...m, until: "2099-01-01T00:00:00Z" })).toThrow();
    expect(() => reanalysisManifestSchema.parse({ ...m, expiresAt: "2099-01-01T00:00:00Z" })).toThrow();
  });
  it("canonicalizes keys, preserves array order and deduplicates the same snapshot across batches", () => {
    const m = sampleManifest(), item = m.items[0];
    expect(reanalysisHash({ a: 1, b: 2 })).toBe(reanalysisHash({ b: 2, a: 1 }));
    expect(reanalysisHash([1, 2])).not.toBe(reanalysisHash([2, 1]));
    expect(reanalysisClaimId(item, m.target)).toBe(reanalysisClaimId({ ...item }, { ...m.target }));
    expect(reanalysisClaimId(item, m.target)).not.toBe(reanalysisClaimId({ ...item, baselineHash: "f".repeat(64) }, m.target));
  });
  it("refuses an unverified runtime, TLS, missing credentials and revision overrides", () => {
    const env = { NODE_ENV: "production", VERCEL_ENV: "production", SAV_RELEASE_STAGE: "v0", SAV_PILOT_MODE: "false", VERCEL_PROJECT_ID: "fixture", VERCEL_ORG_ID: "fixture",
      VERCEL_GIT_COMMIT_SHA: "a".repeat(40), DATABASE_URL: "postgres://fixture:fixture@database.example.invalid/db?sslmode=verify-full", SAV_ENCRYPTION_KEY_V1: "fixture", SAV_GEMINI_API_KEY: "fixture" };
    expect(validateReanalysisRuntime(env).codeRevision).toBe("a".repeat(40));
    for (const patch of [{ NODE_ENV: "test" }, { SAV_PILOT_MODE: "true" }, { SAV_RELEASE_STAGE: "v2" }, { SAV_CODE_REVISION: "b".repeat(40) },
      { SAV_GEMINI_API_KEY: "" }, { VERCEL_ENV: "preview" }, { DATABASE_URL: env.DATABASE_URL.replace("verify-full", "require") }, { DATABASE_URL: env.DATABASE_URL + "&ssl=disable" }])
      expect(() => validateReanalysisRuntime({ ...env, ...patch })).toThrow();
  });
});
