// Local E2E seeds only: lets a seed process call the same server maintenance function as the cron step (for example the
// dashboard projection refresh) by resolving `server-only` to the empty test stub, exactly as vitest.config.mts aliases it.
// Plain Node conditions are kept, so client React stays intact. Never loaded by the application or in production.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
const stub = ${JSON.stringify(new URL("./server-only.ts", import.meta.url).href)};
export async function resolve(specifier, context, next) {
  return specifier === "server-only" ? { url: stub, shortCircuit: true } : next(specifier, context);
}`));
