import { expect, it } from "vitest";
import { validateSavNativeTestTarget } from "../../../test/sav-native-db";
const token = "a".repeat(32);
it("accepts only a dedicated loopback instance and database", () => {
  expect(() => validateSavNativeTestTarget("postgres://codex_test@127.0.0.1:54379/codex_sav_fixture", token)).not.toThrow();
});
it.each([
  "postgres://codex_test@db.example.invalid:54379/codex_sav_fixture",
  "postgres://codex_test@127.0.0.1:5432/codex_sav_fixture",
  "postgres://codex_test@127.0.0.1:54379/production",
  "postgres://owner@127.0.0.1:54379/codex_sav_fixture",
  "postgres://codex_test@127.0.0.1:54379/codex_sav_fixture?host=other",
])("refuses an unsafe native target before opening a connection", value => {
  expect(() => validateSavNativeTestTarget(value, token)).toThrow("SAV_NATIVE_TEST_TARGET_REFUSED");
});
it("requires the separate instance marker", () => {
  expect(() => validateSavNativeTestTarget("postgres://codex_test@127.0.0.1:54379/codex_sav_fixture", undefined)).toThrow("SAV_NATIVE_TEST_TARGET_REFUSED");
});
