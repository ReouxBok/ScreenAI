import { afterEach, describe, expect, it } from "vitest";
import { savAdkTimeoutMs } from "./config";

const previousTimeout = process.env.SAV_ADK_TIMEOUT_MS;

afterEach(() => {
  if (previousTimeout === undefined) delete process.env.SAV_ADK_TIMEOUT_MS;
  else process.env.SAV_ADK_TIMEOUT_MS = previousTimeout;
});

describe("SAV ADK configuration", () => {
  it("leaves enough time for a grounded multi-tool run", () => {
    delete process.env.SAV_ADK_TIMEOUT_MS;
    expect(savAdkTimeoutMs()).toBe(45_000);
  });

  it("clamps invalid or unsafe timeout values", () => {
    process.env.SAV_ADK_TIMEOUT_MS = "500";
    expect(savAdkTimeoutMs()).toBe(10_000);
    process.env.SAV_ADK_TIMEOUT_MS = "120000";
    expect(savAdkTimeoutMs()).toBe(90_000);
    process.env.SAV_ADK_TIMEOUT_MS = "invalid";
    expect(savAdkTimeoutMs()).toBe(45_000);
  });
});
