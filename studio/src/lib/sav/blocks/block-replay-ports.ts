import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { createSavRequestRetrievalBackend } from "../request-retrieval-db";
import { listCaseEvents, readCase } from "../cases/case-store";
import { caseCustomerContextReader } from "../cases/investigation-customer-context-reader";
import { caseCustomerTextsReader } from "../cases/investigation-v2-providers";
import type { SavReplayPorts } from "./block-replay";

/*
 * SAV-92: the READ-ONLY ports of the offline replay. A stored inbound mail is read by its Gmail id (SELECT, then decryption in memory);
 * the knowledge search is the existing V1 backend (SELECT on the index, plus the query embedding it already pays). Nothing here inserts,
 * updates, sends or reserves. No decision port is built here: the model is never reachable from these ports (phase 1b: `replay-decision.ts`).
 * Phase 1b: a stored case is read as the runner reads it (`readCase`, `listCaseEvents`: SELECT only), with the customer texts and the
 * customer context of the existing V2 readers (SELECT and decryption; the files' bytes are never downloaded: media off).
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
    async readCase(caseId) {
      const snapshot = await readCase(caseId);
      if (!snapshot) return null;
      const events = await listCaseEvents(caseId);
      const latest = [...events].filter(event => event.direction === "customer_inbound" && event.sourceRef.type === "email")
        .sort((a, b) => b.caseVersion - a.caseVersion)[0];
      if (!latest || !snapshot.threadIds.length) return null;
      const customerTexts = await caseCustomerTextsReader()(caseId, events.filter(event => event.direction === "customer_inbound").map(event => event.sourceRef));
      const text = customerTexts[`email:${latest.sourceRef.id}`];
      if (typeof text !== "string") return null;
      const [row] = await requireDb().select({ subject: savMessages.subject }).from(savMessages)
        .where(and(eq(savMessages.direction, "inbound"), eq(savMessages.gmailMessageId, latest.sourceRef.id), inArray(savMessages.threadId, snapshot.threadIds))).limit(1);
      const customerContext = await caseCustomerContextReader({ env: () => ({}) })(snapshot, events);
      return { subject: row?.subject ?? "", text, stored: { snapshot, events, customerTexts, customerContext } };
    },
    search: createSavRequestRetrievalBackend({ locale: options.locale, audience: "support", now: options.now }),
  };
}
