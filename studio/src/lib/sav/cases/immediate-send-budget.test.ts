import { expect, it } from "vitest";
import { CASE_REPLY_IMMEDIATE_BUDGET_MS, CASE_REPLY_IMMEDIATE_MIN_REMAINING_MS, CASE_REPLY_IMMEDIATE_SAFETY_MS, immediateSendDeadline } from "./immediate-send-budget";

it("11/11: an immediate send needs a caller deadline with a full send budget plus a margin left, and ends before the margin", () => {
  const now = 1_000_000;
  expect(CASE_REPLY_IMMEDIATE_MIN_REMAINING_MS).toBe(60_000);
  expect(immediateSendDeadline(undefined, now)).toBeNull();
  expect(immediateSendDeadline(NaN, now)).toBeNull();
  expect(immediateSendDeadline(now + 59_999, now)).toBeNull();
  expect(immediateSendDeadline(now + 60_000, now)).toBe(now + 60_000 - CASE_REPLY_IMMEDIATE_SAFETY_MS);
  expect(immediateSendDeadline(now + 270_000, now)).toBe(now + CASE_REPLY_IMMEDIATE_BUDGET_MS);
});
