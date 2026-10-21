import assert from "node:assert/strict";
import { test } from "node:test";
import { discoveredCases, assertPartition, childEnvironment } from "./run-e2e-ci.mjs";

const spec = (line = 3, title = "synthetic", status = "passed") => ({ file: "tests/e2e/example.spec.ts", line, title,
  tests: [{ expectedStatus: "passed", results: [{ status }] }] });
const report = (...specs) => ({ suites: [{ suites: [{ specs }] }], errors: [] });

test("adds the absolute npm binary directory only to the child environment", () => {
  const original = { PATH: "/synthetic/bin:/usr/bin", CI: "1", SYNTHETIC_SETTING: "preserved" };
  const result = childEnvironment(original);
  assert.equal(result.PATH, `${new URL("../node_modules/.bin", import.meta.url).pathname}:${original.PATH}`);
  assert.deepEqual({ ...result, PATH: original.PATH }, original);
  assert.notEqual(result, original);
  assert.equal(original.PATH, "/synthetic/bin:/usr/bin");
});

test("discovers every nested test once and retains its selector/title", () => {
  const cases = discoveredCases(report(spec(), spec(9, "second")));
  assert.deepEqual(cases.map(({ selector, title }) => ({ selector, title })), [
    { selector: "tests/e2e/example.spec.ts:3", title: "synthetic" },
    { selector: "tests/e2e/example.spec.ts:9", title: "second" },
  ]);
  const nested = { ...report({ ...spec(), file: "example.spec.ts" }),
    config: { rootDir: new URL("../tests/e2e", import.meta.url).pathname } };
  assert.equal(discoveredCases(nested)[0].selector, "tests/e2e/example.spec.ts:3");
});
test("rejects empty, ambiguous and multi-project selections", () => {
  assert.throws(() => discoveredCases(report()));
  assert.throws(() => discoveredCases(report(spec(), spec(3, "other title"))));
  const multiple = spec(); multiple.tests.push(multiple.tests[0]);
  assert.throws(() => discoveredCases(report(multiple)));
});
test("accepts only the exact discovered test with one passing attempt", () => {
  const expected = discoveredCases(report(spec()))[0];
  assert.doesNotThrow(() => assertPartition(report(spec()), expected));
  for (const bad of [report(), report(spec(9)), report(spec(3, "changed")), report(spec(), spec(9))]) {
    assert.throws(() => assertPartition(bad, expected));
  }
  for (const status of ["failed", "skipped", "timedOut", "interrupted"]) {
    assert.throws(() => assertPartition(report(spec(3, "synthetic", status)), expected));
  }
  const retried = spec(); retried.tests[0].results.push({ status: "passed" });
  assert.throws(() => assertPartition(report(retried), expected));
  const expectedFailure = spec(); expectedFailure.tests[0].expectedStatus = "failed";
  assert.throws(() => assertPartition(report(expectedFailure), expected));
  assert.throws(() => assertPartition({ ...report(spec()), errors: [{ message: "worker failed" }] }, expected));
});
