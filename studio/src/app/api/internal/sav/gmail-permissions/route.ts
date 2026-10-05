import { timingSafeEqual } from "node:crypto";
import { readSavGmailPermissions } from "@/lib/sav/gmail-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function GET(request: Request) {
  const token = process.env.STUDIO_SERVICE_TOKEN;
  const expected = Buffer.from(`Bearer ${token ?? ""}`);
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  const headers = { "Cache-Control": "no-store" };
  if (!token || token.length < 32 || provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  }
  const report = await readSavGmailPermissions();
  return Response.json(report, { status: report.ok ? 200 : 503, headers });
}
