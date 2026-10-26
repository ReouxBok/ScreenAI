import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql, type SQL } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState, auditLogs, savIntakeExecutions } from "@/db/schema";
import { savIntakeRuntimeConfig } from "./intake/runtime-contract";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "./intake/execution-policy";
import { SAV_INTAKE_OPERATIONAL_PROFILE, intakeAdmissionUsage } from "./intake/budget-profile";
import { readIntakeOtherRules } from "./intake/other-routing";
import { decryptSavPayload } from "./crypto";
import { intakeBlockedRunSql } from "./intake/console-store";
import { monitorStateSchema, monitorCodes, nextMonitorState, monitorWebhook, monitorSlackText, monitorDeliveryHash, type MonitorState, type MonitorSnapshot, type MonitorIssue, type MonitorCode } from "./monitor-contract";

const WORKER = "sav-monitor:v1:worker", STATE = "sav-monitor:v1:state", SNAPSHOT = "sav-monitor:v1:snapshot";
type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
async function queryRows<T extends Record<string, unknown>>(tx: Pick<Tx, "execute">, statement: SQL): Promise<T[]> {
  const result = await tx.execute<T>(statement);
  const rows = Array.isArray(result) ? result : (result as unknown as { rows: T[] }).rows;
  if (!Array.isArray(rows) || rows.length > 100) throw Error("SAV_MONITOR_RESULT_INVALID");
  return rows as T[];
}
type Pulse = { id: string; startedAt: string; finishedAt?: string; lastFinishedAt?: string; lastSucceededAt?: string; monitoringSince?: string; failed?: boolean };
export async function recordSavWorkerPulse(id: string, startedAt: string, failed?: boolean) {
  try {
    await requireDb().transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout','3s',true),set_config('lock_timeout','1s',true)`);
      const finishedAt = new Date().toISOString();
      const value: Pulse = failed === undefined ? { id, startedAt } : { id, startedAt, finishedAt, lastFinishedAt: finishedAt, ...(!failed ? { lastSucceededAt: finishedAt } : {}), failed };
      const encoded = JSON.stringify(value);
      if (failed === undefined) await tx.execute(sql`insert into sav.sync_state(key,status,cursor) values(${WORKER},'running',${JSON.stringify({...value,monitoringSince:startedAt})})
        on conflict(key) do update set status='running',cursor=(sav.sync_state.cursor::jsonb || ${encoded}::jsonb)::text
        where (sav.sync_state.cursor::jsonb->>'startedAt')::timestamptz <= ${startedAt}::timestamptz`);
      else await tx.execute(sql`update sav.sync_state set status=${failed ? "failed" : "finished"},cursor=(cursor::jsonb || ${encoded}::jsonb)::text
        where key=${WORKER} and cursor::jsonb->>'id'=${id}`);
    });
    return true;
  } catch { console.error("sav_monitor_pulse_failed"); return false; }
}

/** Reads metadata only; a failed/partial collection never closes old incidents. */
export async function collectSavMonitorSnapshot(): Promise<MonitorSnapshot> {
  const now = new Date(), issues: MonitorIssue[] = [], metrics: Record<string, number> = {};
  const snapshot: MonitorSnapshot = { observedAt: now.toISOString(), complete: true,
    codeRevision: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.SAV_CODE_REVISION ?? "unknown",
    runtimeMode: process.env.SAV_INTAKE_RUNTIME_MODE === "observe" ? "observe" : "off",
    executionMode: process.env.SAV_INTAKE_EXECUTION_MODE === "execute" ? "execute" : "off", issues, metrics };
  const add = (code: MonitorCode, count: number, severity: MonitorIssue["severity"] = "warning") => { if (count > 0) issues.push({ code, count, severity }); };
  try {
    await requireDb().transaction(async tx => {
      await tx.execute(sql`set transaction isolation level repeatable read read only`);
      await tx.execute(sql`select set_config('statement_timeout','5s',true),set_config('lock_timeout','1s',true),set_config('transaction_timeout','20s',true)`);
      const rows = await tx.select().from(savSyncState).where(sql`${savSyncState.key}=${WORKER} or ${savSyncState.key} like 'sav-intake-launch:%' or ${savSyncState.key}='sav-intake-console-schema-v1' or ${savSyncState.key}='sav-intake-execution-schema-v1'`).limit(15);
      if (rows.length >= 15) throw Error("MONITOR_SCOPE_LIMIT");
      const worker = rows.find(r => r.key === WORKER);
      if (!worker) add("worker_missing", 1);
      else {
        const p = JSON.parse(worker.cursor ?? "null") as Pulse;
        const age = now.getTime() - Date.parse(p.startedAt);
        const completionAge = now.getTime()-Date.parse(p.lastFinishedAt ?? p.monitoringSince ?? p.startedAt);
        if (!Number.isFinite(age) || age < 0 || !Number.isFinite(completionAge) || completionAge < 0) throw Error("MONITOR_WORKER_CLOCK");
        metrics.workerAgeSeconds = Math.floor(age / 1000);
        metrics.workerCompletionAgeSeconds=Math.floor(completionAge/1000);
        add("worker_stalled", age > 15 * 60000 || completionAge > 15*60000 ? 1 : 0, "critical"); add("worker_failed", worker.status === "failed" || p.failed === true ? 1 : 0, "critical");
      }
      const launches = rows.filter(r => r.status === "intake_launch_v1" && r.key.startsWith("sav-intake-launch:"));
      metrics.launchedMailboxes = launches.length;
      const watches = await queryRows<{ count: number }>(tx,sql`select count(*)::int as count from sav.mailboxes where active and (watch_status <> 'watching' and watch_status <> 'active' or watch_expiration is null or watch_expiration < ${new Date(now.getTime() + 3600000).toISOString()})`);
      add("watch_unavailable", watches[0]?.count ?? 0, "critical");
      const receipts = await queryRows<{ count: number; delayed: number }>(tx,sql`select count(*) filter(where status in ('failed','uncertain'))::int as count,
        count(*) filter(where status in ('pending','processing') and received_at < ${new Date(now.getTime()-600000).toISOString()})::int as delayed from sav.webhook_receipts`);
      add("ingestion_failed", receipts[0]?.count ?? 0, "critical");
      add("ingestion_delayed", receipts[0]?.delayed ?? 0, "critical");
      const quarantine = await queryRows<{ count: number }>(tx,sql`select count(*)::int as count from sav.gmail_quarantine where status='quarantined'`);
      add("quarantine", quarantine[0]?.count ?? 0);
      if (!launches.length) return;
      if (!rows.some(r => r.key === "sav-intake-console-schema-v1" && r.status === "installed") || !rows.some(r => r.key === "sav-intake-execution-schema-v1" && r.status === "installed")) {
        add("schema_missing", 1, "critical"); snapshot.complete = false; return;
      }
      add("automation_off", snapshot.runtimeMode !== "observe" || snapshot.executionMode !== "execute" ? 1 : 0);
      const messages = await queryRows<{ pending: number; oldest: number | null; uncertain: number }>(tx,sql`select
        count(*) filter(where m.analysis_status in ('pending','intake_pending','intake_analysing'))::int as pending,
        extract(epoch from (${now.toISOString()}::timestamptz-min(m.created_at) filter(where m.analysis_status in ('pending','intake_pending','intake_analysing'))))::int as oldest,
        count(*) filter(where m.analysis_status='intake_uncertain')::int as uncertain
        from sav.messages m join sav.threads t on t.id=m.thread_id
        join sav.sync_state l on l.key='sav-intake-launch:'||m.mailbox_id::text and l.status='intake_launch_v1'
        where m.direction='inbound' and not t.ai_paused and m.received_at>(l.cursor::jsonb->>'receivedAfter')::timestamptz
        and m.created_at>(l.cursor::jsonb->>'createdAfter')::timestamptz
        and not exists(select 1 from sav.messages n where n.thread_id=m.thread_id and n.direction='inbound' and (n.received_at,n.created_at,n.id)>(m.received_at,m.created_at,m.id))`);
      metrics.pending = messages[0]?.pending ?? 0; metrics.oldestPendingSeconds = Math.max(0, messages[0]?.oldest ?? 0);
      add("analysis_delayed", metrics.oldestPendingSeconds > 600 ? metrics.pending : 0, metrics.oldestPendingSeconds > 1800 ? "critical" : "warning");
      add("analysis_uncertain", messages[0]?.uncertain ?? 0, "critical");
      const waiting = await queryRows<{payload_ciphertext:string;attempts:number}>(tx,sql`select r.payload_ciphertext,r.attempts from sav.intake_runs r
        join sav.messages m on m.id=r.message_id join sav.threads t on t.id=r.thread_id
        join sav.sync_state l on l.key='sav-intake-launch:'||m.mailbox_id::text and l.status='intake_launch_v1'
        where r.is_current and r.state='waiting' and not t.ai_paused and r.updated_at < ${new Date(now.getTime()-600000).toISOString()}
        and m.received_at>(l.cursor::jsonb->>'receivedAfter')::timestamptz and m.created_at>(l.cursor::jsonb->>'createdAfter')::timestamptz
        order by r.updated_at limit 100`);
      let technicalWaiting=0;
      for(const row of waiting) {
        const value=decryptSavPayload<{reason?:unknown;plan?:{decision?:{disposition?:{kind?:string}}}}>(row.payload_ciphertext);
        if(typeof value.reason==='string' && /^SAV_[A-Z_]+$/.test(value.reason) || !value.plan && row.attempts>=2) technicalWaiting++;
      }
      add("analysis_waiting",technicalWaiting,"critical");
      if(waiting.length===100) {snapshot.complete=false;add("collection_failed",1,"critical");}
      const executions = await queryRows<{ count: number }>(tx,sql`select count(*)::int as count from sav.intake_executions e join sav.intake_runs r on r.id=e.run_id
        join sav.threads t on t.id=e.thread_id where r.is_current and not t.ai_paused and e.state in ('pending','running','uncertain','waiting') and e.updated_at < ${new Date(now.getTime()-600000).toISOString()}`);
      add("execution_delayed", executions[0]?.count ?? 0, "critical");
      // Mail that intake owns but cannot move without a person: a human hold on
      // the thread, sources to re-investigate, or a dossier waiting for qualification.
      const held = await queryRows<{ count: number }>(tx,sql`select count(*)::int as count from sav.messages m join sav.threads t on t.id=m.thread_id
        join sav.sync_state l on l.key='sav-intake-launch:'||m.mailbox_id::text and l.status='intake_launch_v1'
        where m.direction='inbound' and t.ai_paused and m.created_at < ${new Date(now.getTime()-1800000).toISOString()}
        and m.received_at>(l.cursor::jsonb->>'receivedAfter')::timestamptz and m.created_at>(l.cursor::jsonb->>'createdAfter')::timestamptz
        and not exists(select 1 from sav.messages n where n.thread_id=m.thread_id and n.direction='inbound' and (n.received_at,n.created_at,n.id)>(m.received_at,m.created_at,m.id))`);
      add("intake_held", held[0]?.count ?? 0);
      const stalled = await queryRows<{ changed: number; waiting: number }>(tx,sql`select
        count(*) filter(where c.status='context_changed')::int as changed,
        count(*) filter(where c.status='waiting')::int as waiting
        from sav.intake_console c join sav.sync_state l on l.key='sav-intake-launch:'||c.mailbox_id::text and l.status='intake_launch_v1'
        where c.updated_at < ${new Date(now.getTime()-1800000).toISOString()}`);
      add("sources_changed_waiting", stalled[0]?.changed ?? 0);
      add("dossier_waiting", stalled[0]?.waiting ?? 0);
      // Same predicate as the console counter: exhausted, deterministically blocked or waiting > 15 min.
      const blocked = await queryRows<{ count: number }>(tx,sql`select count(*)::int as count from sav.intake_console c
        join sav.sync_state l on l.key='sav-intake-launch:'||c.mailbox_id::text and l.status='intake_launch_v1'
        join sav.threads t on t.id=c.thread_id
        where not t.ai_paused and (c.epoch<>c.projected_epoch or c.view is null) and ${intakeBlockedRunSql(sql`c.thread_id`)}`);
      add("intake_blocked", blocked[0]?.count ?? 0, "critical");
      const effects = await queryRows<{ uncertain: number; failed: number }>(tx,sql`select count(*) filter(where state in ('uncertain','dispatched','acked') and confirmed_at is null)::int as uncertain,
        count(*) filter(where state='failed')::int as failed from sav.intake_effects`);
      add("effect_uncertain", effects[0]?.uncertain ?? 0, "critical"); add("effect_failed", effects[0]?.failed ?? 0, "critical");
      const budget = await queryRows<{ daily: string; rolling: string }>(tx,sql`select
        coalesce(sum(charged_nano_usd) filter(where state<>'settled' or created_at >= date_trunc('day',${now.toISOString()}::timestamptz at time zone 'UTC') at time zone 'UTC'),0)::text as daily,
        coalesce(sum(charged_nano_usd) filter(where state<>'settled' or created_at >= ${new Date(now.getTime()-30*86400000).toISOString()}),0)::text as rolling from sav.intake_model_calls`);
      metrics.dailyNanoUsd = Number(budget[0]?.daily ?? 0); metrics.rollingNanoUsd = Number(budget[0]?.rolling ?? 0);
      add("daily_budget_low", metrics.dailyNanoUsd >= 2400000000 ? 1 : 0); add("rolling_budget_low", metrics.rollingNanoUsd >= 72000000000 ? 1 : 0);
    });
    try {
      const config = savIntakeRuntimeConfig();
      const execution = intakeExecutionConfig();
      if (execution) {
        if (!config) throw Error();
        const authority = await readIntakeExecutionAuthority(execution, now);
        const remaining = Date.parse(authority.policy.expiresAt) - now.getTime();
        metrics.authorityRemainingHours = Math.max(0, Math.floor(remaining / 3600000));
        add("authority_expiring", remaining < 3 * 86400000 ? 1 : 0, remaining < 86400000 ? "critical" : "warning");
        // Same admission count as the executor: all executions, or today's (UTC) for the operational profile.
        const admitted = intakeAdmissionUsage(await requireDb().select({ createdAt: savIntakeExecutions.createdAt }).from(savIntakeExecutions),
          authority.policy.budgetProfile === SAV_INTAKE_OPERATIONAL_PROFILE, now);
        metrics.admittedDossiers = admitted; metrics.maxDossiers = authority.policy.maxDossiers;
        add("authority_admission_limit", admitted >= authority.policy.maxDossiers * 0.8 ? 1 : 0, admitted >= authority.policy.maxDossiers ? "critical" : "warning");
      }
      if (config) {
        const remaining = Date.parse(config.expiresAt) - now.getTime();
        metrics.runtimeRemainingHours = Math.max(0, Math.floor(remaining / 3600000));
        add("runtime_expiring", remaining < 3 * 86400000 ? 1 : 0, remaining < 86400000 ? "critical" : "warning");
      }
      const other = readIntakeOtherRules();
      add("other_rules_expiring", other && Date.parse(other.expiresAt)-now.getTime()<86400000 ? 1 : 0);
    } catch { add("configuration_invalid", 1, "critical"); snapshot.complete = false; }
  } catch (error) {
    let current: unknown=error, errorCode="COLLECTION_FAILED";
    for(let depth=0;depth<4 && current && typeof current==='object';depth++) {
      const value=current as {code?:unknown;cause?:unknown};
      if(typeof value.code==='string'&&/^[A-Z0-9_]{2,50}$/.test(value.code)){errorCode=value.code;break;}
      current=value.cause;
    }
    console.error("sav_monitor_collection_failed",{errorCode});
    add("collection_failed", 1, "critical"); snapshot.complete = false;
  }
  return snapshot;
}

/** Monitoring owns only its own keys and audit rows. It cannot run writers. */
export async function runSavServerMonitor() {
  const owner = randomUUID(), now = new Date();
  const initial = await requireDb().transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout','5s',true),set_config('lock_timeout','1s',true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${STATE}))`);
    const [row] = await tx.select().from(savSyncState).where(eq(savSyncState.key, STATE));
    const previous = row ? monitorStateSchema.parse(JSON.parse(row.cursor ?? "null")) : null;
    if (previous && Date.parse(previous.leaseUntil) > now.getTime()) return null;
    if(previous && (previous.delivery.state==='dispatched'||previous.delivery.state==='uncertain') && previous.delivery.hash && previous.events.length) {
      await tx.insert(savSyncState).values({key:`sav-monitor:v1:delivery:${previous.delivery.hash}`,status:'delivery_uncertain',cursor:JSON.stringify({delivery:{...previous.delivery,state:'uncertain'},events:previous.events})}).onConflictDoNothing();
      previous.events=[];
    }
    const next: MonitorState = previous ? { ...previous, owner, leaseUntil: new Date(now.getTime()+90000).toISOString(), delivery: previous.delivery.state === "dispatched" ? { ...previous.delivery, state: "uncertain" } : previous.delivery }
      : { revision: 1, owner, leaseUntil: new Date(now.getTime()+90000).toISOString(), observedAt: null, issues: [], events: [], delivery: { state: "idle", hash: null, attempts: 0, at: null } };
    await tx.insert(savSyncState).values({ key: STATE, status: "running", cursor: JSON.stringify(next) }).onConflictDoUpdate({ target: savSyncState.key, set: { status: "running", cursor: JSON.stringify(next) } });
    return next;
  });
  if (!initial) return { skipped: "already_running" };
  const snapshot = await collectSavMonitorSnapshot();
  const state = nextMonitorState(initial, snapshot);
  const persist = async (receipt?: { hash:string; status:string; events:MonitorState['events'] }) => requireDb().transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout','5s',true),set_config('lock_timeout','1s',true)`);
    const changed = await tx.update(savSyncState).set({ status: "observed", cursor: JSON.stringify(state) }).where(sql`${savSyncState.key}=${STATE} and ${savSyncState.cursor}::jsonb->>'owner'=${owner}`).returning({ key: savSyncState.key });
    if (!changed.length) throw Error("SAV_MONITOR_LEASE_LOST");
    if(receipt)await tx.insert(savSyncState).values({key:`sav-monitor:v1:delivery:${receipt.hash}`,status:receipt.status,cursor:JSON.stringify({delivery:state.delivery,events:receipt.events})}).onConflictDoUpdate({target:savSyncState.key,set:{status:receipt.status,cursor:JSON.stringify({delivery:state.delivery,events:receipt.events})}});
    await tx.insert(savSyncState).values({ key: SNAPSHOT, status: snapshot.complete ? "complete" : "partial", cursor: JSON.stringify(snapshot) }).onConflictDoUpdate({ target: savSyncState.key, set: { status: snapshot.complete ? "complete" : "partial", cursor: JSON.stringify(snapshot) } });
  });
  const webhook = monitorWebhook(process.env.SAV_MONITOR_SLACK_WEBHOOK_URL);
  if (!webhook && state.delivery.state !== "uncertain") state.delivery = { ...state.delivery, state: "unconfigured" };
  await persist();
  if (webhook && state.events.length) {
    const batch=state.events, text = monitorSlackText(snapshot, batch), hash = monitorDeliveryHash(JSON.stringify(batch));
    const attempts=state.delivery.hash===hash?state.delivery.attempts:0;
    if(attempts>=3||state.delivery.hash===hash&&state.delivery.state==='uncertain') {state.events=[];await persist({hash,status:state.delivery.state==='uncertain'?'delivery_uncertain':'delivery_failed',events:batch});}
    else {
    state.delivery = { state: "dispatched", hash, attempts: attempts+1, at: new Date().toISOString() }; await persist({hash,status:'delivery_dispatched',events:batch});
    try {
      const response = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }), redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.ok && (await response.text()).trim() === "ok") {
        state.delivery = { ...state.delivery, state: "sent", attempts: 0 }; state.events = [];
      } else state.delivery = { ...state.delivery, state: response.status >= 400 && response.status < 500 ? "failed" : "uncertain" };
    } catch { state.delivery = { ...state.delivery, state: "uncertain" }; }
    if(state.delivery.state==='uncertain'||state.delivery.attempts>=3)state.events=[];
    await persist({hash,status:`delivery_${state.delivery.state}`,events:batch});
    }
  }
  state.leaseUntil = new Date().toISOString(); await persist();
  await requireDb().insert(auditLogs).values({ actorEmail: "system", action: "sav_monitor_observed", entityType: "sav_monitor", entityId: owner,
    technicalMetadata: { complete: snapshot.complete, issueCount: state.issues.length, delivery: state.delivery.state, code: /^[a-f0-9]{40}$/.test(snapshot.codeRevision) ? snapshot.codeRevision : "unknown" } });
  console.info("sav_monitor_observed", { complete: snapshot.complete, codes: state.issues.map(i => i.code).filter(c => monitorCodes.includes(c)), delivery: state.delivery.state });
  return { complete: snapshot.complete, issues: state.issues, metrics: snapshot.metrics, delivery: state.delivery.state };
}
