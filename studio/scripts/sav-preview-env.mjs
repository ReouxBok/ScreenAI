import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PREVIEW_PORT = 3010;
export const PREVIEW_HOST = "127.0.0.1";
// Public, fixed fixture key. It is deliberately not a production secret.
export const PREVIEW_ENCRYPTION_KEY = "sav-local-preview-v1-fictitious-data-never-production";

const SYSTEM_ENVIRONMENT_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ",
]);
const LOADED_ENVIRONMENT_FILES = new Set([
  ".env", ".env.local", ".env.development", ".env.development.local",
]);

/** @param {string[]} argv */
export function parsePreviewArguments(argv) {
  let initOnly = false;
  let help = false;
  let port = DEFAULT_PREVIEW_PORT;
  let portSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--init-only" && !initOnly) initOnly = true;
    else if ((argument === "--help" || argument === "-h") && !help) help = true;
    else if (argument === "--port" && !portSeen) {
      const value = argv[++index];
      if (!value || !/^\d{1,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
        throw new Error("SAV_PREVIEW_PORT_INVALID : choisir un port entier entre 1024 et 65535.");
      }
      port = Number(value);
      portSeen = true;
    } else throw new Error("SAV_PREVIEW_ARGUMENT_INVALID : option inconnue ou répétée. Options : --init-only, --port <numéro>, --help.");
  }
  return { initOnly, help, port };
}

/** @param {string} version */
export function assertPreviewNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!match || !(major >= 24 || (major === 22 && minor >= 13))) {
    throw new Error("SAV_PREVIEW_NODE_UNSUPPORTED : Node 24 conseillé ; Node 22.13+ également accepté. Aucune installation automatique.");
  }
}

/** @param {string} databaseDirectory @param {Record<string, string | undefined>} inherited */
export function createPreviewEnvironment(databaseDirectory, inherited = process.env) {
  if (inherited.NODE_ENV === "production" || inherited.VERCEL === "1") {
    throw new Error("SAV_PREVIEW_LOCAL_ONLY : ce lanceur est réservé à une machine locale hors production.");
  }
  const normalizedDirectory = databaseDirectory.replaceAll("\\", "/");
  const absolute = normalizedDirectory.startsWith("/") || /^[a-z]:\//i.test(normalizedDirectory);
  if (!absolute || !normalizedDirectory.endsWith("/.sav-preview/sav-preview-db") || normalizedDirectory.startsWith("//")
    || normalizedDirectory.includes("\0") || normalizedDirectory.split("/").includes("..")) {
    throw new Error("SAV_PREVIEW_DATABASE_PATH_INVALID : utiliser uniquement le répertoire local dédié .sav-preview/sav-preview-db.");
  }
  /** @type {Record<string, string>} */
  const environment = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (SYSTEM_ENVIRONMENT_KEYS.has(name.toUpperCase()) && typeof value === "string") environment[name] = value;
  }
  return {
    ...environment,
    NODE_ENV: "development",
    DATABASE_URL: `pglite:${normalizedDirectory}`,
    DEV_AUTH_BYPASS: "true",
    DEV_USER_EMAIL: "ugo@limova.ai",
    SAV_RELEASE_STAGE: "v0",
    SAV_AUTOMATION_MODE: "shadow",
    SAV_WRITES_DISABLED: "true",
    SAV_ADK_MODE: "off",
    SAV_AI_ANALYSIS: "false",
    SAV_PILOT_MODE: "false",
    SAV_HUBSPOT_BACKFILL_ENABLED: "false",
    SAV_RETENTION_ENABLED: "false",
    SAV_ALLOW_UNSIGNED_WEBHOOKS: "false",
    SAV_TEST_MODE: "true",
    SAV_TEST_OUTBOUND_ALLOWLIST: "",
    SAV_ENCRYPTION_KEY_V1: PREVIEW_ENCRYPTION_KEY,
    MEMORY_AI_EXTRACTION: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    OTEL_SDK_DISABLED: "true",
    WATCHPACK_POLLING: "true",
  };
}

/** Refuse loader-relevant files by name, without ever reading their contents. @param {string} studioDirectory */
export async function assertNoPreviewEnvironmentFiles(studioDirectory) {
  const found = (await readdir(studioDirectory)).filter((name) => LOADED_ENVIRONMENT_FILES.has(name.toLowerCase()));
  if (found.length) {
    throw new Error(`SAV_PREVIEW_ENV_FILES_FORBIDDEN : ${found.sort().join(", ")}. Utiliser un checkout dédié sans ces fichiers ; aucune valeur n’a été lue.`);
  }
}

/** @param {string} directory */
async function ensureRealDirectory(directory) {
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("SAV_PREVIEW_DIRECTORY_UNSAFE : le dossier local ne doit pas être un fichier ni un lien symbolique.");
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  if (actual !== path.resolve(directory)) throw new Error("SAV_PREVIEW_DIRECTORY_UNSAFE : le chemin local a été redirigé.");
}

/** Creates only dedicated directories, never removes or resets a database. @param {string} studioDirectory */
export async function preparePreviewDirectories(studioDirectory) {
  const studioRoot = await realpath(studioDirectory);
  const previewDirectory = path.join(studioRoot, ".sav-preview");
  const databaseDirectory = path.join(previewDirectory, "sav-preview-db");
  await ensureRealDirectory(previewDirectory);
  await ensureRealDirectory(databaseDirectory);
  return { studioDirectory: studioRoot, previewDirectory, databaseDirectory };
}

/** @param {string} studioDirectory @param {{tsx: string, next: string}} bins @param {{initOnly: boolean, port: number}} options */
export function createPreviewPlan(studioDirectory, bins, options) {
  const tsxLoader = pathToFileURL(bins.tsx).href;
  const preparation = [
    ["Migrations locales", "migrate.ts"],
    ["Connaissances fictives", "seed-sav-preview.ts"],
    ["Inbox fictive", "seed-sav-inbox-preview.ts"],
  ].map(([label, file]) => ({ label, args: ["--conditions=react-server", "--import", tsxLoader, path.join(studioDirectory, "scripts", file)] }));
  return options.initOnly ? preparation : [...preparation, {
    label: "Studio local",
    args: [bins.next, "dev", "--hostname", PREVIEW_HOST, "--port", String(options.port)],
  }];
}
