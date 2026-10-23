import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src"), "server-only": path.resolve(root, "test/server-only.ts") } },
  // Qualification runs assert the corrected contract in CI, never baseline bugs.
  test: { environment: "node", env: { SAV_QUALIFICATION_TARGET: "1" }, include: ["src/**/*.test.ts"] },
});
