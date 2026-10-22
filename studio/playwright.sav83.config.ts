import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { SAV83_E2E_KEY, SAV83_THREAD } from "./test/sav83-e2e-fixture";
if ([".env", ".env.local", ".env.development", ".env.development.local"].some(file => existsSync(file))) throw new Error("SAV83_REQUIRES_CLEAN_CHECKOUT");
if (Object.entries(process.env).some(([key, value]) => value && /^(SAV_|GMAIL_|HUBSPOT_|GOOGLE_|GEMINI_|OPENAI_|ANTHROPIC_|BLOB_|CLERK_|NEXT_PUBLIC_CLERK_|DATABASE_URL$|DEV_AUTH_BYPASS$|STUDIO_SERVICE_TOKEN$|NODE_OPTIONS$)/.test(key))) throw new Error("SAV83_USE_ENV_I");
const dbDir = path.resolve(".e2e-sav83-db");
export default defineConfig({
  testDir: "./tests/sav83", workers: 1, fullyParallel: false, retries: 0, timeout: 120000, expect: { timeout: 15000 }, reporter: "list",
  use: { baseURL: "http://127.0.0.1:3183", trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1440, height: 1000 } },
  webServer: { command: "node_modules/.bin/tsx scripts/prepare-e2e.ts && NODE_OPTIONS=--conditions=react-server node_modules/.bin/tsx scripts/prepare-sav83-e2e.ts && NODE_OPTIONS=--import=./test/sav83-provider.mjs node_modules/.bin/next dev --webpack --hostname 127.0.0.1 -p 3183", url: `http://127.0.0.1:3183/studio/sav/${SAV83_THREAD}`, timeout: 180000, reuseExistingServer: false,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", CI: "1", NEXT_TELEMETRY_DISABLED: "1", WATCHPACK_POLLING: "1000", STUDIO_E2E_DB_DIR: dbDir, DATABASE_URL: `pglite://${dbDir}`,
      DEV_AUTH_BYPASS: "true", DEV_USER_EMAIL: "ugo@limova.ai", SAV_ENCRYPTION_KEY_V1: SAV83_E2E_KEY, SAV_RELEASE_STAGE: "v0", SAV_AUTOMATION_MODE: "off", SAV_WRITES_DISABLED: "true", SAV_AI_ANALYSIS: "true", SAV_GEMINI_API_KEY: "synthetic-only-not-a-real-key", SAV83_E2E: "synthetic-loopback-only" },
  },
});
