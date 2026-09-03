import { connectTraining } from "@/lib/training";
export async function POST(request: Request) {
  const { token = "" } = await request.json().catch(() => ({}));
  const session = await connectTraining(String(token));
  if (!session) return Response.json({ error: "Session introuvable ou expirée" }, { status: 404 });
  return Response.json({ id: session.id, title: session.title, goal: session.goal, agentKey: session.agentKey, startPath: session.startPath, status: session.status, recordingStatus: session.recordingStatus, recordingReady: session.recordingStatus === "ready" && Boolean(session.recordingPathname) });
}
