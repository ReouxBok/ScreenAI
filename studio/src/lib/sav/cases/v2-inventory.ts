import "server-only";
import { and, asc, eq, gt, like, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savCases, savCaseEvents, savCaseCalls, savCaseEffectExecutions, savIntakeEffects, savMessages, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { SAV_CASE_ADMISSION_TEAM_REASONS } from "./case-types";

export const v2InventoryStates = ["processing", "awaiting_customer", "reply_sent", "handed_to_team", "failed", "paused"] as const;
export const v2InventoryInput = z.object({
  from: z.iso.datetime({ offset: true }).optional().describe("Depuis : date inclusive du premier mail client V2."),
  until: z.iso.datetime({ offset: true }).optional().describe("Jusqu’à : date inclusive du premier mail client V2."),
  state: z.enum(v2InventoryStates).optional().describe("processing : en cours ; awaiting_customer : en attente du client ; reply_sent : réponse envoyée ; handed_to_team : transféré à l’équipe ; failed : échec ; paused : en pause."),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional().describe("Curseur opaque durable ; conserver les mêmes filtres. Sa taille dépend du nombre de dossiers dans la fenêtre."),
}).strict();
type Input = z.infer<typeof v2InventoryInput>;
const cursorSchema = z.object({ v: z.literal(1), filters: z.string(), ids: z.array(z.uuid()), after: z.uuid(), observedAt: z.iso.datetime() }).strict();
const invalid = (): never => { throw Error("SAV_V2_INVENTORY_CURSOR_INVALID"); };
const handoffCodes = new Set<string>([...SAV_CASE_ADMISSION_TEAM_REASONS, "explicit_human_request", "sensitive_request", "knowledge_missing", "knowledge_conflict",
  "evidence_inaccessible", "diagnosis_out_of_tools", "repeated_failure", "out_of_scope", "decision_refused", "validator_refusals", "awaiting_v2_attribution"]);
const object = z.record(z.string(), z.unknown());
const spendDay = z.object({ open: z.record(z.string(), z.object({ amount: z.number().int().nonnegative() })), done: z.record(z.string(), z.number().int().nonnegative()), verifiedUsage: z.array(z.string()).optional() });

// Dates belong to the FIRST customer event of the case, not to an unrelated older mail in its V1 thread.
const receivedAt = sql<string | null>`(select min(e.occurred_at)::text from sav.case_events e where e.case_id = sav.cases.id and e.kind = 'inbound_confirmed' and e.direction = 'customer_inbound')`;
const stateSql = sql<typeof v2InventoryStates[number]>`case
  when ${savCases.owner} = 'system_hold' then 'paused'
  when ${savCases.owner} = 'human' then 'handed_to_team'
  when ${savCases.phase} in ('blocked_technical', 'blocked_reconcile', 'needs_review') then 'failed'
  when ${savCases.phase} = 'awaiting_customer' then 'awaiting_customer'
  when ${savCases.phase} = 'resolved' and exists (select 1 from sav.case_effect_executions x join sav.intake_effects f on f.execution_id = x.id where x.case_id = sav.cases.id and f.kind = 'reply_send' and f.state = 'confirmed' and f.confirmed_at is not null) then 'reply_sent'
  else 'processing' end`;

/** Read-only inventory. A sealed membership manifest makes cursors durable across processes and
 * freezes the state/date filter and total despite inserts (even backdated inserts) or case updates.
 * Keyset by immutable UUID, never offset or updated_at. The cursor grows with the window's membership;
 * use smaller date windows for very large inventories. Values are fresh per page, membership is not.
 * No payload upgrade, lock, migration, external call, or write. */
export async function listV2Cases(raw: Input) {
  const input = v2InventoryInput.parse(raw);
  if (input.from && input.until && Date.parse(input.from) > Date.parse(input.until)) throw Error("SAV_V2_INVENTORY_WINDOW_INVALID");
  const filters = JSON.stringify([input.from ? new Date(input.from).toISOString() : null, input.until ? new Date(input.until).toISOString() : null, input.state ?? null]);
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (input.cursor) {
    try { cursor = cursorSchema.parse(decryptSavPayload(input.cursor)); } catch { invalid(); }
    if (!cursor || cursor.filters !== filters || !cursor.ids.includes(cursor.after) || new Set(cursor.ids).size !== cursor.ids.length) invalid();
  }
  return requireDb().transaction(async tx => {
    const observedAt = cursor?.observedAt ?? new Date().toISOString();
    const members = cursor?.ids ?? (await tx.select({ id: savCases.id }).from(savCases).where(and(
      input.from ? sql`${receivedAt}::timestamptz >= ${input.from}::timestamptz` : undefined,
      input.until ? sql`${receivedAt}::timestamptz <= ${input.until}::timestamptz` : undefined,
      input.state ? eq(stateSql, input.state) : undefined,
    )).orderBy(asc(savCases.id))).map(row => row.id);
    if (!members.length) return { attendus: 0, observedAt, rows: [], nextCursor: null };
    const page = await tx.select({ id: savCases.id, threadIds: savCases.threadIds, phase: savCases.phase, state: stateSql, payload: savCases.payloadCiphertext, receivedAt })
      .from(savCases).where(and(sql`${savCases.id} = any(${`{${members.join(",")}}`}::uuid[])`, cursor ? gt(savCases.id, cursor.after) : undefined)).orderBy(asc(savCases.id)).limit(input.limit + 1);
    // A deletion must never make a partial audit look exhaustive.
    const expected = members.filter(id => !cursor || id > cursor.after).slice(0, input.limit + 1);
    if (JSON.stringify(page.map(row => row.id)) !== JSON.stringify(expected)) throw Error("SAV_V2_INVENTORY_MEMBERSHIP_CHANGED");
    const ledgers: z.infer<typeof spendDay>[] = [];
    let ledgerUnreadable = false;
    // One accounting read per page, never the budget writer (which creates/locks day rows).
    for (const ledger of await tx.select({ cursor: savSyncState.cursor }).from(savSyncState).where(like(savSyncState.key, "sav-v2-spend.v1:%"))) {
      try { ledgers.push(spendDay.parse(JSON.parse(ledger.cursor ?? "null"))); } catch { ledgerUnreadable = true; }
    }
    const rows = [];
    // Only public counters/codes are projected. Encrypted event/body content never leaves this function.
    for (const row of page.slice(0, input.limit)) {
      const [entry] = await tx.select({ key: savCaseEvents.dedupeKey }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, row.id), eq(savCaseEvents.kind, "inbound_confirmed"), eq(savCaseEvents.direction, "customer_inbound")))
        .orderBy(asc(savCaseEvents.occurredAt), asc(savCaseEvents.id)).limit(1);
      const [message] = entry ? await tx.select({ id: savMessages.id, threadId: savMessages.threadId }).from(savMessages)
        .where(and(eq(savMessages.gmailMessageId, entry.key.slice("inbound:".length)), eq(savMessages.direction, "inbound"), sql`exists (select 1 from sav.cases c where c.id = ${row.id} and ${savMessages.threadId} = any(c.thread_ids))`)).limit(1) : [];
      const executions = await tx.select({ id: savCaseEffectExecutions.id, key: savCaseEffectExecutions.replyKey, state: savCaseEffectExecutions.state, payload: savCaseEffectExecutions.payloadCiphertext })
        .from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, row.id));
      const effects = await tx.select({ executionId: savCaseEffectExecutions.id, kind: savIntakeEffects.kind, state: savIntakeEffects.state, confirmedAt: savIntakeEffects.confirmedAt })
        .from(savCaseEffectExecutions).innerJoin(savIntakeEffects, eq(savIntakeEffects.executionId, savCaseEffectExecutions.id)).where(eq(savCaseEffectExecutions.caseId, row.id));
      // First confirmed V2 reply of this case, excluding unrelated V1/CRM effects.
      const reply = effects.filter(e => e.kind === "reply_send" && e.state === "confirmed" && e.confirmedAt).sort((a, b) => a.confirmedAt!.getTime() - b.confirmedAt!.getTime())[0];
      const noteCreates = effects.filter(e => e.kind === "note_create");
      const queuedNote = executions.some(e => e.state !== "refused" && !effects.some(f => f.executionId === e.id && f.kind === "note_create") && object.safeParse(object.parse(decryptSavPayload(e.payload)).note).success);
      const note = queuedNote ? "queued" : !noteCreates.length ? effects.some(e => e.kind === "note_associate") ? "queued" : "absent" : noteCreates.every(e => e.state === "confirmed" && e.confirmedAt && effects.some(a => a.executionId === e.executionId && a.kind === "note_associate" && a.state === "confirmed" && a.confirmedAt)) ? "confirmed" : "queued";
      const stages = effects.filter(e => e.kind === "ticket_stage");
      const queuedStage = executions.some(e => e.state !== "refused" && e.key.startsWith("case-stage:") && !effects.some(f => f.executionId === e.id && f.kind === "ticket_stage"));
      const status = queuedStage ? "queued" : !stages.length ? "absent" : stages.every(e => e.state === "confirmed" && e.confirmedAt) ? "confirmed" : "queued";
      const body = object.parse(decryptSavPayload(row.payload));
      const handoff = object.safeParse(body.handoff);
      const reason = handoff.success ? handoff.data.reason : null;
      const refusals = new Set<string>();
      const events = await tx.select({ payload: savCaseEvents.payloadCiphertext }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, row.id), eq(savCaseEvents.kind, "observation_recorded")));
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
      const calls = await tx.select({ key: savCaseCalls.callKey, state: savCaseCalls.state }).from(savCaseCalls).where(eq(savCaseCalls.caseId, row.id));
      let confirmed = 0, reserved = 0;
      const coverage = new Map<string, number>();
      for (const day of ledgers) {
        for (const call of calls) {
          if (Object.hasOwn(day.open, call.key)) { reserved += day.open[call.key]!.amount; coverage.set(call.key, (coverage.get(call.key) ?? 0) + 1); }
          if (Object.hasOwn(day.done, call.key)) { const amount = day.done[call.key]!; if (day.verifiedUsage?.includes(call.key)) confirmed += amount; else reserved += amount; coverage.set(call.key, (coverage.get(call.key) ?? 0) + 1); }
        }
      }
      const complete = !ledgerUnreadable && calls.length > 0 && calls.every(call => call.state === "released" ? !coverage.has(call.key) : coverage.get(call.key) === 1);
      const entered = row.receivedAt ? new Date(row.receivedAt) : null, answered = reply?.confirmedAt ?? null;
      rows.push({ caseId: row.id, threadId: message?.threadId ?? row.threadIds[0] ?? null, messageId: message?.id ?? null, state: row.state, phase: row.phase,
        receivedAt: entered?.toISOString() ?? null, replyConfirmedAt: answered?.toISOString() ?? null,
        replyDelaySeconds: entered && answered && answered >= entered ? (answered.getTime() - entered.getTime()) / 1000 : null,
        hubspot: { note, status }, handoffReason: typeof reason === "string" ? handoffCodes.has(reason) ? reason : "other_internal_reason" : null,
        validatorRefusals: refusals.size,
        cost: { confirmedMicroUsd: complete ? confirmed : null, reservedMicroUsd: complete ? reserved : null, reason: complete ? null : !calls.length ? "no_recorded_call" : ledgerUnreadable ? "receipt_unreadable" : "receipt_missing" },
      });
    }
    const last = rows.at(-1);
    return { attendus: members.length, observedAt, rows, nextCursor: page.length > input.limit && last ? encryptSavPayload({ v: 1, filters, ids: members, after: last.caseId, observedAt }) : null };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
