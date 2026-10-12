import { readFile } from "node:fs/promises";
import { runSavRuleReplay, savRuleReplayExitCode } from "../src/lib/sav/replay";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--technical-preflight")) throw new Error("SAV_REPLAY_INVALID_ARGUMENTS");
const technicalPreflightOnly = args[0] === "--technical-preflight";
const corpusPath = new URL("../test/fixtures/sav-replay-v1.json", import.meta.url);
const report = runSavRuleReplay(JSON.parse(await readFile(corpusPath, "utf8")));
console.log(JSON.stringify({ scope: "technical_preflight_only", semanticQualityVerified: false, executionMode: technicalPreflightOnly ? "technical_preflight" : "require_complete_evaluation", corpus: "sav-replay-v1", total: report.total, passed: report.passed, failed: report.failed, notEvaluated: report.notEvaluated,
  development: { total: report.development.length, passed: report.development.filter((item) => item.passed).length },
  control: { total: report.control.length, passed: report.control.filter((item) => item.passed).length },
  failures: report.results.filter((item) => item.evaluated && !item.passed),
  requiresSemanticEvaluation: report.results.filter((item) => !item.evaluated).map(item => item.id),
}, null, 2));
process.exitCode = savRuleReplayExitCode(report, technicalPreflightOnly);
