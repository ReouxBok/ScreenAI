import { z } from "zod";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readIntakeRunDiagnostics } from "@/lib/sav/intake/run-diagnostics";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { if ((await requireIntakeConsoleStaff()).role !== "admin") throw Error("FORBIDDEN"); }
  catch { return Response.json({ error: "forbidden" }, { status: 403, headers }); }
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
  const diagnostics = await readIntakeRunDiagnostics(id.data);
  return Response.json({ diagnostics }, { status: diagnostics ? 200 : 404, headers });
}
