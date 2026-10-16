import { defineConfig } from "@playwright/test";
import path from "node:path";
import base from "./playwright.sav55.config";
import { SAV_OTHER_E2E_KEY, SAV_OTHER_E2E_REGISTRY } from "./test/sav-other-e2e-fixture";

// Reuse the clean-environment and no-.env guard before overriding synthetic data.
const server = base.webServer as Exclude<typeof base.webServer, unknown[] | undefined>;
const dbDir = path.resolve(".e2e-db-sav-other");
export default defineConfig({
  ...base, testDir: "./tests/sav-other",
  webServer: {
    ...server,
    command: "node_modules/.bin/tsx scripts/prepare-e2e.ts && node_modules/.bin/tsx scripts/prepare-sav-other-e2e.ts && node_modules/.bin/next dev --webpack --hostname 127.0.0.1 -p 3125",
    url: "http://127.0.0.1:3125/studio/sav?view=other&q=AUTRE88",
    env: { ...server.env, DATABASE_URL: `pglite://${dbDir}`, STUDIO_E2E_DB_DIR: dbDir, SAV_ENCRYPTION_KEY_V1: SAV_OTHER_E2E_KEY, SAV_OTHER_OBSERVATION_RULES_JSON: SAV_OTHER_E2E_REGISTRY },
  },
});
