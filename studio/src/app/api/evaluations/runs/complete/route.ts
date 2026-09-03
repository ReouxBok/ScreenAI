import { NextResponse } from "next/server";
import { completeEvaluation } from "@/lib/evaluations";

export const runtime = "nodejs";
const cors = (request: Request): Record<string, string> => {
  const origin = request.headers.get("origin") ?? "";
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" } : {};
};
export async function OPTIONS(request: Request) { return new Response(null, { status: 204, headers: cors(request) }); }
export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const body = await request.json().catch(() => ({})) as { verdict?: string; promptRevision?: string; knowledgeRevision?: string };
  if (!['correct', 'problem'].includes(String(body.verdict))) return NextResponse.json({ error: "Verdict invalide." }, { status: 400, headers: cors(request) });
  const result = await completeEvaluation(token, body.verdict as "correct" | "problem", String(body.promptRevision ?? ""), String(body.knowledgeRevision ?? ""));
  if (!result) return NextResponse.json({ error: "Test indisponible." }, { status: 404, headers: cors(request) });
  return NextResponse.json(result, { headers: { ...cors(request), "Cache-Control": "no-store" } });
}
