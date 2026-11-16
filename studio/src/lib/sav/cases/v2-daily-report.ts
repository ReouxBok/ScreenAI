import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { decryptSavPayload } from "../crypto";
import { SAV_CASE_ADMISSION_REASONS, caseBodySchema } from "./case-types";
import { readV2Cases, type V2ReadTx } from "./v2-inventory";

export const v2DailyReportInput = z.object({
  from: z.iso.datetime({ offset: true }), until: z.iso.datetime({ offset: true }),
}).strict().superRefine((input, ctx) => {
  const span = Date.parse(input.until) - Date.parse(input.from);
  if (span <= 0 || span > 7 * 86400000) ctx.addIssue({ code: "custom", message: "SAV_V2_REPORT_WINDOW_INVALID" });
});
const MAX_CASES = 1000, MAX_HISTORY = 10000;
const record = z.record(z.string(), z.unknown());
const object = (value: unknown): Record<string, unknown> => record.safeParse(value).data ?? {};
const decoded = (value: string) => object(decryptSavPayload(value));
async function batch<T extends Record<string, unknown>>(tx: V2ReadTx, statement: SQL): Promise<T[]> {
  const result = await tx.execute<T>(statement);
  const rows = Array.isArray(result) ? result : (result as unknown as { rows: T[] }).rows;
  if (rows.length > MAX_HISTORY) throw Error("SAV_V2_REPORT_HISTORY_LIMIT");
  return rows as T[];
}
export function reportDistribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b), n = sorted.length;
  return { samples: n, medianSeconds: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null,
    p90Seconds: n ? sorted[Math.ceil(n * .9) - 1]! : null };
}

/** Creation cohort [from, until), observed at one repeatable-read snapshot. All historical
 * receipts of those cases are included: this is not a count of sends occurring in the window.
 * No external verification, payload upgrades, writes, model calls or per-case queries. */
export async function v2DailyReport(raw: z.infer<typeof v2DailyReportInput>) {
  const input = v2DailyReportInput.parse(raw);
  return requireDb().transaction(async tx => {
    // PostgreSQL timestamps have microsecond precision: use an exclusive upper boundary.
    const cases = await batch<{ id: string; target: string | null; reason: string | null; payload: string }>(tx, sql`
      select id, admission_target as target, admission_reason as reason, payload_ciphertext as payload
      from sav.cases where created_at >= ${input.from}::timestamptz and created_at < ${input.until}::timestamptz
      order by created_at, id limit ${MAX_CASES + 1}`);
    if (cases.length > MAX_CASES) throw Error("SAV_V2_REPORT_CASE_LIMIT");
    const ids = `{${cases.map(c => c.id).join(",")}}`;
    // Inventory batches supply the exact existing receipt/cost/refusal semantics, in THIS snapshot.
    const rows: Awaited<ReturnType<typeof readV2Cases>>["rows"] = [];
    let cursor: string | undefined;
    let observedAt = "";
    do {
      const page = await readV2Cases(tx, { ...input, limit: 100, cursor }, true);
      observedAt = page.observedAt;
      rows.push(...page.rows.filter(row => cases.some(c => c.id === row.caseId)));
      cursor = page.nextCursor ?? undefined;
      if (page.attendus > MAX_CASES) throw Error("SAV_V2_REPORT_CASE_LIMIT");
    } while (cursor);
    if (rows.length !== cases.length) throw Error("SAV_V2_REPORT_COVERAGE_INVALID");
    const events = await batch<{ caseId: string; version: number; key: string; occurredAt: string; payload: string }>(tx, sql`
      select case_id as "caseId", case_version as version, dedupe_key as key, occurred_at::text as "occurredAt", payload_ciphertext as payload from sav.case_events
      where case_id=any(${ids}::uuid[]) and kind='inbound_confirmed' order by case_id, case_version limit ${MAX_HISTORY + 1}`);
    const effects = await batch<{ caseId: string; executionId: string; kind: string | null; state: string | null; parentState: string; confirmedAt: string | null; approvedAt: string | null; payload: string }>(tx, sql`
      select x.case_id as "caseId", x.id as "executionId", f.kind, f.state, x.state as "parentState", f.confirmed_at::text as "confirmedAt",
        v.approved_at::text as "approvedAt", x.payload_ciphertext as payload
      from sav.case_effect_executions x left join sav.intake_effects f on f.execution_id=x.id
        and f.kind in ('reply_send','ticket_stage','note_create','note_associate')
      left join (select execution_id, min(decided_at) as approved_at from sav.case_reply_validations
        where case_id=any(${ids}::uuid[]) and state='approved' group by execution_id) v on v.execution_id=x.id
      where x.case_id=any(${ids}::uuid[])
      order by x.case_id, x.id, f.id limit ${MAX_HISTORY + 1}`);
    const calls = await batch<{ caseId: string; count: number; dispatched: number }>(tx, sql`
      select case_id as "caseId", count(*)::int as count,
        count(*) filter (where dispatched_at is not null)::int as dispatched from sav.case_calls
      where case_id=any(${ids}::uuid[]) group by case_id limit ${MAX_HISTORY + 1}`);
    const timers = await batch<{ caseId: string; id: string; state: string }>(tx, sql`
      select case_id as "caseId", id, state from sav.case_timers where case_id=any(${ids}::uuid[])
      order by case_id, id limit ${MAX_HISTORY + 1}`);
    const wakes = await batch<{ caseId: string; state: string | null; retryAt: string | null; wakeUntil: string | null }>(tx, sql`
      select entity_id as "caseId", technical_metadata->>'state' as state,
        technical_metadata->>'retryAt' as "retryAt", technical_metadata->>'wakeUntil' as "wakeUntil"
      from public.audit_logs where action='sav_v2_settle_wake' and entity_type='sav_v2_case'
        and entity_id=any(${ids}::text[]) limit ${MAX_HISTORY + 1}`);
    const anomalies = new Set<string>();
    const refusedByReason: Record<string, number> = {};
    const crm = { notes: { confirmed: 0, uncertain: 0, refused: 0, absent: 0, pending: 0 }, statuses: { confirmed: 0, uncertain: 0, refused: 0, absent: 0, pending: 0 } };
    let failedTrialReturns = 0, overdueScheduledWakes = 0;
    let admitted = 0, admissionUnknown = 0, handedToTeam = 0, sent = 0, provenClosures = 0, reopenedSameIncident = 0, duplicateCycles = 0, cycleUnknown = 0, overdueWithoutWake = 0;
    const mailDelays: number[] = [], validationDelays: number[] = [];
    const perCase = [];
    for (const c of cases) {
      const row = rows.find(r => r.caseId === c.id)!;
      const body = caseBodySchema.parse(decryptSavPayload(c.payload));
      failedTrialReturns += new Set(body.trials.filter(t => t.outcome === "failed" && t.result?.source.type === "email").map(t => t.result!.source.id)).size;
      if (c.target === 'agent') admitted++;
      else if (c.target === null) admissionUnknown++;
      else { const reason = (SAV_CASE_ADMISSION_REASONS as readonly string[]).includes(c.reason ?? '') ? c.reason! : 'other_internal_reason'; refusedByReason[reason] = (refusedByReason[reason] ?? 0) + 1; }
      if (row.state === 'handed_to_team') handedToTeam++;
      const reopens = events.filter(e => e.caseId === c.id && object(object(decoded(e.payload).detail).relay).route === 'reopen');
      reopenedSameIncident += reopens.length;
      const own = effects.filter(e => e.caseId === c.id);
      const replies = own.filter(e => e.kind === 'reply_send' && e.state === 'confirmed' && e.confirmedAt);
      const cycles = new Map<number, number>();
      for (const reply of replies) {
        sent++;
        const sentAt = Date.parse(reply.confirmedAt!);
        const proposal = object(decoded(reply.payload).proposal);
        const inbound = events.filter(e => e.caseId === c.id);
        const source = inbound.find(e => e.key === proposal.triggerEventId) ?? (inbound.length === 1 ? inbound[0] : undefined);
        if (source && sentAt >= Date.parse(source.occurredAt)) mailDelays.push((sentAt - Date.parse(source.occurredAt)) / 1000);
        else anomalies.add(c.id);
        if (reply.approvedAt && sentAt >= Date.parse(reply.approvedAt)) validationDelays.push((sentAt - Date.parse(reply.approvedAt)) / 1000);
        else anomalies.add(c.id);
        const version = object(decoded(reply.payload).proposal).caseVersion;
        if (typeof version !== 'number' || !Number.isInteger(version)) { cycleUnknown++; anomalies.add(c.id); continue; }
        const cycle = 1 + reopens.filter(e => e.version <= version).length;
        cycles.set(cycle, (cycles.get(cycle) ?? 0) + 1);
      }
      for (const count of cycles.values()) if (count >= 2) { duplicateCycles++; anomalies.add(c.id); }
      // Closure means a confirmed CRM closed stage sealed with the proven-resolution trigger.
      const closed = new Set<string>();
      for (const effect of own.filter(e => e.kind === 'ticket_stage' && e.state === 'confirmed' && e.confirmedAt)) {
        const payload = decoded(effect.payload), trigger = object(payload.trigger);
        if (object(payload.intent).target === 'closed' && trigger.kind === 'resolution_recorded' && Number.isInteger(trigger.cycle)) closed.add(String(trigger.cycle));
      }
      provenClosures += closed.size;
      if (body.waiting && Date.parse(observedAt) - Date.parse(body.waiting.dueAt ?? body.waiting.since) > 15 * 60000 &&
        !timers.some(t => t.caseId === c.id && t.id === body.waiting?.timerId && t.state === 'scheduled') &&
        !wakes.some(w => w.caseId === c.id && ['starting', 'scheduled'].includes(w.state ?? '') && w.wakeUntil && Date.parse(w.wakeUntil) > Date.parse(observedAt))) { overdueWithoutWake++; anomalies.add(c.id); }
      // A durable scheduled marker is not evidence that the wake actually ran.
      if ((body.waiting && Date.parse(observedAt) - Date.parse(body.waiting.dueAt ?? body.waiting.since) > 15 * 60000 &&
          timers.some(t => t.caseId === c.id && t.id === body.waiting?.timerId && t.state === 'scheduled')) ||
        (row.state === 'processing' && wakes.some(w => w.caseId === c.id && ['starting', 'scheduled', 'start_failed'].includes(w.state ?? '') &&
          w.retryAt && Date.parse(observedAt) - Date.parse(w.retryAt) > 15 * 60000))) {
        overdueScheduledWakes++; anomalies.add(c.id);
      }
      for (const [name, kinds] of [['notes', ['note_create', 'note_associate']], ['statuses', ['ticket_stage']]] as const) {
        const relevant = own.filter(e => (kinds as readonly string[]).includes(e.kind ?? ""));
        const inventoryState = name === 'notes' ? row.hubspot.note : row.hubspot.status;
        const parentRefused = own.some(e => e.parentState === 'refused' && (name === 'notes' ? object(decoded(e.payload).note).text !== undefined : object(decoded(e.payload).intent).target !== undefined));
        const state = parentRefused ? 'refused' : !relevant.length ? inventoryState === 'queued' ? 'pending' : 'absent' : relevant.some(e => e.state === 'uncertain' || e.state === 'dispatched' || e.state === 'acked') ? 'uncertain'
          : relevant.some(e => e.state === 'refused') ? 'refused'
          : relevant.every(e => e.state === 'confirmed' && e.confirmedAt) && inventoryState === 'confirmed' ? 'confirmed' : 'pending';
        crm[name][state]++;
        if (replies.length && state !== 'confirmed') anomalies.add(c.id);
      }
      if (row.validatorRefusals || row.cost.reason || row.state === 'failed') anomalies.add(c.id);
      const call = calls.find(call => call.caseId === c.id);
      perCase.push({ caseId: c.id, recordedCalls: call?.count ?? 0, dispatchedCalls: call?.dispatched ?? 0,
        estimatedMicroUsd: row.cost.confirmedMicroUsd === null || row.cost.reservedMicroUsd === null ? null : row.cost.confirmedMicroUsd + row.cost.reservedMicroUsd, ...row.cost });
    }
    return { window: input, observedAt, cohort: 'created_at_[from,until)', coverage: { expected: cases.length, checked: rows.length, complete: true },
      admitted, refusedByReason, admissionUnknown, handedToTeam, repliesSent: sent,
      mailToSend: { ...reportDistribution(mailDelays), unverified: sent - mailDelays.length }, validationToSend: { ...reportDistribution(validationDelays), unverified: sent - validationDelays.length }, overdueWithoutWake, overdueScheduledWakes,
      provenClosures, reopenedSameIncident, stillBlockedReturns: { confirmedFailedTrialMessages: failedTrialReturns, exhaustiveCount: null }, duplicateCycles, repliesWithUnknownCycle: cycleUnknown, crm, perCase,
      validatorRefusals: rows.reduce((n, r) => n + r.validatorRefusals, 0), anomalies: [...anomalies].sort(),
      limitations: ['Cohorte de création ; reçus cumulés au relevé, hors appels externes.',
        'Retours toujours bloqué : résultats d’essais échoués sourcés par mail seulement ; total exhaustif non vérifié, réouvertures comptées séparément.',
        'Mail→envoi depuis le déclencheur identifié, sinon mail unique du dossier ; validations manquantes exclues des délais et signalées.',
        'CRM confirmé par registre local, sans relecture HubSpot ; coûts réservés inclus dans estimation, jamais assimilés à usage confirmé.',
        'Attentes : dépassement de dueAt (sinon since) de 15 min sans timer associé programmé ; marqueurs settle inclus ; réveils programmés en retard comptés séparément, autres mécanismes non vérifiés.',
        'Doublon potentiel : deux réponses confirmées dans un cycle, y compris rappels légitimes ; contrôle humain requis.'],
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
