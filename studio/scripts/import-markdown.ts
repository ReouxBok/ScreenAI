import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { eq } from "drizzle-orm";
import { closeDb, requireDb } from "../src/db/client";
import { categories, contentItems, contentVersions, testCases } from "../src/db/schema";
import { CATEGORIES } from "../src/lib/content";
import { GOLDEN_QUERIES } from "../src/lib/golden-queries";
import { inferAgentKey } from "../src/lib/agents";

const SOURCE = path.resolve(process.cwd(), "../src/knowledge-base/articles");
const ownerEmail = process.env.KNOWLEDGE_IMPORT_OWNER ?? "knowledge@limova.ai";
const db = requireDb();

function categoryFor(slug: string, title: string) {
  const value = `${slug} ${title}`.toLowerCase();
  if (/factur|paiement|abonnement|crédit/.test(value)) return "facturation";
  if (/intégr|gmail|linkedin|whatsapp|outlook|connect/.test(value)) return "integrations";
  if (/sécur|confidential|rgpd|donnée/.test(value)) return "securite-confidentialite";
  if (/équipe|compte|profil|membre/.test(value)) return "compte-equipe";
  if (/erreur|problème|dépann|bloqu/.test(value)) return "depannage";
  if (/agent|charly|elio|tom|john|manue/.test(value)) return "agents";
  if (/campagne|automatis|super.pouvoir/.test(value)) return "super-pouvoirs";
  return "bien-demarrer";
}

await db.insert(categories).values(CATEGORIES.map(([slug,label],position)=>({slug,label,position}))).onConflictDoNothing();
const categoryRows = await db.select().from(categories);
const categoryMap = new Map(categoryRows.map(category => [category.slug, category.id]));
const files = (await readdir(SOURCE)).filter(file => file.endsWith(".md")).sort();
if (files.length !== 106) throw new Error(`Expected 106 Markdown files, found ${files.length}`);

let imported = 0;
for (const file of files) {
  const raw = await readFile(path.join(SOURCE,file),"utf8");
  const parsed = matter(raw);
  const slug = String(parsed.data.slug ?? file.replace(/\.md$/, ""));
  const title = String(parsed.data.title ?? parsed.content.match(/^#\s+(.+)$/m)?.[1] ?? slug);
  const sourceMetadata = JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>;
  const [existing] = await db.select().from(contentItems).where(eq(contentItems.slug,slug)).limit(1);
  if (existing) continue;
  const categorySlug = categoryFor(slug,title);
  const summary = parsed.content.replace(/^#.+$/m,"").replace(/[#*_`]/g,"").trim().slice(0,500);
  const [item] = await db.insert(contentItems).values({ slug, type:"article", locale:"fr-FR", title, summary, categoryId:categoryMap.get(categorySlug), agentKey:inferAgentKey(slug,title), visibility:"charly_only", status:"in_review", ownerEmail, aiEnabled:true, sourcePath:`src/knowledge-base/articles/${file}` }).returning();
  const [version] = await db.insert(contentVersions).values({ itemId:item.id, version:1, bodyMarkdown:parsed.content.trim(), metadata:{ intents:Array.isArray(parsed.data.keywords)?parsed.data.keywords.map(String):[], limovaPaths:Array.isArray(parsed.data.related_urls)?parsed.data.related_urls.map(String):[], prerequisites:[], expectedResult:"", troubleshooting:"", sourceMetadata }, changeNote:"Import initial depuis la base Markdown", authorEmail:ownerEmail }).returning();
  await db.update(contentItems).set({currentDraftVersionId:version.id}).where(eq(contentItems.id,item.id));
  imported += 1;
}
const [existingTest] = await db.select({id:testCases.id}).from(testCases).limit(1);
if (!existingTest) {
  const items=await db.select({id:contentItems.id,slug:contentItems.slug}).from(contentItems);
  const ids=new Map(items.map(item=>[item.slug,item.id]));
  const values=GOLDEN_QUERIES.flatMap(test=>{const expectedItemId=ids.get(test.slug);return expectedItemId?[{query:test.query,path:test.path,locale:"fr-FR",expectedItemId}]:[];});
  if (values.length<30) throw new Error(`Only ${values.length} golden queries matched imported slugs`);
  await db.insert(testCases).values(values);
}
console.log(`Imported ${imported} new articles (${files.length} source files checked).`);
await closeDb();
