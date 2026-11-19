import { afterEach, describe, expect, it, vi } from "vitest";
import { savAdkTimeoutMs, savAutoReplyDailyLimit, savAutoReplyRolloutPercent, savReleaseStage } from "./config";

const previousTimeout = process.env.SAV_ADK_TIMEOUT_MS;
const previousRollout = process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT;
const previousDailyLimit = process.env.SAV_AUTO_REPLY_DAILY_LIMIT;

afterEach(() => {
  vi.unstubAllEnvs();
  if (previousTimeout === undefined) delete process.env.SAV_ADK_TIMEOUT_MS;
  else process.env.SAV_ADK_TIMEOUT_MS = previousTimeout;
  if (previousRollout === undefined) delete process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT;
  else process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT = previousRollout;
  if (previousDailyLimit === undefined) delete process.env.SAV_AUTO_REPLY_DAILY_LIMIT;
  else process.env.SAV_AUTO_REPLY_DAILY_LIMIT = previousDailyLimit;
});

describe("SAV ADK configuration", () => {
  it("defaults to V0 and ignores autonomy settings until a later release is explicit", () => {
    vi.stubEnv("SAV_AUTOMATION_MODE", "on");
    for (const stage of [undefined, "invalid", "v0"]) {
      vi.stubEnv("SAV_RELEASE_STAGE", stage);
      expect(savReleaseStage()).toBe("v0");
    }
  });
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
  it("keeps gradual autonomous rollout closed by default and deterministic", () => {
    delete process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT;
    expect(savAutoReplyRolloutPercent()).toBe(0);
    process.env.SAV_AUTO_REPLY_DAILY_LIMIT = "9999";
    expect(savAutoReplyDailyLimit()).toBe(500);
  });
});
