import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SAV_ACCESS_SKILL_CORPUS } from "../src/lib/sav/cases/access-skill/access-skill-corpus.fixture";
import { AccessSkillEvalStop, accessSkillLabelledAnswer, runAccessSkillEvaluation } from "../src/lib/sav/cases/access-skill/access-skill-eval";
import { accessSkillPromptSha256, SAV_ACCESS_SKILL_REVISION } from "../src/lib/sav/cases/access-skill/access-skill-guidelines";
import { accessSkillWireAnswer, accessSkillWireBody, readAccessSkillWireResponse, SAV_ACCESS_SKILL_GEMINI_URL } from "../src/lib/sav/cases/access-skill/access-skill-wire";

/*
 * SAV-97 operator evaluation of the Access skill on the FICTIONAL corpus, outside CI (the production self-test, SAV_V2_ACCESS_SKILL_SELFTEST, is the
 * path when the key stays in Vercel). Same wire, same readings and same rule as production. 3 passes, a spend cap in EUR, a cache by request hash
 * (an interrupted run is resumed without paying again), stop at the first sensitive mail admitted. The report and cache are written OUTSIDE the
 * repository (0600), ids and codes only. Key: SAV_V2_GEMINI_API_KEY, never printed.
 *   --dry-run                     no key, no network: the labelled double answers (checks the plumbing)
 *   --report=/abs/path.json       required, outside the repository
 *   --cache=/abs/path.json        optional, outside the repository
 *   --model=<id>                  required unless --dry-run
 *   --cap-eur=10 --eur-per-million-input=<n> --eur-per-million-output=<n> --passes=3 --max-output-tokens=1024
 */
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const number = (name: string, fallback?: number) => { const raw = arg(name); const value = raw === undefined ? fallback : Number(raw); if (value === undefined || !Number.isFinite(value) || value < 0) throw Error(`SAV_ACCESS_EVAL_ARG_${name}`); return value; };
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outside = (path: string) => { const rel = relative(root, resolve(path)); return isAbsolute(path) && (rel.startsWith(`..${sep}`) || isAbsolute(rel)); };

async function main() {
  const dryRun = process.argv.includes("--dry-run"), report = arg("report"), cachePath = arg("cache");
  if (!report || !outside(report) || (cachePath && !outside(cachePath))) throw Error("SAV_ACCESS_EVAL_PRIVATE_PATH_OUTSIDE_REPOSITORY_REQUIRED");
  const passes = number("passes", 3), capEur = number("cap-eur", 10), maxOutputTokens = number("max-output-tokens", 1024);
  const priceIn = dryRun ? 0 : number("eur-per-million-input"), priceOut = dryRun ? 0 : number("eur-per-million-output");
  const model = dryRun ? "dry-run" : arg("model") ?? "", key = process.env.SAV_V2_GEMINI_API_KEY ?? "";
  if (!dryRun && (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(model) || !key)) throw Error("SAV_ACCESS_EVAL_MODEL_AND_KEY_REQUIRED");
  if (capEur > 10) throw Error("SAV_ACCESS_EVAL_CAP_ABOVE_APPROVED_10_EUR");
  const cache: Record<string, unknown> = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  let spentEur = 0, paidCalls = 0, cachedCalls = 0;
  const worstEur = (bytes: number) => (bytes / 2) * priceIn / 1e6 + maxOutputTokens * priceOut / 1e6;
  const result = await runAccessSkillEvaluation({ cases: SAV_ACCESS_SKILL_CORPUS, passes, stopOnSensitiveAdmitted: true, call: async (kind, input, context) => {
    const row = SAV_ACCESS_SKILL_CORPUS.find(item => item.id === context.caseId)!, body = accessSkillWireBody(kind, input, maxOutputTokens);
    const hash = createHash("sha256").update(JSON.stringify([model, context.pass, body])).digest("hex");
    let json = cache[hash];
    if (json === undefined) {
      if (dryRun) { const answer = accessSkillLabelledAnswer(row, kind, "honest"); json = answer.status === "ok" ? accessSkillWireAnswer(answer.output) : {}; }
      else {
        if (spentEur + worstEur(Buffer.byteLength(body)) > capEur) throw new AccessSkillEvalStop("spend_cap");
        const response = await fetch(`${SAV_ACCESS_SKILL_GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, { method: "POST", signal: AbortSignal.timeout(25_000),
          headers: { "content-type": "application/json", "x-goog-api-key": key }, body }).catch(() => null);
        json = response?.ok ? await response.json() : { failed: response ? `http_${response.status}` : "network_failed" };
        paidCalls += 1;
      }
      cache[hash] = json;
      if (cachePath) writeFileSync(cachePath, JSON.stringify(cache), { mode: 0o600 });
    } else cachedCalls += 1;
    const read = readAccessSkillWireResponse(json);
    spentEur += !dryRun && read.usage ? (read.usage.inputTokens * priceIn + read.usage.outputTokens * priceOut) / 1e6 : 0;
    return read.status === "ok" ? { status: "ok", output: read.output } : { status: "failed", problem: read.problem, uncertain: read.uncertain };
  } });
  const summary = { revision: SAV_ACCESS_SKILL_REVISION, promptSha256: accessSkillPromptSha256(), model, dryRun, passes: result.passes, stopped: result.stopped, acceptance: result.acceptance,
    spentEur: Math.round(spentEur * 10_000) / 10_000, paidCalls, cachedCalls };
  writeFileSync(report, JSON.stringify({ ...summary, rows: result.rows }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, passes: result.passes.map(pass => ({ pass: pass.pass, sensitiveAdmitted: pass.sensitiveAdmitted, accessRecall: pass.accessRecall, capcarRecall: pass.capcarRecall })) }));
  if (!result.acceptance.accepted) process.exitCode = 2;
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message.replace(/[^A-Z0-9_:.-]/gi, "_").slice(0, 160) : "SAV_ACCESS_EVAL_FAILED"); process.exitCode = 1; });
