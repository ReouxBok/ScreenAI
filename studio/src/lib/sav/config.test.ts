import { afterEach, describe, expect, it } from "vitest";
import { savAdkTimeoutMs, savAutoReplyCategories, savAutoReplyDailyLimit, savAutoReplyRolloutPercent, savThreadInAutoReplyRollout } from "./config";

const previousTimeout = process.env.SAV_ADK_TIMEOUT_MS;
const previousCategories = process.env.SAV_AUTO_REPLY_CATEGORIES;
const previousRollout = process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT;
const previousDailyLimit = process.env.SAV_AUTO_REPLY_DAILY_LIMIT;

afterEach(() => {
  if (previousTimeout === undefined) delete process.env.SAV_ADK_TIMEOUT_MS;
  else process.env.SAV_ADK_TIMEOUT_MS = previousTimeout;
  if (previousCategories === undefined) delete process.env.SAV_AUTO_REPLY_CATEGORIES;
  else process.env.SAV_AUTO_REPLY_CATEGORIES = previousCategories;
  if (previousRollout === undefined) delete process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT;
  else process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT = previousRollout;
  if (previousDailyLimit === undefined) delete process.env.SAV_AUTO_REPLY_DAILY_LIMIT;
  else process.env.SAV_AUTO_REPLY_DAILY_LIMIT = previousDailyLimit;
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
  it("limits autonomy to explicit low-risk categories", () => {
    delete process.env.SAV_AUTO_REPLY_CATEGORIES;
    expect([...savAutoReplyCategories()]).toEqual(["technical", "how_to"]);
    process.env.SAV_AUTO_REPLY_CATEGORIES = "integration,billing,invalid";
    expect([...savAutoReplyCategories()]).toEqual(["integration"]);
  });
  it("keeps gradual autonomous rollout closed by default and deterministic", () => {
    delete process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT;
    expect(savAutoReplyRolloutPercent()).toBe(0);
    expect(savThreadInAutoReplyRollout("thread-a")).toBe(false);
    expect(savThreadInAutoReplyRollout("thread-a", 100)).toBe(true);
    process.env.SAV_AUTO_REPLY_DAILY_LIMIT = "9999";
    expect(savAutoReplyDailyLimit()).toBe(500);
  });
});
