import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { requireDb } from "@/db";
import { savContentHash } from "./crypto";
import { listSavDossierDashboardReference, type SavDashboardDb, type SavDashboardOptions, type SavDashboardRow } from "./dashboard-source";
import { readSavOtherConfiguration } from "./other-observation";
import { countSavRead } from "./read-metrics";
import { indexSavDashboardSearch, querySavDashboardSearch, savDashboardSearchKeyRevision } from "./dashboard-search";

export const SAV_DASHBOARD_PROJECTION_REVISION = "sav-dashboard-2026-10-20.v2";
export const SAV_DASHBOARD_REPAIR_LIMIT = 25;
export class SavDashboardProjectionPending extends Error {
  constructor() { super("SAV_DASHBOARD_PROJECTION_PENDING"); }
}
export function savSqlDashboardEnabled() { return process.env.SAV_DASHBOARD_SQL === "true"; }

// Explicit ARRAY construction works identically with postgres-js and PGlite.
const textArray = (values: string[]) => sql`ARRAY[${sql.join(values.map(value => sql`${value}`), sql`, `)}]::text[]`;
const scope = (threadId?: string) => threadId ? sql`thread_id = ${threadId}::uuid` : sql`true`;
async function execute<T extends Record<string, unknown> = Record<string, unknown>>(db: SavDashboardDb, statement: SQL) {
  countSavRead("queries");
  const result = await db.execute<T>(statement);
  return Array.isArray(result) ? result : (result as unknown as { rows: T[] }).rows;
}
type Generation = { key: string; otherStatus: ReturnType<typeof readSavOtherConfiguration>["status"] };
async function generation(db: SavDashboardDb): Promise<Generation> {
  // Active knowledge affects the displayed draft verdict, not membership/counts
  // or searchable summary. Page hydration always reads it in the same snapshot.
  const [state] = await execute<{ cutover: string | null }>(db, sql`select
    (select json_build_array(status, cursor)::text from sav.sync_state where key = 'sav-v0-cutover') as cutover`);
  const other = readSavOtherConfiguration();
  return { key: savContentHash({ revision: SAV_DASHBOARD_PROJECTION_REVISION, state, other, key: savDashboardSearchKeyRevision() }), otherStatus: other.status };
}

/** Cache maintenance only. The source row and its invalidation commit together.
 * Lock cache versions before reading any source. A concurrent writer either
 * precedes this snapshot or invalidates again after this transaction commits.
 * Bounded retries handle repeatable-read conflicts; no provider/model calls. */
export async function refreshSavDashboardProjection(limit = SAV_DASHBOARD_REPAIR_LIMIT, threadId?: string, options: { deadlineMs?: number } = {}) {
  const batchSize = Math.max(1, Math.min(100, Math.trunc(limit) || SAV_DASHBOARD_REPAIR_LIMIT));
  const checkDeadline = () => {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) throw new Error("SAV_DASHBOARD_REPAIR_DEADLINE");
  };
  for (let attempt = 0; ; attempt++) {
    try {
      checkDeadline();
      return await requireDb().transaction(async db => {
        const current = await generation(db);
        checkDeadline();
        // Restore missing cache entries too; a partial cache must never look
        // like an empty business list after maintenance or restoration.
        await execute(db, sql`insert into sav.dashboard_projection(thread_id)
          select t.id from sav.threads t where ${threadId ? sql`t.id = ${threadId}::uuid` : sql`true`}
          and not exists(select 1 from sav.dashboard_projection p where p.thread_id = t.id)
          order by t.id limit ${batchSize} on conflict(thread_id) do nothing`);
        const dirty = await execute<{ thread_id: string; version: string }>(db, sql`select thread_id, version::text from sav.dashboard_projection
          where ${scope(threadId)} and (indexed_version <> version or generation is distinct from ${current.key})
          order by thread_id limit ${batchSize} for update skip locked`);
        checkDeadline();
        if (!dirty.length) return { refreshed: 0 };
        const rows = new Map<string, { row: SavDashboardRow; search: string }>();
        await listSavDossierDashboardReference({ db, threadIds: dirty.map(item => item.thread_id), capture: (row, search) => {
          if (rows.has(row.threadId)) throw new Error("SAV_DASHBOARD_SOURCE_AMBIGUOUS");
          rows.set(row.threadId, { row, search });
        } });
        checkDeadline();
        for (const item of dirty) {
          checkDeadline();
          const projected = rows.get(item.thread_id);
          if (!projected) {
            await execute(db, sql`update sav.dashboard_projection set indexed_version = version, generation = ${current.key},
              message_id = null, received_at = null, search_grams = '{}', search_stream = '', updated_at = now()
              where thread_id = ${item.thread_id}::uuid`);
            continue;
          }
          const { row, search } = projected, index = indexSavDashboardSearch(search);
          checkDeadline();
          await execute(db, sql`update sav.dashboard_projection set indexed_version = version, generation = ${current.key},
            message_id = ${row.messageId}::uuid, received_at = (select received_at from sav.messages where id = ${row.messageId}::uuid),
            state = ${row.state}, technical = ${row.technical}, incident = ${row.incident}, is_other = ${Boolean(row.otherObservation)},
            search_grams = ${textArray(index.grams)}, search_stream = ${index.stream}, updated_at = now()
            where thread_id = ${item.thread_id}::uuid`);
        }
        checkDeadline();
        return { refreshed: dirty.length };
      }, { isolationLevel: "repeatable read" });
    } catch (error) {
      if (error instanceof Error && error.message === "SAV_DASHBOARD_REPAIR_DEADLINE") return { refreshed: 0, deferred: "deadline" as const };
      // Drizzle retains PostgreSQL's SQLSTATE on cause. Retry the entire snapshot.
      const code = (error as { code?: string; cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
      if (attempt >= 1 || !["40001", "40P01"].includes(code ?? "")) throw error;
    }
  }
}

function normalize(options: SavDashboardOptions) {
  if (options.threadId !== undefined && !/^[a-f0-9-]{36}$/i.test(options.threadId)) throw new Error("SAV_THREAD_ID_INVALID");
  return {
    pageSize: Math.min(50, Math.max(1, Math.trunc(options.pageSize ?? 25) || 25)),
    requestedPage: Math.max(1, Math.min(100_000, Math.trunc(options.page ?? 1) || 1)),
    view: ["to_process", "to_validate", "learning", "completed", "other", "technical", "incidents"].includes(options.view ?? "") ? options.view! : "to_process",
    query: options.query?.trim().slice(0, 200).toLocaleLowerCase("fr") ?? "",
  };
}
type Counts = { to_process: number; to_validate: number; learning: number; completed: number; other: number; technical: number; incidents: number };
function viewPredicate(view: string): SQL {
  return view === "other" ? sql`is_other` : view === "technical" ? sql`technical` : view === "incidents" ? sql`not technical and incident` : sql`not technical and state = ${view}`;
}

async function readPage(options: SavDashboardOptions) {
  const { pageSize, requestedPage, view, query } = normalize(options);
  return requireDb().transaction(async db => {
    const current = await generation(db);
    const [dirty] = await execute<{ pending: boolean }>(db, sql`select exists(select 1 from sav.dashboard_projection
      where ${scope(options.threadId)} and (indexed_version <> version or generation is distinct from ${current.key}))
      or exists(select 1 from sav.threads t where ${options.threadId ? sql`t.id = ${options.threadId}::uuid` : sql`true`}
        and not exists(select 1 from sav.dashboard_projection p where p.thread_id = t.id)) as pending`);
    if (dirty.pending) return { pending: true as const };
    const search = querySavDashboardSearch(query);
    const predicate = sql`${scope(options.threadId)} and message_id is not null and generation = ${current.key}
      ${search.grams.length ? sql`and search_grams @> ${textArray(search.grams)}` : sql``}
      ${search.stream ? sql`and strpos(search_stream, ${search.stream}) > 0` : sql``}`;
    const [counts] = await execute<Counts>(db, sql`select
      count(*) filter (where not technical and state = 'to_process')::int as to_process,
      count(*) filter (where not technical and state = 'to_validate')::int as to_validate,
      count(*) filter (where not technical and state = 'learning')::int as learning,
      count(*) filter (where not technical and state = 'completed')::int as completed,
      count(*) filter (where is_other)::int as other, count(*) filter (where technical)::int as technical,
      count(*) filter (where not technical and incident)::int as incidents
      from sav.dashboard_projection where ${predicate}`);
    const total = counts[view as keyof Counts], totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages), direction = options.sort === "oldest" ? sql`asc` : sql`desc`;
    const selected = await execute<{ thread_id: string; message_id: string; state: string; technical: boolean; incident: boolean; is_other: boolean }>(db, sql`select thread_id, message_id, state, technical, incident, is_other from sav.dashboard_projection
      where ${predicate} and (${viewPredicate(view)}) order by received_at ${direction}, message_id ${direction}
      limit ${pageSize} offset ${(page - 1) * pageSize}`);
    const hydrated = new Map<string, SavDashboardRow>();
    if (selected.length) await listSavDossierDashboardReference({ db, threadIds: selected.map(item => item.thread_id), capture: row => {
      if (hydrated.has(row.threadId)) throw new Error("SAV_DASHBOARD_SOURCE_AMBIGUOUS");
      hydrated.set(row.threadId, row);
    } });
    const rows = selected.map(item => {
      const row = hydrated.get(item.thread_id);
      if (!row || row.messageId !== item.message_id || row.state !== item.state || row.technical !== item.technical
        || row.incident !== item.incident || Boolean(row.otherObservation) !== item.is_other) throw new Error("SAV_DASHBOARD_PROJECTION_INVALID");
      return row;
    });
    return { pending: false as const, data: { rows, counts, total, totalPages, page, pageSize, view, otherConfigurationStatus: current.otherStatus } };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function listSavDossierDashboardSql(options: SavDashboardOptions = {}) {
  const first = await readPage(options);
  if (!first.pending) return first.data;
  await refreshSavDashboardProjection(SAV_DASHBOARD_REPAIR_LIMIT, options.threadId);
  const retried = await readPage(options);
  if (retried.pending) throw new SavDashboardProjectionPending();
  return retried.data;
}

/** Operational readiness, aggregate only. Does not decrypt or repair sources. */
export async function savDashboardProjectionStatus() {
  return requireDb().transaction(async db => {
    const current = await generation(db);
    const [status] = await execute<{ total: number; pending: number; searchable: number; missing: number }>(db, sql`select count(*)::int as total,
      count(*) filter (where indexed_version <> version or generation is distinct from ${current.key})::int as pending,
      count(*) filter (where message_id is not null)::int as searchable,
      (select count(*)::int from sav.threads t where not exists(select 1 from sav.dashboard_projection p where p.thread_id = t.id)) as missing
      from sav.dashboard_projection`);
    return { revision: SAV_DASHBOARD_PROJECTION_REVISION, ...status, pending: status.pending + status.missing };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
