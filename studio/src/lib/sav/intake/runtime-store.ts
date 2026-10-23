import "server-only";
import { reconcileIntakeZeroThoughtUsage } from "./model-usage";
import { SAV_INTAKE_OPERATIONAL_PROFILE, intakeBudgetUsage } from "./budget-profile";
import { intakeLaunchMatches } from "./launch-boundary";
import { intakeConsoleInstalled } from "./console-capability";
import { intakeRunConfigurationBound, intakeHumanRefused, intakeHasHumanDecision, intakeRunCandidateContactIds } from "./human-binding";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages, savThreads, savIntakeRuns, savIntakeJournal, savIntakeModelCalls, savIntakeHumanEvents, savIntakeIdentityEpisodes, savIntakeEffects, savIntakeExecutions } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { savAttachmentInventorySchema } from "../attachment-contract";
import { prepareSavIntakeMessage } from "./message";
import { savDerivedCostQuote } from "../derived-budget";
import type { SavGeminiMetadata } from "../gemini-response";
import { intakeRuntimeHash, SAV_INTAKE_RUNTIME_REVISION, type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import type { EngineInput } from "./engine-types";

type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
type Run = typeof savIntakeRuns.$inferSelect;
type Body = { text: string; headers?: Record<string, string>; attachments?: unknown[]; attachmentInventory?: unknown };
export type IntakeLease = { run: Run; token: string; input: EngineInput; provenance: Map<string, ReturnType<typeof prepareSavIntakeMessage>["provenance"]>; body: Body; sourceHash: string };
const fail = (): never => { throw Error("SAV_INTAKE_RUNTIME_CONTEXT_CHANGED"); };
const budgetColumns={id:savIntakeModelCalls.id,messageKey:savIntakeModelCalls.messageKey,requestHash:savIntakeModelCalls.requestHash,state:savIntakeModelCalls.state,reservedNanoUsd:savIntakeModelCalls.reservedNanoUsd,chargedNanoUsd:savIntakeModelCalls.chargedNanoUsd,payloadCiphertext:savIntakeModelCalls.payloadCiphertext,createdAt:savIntakeModelCalls.createdAt};
function budgetRowsValid(rows: Pick<typeof savIntakeModelCalls.$inferSelect,"reservedNanoUsd"|"chargedNanoUsd"|"payloadCiphertext"|"state">[]) {
  for (const row of rows) {
    const data = decryptSavPayload<{ metadata?: SavGeminiMetadata }>(row.payloadCiphertext), m = data.metadata ?? {};
    const { inputTokens: i, outputTokens: o, thoughtTokens: t, totalTokens: total } = m;
    const known = [i, o, t, total].every(n => Number.isSafeInteger(n) && Number(n) >= 0) && Number(i) > 0 && Number(i) <= 1_048_576
      && Number(o) + Number(t) <= 8192 && Number(i) + Number(o) + Number(t) === total;
    if (row.reservedNanoUsd !== 817_152_000 || !Number.isSafeInteger(row.chargedNanoUsd) || row.chargedNanoUsd < 0
      || (row.state === "settled" ? !known || row.chargedNanoUsd !== Number(i) * 750 + (Number(o) + Number(t)) * 3750 : row.chargedNanoUsd !== row.reservedNanoUsd)) throw Error("SAV_INTAKE_RUNTIME_LEDGER_REJECTED");
  }
}

const latest = async (tx: Tx, threadId: string) => (await tx.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
  .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1))[0];
const journal = async (tx: Tx, runId: string, kind: string, value: unknown) => {
  await tx.insert(savIntakeJournal).values({ runId, kind, payloadCiphertext: encryptSavPayload(value) });
};
export async function savIntakeSourceSnapshot(tx: Pick<Tx, "select">, message: typeof savMessages.$inferSelect, now: Date) {
  const rows = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, message.threadId), lte(savMessages.receivedAt, message.receivedAt)))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(51);
  const prepared = rows.slice(0, 50).map(row => {
    const body = decryptSavPayload<Body>(row.bodyCiphertext);
    return { body, ...prepareSavIntakeMessage({ id: row.id, threadId: row.threadId, fromEmail: row.fromEmail, toEmails: row.toEmails,
      direction: row.direction, receivedAt: row.receivedAt.toISOString(), subject: row.subject, body: body.text,
      bodyComplete: typeof body.text === "string" && body.text.length < 100_000, unresolvedAttachments: Boolean(body.attachments?.length) || body.attachmentInventory !== undefined && !savAttachmentInventorySchema.safeParse(body.attachmentInventory).data?.complete }) };
  });
  const current = prepared.find(p => p.message.id === message.id); if (!current) return fail();
  let previousIdentification: EngineInput["previousIdentification"], identificationContinuation: EngineInput["identificationContinuation"];
  const [episode] = await tx.select().from(savIntakeIdentityEpisodes).where(eq(savIntakeIdentityEpisodes.threadId, message.threadId));
  if (episode && episode.initialMessageId !== message.id && episode.initialEffectId) {
    const [effect] = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, episode.initialEffectId));
    const [execution] = effect ? await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, effect.executionId)) : [];
    const recipient = decryptSavPayload<{email:string;mailbox?:string;gmailThread?:string}>(episode.recipientCiphertext);
    const initial = prepared.find(p => p.message.id === episode.initialMessageId)?.message;
    const initialRow = rows.find(r => r.id === episode.initialMessageId);
    if (effect?.kind === "identity_send" && effect.state === "confirmed" && effect.ackCiphertext && effect.verificationCiphertext
      && execution?.threadId === message.threadId && execution.messageId === episode.initialMessageId
      && initial && initialRow?.mailboxId === message.mailboxId && initial.direction === "inbound" && initial.contentComplete
      && initial.fromEmail.toLowerCase() === message.fromEmail.toLowerCase() && recipient.email.toLowerCase() === message.fromEmail.toLowerCase()
      && initial.receivedAt < current.message.receivedAt) {
      previousIdentification = {messageId:initial.id,address:recipient.email,state:"confirmed"};
      identificationContinuation = {initialMessageId:initial.id,confirmedEffectId:effect.id};
    }
  }
  return { sourceHash: intakeRuntimeHash({ rows: rows.map(row => ({ id: row.id, threadId: row.threadId, mailboxId: row.mailboxId,
      fromEmail: row.fromEmail, toEmails: row.toEmails, subject: row.subject, direction: row.direction, bodyCiphertext: row.bodyCiphertext, receivedAt: row.receivedAt })),
      ...(identificationContinuation ? {identificationContinuation} : {}),
      thread: (await tx.select({ updatedAt: savThreads.updatedAt, aiPaused: savThreads.aiPaused, humanRequestedAt: savThreads.humanRequestedAt, ticketId: savThreads.hubspotTicketId }).from(savThreads).where(eq(savThreads.id, message.threadId)))[0] }), body: current.body, provenance: new Map(prepared.map(p => [p.message.id, p.provenance])),
    input: { message: current.message, latestInboundMessageId: message.id, mode: "current", now: now.toISOString(), identificationAttemptId: message.id,
      ...(identificationContinuation ? {previousIdentification,identificationContinuation} : {}),
      conversation: { data: prepared.map(p => p.message).reverse(), status: rows.length > 50 ? "partial" : "complete", observedAt: now.toISOString() } } satisfies EngineInput };
}

const unclaimedMessage = sql`(${savMessages.analysisStatus} = 'pending' and ${savMessages.analysisAttempts} = 0 and ${savMessages.analysisStartedAt} is null and ${savMessages.processedAt} is null
  and not exists (select 1 from sav.decisions d where d.message_id = ${savMessages.id})
  and not exists (select 1 from sav.agent_runs a where a.message_id = ${savMessages.id})
  and not exists (select 1 from sav.pilot_items p where p.message_id = ${savMessages.id})
  and not exists (select 1 from sav.actions a where a.message_id = ${savMessages.id})
  and not exists (select 1 from sav.proposal_reviews r where r.message_id = ${savMessages.id}))`;
// A configuration rotation cannot replace evidence for an action that has
// already left the system. A genuinely new inbound has a different message ID.
const noCommittedExecution = sql`not exists(select 1 from sav.intake_executions e where e.message_id=${savMessages.id}
  and (e.state in ('confirmed','refused') or exists(select 1 from sav.intake_effects f where f.execution_id=e.id
    and (f.state<>'planned' or f.dispatched_at is not null or f.dispatch_token is not null or f.ack_ciphertext is not null or f.confirmed_at is not null))))`;
const eligible = (message: typeof savMessages.$inferSelect, config: IntakeRuntimeConfig) => message.direction === "inbound" && message.mailboxId === config.mailboxId
  && message.receivedAt.getTime() > Date.parse(config.receivedAfter) && message.createdAt.getTime() > Date.parse(config.createdAfter);
/** Called after durable mail insertion. Recovery finds an interrupted enqueue. */
export async function enqueueSavIntakeMessage(messageId: string, config: IntakeRuntimeConfig) {
  return requireDb().transaction(async tx => {
    const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, messageId));
    if (!await intakeLaunchMatches(config, tx) || !message || !eligible(message, config) || await intakeHumanRefused(messageId, tx)) return null;
    await tx.select().from(savThreads).where(eq(savThreads.id, message.threadId)).for("update");
    if ((await latest(tx, message.threadId))?.id !== message.id) return null;
    const [uncommitted] = await tx.select({id:savMessages.id}).from(savMessages).where(and(eq(savMessages.id,message.id),noCommittedExecution));
    if (!uncommitted) return null;
    const [same] = await tx.select().from(savIntakeRuns).where(and(eq(savIntakeRuns.messageId, message.id), eq(savIntakeRuns.configHash, config.configHash)));
    if (same) return same.id;
    if (await intakeHasHumanDecision(messageId, tx)) return null;
    // Atomic ownership claim races safely with the legacy pending->processing UPDATE.
    const owned = await tx.update(savMessages).set({ analysisStatus: "intake_pending" }).where(and(eq(savMessages.id, message.id),
      or(unclaimedMessage, sql`${savMessages.analysisStatus} like 'intake_%'`))).returning({ id: savMessages.id });
    if (!owned.length) return null;
    const [last] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.threadId, message.threadId)).orderBy(desc(savIntakeRuns.version)).limit(1);
    await tx.update(savIntakeRuns).set({ isCurrent: false, state: "superseded", leaseToken: null, leaseUntil: null, freshUntil: null, updatedAt: new Date() })
      .where(and(eq(savIntakeRuns.threadId, message.threadId), eq(savIntakeRuns.isCurrent, true)));
    if (last) await journal(tx, last.id, "superseded", { nextMessageId: message.id });
    const [run] = await tx.insert(savIntakeRuns).values({ threadId: message.threadId, messageId: message.id, version: (last?.version ?? 0) + 1,
      configHash: config.configHash, policyHash: config.policyHash, payloadCiphertext: encryptSavPayload({ revision: SAV_INTAKE_RUNTIME_REVISION, effects: "not_connected" }) }).returning();
    await journal(tx, run.id, "queued", { messageId: message.id, version: run.version, configHash: config.configHash });
    return run.id;
  });
}
/** Scope and latest-inbound predicate prevent a broad historical replay. */
export async function catchupSavIntake(config: IntakeRuntimeConfig, limit = 4) {
  const noHuman = await intakeConsoleInstalled() ? sql`not exists(select 1 from sav.intake_human_events h where h.message_id=${savMessages.id})` : undefined;
  const messages = await requireDb().select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.mailboxId, config.mailboxId), eq(savMessages.direction, "inbound"),
    gt(savMessages.receivedAt, new Date(config.receivedAfter)), gt(savMessages.createdAt, new Date(config.createdAfter)),
    or(unclaimedMessage, sql`${savMessages.analysisStatus} like 'intake_%'`), noHuman, noCommittedExecution,
    sql`not exists (select 1 from sav.intake_runs r where r.message_id = ${savMessages.id} and r.config_hash = ${config.configHash})`,
    sql`not exists (select 1 from sav.messages m where m.thread_id = ${savMessages.threadId} and m.direction = 'inbound' and (m.received_at,m.created_at,m.id) > (${savMessages.receivedAt},${savMessages.createdAt},${savMessages.id}))`))
    .orderBy(savMessages.createdAt).limit(Math.min(4, Math.max(1, limit)));
  for (const message of messages) await enqueueSavIntakeMessage(message.id, config);
  return messages.length;
}
export async function claimSavIntakeRun(id: string, config: IntakeRuntimeConfig, now = new Date()): Promise<IntakeLease | null> {
  return requireDb().transaction(async tx => {
    const [initial] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id)); if (!initial) return null;
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, initial.threadId)).for("update");
    const [run] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, id)).for("update");
    if (!run.isCurrent || !await intakeRunConfigurationBound(run, config, tx) || ["observed", "uncertain", "superseded"].includes(run.state)
      || run.leaseUntil && run.leaseUntil > now) return null;
    const message = await latest(tx, run.threadId);
    if (!message || message.id !== run.messageId || !eligible(message, config)) {
      await tx.update(savIntakeRuns).set({ state: "superseded", isCurrent: false, leaseToken: null, leaseUntil: null, freshUntil: null }).where(eq(savIntakeRuns.id, id)); return null;
    }
    const siblings = await tx.select({ attempts: savIntakeRuns.attempts }).from(savIntakeRuns).where(eq(savIntakeRuns.messageId, run.messageId));
    const totalAttempts = siblings.reduce((sum, sibling) => sum + sibling.attempts, 0);
    const pending = await tx.select({id:savIntakeModelCalls.id}).from(savIntakeModelCalls).where(and(eq(savIntakeModelCalls.runId, id), inArray(savIntakeModelCalls.state, ["dispatched", "uncertain"])));
    const reason = pending.length ? "usage_uncertain" : thread.aiPaused ? "paused" : totalAttempts >= 2 ? "attempts_exhausted" : null;
    if (reason) {
      await tx.update(savIntakeRuns).set({ state: pending.length ? "uncertain" : "waiting", leaseToken: null, leaseUntil: null, freshUntil: null, updatedAt: now }).where(eq(savIntakeRuns.id, id));
      await tx.update(savMessages).set({ analysisStatus: pending.length ? "intake_uncertain" : "intake_waiting" }).where(eq(savMessages.id, run.messageId));
      await journal(tx, id, "waiting", { reason }); return null;
    }
    if(config.budgetProfile===SAV_INTAKE_OPERATIONAL_PROFILE) {
      // Budget deferral is not an analysis attempt. Never burn the two durable
      // attempts merely because another dossier used today's shared margin.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-runtime-model-budget-v1'))`);
      const rows=await tx.select(budgetColumns).from(savIntakeModelCalls);
      budgetRowsValid(rows);
      const budgetNow=new Date(),usage=intakeBudgetUsage(rows,config,budgetNow);
      const messageKey=intakeRuntimeHash(run.messageId);
      const unknown=rows.some(row=>row.messageKey===messageKey&&row.state!=="settled");
      const quote=savDerivedCostQuote(config.model,8192,budgetNow);
      if(unknown||usage.remainingCalls<1||usage.remainingNanoUsd<quote.reservedNanoUsd||usage.remainingRollingNanoUsd<quote.reservedNanoUsd) {
        const payload=decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext);
        const reason=unknown?"SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN":"SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED";
        await tx.update(savIntakeRuns).set({state:unknown?"uncertain":"waiting",payloadCiphertext:encryptSavPayload({...payload,reason}),leaseToken:null,leaseUntil:null,freshUntil:null,updatedAt:budgetNow}).where(eq(savIntakeRuns.id,id));
        await tx.update(savMessages).set({analysisStatus:unknown?"intake_uncertain":"intake_waiting"}).where(eq(savMessages.id,run.messageId));
        await journal(tx,id,"budget_deferred_before_attempt",{reason,attemptsUnchanged:true});
        return null;
      }
    }
    const data = await savIntakeSourceSnapshot(tx, message, now), token = randomUUID();
    const [claimed] = await tx.update(savIntakeRuns).set({ state: "analysing", leaseToken: token, leaseUntil: new Date(now.getTime() + 90_000),
      attempts: run.attempts + 1, sourceHash: data.sourceHash, updatedAt: now }).where(eq(savIntakeRuns.id, id)).returning();
    await tx.update(savMessages).set({ analysisStatus: "intake_analysing" }).where(eq(savMessages.id, run.messageId));
    await journal(tx, id, "claimed", { attempt: claimed.attempts, sourceHash: data.sourceHash });
    return { run: claimed, token, ...data };
  });
}
async function assertLease(tx: Tx, lease: IntakeLease, config: IntakeRuntimeConfig, now: Date) {
  const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, lease.run.threadId)).for("update");
  const [run] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, lease.run.id)).for("update");
  const message = await latest(tx, lease.run.threadId);
  if (!thread || thread.aiPaused || !run?.isCurrent || run.state !== "analysing" || run.leaseToken !== lease.token || !run.leaseUntil || run.leaseUntil <= now
    || run.humanChoiceCiphertext !== lease.run.humanChoiceCiphertext || !await intakeRunConfigurationBound(run, config, tx) || Date.parse(config.expiresAt) <= now.getTime() || message?.id !== run.messageId) return fail();
  if ((await savIntakeSourceSnapshot(tx, message, now)).sourceHash !== lease.sourceHash) return fail();
  return run;
}
export async function assertSavIntakeLease(lease: IntakeLease, config: IntakeRuntimeConfig, now = new Date()) {
  await requireDb().transaction(tx => assertLease(tx, lease, config, now));
}
export async function saveSavIntakeResult(lease: IntakeLease, config: IntakeRuntimeConfig, payload: IntakeRuntimePayload, state: "observed" | "waiting", now = new Date()) {
  return requireDb().transaction(async tx => {
    await assertLease(tx, lease, config, now);
    const oldest = Math.min(Date.parse(lease.input.now), ...(payload.plan?.decision.evidence.map(e => Date.parse(e.observedAt)) ?? []));
    const freshUntil = new Date(oldest + 300_000);
    if (freshUntil <= now) { state = "waiting"; payload.reason = "SAV_INTAKE_RUNTIME_SOURCES_STALE"; }
    await tx.update(savIntakeRuns).set({ state, payloadCiphertext: encryptSavPayload(payload), freshUntil,
      leaseToken: null, leaseUntil: null, updatedAt: now }).where(eq(savIntakeRuns.id, lease.run.id));
    await tx.update(savMessages).set({ analysisStatus: state === "observed" ? "intake_observed" : "intake_waiting" }).where(eq(savMessages.id, lease.run.messageId));
    await journal(tx, lease.run.id, state, payload);
  });
}
/** Fenced failure storage preserves a partial result without reviving an old lease. */
export async function failSavIntakeRun(lease: IntakeLease, payload: IntakeRuntimePayload, uncertain = false) {
  await requireDb().transaction(async tx => {
    await tx.select().from(savThreads).where(eq(savThreads.id, lease.run.threadId)).for("update");
    const rows = await tx.update(savIntakeRuns).set({ state: uncertain ? "uncertain" : "waiting", payloadCiphertext: encryptSavPayload(payload),
      freshUntil: null, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(savIntakeRuns.id, lease.run.id), eq(savIntakeRuns.leaseToken, lease.token), eq(savIntakeRuns.isCurrent, true))).returning();
    if (rows.length) {
      await tx.update(savMessages).set({ analysisStatus: uncertain ? "intake_uncertain" : "intake_waiting" }).where(eq(savMessages.id, lease.run.messageId));
      await journal(tx, lease.run.id, "interrupted", payload);
    } else {
      const [existing] = await tx.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(eq(savIntakeRuns.id, lease.run.id));
      if (existing) await journal(tx, lease.run.id, "obsolete_partial_result", { sourceHash: lease.sourceHash, payload });
    }
  });
}
export async function pendingSavIntakeRuns(config: IntakeRuntimeConfig, now = new Date()) {
  const noHuman = await intakeConsoleInstalled() ? sql`not exists(select 1 from sav.intake_human_events h where h.message_id=${savIntakeRuns.messageId})` : undefined;
  return requireDb().select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(and(eq(savIntakeRuns.isCurrent, true), eq(savIntakeRuns.configHash, config.configHash),
    lt(savIntakeRuns.attempts, 2), noHuman,
    sql`(select coalesce(sum(s.attempts),0) from sav.intake_runs s where s.message_id = ${savIntakeRuns.messageId}) < 2`,
    sql`exists (select 1 from sav.threads t where t.id = ${savIntakeRuns.threadId} and not t.ai_paused)`,
    or(inArray(savIntakeRuns.state, ["pending", "waiting"]), and(eq(savIntakeRuns.state, "analysing"), lt(savIntakeRuns.leaseUntil, now)))))
    .orderBy(savIntakeRuns.createdAt).limit(4);
}
async function reserveIntakeCall(tx: Tx, run: Run, config: IntakeRuntimeConfig, requestHash: string, now: Date) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-runtime-model-budget-v1'))`);
    const rows = await tx.select(budgetColumns).from(savIntakeModelCalls), messageKey = intakeRuntimeHash(run.messageId);
    budgetRowsValid(rows);
    const prior = rows.find(row => row.messageKey === messageKey && row.requestHash === requestHash);
    if (prior) {
      if (prior.state !== "settled") throw Error("SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN");
      const [cache]=await tx.select({resultCiphertext:savIntakeModelCalls.resultCiphertext}).from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id,prior.id));
      if (!cache?.resultCiphertext) throw Error("SAV_INTAKE_RUNTIME_CALL_ALREADY_CONSUMED");
      const saved = decryptSavPayload<{ json: unknown; metadata: SavGeminiMetadata }>(cache.resultCiphertext);
      return { id: prior.id, cached: saved };
    }
    if (rows.some(row => row.state !== "settled" && (config.budgetProfile !== SAV_INTAKE_OPERATIONAL_PROFILE || row.messageKey === messageKey))) throw Error("SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN");
    const budgetNow=config.budgetProfile===SAV_INTAKE_OPERATIONAL_PROFILE ? new Date() : now;
    if(!Number.isFinite(now.getTime())||now>budgetNow)throw Error("SAV_INTAKE_RUNTIME_LEDGER_CLOCK_REJECTED");
    const price = savDerivedCostQuote(config.model, 8192, budgetNow);
    const usage = intakeBudgetUsage(rows,config,budgetNow);
    if (usage.remainingCalls < 1 || rows.filter(row => row.messageKey === messageKey).length >= 3
      || price.reservedNanoUsd > usage.remainingNanoUsd || price.reservedNanoUsd > usage.remainingRollingNanoUsd) throw Error("SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED");
    const [row] = await tx.insert(savIntakeModelCalls).values({ runId: run.id, messageKey, requestHash, state: "dispatched", reservedNanoUsd: price.reservedNanoUsd,
      chargedNanoUsd: price.reservedNanoUsd, createdAt:budgetNow, payloadCiphertext: encryptSavPayload({ model: config.model, configHash: config.configHash }) }).returning();
    return { id: row.id, cached: null };
}
export async function reserveSavIntakeCall(lease: IntakeLease, config: IntakeRuntimeConfig, requestHash: string, now = new Date()) {
  return requireDb().transaction(async tx => { await assertLease(tx,lease,config,now); return reserveIntakeCall(tx,lease.run,config,requestHash,now); });
}
export type IntakeHumanAnalysisAuthority={eventId:string;parentRunId:string;token:string};
async function assertHumanAnalysis(tx:Tx, authority:IntakeHumanAnalysisAuthority,config:IntakeRuntimeConfig,now:Date) {
  const [anchor]=await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,authority.parentRunId)); if(!anchor)return fail();
  const [thread]=await tx.select().from(savThreads).where(eq(savThreads.id,anchor.threadId)).for("update");
  const [run]=await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,anchor.id)).for("update");
  const [event]=await tx.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id,authority.eventId)).for("update");
  if(!run?.isCurrent||!thread||thread.aiPaused||!event||event.kind!=="classify"||event.state!=="reading"||event.leaseToken!==authority.token
    ||!event.leaseUntil||event.leaseUntil<=now||event.parentRunId!==run.id||event.threadId!==run.threadId||event.messageId!==run.messageId||event.sourceHash!==run.sourceHash
    ||event.baseConfigHash!==config.configHash||!await intakeRunConfigurationBound(run,config,tx,event.id))return fail();
  const body=decryptSavPayload<import("./human-binding").HumanEventPayload>(event.payloadCiphertext);
  const [message]=await tx.select().from(savMessages).where(eq(savMessages.id,run.messageId));
  if(!message||body.parentPayloadHash!==intakeRuntimeHash(decryptSavPayload(run.payloadCiphertext))||body.policyHash!==config.policyHash||body.resourcesHash!==config.resourcesHash
    ||!body.reinvestigate&&(body.classification===undefined||body.classification==="other")||(await latest(tx,run.threadId))?.id!==run.messageId
    ||(await savIntakeSourceSnapshot(tx,message,now)).sourceHash!==run.sourceHash)return fail();
  return run;
}
export async function assertIntakeHumanAnalysis(authority:IntakeHumanAnalysisAuthority,config:IntakeRuntimeConfig) {
  await requireDb().transaction(tx=>assertHumanAnalysis(tx,authority,config,new Date()));
}
export async function reserveIntakeHumanCall(authority:IntakeHumanAnalysisAuthority,config:IntakeRuntimeConfig,requestHash:string) {
  return requireDb().transaction(async tx=>{const now=new Date(),run=await assertHumanAnalysis(tx,authority,config,now);return reserveIntakeCall(tx,run,config,requestHash,now);});
}
export async function settleSavIntakeCall(id: string, metadata?: SavGeminiMetadata, result?: { json: unknown; metadata: SavGeminiMetadata }) {
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-runtime-model-budget-v1'))`);
    const [row] = await tx.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.id, id)).for("update"); if (!row) return fail();
    if (row.state !== "dispatched") return row.state === "settled";
    const { inputTokens: i, outputTokens: o, thoughtTokens: t, totalTokens: total } = metadata ?? {};
    const valid = [i, o, t, total].every(n => Number.isSafeInteger(n) && Number(n) >= 0) && Number(i) >= 1 && Number(i) <= 1_048_576
      && Number(o) + Number(t) <= 8192 && Number(i) + Number(o) + Number(t) === total;
    const cost = valid ? Number(i) * 750 + (Number(o) + Number(t)) * 3750 : row.reservedNanoUsd;
    await tx.update(savIntakeModelCalls).set({ state: valid ? "settled" : "uncertain", chargedNanoUsd: cost,
      payloadCiphertext: encryptSavPayload({ metadata: metadata ?? {} }), resultCiphertext: valid && result && row.runId ? encryptSavPayload(result) : null, settledAt: new Date() }).where(eq(savIntakeModelCalls.id, id));
    return valid;
  });
}
/** Bounded accounting repair for the previous deployment's omitted-zero bug.
 * Only confined, non-executable runs are eligible. This settles cost from the
 * original encrypted counters; it never restores output, retries or a plan. */
export async function reconcileConfinedIntakeUsage(config:IntakeRuntimeConfig) {
  if(config.budgetProfile!==SAV_INTAKE_OPERATIONAL_PROFILE)return {reconciled:0};
  return requireDb().transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-runtime-model-budget-v1'))`);
    const rows=await tx.select().from(savIntakeModelCalls).where(eq(savIntakeModelCalls.state,"uncertain"))
      .orderBy(savIntakeModelCalls.createdAt,savIntakeModelCalls.id).limit(3).for("update");
    let reconciled=0;
    for(const row of rows) {
      if(!row.runId||row.resultCiphertext!==null||row.reservedNanoUsd!==817_152_000||row.chargedNanoUsd!==817_152_000)continue;
      const [run]=await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,row.runId));
      const [thread]=run?await tx.select().from(savThreads).where(eq(savThreads.id,run.threadId)):[];
      const [message]=run?await tx.select().from(savMessages).where(eq(savMessages.id,run.messageId)):[];
      if(!run||!thread?.aiPaused||!message||message.mailboxId!==config.mailboxId||!eligible(message,config)
        ||!['uncertain','superseded'].includes(run.state)||run.policyHash!==config.policyHash||row.messageKey!==intakeRuntimeHash(run.messageId))continue;
      const source=decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext).configuration;
      if(source?.codeRevision!=="2483091f858fd3e4c31490c8446278f493f663ba"||source.model!==config.model||source.configHash!==run.configHash
        ||source.policyHash!==config.policyHash||source.resourcesHash!==config.resourcesHash)continue;
      const original=decryptSavPayload<{metadata?:SavGeminiMetadata}>(row.payloadCiphertext),raw=original.metadata;
      if(raw?.thoughtTokens!==undefined||raw?.finishReason!=="STOP"||raw.blockReason&&raw.blockReason!=="BLOCK_REASON_UNSPECIFIED"
        ||raw.transport?.attempts!==1||raw.transport.retries!==0||raw.transport.errorCode!==null||raw.transport.model!==config.model)continue;
      const metadata=reconcileIntakeZeroThoughtUsage(raw);
      if(metadata.usageReconciliation!=="gemini_omitted_zero_thoughts.v1")continue;
      const cost=Number(metadata.inputTokens)*750+Number(metadata.outputTokens)*3750;
      await journal(tx,run.id,"verified_zero_thought_usage_reconciled",{callId:row.id,originalPayloadCiphertext:row.payloadCiphertext,
        originalState:row.state,originalChargedNanoUsd:row.chargedNanoUsd,originalSettledAt:row.settledAt,chargedNanoUsd:cost,metadata});
      await tx.update(savIntakeModelCalls).set({state:"settled",chargedNanoUsd:cost,payloadCiphertext:encryptSavPayload({...original,metadata}),settledAt:new Date()})
        .where(and(eq(savIntakeModelCalls.id,row.id),eq(savIntakeModelCalls.state,"uncertain")));
      reconciled++;
    }
    return {reconciled};
  });
}
/** Read-only contract for later worker/UI lots. Observation never means treatment. */
export async function readSavIntakeCurrent(threadId: string, config?: IntakeRuntimeConfig | null, now = new Date()) {
  const db = requireDb();
  const [run] = await db.select().from(savIntakeRuns).where(and(eq(savIntakeRuns.threadId, threadId), eq(savIntakeRuns.isCurrent, true))); if (!run) return null;
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId));
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const currentSourceHash = message?.id === run.messageId ? await db.transaction(async tx => (await savIntakeSourceSnapshot(tx, message, now)).sourceHash) : null;
  const sourceMatches = currentSourceHash !== null && currentSourceHash === run.sourceHash;
  const payload=decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext);
  const candidateContactIds=await intakeRunCandidateContactIds(run,payload);
  const events = await db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId, run.id)).orderBy(savIntakeJournal.createdAt, savIntakeJournal.id);
  return { ...run, sourceMatches, currentSourceHash, candidateContactIds, fresh: Boolean(config && Date.parse(config.expiresAt) > now.getTime() && await intakeRunConfigurationBound(run, config) && run.state === "observed" && run.freshUntil && run.freshUntil > now && !thread?.aiPaused && sourceMatches),
    payload,
    humanChoice: run.humanChoiceCiphertext ? decryptSavPayload<unknown>(run.humanChoiceCiphertext) : null,
    journal: events.map(event => ({ id: event.id, kind: event.kind, createdAt: event.createdAt, payload: decryptSavPayload<unknown>(event.payloadCiphertext) })) };
}
export async function checkpointSavIntakeRun(lease: IntakeLease, payload: IntakeRuntimePayload) {
  const rows = await requireDb().update(savIntakeRuns).set({ payloadCiphertext: encryptSavPayload(payload), updatedAt: new Date() })
    .where(and(eq(savIntakeRuns.id, lease.run.id), eq(savIntakeRuns.leaseToken, lease.token), eq(savIntakeRuns.isCurrent, true), eq(savIntakeRuns.state, "analysing"))).returning({ id: savIntakeRuns.id });
  if (!rows.length) return fail();
}
export async function readSavIntakeBudget(config: IntakeRuntimeConfig, now = new Date()) {
  const rows = await requireDb().select(budgetColumns).from(savIntakeModelCalls);
  budgetRowsValid(rows);
  return intakeBudgetUsage(rows,config,now);
}
