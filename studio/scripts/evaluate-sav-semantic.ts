import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSavSemanticCampaign } from "../src/lib/sav/semantic-evaluation";

// Deliberately no dotenv, DB, application services, provider, or network imports.
// Keep campaign artifacts outside the public repository, including symlink targets.
async function main() {
  const suppliedPath = process.argv[2];
  if (process.argv.length !== 3 || !suppliedPath || !isAbsolute(suppliedPath)) throw new Error("SAV_SEMANTIC_PRIVATE_PATH_REQUIRED");
  const repoRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const filename = await realpath(suppliedPath);
  const relativePath = relative(repoRoot, filename);
  if (!relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(relativePath)) throw new Error("SAV_SEMANTIC_ARTIFACT_INSIDE_PUBLIC_REPOSITORY");
  if ((await stat(filename)).size > 5_000_000) throw new Error("SAV_SEMANTIC_ARTIFACT_TOO_LARGE");
  const report = evaluateSavSemanticCampaign(JSON.parse(await readFile(filename, "utf8")));
  console.log(JSON.stringify(report, null, 2));
  if (!report.releaseReady) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Parse errors and filesystem errors may contain private values or paths.
  const code = error instanceof Error && /^SAV_SEMANTIC_[A-Z_]+$/.test(error.message) ? error.message : "SAV_SEMANTIC_ARTIFACT_INVALID";
  console.error(JSON.stringify({ releaseReady: false, blockers: [code] }));
  process.exitCode = 1;
});
