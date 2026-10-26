import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readSavIntakeShadowReport } from "@/lib/sav/intake/shadow";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
/** Read-only comparison report (identifiers and decision fields only), administrators only. */
export async function GET() {
  try { if ((await requireIntakeConsoleStaff()).role !== "admin") throw Error("FORBIDDEN"); }
  catch { return Response.json({ error: "forbidden" }, { status: 403, headers }); }
  return Response.json({ report: await readSavIntakeShadowReport() }, { headers });
}
