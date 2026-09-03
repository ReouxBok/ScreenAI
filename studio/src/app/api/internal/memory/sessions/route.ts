import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizedMemoryRequest, validUserKey } from "@/memory/internal-auth";
import {
  closeExplicitSession,
  getExplicitSession,
  openExplicitSession,
  updateExplicitSessionState,
} from "@/memory/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({
  userKey: z.string(),
  action: z.enum(["open", "get", "close", "update_state"]),
  sessionId: z.string().uuid().optional(),
  previousSessionId: z.string().uuid().optional(),
  closePrevious: z.boolean().optional(),
  promptRevision: z.string().max(160).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(80).optional(),
}).strict();

export async function POST(request: Request) {
  if (!authorizedMemoryRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const input = inputSchema.parse(await request.json());
    if (!validUserKey(input.userKey)) return NextResponse.json({ error: "invalid_user" }, { status: 400 });
    if (input.action === "open") {
      const session = await openExplicitSession(input.userKey, {
        sessionId: input.sessionId,
        previousSessionId: input.previousSessionId,
        closePrevious: input.closePrevious,
        promptRevision: input.promptRevision,
        initialState: input.state,
      });
      return NextResponse.json({
        id: session.id,
        status: session.status,
        promptRevision: session.promptRevision,
        sessionRevision: session.sessionRevision,
        lastUpdateTime: session.lastMessageAt.getTime(),
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (!input.sessionId) return NextResponse.json({ error: "session_required" }, { status: 400 });
    if (input.action === "get") {
      const session = await getExplicitSession(input.userKey, input.sessionId);
      return session
        ? NextResponse.json(session, { headers: { "Cache-Control": "private, no-store" } })
        : NextResponse.json({ error: "session_not_found" }, { status: 404 });
    }
    if (input.action === "update_state") {
      return NextResponse.json(await updateExplicitSessionState(input.userKey, input.sessionId, input.state));
    }
    return NextResponse.json(await closeExplicitSession(input.userKey, input.sessionId, input.reason));
  } catch (error) {
    const invalid = error instanceof z.ZodError;
    console.error("memory_session_error", { errorCode: invalid ? "invalid_session" : "session_unavailable" });
    return NextResponse.json({ error: invalid ? "invalid_session" : "session_unavailable" }, { status: invalid ? 400 : 503 });
  }
}
