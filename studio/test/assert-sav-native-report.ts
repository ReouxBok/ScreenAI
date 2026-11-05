import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

// node --import tsx test/assert-sav-native-report.ts <vitest json report> <test file>...
// A native run proves something only if every listed file is in the report, passed tests and skipped none: a describe.skipIf on a
// missing database, an it.skip or a todo would otherwise read as green. A listed file that builds its own PGlite is refused as well.
const [reportPath, ...files] = process.argv.slice(2);
assert.ok(reportPath && files.length, "usage: <report.json> <test files...>");
const report = JSON.parse(await readFile(reportPath, "utf8")) as { testResults: { name: string; assertionResults: { status: string }[] }[] };
const problems: string[] = [];
for (const file of files) {
  if ((await readFile(file, "utf8")).includes("new PGlite")) problems.push(`${file}: builds its own PGlite`);
  const result = report.testResults.find(entry => path.resolve(entry.name) === path.resolve(file));
  if (!result) { problems.push(`${file}: absent from the report`); continue; }
  const passed = result.assertionResults.filter(test => test.status === "passed").length, other = result.assertionResults.length - passed;
  if (passed === 0) problems.push(`${file}: no passed test`);
  if (other > 0) problems.push(`${file}: ${other} test(s) not passed (${[...new Set(result.assertionResults.map(test => test.status))].join(", ")})`);
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`SAV native report: ${files.length} files, every test passed, none skipped`);
