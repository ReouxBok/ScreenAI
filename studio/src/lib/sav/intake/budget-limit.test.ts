import { expect, it } from "vitest";
import { intakeExhaustedLimit, publicIntakeBudgetLimit } from "./budget-limit";
import { SAV_INTAKE_OPERATIONAL_PROFILE } from "./budget-profile";

it("names a sub-limit exactly when the historical ledger condition refused, on a grid of values", () => {
  const seen = new Set<string>();
  for (const own of [0, 8, 9]) for (const version of [0, 5, 6]) for (const needed of [1, 2]) for (const calls of [0, 1, 5]) for (const money of [0, 100, 1000]) for (const rolling of [0, 100, 1000])
    for (const profile of [SAV_INTAKE_OPERATIONAL_PROFILE, "qualification_lifetime"]) {
      const usage = { profile, remainingCalls: calls, remainingNanoUsd: money, remainingRollingNanoUsd: rolling }, price = 100;
      const historical = own + needed > 9 || version + needed > 6 || needed > calls || needed * price > money || needed * price > rolling;
      const limit = intakeExhaustedLimit({ own, version, needed, perMessage: 9, perVersion: 6, priceNanoUsd: price, usage });
      expect(Boolean(limit)).toBe(historical);
      if (limit) seen.add(limit);
    }
  expect([...seen].sort()).toEqual(["campaign_calls", "campaign_nano_usd", "daily_calls", "daily_nano_usd", "per_message", "per_version", "rolling_nano_usd"]);
});
it("projects only known sub-limit names", () => {
  expect(publicIntakeBudgetLimit("per_message")).toBe("per_message");
  expect(publicIntakeBudgetLimit("raise_it_please")).toBeNull();
});
