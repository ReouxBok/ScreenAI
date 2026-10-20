/** Explicit cache preparation only. Never invokes ingestion, models or providers.
 * Run with --conditions=react-server. Default is aggregate read-only status. */
import { closeDb } from "../src/db";
import { refreshSavDashboardProjection, savDashboardProjectionStatus } from "../src/lib/sav/dashboard-projection";
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply" && !/^--batches=\d+$/.test(arg))) throw new Error("Usage: prepare-sav-dashboard.ts [--apply] [--batches=100]");
const batches = Math.min(1_000, Math.max(1, Number(args.find(arg => arg.startsWith("--batches="))?.split("=")[1] ?? 100)));
try {
  const before = await savDashboardProjectionStatus();
  let refreshed = 0;
  if (args.includes("--apply")) {
    for (let i = 0; i < batches; i++) {
      const result = await refreshSavDashboardProjection(100);
      refreshed += result.refreshed;
      if (!result.refreshed) break;
    }
  }
  const after = await savDashboardProjectionStatus();
  console.info(JSON.stringify({ mode: args.includes("--apply") ? "apply" : "status", before, refreshed, after }));
  if (args.includes("--apply") && after.pending) process.exitCode = 2;
} finally { await closeDb(); }
