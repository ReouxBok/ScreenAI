import { defineConfig } from "@playwright/test";
import path from "node:path";
import navigation from "./playwright.sav73.config";
const mode = process.env.STUDIO_E2E_READER;
if (mode !== "reference" && mode !== "sql") throw new Error("EXPLICIT_SYNTHETIC_READER_REQUIRED");
const directory = path.resolve(`.e2e-sav-performance-${mode}-db`);
const server = navigation.webServer as Exclude<typeof navigation.webServer, unknown[]>;
export default defineConfig({
  ...navigation, testDir: "./tests/sav-performance", timeout: 180_000,
  outputDir: `test-results/sav-performance-${mode}`,
  use: { ...navigation.use, baseURL: "http://127.0.0.1:3198" },
  webServer: {
    ...server,
    command: "node_modules/.bin/tsx scripts/prepare-e2e.ts && node_modules/.bin/tsx scripts/prepare-sav53-e2e.ts && node --conditions=react-server --import tsx scripts/prepare-sav-performance-e2e.ts && node_modules/.bin/next dev --webpack --hostname 127.0.0.1 -p 3198",
    url: "http://127.0.0.1:3198/studio/sav/00000053-0000-4000-8000-000000000001",
    env: { ...server?.env, DATABASE_URL: `pglite://${directory}`, STUDIO_E2E_DB_DIR: directory, SAV_DASHBOARD_SQL: mode === "sql" ? "true" : "false" },
  },
});
