import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readSavIntakeComparisonReport } from "@/lib/sav/intake/comparison-campaign";
import { runIntakeComparisonOperator } from "@/lib/sav/intake/comparison-operator";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
async function admin() {
  try { return (await requireIntakeConsoleStaff()).role === "admin"; } catch { return false; }
}
export async function GET() {
  if (!await admin()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  return Response.json({ report: await readSavIntakeComparisonReport() }, { headers });
}
/** Same phase/attestation guards as the operator UI; never an unrestricted batch. */
export async function POST(request: Request) {
  if (!await admin()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  try {
    const body = await request.text();
    const input: unknown = body.trim() ? JSON.parse(body) : { stage: "sentinels", reviewed: false };
    return Response.json({ batch: await runIntakeComparisonOperator(input) }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_COMPARISON_INVALID_COMMAND" }, { status: 400, headers });
  }
}
