import "server-only";
import { inArray, like } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savMessages, savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../../crypto";
import { readSmartLedger, smartItemKey, smartLedgerSpent, type SmartItemRow } from "./smart-ledger";
import { SAV_SMART_SHADOW_PREFIX, smartShadowGateKey, smartShadowItem, type SmartShadowStored } from "./smart-shadow";
import { smartShadowCaseLine } from "./smart-shadow-report";
import { SAV_SMART_REPLAY_ID, SAV_SMART_REPLAY_MAX_MAILS, smartReplayPrefix, type SmartReplayStored } from "./smart-shadow-replay";

/*
 * Read-only report of ONE replay run of the shadow (`smart-shadow-replay.ts`), for the MCP (`v2_shadow_replay_report`, administrators only).
 * Per mail: the replay's line (v20) next to the shadow's line for the same mail (v19, read only), both made of the codes of `smartShadowCaseLine`,
 * PLUS the texts Ugo reads: the reply the customer would have received, a reply refused by the checks (never sent), the team note. Customer
 * content is given at the level of `get_dossier`'s `smartTrace` (administrators, same bounds: reply 6000 chars, note 3000), never logged.
 */

export const SMART_REPLAY_REPORT_DEFAULT_LIMIT = 10, SMART_REPLAY_REPORT_MAX_LIMIT = 20;
const REPLY_CHARS = 6_000, NOTE_CHARS = 3_000;
const outcomes = ["team_sensitive", "reply", "ask", "handoff", "failed", "interrupted"] as const;

export const smartReplayReportInput = z.object({
  replayId: z.string().regex(SAV_SMART_REPLAY_ID),
  /** Filters the per-mail list only (on the replay's outcome); the summary always covers the whole run. */
  outcome: z.enum(outcomes).optional(),
  offset: z.number().int().min(0).max(SAV_SMART_REPLAY_MAX_MAILS).default(0),
  limit: z.number().int().min(1).max(SMART_REPLAY_REPORT_MAX_LIMIT).default(SMART_REPLAY_REPORT_DEFAULT_LIMIT),
}).strict();
export type SmartReplayReportInput = z.input<typeof smartReplayReportInput>;

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
/** Pure: the texts of one stored turn, bounded. `replyRefused`: the model's reply when it was not kept (a handoff), never sent to anyone. */
export function smartReplayTexts(row: SmartShadowStored) {
  const turn = row.turn, sent = text(turn.replyWithFooter, REPLY_CHARS);
  return { replyProposed: sent, replyRefused: sent ? null : text(turn.decision?.reply, REPLY_CHARS), teamNote: text(turn.teamNoteText, NOTE_CHARS) };
}
const decrypt = <T>(cursor: string | null) => { try { return decryptSavPayload<T>(cursor ?? ""); } catch { return null; } };

/** One replay run: its ledger, counts (v20, v19, transitions), then one entry per mail (oldest received first, paged). Read only. */
export async function readSmartReplayReport(raw: SmartReplayReportInput) {
  const input = smartReplayReportInput.parse(raw);
  const prefix = smartReplayPrefix(input.replayId), db = requireDb();
  const items = await db.select({ status: savSyncState.status, cursor: savSyncState.cursor }).from(savSyncState)
    .where(like(savSyncState.key, `${smartItemKey(prefix, smartShadowItem(""))}%`)).limit(SAV_SMART_REPLAY_MAX_MAILS + 1);
  const gateRows = await db.select({ cursor: savSyncState.cursor }).from(savSyncState).where(like(savSyncState.key, `${prefix}:gate:%`)).limit(1_000);
  const ledger = await readSmartLedger(prefix, input.replayId);

  const replayed: SmartReplayStored[] = [], withoutResult: Record<string, number> = {};
  let unreadable = 0;
  for (const item of items) {
    const value = decrypt<SmartItemRow<SmartReplayStored>>(item.cursor);
    if (!value) { unreadable += 1; continue; }
    if (item.status !== "done" || !value.result) { withoutResult[item.status] = (withoutResult[item.status] ?? 0) + 1; continue; }
    replayed.push(value.result);
  }
  replayed.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId));
  const discardedByV1: Record<string, number> = {};
  for (const row of gateRows) { const gate = decrypt<{ reason?: unknown }>(row.cursor); const reason = typeof gate?.reason === "string" ? gate.reason : "unknown"; discardedByV1[reason] = (discardedByV1[reason] ?? 0) + 1; }

  // The shadow's rows of the same mails (read only): its item (v19 result) or its V1 gate row.
  const ids = replayed.map(row => row.messageId);
  const shadowRows = ids.length ? await db.select({ key: savSyncState.key, status: savSyncState.status, cursor: savSyncState.cursor }).from(savSyncState)
    .where(inArray(savSyncState.key, ids.flatMap(id => [smartItemKey(SAV_SMART_SHADOW_PREFIX, smartShadowItem(id)), smartShadowGateKey(id)]))) : [];
  const shadow = new Map<string, { status: string; row: SmartShadowStored | null; gate: string | null }>();
  for (const id of ids) {
    const item = shadowRows.find(row => row.key === smartItemKey(SAV_SMART_SHADOW_PREFIX, smartShadowItem(id))), gate = shadowRows.find(row => row.key === smartShadowGateKey(id));
    if (item) shadow.set(id, { status: item.status, row: item.status === "done" ? decrypt<SmartItemRow<SmartShadowStored>>(item.cursor)?.result ?? null : null, gate: null });
    else if (gate) { const value = decrypt<{ reason?: unknown }>(gate.cursor); shadow.set(id, { status: "team", row: null, gate: typeof value?.reason === "string" ? value.reason : "unknown" }); }
  }

  const v20: Record<string, number> = {}, v19: Record<string, number> = {}, transitions: Record<string, number> = {};
  let costMicroUsd = 0;
  for (const row of replayed) {
    const before = shadow.get(row.messageId), was = before?.row?.turn.outcome ?? (before ? `shadow_${before.status}` : "absent");
    v20[row.turn.outcome] = (v20[row.turn.outcome] ?? 0) + 1; v19[was] = (v19[was] ?? 0) + 1;
    transitions[`${was}->${row.turn.outcome}`] = (transitions[`${was}->${row.turn.outcome}`] ?? 0) + 1;
    costMicroUsd += row.costMicroUsd;
  }
  const listed = replayed.filter(row => !input.outcome || row.turn.outcome === input.outcome), page = listed.slice(input.offset, input.offset + input.limit);
  const pageIds = page.map(row => row.messageId);
  const threads = new Map((pageIds.length ? await db.select({ id: savMessages.id, threadId: savMessages.threadId }).from(savMessages).where(inArray(savMessages.id, pageIds)) : [])
    .map(row => [row.id, row.threadId]));
  const day = (iso: string) => iso.slice(0, 10);

  return {
    replayId: input.replayId,
    run: { mailsClaimed: ledger.items, spentMicroUsd: smartLedgerSpent(ledger), openReservations: Object.keys(ledger.open).length },
    summary: { mails: replayed.length, costMicroUsd, outcomesV20: v20, outcomesV19: v19, transitions, discardedByV1, itemsWithoutResult: withoutResult, unreadableRows: unreadable,
      revisions: [...new Set(replayed.map(row => `${row.revision}:${row.promptSha256.slice(0, 16)}:${row.model}`))] },
    cases: page.map(row => {
      const before = shadow.get(row.messageId), threadId = threads.get(row.messageId) ?? null;
      return {
        messageId: row.messageId, threadId, receivedAt: row.receivedAt,
        v19: before?.row ? { status: "done", ...smartShadowCaseLine(before.row, day(before.row.startedAt), threadId), texts: smartReplayTexts(before.row) }
          : { status: before ? `shadow_${before.status}` : "absent", v1GateReason: before?.gate ?? null },
        v20: { ...smartShadowCaseLine(row, day(row.startedAt), threadId), texts: smartReplayTexts(row) },
      };
    }),
    casesTotal: listed.length, offset: input.offset, nextOffset: input.offset + page.length < listed.length ? input.offset + page.length : null,
    limitations: [
      "Contient du contenu client (réponse proposée, réponse refusée jamais envoyée, note équipe) : administrateurs seulement, comme smartTrace de get_dossier ; ne pas copier dans un dépôt ou un ticket public.",
      "v19 = ligne du shadow normal pour le même mail (absente si le shadow ne l'a pas traitée, shadow_team si V1 l'a envoyée à l'équipe) ; v20 = ce rejeu.",
      "Fiches lues au moment du rejeu (pas à la date du mail) ; contexte du fil figé à la réception comme le shadow.",
      "Lignes conservées 30 jours.",
    ],
  };
}
