import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, it } from "vitest";

it("backfills only SAV versions already active and preserves historical opening uncertainty", async () => {
  const db = new PGlite({ extensions: { vector } });
  try {
    const dir = new URL("../../../drizzle/", import.meta.url);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files.filter((name) => name < "0034")) {
      for (const statement of (await readFile(new URL(file, dir), "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement);
    }
    await db.exec(`
      INSERT INTO content_items(id,slug,type,title,owner_email,agent_key,ai_enabled,status) VALUES
       ('10000000-0000-4000-8000-000000000001','sav-active','article','Fiche active','test@example.invalid','sav',true,'published'),
       ('10000000-0000-4000-8000-000000000002','sav-disabled','article','Fiche désactivée','test@example.invalid','sav',false,'published'),
       ('10000000-0000-4000-8000-000000000003','chrome-active','article','Fiche Chrome','test@example.invalid','charly',true,'published');
      INSERT INTO content_versions(id,item_id,version,body_markdown,metadata,change_note,author_email) SELECT
       ('20000000-0000-4000-8000-' || right(id::text,12))::uuid,id,1,'Preuve fictive','{}'::jsonb,'Test migration','test@example.invalid' FROM content_items;
      UPDATE content_items SET published_version_id=('20000000-0000-4000-8000-' || right(id::text,12))::uuid;
    `);
    for (const statement of (await readFile(new URL("0034_sav_knowledge_workspace.sql", dir), "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement);
    const rows = (await db.query<{ item_id: string; title: string }>("SELECT item_id,title FROM sav_knowledge_activations")).rows;
    expect(rows).toEqual([{ item_id: "10000000-0000-4000-8000-000000000001", title: "Fiche active" }]);
    expect((await db.query("SELECT id FROM content_items WHERE ai_enabled=true")).rows).toHaveLength(2);
    const columns = (await db.query<{ column_name: string; column_default: string | null }>("SELECT column_name,column_default FROM information_schema.columns WHERE table_schema='sav' AND table_name='messages' AND column_name LIKE 'studio_%'")).rows;
    expect(columns).toEqual(expect.arrayContaining([{ column_name: "studio_opened_at", column_default: null }, { column_name: "studio_opening_tracked", column_default: "true" }]));
  } finally { await db.close(); }
}, 30_000);
