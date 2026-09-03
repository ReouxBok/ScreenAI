import { defineConfig } from "@playwright/test";
import path from "node:path";
const dbDir=path.resolve(".e2e-db");
export default defineConfig({
  testDir:"./tests/e2e",
  fullyParallel:false,
  workers:1,
  retries:0,
  reporter:"list",
  use:{baseURL:"http://127.0.0.1:3100",trace:"retain-on-failure",screenshot:"only-on-failure"},
  webServer:{
    command:"tsx scripts/prepare-e2e.ts && next dev -p 3100",
    url:"http://127.0.0.1:3100/connexion",
    timeout:120_000,
    reuseExistingServer:false,
    // Browser tests exercise the current role-based application without
    // depending on an external Clerk tenant. Production never enables this.
    env:{...process.env,BLOB_READ_WRITE_TOKEN:"",DATABASE_URL:`pglite://${dbDir}`,STUDIO_E2E_DB_DIR:dbDir,DEV_AUTH_BYPASS:"true",DEV_USER_EMAIL:"reouven@limova.ai",STUDIO_SERVICE_TOKEN:"e2e-service-token-that-is-at-least-32-characters"},
  },
});
