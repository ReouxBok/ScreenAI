import { z } from "zod";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { readLegacyStartedInventory } from "@/lib/sav/intake/legacy-started";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

/**
 * Read-only inventory of the mails the retired V0 engine had started and of the human V0 commands still open: cause, age, handoff to the team,
 * read-only checks. Administrator only. It resumes, resets, cancels and sends nothing, calls no provider and no model, and returns identifiers,
 * counts and fixed codes (no mail text, no address). There is deliberately no POST: the decision on the queued commands is Ugo's (C2).
 */
export async function GET(request: Request) {
  try { if ((await requireIntakeConsoleStaff()).role !== "admin") throw Error("FORBIDDEN"); }
  catch { return Response.json({ error: "forbidden" }, { status: 403, headers }); }
  const url = new URL(request.url);
  const parsed = query.safeParse(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {});
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
  try { return Response.json({ inventory: await readLegacyStartedInventory({ limit: parsed.data.limit }) }, { headers }); }
  catch { return Response.json({ error: "unavailable" }, { status: 503, headers }); }
}
