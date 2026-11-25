import { readIntakeUncertaintiesOrUnread } from "./uncertainty-read";
import { intakeHumanHoldSql, intakeThreadHumanHeld } from "./legacy-pause";
import { readSavExternalCompletion, listSavExternalCompletionMessageIds } from "../external-completion";
import "server-only";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeConsole, savIntakeRuns, savIntakeHumanEvents, savMessages, savThreads,
  savIntakeObservationBindings, savResolutionObservations, savObservationCycles, savIntakeJournal } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { historicalMessageSql, historicalThreadSql, intakeMessageHistorical } from "./launch-boundary";
import type { IntakeRuntimePayload } from "./runtime-contract";
import { savIntakeViewSchema, type SavIntakeView } from "./contract";
import { intakeConsoleInstalled } from "./console-capability";
import { noReadRecoverySql } from "./read-recovery-store";
import { SAV_INTAKE_ATTEMPT_POLICY, SAV_INTAKE_BLOCKED_AFTER_MINUTES, intakeActiveBlockSql, intakeCountedAttemptsSql, intakeRescueConsumedSql, intakeRescueOpenSql } from "./attempt-policy";
import { readSavAgentPause, type SavAgentPauseState } from "./agent-pause";
import { savIntakeSourceSnapshot, intakeSourceMatches } from "./runtime-store";
import { intakeDossierSensitive } from "./observation-binding";
import { intakeBlockedSubCause, intakeContextRequiredRoute, intakeExecutionDecisionRoute, intakeSensitiveRoute } from "./console-presentation";
import { observationConsoleCoverage, observationLimitsLabel, publicObservationSourceCodes } from "../observation-coverage";
import { readIntakeExecutionProgress } from "./executor";
import { invalidIntakeAddressMetadata, SAV_INTAKE_INVALID_SOURCE } from "./source-validation";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";
import { intakeRoutingShadowLabel, savIntakeRoutingClassLabels } from "./routing-rules";
import { savAckTicketConsoleReason } from "./ack-ticket";
import { SAV_CASE_THREAD_CONSOLE_REASON } from "./case-thread-reply";
export type ConsoleProjection = { view: SavIntakeView | null; status: string; reason: string | null };
/** Runs only in the worker. CAS against the monotone source epoch means a new
 * inbound arriving during computation can never be cleared by an old result. */
export async function projectIntakeThread(threadId: string, beforePublish?: () => Promise<void>) {
  if (!await intakeConsoleInstalled()) return false;
  const db = requireDb(), [projection] = await db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, threadId));
  if (!projection) return false;
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId));
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const [run] = await db.select().from(savIntakeRuns).where(and(eq(savIntakeRuns.threadId, threadId), eq(savIntakeRuns.isCurrent, true)));
  let result: ConsoleProjection = { view: null, status: "processing", reason: null };
  // SAV-92: whether the current mail already has a V1 decision or execution (a sensitive dossier is then never left in a technical wait).
  let decided = false;
  let routingNote: string | null = null;
  if (message && await readSavExternalCompletion(message)) result = { view: null, status: "external_completion_pending", reason: "Traitement externe enregistré ; les commandes et résultats restent à rapprocher avant clôture administrative." };
  else if (await intakeThreadHumanHeld(threadId)) result = { view: "to_validate", status: "human_hold", reason: "L’équipe garde la main sur ce dossier. L’automatisation reste en pause ; une décision humaine est attendue." };
  else if (message && await intakeMessageHistorical(message.id)) result = { view: "completed", status: "historical_outside_automation", reason: "Historique — hors automatisation. Le statut HubSpot et les preuves sont conservés." };
  else if (thread?.aiPaused) result = { view: null, status: "paused", reason: "Reprise suspendue par l’équipe" };
  // V2 entry: this mail's V1 run was ended with its record on the V2 case; it is not waiting for an analysis.
  else if (message && (!run || run.messageId !== message.id) && (await db.select({ id: savIntakeJournal.id }).from(savIntakeJournal).innerJoin(savIntakeRuns, eq(savIntakeRuns.id, savIntakeJournal.runId))
    .where(and(eq(savIntakeRuns.messageId, message.id), eq(savIntakeJournal.kind, "v2_customer_return"))).limit(1)).length) result = { view: null, status: "v2_customer_return", reason: "Retour client repris sur le dossier V2." };
  else if (!run || run.messageId !== message?.id) result.reason = "Nouvelle entrée en attente d’analyse";
  else {
    try {
    const payload = decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext), plan = payload.plan;
    const [refused] = await db.select().from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.messageId, run.messageId), eq(savIntakeHumanEvents.kind, "refuse"))).limit(1);
    const [pending] = await db.select().from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.parentRunId, run.id), sql`${savIntakeHumanEvents.state} in ('pending','reading','waiting')`)).limit(1);
    const progress = await readIntakeExecutionProgress(run.messageId);
    const local = await db.transaction(async tx => savIntakeSourceSnapshot(tx, message, new Date()));
    decided = Boolean(plan || progress);
    // V1 routing (23/11): live receipts close the dossier; a shadow decision is only named (« aurait transféré à … »), nothing else changes.
    const routing = payload.routing?.messageId === run.messageId ? payload.routing : undefined;
    const routingFinal = routing?.mode === "live" && routing.action !== "keep" ? await (await import("./routing-store")).readIntakeRoutingFinal(run.messageId).catch(() => null) : null;
    if (routing?.mode === "shadow") routingNote = intakeRoutingShadowLabel(routing);
    const routingLabel = routing?.class ? savIntakeRoutingClassLabels[routing.class] : "";
    if (refused) result = { view: "to_validate", status: "human_refused", reason: "Proposition refusée par un opérateur" };
    else if (pending) result = { view: null, status: "human_revalidation", reason: "Choix enregistré, revalidation en cours" };
    else if (routingFinal?.step === "confirmed" && routing?.action === "forward") result = { view: "completed", status: "routed_forwarded",
      reason: `Transféré automatiquement à ${routing.recipient} (${routingLabel}) ; aucune réponse envoyée à l’expéditeur.` };
    else if (routingFinal?.step === "confirmed" && routing?.action === "archive") result = { view: "other", status: "routed_archived",
      reason: `Archivé automatiquement (${routingLabel}) ; aucune réponse envoyée à l’expéditeur.` };
    else if (routingFinal?.step === "uncertain") result = { view: "to_validate", status: "routing_uncertain",
      reason: "Transfert automatique incertain : vérifier la boîte d’envoi de contact@limova.ai avant toute action ; aucun renvoi automatique." };
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
        // SAV-92 (A): a coverage limit (size/count bound, identical at every re-read) gives a partial follow-up, never an
        // "incomplete" one waiting forever; only a real read error keeps the follow-up pending its next daily read.
        // A body really cut at 8 000 characters of text is shown as a named partial follow-up (deterministic, same cut at
        // every read); the learning gates still read the raw sourceErrors and refuse it.
        const coverage = observation ? observationConsoleCoverage(observation.sourceErrors) : null;
        const started = Boolean(observation?.lastSyncAt && coverage !== "incomplete" && cycle && cycle.status !== "unknown");
        const finished = started && observation!.closed && Boolean(cycle && (sensitive || ["resolved","closed_without_resolution","abandoned","duplicate"].includes(cycle.qualification ?? "") || ["new","already_covered","amendment","not_reusable","insufficient_evidence","conflict","candidate_revision_required","specialist_review_required","candidate_created","candidate_updated","candidate_linked","admitted","grouped","not_applicable"].includes(cycle.learningDisposition ?? "")));
        result = finished ? { view: "completed", status: sensitive ? "not_applicable_sensitive" : "summary_finished", reason: null }
          : started ? { view: sensitive ? "sensitive" : "learning", status: coverage === "partial" ? "followup_partial" : "followup_started", reason: coverage === "partial" ? observationLimitsLabel(observation!.sourceErrors) : null }
          : { view: null, status: "followup_pending", reason: coverage === "incomplete" ? followupIncompleteReason(observation!.sourceErrors, observation!.nextSyncAt) : "Actions confirmées, premier suivi en attente" };
      }
    } else if (plan?.progress.kind === "qualified_other" && progress?.state === "refused" && progress.effects.length === 0) result = { view: "other", status: "qualified_other", reason: payload.other ? `${payload.other.label} · règle ${payload.other.ruleId}` : "Classement confirmé par un opérateur" };
    else if (plan?.decision.disposition.kind === "request_identification"
      && (payload.input as {humanResolution?:{suppressOutbound?:boolean}} | undefined)?.humanResolution?.suppressOutbound)
      result = {view:"to_validate",status:"identity_pending_approval",reason:"Demande analysée. Le mail d’identification attend votre accord ; aucun envoi par la reprise."};
    // SAV-92 (C): an execution stopped for a human decision goes to the team's queue; an older one is shown obsolete.
    else if (progress) result = intakeExecutionDecisionRoute({ progress, run }) ?? { view: null, status: progress.state, reason: progress.reason };
    else if (plan?.progress.view === "to_validate") result = { view: "to_validate", status: "human_choice", reason: payload.reason ?? null };
    else if (plan?.progress.kind === "qualified_other") result = { view: "other", status: "qualified_other", reason: payload.other ? `${payload.other.label} · règle ${payload.other.ruleId}`
      : plan.decision.disposition.kind === "no_ticket" && plan.decision.disposition.qualifiedInformation === "automated_noise" ? `Mail automatique · ${payload.noise?.reason ?? "filtre déterministe"}` : "Classement confirmé par un opérateur" };
    else if (plan?.decision.disposition.kind === "no_ticket" && plan.decision.disposition.reason === "acknowledgement_only")
      result = {view:"completed",status:"acknowledgement_only",reason:savAckTicketConsoleReason(plan.acknowledgementTicket)};
    // 25/11 (`SAV_V2_CASE_THREAD_REPLY=on`): a reply relayed to its thread's V2 case is done for V1, never « À valider ».
    else if (plan?.decision.disposition.kind === "no_ticket" && plan.decision.disposition.reason === "v2_case_thread")
      result = { view: "completed", status: "v2_case_thread", reason: SAV_CASE_THREAD_CONSOLE_REASON };
    // SAV-92 (B): a V1 request for context the team must give is a team decision, not a technical wait.
    else result = intakeContextRequiredRoute({ disposition: plan?.decision.disposition, progressKind: plan?.progress.kind, runState: run.state,
      readRetryScheduled: payload.readRecovery?.state === "scheduled",
      retryScheduled: run.state === "waiting" && !run.leaseToken && Boolean(run.leaseUntil && run.leaseUntil > new Date()) })
      ?? { view: null, status: run.state, reason: payload.reason ?? null };
    } catch (error) {
      if (!invalidIntakeAddressMetadata(error)) throw error;
      result = { view: null, status: "waiting", reason: SAV_INTAKE_INVALID_SOURCE };
    }
  }
  // SAV-92 (sensitive): a finance/cancellation dossier with a V1 decision is never left in a technical wait.
  // Review F4: a version re-created without a plan still counts as decided when an earlier version of the SAME mail
  // holds a V1 plan (the execution of the mail is already read above through `progress`).
  const route = result.view === null ? intakeSensitiveRoute(result, true) : null;
  if (route && !decided && run && message && run.messageId === message.id) {
    const siblings = await db.select({ payload: savIntakeRuns.payloadCiphertext }).from(savIntakeRuns)
      .where(and(eq(savIntakeRuns.messageId, run.messageId), sql`${savIntakeRuns.id} <> ${run.id}`));
    decided = siblings.some(s => { try { return Boolean(decryptSavPayload<IntakeRuntimePayload>(s.payload).plan); } catch { return false; } });
  }
  if (route && decided && await intakeDossierSensitive(threadId, thread?.hubspotTicketId ?? null)) result = route;
  if (routingNote) result = { ...result, reason: [result.reason, routingNote].filter(Boolean).join(" · ") };
  await beforePublish?.();
  const published = await db.update(savIntakeConsole).set({ ...result, projectedEpoch: projection.epoch,
    messageId: message?.id ?? null, runId: run?.id ?? null, version: run?.version ?? null })
    .where(and(eq(savIntakeConsole.threadId, threadId), eq(savIntakeConsole.epoch, projection.epoch))).returning({ id: savIntakeConsole.threadId });
  return published.length === 1;
}
/** "Collecte du suivi incomplète" with the named read errors and the next daily read: never a promise without a date. */
function followupIncompleteReason(sourceErrors: readonly unknown[], nextSyncAt: Date | null) {
  const codes = publicObservationSourceCodes(sourceErrors).filter(c => c.kind === "error").map(c => c.code);
  const next = nextSyncAt ? nextSyncAt.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }) : null;
  return `Ticket créé et actions confirmées. Collecte du suivi incomplète (${codes.join(", ") || "lecture échouée"})${next ? ` ; nouvelle lecture prévue le ${next}` : ""}.`;
}
export async function refreshIntakeConsole(limit = 20) {
  if (!await intakeConsoleInstalled()) return { skipped: "migration_absent" };
  const rows = await requireDb().select({ id: savIntakeConsole.threadId }).from(savIntakeConsole)
    .where(and(sql`${savIntakeConsole.epoch} <> ${savIntakeConsole.projectedEpoch}`, sql`not ${historicalThreadSql(savIntakeConsole.threadId)}`)).orderBy(savIntakeConsole.updatedAt, savIntakeConsole.threadId).limit(Math.min(50, Math.max(1, limit)));
  for (const row of rows) await projectIntakeThread(row.id);
  return { refreshed: rows.length };
}
/** SAV-75: the administrative pause seen by the blocked-run predicate. While analysis is fully
 * paused nobody can claim a waiting run, so waiting is expected, never a technical incident;
 * after a resume the 15-minute threshold restarts from the resume. */
export type IntakeBlockedPause = { analysisPaused: boolean; resumedAt: string | null };
export const INTAKE_NOT_PAUSED: IntakeBlockedPause = { analysisPaused: false, resumedAt: null };
export function intakeBlockedPause(state: SavAgentPauseState): IntakeBlockedPause {
  return { analysisPaused: state.level === "fully_paused", resumedAt: state.level !== "fully_paused" && state.setting ? state.setting.setAt : null };
}
/** Current run blocked: durable blocking marker, or a technical wait/analysis older than the threshold.
 * Shared by the console list, its counters and the monitor, so moving a dossier never hides the incident. */
/** A scheduled automatic retry (waiting, no lease token, future leaseUntil) is a next action, not an incident, until its due time passes. */
/** SAV-92 (A): a run whose mail already has a confirmed execution (ticket and actions done) is not an incident even if it
 * was left waiting: no code moves a run after its execution is confirmed. Its follow-up is shown on its own. */
export function intakeBlockedRunSql(threadId: ReturnType<typeof sql>, pause: IntakeBlockedPause = INTAKE_NOT_PAUSED) {
  // An analysis stuck from before the pause stays an incident; waiting for a claim does not.
  const states = pause.analysisPaused ? sql`('analysing')` : sql`('pending', 'waiting', 'analysing')`;
  const since = pause.resumedAt ? sql`greatest(br.updated_at, ${pause.resumedAt}::timestamptz)` : sql`br.updated_at`;
  return sql`exists(select 1 from sav.intake_runs br where br.thread_id = ${threadId} and br.is_current and (
    ${intakeActiveBlockSql(sql`br.id`)}
    or (br.state in ${states} and ${since} < now() - make_interval(mins => ${SAV_INTAKE_BLOCKED_AFTER_MINUTES})
      and not coalesce(br.state = 'waiting' and br.lease_token is null and br.lease_until > now(), false)
      and not exists(select 1 from sav.intake_executions be where be.message_id = br.message_id and be.state = 'confirmed'))))`;
}
export function intakeBlockedCauseSql(threadId: ReturnType<typeof sql>, pause: IntakeBlockedPause = INTAKE_NOT_PAUSED) {
  // SAV-88: an attempts_exhausted lifted by the rescue claimed on the same run no longer blocks (see attempt-policy.ts).
  const marker = (kind: string) => sql`exists(select 1 from sav.intake_runs br where br.thread_id = ${threadId} and br.is_current and ${intakeActiveBlockSql(sql`br.id`, [kind])})`;
  const paused = pause.analysisPaused ? sql`exists(select 1 from sav.intake_runs br where br.thread_id = ${threadId} and br.is_current and br.state in ('pending', 'waiting'))` : sql`false`;
  // SAV-88: a version re-created (deployment) after the message already used its one rescue is never claimed again: "à traiter à la main".
  const rescueUsed = sql`exists(select 1 from sav.intake_runs br where br.thread_id = ${threadId} and br.is_current and br.state in ('pending', 'waiting')
    and ${intakeRescueConsumedSql(sql`br.message_id`)} and not ${intakeRescueConsumedSql(sql`br.message_id`, sql`br.id`)}
    and ${intakeCountedAttemptsSql(sql`br.message_id`)} >= ${SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage})`;
  // A version re-created after the attempt caps is never scheduled, so it never gets its marker: it is exhausted, not
  // "waiting for the next pass". Same lifetime total as the scheduler's bound; an open rescue lifts it.
  const exhaustedUnmarked = sql`exists(select 1 from sav.intake_runs br where br.thread_id = ${threadId} and br.is_current and br.state in ('pending', 'waiting')
    and ${intakeCountedAttemptsSql(sql`br.message_id`)} >= ${SAV_INTAKE_ATTEMPT_POLICY.totalPerMessage}
    and not ${intakeRescueOpenSql(sql`br.id`, sql`br.message_id`)} and ${noReadRecoverySql(sql`br.id`)})`;
  return sql<string | null>`case when ${marker("rescue_failed")} or ${rescueUsed} then 'manual_required' when ${marker("private_resource_unavailable")} then 'private_resource_unavailable'
    when ${marker("other_evidence_unavailable")} then 'other_evidence_unavailable' when ${marker("forwarded_origin_unverified")} then 'forwarded_origin_unverified' when ${marker("attempts_exhausted")} or ${exhaustedUnmarked} then 'attempts_exhausted' when ${marker("deterministic_block")} then 'input_invalid'
    when ${marker("source_invalid")} then 'source_invalid' when ${intakeBlockedRunSql(threadId, pause)} then 'technical_wait' when ${paused} then 'agent_paused' else null end`;
}
/** Due time of a scheduled automatic retry of the current run, if any. */
export function intakeRetryAtSql(threadId: ReturnType<typeof sql>) {
  return sql<Date | null>`(select br.lease_until from sav.intake_runs br where br.thread_id = ${threadId} and br.is_current
    and br.state = 'waiting' and br.lease_token is null and br.lease_until > now() limit 1)`;
}
const latestMessageJoin = eq(savMessages.id, sql`(select m.id from sav.messages m where m.thread_id=${savIntakeConsole.threadId} and m.direction='inbound' order by least(m.received_at,m.created_at) desc,m.created_at desc,m.id desc limit 1)`);

export async function listIntakeConsole(options: { mailboxId?: string; view?: SavIntakeView | "processing"; search?: string; page?: number; sort?: "newest" | "oldest" } = {}) {
  if (!await intakeConsoleInstalled()) return { installed: false, counts: {}, rows: [], page: 1, pages: 1, total: 0 };
  const search = (options.search ?? "").trim().slice(0, 120), page = Math.min(10000, Math.max(1, Math.floor(options.page ?? 1)));
  const escaped = search.replace(/[\\%_]/g, value => `\\${value}`);
  const common = and(options.mailboxId ? eq(savIntakeConsole.mailboxId, options.mailboxId) : undefined,
    search ? or(ilike(savMessages.subject, `%${escaped}%`), ilike(savMessages.fromEmail, `%${escaped}%`)) : undefined);

  // Both statements share one immutable PostgreSQL snapshot and exactly the
  // same mailbox/search cohort. No arbitrary 250-row application filtering.
  return requireDb().transaction(async tx => {
    const pause = intakeBlockedPause(await readSavAgentPause(tx));
    const completedIds = await listSavExternalCompletionMessageIds(tx, true, options.mailboxId, "completed");
    const otherIds = await listSavExternalCompletionMessageIds(tx, true, options.mailboxId, "other");
    const reviewIds = await listSavExternalCompletionMessageIds(tx, true, options.mailboxId, "to_validate");
    const markedIds = await listSavExternalCompletionMessageIds(tx, false, options.mailboxId);
    const completed = completedIds.length ? sql`${savMessages.id} in (${sql.join(completedIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
    const marked = markedIds.length ? sql`${savMessages.id} in (${sql.join(markedIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
    const other = otherIds.length ? sql`${savMessages.id} in (${sql.join(otherIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
    const review = reviewIds.length ? sql`${savMessages.id} in (${sql.join(reviewIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
    // A provider date later than storage is bounded for display and chronological order.
    const effectiveReceivedAt = savEffectiveReceivedAt;
    const held = sql`exists(select 1 from sav.threads ht where ht.id=${savIntakeConsole.threadId} and ht.ai_paused and ${intakeHumanHoldSql(sql`ht.id`)})`;
    const effectiveView = sql<string | null>`case when ${completed} then 'completed' when ${other} then 'other' when ${review} then 'to_validate' when ${marked} then null when ${held} then 'to_validate' when ${historicalMessageSql()} then 'completed' when ${savIntakeConsole.status}='external_completion_pending' then null when ${savIntakeConsole.epoch}=${savIntakeConsole.projectedEpoch} then ${savIntakeConsole.view} else null end`;
    const selected = options.view && options.view !== "processing" ? eq(effectiveView, savIntakeViewSchema.parse(options.view)) : sql`${effectiveView} is null`;
    // Group the derived column, not a repeated parameterised expression: SQL
    // placeholders in SELECT/GROUP BY otherwise have distinct identities.
    const blocked = intakeBlockedRunSql(sql`${savIntakeConsole.threadId}`, pause);
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
      blockedCause: sql<string | null>`case when ${effectiveView} is null then ${intakeBlockedCauseSql(sql`${savIntakeConsole.threadId}`, pause)} else null end`,
      retryAt: sql<string | null>`case when ${effectiveView} is null then ${intakeRetryAtSql(sql`${savIntakeConsole.threadId}`)} else null end`,
      // SAV-88: the ticket the team already sees names the real state of a dossier waiting for an analysis.
      ticketId: sql<string | null>`(select tt.hubspot_ticket_id from sav.threads tt where tt.id = ${savIntakeConsole.threadId})`,
      // SAV-92 (C): read only, to name a context change no attempt ever took up for more than 24 h.
      runAttempts: sql<number | null>`(select cr.attempts from sav.intake_runs cr where cr.thread_id = ${savIntakeConsole.threadId} and cr.is_current limit 1)`,
      runUpdatedAt: sql<string | null>`(select cr.updated_at from sav.intake_runs cr where cr.thread_id = ${savIntakeConsole.threadId} and cr.is_current limit 1)`,
      view: effectiveView, status: sql<string>`case when ${completed} then 'handled_externally' when ${other} then 'human_other' when ${review} then 'human_review' when ${marked} then 'external_completion_pending' when ${held} then 'human_hold' when ${savIntakeConsole.status}='external_completion_pending' then 'processing' when ${historicalMessageSql()} then 'historical_outside_automation' when ${savIntakeConsole.epoch}<>${savIntakeConsole.projectedEpoch} then 'processing' else ${savIntakeConsole.status} end`,
      reason: sql<string | null>`case when ${completed} then 'Traité hors Studio — clôture administrative de ce message. Aucun verdict IA, fermeture HubSpot ou apprentissage terminé ne sont déclarés.' when ${other} then 'Autres — classement humain de ce message.' when ${review} then 'Décision confiée à l’équipe pour ce message.' when ${marked} then 'Traitement externe enregistré ; commande humaine ou résultat externe à rapprocher.' when ${held} then 'L’équipe garde la main sur ce dossier. L’automatisation reste en pause ; une décision humaine est attendue.' when ${savIntakeConsole.status}='external_completion_pending' then null when ${historicalMessageSql()} then 'Historique — hors automatisation. Aucun ticket HubSpot fermé par ce classement.' when ${savIntakeConsole.epoch}=${savIntakeConsole.projectedEpoch} then ${savIntakeConsole.reason} else null end`,
    }).from(savIntakeConsole).leftJoin(savMessages, latestMessageJoin).where(and(common, selected))
      // Projection refreshes must not reshuffle the chronological list.
      .orderBy(...(options.sort==="oldest"?[sql`${effectiveReceivedAt} asc nulls last`,asc(savMessages.createdAt),asc(savIntakeConsole.threadId)]:[sql`${effectiveReceivedAt} desc nulls last`,desc(savMessages.createdAt),desc(savIntakeConsole.threadId)])).limit(25).offset((currentPage - 1) * 25);
    // Read in a savepoint: its failure rolls back to it and the page keeps its rows, marked `unread` (never "no effect").
    const uncertainties = await readIntakeUncertaintiesOrUnread(rows.filter(row => row.status === "uncertain" && row.messageId).map(row => row.messageId!),
      read => tx.transaction(read));
    return { installed: true, counts: countMap, rows: rows.map(row => ({ ...row, blockedSubCause: intakeBlockedSubCause(row), uncertainty: row.messageId ? uncertainties[row.messageId] ?? null : null })), page: currentPage, pages, total };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
