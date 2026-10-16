import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, it } from "vitest";

it("applies 0035 to populated 0034 without changing historical candidates or activating intake", async () => {
  const db = new PGlite({ extensions: { vector } });
  try {
    const directory = new URL("../../../drizzle/", import.meta.url);
    for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql") && name < "0035").sort()) {
      for (const statement of (await readFile(new URL(file, directory), "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement);
    }
    await db.exec(`insert into sav.learning_candidates(source_ref,source_content_hash,proposed_patch,explanation,status) values ('hubspot:historical','hash-unchanged','{}','Historical fixture','pending'),('hubspot:rejected','refused-hash','{}','Rejected fixture','rejected')`);
    const before = await db.query("select id,source_ref,source_content_hash,proposed_patch,explanation,status,created_at from sav.learning_candidates order by id");
    for (const statement of (await readFile(new URL("0035_sav_learning_admission.sql", directory), "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement);
    expect((await db.query("select id,source_ref,source_content_hash,proposed_patch,explanation,status,created_at from sav.learning_candidates order by id")).rows).toEqual(before.rows);
    expect((await db.query("select * from sav.learning_admission_attempts")).rows).toHaveLength(0);
    expect((await db.query("select * from sav.sync_state where key='sav-learning-admission-cutover'")).rows).toHaveLength(0);
  } finally { await db.close(); }
}, 30000);
