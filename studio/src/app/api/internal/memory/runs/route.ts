import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizedMemoryRequest, validUserKey } from "@/memory/internal-auth";
import { completeCopilotRun, createCopilotRun, getActiveCopilotRun, getCopilotRun } from "@/memory/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const runSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    userKey: z.string(),
    runId: z.string().uuid(),
    sessionId: z.string().uuid(),
    callId: z.string().min(1).max(200),
    toolName: z.string().min(1).max(100),
    contextVersion: z.number().int().nonnegative(),
    actionCount: z.number().int().min(0).max(6),
    recoveryCount: z.number().int().min(0).max(1).optional(),
    promptRevision: z.string().max(160).optional(),
  }).strict(),
  z.object({
    action: z.literal("get"),
    userKey: z.string(),
    runId: z.string().uuid(),
  }).strict(),
  z.object({
    action: z.literal("active"),
    userKey: z.string(),
    sessionId: z.string().uuid(),
  }).strict(),
  z.object({
    action: z.literal("complete"),
    userKey: z.string(),
    runId: z.string().uuid(),
    status: z.enum(["completed", "failed", "interrupted"]),
    errorCode: z.string().max(100).optional(),
  }).strict(),
]);

export async function POST(request: Request) {
  if (!authorizedMemoryRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const input = runSchema.parse(await request.json());
    if (!validUserKey(input.userKey)) return NextResponse.json({ error: "invalid_user" }, { status: 400 });
    if (input.action === "create") return NextResponse.json(await createCopilotRun(input.userKey, input));
    if (input.action === "get") {
      const run = await getCopilotRun(input.userKey, input.runId);
      return run ? NextResponse.json(run) : NextResponse.json({ error: "run_not_found" }, { status: 404 });
    }
    if (input.action === "active") return NextResponse.json({ run: await getActiveCopilotRun(input.userKey, input.sessionId) });
    return NextResponse.json(await completeCopilotRun(input.userKey, input.runId, input.status, input.errorCode));
  } catch (error) {
    const invalid = error instanceof z.ZodError;
    return NextResponse.json({ error: invalid ? "invalid_run" : "run_unavailable" }, { status: invalid ? 400 : 503 });
  }
}
