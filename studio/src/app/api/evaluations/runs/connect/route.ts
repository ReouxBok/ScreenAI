import { NextResponse } from "next/server";
import { connectEvaluation } from "@/lib/evaluations";

export const runtime = "nodejs";

const cors = (request: Request): Record<string, string> => {
  const origin = request.headers.get("origin") ?? "";
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  } : {};
};
const bearer = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";

export async function OPTIONS(request: Request) { return new Response(null, { status: 204, headers: cors(request) }); }

export async function POST(request: Request) {
  const token = bearer(request);
  const body = await request.json().catch(() => ({})) as { extensionVersion?: string };
  const result = await connectEvaluation(token, String(body.extensionVersion ?? ""));
  if (!result) return NextResponse.json({ error: "Test introuvable ou expiré." }, { status: 404, headers: cors(request) });
  return NextResponse.json(result, { headers: { ...cors(request), "Cache-Control": "no-store" } });
}
