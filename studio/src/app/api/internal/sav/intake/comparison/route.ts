import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readSavIntakeComparisonReport, runSavIntakeComparisonBatch } from "@/lib/sav/intake/comparison-campaign";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
async function admin() {
  try { return (await requireIntakeConsoleStaff()).role === "admin"; } catch { return false; }
}
/** Campaign report, administrators only, read-only. */
export async function GET() {
  if (!await admin()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  return Response.json({ report: await readSavIntakeComparisonReport() }, { headers });
}
/** Runs the next small batch of the configured campaign (paid calls within its own cap). OFF unless configured. */
export async function POST() {
  if (!await admin()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  return Response.json({ batch: await runSavIntakeComparisonBatch() }, { headers });
}
