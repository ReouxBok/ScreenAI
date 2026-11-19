import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "@/db/schema";
it("keeps schema declarations and the reserved snapshot consistent without a follow-up DDL diff",async()=>{
  // The LATEST migration's snapshot (the journal's last entry): 0054 (SAV-96) made case_effect_executions.thread_id nullable, so a fixed 0051 went stale. 0055 (SAV-99) changes a check and a trigger only: same tables.
  const journal=JSON.parse(await readFile(new URL("../../../drizzle/meta/_journal.json",import.meta.url),"utf8")) as { entries: { tag: string }[] };
  const latest=journal.entries.at(-1)!.tag.slice(0,4);
  expect(latest).toBe("0055");
  const snapshot=JSON.parse(await readFile(new URL(`../../../drizzle/meta/${latest}_snapshot.json`,import.meta.url),"utf8"));
  // Snapshots are JSON: absent optional fields serialize without undefined.
  // Compare the same representation strictly, then require an empty DDL diff.
  const generated=JSON.parse(JSON.stringify(generateDrizzleJson(schema,snapshot.prevId)));
  expect(generated.tables).toEqual(snapshot.tables);
  expect(await generateMigration(snapshot,generated)).toEqual([]);
});
