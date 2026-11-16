import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { intakeHtmlOwnPart } from "./html-message";

export const originalRequestTicketEnabled = (env: Record<string, string | undefined>) => env.SAV_INTAKE_ORIGINAL_REQUEST_TICKET === "on";

/** Reuse the runtime's verified episode, never an address search or an inferred parent. */
export async function readOriginalRequestTicket(messageId: string, env: Record<string, string | undefined>) {
  if (!originalRequestTicketEnabled(env)) return null;
  const db = requireDb();
  const [current] = await db.select().from(savMessages).where(eq(savMessages.id, messageId));
  if (!current) return null;
  const { savIntakeSourceSnapshot } = await import("./runtime-store");
  const snapshot = await savIntakeSourceSnapshot(db, current, new Date());
  const initialId = snapshot.input.identificationContinuation?.initialMessageId;
  const [initial] = initialId ? await db.select().from(savMessages).where(eq(savMessages.id, initialId)) : [];
  const text = initial ? decryptSavPayload<{ text?: unknown }>(initial.bodyCiphertext).text : null;
  if (!initial || !initial.gmailMessageId || typeof text !== "string" || !text.trim() || text.length >= 100_000 || intakeHtmlOwnPart(text)?.unclosed) {
    console.info("sav_intake_original_request_fallback", { messageId, reason: initialId ? "source_incomplete" : "continuation_unverified" });
    return null;
  }
  return { message: initial, text, current: snapshot.input.message };
}
