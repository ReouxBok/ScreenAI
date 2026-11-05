import "server-only";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { requireDb } from "@/db";
import { contentItems, contentVersions, savCaseEffectExecutions, savIntakeEffects, savMessages } from "@/db/schema";
import { HANDOFF_NOTICE_KEY_PREFIX } from "@/lib/sav/cases/case-handoff-notice";
import { decryptSavPayload } from "@/lib/sav/crypto";
import type { CaseDossierReaders } from "./case-dossier-read";

// COMPOSITION ONLY, select-only: the stored mails and the published-content tables bound to the V2 case page. No Gmail, CRM or model call, so reading here has none of the
// Gmail effects of opening a mail in the V1 console. The page calls it after its staff check.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const caseDossierReaders: CaseDossierReaders | null = {
  async mails({ threadIds, gmailMessageIds }) {
    if (!threadIds.length || !gmailMessageIds.length) return [];
    const rows = await requireDb().select({ gmailMessageId: savMessages.gmailMessageId, from: savMessages.fromEmail, subject: savMessages.subject, receivedAt: savMessages.receivedAt, bodyCiphertext: savMessages.bodyCiphertext })
      .from(savMessages).where(and(inArray(savMessages.threadId, [...threadIds]), inArray(savMessages.gmailMessageId, [...gmailMessageIds]), eq(savMessages.direction, "inbound")));
    return rows.flatMap(({ bodyCiphertext, receivedAt, gmailMessageId, ...row }) => {
      if (!gmailMessageId) return [];
      let text: string | null = null;
      try { const body = decryptSavPayload<{ text?: unknown }>(bodyCiphertext); text = typeof body.text === "string" ? body.text : null; } catch { text = null; }
      return [{ ...row, gmailMessageId, receivedAt: receivedAt.toISOString(), text }];
    });
  },
  async cards(refs) {
    // A ref that is not a stored id cannot match; it must not make the whole read fail on the uuid column.
    const valid = refs.filter(ref => UUID.test(ref.knowledgeId) && UUID.test(ref.contentVersionId));
    if (!valid.length) return [];
    const rows = await requireDb().select({ knowledgeId: contentVersions.itemId, contentVersionId: contentVersions.id, version: contentVersions.version, title: contentItems.title })
      .from(contentVersions).innerJoin(contentItems, eq(contentItems.id, contentVersions.itemId)).where(inArray(contentVersions.id, valid.map(ref => ref.contentVersionId)));
    return rows;
  },
  async handoffNotice(caseId) {
    const [row] = await requireDb().select({ execution: savCaseEffectExecutions.state, effect: savIntakeEffects.state, ackCiphertext: savIntakeEffects.ackCiphertext })
      .from(savCaseEffectExecutions).leftJoin(savIntakeEffects, and(eq(savIntakeEffects.executionId, savCaseEffectExecutions.id), eq(savIntakeEffects.kind, "handoff_notify")))
      .where(and(eq(savCaseEffectExecutions.caseId, caseId), like(savCaseEffectExecutions.replyKey, `${HANDOFF_NOTICE_KEY_PREFIX}%`))).orderBy(desc(savCaseEffectExecutions.createdAt)).limit(1);
    if (!row) return null;
    let ack: { ts?: unknown; channel?: unknown } | null = null;
    try { ack = row.ackCiphertext ? decryptSavPayload<{ ts?: unknown; channel?: unknown }>(row.ackCiphertext) : null; } catch { ack = null; }
    return { execution: row.execution, effect: row.effect, ack };
  },
};
