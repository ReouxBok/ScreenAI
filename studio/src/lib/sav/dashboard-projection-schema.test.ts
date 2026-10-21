import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "@/db/schema";
it("keeps schema declarations and the reserved snapshot consistent without a follow-up DDL diff",async()=>{
  const snapshot=JSON.parse(await readFile(new URL("../../../drizzle/meta/0043_snapshot.json",import.meta.url),"utf8"));
  // Snapshots are JSON: absent optional fields serialize without undefined.
  // Compare the same representation strictly, then require an empty DDL diff.
  const generated=JSON.parse(JSON.stringify(generateDrizzleJson(schema,snapshot.prevId)));
  expect(generated.tables).toEqual(snapshot.tables);
  expect(await generateMigration(snapshot,generated)).toEqual([]);
});
