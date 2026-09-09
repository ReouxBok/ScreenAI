import { afterEach, describe, expect, it } from "vitest";
import { savRetentionSettings } from "./retention";

afterEach(() => { delete process.env.SAV_RETENTION_ENABLED; delete process.env.SAV_CONTENT_RETENTION_DAYS; });
describe("SAV retention configuration", () => {
  it("is opt-in and defaults to one year", () => expect(savRetentionSettings(new Date("2026-09-09T00:00:00Z"))).toMatchObject({ enabled: false, days: 365, cutoff: new Date("2025-09-09T00:00:00Z") }));
  it("prevents dangerously short or unbounded retention values", () => {
    process.env.SAV_CONTENT_RETENTION_DAYS = "1";
    expect(savRetentionSettings().days).toBe(30);
    process.env.SAV_CONTENT_RETENTION_DAYS = "99999";
    expect(savRetentionSettings().days).toBe(2555);
  });
});
