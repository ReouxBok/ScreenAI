import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

type Counters = { queries: number; sourceRows: number; relatedRows: number; classifiedRows: number; decryptions: number; ciphertextBytes: number };
const scope = new AsyncLocalStorage<Counters>();
export function countSavRead(metric: keyof Counters, amount = 1) {
  const current = scope.getStore();
  if (current) current[metric] += amount;
}
/** Aggregate timings only: no query, client data, source IDs or permission cache. */
export async function measureSavDashboardRead<T>(mode: "reference" | "sql", operation: () => Promise<T>) {
  const counters: Counters = { queries: 0, sourceRows: 0, relatedRows: 0, classifiedRows: 0, decryptions: 0, ciphertextBytes: 0 };
  const started = performance.now();
  let status = "failed";
  try {
    const value = await scope.run(counters, operation);
    status = "ok";
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "SAV_DASHBOARD_PROJECTION_PENDING") status = "pending";
    throw error;
  } finally {
    console.info("sav_dashboard_read", { revision: "sav-dashboard-read-2026-10-19.v1", mode, status,
      durationMs: Math.round((performance.now() - started) * 100) / 100, ...counters });
  }
}
