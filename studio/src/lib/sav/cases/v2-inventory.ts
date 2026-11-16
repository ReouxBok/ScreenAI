import "server-only";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savCases, savMessages } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { caseComponentOutcomes } from "./case-component-outcomes";
import { SAV_CASE_ADMISSION_TEAM_REASONS } from "./case-types";

export const v2InventoryStates = ["processing", "awaiting_customer", "reply_sent", "handed_to_team", "failed", "paused"] as const;
export const v2InventoryInput = z.object({
  from: z.iso.datetime({ offset: true }).optional().describe("Depuis : date inclusive de création du dossier V2."),
  until: z.iso.datetime({ offset: true }).optional().describe("Jusqu’à : date inclusive de création du dossier V2."),
  state: z.enum(v2InventoryStates).optional().describe("Filtre d’affichage seulement, sans retirer de dossiers du parcours ; processing : en cours ; awaiting_customer : en attente du client ; reply_sent : réponse envoyée ; handed_to_team : transféré à l’équipe ; failed : échec ; paused : en pause."),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(1023).optional().describe("Curseur opaque durable ; conserver les mêmes filtres. Taille constante ; périmètre borné par snapshotAt."),
}).strict();
type Input = z.infer<typeof v2InventoryInput>;
const timestamp = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)));
const cursorSchema = z.object({ v: z.literal(3), filters: z.string(), after: z.object({ createdAt: timestamp, id: z.uuid() }), snapshotAt: timestamp, attendus: z.number().int().nonnegative() }).strict();
const invalid = (): never => { throw Error("SAV_V2_INVENTORY_CURSOR_INVALID"); };
const handoffCodes = new Set<string>([...SAV_CASE_ADMISSION_TEAM_REASONS, "explicit_human_request", "sensitive_request", "knowledge_missing", "knowledge_conflict",
  "evidence_inaccessible", "diagnosis_out_of_tools", "repeated_failure", "out_of_scope", "decision_refused", "validator_refusals", "awaiting_v2_attribution"]);
const object = z.record(z.string(), z.unknown());

export type V2ReadTx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
async function queryBatch<T extends Record<string, unknown>>(tx: Pick<V2ReadTx, "execute">, statement: SQL) {
  const result = await tx.execute<T>(statement);
  return { rows: Array.isArray(result) ? result : (result as unknown as { rows: T[] }).rows };
}
function groupBy<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row), group = groups.get(id);
    if (group) group.push(row); else groups.set(id, [row]);
  }
  return groups;
}

// Dates belong to the FIRST customer event of the case, not to an unrelated older mail in its V1 thread.
const receivedAt = sql<string | null>`(select min(e.occurred_at)::text from sav.case_events e where e.case_id = sav.cases.id and e.kind = 'inbound_confirmed' and e.direction = 'customer_inbound')`;
const stateSql = sql<typeof v2InventoryStates[number]>`case
  when ${savCases.owner} = 'system_hold' then 'paused'
  when ${savCases.owner} = 'human' then 'handed_to_team'
  when ${savCases.phase} in ('blocked_technical', 'blocked_reconcile', 'needs_review') then 'failed'
  when ${savCases.phase} = 'awaiting_customer' then 'awaiting_customer'
  when ${savCases.phase} = 'resolved' and exists (select 1 from sav.case_effect_executions x join sav.intake_effects f on f.execution_id = x.id where x.case_id = sav.cases.id and f.kind = 'reply_send' and f.state = 'confirmed' and f.confirmed_at is not null) then 'reply_sent'
  else 'processing' end`;

/** Read-only, compact (created_at, id) keyset. The DB timestamp freezes the creation
 * boundary; scope uses only immutable creation dates in [from, min(until, snapshotAt)].
 * Mutable states are display-only filters; every traversed case is listed or filtered out. Histories are bounded and fail explicitly on overflow.
 * No external call, write, lock or payload upgrade. */
export async function listV2Cases(raw: Input) {
  return requireDb().transaction(tx => readV2Cases(tx, raw), { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Internal batch reader; caller owns the read-only snapshot. */
export async function readV2Cases(tx: V2ReadTx, raw: Input, untilExclusive = false) {
  const input = v2InventoryInput.parse(raw);
  if (input.from && input.until && Date.parse(input.from) > Date.parse(input.until)) throw Error("SAV_V2_INVENTORY_WINDOW_INVALID");
  const filters = JSON.stringify([...(untilExclusive ? ["exclusive"] : []), input.from ? new Date(input.from).toISOString() : null, input.until ? new Date(input.until).toISOString() : null, input.state ?? null]);
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (input.cursor) {
    if (input.cursor.split(".").length !== 4 || input.cursor.split(".").slice(1).some(part => Buffer.from(part, "base64url").toString("base64url") !== part)) invalid();
    try { cursor = cursorSchema.parse(decryptSavPayload(input.cursor)); } catch { invalid(); }
    if (!cursor || cursor.filters !== filters || Date.parse(cursor.after.createdAt) > Date.parse(cursor.snapshotAt)) invalid();
  }
  return (async () => {
    // Preserve PostgreSQL microseconds in the keyset (JS Date would truncate them).
    const snapshotAt = cursor?.snapshotAt ?? (await queryBatch<{ value: string }>(tx, sql`select clock_timestamp()::text as value`)).rows[0]!.value;
    const observedAt = new Date(snapshotAt).toISOString();
    const scope = and(
      input.from ? sql`${savCases.createdAt} >= ${input.from}::timestamptz` : undefined,
      untilExclusive && input.until ? sql`${savCases.createdAt} < ${input.until}::timestamptz` : undefined,
      sql`${savCases.createdAt} <= least(${input.until ?? snapshotAt}::timestamptz, ${snapshotAt}::timestamptz)`,
    );
    const attendus = Number((await tx.select({ count: sql<number>`count(*)` }).from(savCases).where(scope))[0]!.count);
    // Deletions still invalidate the traversal rather than silently claiming exhaustiveness.
    if (cursor && attendus !== cursor.attendus) throw Error("SAV_V2_INVENTORY_MEMBERSHIP_CHANGED");
    const page = await tx.select({ id: savCases.id, createdAt: sql<string>`${savCases.createdAt}::text`, threadIds: savCases.threadIds, phase: savCases.phase, state: stateSql, payload: savCases.payloadCiphertext, receivedAt })
      .from(savCases).where(and(scope, cursor ? sql`(${savCases.createdAt}, ${savCases.id}) > (${cursor.after.createdAt}::timestamptz, ${cursor.after.id}::uuid)` : undefined))
      .orderBy(asc(savCases.createdAt), asc(savCases.id)).limit(input.limit + 1);
    if (!page.length) return { attendus, observedAt, statesFilterApplied: !!input.state, filteredOut: 0, rows: [], nextCursor: null };
    const ids = page.slice(0, input.limit).map(row => row.id);
    const idArray = `{${ids.join(",")}}`;
    // One batch per table, with at most 1000 history records per case plus an overflow sentinel.
    const historyLimit = 1000;
    const eventBatch = await queryBatch<{ caseId: string; key: string | null; payload: string | null }>(tx, sql`
      select c.id as "caseId", e.key, e.payload from sav.cases c join lateral (
        (select dedupe_key as key, null::text as payload from sav.case_events where case_id=c.id
          and kind='inbound_confirmed' and direction='customer_inbound' order by occurred_at, id limit 1)
        union all
        (select null::text as key, payload_ciphertext as payload from sav.case_events where case_id=c.id
          and kind='observation_recorded' order by case_version, id limit ${historyLimit + 1})
      ) e on true where c.id=any(${idArray}::uuid[])`);
    const entries = { rows: eventBatch.rows.filter((e): e is typeof e & { key: string } => e.key !== null) };
    const eventRows = { rows: eventBatch.rows.filter((e): e is typeof e & { payload: string } => e.payload !== null) };
    const messageRows = entries.rows.length ? await tx.select({ id: savMessages.id, threadId: savMessages.threadId, gmailId: savMessages.gmailMessageId }).from(savMessages)
      .where(and(inArray(savMessages.gmailMessageId, entries.rows.map(e => e.key.slice("inbound:".length))), eq(savMessages.direction, "inbound"))) : [];
    const executionRows = await queryBatch<{ caseId: string; id: string; key: string; state: string; reason: string | null; payload: string }>(tx, sql`
      select c.id as "caseId", e.id, e.reply_key as key, e.state, e.reason, e.payload_ciphertext as payload from sav.cases c
      join lateral (select * from sav.case_effect_executions where case_id=c.id order by created_at, id limit ${historyLimit + 1}) e on true
      where c.id=any(${idArray}::uuid[])`);
    const executionIds = `{${executionRows.rows.map(e => e.id).join(",")}}`;
    // Latest component result only: one batch over the journal, never one scan per execution.
    const componentRows = executionRows.rows.length ? await queryBatch<{ executionId: string; kind: string; payload: string }>(tx, sql`
      select distinct on (execution_id, kind) execution_id as "executionId", kind, payload_ciphertext as payload
      from sav.intake_effect_journal where execution_id=any(${executionIds}::uuid[])
        and kind in ('case_component_note','case_component_status') order by execution_id, kind, created_at desc, id desc`) : null;
    const componentJournal = new Map((componentRows?.rows ?? []).map(e => [`${e.executionId}:${e.kind}`, e.payload]));
    // Four public effect kinds, one aggregate per execution/kind, regardless of ledger length.
    const effectResult = executionRows.rows.length ? await queryBatch<{ executionId: string; kind: string; state: string; confirmedAt: string | null }>(tx, sql`
      select execution_id as "executionId", kind,
        case when bool_and(state='confirmed' and confirmed_at is not null) then 'confirmed'
          when bool_or(state in ('dispatched','acked','uncertain')) then 'uncertain'
          when bool_or(state='failed') then 'failed' else 'pending' end as state,
        min(confirmed_at)::text as "confirmedAt"
      from sav.intake_effects where execution_id=any(${executionIds}::uuid[])
        and kind in ('reply_send','note_create','note_associate','ticket_stage') group by execution_id, kind`) : null;
    const effectRows = (effectResult?.rows ?? []).map(e => ({ ...e, confirmedAt: e.confirmedAt ? new Date(e.confirmedAt) : null }));
    const callRows = await queryBatch<{ caseId: string; key: string; state: string }>(tx, sql`
      select c.id as "caseId", e.call_key as key, e.state from sav.cases c
      join lateral (select call_key, state from sav.case_calls where case_id=c.id order by created_at, call_key limit ${historyLimit + 1}) e on true
      where c.id=any(${idArray}::uuid[])`);
    if (ids.some(id => [executionRows.rows, eventRows.rows, callRows.rows].some(rows => rows.filter(r => r.caseId === id).length > historyLimit)))
      throw Error("SAV_V2_INVENTORY_HISTORY_LIMIT");
    // SQL returns one aggregate per call, not day registries or day × call receipts.
    // Size checks precede JSON parsing. Any truncated/corrupt registry keeps costs unknown.
    const callKeys = callRows.rows.map(c => c.key);
    const ledgerRows = callKeys.length ? await queryBatch<{ key: string; confirmed: string; reserved: string; coverage: number; unreadable: boolean }>(tx, sql`
      with days as materialized (
        select case when octet_length(cursor) <= 1048576 then
          case when pg_input_is_valid(cursor, 'jsonb') then cursor::jsonb end end as body
        from sav.sync_state where key like 'sav-v2-spend.v1:%' order by key limit 1001
      ), keys as (select jsonb_array_elements_text(${JSON.stringify(callKeys)}::jsonb) as key),
      metadata as (
        select count(*) > 1000 or coalesce(bool_or(body is null or
          jsonb_typeof(body->'open') is distinct from 'object' or jsonb_typeof(body->'done') is distinct from 'object' or
          (body ? 'verifiedUsage' and jsonb_typeof(body->'verifiedUsage') is distinct from 'array')), false) as unreadable from days
      ), receipts as (
        select key, body->'open'->key->'amount' as held, body->'done'->key as done,
          coalesce(body->'open' ? key, false) as has_open, coalesce(body->'done' ? key, false) as has_done,
          coalesce(body->'verifiedUsage' ? key, false) as verified
        from keys join days on body->'open' ? key or body->'done' ? key
      ), checked as (
        select *, (not has_open or (jsonb_typeof(held)='number' and held::text ~ '^[0-9]+$'))
          and (not has_done or (jsonb_typeof(done)='number' and done::text ~ '^[0-9]+$')) as valid from receipts
      ) select keys.key, metadata.unreadable or coalesce(bool_or(valid is distinct from true) filter (where checked.key is not null),false) as unreadable,
        coalesce(sum(case when valid and has_done and verified then done::text::numeric else 0 end),0)::text as confirmed,
        coalesce(sum(case when valid then (case when has_open then held::text::numeric else 0 end)
          + (case when has_done and not verified then done::text::numeric else 0 end) else 0 end),0)::text as reserved,
        coalesce(sum(has_open::int + has_done::int),0)::int as coverage
      from keys cross join metadata left join checked on checked.key=keys.key group by keys.key, metadata.unreadable`) : null;
    const receipts = new Map((ledgerRows?.rows ?? []).map(row => [row.key, row]));
    const executionsByCase = groupBy(executionRows.rows, row => row.caseId);
    const effectsByExecution = groupBy(effectRows, row => row.executionId);
    const eventsByCase = groupBy(eventRows.rows, row => row.caseId);
    const callsByCase = groupBy(callRows.rows, row => row.caseId);
    const rows = [];
    let filteredOut = 0;
    // Only public counters/codes are projected. Encrypted event/body content never leaves this function.
    for (const row of page.slice(0, input.limit)) {
      if (input.state && row.state !== input.state) { filteredOut++; continue; }
      const entry = entries.rows.find(e => e.caseId === row.id);
      const message = entry ? messageRows.find(m => m.gmailId === entry.key.slice("inbound:".length) && row.threadIds.includes(m.threadId)) : undefined;
      const executions = executionsByCase.get(row.id) ?? [];
      const componentExecutions = executions.map(e => {
        const note = componentJournal.get(`${e.id}:case_component_note`), status = componentJournal.get(`${e.id}:case_component_status`);
        return { ...e, noteExpected: object.safeParse(object.parse(decryptSavPayload(e.payload)).note).success,
          noteOutcome: note ? object.parse(decryptSavPayload(note)) : null,
          statusOutcome: status ? object.parse(decryptSavPayload(status)) : null };
      });
      const componentEffects = executions.flatMap(e => effectsByExecution.get(e.id) ?? []);
      const outcomes = componentExecutions.map(e => ({ executionId: e.id, ...caseComponentOutcomes(e, componentExecutions, componentEffects) }));
      const active = executions.filter(e => !["refused", "cancelled"].includes(e.state) && !e.reason?.startsWith("SAV_CASE_EFFECT_CANCELLED_"));
      const effects = executions.flatMap(e => effectsByExecution.get(e.id) ?? []);
      const activeEffects = active.flatMap(e => effectsByExecution.get(e.id) ?? []);
      // First confirmed V2 reply of this case, excluding unrelated V1/CRM effects.
      const reply = effects.filter(e => e.kind === "reply_send" && e.state === "confirmed" && e.confirmedAt).sort((a, b) => a.confirmedAt!.getTime() - b.confirmedAt!.getTime())[0];
      const noteCreates = activeEffects.filter(e => e.kind === "note_create");
      const queuedNote = active.some(e => !effectsByExecution.get(e.id)?.some(f => f.kind === "note_create") && object.safeParse(object.parse(decryptSavPayload(e.payload)).note).success);
      const note = queuedNote ? "queued" : !noteCreates.length ? activeEffects.some(e => e.kind === "note_associate") ? "queued" : "absent" : noteCreates.every(e => e.state === "confirmed" && e.confirmedAt && effectsByExecution.get(e.executionId)?.some(a => a.kind === "note_associate" && a.state === "confirmed" && a.confirmedAt)) ? "confirmed" : "queued";
      const stages = activeEffects.filter(e => e.kind === "ticket_stage");
      const queuedStage = active.some(e => e.key.startsWith("case-stage:") && !effectsByExecution.get(e.id)?.some(f => f.kind === "ticket_stage"));
      const status = queuedStage ? "queued" : !stages.length ? "absent" : stages.every(e => e.state === "confirmed" && e.confirmedAt) ? "confirmed" : "queued";
      const body = object.parse(decryptSavPayload(row.payload));
      const handoff = object.safeParse(body.handoff);
      const reason = handoff.success ? handoff.data.reason : null;
      const refusals = new Set<string>();
      const events = eventsByCase.get(row.id) ?? [];
      for (const event of events) {
        const payload = object.parse(decryptSavPayload(event.payload));
        const detail = object.safeParse(payload.detail), record = object.safeParse(detail.success ? detail.data.record : null);
        if (!record.success || record.data.kind !== "sav-case-investigation.v1") continue;
        const progress = object.parse(record.data.progress);
        for (const attempt of z.array(object).parse(progress.attempts)) {
          // Progress repeats across resumptions: count a validated call once per input.
          if (attempt.result === "validated" && attempt.outcome === "needs_review") refusals.add(JSON.stringify([record.data.inputKey, attempt.call]));
        }
      }
      const calls = callsByCase.get(row.id) ?? [];
      let confirmed = 0, reserved = 0;
      let ledgerUnreadable = false;
      const complete = calls.length > 0 && calls.every(call => {
        const receipt = receipts.get(call.key);
        if (!receipt || receipt.unreadable || !Number.isSafeInteger(Number(receipt.confirmed)) || !Number.isSafeInteger(Number(receipt.reserved))) ledgerUnreadable = true;
        confirmed += Number(receipt?.confirmed ?? 0);
        reserved += Number(receipt?.reserved ?? 0);
        return !ledgerUnreadable && (call.state === "released" ? receipt?.coverage === 0 : receipt?.coverage === 1);
      });
      const entered = row.receivedAt ? new Date(row.receivedAt) : null, answered = reply?.confirmedAt ?? null;
      rows.push({ caseId: row.id, threadId: message?.threadId ?? row.threadIds[0] ?? null, messageId: message?.id ?? null, state: row.state, phase: row.phase,
        receivedAt: entered?.toISOString() ?? null, replyConfirmedAt: answered?.toISOString() ?? null,
        replyDelaySeconds: entered && answered && answered >= entered ? (answered.getTime() - entered.getTime()) / 1000 : null,
        outcomes, hubspot: { note, status }, handoffReason: typeof reason === "string" ? handoffCodes.has(reason) ? reason : "other_internal_reason" : null,
        questions: (() => {
          const questions = z.array(z.object({ answeredBy: z.unknown().optional() })).parse(body.questions ?? []);
          const answered = questions.filter(question => question.answeredBy != null).length;
          return { asked: questions.length, answered, open: questions.length - answered };
        })(),
        validatorRefusals: refusals.size,
        cost: { confirmedMicroUsd: complete ? confirmed : null, reservedMicroUsd: complete ? reserved : null, reason: complete ? null : !calls.length ? "no_recorded_call" : ledgerUnreadable ? "receipt_unreadable" : "receipt_missing" },
      });
    }
    const last = page.slice(0, input.limit).at(-1);
    return { attendus, observedAt, statesFilterApplied: !!input.state, filteredOut, rows, nextCursor: page.length > input.limit && last ? encryptSavPayload({ v: 3, filters, after: { createdAt: last.createdAt, id: last.id }, snapshotAt, attendus }) : null };
  })();
}
