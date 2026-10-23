import { describe, expect, it } from "vitest";
import { intakeArtifactAuthorized, intakeSamePin, SAV_INTAKE_COMPATIBILITY } from "./compatibility";
import { intakeRuntimeHash, savIntakeRuntimeConfig, savIntakeRuntimePins } from "./runtime-contract";
const a = "a".repeat(40), b = "b".repeat(40);
const pin = { codeRevision: a, compatibility: SAV_INTAKE_COMPATIBILITY };
describe("intake artifact authority", () => {
  it("accepts a different deployment only after explicit compatibility approval", () => {
    expect(intakeArtifactAuthorized(pin, b)).toBe(true);
    expect(intakeArtifactAuthorized({ codeRevision: a }, b)).toBe(false);
    expect(intakeArtifactAuthorized({ codeRevision: a }, a)).toBe(true);
  });
  it.each([undefined, null, "", "bad", "A".repeat(40), "a".repeat(39), "a".repeat(41)])("refuses invalid deployed SHA %s", deployed => {
    expect(intakeArtifactAuthorized(pin, deployed)).toBe(false);
    expect(intakeArtifactAuthorized({ codeRevision: a }, deployed)).toBe(false);
  });
  it.each(["f".repeat(64), "bad", "", "A".repeat(64)])("never falls back to exact SHA after compatibility mismatch %s", compatibility => {
    expect(intakeArtifactAuthorized({ codeRevision: a, compatibility }, a)).toBe(false);
  });
  it("requires a valid approval reference even in compatibility mode", () => {
    expect(intakeArtifactAuthorized({ ...pin, codeRevision: "bad" }, b)).toBe(false);
  });
  it("compares matching compatible references and keeps legacy and mixed modes separate", () => {
    expect(intakeSamePin(pin, { ...pin, codeRevision: b })).toBe(true);
    expect(intakeSamePin(pin, { codeRevision: a })).toBe(false);
    expect(intakeSamePin({ codeRevision: a }, pin)).toBe(false);
    expect(intakeSamePin({ codeRevision: a }, { codeRevision: a })).toBe(true);
    expect(intakeSamePin({ codeRevision: a }, { codeRevision: b })).toBe(false);
    expect(intakeSamePin(pin, { ...pin, compatibility: "f".repeat(64) })).toBe(false);
    expect(intakeSamePin({ codeRevision: "bad" }, { codeRevision: "bad" })).toBe(false);
  });
});
const now = new Date("2026-10-23T12:00:00Z");
const policy = { relationRevision: "synthetic", admittedRelations: [], resources: {} };
const pins = { ...pin, mailboxId: "10000000-0000-4000-8000-000000000001", createdAfter: "2026-10-23T11:00:00Z", receivedAfter: "2026-10-23T11:00:00Z", expiresAt: "2026-10-23T13:00:00Z",
  policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxCalls: 3, maxNanoUsd: 1000 };
const env = { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify(pins), SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
  VERCEL_GIT_COMMIT_SHA: a, SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "synthetic", HUBSPOT_ACCESS_TOKEN: "synthetic", SAV_ENCRYPTION_KEY_V1: "synthetic-only-encryption-key-at-least-32-characters" };
it("keeps configHash and reference stable across compatible deployments", () => {
  const before = savIntakeRuntimeConfig(env, now)!, after = savIntakeRuntimeConfig({ ...env, VERCEL_GIT_COMMIT_SHA: b }, now)!;
  expect(after.configHash).toBe(before.configHash); expect(after.codeRevision).toBe(a);
});
it("does not upgrade old pins or change their parsed hash", () => {
  const { compatibility: omitted, ...legacy } = pins; expect(omitted).toBe(SAV_INTAKE_COMPATIBILITY);
  // Field order is the historical schema's order, not arbitrary incoming JSON.
  const historical = { mailboxId: pins.mailboxId, createdAfter: pins.createdAfter, receivedAfter: pins.receivedAfter, expiresAt: pins.expiresAt,
    codeRevision: a, resourcesHash: pins.resourcesHash, policyHash: pins.policyHash, maxNanoUsd: pins.maxNanoUsd, maxCalls: pins.maxCalls };
  expect(intakeRuntimeHash(savIntakeRuntimePins.parse(legacy))).toBe(intakeRuntimeHash(historical));
  expect(() => savIntakeRuntimeConfig({ ...env, VERCEL_GIT_COMMIT_SHA: b, SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify(legacy) }, now)).toThrow();
  expect(savIntakeRuntimeConfig({ ...env, SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify(legacy) }, now)).not.toBeNull();
});
it.each([{ expiresAt: "2026-10-23T11:30:00Z" }, { maxCalls: 301 }, { maxNanoUsd: 3_000_000_001 }, { createdAfter: "2026-10-24T11:00:00Z" }, { receivedAfter: pins.expiresAt }, { compatibility: "f".repeat(64) }])("keeps independent runtime guard %j", change => {
  expect(() => savIntakeRuntimeConfig({ ...env, SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ ...pins, ...change }) }, now)).toThrow();
});
it("requires a deployed SHA and preserves model and resource guards", () => {
  expect(() => savIntakeRuntimeConfig({ ...env, VERCEL_GIT_COMMIT_SHA: undefined }, now)).toThrow();
  expect(() => savIntakeRuntimeConfig({ ...env, SAV_AI_MODEL: "other" }, now)).toThrow();
  expect(() => savIntakeRuntimeConfig({ ...env, SAV_INTAKE_RUNTIME_RESOURCES: "[{}]" }, now)).toThrow();
});
