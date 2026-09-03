import { after, NextResponse } from "next/server";
import { z } from "zod";
import { authorizedMemoryRequest, validUserKey } from "@/memory/internal-auth";
import { enrichStoredTurn, storeDeterministicMemories, storeTurn } from "@/memory/service";

export const runtime = "nodejs";

const turnSchema = z.object({
  userKey: z.string(),
  user: z.string().trim().max(8_000).optional(),
  assistant: z.string().trim().max(8_000).optional(),
  source: z.enum(["text", "voice"]),
  idempotencyKey: z.string().trim().min(8).max(180),
  sessionId: z.string().uuid().optional(),
  adkEventId: z.string().trim().max(200).optional(),
  invocationId: z.string().trim().max(200).optional(),
  finalStatus: z.enum(["completed", "failed", "interrupted"]).optional(),
}).refine((value) => Boolean(value.user || value.assistant), "empty_turn");

function isUserDeletionRace(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const record = current as Record<string, unknown>;
    if (record.code === "23503" && String(record.constraint_name || "").endsWith("_user_key_fkey")) return true;
    current = record.cause;
  }
  return false;
}

export async function POST(request: Request) {
  if (!authorizedMemoryRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const input = turnSchema.parse(await request.json());
    if (!validUserKey(input.userKey)) return NextResponse.json({ error: "invalid_user" }, { status: 400 });
    const stored = await storeTurn(input.userKey, input);
    if (!stored.disabled && stored.sessionId) {
      // Explicit statements such as “rappelle-toi que…” must be durable before
      // the turn is acknowledged. Broader Gemini extraction stays asynchronous.
      if (input.user && stored.userMessageId) {
        await storeDeterministicMemories(input.userKey, input.user, stored.userMessageId);
      }
      after(async () => {
        try {
          await enrichStoredTurn(input.userKey, {
            user: input.user,
            assistant: input.assistant,
            sessionId: stored.sessionId,
            sourceMessageId: stored.userMessageId,
          });
        } catch (error) {
          // Enrichment is best-effort and may race with a user data deletion.
          // Never let the runtime print SQL parameters or user content.
          if (!isUserDeletionRace(error)) {
            console.error("memory_enrichment_error", { errorCode: "enrichment_failed" });
          }
        }
      });
    }
    return NextResponse.json(stored, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof z.ZodError ? "invalid_turn" : "memory_write_unavailable";
    return NextResponse.json({ error: code }, { status: error instanceof z.ZodError ? 400 : 503 });
  }
}
