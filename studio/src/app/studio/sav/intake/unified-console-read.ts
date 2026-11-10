import "server-only";
import { readIntakeExecutionProgress } from "@/lib/sav/intake/executor";
import { readCaseByTicket } from "@/lib/sav/cases/case-store";
import { readCaseReplies } from "../v2/case-replies";
import { caseReplyReaders } from "../v2/case-replies-port";
import { replyFromItems, unifiedConsoleLine, type UnifiedCase, type UnifiedLine, type UnifiedTicket, type UnifiedV1Row } from "./unified-console-model";
type Progress = Awaited<ReturnType<typeof readIntakeExecutionProgress>>;
type Snapshot = Awaited<ReturnType<typeof readCaseByTicket>>;
type Replies = Awaited<ReturnType<typeof readCaseReplies>>;
export type UnifiedReaders = { progress: (messageId: string) => Promise<Progress>; caseByTicket: (ticketId: string) => Promise<Snapshot>; replies: (caseId: string) => Promise<Replies> };
const defaults: UnifiedReaders = { progress: readIntakeExecutionProgress, caseByTicket: readCaseByTicket, replies: caseId => readCaseReplies(caseReplyReaders, { caseId }) };
export const replyOf = (read: Replies) => read.state === "ok" ? read.next ? { state: "unavailable" as const } : replyFromItems(read.items) : read.state === "absent" ? { state: "absent" as const } : { state: "unavailable" as const };
export function ticketOf(progress: Progress): UnifiedTicket {
  if (!progress?.ticketId) return { state: "none" };
  const ticketEffect = progress.effects.filter(e => e.kind.startsWith("ticket_"));
  const confirmed = progress.confirmed || (ticketEffect.length > 0 && ticketEffect.every(e => e.state === "confirmed"));
  return { state: confirmed ? "confirmed" : "uncertain", ticketId: progress.ticketId };
}
/** Select-only enrichment of ONE page (≤25 rows) of the existing paginated list: no count changes, no write. */
export async function readUnifiedLines(rows: readonly (UnifiedV1Row & { messageId: string | null })[], readers: UnifiedReaders = defaults): Promise<Record<string, UnifiedLine>> {
  const page = rows.slice(0, 25);
  // Request-local promises include failures: no repeated provider/DB read on the
  // same key during this render. Never retain another request's cached evidence.
  const progressCache = new Map<string, Promise<Progress>>(), caseCache = new Map<string, Promise<Snapshot>>(), replyCache = new Map<string, Promise<Replies>>();
  function once<T>(cache: Map<string, Promise<T>>, key: string, read: (key: string) => Promise<T>) {
    let value = cache.get(key);
    if (!value) { value = Promise.resolve().then(() => read(key)); cache.set(key, value); }
    return value;
  }
  const entries: Array<readonly [string, UnifiedLine]> = new Array(page.length);
  let cursor = 0;
  const readRow = async (row: typeof page[number]) => {
    let ticket: UnifiedTicket = { state: "none" }, kase: UnifiedCase = { state: "absent" };
    if (row.messageId) { try { ticket = ticketOf(await once(progressCache, row.messageId, readers.progress)); } catch { ticket = { state: "unavailable" }; } }
    if (ticket.state === "confirmed") {
      try { const s = await once(caseCache, ticket.ticketId, readers.caseByTicket); if (s && s.ticketId === ticket.ticketId) {
        // One list read (≤10 latest replies) per exact case, already filtered by caseId in SQL; no read per reply.
        let reply; try { reply = replyOf(await once(replyCache, s.caseId, readers.replies)); } catch { reply = { state: "unavailable" as const }; }
        kase = { state: "found", ticketId: s.ticketId, owner: s.owner, phase: s.phase, updatedAt: s.updatedAt, reply };
      } else kase = { state: "absent" }; }
      catch { kase = { state: "unavailable" }; }
    }
    return [row.threadId, unifiedConsoleLine(row, ticket, kase)] as const;
  };
  // At most two independent row chains; each chain awaits its reads in order.
  await Promise.all(Array.from({ length: Math.min(2, page.length) }, async () => {
    while (cursor < page.length) { const index = cursor++; entries[index] = await readRow(page[index]); }
  }));
  return Object.fromEntries(entries);
}
