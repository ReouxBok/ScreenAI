import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savMailboxes, savSyncState } from "@/db/schema";

/** Durable state of the self-scheduler fallback (lib/sav/self-scheduler.ts). Rows of the existing sav.sync_state
 * table only, under their own keys: no migration, no other key is written. Each claim is serialized by a transaction
 * advisory lock on its key, the same mechanism as the monitor lease (lib/sav/monitor.ts). */
export const SELF_SCHEDULER_KEY_PREFIX = "sav-self-scheduler:v1:";
export const SAV_WORKER_PULSE_KEY = "sav-monitor:v1:worker";
export const SAV_MONITOR_SNAPSHOT_KEY = "sav-monitor:v1:snapshot";
export const SAV_HEARTBEAT_KEY = `${SELF_SCHEDULER_KEY_PREFIX}heartbeat`;
/** Opt-in switch. Absent, unreadable or anything but enabled=true means OFF: delivering the code changes nothing. */
export const SELF_SCHEDULER_SWITCH_KEY = `${SELF_SCHEDULER_KEY_PREFIX}switch`;
/** The fallback's sav-reconcile row; its lastPulseId tells the monitor whether the current pulse is the fallback's. */
export const SELF_SCHEDULER_CATCH_UP_KEY = `${SELF_SCHEDULER_KEY_PREFIX}sav-reconcile`;

export type SelfSchedulerJob = "sav-reconcile" | "sav-monitor" | "gmail-watch" | "memory-retention";
export type SelfSchedulerJobRecord = {
  owner: string | null; leaseUntil: string | null; lastStartedAt: string | null; lastTrigger: string | null;
  lastPulseId: string | null; lastFinishedAt: string | null; lastStatus: string | null;
};
export type SelfSchedulerSignals = {
  /** The sav-reconcile worker pulse, written at the start of every pass (cron or fallback). */
  pulse: { id: string; startedAt: string } | null;
  /** observedAt of the last monitor snapshot. */
  monitorObservedAt: string | null;
  /** watch_expiration of each active mailbox (null when unknown). */
  watchExpirations: (string | null)[];
  /** Pulse id of the last pass this fallback started: when it is still the current pulse, no cron pass ran since. */
  catchUpPulseId: string | null;
};
export type SelfSchedulerDecision = { run: true } | { run: false; reason: string };
export type SelfSchedulerSwitch = { enabled: boolean; actor: string | null; reason: string | null; at: string | null };
export type SavHeartbeatRecord = { owner: string; beatAt: string; revision: string | null; startedAt: string | null };

type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
const jobKey = (job: SelfSchedulerJob) => `${SELF_SCHEDULER_KEY_PREFIX}${job}`;
const text = (value: unknown) => typeof value === "string" && value.length <= 200 ? value : null;
function parse(cursor: string | null | undefined): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(cursor ?? "null"); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
function jobRecord(cursor: string | null | undefined): SelfSchedulerJobRecord | null {
  const value = parse(cursor);
  return value && { owner: text(value.owner), leaseUntil: text(value.leaseUntil), lastStartedAt: text(value.lastStartedAt), lastTrigger: text(value.lastTrigger),
    lastPulseId: text(value.lastPulseId), lastFinishedAt: text(value.lastFinishedAt), lastStatus: text(value.lastStatus) };
}
function switchRecord(cursor: string | null | undefined): SelfSchedulerSwitch {
  const value = parse(cursor);
  return { enabled: value?.enabled === true, actor: text(value?.actor), reason: text(value?.reason), at: text(value?.at) };
}
function heartbeatRecord(cursor: string | null | undefined): SavHeartbeatRecord | null {
  const value = parse(cursor), owner = text(value?.owner), beatAt = text(value?.beatAt);
  return owner && beatAt ? { owner, beatAt, revision: text(value?.revision), startedAt: text(value?.startedAt) } : null;
}
async function locked<T>(key: string, work: (tx: Tx) => Promise<T>) {
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    return work(tx);
  });
}
async function switchOn(tx: Pick<Tx, "select">) {
  const [row] = await tx.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, SELF_SCHEDULER_SWITCH_KEY));
  return parse(row?.cursor)?.enabled === true;
}
const OFF = { run: false as const, reason: "switch_off" };
async function readSignals(tx: Tx): Promise<SelfSchedulerSignals> {
  const rows = await tx.select({ key: savSyncState.key, cursor: savSyncState.cursor }).from(savSyncState)
    .where(inArray(savSyncState.key, [SAV_WORKER_PULSE_KEY, SAV_MONITOR_SNAPSHOT_KEY, SELF_SCHEDULER_CATCH_UP_KEY]));
  const pulse = parse(rows.find(row => row.key === SAV_WORKER_PULSE_KEY)?.cursor);
  const pulseId = text(pulse?.id), pulseStartedAt = text(pulse?.startedAt);
  const mailboxes = await tx.select({ watchExpiration: savMailboxes.watchExpiration }).from(savMailboxes).where(eq(savMailboxes.active, true)).limit(50);
  return {
    pulse: pulseId && pulseStartedAt ? { id: pulseId, startedAt: pulseStartedAt } : null,
    monitorObservedAt: text(parse(rows.find(row => row.key === SAV_MONITOR_SNAPSHOT_KEY)?.cursor)?.observedAt),
    watchExpirations: mailboxes.map(mailbox => mailbox.watchExpiration ? mailbox.watchExpiration.toISOString() : null),
    catchUpPulseId: jobRecord(rows.find(row => row.key === SELF_SCHEDULER_CATCH_UP_KEY)?.cursor)?.lastPulseId ?? null,
  };
}
async function writeRow(tx: Tx, key: string, status: string, cursor: Record<string, unknown>) {
  const encoded = JSON.stringify(cursor);
  await tx.insert(savSyncState).values({ key, status, cursor: encoded })
    .onConflictDoUpdate({ target: savSyncState.key, set: { status, cursor: encoded, updatedAt: new Date() } });
}

/** Single-flight claim: under the key's lock, the decision sees the current lease and the signals; a run takes the lease. */
export async function claimSelfSchedulerJob(input: {
  job: SelfSchedulerJob; owner: string; trigger: string; now: Date; leaseMs: number; pulseId?: string;
  decide: (record: SelfSchedulerJobRecord | null, signals: SelfSchedulerSignals, now: number) => SelfSchedulerDecision;
}): Promise<SelfSchedulerDecision> {
  const key = jobKey(input.job);
  return locked(key, async tx => {
    if (!await switchOn(tx)) return OFF;
    const [row] = await tx.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, key));
    const record = jobRecord(row?.cursor);
    const decision = input.decide(record, await readSignals(tx), input.now.getTime());
    if (!decision.run) return decision;
    await writeRow(tx, key, "running", { ...record, owner: input.owner, leaseUntil: new Date(input.now.getTime() + input.leaseMs).toISOString(),
      lastStartedAt: input.now.toISOString(), lastTrigger: input.trigger, lastStatus: "running", ...(input.pulseId ? { lastPulseId: input.pulseId } : {}) });
    return decision;
  });
}

/** Releases the lease only if this owner still holds it. */
export async function finishSelfSchedulerJob(input: { job: SelfSchedulerJob; owner: string; status: string; now: Date }) {
  const key = jobKey(input.job);
  await locked(key, async tx => {
    const [row] = await tx.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, key));
    const record = jobRecord(row?.cursor);
    if (record?.owner !== input.owner) return;
    await writeRow(tx, key, input.status, { ...record, leaseUntil: input.now.toISOString(), lastFinishedAt: input.now.toISOString(), lastStatus: input.status });
  });
}

/** One live heartbeat at most. A start is granted when no beat is fresh, or when the live one runs other code
 * (both revisions known and different): the caller's deployment then takes over and the old run stops at its next beat. */
export async function requestSavHeartbeatStart(input: { owner: string; revision: string | null; now: Date; staleMs: number }) {
  return locked(SAV_HEARTBEAT_KEY, async tx => {
    if (!await switchOn(tx)) return { start: false as const, reason: "switch_off" };
    const [row] = await tx.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, SAV_HEARTBEAT_KEY));
    const current = heartbeatRecord(row?.cursor);
    const alive = current && input.now.getTime() - Date.parse(current.beatAt) < input.staleMs;
    const otherCode = !!(current?.revision && input.revision && current.revision !== input.revision);
    if (alive && !otherCode) return { start: false as const, reason: "alive" };
    await writeRow(tx, SAV_HEARTBEAT_KEY, "starting", { owner: input.owner, beatAt: input.now.toISOString(), revision: input.revision, startedAt: input.now.toISOString() });
    return { start: true as const, reason: alive ? "other_revision" : current ? "stale" : "absent" };
  });
}

/** Read at every tick: the switch OFF stops any heartbeat (old deployments included) at its next tick, without continuation.
 * Otherwise a beat from the owner of the row, or from any run when the row's beat is stale. Another fresh owner wins. */
export async function beatSavHeartbeat(input: { owner: string; revision: string | null; now: Date; staleMs: number }) {
  return locked(SAV_HEARTBEAT_KEY, async tx => {
    if (!await switchOn(tx)) return { alive: false as const, reason: "switch_off" };
    const [row] = await tx.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, SAV_HEARTBEAT_KEY));
    const current = heartbeatRecord(row?.cursor);
    if (current && current.owner !== input.owner && input.now.getTime() - Date.parse(current.beatAt) < input.staleMs) return { alive: false as const, reason: "superseded" };
    await writeRow(tx, SAV_HEARTBEAT_KEY, "beating", { owner: input.owner, beatAt: input.now.toISOString(), revision: input.revision, startedAt: current?.owner === input.owner ? current.startedAt : input.now.toISOString() });
    return { alive: true as const };
  });
}

/** Continuation of a heartbeat run: the row moves from this run's owner to the next generation's owner before that run
 * is started, so the next run's first beat is its own. Granted once per `from`: a second continuation of the same run
 * finds the row already moved and is refused, so two runs can never hold the same owner. */
export async function handOffSavHeartbeat(input: { from: string; to: string; revision: string | null; now: Date }) {
  return locked(SAV_HEARTBEAT_KEY, async tx => {
    if (!await switchOn(tx)) return { handedOff: false as const, reason: "switch_off" };
    const [row] = await tx.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, SAV_HEARTBEAT_KEY));
    const current = heartbeatRecord(row?.cursor);
    if (current?.owner !== input.from) return { handedOff: false as const, reason: "not_owner" };
    await writeRow(tx, SAV_HEARTBEAT_KEY, "handed_off", { owner: input.to, beatAt: input.now.toISOString(), revision: input.revision, startedAt: input.now.toISOString() });
    return { handedOff: true as const };
  });
}

/** Administrator switch. Writes only its own row; the actor and reason are kept on the row and in the audit log. */
export async function setSelfSchedulerSwitch(input: { enabled: boolean; actor: string; reason: string; now: Date }) {
  return locked(SELF_SCHEDULER_SWITCH_KEY, async tx => {
    const value: SelfSchedulerSwitch = { enabled: input.enabled, actor: input.actor, reason: input.reason, at: input.now.toISOString() };
    await writeRow(tx, SELF_SCHEDULER_SWITCH_KEY, input.enabled ? "enabled" : "disabled", value);
    await tx.insert(auditLogs).values({ actorEmail: input.actor, action: input.enabled ? "sav_self_scheduler_enabled" : "sav_self_scheduler_disabled",
      entityType: "sav_self_scheduler", entityId: "switch", technicalMetadata: { reason: input.reason } });
    return value;
  });
}

/** A start that could not be enqueued leaves no fresh beat behind, so the next trigger retries. */
export async function abandonSavHeartbeatStart(owner: string) {
  await locked(SAV_HEARTBEAT_KEY, async tx => {
    const [row] = await tx.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, SAV_HEARTBEAT_KEY));
    const current = heartbeatRecord(row?.cursor);
    if (current?.owner === owner) await writeRow(tx, SAV_HEARTBEAT_KEY, "start_failed", { ...current, beatAt: new Date(0).toISOString() });
  });
}

/** Read-only view for the administrator route: keys of this fallback only. */
export async function readSelfSchedulerState(): Promise<Record<string, Record<string, unknown>>> {
  const rows = await requireDb().select({ key: savSyncState.key, status: savSyncState.status, cursor: savSyncState.cursor }).from(savSyncState)
    .where(sql`${savSyncState.key} like ${`${SELF_SCHEDULER_KEY_PREFIX}%`}`).limit(10);
  const state = Object.fromEntries(rows.map(row => [row.key.slice(SELF_SCHEDULER_KEY_PREFIX.length),
    row.key === SAV_HEARTBEAT_KEY ? { status: row.status, ...heartbeatRecord(row.cursor) }
      : row.key === SELF_SCHEDULER_SWITCH_KEY ? switchRecord(row.cursor) : { status: row.status, ...jobRecord(row.cursor) }]));
  return { ...state, switch: state.switch ?? switchRecord(null) };
}
