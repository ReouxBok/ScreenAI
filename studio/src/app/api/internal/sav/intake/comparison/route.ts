import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readSavIntakeComparisonReport } from "@/lib/sav/intake/comparison-campaign";
import { attestIntakeComparison, readIntakeComparisonEvidence, runIntakeComparisonOperator } from "@/lib/sav/intake/comparison-operator";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
async function admin() {
  try { return (await requireIntakeConsoleStaff()).role === "admin"; } catch { return false; }
}
const code = (error: unknown, fallback: string) => error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : fallback;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The list (summaries and manifests, never a receipt), or ONE listed dossier's receipt. */
export async function GET(request: Request) {
  if (!await admin()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  const messageId = new URL(request.url).searchParams.get("messageId");
  if (messageId === null) return Response.json({ report: await readSavIntakeComparisonReport() }, { headers });
  if (!UUID.test(messageId)) return Response.json({ error: "SAV_INTAKE_COMPARISON_INVALID_COMMAND" }, { status: 400, headers });
  try { return Response.json({ evidence: await readIntakeComparisonEvidence(messageId) }, { headers }); }
  catch (error) { return Response.json({ error: code(error, "SAV_INTAKE_COMPARISON_EVIDENCE_UNAVAILABLE") }, { status: 400, headers }); }
}
/** Same phase/attestation guards as the operator UI; never an unrestricted batch. */
export async function POST(request: Request) {
  if (!await admin()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  try {
    const body = await request.text();
    const input: unknown = body.trim() ? JSON.parse(body) : { stage: "sentinels", reviewed: false };
    // An attestation never starts a comparison; a command never records an attestation.
    if (input && typeof input === "object" && (input as { kind?: unknown }).kind === "attestation") return Response.json({ attestation: await attestIntakeComparison(input) }, { headers });
    return Response.json({ batch: await runIntakeComparisonOperator(input) }, { headers });
  } catch (error) {
    return Response.json({ error: code(error, "SAV_INTAKE_COMPARISON_INVALID_COMMAND") }, { status: 400, headers });
  }
}
