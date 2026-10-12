import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { SAV_SEMANTIC_E2E_KEY, SAV_SEMANTIC_E2E_THREAD } from "./test/sav-semantic-e2e-fixture";

if ([".env", ".env.local", ".env.development", ".env.development.local"].some(file => existsSync(path.resolve(file)))) throw new Error("SAV_SEMANTIC_E2E_REQUIRES_CHECKOUT_WITHOUT_ENV_FILES");
// Playwright merges webServer.env with its parent environment. Require the clean
// invocation documented in tests/sav-semantic/README.md before preparing a DB.
const operationalPrefixes = ["SAV_", "GMAIL_", "HUBSPOT_", "GOOGLE_", "GEMINI_", "OPENAI_", "ANTHROPIC_", "BLOB_", "CLERK_", "NEXT_PUBLIC_CLERK_", "CRON_"];
const operationalNames = new Set(["DATABASE_URL", "STUDIO_SERVICE_TOKEN", "DEV_AUTH_BYPASS", "DEV_USER_EMAIL", "NODE_OPTIONS"]);
if (Object.entries(process.env).some(([name, value]) => value && (operationalNames.has(name) || operationalPrefixes.some(prefix => name.startsWith(prefix))))) throw new Error("SAV_SEMANTIC_E2E_REQUIRES_EMPTY_OPERATIONAL_ENVIRONMENT_USE_ENV_I");
const dbDir = path.resolve(".e2e-db");
const port = 3117;
export default defineConfig({
  testDir: "./tests/sav-semantic", testMatch: "sav-semantic-review.spec.ts", fullyParallel: false, workers: 1, retries: 0, reporter: "list", timeout: 120000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure", screenshot: "only-on-failure", launchOptions: process.env.STUDIO_E2E_CHROMIUM_PATH ? { executablePath: process.env.STUDIO_E2E_CHROMIUM_PATH } : {} },
  webServer: {
    command: `node_modules/.bin/tsx scripts/prepare-e2e.ts && node_modules/.bin/tsx scripts/prepare-sav-semantic-e2e.ts && node_modules/.bin/next dev --webpack --hostname 127.0.0.1 -p ${port}`,
    // Compile and load the seeded dossier before the browser scenario timeout starts.
    url: `http://127.0.0.1:${port}/studio/sav/${SAV_SEMANTIC_E2E_THREAD}`, timeout: 180000, reuseExistingServer: false, stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", CI: "1", NEXT_TELEMETRY_DISABLED: "1", WATCHPACK_POLLING: "1000",
      DATABASE_URL: `pglite://${dbDir}`, STUDIO_E2E_DB_DIR: dbDir, DEV_AUTH_BYPASS: "true", DEV_USER_EMAIL: "ugo@limova.ai",
      SAV_ENCRYPTION_KEY_V1: SAV_SEMANTIC_E2E_KEY, SAV_RELEASE_STAGE: "v0", SAV_AUTOMATION_MODE: "assist", SAV_WRITES_DISABLED: "true", SAV_PILOT_MODE: "false", SAV_AI_ANALYSIS: "false", SAV_TEST_MODE: "true", SAV_TEST_OUTBOUND_ALLOWLIST: "",
      SAV_GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GEMINI_API_KEY: "", HUBSPOT_ACCESS_TOKEN: "", GMAIL_CLIENT_ID: "", GMAIL_CLIENT_SECRET: "", GMAIL_REFRESH_TOKEN: "", BLOB_READ_WRITE_TOKEN: "", CLERK_SECRET_KEY: "", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "", CRON_SECRET: "", STUDIO_SERVICE_TOKEN: "synthetic-e2e-service-token-at-least-32-characters",
    },
  },
});
