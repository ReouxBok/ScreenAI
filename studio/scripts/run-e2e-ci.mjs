import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const studio = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(studio, "node_modules/@playwright/test/cli.js");

/** Use Playwright's own discovery, never a second list of test titles. */
export function discoveredCases(report) {
  const cases = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      if (!spec.file || !Number.isInteger(spec.line) || spec.tests?.length !== 1) {
        throw Error("Expected one project/test per discovered spec");
      }
      const file = path.relative(studio, path.resolve(report.config?.rootDir ?? studio, spec.file));
      cases.push({ selector: `${file}:${spec.line}`, title: spec.title, test: spec.tests[0] });
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  if (!cases.length || new Set(cases.map(item => item.selector)).size !== cases.length) {
    throw Error("Empty or ambiguous Playwright discovery");
  }
  return cases;
}

export function assertPartition(report, expected) {
  const actual = discoveredCases(report);
  if (actual.length !== 1 || actual[0].selector !== expected.selector || actual[0].title !== expected.title) {
    throw Error("Partition does not cover exactly its discovered test");
  }
  const results = actual[0].test.results;
  if (actual[0].test.expectedStatus !== "passed" || results?.length !== 1 || results[0].status !== "passed"
    || report.errors?.length) {
    throw Error("Partition failed, skipped, retried or reported an error");
  }
}

export function childEnvironment(env) {
  // Direct node invocation does not add the npm script binary directory.
  return { ...env, PATH: `${path.join(studio, "node_modules/.bin")}${path.delimiter}${env.PATH ?? ""}` };
}

function run(args, { capture = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: studio, env: childEnvironment(env), stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let output = "", requestedSignal = null;
    if (capture) child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
    const interrupt = signal => { requestedSignal = signal; child.kill(signal); };
    const sigint = () => interrupt("SIGINT"), sigterm = () => interrupt("SIGTERM");
    process.once("SIGINT", sigint);
    process.once("SIGTERM", sigterm);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", sigint);
      process.removeListener("SIGTERM", sigterm);
      resolve({ code, signal: signal ?? requestedSignal, output });
    });
  });
}

async function main() {
  const resultsRoot = path.join(studio, "test-results");
  await mkdir(resultsRoot, { recursive: true });
  const directory = await mkdtemp(path.join(resultsRoot, "ci-partitions-"));
  const discovery = await run(["test", "--list", "--reporter=json"], { capture: true });
  if (discovery.code !== 0) throw Error("Playwright discovery failed");
  const report = JSON.parse(discovery.output);
  if (report.errors?.length) throw Error("Playwright discovery reported errors");
  const cases = discoveredCases(report);
  // The release gate currently covers exactly these 20 tests. A coverage change
  // must be reviewed, rather than silently accepting a filtered/empty suite.
  if (cases.length !== 20) throw Error(`Expected 20 tests, discovered ${cases.length}`);
  const manifest = { discovered: cases.map(({ selector, title }) => ({ selector, title })), partitions: [] };
  const manifestFile = path.join(directory, "manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  let interrupted = false;
  for (const [index, item] of cases.entries()) {
    const output = path.join(directory, String(index + 1).padStart(2, "0"));
    const jsonFile = path.join(directory, `${index + 1}.json`);
    console.log(`\nStudio browser partition ${index + 1}/${cases.length}: ${item.selector} — ${item.title}`);
    // Each CLI invocation owns a new Next process and a freshly seeded DB.
    // The config retains workers=1/retries=0/auth/heap/webpack and its reviewed
    // cold-process functional assertion budgets. Coverage is still exact.
    const startedAt = Date.now();
    const result = await run(["test", item.selector, "--reporter=list,json", `--output=${output}`], {
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: jsonFile },
    });
    let error = null;
    try {
      assertPartition(JSON.parse(await readFile(jsonFile, "utf8")), item);
      if (result.code !== 0 || result.signal) throw Error("Playwright process did not succeed");
    } catch (failure) {
      error = failure.message;
    }
    manifest.partitions.push({ selector: item.selector, title: item.title, code: result.code,
      signal: result.signal, durationMs: Date.now() - startedAt, error });
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    if (result.signal || result.code === 130 || result.code === 143) {
      interrupted = true;
      break;
    }
  }
  const success = !interrupted && manifest.partitions.length === cases.length
    && manifest.partitions.every(item => item.error === null);
  console.log(`Studio browser coverage: ${manifest.partitions.length}/${cases.length}; ${success ? "PASS" : "FAIL"}. Manifest: ${manifestFile}`);
  process.exitCode = success ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
