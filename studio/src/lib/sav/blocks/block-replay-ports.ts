import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { createSavRequestRetrievalBackend } from "../request-retrieval-db";
import type { SavReplayPorts } from "./block-replay";

/*
 * SAV-92: the READ-ONLY ports of the offline replay. A stored inbound mail is read by its Gmail id (SELECT, then decryption in memory);
 * the knowledge search is the existing V1 backend (SELECT on the index, plus the query embedding it already pays). Nothing here inserts,
 * updates, sends or reserves. No decision port is built here: the model is never reachable from these ports (phase 1b, see SPEC_HARNAIS).
 * To run against production data needs Ugo's explicit go for that target (cockpit rule): this module never chooses its database.
 */
export function createSavReplayReadPorts(options: Readonly<{ locale?: string; now?: Date }> = {}): SavReplayPorts {
  return {
    async readMail(messageId) {
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(messageId)) return null;
      const rows = await requireDb().select({ subject: savMessages.subject, body: savMessages.bodyCiphertext }).from(savMessages)
        .where(and(eq(savMessages.gmailMessageId, messageId), eq(savMessages.direction, "inbound"))).limit(2);
      // Two mailboxes holding the same Gmail id is ambiguous: refused, never guessed.
      if (rows.length !== 1) return null;
      try {
        const body = decryptSavPayload<{ text?: unknown }>(rows[0]!.body);
        return typeof body.text === "string" ? { subject: rows[0]!.subject, text: body.text } : null;
      } catch { return null; }
    },
    search: createSavRequestRetrievalBackend({ locale: options.locale, audience: "support", now: options.now }),
  };
}
