/** Destructive synthetic benchmark. Refuses any non-dedicated native test target. */
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { createSavNativeTestDb } from "../test/sav-native-db";
import { withStudioDatabase } from "../src/db";
import { savAgentRuns, savDecisions, savMailboxes, savMessages, savThreads } from "../src/db/schema";
import { encryptSavPayload } from "../src/lib/sav/crypto";
import { activateSavV0Cutover } from "../src/lib/sav/cutover";
import { listSavDossierDashboardReference, type SavDashboardOptions } from "../src/lib/sav/dashboard-source";
import { listSavDossierDashboardSql, refreshSavDashboardProjection, savDashboardProjectionStatus } from "../src/lib/sav/dashboard-projection";
import { querySavDashboardSearch } from "../src/lib/sav/dashboard-search";
import { measureSavDashboardRead } from "../src/lib/sav/read-metrics";
import { sav53Proposal } from "../test/sav53-e2e-fixture";
if (process.env.SAV_DASHBOARD_BENCHMARK !== "synthetic-only" || !process.env.SAV_TEST_POSTGRES_URL || process.env.DATABASE_URL) throw new Error("DEDICATED_SYNTHETIC_BENCHMARK_REQUIRED");
const fixture = await createSavNativeTestDb(process.env.SAV_TEST_POSTGRES_URL, process.env.SAV_TEST_POSTGRES_TOKEN);
const report: unknown[] = [];
const originalInfo = console.info;
type Metrics = { durationMs: number; queries: number; sourceRows: number; relatedRows: number; classifiedRows: number; decryptions: number; ciphertextBytes: number };
const quantile = (values: number[], p: number) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*p)-1)];
async function timed(mode: "reference" | "sql", options: SavDashboardOptions) {
  let metrics!: Metrics;
  console.info = (label, value) => { if (label === "sav_dashboard_read") metrics = value; };
  let cancellation: ReturnType<typeof setInterval> | undefined;
  let cancelling = false;
  const deadline = Date.now() + 10_000;
  if (mode === "reference") cancellation = setInterval(() => {
    if (Date.now() < deadline || cancelling) return;
    cancelling = true;
    void fixture.client.query("select pg_cancel_backend(pid) from pg_stat_activity where application_name='codex_sav_validation' and datname=current_database() and pid <> pg_backend_pid() and state='active'").catch(() => {}).finally(() => { cancelling = false; });
  }, 100);
  try {
    const data = await measureSavDashboardRead(mode, () => mode === "sql" ? listSavDossierDashboardSql(options) : listSavDossierDashboardReference(options));
    return { data, metrics };
  } finally { clearInterval(cancellation); console.info = originalInfo; }
}
try {
  await withStudioDatabase(fixture.db, async () => {
    for (const size of [100, 1000, 10_000]) {
      await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs; TRUNCATE active_knowledge");
      const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
      await activateSavV0Cutover({ receivedAfter: "2026-10-01T00:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
      for (let offset=0; offset<size; offset+=100) {
        const batch = Array.from({length:Math.min(100,size-offset)}, (_,i) => ({ index:offset+i, threadId:randomUUID(), messageId:randomUUID(), runId:randomUUID() }));
        await fixture.db.insert(savThreads).values(batch.map(r => ({ id:r.threadId, mailboxId:mailbox.id, gmailThreadId:`benchmark-${r.index}`, subject:`Téléphonie synthétique ${r.index}`, customerEmail:`fixture-${r.index}@example.invalid` })));
        await fixture.db.insert(savMessages).values(batch.map(r => ({ id:r.messageId, threadId:r.threadId, mailboxId:mailbox.id, gmailMessageId:`benchmark-message-${r.index}`, direction:"inbound" as const, fromEmail:`fixture-${r.index}@example.invalid`, subject:`Téléphonie synthétique ${r.index}`, bodyCiphertext:encryptSavPayload({text:"Demande synthétique sans données réelles. ".repeat(20)}), receivedAt:new Date(Date.parse("2026-10-03")+r.index*1000), analysisStatus:"done" as const })));
        await fixture.db.insert(savAgentRuns).values(batch.map(r => ({ id:r.runId, messageId:r.messageId, runtime:"synthetic_fixture", mode:"off", status:"succeeded", model:"fixture", promptRevision:"fixture", inputHash:"fixture", proposalCiphertext:encryptSavPayload(sav53Proposal(false)) })));
        await fixture.db.insert(savDecisions).values(batch.map(r => ({ messageId:r.messageId, agentRunId:r.runId, kind:"human_review_required" as const, reasonCode:"fixture", explanation:"Synthétique", confidence:0 })));
      }
      await fixture.client.exec("ANALYZE sav.messages; ANALYZE sav.threads; ANALYZE sav.agent_runs; ANALYZE sav.decisions");
      const start=performance.now();
      while ((await refreshSavDashboardProjection(100)).refreshed) { /* bounded transactions */ }
      const warmupMs=performance.now()-start;
      await fixture.client.exec("ANALYZE sav.dashboard_projection");
      const samples: {reference?:Metrics;sql:Metrics}[]=[];
      let referenceTimeout = false;
      for (let i=0;i<20;i++) {
        const options:SavDashboardOptions={ pageSize:25, page:i%2?Math.ceil(size/25):1, sort:i%3?"newest":"oldest", ...(i%4===0?{query:"Téléphonie"}:{}) };
        let before: Awaited<ReturnType<typeof timed>> | undefined;
        if (!referenceTimeout) {
          try { before = await timed("reference", options); }
          catch (error) {
            const code = (error as { cause?: { code?: string } }).cause?.code;
            if (code !== "57014") throw error;
            referenceTimeout = true;
          }
        }
        const after=await timed("sql",options);
        if (before && !isDeepStrictEqual(before.data,after.data)) throw new Error(`BENCHMARK_RESULT_MISMATCH_${size}_${i}`);
        if (after.data.total !== size || after.data.rows.length !== 25) throw new Error("BENCHMARK_COUNTS_INVALID");
        const expected = await fixture.client.query<{ id: string }>(`select id from sav.messages order by received_at ${options.sort === "oldest" ? "asc" : "desc"}, id ${options.sort === "oldest" ? "asc" : "desc"} limit 25 offset ${((options.page ?? 1)-1)*25}`);
        if (!isDeepStrictEqual(after.data.rows.map(row=>row.messageId),expected.rows.map(row=>row.id))) throw new Error("BENCHMARK_PAGE_INVALID");
        samples.push({reference:before?.metrics,sql:after.metrics});
      }
      const summarized=Object.fromEntries((["reference","sql"] as const).map(mode=>{
        const values = samples.flatMap(sample=>sample[mode] ? [sample[mode]!] : []);
        return [mode,values.length ? {samples:values.length,p50Ms:quantile(values.map(s=>s.durationMs),.5),p95Ms:quantile(values.map(s=>s.durationMs),.95),maxQueries:Math.max(...values.map(s=>s.queries)),maxSourceRows:Math.max(...values.map(s=>s.sourceRows)),maxRelatedRows:Math.max(...values.map(s=>s.relatedRows)),maxClassifiedRows:Math.max(...values.map(s=>s.classifiedRows)),maxDecryptions:Math.max(...values.map(s=>s.decryptions)),maxCiphertextBytes:Math.max(...values.map(s=>s.ciphertextBytes))} : {samples:0,status:"reference_read_cancelled_or_timed_out",readBudgetMs:10_000}];
      }));
      const concurrent: Metrics[] = [];
      if (size === 10_000) {
        for (let round=0;round<5;round++) {
          // Each read owns an AsyncLocalStorage metrics scope. Suppress logging
          // while timing concurrency; measure elapsed independently of logs.
          const started=performance.now();
          await Promise.all(Array.from({length:3},()=>listSavDossierDashboardSql({pageSize:25})));
          concurrent.push({durationMs:performance.now()-started,queries:0,sourceRows:75,relatedRows:0,classifiedRows:75,decryptions:0,ciphertextBytes:0});
        }
      }
      const storage=await fixture.client.query("select pg_total_relation_size('sav.dashboard_projection')::bigint::text as bytes, pg_indexes_size('sav.dashboard_projection')::bigint::text as index_bytes");
      const plan=await fixture.client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT thread_id FROM sav.dashboard_projection WHERE NOT technical AND state='to_process' AND message_id IS NOT NULL ORDER BY received_at DESC,message_id DESC LIMIT 25");
      const search=querySavDashboardSearch(`synthétique ${size-1}`);
      const searchPlan=await fixture.client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT thread_id FROM sav.dashboard_projection WHERE search_grams @> $1::text[] AND strpos(search_stream,$2)>0 LIMIT 25",[`{${search.grams.join(",")}}`,search.stream]);
      const countPlan=await fixture.client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT count(*) FROM sav.dashboard_projection WHERE NOT technical AND state='to_process' AND message_id IS NOT NULL");
      report.push({size,warmupMs:Math.round(warmupMs),status:await savDashboardProjectionStatus(),referenceTimeout,...summarized,concurrent3:concurrent.length?{rounds:5,readsPerRound:3,p50BatchMs:quantile(concurrent.map(s=>s.durationMs),.5),p95BatchMs:quantile(concurrent.map(s=>s.durationMs),.95),poolMax:4}:null,storage:storage.rows[0],pagePlan:plan.rows,searchPlan:searchPlan.rows,countPlan:countPlan.rows});
      originalInfo(JSON.stringify({progress:size,complete:true,result:report.at(-1)}));
    }
  });
  originalInfo(JSON.stringify({revision:"sav73-benchmark.v1",database:"dedicated-local-PostgreSQL17",node:process.version,concurrency:1,samples:report},null,2));
} finally { console.info=originalInfo; await fixture.client.close(); }
