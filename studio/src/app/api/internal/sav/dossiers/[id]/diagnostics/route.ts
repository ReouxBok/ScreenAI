import { z } from "zod";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { readSavRunDiagnostics } from "@/lib/sav/run-diagnostics";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireSavApiStaff("admin"); } catch { return Response.json({ error: "forbidden" }, { status: 403, headers }); }
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
  return Response.json({ runs: await readSavRunDiagnostics(id.data) }, { headers });
}
