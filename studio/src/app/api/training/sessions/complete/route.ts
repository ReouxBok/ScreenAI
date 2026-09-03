import { completeTraining } from "@/lib/training";
export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const result = await completeTraining(token);
  if (!result) return Response.json({ error: "Session non autorisée" }, { status: 401 });
  if ("error" in result) return Response.json({ error: "La vidéo complète doit être envoyée avant de terminer la démonstration.", code: "TRAINING_RECORDING_REQUIRED" }, { status: 409 });
  return Response.json({ ok: true, id: result.session.id });
}
