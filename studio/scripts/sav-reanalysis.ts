/** Private operator CLI. No route, cron, worker or automatic adoption. */
import { readFile, open, stat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { reanalysisApprovalSchema, reanalysisHash, reanalysisManifestSchema, validateReanalysisRuntime } from "../src/lib/sav/reanalysis-contract";

async function main() {
  const [command = "plan", ...args] = process.argv.slice(2);
  if (!["plan", "execute", "compare", "cancel"].includes(command) || args.length % 2) throw new Error("SAV_REANALYSIS_ARGUMENTS_REFUSED");
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--input", "--output", "--target", "--approval"].includes(args[i]) || options.has(args[i])) throw new Error("SAV_REANALYSIS_ARGUMENTS_REFUSED");
    options.set(args[i], args[i + 1]);
  }
  // Refuse before loading any DB/model module. No .env auto-load, no secret output.
  if (command === "execute" && process.env.SAV_REANALYSIS_EXECUTION_ENABLED !== "true") throw new Error("SAV_REANALYSIS_EXECUTION_DISABLED");
  const identity = validateReanalysisRuntime(process.env);
  const privatePath = async (value: string | undefined, exists: boolean) => {
    if (!value || !isAbsolute(value)) throw new Error("SAV_REANALYSIS_PRIVATE_PATH_REQUIRED");
    const path = exists ? await realpath(value) : resolve(await realpath(dirname(value)), value.split("/").pop()!);
    const checkout = resolve(import.meta.dirname, "../..");
    const rel = relative(checkout, path);
    if (!(rel === ".." || rel.startsWith("../") || isAbsolute(rel))) throw new Error("SAV_REANALYSIS_OUTPUT_IN_CHECKOUT_REFUSED");
    if (exists && ((await stat(path)).mode & 0o077)) throw new Error("SAV_REANALYSIS_FILE_PERMISSIONS_REFUSED");
    return path;
  };
  const readPrivate = async (key: string) => JSON.parse(await readFile(await privatePath(options.get(key), true), "utf8"));
  const pinSchema = z.object({ projectId: z.string(), teamId: z.string(), databaseHash: z.string(), codeRevision: z.string() }).strict();
  const pin = pinSchema.parse(await readPrivate("--target"));
  if (reanalysisHash(pin) !== reanalysisHash(identity)) throw new Error("SAV_REANALYSIS_TARGET_REFUSED");
  const input = await readPrivate("--input");
  const outputPath = await privatePath(options.get("--output"), false);
  const approval = command === "execute" ? reanalysisApprovalSchema.parse(await readPrivate("--approval")) : null;
  // Validate all input shapes before opening a connection.
  const seedSchema = z.object({ since: z.iso.datetime({ offset: true }), until: z.iso.datetime({ offset: true }),
    pairs: z.array(z.object({ threadId: z.uuid(), messageId: z.uuid() }).strict()).min(1).max(216) }).strict();
  const parsed = command === "plan" ? seedSchema.parse(input) : reanalysisManifestSchema.parse(input);
  const { sql } = await import("drizzle-orm");
  const { requireDb, closeDb } = await import("../src/db");
  // Reserve the private output before any possible paid call or write.
  const output = await open(outputPath, "wx", 0o600);
  try {
    // All preparation/comparison queries use server-enforced read-only transactions.
    if (["plan", "compare"].includes(command)) await requireDb().execute(sql`set default_transaction_read_only = on`);
    const engine = await import("../src/lib/sav/reanalysis");
    const target = await engine.currentReanalysisTarget(identity);
    let result: unknown;
    if (command === "plan") result = await engine.prepareReanalysisManifest({ ...seedSchema.parse(parsed), target });
    else {
      const manifest = reanalysisManifestSchema.parse(parsed);
      if (reanalysisHash(target) !== reanalysisHash(manifest.target)) throw new Error("SAV_REANALYSIS_TARGET_CHANGED");
      if (command === "execute") result = await engine.executeReanalysis(manifest, approval!, target);
      else if (command === "compare") result = await engine.compareReanalysis(manifest);
      else { await engine.cancelReanalysis(manifest.batchId); result = { cancelled: true }; }
    }
    // Exclusive create: no overwriting an approval, corpus or previous comparison.
    await output.writeFile(JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ command, completed: true }));
  } finally { await output.close(); await closeDb(); }
}
main().catch(() => { console.error("SAV_REANALYSIS_COMMAND_REFUSED_OR_FAILED"); process.exitCode = 1; });
