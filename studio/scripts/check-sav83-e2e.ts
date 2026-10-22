import path from "node:path";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { decryptSavPayload } from "../src/lib/sav/crypto";
import { SAV83_E2E_KEY, SAV83_UNREAD_MESSAGE } from "../test/sav83-e2e-fixture";
const target = path.resolve(".e2e-sav83-db");
if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL !== `pglite://${target}` || process.env.SAV_ENCRYPTION_KEY_V1 !== SAV83_E2E_KEY) throw new Error("SAV83_SYNTHETIC_TARGET_REQUIRED");
// Run only after Playwright has stopped its Next server: PGlite is single-process.
const client = new PGlite(target, { extensions: { vector } });
try {
  const rows = await client.query<{ body_ciphertext: string }>("select body_ciphertext from sav.messages where id=$1", [SAV83_UNREAD_MESSAGE]);
  assert.equal(rows.rows.length, 1);
  assert.equal(decryptSavPayload<{ attachmentRead?: unknown }>(rows.rows[0].body_ciphertext).attachmentRead, undefined);
  console.log("SAV83: opening/reload/prefetch did not create an attachment claim or observation.");
} finally { await client.close(); }
