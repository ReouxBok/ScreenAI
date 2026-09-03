import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { eq } from "drizzle-orm";
import { closeDb, requireDb } from "../src/db/client";
import { contentItems, contentVersions } from "../src/db/schema";
const flag = process.argv.indexOf("--out");
if (flag < 0 || !process.argv[flag+1]) throw new Error("Usage: npm run kb:export -- --out /explicit/output/path");
const output = path.resolve(process.argv[flag+1]);
const db=requireDb();
const rows=await db.select({item:contentItems,version:contentVersions}).from(contentItems).innerJoin(contentVersions,eq(contentItems.currentDraftVersionId,contentVersions.id));
await mkdir(output,{recursive:true});
for(const {item,version} of rows){ const metadata=version.metadata as Record<string,unknown>; const source=(metadata.sourceMetadata as Record<string,unknown>|undefined)??{}; const frontmatter={...source,title:item.title,slug:item.slug}; await writeFile(path.join(output,`${item.slug}.md`),matter.stringify(`${version.bodyMarkdown.trim()}\n`,frontmatter),"utf8"); }
console.log(`Exported ${rows.length} Markdown files to ${output}.`);
await closeDb();
