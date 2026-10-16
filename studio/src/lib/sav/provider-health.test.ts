import { describe, expect, it } from "vitest";
import { savProviderHealthCheck } from "./provider-health";
const counts = { runs: 10, providerFailures: 3, outputFailures: 1, validationFailures: 2, lastProviderFailure: "2026-10-15T10:00:00Z", lastSuccess: "2026-10-15T09:00:00Z" };
describe("deduplicated SAV health", () => {
  it("shows one stable provider alert regardless of repeated failures", () => {
    expect(savProviderHealthCheck(counts)).toMatchObject({ key: "sav-ai-provider", level: "error" });
    expect(savProviderHealthCheck({ ...counts, providerFailures: 100 })).toMatchObject({ key: "sav-ai-provider", level: "error" });
  });
  it("reports recovery with retained history and keeps output/validation failures separate", () => {
    const check = savProviderHealthCheck({ ...counts, lastSuccess: "2026-10-15T11:00:00Z" });
    expect(check.level).toBe("warning"); expect(check.detail).toContain("1 sortie(s) invalide(s) · 2 refus");
  });
  it("does not treat missing observations as a successful provider check", () => {
    expect(savProviderHealthCheck({ ...counts, runs: 0, providerFailures: 0, outputFailures: 0, validationFailures: 0, lastProviderFailure: null, lastSuccess: null })).toMatchObject({ level: "warning" });
  });
});
