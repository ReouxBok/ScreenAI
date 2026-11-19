import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSavBenchCurrentAgent, createSavBenchCurrentModel, savBenchCurrentEnv } from "../src/lib/sav/bench/bench-agent-current";
import { SAV_BENCH_CORPUS_REVISION, savBenchCorpusCounts, selectSavBenchCorpus } from "../src/lib/sav/bench/bench-corpus";
import { createSavBenchScriptedAgent, createSavBenchScriptedJudge } from "../src/lib/sav/bench/bench-doubles";
import { createSavBenchGeminiJudge, savBenchJudgePromptSha256 } from "../src/lib/sav/bench/bench-judge";
import { savBenchComparisonMarkdown, savBenchMarkdown } from "../src/lib/sav/bench/bench-report";
import { runSavBench, type SavBenchReport } from "../src/lib/sav/bench/bench-run";
import type { SavBenchAgent } from "../src/lib/sav/bench/bench-types";
import { createSavBenchWire, SAV_BENCH_CAP_EUR } from "../src/lib/sav/bench/bench-wire";

/*
 * SAV-109: the SAV agent's test bench on the real model, judged by an AI judge, outside CI. Reuses the Access evaluation script's shape
 * (`evaluate-sav-access-skill.ts`): dry-run, cache by request fingerprint, cap in EUR, stop at the first sensitive case admitted, reports
 * written OUTSIDE the repository (0600). Key: SAV_V2_GEMINI_API_KEY in the environment, never printed, never read from Vercel.
 *
 * Usage (from studio/):
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/evaluate-sav-bench.ts --dry-run --report-dir=/abs/dir
 *   NODE_OPTIONS=--conditions=react-server SAV_V2_GEMINI_API_KEY=… npx tsx scripts/evaluate-sav-bench.ts --agent=current --model=<id> \
 *     --eur-per-million-input=<n> --eur-per-million-output=<n> --cap-eur=2 --report-dir=/abs/dir --cache=/abs/cache.json
 *   --agent=current|new|scripted   current: the production V2 decision path, replayed with no effect; new: `--agent-module=/abs/file.ts`
 *                                  exporting `createSavBenchAgent({ dryRun, network, env })`; scripted: the labelled double (plumbing only)
 *   --judge-model=<id>             default: --model.  --judge=gemini|scripted (default gemini; dry-run: scripted)
 *   --cap-eur=2 (max 10)  --passes=1  --subset=all|risky  --families=a,b  --ids=x,y  --limit=n
 *   --max-output-tokens=4096 (agent, ≤ 8192)  --judge-max-output-tokens=2048  --max-input-bytes=100000
 *   --v2-flag=SAV_V2_PROMPT_COMPACT=on (repeatable; generation flags only)
 *   --compare=/abs/bench-current.json   writes the comparison of this run with that report (same conversations)
 *   There is no option to keep going after a sensitive case admitted: the run always stops there.
 */
const args = process.argv.slice(2);
const arg = (name: string) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const list = (name: string) => arg(name)?.split(",").map(part => part.trim()).filter(Boolean);
const number = (name: string, fallback?: number) => { const raw = arg(name); const value = raw === undefined ? fallback : Number(raw); if (value === undefined || !Number.isFinite(value) || value < 0) throw Error(`SAV_BENCH_ARG_${name}`); return value; };
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outside = (path: string) => { const rel = relative(root, resolve(path)); return isAbsolute(path) && (rel.startsWith(`..${sep}`) || isAbsolute(rel)); };
const MODEL = /^[a-z0-9][a-z0-9.-]{0,99}$/;

async function main() {
  const dryRun = args.includes("--dry-run"), agentName = arg("agent") ?? "current", reportDir = arg("report-dir"), cachePath = arg("cache");
  if (!["current", "new", "scripted"].includes(agentName)) throw Error("SAV_BENCH_AGENT_UNKNOWN");
  if (!reportDir || !outside(reportDir) || (cachePath && !outside(cachePath))) throw Error("SAV_BENCH_PRIVATE_PATH_OUTSIDE_REPOSITORY_REQUIRED");
  const capEur = number("cap-eur", SAV_BENCH_CAP_EUR.default);
  if (capEur > SAV_BENCH_CAP_EUR.max) throw Error("SAV_BENCH_CAP_ABOVE_APPROVED_10_EUR");
  const passes = number("passes", 1), maxOutputTokens = number("max-output-tokens", 4096), judgeMaxOutputTokens = number("judge-max-output-tokens", 2048);
  if (maxOutputTokens > 8192 || maxOutputTokens < 256) throw Error("SAV_BENCH_ARG_max-output-tokens");
  const priceIn = arg("eur-per-million-input") === undefined ? undefined : number("eur-per-million-input"), priceOut = arg("eur-per-million-output") === undefined ? undefined : number("eur-per-million-output");
  const prices = priceIn !== undefined && priceOut !== undefined ? { eurPerMillionInput: priceIn, eurPerMillionOutput: priceOut } : null;
  const model = arg("model") ?? (dryRun ? "dry-run-model" : ""), judgeModel = arg("judge-model") ?? model, key = process.env.SAV_V2_GEMINI_API_KEY ?? "";
  if (!dryRun && (!MODEL.test(model) || !MODEL.test(judgeModel) || !key || !prices)) throw Error("SAV_BENCH_MODEL_KEY_AND_PRICES_REQUIRED");
  const flags = Object.fromEntries(args.filter(value => value.startsWith("--v2-flag=")).map(value => value.slice(10).split("=") as [string, string]));

  const conversations = selectSavBenchCorpus({ subset: arg("subset") === "risky" ? "risky" : "all", families: list("families"), ids: list("ids"), limit: arg("limit") ? number("limit") : undefined });
  if (!conversations.length) throw Error("SAV_BENCH_NO_CONVERSATION_SELECTED");
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const cache: Record<string, unknown> = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const wire = createSavBenchWire({ mode: dryRun ? "dry-run" : "live", capEur, maxOutputTokens: Math.max(maxOutputTokens, judgeMaxOutputTokens), prices, cache,
    persist: cachePath ? () => writeFileSync(cachePath, JSON.stringify(cache), { mode: 0o600 }) : undefined });

  let agent: SavBenchAgent;
  const env = savBenchCurrentEnv({ key: dryRun ? "sav-bench-dry-run-no-key" : key, model: MODEL.test(model) ? model : "dry-run-model", maxOutputTokens,
    maxInputBytes: arg("max-input-bytes") ? number("max-input-bytes") : undefined, eurPerMillionInput: priceIn, eurPerMillionOutput: priceOut, flags });
  if (agentName === "current") agent = createSavBenchCurrentAgent({ model: createSavBenchCurrentModel({ env, network: wire.network, dryRun }), revision: `v2-decision:${model}${Object.keys(flags).length ? `+${Object.entries(flags).map(([k, v]) => `${k}=${v}`).join(",")}` : ""}` });
  else if (agentName === "scripted") agent = createSavBenchScriptedAgent(conversations, "labelled");
  else {
    const modulePath = arg("agent-module");
    if (!modulePath || !isAbsolute(modulePath) || !existsSync(modulePath)) throw Error("SAV_BENCH_NEW_AGENT_MODULE_REQUIRED");
    const loaded = await import(pathToFileURL(modulePath).href) as { createSavBenchAgent?: (context: { dryRun: boolean; network: typeof wire.network; env: Record<string, string> }) => SavBenchAgent | Promise<SavBenchAgent> };
    if (typeof loaded.createSavBenchAgent !== "function") throw Error("SAV_BENCH_NEW_AGENT_FACTORY_MISSING");
    agent = await loaded.createSavBenchAgent({ dryRun, network: wire.network, env });
  }
  const judgeKind = arg("judge") ?? (dryRun ? "scripted" : "gemini");
  const judge = judgeKind === "scripted" ? createSavBenchScriptedJudge("honest")
    : createSavBenchGeminiJudge({ network: wire.network, model: MODEL.test(judgeModel) ? judgeModel : "dry-run-model", key: dryRun ? "sav-bench-dry-run-no-key" : key, maxOutputTokens: judgeMaxOutputTokens });

  const report = await runSavBench({ conversations, agent, judge, passes, stopOnSensitiveAdmitted: true, shouldStop: wire.stopped });
  const sha = (() => { try { return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
  const totals = wire.totals();
  const info = { sha, corpusRevision: SAV_BENCH_CORPUS_REVISION, judgePromptSha256: savBenchJudgePromptSha256(), model, judgeModel, dryRun,
    cost: { spentEur: totals.spentEur, capEur, paidCalls: totals.paidCalls, cachedCalls: totals.cachedCalls, estimatedEur: totals.estimatedEur } };
  const base = join(reportDir, `bench-${agentName}`);
  writeFileSync(`${base}.json`, JSON.stringify({ info, wire: totals, corpus: savBenchCorpusCounts(conversations), ...report }, null, 2), { mode: 0o600 });
  writeFileSync(`${base}.md`, savBenchMarkdown(report, info), { mode: 0o600 });
  const compare = arg("compare");
  if (compare) {
    if (!outside(compare) || !existsSync(compare)) throw Error("SAV_BENCH_COMPARE_REPORT_MISSING");
    const other = JSON.parse(readFileSync(compare, "utf8")) as SavBenchReport;
    const [current, next] = other.agent.name === "current" ? [other, report] : [report, other];
    writeFileSync(join(reportDir, "bench-comparison.md"), savBenchComparisonMarkdown(current, next), { mode: 0o600 });
  }
  console.log(JSON.stringify({ agent: report.agent, judge: report.judge, sha, dryRun, conversations: conversations.length, stopped: report.stopped, acceptance: report.acceptance,
    strict: report.metrics.strict, passed: `${report.metrics.conversationsPassed}/${report.metrics.conversations}`, judgeFailures: report.metrics.judge.failures, wire: totals }));
  if (!report.acceptance.accepted) process.exitCode = 2;
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message.replace(/[^A-Z0-9_:.-]/gi, "_").slice(0, 160) : "SAV_BENCH_FAILED"); process.exitCode = 1; });
