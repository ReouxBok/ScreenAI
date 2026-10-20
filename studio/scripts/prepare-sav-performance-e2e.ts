/** Same synthetic volume for reference/SQL browser timing; never operational data. */
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/db/schema";
import { withStudioDatabase, type requireDb } from "../src/db";
import { encryptSavPayload } from "../src/lib/sav/crypto";
import { refreshSavDashboardProjection } from "../src/lib/sav/dashboard-projection";
import { SAV53_E2E_KEY } from "../test/sav53-e2e-fixture";
const target = path.resolve(process.env.STUDIO_E2E_DB_DIR ?? "");
if (process.env.NODE_ENV === "production" || !/^\.e2e-sav-performance-(reference|sql)-db$/.test(path.basename(target))
  || process.env.DATABASE_URL !== `pglite://${target}` || process.env.SAV_ENCRYPTION_KEY_V1 !== SAV53_E2E_KEY
  || process.env.SAV_WRITES_DISABLED !== "true") throw new Error("LOCAL_SYNTHETIC_PERFORMANCE_REQUIRED");
const client = new PGlite(`file://${target}`, { extensions: { vector } });
try {
  await client.exec(`INSERT INTO sav.threads(id,mailbox_id,gmail_thread_id,subject,customer_email)
    SELECT ('00000073-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid, (SELECT id FROM sav.mailboxes WHERE email='contact@limova.ai'), 'synthetic-performance-'||i,'Performance synthétique '||i,'performance-'||i||'@example.invalid' FROM generate_series(1,1000) i`);
  await client.query(`INSERT INTO sav.messages(id,thread_id,mailbox_id,gmail_message_id,direction,from_email,subject,body_ciphertext,received_at)
    SELECT replace(id::text,'-8000-','-9000-')::uuid,id,mailbox_id,gmail_thread_id,'inbound',customer_email,subject,$1,
      '2026-10-04'::timestamptz + right(id::text,12)::int * interval '1 second' FROM sav.threads WHERE gmail_thread_id LIKE 'synthetic-performance-%'`,
    [encryptSavPayload({ text: "Question synthétique de performance sans données réelles. ".repeat(20) })]);
  // Activation needs a warm projection; measure its preparation separately.
  const started = performance.now();
  await withStudioDatabase(drizzle(client, { schema }) as unknown as ReturnType<typeof requireDb>, async () => {
    while ((await refreshSavDashboardProjection(100)).refreshed) { /* same prepared database in both modes */ }
  });
  console.log(JSON.stringify({ syntheticThreads: 1000, projectionPreparationMs: performance.now() - started }));
} finally { await client.close(); }
