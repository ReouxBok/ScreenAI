import { describe, expect, it } from "vitest";
import { hasSavReanalysisAuthority, withSavReanalysisAuthority } from "./reanalysis-authority";
const target = { projectId: "fixture", teamId: "fixture", databaseHash: "a".repeat(64), codeRevision: "b".repeat(40), promptRevision: "fixture", model: "fixture", resourcesHash: "c".repeat(64) };
describe("request-local server execution authority", () => {
  it("never leaks authority beyond its callback and binds exact target/expiry", async () => {
    expect(hasSavReanalysisAuthority(target)).toBe(false);
    await withSavReanalysisAuthority({ operationId: "fixture", target, expiresAt: new Date(Date.now() + 60_000).toISOString() }, async () => {
      expect(hasSavReanalysisAuthority(target)).toBe(true);
      expect(hasSavReanalysisAuthority({ ...target, codeRevision: "f".repeat(40) })).toBe(false);
    });
    expect(hasSavReanalysisAuthority(target)).toBe(false);
    await withSavReanalysisAuthority({ operationId: "fixture", target, expiresAt: "2020-01-01T00:00:00Z" }, async () => expect(hasSavReanalysisAuthority(target)).toBe(false));
  });
});
