/** Offline sealing only: no environment, model, CRM, auth or database access. */
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluationBatchSchema, evaluationHash, EVALUATION_MAX_BYTES } from "../src/lib/sav/intake/server-contract";

async function main() {
  const [source, destination] = process.argv.slice(2);
  if (process.argv.length !== 4 || !source || !destination || !isAbsolute(source) || !isAbsolute(destination)) throw Error("SAV_EVAL_PRIVATE_PATH_REQUIRED");
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const input = await realpath(source), outputDirectory = await realpath(dirname(destination));
  const outside = (path: string) => { const rel = relative(root, path); return rel.startsWith(".." + sep) || isAbsolute(rel); };
  const info = await stat(input);
  if (!outside(input) || !outside(outputDirectory) || !info.isFile() || info.size > EVALUATION_MAX_BYTES || info.mode & 0o077 || (await stat(outputDirectory)).mode & 0o077) throw Error("SAV_EVAL_PRIVATE_PATH_REQUIRED");
  const raw = await readFile(input);
  const batch = evaluationBatchSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
  const sealed = JSON.stringify(batch);
  if (Buffer.byteLength(sealed) > EVALUATION_MAX_BYTES) throw Error("SAV_EVAL_BODY_REJECTED");
  await writeFile(resolve(outputDirectory, destination.split(sep).at(-1)!), sealed, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ manifestSha256: evaluationHash(sealed), cases: batch.cases.length, bytes: Buffer.byteLength(sealed), effects: "none" }));
}
main().catch(() => { console.error("SAV_EVAL_SEALING_FAILED"); process.exitCode = 1; });
