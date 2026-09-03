import { abandonTraining } from "@/lib/training";

export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const session = await abandonTraining(token);
  if (!session) return Response.json({ error: "Session non autorisée" }, { status: 401 });
  return Response.json({ ok: true, id: session.id, status: session.status, recordingStatus: session.recordingStatus, recovered: session.status === "ready" });
}
