import { intakeHumanHoldSql, intakeThreadHumanHeld } from "./legacy-pause";
import { readSavExternalCompletion, listSavExternalCompletionMessageIds } from "../external-completion";
import "server-only";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeConsole, savIntakeRuns, savIntakeHumanEvents, savMessages, savThreads,
  savIntakeObservationBindings, savResolutionObservations, savObservationCycles } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { historicalMessageSql, historicalThreadSql, intakeMessageHistorical } from "./launch-boundary";
import type { IntakeRuntimePayload } from "./runtime-contract";
import { savIntakeViewSchema, type SavIntakeView } from "./contract";
import { intakeConsoleInstalled } from "./console-capability";
import { SAV_INTAKE_BLOCKED_AFTER_MINUTES, SAV_INTAKE_BLOCKING_JOURNAL_KINDS } from "./attempt-policy";
import { savIntakeSourceSnapshot, intakeSourceMatches } from "./runtime-store";
import { intakeDossierSensitive } from "./observation-binding";
import { readIntakeExecutionProgress } from "./executor";
import { invalidIntakeAddressMetadata, SAV_INTAKE_INVALID_SOURCE } from "./source-validation";
export type ConsoleProjection = { view: SavIntakeView | null; status: string; reason: string | null };
/** Runs only in the worker. CAS against the monotone source epoch means a new
 * inbound arriving during computation can never be cleared by an old result. */
export async function projectIntakeThread(threadId: string, beforePublish?: () => Promise<void>) {
  if (!await intakeConsoleInstalled()) return false;
  const db = requireDb(), [projection] = await db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, threadId));
  if (!projection) return false;
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId));
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const [run] = await db.select().from(savIntakeRuns).where(and(eq(savIntakeRuns.threadId, threadId), eq(savIntakeRuns.isCurrent, true)));
  let result: ConsoleProjection = { view: null, status: "processing", reason: null };
  if (message && await readSavExternalCompletion(message)) result = { view: null, status: "external_completion_pending", reason: "Traitement externe enregistré ; les commandes et résultats restent à rapprocher avant clôture administrative." };
  else if (await intakeThreadHumanHeld(threadId)) result = { view: "to_validate", status: "human_hold", reason: "L’équipe garde la main sur ce dossier. L’automatisation reste en pause ; une décision humaine est attendue." };
  else if (message && await intakeMessageHistorical(message.id)) result = { view: "completed", status: "historical_outside_automation", reason: "Historique — hors automatisation. Le statut HubSpot et les preuves sont conservés." };
  else if (thread?.aiPaused) result = { view: null, status: "paused", reason: "Reprise suspendue par l’équipe" };
  else if (!run || run.messageId !== message?.id) result.reason = "Nouvelle entrée en attente d’analyse";
  else {
    try {
    const payload = decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext), plan = payload.plan;
    const [refused] = await db.select().from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.messageId, run.messageId), eq(savIntakeHumanEvents.kind, "refuse"))).limit(1);
    const [pending] = await db.select().from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.parentRunId, run.id), sql`${savIntakeHumanEvents.state} in ('pending','reading','waiting')`)).limit(1);
    const progress = await readIntakeExecutionProgress(run.messageId);
    const local = await db.transaction(async tx => savIntakeSourceSnapshot(tx, message, new Date()));
    if (refused) result = { view: "to_validate", status: "human_refused", reason: "Proposition refusée par un opérateur" };
    else if (pending) result = { view: null, status: "human_revalidation", reason: "Choix enregistré, revalidation en cours" };
    // An initial queued run has no recorded source to compare yet. Preserve
    // waiting/pending; a stored source or any plan/result still uses the guards below.
    else if (!run.sourceHash && run.attempts === 0 && !plan && !progress && ["pending", "waiting"].includes(run.state))
      result = { view: null, status: run.state, reason: payload.reason ?? "Nouvelle entrée en attente d’analyse" };
    else if (progress?.confirmed && !intakeSourceMatches(local, progress.completionSourceHash)) result = {view:null,status:"context_changed",reason:"Les sources locales ont changé depuis le résultat confirmé"};
    else if (!progress?.confirmed && !intakeSourceMatches(local, run.sourceHash)) result = {view:null,status:"context_changed",reason:"Les sources locales doivent être réinvestiguées"};
    else if (progress?.confirmed && progress.runId === run.id) {
      if (!progress.ticketId) result = { view: "missing_contact", status: "identity_sent", reason: null };
      else {
        const [binding] = await db.select().from(savIntakeObservationBindings).where(eq(savIntakeObservationBindings.executionId, progress.executionId));
        const [observation] = binding ? await db.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, binding.observationId)) : [];
        const [cycle] = observation ? await db.select().from(savObservationCycles).where(and(eq(savObservationCycles.observationId, observation.id), eq(savObservationCycles.cycle, observation.cycle))) : [];
        const sensitive = Boolean(binding?.sensitive || await intakeDossierSensitive(threadId,progress.ticketId));
        const started = Boolean(observation?.lastSyncAt && !observation.sourceErrors.length && observation.state !== "sources_incomplete" && cycle && cycle.status !== "unknown");
        const finished = started && observation!.closed && Boolean(cycle && (sensitive || ["resolved","closed_without_resolution","abandoned","duplicate"].includes(cycle.qualification ?? "") || ["new","already_covered","amendment","not_reusable","insufficient_evidence","conflict","candidate_revision_required","specialist_review_required","candidate_created","candidate_updated","candidate_linked","admitted","grouped","not_applicable"].includes(cycle.learningDisposition ?? "")));
        result = finished ? { view: "completed", status: sensitive ? "not_applicable_sensitive" : "summary_finished", reason: null }
          : started ? { view: sensitive ? "sensitive" : "learning", status: "followup_started", reason: null }
          : { view: null, status: "followup_pending", reason: observation?.sourceErrors.length ? "Collecte du suivi incomplète" : "Actions confirmées, premier suivi en attente" };
      }
    } else if (plan?.progress.kind === "qualified_other" && progress?.state === "refused" && progress.effects.length === 0) result = { view: "other", status: "qualified_other", reason: payload.other ? `${payload.other.label} · règle ${payload.other.ruleId}` : "Classement confirmé par un opérateur" };
    else if (plan?.decision.disposition.kind === "request_identification"
      && (payload.input as {humanResolution?:{suppressOutbound?:boolean}} | undefined)?.humanResolution?.suppressOutbound)
      result = {view:"to_validate",status:"identity_pending_approval",reason:"Demande analysée. Le mail d’identification attend votre accord ; aucun envoi par la reprise."};
    else if (progress) result = { view: null, status: progress.state, reason: progress.reason };
    else if (plan?.progress.view === "to_validate") result = { view: "to_validate", status: "human_choice", reason: payload.reason ?? null };
    else if (plan?.progress.kind === "qualified_other") result = { view: "other", status: "qualified_other", reason: payload.other ? `${payload.other.label} · règle ${payload.other.ruleId}` : "Classement confirmé par un opérateur" };
    else if (plan?.decision.disposition.kind === "no_ticket" && plan.decision.disposition.reason === "acknowledgement_only")
      result = {view:"completed",status:"acknowledgement_only",reason:"Accusé de réception sans nouvelle demande ; aucun ticket fermé par ce classement."};
    else result = { view: null, status: run.state, reason: payload.reason ?? null };
    } catch (error) {
      if (!invalidIntakeAddressMetadata(error)) throw error;
      result = { view: null, status: "waiting", reason: SAV_INTAKE_INVALID_SOURCE };
    }
  }
  await beforePublish?.();
  const published = await db.update(savIntakeConsole).set({ ...result, projectedEpoch: projection.epoch,
    messageId: message?.id ?? null, runId: run?.id ?? null, version: run?.version ?? null })
    .where(and(eq(savIntakeConsole.threadId, threadId), eq(savIntakeConsole.epoch, projection.epoch))).returning({ id: savIntakeConsole.threadId });
  return published.length === 1;
}
export async function refreshIntakeConsole(limit = 20) {
  if (!await intakeConsoleInstalled()) return { skipped: "migration_absent" };
  const rows = await requireDb().select({ id: savIntakeConsole.threadId }).from(savIntakeConsole)
    .where(and(sql`${savIntakeConsole.epoch} <> ${savIntakeConsole.projectedEpoch}`, sql`not ${historicalThreadSql(savIntakeConsole.threadId)}`)).orderBy(savIntakeConsole.updatedAt, savIntakeConsole.threadId).limit(Math.min(50, Math.max(1, limit)));
  for (const row of rows) await projectIntakeThread(row.id);
  return { refreshed: rows.length };
}
/** Current run blocked: durable blocking marker, or a technical wait/analysis older than the threshold.
 * Shared by the console list, its counters and the monitor, so moving a dossier never hides the incident. */
export function intakeBlockedRunSql(threadId: ReturnType<typeof sql>) {
  const kinds = sql.join(SAV_INTAKE_BLOCKING_JOURNAL_KINDS.map(k => sql`${k}`), sql`, `);
  return sql`exists(select 1 from sav.intake_runs br where br.thread_id = ${threadId} and br.is_current and (
    exists(select 1 from sav.intake_journal bj where bj.run_id = br.id and bj.kind in (${kinds}))
    or (br.state in ('pending', 'waiting', 'analysing') and br.updated_at < now() - make_interval(mins => ${SAV_INTAKE_BLOCKED_AFTER_MINUTES}))))`;
}
export function intakeBlockedCauseSql(threadId: ReturnType<typeof sql>) {
  const marker = (kind: string) => sql`exists(select 1 from sav.intake_runs br join sav.intake_journal bj on bj.run_id = br.id where br.thread_id = ${threadId} and br.is_current and bj.kind = ${kind})`;
  return sql<string | null>`case when ${marker("attempts_exhausted")} then 'attempts_exhausted' when ${marker("deterministic_block")} then 'input_invalid'
    when ${marker("source_invalid")} then 'source_invalid' when ${intakeBlockedRunSql(threadId)} then 'technical_wait' else null end`;
}
const latestMessageJoin = eq(savMessages.id, sql`(select m.id from sav.messages m where m.thread_id=${savIntakeConsole.threadId} and m.direction='inbound' order by m.received_at desc,m.created_at desc,m.id desc limit 1)`);

export async function listIntakeConsole(options: { mailboxId?: string; view?: SavIntakeView | "processing"; search?: string; page?: number; sort?: "newest" | "oldest" } = {}) {
  if (!await intakeConsoleInstalled()) return { installed: false, counts: {}, rows: [], page: 1, pages: 1, total: 0 };
  const search = (options.search ?? "").trim().slice(0, 120), page = Math.min(10000, Math.max(1, Math.floor(options.page ?? 1)));
  const escaped = search.replace(/[\\%_]/g, value => `\\${value}`);
  const common = and(options.mailboxId ? eq(savIntakeConsole.mailboxId, options.mailboxId) : undefined,
    search ? or(ilike(savMessages.subject, `%${escaped}%`), ilike(savMessages.fromEmail, `%${escaped}%`)) : undefined);

  // Both statements share one immutable PostgreSQL snapshot and exactly the
  // same mailbox/search cohort. No arbitrary 250-row application filtering.
  return requireDb().transaction(async tx => {
    const completedIds = await listSavExternalCompletionMessageIds(tx, true, options.mailboxId, "completed");
    const otherIds = await listSavExternalCompletionMessageIds(tx, true, options.mailboxId, "other");
    const reviewIds = await listSavExternalCompletionMessageIds(tx, true, options.mailboxId, "to_validate");
    const markedIds = await listSavExternalCompletionMessageIds(tx, false, options.mailboxId);
    const completed = completedIds.length ? sql`${savMessages.id} in (${sql.join(completedIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
    const marked = markedIds.length ? sql`${savMessages.id} in (${sql.join(markedIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
    const other = otherIds.length ? sql`${savMessages.id} in (${sql.join(otherIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
    const review = reviewIds.length ? sql`${savMessages.id} in (${sql.join(reviewIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
    // A provider date later than storage is bounded for display and chronological order.
    const effectiveReceivedAt = sql`least(${savMessages.receivedAt}, ${savMessages.createdAt})`.mapWith(savMessages.receivedAt);
    const held = sql`exists(select 1 from sav.threads ht where ht.id=${savIntakeConsole.threadId} and ht.ai_paused and ${intakeHumanHoldSql(sql`ht.id`)})`;
    const effectiveView = sql<string | null>`case when ${completed} then 'completed' when ${other} then 'other' when ${review} then 'to_validate' when ${marked} then null when ${held} then 'to_validate' when ${historicalMessageSql()} then 'completed' when ${savIntakeConsole.status}='external_completion_pending' then null when ${savIntakeConsole.epoch}=${savIntakeConsole.projectedEpoch} then ${savIntakeConsole.view} else null end`;
    const selected = options.view && options.view !== "processing" ? eq(effectiveView, savIntakeViewSchema.parse(options.view)) : sql`${effectiveView} is null`;
    // Group the derived column, not a repeated parameterised expression: SQL
    // placeholders in SELECT/GROUP BY otherwise have distinct identities.
    const blocked = intakeBlockedRunSql(sql`${savIntakeConsole.threadId}`);
    const cohort = tx.select({ view: effectiveView.as("effective_view"), blocked: sql<boolean>`${blocked}`.as("blocked") }).from(savIntakeConsole)
      .leftJoin(savMessages, latestMessageJoin).where(common).as("intake_cohort");
    const counts = await tx.select({ view: cohort.view, count: sql<number>`count(*)::int`, blocked: sql<number>`(count(*) filter (where ${cohort.blocked}))::int` }).from(cohort).groupBy(cohort.view);
    const countMap: Record<string, number> = Object.fromEntries(counts.map(row => [row.view ?? "processing", row.count]));
    // Incidents stay counted wherever the dossier is displayed.
    countMap.blocked = counts.filter(row => row.view === null).reduce((sum, row) => sum + row.blocked, 0);
    const total = countMap[options.view ?? "processing"] ?? 0, pages = Math.max(1, Math.ceil(total / 25)), currentPage = Math.min(page, pages);
    const rows = await tx.select({ threadId: savIntakeConsole.threadId, mailboxId: savIntakeConsole.mailboxId,
      messageId: savMessages.id, version: savIntakeConsole.version, subject: savMessages.subject,
      fromEmail: savMessages.fromEmail, receivedAt: effectiveReceivedAt, updatedAt: savIntakeConsole.updatedAt,
      blockedCause: sql<string | null>`case when ${effectiveView} is null then ${intakeBlockedCauseSql(sql`${savIntakeConsole.threadId}`)} else null end`,
      view: effectiveView, status: sql<string>`case when ${completed} then 'handled_externally' when ${other} then 'human_other' when ${review} then 'human_review' when ${marked} then 'external_completion_pending' when ${held} then 'human_hold' when ${savIntakeConsole.status}='external_completion_pending' then 'processing' when ${historicalMessageSql()} then 'historical_outside_automation' when ${savIntakeConsole.epoch}<>${savIntakeConsole.projectedEpoch} then 'processing' else ${savIntakeConsole.status} end`,
      reason: sql<string | null>`case when ${completed} then 'Traité hors Studio — clôture administrative de ce message. Aucun verdict IA, fermeture HubSpot ou apprentissage terminé ne sont déclarés.' when ${other} then 'Autres — classement humain de ce message.' when ${review} then 'Décision confiée à l’équipe pour ce message.' when ${marked} then 'Traitement externe enregistré ; commande humaine ou résultat externe à rapprocher.' when ${held} then 'L’équipe garde la main sur ce dossier. L’automatisation reste en pause ; une décision humaine est attendue.' when ${savIntakeConsole.status}='external_completion_pending' then null when ${historicalMessageSql()} then 'Historique — hors automatisation. Aucun ticket HubSpot fermé par ce classement.' when ${savIntakeConsole.epoch}=${savIntakeConsole.projectedEpoch} then ${savIntakeConsole.reason} else null end`,
    }).from(savIntakeConsole).leftJoin(savMessages, latestMessageJoin).where(and(common, selected))
      // Projection refreshes must not reshuffle the chronological list.
      .orderBy(...(options.sort==="oldest"?[sql`${effectiveReceivedAt} asc nulls last`,asc(savMessages.createdAt),asc(savIntakeConsole.threadId)]:[sql`${effectiveReceivedAt} desc nulls last`,desc(savMessages.createdAt),desc(savIntakeConsole.threadId)])).limit(25).offset((currentPage - 1) * 25);
    return { installed: true, counts: countMap, rows, page: currentPage, pages, total };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
