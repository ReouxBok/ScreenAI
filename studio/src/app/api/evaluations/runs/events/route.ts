import { verifyStudioEvaluation } from "@/lib/verify-studio-evaluation";
import { NextResponse } from "next/server";
import { appendEvaluationEvent } from "@/lib/evaluations";

export const runtime = "nodejs";
const cors = (request: Request): Record<string, string> => {
  const origin = request.headers.get("origin") ?? "";
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" } : {};
};
export async function OPTIONS(request: Request) { return new Response(null, { status: 204, headers: cors(request) }); }
export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return NextResponse.json({ error: "Événement invalide." }, { status: 400, headers: cors(request) });
  const event = "kind" in input && input.kind === "native_verification"
    ? await verifyStudioEvaluation(token, "observation" in input ? input.observation : undefined, request.signal)
    : await appendEvaluationEvent(token, Object.fromEntries(Object.entries(input)));
  if (!event) return NextResponse.json({ error: "Test indisponible." }, { status: 404, headers: cors(request) });
  return NextResponse.json({ ok: true }, { headers: { ...cors(request), "Cache-Control": "no-store" } });
}
