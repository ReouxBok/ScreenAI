import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { savSemanticArtifactHash, savSemanticManifestSchema, savSemanticManifestBlockers } from "../src/lib/sav/semantic-evaluation";
import { assertSavEvaluationEnvironment, createSavEvaluationFetch, runSavPrivateModelCase, SAV_EVALUATION_ADAPTER_REVISION, savPrivateModelCaseSchema, type SavIsolatedAnalysis, type SavEvaluationRequest } from "../src/lib/sav/semantic-model-runner";

// No dotenv and no application imports before environment, path, corpus and adapter checks.
async function main() {
  assertSavEvaluationEnvironment(process.env);
  const [inputPath, outputPath] = process.argv.slice(2);
  if (process.argv.length !== 4 || !inputPath || !outputPath || !isAbsolute(inputPath) || !isAbsolute(outputPath)) throw new Error("SAV_SEMANTIC_PRIVATE_PATH_REQUIRED");
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const filename = await realpath(inputPath), outputDirectory = await realpath(dirname(outputPath));
  const outside = (path: string) => { const rel = relative(root, path); return rel.startsWith(`..${sep}`) || isAbsolute(rel); };
  if (!outside(filename) || !outside(outputDirectory)) throw new Error("SAV_SEMANTIC_ARTIFACT_INSIDE_PUBLIC_REPOSITORY");
  if ((await stat(outputDirectory)).mode & 0o077) throw new Error("SAV_SEMANTIC_PRIVATE_DIRECTORY_REQUIRED");
  if ((await stat(filename)).size > 10_000_000) throw new Error("SAV_SEMANTIC_ARTIFACT_TOO_LARGE");
  if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("SAV_SEMANTIC_CHECKOUT_NOT_CLEAN");
  const codeRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const input = z.object({ version: z.literal(1), manifest: savSemanticManifestSchema,
    model: z.string().regex(/^[a-zA-Z0-9._-]+$/), mode: z.enum(["off", "shadow", "pilot", "on"]),
    cases: z.array(savPrivateModelCaseSchema).min(1).max(1000),
  }).strict().parse(JSON.parse(await readFile(filename, "utf8")));
  if (savSemanticManifestBlockers(input.manifest).length) throw new Error("SAV_SEMANTIC_APPROVED_FROZEN_MANIFEST_REQUIRED");
  if (new Set(input.cases.map((item) => item.id)).size !== input.cases.length || input.cases.length !== input.manifest.cases.length) throw new Error("SAV_SEMANTIC_CASE_SET_MISMATCH");
  for (const item of input.cases) if (!input.manifest.cases.some((descriptor) => descriptor.id === item.id && descriptor.inputHash === savSemanticArtifactHash(item))) throw new Error("SAV_SEMANTIC_PRIVATE_INPUT_HASH_MISMATCH");
  const startedAt = new Date().toISOString();
  if (startedAt < input.manifest.frozenAt) throw new Error("SAV_SEMANTIC_MANIFEST_NOT_FROZEN");
  const apiKey = process.env.SAV_EVAL_GEMINI_API_KEY!;
  process.env.SAV_CODE_REVISION = codeRevision;
  process.env.SAV_WRITES_DISABLED = "true";
  process.env.SAV_RELEASE_STAGE = "v0";
  // Covers SDK fetch calls too. The injected fetch records the direct pipeline calls.
  const originalFetch = globalThis.fetch;
  const requests: SavEvaluationRequest[] = [];
  globalThis.fetch = createSavEvaluationFetch({ apiKey, model: input.model, fetch: originalFetch, requests });
  try {
    const analysisModule: unknown = await import("../src/lib/sav/intelligence");
    const runtime = analysisModule as { SAV_EVALUATION_ADAPTER_REVISION?: string; analyzeSavMessage?: SavIsolatedAnalysis };
    if (runtime.SAV_EVALUATION_ADAPTER_REVISION !== SAV_EVALUATION_ADAPTER_REVISION || typeof runtime.analyzeSavMessage !== "function") throw new Error("SAV_SEMANTIC_ADAPTER_UNAVAILABLE");
    // Exclusive mode reserves the private output before the first billable call.
    const artifact = { version: 1, scope: "raw_private_model_evidence_requires_human_review", manifestHash: savSemanticArtifactHash(input.manifest),
      model: input.model, mode: input.mode, codeRevision, startedAt, completedAt: null as string | null, results: [] as unknown[] };
    await writeFile(outputPath, JSON.stringify(artifact), { mode: 0o600, flag: "wx" });
    for (const testCase of input.cases) {
      const requestOffset = requests.length;
      try { artifact.results.push(await runSavPrivateModelCase(testCase, { apiKey, model: input.model, mode: input.mode, analyze: runtime.analyzeSavMessage, fetch: originalFetch, requests })); }
      catch { artifact.results.push({ caseId: testCase.id, inputHash: savSemanticArtifactHash(testCase), outcome: "execution_failed", requests: requests.slice(requestOffset), humanReview: null }); }
      // Preserve failures and partial campaigns on interruption; never retry a case implicitly.
      await writeFile(outputPath, JSON.stringify(artifact), { mode: 0o600 });
    }
    artifact.completedAt = new Date().toISOString();
    await writeFile(outputPath, JSON.stringify(artifact), { mode: 0o600 });
    console.log(JSON.stringify({ scope: artifact.scope, completed: artifact.results.length, releaseReady: false, humanReviewRequired: true }));
  } finally { globalThis.fetch = originalFetch; }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^SAV_SEMANTIC_[A-Z_]+$/.test(error.message) ? error.message : "SAV_SEMANTIC_EVALUATION_FAILED";
  console.error(JSON.stringify({ releaseReady: false, blockers: [code] }));
  process.exitCode = 1;
});
