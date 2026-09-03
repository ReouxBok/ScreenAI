import { appendTrainingEvent } from "@/lib/training";
export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const event = await appendTrainingEvent(token, await request.json().catch(() => ({})));
  if (!event) return Response.json({ error: "Enregistrement non autorisé" }, { status: 401 });
  return Response.json({ ok: true, ordinal: event.ordinal });
}
