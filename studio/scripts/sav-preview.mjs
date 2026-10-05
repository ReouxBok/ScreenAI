import { spawn } from "node:child_process";
import { open, lstat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PREVIEW_HOST,
  assertNoPreviewEnvironmentFiles,
  assertPreviewNodeVersion,
  createPreviewEnvironment,
  createPreviewPlan,
  parsePreviewArguments,
  preparePreviewDirectories,
} from "./sav-preview-env.mjs";

const studioDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {number} port */
async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`SAV_PREVIEW_PORT_UNAVAILABLE : ${PREVIEW_HOST}:${port} est indisponible. Arrêter l’autre instance ou choisir --port <numéro>.`)));
    probe.listen({ host: PREVIEW_HOST, port, exclusive: true }, () => probe.close((error) => error ? reject(error) : resolve(undefined)));
  });
}

/** Excludes simultaneous PGlite writers, even when two servers use different ports. @param {string} previewDirectory */
export async function acquirePreviewLock(previewDirectory) {
  const lockPath = path.join(previewDirectory, "preview.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error("SAV_PREVIEW_ALREADY_RUNNING : une instance ou un verrou existe déjà dans .sav-preview. Ne pas lancer deux processus sur la même base ; voir docs/SAV_LOCAL_PREVIEW.md.");
    throw error;
  }
  const identity = await lock.stat();
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => {
    await lock.close();
    try {
      const current = await lstat(lockPath);
      // Only our own ephemeral lock is removed; no database/content file is deleted.
      if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  };
}

/** @param {{label: string, args: string[]}} job @param {string} cwd @param {Record<string, string>} env @param {{child: import('node:child_process').ChildProcess | null, signal: NodeJS.Signals | null}} state */
async function runStep(job, cwd, env, state) {
  if (state.signal) throw new Error("SAV_PREVIEW_INTERRUPTED");
  // Recheck before every child: dotenv/Next must not import a newly added .env.
  await assertNoPreviewEnvironmentFiles(cwd);
  if (state.signal) throw new Error("SAV_PREVIEW_INTERRUPTED");
  console.log(`\n${job.label}…`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, job.args, { cwd, env, stdio: "inherit", shell: false });
    state.child = child;
    child.once("error", (error) => reject(new Error(`SAV_PREVIEW_STEP_FAILED : ${job.label} — ${error.message}`)));
    child.once("close", (code, signal) => {
      if (state.child === child) state.child = null;
      if (state.signal || signal) reject(new Error("SAV_PREVIEW_INTERRUPTED"));
      else if (code !== 0) reject(new Error(`SAV_PREVIEW_STEP_FAILED : ${job.label} (code ${code ?? "inconnu"}). La base existante est conservée.`));
      else resolve(undefined);
    });
  });
}

/** @param {string[]} argv */
export async function runSavPreview(argv = process.argv.slice(2)) {
  const options = parsePreviewArguments(argv);
  if (options.help) {
    console.log("Démo SAV locale uniquement.\nUsage : npm run sav:preview -- [--init-only] [--port 3010]\nAucune installation, connexion CRM/email/IA ni remise à zéro automatique.");
    return;
  }
  assertPreviewNodeVersion(process.version);
  await assertNoPreviewEnvironmentFiles(studioDirectory);
  // Validate production/hosting context before creating any local data directory.
  createPreviewEnvironment(path.join(studioDirectory, ".sav-preview", "sav-preview-db"));
  const require = createRequire(path.join(studioDirectory, "package.json"));
  let bins;
  try { bins = { tsx: require.resolve("tsx"), next: require.resolve("next/dist/bin/next") }; }
  catch { throw new Error("SAV_PREVIEW_DEPENDENCIES_MISSING : exécuter npm ci dans studio/ (avec les dépendances de développement), puis relancer. Aucune installation n’est lancée automatiquement."); }
  if (!options.initOnly) await assertPortAvailable(options.port);
  const directories = await preparePreviewDirectories(studioDirectory);
  const env = createPreviewEnvironment(directories.databaseDirectory);
  const releaseLock = await acquirePreviewLock(directories.previewDirectory);
  /** @type {{child: import('node:child_process').ChildProcess | null, signal: NodeJS.Signals | null}} */
  const state = { child: null, signal: null };
  /** @param {NodeJS.Signals} signal */
  const stop = (signal) => { state.signal = signal; state.child?.kill(signal); };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    console.log("Démo SAV : données fictives, utilisateur local Ugo, V0 shadow, écritures externes désactivées.");
    console.log(`Base locale dédiée : ${directories.databaseDirectory}`);
    if (!options.initOnly) console.log(`Adresse prévue : http://${PREVIEW_HOST}:${options.port}/studio/sav — Ctrl+C pour arrêter.`);
    for (const job of createPreviewPlan(directories.studioDirectory, bins, options)) await runStep(job, directories.studioDirectory, env, state);
    if (options.initOnly) console.log("Initialisation locale terminée. Aucun serveur lancé ; aucune base existante supprimée.");
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    await releaseLock();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runSavPreview().catch((error) => {
    if (error instanceof Error && error.message === "SAV_PREVIEW_INTERRUPTED") {
      console.log("\nDémo locale arrêtée ; données locales conservées.");
      process.exitCode = 130;
    } else {
      console.error(error instanceof Error ? error.message : "SAV_PREVIEW_FAILED");
      process.exitCode = 1;
    }
  });
}
