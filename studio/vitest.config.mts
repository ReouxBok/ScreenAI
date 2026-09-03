import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src"), "server-only": path.resolve(root, "test/server-only.ts") } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
