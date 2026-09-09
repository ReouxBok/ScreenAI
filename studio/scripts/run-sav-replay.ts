import { readFile } from "node:fs/promises";
import { runSavRuleReplay } from "../src/lib/sav/replay";

const corpusPath = new URL("../test/fixtures/sav-replay-v1.json", import.meta.url);
const report = runSavRuleReplay(JSON.parse(await readFile(corpusPath, "utf8")));
console.log(JSON.stringify({ corpus: "sav-replay-v1", total: report.total, passed: report.passed, failed: report.failed,
  development: { total: report.development.length, passed: report.development.filter((item) => item.passed).length },
  control: { total: report.control.length, passed: report.control.filter((item) => item.passed).length },
  failures: report.results.filter((item) => !item.passed),
}, null, 2));
if (report.failed) process.exitCode = 1;
