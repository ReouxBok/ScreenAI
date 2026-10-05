import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PREVIEW_ENCRYPTION_KEY,
  assertNoPreviewEnvironmentFiles,
  assertPreviewNodeVersion,
  createPreviewEnvironment,
  createPreviewPlan,
  parsePreviewArguments,
  preparePreviewDirectories,
} from "../../../scripts/sav-preview-env.mjs";
import { acquirePreviewLock } from "../../../scripts/sav-preview.mjs";

const temporaryDirectories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "sav-preview-launcher-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("isolated SAV preview launcher", () => {
  it("never inherits external credentials, production databases, preloads or dotenv overrides", () => {
    const env = createPreviewEnvironment("/checkout/studio/.sav-preview/sav-preview-db", {
      PATH: "/safe/path", HOME: "/example/home", TMPDIR: "/example/tmp",
      DATABASE_URL: "postgresql://do-not-use", HUBSPOT_ACCESS_TOKEN: "do-not-use",
      GMAIL_REFRESH_TOKEN: "do-not-use", SAV_GEMINI_API_KEY: "do-not-use", GEMINI_API_KEY: "do-not-use",
      EXTENSION_GEMINI_API_KEY: "do-not-use", KNOWLEDGE_GEMINI_API_KEY: "do-not-use",
      MEMORY_DATABASE_URL: "postgresql://do-not-use", MEMORY_GEMINI_API_KEY: "do-not-use",
      BLOB_READ_WRITE_TOKEN: "do-not-use", CLERK_SECRET_KEY: "do-not-use", CRON_SECRET: "do-not-use",
      NODE_OPTIONS: "--import unsafe-module", NODE_PATH: "/unsafe/modules", DOTENV_CONFIG_PATH: "/unsafe/.env",
      SAV_ENCRYPTION_KEY_V1: "do-not-use", SAV_WRITES_DISABLED: "false", DEV_USER_EMAIL: "other@example.com",
    });
    expect(env).toMatchObject({
      PATH: "/safe/path", HOME: "/example/home", TMPDIR: "/example/tmp", NODE_ENV: "development",
      DATABASE_URL: "pglite:/checkout/studio/.sav-preview/sav-preview-db", DEV_AUTH_BYPASS: "true", DEV_USER_EMAIL: "ugo@limova.ai",
      SAV_WRITES_DISABLED: "true", SAV_RELEASE_STAGE: "v0", SAV_AUTOMATION_MODE: "shadow", SAV_ADK_MODE: "off", SAV_AI_ANALYSIS: "false",
      SAV_ENCRYPTION_KEY_V1: PREVIEW_ENCRYPTION_KEY, NEXT_TELEMETRY_DISABLED: "1",
    });
    expect(JSON.stringify(env)).not.toContain("do-not-use");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("NODE_PATH");
    expect(env).not.toHaveProperty("DOTENV_CONFIG_PATH");
    expect(env).not.toHaveProperty("HUBSPOT_ACCESS_TOKEN");
    expect(env).not.toHaveProperty("GMAIL_REFRESH_TOKEN");
  });

  it("normalizes Windows DB paths and preserves essential Windows system variables", () => {
    const env = createPreviewEnvironment("C:\\Projects\\Studio\\.sav-preview\\sav-preview-db", {
      Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", COMSPEC: "cmd.exe",
    });
    expect(env.DATABASE_URL).toBe("pglite:C:/Projects/Studio/.sav-preview/sav-preview-db");
    expect(env).toMatchObject({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", COMSPEC: "cmd.exe" });
    expect(() => createPreviewEnvironment("\\\\server\\share\\.sav-preview\\sav-preview-db", {})).toThrow("SAV_PREVIEW_DATABASE_PATH_INVALID");
  });

  it("refuses production/hosting context and arbitrary database targets", () => {
    const db = "/checkout/studio/.sav-preview/sav-preview-db";
    expect(() => createPreviewEnvironment(db, { NODE_ENV: "production" })).toThrow("SAV_PREVIEW_LOCAL_ONLY");
    expect(() => createPreviewEnvironment(db, { VERCEL: "1" })).toThrow("SAV_PREVIEW_LOCAL_ONLY");
    expect(() => createPreviewEnvironment("/production/database", {})).toThrow("SAV_PREVIEW_DATABASE_PATH_INVALID");
    expect(() => createPreviewEnvironment("relative/.sav-preview/sav-preview-db", {})).toThrow("SAV_PREVIEW_DATABASE_PATH_INVALID");
    expect(() => createPreviewEnvironment("/unrelated/../studio/.sav-preview/sav-preview-db", {})).toThrow("SAV_PREVIEW_DATABASE_PATH_INVALID");
  });

  it("accepts only explicit initialization/port options and supported Node versions", () => {
    expect(parsePreviewArguments([])).toEqual({ initOnly: false, help: false, port: 3010 });
    expect(parsePreviewArguments(["--init-only", "--port", "4010"])).toEqual({ initOnly: true, help: false, port: 4010 });
    expect(parsePreviewArguments(["--help"]).help).toBe(true);
    for (const argv of [["--reset"], ["--port"], ["--port", "0"], ["--port", "65536"], ["--port", "3010;danger"], ["--port", "3010", "--port", "3011"]]) {
      expect(() => parsePreviewArguments(argv)).toThrow("SAV_PREVIEW_");
    }
    for (const version of ["22.13.0", "v22.22.1", "24.0.0"]) expect(() => assertPreviewNodeVersion(version)).not.toThrow();
    for (const version of ["20.9.0", "22.12.0", "23.5.0", "invalid"]) expect(() => assertPreviewNodeVersion(version)).toThrow("SAV_PREVIEW_NODE_UNSUPPORTED");
  });

  it("refuses environment files by name, without copying or editing their contents", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, ".env.example"), "DOCUMENTATION_ONLY=true");
    await assertNoPreviewEnvironmentFiles(directory);
    await writeFile(path.join(directory, ".env.local"), "THIS_CONTENT_MUST_STAY_UNTOUCHED=true");
    await expect(assertNoPreviewEnvironmentFiles(directory)).rejects.toThrow("SAV_PREVIEW_ENV_FILES_FORBIDDEN");
    expect(await readFile(path.join(directory, ".env.local"), "utf8")).toBe("THIS_CONTENT_MUST_STAY_UNTOUCHED=true");
  });

  it("creates dedicated directories and preserves existing local DB files", async () => {
    const directory = await temporaryDirectory();
    const first = await preparePreviewDirectories(directory);
    await writeFile(path.join(first.databaseDirectory, "existing-fixture-marker"), "preserved");
    expect(await preparePreviewDirectories(directory)).toEqual(first);
    expect(await readFile(path.join(first.databaseDirectory, "existing-fixture-marker"), "utf8")).toBe("preserved");
    expect(first.databaseDirectory).toBe(path.join(first.previewDirectory, "sav-preview-db"));
  });

  it("refuses a preview directory redirected via a symbolic link", async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, "unrelated-data");
    await mkdir(target);
    await writeFile(path.join(target, "untouched"), "preserved");
    await symlink(target, path.join(directory, ".sav-preview"), process.platform === "win32" ? "junction" : "dir");
    await expect(preparePreviewDirectories(directory)).rejects.toThrow("SAV_PREVIEW_DIRECTORY_UNSAFE");
    expect(await readFile(path.join(target, "untouched"), "utf8")).toBe("preserved");
  });

  it("locks a single local writer and removes only its own temporary lock on release", async () => {
    const directory = await temporaryDirectory();
    const { previewDirectory, databaseDirectory } = await preparePreviewDirectories(directory);
    const marker = path.join(databaseDirectory, "existing-data");
    await writeFile(marker, "preserved");
    const release = await acquirePreviewLock(previewDirectory);
    try {
      await expect(acquirePreviewLock(previewDirectory)).rejects.toThrow("SAV_PREVIEW_ALREADY_RUNNING");
      expect(JSON.parse(await readFile(path.join(previewDirectory, "preview.lock"), "utf8")).pid).toBe(process.pid);
    } finally { await release(); }
    await expect(access(path.join(previewDirectory, "preview.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(marker, "utf8")).toBe("preserved");
    const releaseAgain = await acquirePreviewLock(previewDirectory);
    await releaseAgain();
  });

  it("plans sequential local migrations/seeds then dev loopback, with no npm/install/build/deployment", () => {
    const directory = "/example/checkout with spaces/studio";
    const bins = { tsx: "/example/node_modules/tsx/dist/loader.mjs", next: "/example/node_modules/next/dist/bin/next" };
    const plan = createPreviewPlan(directory, bins, { initOnly: false, port: 4010 });
    expect(plan).toHaveLength(4);
    expect(plan.slice(0, 3).map((step) => path.basename(step.args.at(-1)!))).toEqual(["migrate.ts", "seed-sav-preview.ts", "seed-sav-inbox-preview.ts"]);
    for (const step of plan.slice(0, 3)) expect(step.args.slice(0, 3)).toEqual(["--conditions=react-server", "--import", "file:///example/node_modules/tsx/dist/loader.mjs"]);
    expect(plan.at(-1)?.args).toEqual([bins.next, "dev", "--hostname", "127.0.0.1", "--port", "4010"]);
    expect(createPreviewPlan(directory, bins, { initOnly: true, port: 3010 })).toHaveLength(3);
    expect(JSON.stringify(plan)).not.toMatch(/vercel|git push|npm install|next build|next start/);
  });
});
