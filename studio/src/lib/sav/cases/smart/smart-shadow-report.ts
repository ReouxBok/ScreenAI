import "server-only";
import { and, asc, gte, inArray, like, lt } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savMessages, savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../../crypto";
import { smartItemKey, type SmartItemRow } from "./smart-ledger";
import { aggregateSmartShadow, SAV_SMART_SHADOW_PREFIX, SMART_V1_TEAM_REASONS, type SmartShadowStored, type SmartV1TeamReason } from "./smart-shadow";

/*
 * Read-only report of the smart agent's SHADOW pass over a range of UTC days, for the MCP (`v2_shadow_report`, administrators only).
 * It reuses `aggregateSmartShadow` as is and adds one line per mail, made of CODES AND NUMBERS ONLY: never the mail, the subject, the reply,
 * the reading, the facts, the memory, the note's text, an email address or a name. The note gives only its closed reason and its counts.
 * No write, no table, no migration: the rows are the shadow's own `sav.sync_state` rows (kept 30 days by the shadow pass).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Max days of one report (inclusive range), max mails listed, max stored rows read (the shadow is capped at 20 mails a day by default). */
export const SMART_SHADOW_REPORT_MAX_DAYS = 7, SMART_SHADOW_REPORT_MAX_CASES = 50, SMART_SHADOW_REPORT_MAX_ROWS = 1_000;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const utcDay = z.string().regex(DAY).refine(day => Number.isFinite(dayStart(day)) && new Date(dayStart(day)).toISOString().slice(0, 10) === day);
const outcomes = ["team_sensitive", "reply", "ask", "handoff", "failed", "interrupted"] as const;

export const smartShadowReportInput = z.object({
  from: utcDay, until: utcDay,
  /** Filters the per-mail list only (the aggregate always covers the whole range). */
  outcome: z.enum(outcomes).optional(),
}).strict().superRefine((input, ctx) => {
  const span = (dayStart(input.until) - dayStart(input.from)) / DAY_MS;
  if (!(span >= 0 && span < SMART_SHADOW_REPORT_MAX_DAYS)) ctx.addIssue({ code: "custom", message: "SAV_V2_SHADOW_REPORT_WINDOW_INVALID" });
});
export type SmartShadowReportInput = z.infer<typeof smartShadowReportInput>;

const clip = (value: unknown, max: number) => typeof value === "string" ? value.trim().toLowerCase().slice(0, max) : null;

/** Pure: one stored row as a line of codes and numbers. Every field is picked explicitly, never spread from the row. */
export function smartShadowCaseLine(row: SmartShadowStored, day: string, threadId: string | null) {
  const turn = row.turn, note = turn.teamNote;
  const steps = turn.steps ?? [];
  return {
    messageId: row.messageId, threadId, day, receivedAt: row.receivedAt, startedAt: row.startedAt, durationMs: row.durationMs,
    v1Gate: row.v1Gate ?? "unknown",
    outcome: turn.outcome,
    reasons: [...turn.reasons],
    sensitiveStop: turn.sensitiveStop,
    decisionOutcome: turn.decision?.outcome ?? null,
    handoffReason: turn.decision?.handoffReason ?? null,
    teamNote: note ? { raison: note.raison, verified: note.verifie.length, tried: note.essaye.length, hypotheses: note.hypotheses.length,
      nextCheck: Boolean(note.prochaineVerification), toldCustomer: Boolean(note.ditAuClient) } : null,
    serverRefusals: { first: turn.checks.first ? [...turn.checks.first] : null, second: turn.checks.second ? [...turn.checks.second] : null },
    verifyRefusals: { first: turn.verdicts.first ? { verdict: turn.verdicts.first.verdict, codes: turn.verdicts.first.problems.map(problem => problem.code) } : null,
      second: turn.verdicts.second ? { verdict: turn.verdicts.second.verdict, codes: turn.verdicts.second.problems.map(problem => problem.code) } : null },
    corrected: turn.corrected,
    progressed: turn.progressed ?? null,
    missingThemes: turn.missing.map(missing => clip(missing.theme, 80) || "sans_theme"),
    sources: turn.sources.map(source => ({ cardId: source.cardId, version: source.version, needs: source.needIds.length })),
    decidePasses: steps.filter(step => step.kind === "decide").map(step => ({ pass: step.pass, action: step.action ?? null, status: step.status ?? null, code: step.code ?? null })),
    tools: steps.filter(step => step.kind === "tool").map(step => ({ pass: step.pass, tool: step.tool ?? null, status: step.status ?? null, code: step.code ?? null, bytes: step.bytes ?? null })),
    calls: turn.calls.map(call => ({ kind: call.kind, status: call.status, problem: call.problem, inputBytes: call.inputBytes, uncertain: call.uncertain, sent: call.sent,
      inputTokens: call.usage?.inputTokens ?? null, outputTokens: call.usage?.outputTokens ?? null })),
    costMicroUsd: row.costMicroUsd,
    revision: { prompt: row.revision, promptSha256: row.promptSha256.slice(0, 16), contract: row.contractRevision, model: row.model, codeSha: row.codeSha },
  };
}

/** The shadow over [from, until] (UTC days, inclusive): the existing aggregate, then one line per mail (newest first, at most 50). Read only. */
export async function readSmartShadowReport(raw: SmartShadowReportInput) {
  const input = smartShadowReportInput.parse(raw);
  const since = new Date(dayStart(input.from)), before = new Date(dayStart(input.until) + DAY_MS);
  const inRange = (day: string) => day >= input.from && day <= input.until;
  const db = requireDb();
  const items = await db.select({ status: savSyncState.status, cursor: savSyncState.cursor }).from(savSyncState)
    .where(and(like(savSyncState.key, `${smartItemKey(SAV_SMART_SHADOW_PREFIX, "mail:")}%`), gte(savSyncState.startedAt, since), lt(savSyncState.startedAt, before)))
    .orderBy(asc(savSyncState.startedAt)).limit(SMART_SHADOW_REPORT_MAX_ROWS + 1);
  const gateRows = await db.select({ cursor: savSyncState.cursor }).from(savSyncState)
    .where(and(like(savSyncState.key, `${SAV_SMART_SHADOW_PREFIX}:gate:%`), gte(savSyncState.startedAt, since), lt(savSyncState.startedAt, before)))
    .orderBy(asc(savSyncState.startedAt)).limit(SMART_SHADOW_REPORT_MAX_ROWS + 1);
  const rowsTruncated = items.length > SMART_SHADOW_REPORT_MAX_ROWS || gateRows.length > SMART_SHADOW_REPORT_MAX_ROWS;

  const stored: Array<{ day: string; row: SmartShadowStored }> = [], withoutResult: Record<string, number> = {};
  let unreadable = 0;
  for (const item of items.slice(0, SMART_SHADOW_REPORT_MAX_ROWS)) {
    let value: SmartItemRow<SmartShadowStored>;
    try { value = decryptSavPayload<SmartItemRow<SmartShadowStored>>(item.cursor ?? ""); } catch { unreadable += 1; continue; }
    if (!inRange(value.scope)) continue;
    // `pending`: claimed, never settled (in flight or lost); `failed`: the turn crashed. Neither has a result: counted, not listed.
    if (item.status !== "done" || !value.result) { withoutResult[item.status] = (withoutResult[item.status] ?? 0) + 1; continue; }
    stored.push({ day: value.scope, row: value.result });
  }
  const gates = gateRows.slice(0, SMART_SHADOW_REPORT_MAX_ROWS).flatMap(row => {
    try { const gate = decryptSavPayload<{ reason?: unknown; at?: unknown }>(row.cursor ?? "");
      const reason: SmartV1TeamReason = (SMART_V1_TEAM_REASONS as readonly unknown[]).includes(gate.reason) ? gate.reason as SmartV1TeamReason : "unknown";
      return typeof gate.at !== "string" || inRange(gate.at.slice(0, 10)) ? [{ reason }] : [];
    } catch { unreadable += 1; return []; }
  });

  const listed = stored.filter(entry => !input.outcome || entry.row.turn.outcome === input.outcome).reverse();
  const page = listed.slice(0, SMART_SHADOW_REPORT_MAX_CASES);
  // The thread of each mail (internal ids only), so a case can be opened with get_dossier.
  const ids = [...new Set(page.map(entry => entry.row.messageId))];
  const threads = new Map((ids.length ? await db.select({ id: savMessages.id, threadId: savMessages.threadId }).from(savMessages).where(inArray(savMessages.id, ids)) : [])
    .map(row => [row.id, row.threadId]));

  return {
    range: { from: input.from, until: input.until, outcome: input.outcome ?? null },
    summary: aggregateSmartShadow(stored.map(entry => entry.row), gates),
    itemsWithoutResult: withoutResult, unreadableRows: unreadable, rowsTruncated,
    cases: page.map(entry => smartShadowCaseLine(entry.row, entry.day, threads.get(entry.row.messageId) ?? null)),
    casesTotal: listed.length, casesTruncated: listed.length > page.length,
    limitations: [
      "Codes et nombres uniquement : ni texte du mail, ni objet, ni réponse proposée, ni texte de la note équipe (seulement sa raison et ses compteurs).",
      "Lignes conservées 30 jours par le shadow ; jour = jour UTC de la réservation du mail.",
      "Le shadow n'ouvre aucun dossier V2 : threadId renvoie au dossier de la console (get_dossier), pas à un dossier V2.",
    ],
  };
}
