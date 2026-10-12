import { afterEach, expect, it, vi } from "vitest";
import { formatParisDateTime } from "./paris-date";
afterEach(() => vi.unstubAllEnvs());
it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])("uses Paris summer/winter and date boundaries regardless of host %s", (timezone) => {
  vi.stubEnv("TZ", timezone);
  expect(formatParisDateTime("2026-01-02T12:00:00Z")).toBe("02/01/2026 13:00");
  expect(formatParisDateTime("2026-07-02T12:00:00Z")).toBe("02/07/2026 14:00");
  expect(formatParisDateTime("2026-07-02T23:30:00Z", { dateStyle: "short" })).toBe("03/07/2026");
});
it("handles missing and invalid dates without inventing a timestamp", () => {
  for (const value of [undefined, null, "", "invalid", new Date(NaN)]) expect(formatParisDateTime(value)).toBe("Date indisponible");
});
