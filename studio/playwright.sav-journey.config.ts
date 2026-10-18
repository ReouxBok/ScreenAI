import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { JOURNEY_KEY, journeyId } from "./test/sav-journey-fixture";
if ([".env", ".env.local", ".env.development", ".env.development.local"].some(file => existsSync(file))) throw new Error("JOURNEY_REQUIRES_CLEAN_CHECKOUT");
const forbidden = /^(SAV_|GMAIL_|HUBSPOT_|GOOGLE_|GEMINI_|OPENAI_|ANTHROPIC_|BLOB_|CLERK_|NEXT_PUBLIC_CLERK_|CRON_|DATABASE_URL$|STUDIO_SERVICE_TOKEN$|DEV_AUTH_BYPASS$|DEV_USER_EMAIL$|NODE_OPTIONS$)/;
if (Object.entries(process.env).some(([key, value]) => value && forbidden.test(key))) throw new Error("JOURNEY_USE_ENV_I");
const dbDir = path.resolve(".e2e-journey-db");
export default defineConfig({
  testDir: "./tests/sav-journey", workers: 1, retries: 0, fullyParallel: false, timeout: 120000, expect: { timeout: 15000 }, reporter: [["list"], ["json", { outputFile: "test-results/journey-results.json" }]],
  use: { baseURL: "http://127.0.0.1:3118", trace: "retain-on-failure", screenshot: "only-on-failure", launchOptions: process.env.STUDIO_E2E_CHROMIUM_PATH ? { executablePath: process.env.STUDIO_E2E_CHROMIUM_PATH } : {} },
  webServer: {
    // The seed never imports the provider shim. The server refuses all external
    // fetches except the enumerated synthetic provider responses in that shim.
    command: "node_modules/.bin/tsx scripts/prepare-e2e.ts && node_modules/.bin/tsx scripts/prepare-sav-journey-e2e.ts && NODE_OPTIONS=\"--import=./test/sav-journey-provider.mjs\" node_modules/.bin/next dev --webpack --hostname 127.0.0.1 -p 3118",
    url: `http://127.0.0.1:3118/studio/sav/${journeyId("create")}`, timeout: 180000, reuseExistingServer: false, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", CI: "1", NEXT_TELEMETRY_DISABLED: "1", WATCHPACK_POLLING: "1000",
      DATABASE_URL: `pglite://${dbDir}`, STUDIO_E2E_DB_DIR: dbDir, DEV_AUTH_BYPASS: "true", DEV_USER_EMAIL: "ugo@limova.ai", SAV_ENCRYPTION_KEY_V1: JOURNEY_KEY,
      SAV_RELEASE_STAGE: "v0", SAV_AUTOMATION_MODE: "assist", SAV_WRITES_DISABLED: "false", SAV_AI_ANALYSIS: "false", SAV_PILOT_MODE: "false", SAV_TEST_MODE: "true", SAV_TEST_OUTBOUND_ALLOWLIST: "*@example.invalid",
      SAV_JOURNEY_E2E: "synthetic-loopback-only", HUBSPOT_ACCESS_TOKEN: "synthetic-journey-only", GMAIL_CLIENT_ID: "synthetic", GMAIL_CLIENT_SECRET: "synthetic", GMAIL_REFRESH_TOKEN: "synthetic", GMAIL_REPLY_FROM_ADDRESS: "contact@limova.ai", STUDIO_SERVICE_TOKEN: "synthetic-journey-service-token-at-least-32-characters",
    },
  },
});
