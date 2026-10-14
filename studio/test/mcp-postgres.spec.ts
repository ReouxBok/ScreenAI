import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:https";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, inArray } from "drizzle-orm";
import { POST } from "@/app/api/mcp/route";
import { closeDb, requireDb } from "@/db";
import * as schema from "@/db/schema";
import { deterministicEmbedding } from "@/lib/embeddings";

const databaseUrl = process.env.STUDIO_MCP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("STUDIO_MCP_TEST_DATABASE_URL must name an isolated local test database");
const database = new URL(databaseUrl);
if (!["127.0.0.1", "localhost"].includes(database.hostname) || database.pathname !== "/extension_mcp_test") {
  throw new Error("Only a local extension_mcp_test database is allowed");
}
const token = randomUUID() + randomUUID();
const actor = "mcp-fixture@example.test";
const query = "connecter gmail";
const revision = `mcp-test-${randomUUID()}`;
const itemIds: string[] = [];
const templateIds = [randomUUID(), randomUUID()];
let server: Server | undefined;
let client: Client | undefined;
let sql: ReturnType<typeof postgres> | undefined;
let origin = "";
let publishedId = "";

async function seedItem(label: string, options: { published?: boolean; enabled?: boolean; sav?: boolean; archived?: boolean } = {}) {
  const db = requireDb();
  const id = randomUUID(), versionId = randomUUID(), draftId = randomUUID();
  itemIds.push(id);
  await db.insert(schema.contentItems).values({ id, slug: id, type: "onboarding", title: `${query} ${label}`,
    ownerEmail: actor, agentKey: options.sav ? "sav" : "common", aiEnabled: options.enabled !== false,
    status: options.archived ? "archived" : options.published === false ? "draft" : "published",
    publishedVersionId: options.published === false ? null : versionId, currentDraftVersionId: draftId });
  const metadata = { intents: [query], limovaPaths: [], prerequisites: [], expectedResult: "Gmail connecté", troubleshooting: "" };
  await db.insert(schema.contentVersions).values([
    { id: versionId, itemId: id, version: 1, bodyMarkdown: label, metadata, changeNote: "fixture published", authorEmail: actor },
    { id: draftId, itemId: id, version: 2, bodyMarkdown: `PRIVATE_DRAFT_${label}`, metadata, changeNote: "fixture draft", authorEmail: actor },
  ]);
  await db.insert(schema.contentChunks).values([versionId, draftId].map((version, index) => ({
    itemId: id, versionId: version, ordinal: 0, content: index ? `PRIVATE_DRAFT_${label}` : label,
    embedding: deterministicEmbedding(query), intents: [query],
  })));
  return id;
}

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("STUDIO_SERVICE_TOKEN", token);
  for (const name of ["EXTENSION_GEMINI_API_KEY", "GEMINI_API_KEY", "KNOWLEDGE_GEMINI_API_KEY", "SAV_GEMINI_API_KEY"]) vi.stubEnv(name, "");
  sql = postgres(databaseUrl, { max: 1, prepare: false });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  const db = requireDb();
  expect(await db.select({ id: schema.contentItems.id }).from(schema.contentItems)).toEqual([]);
  publishedId = await seedItem("PUBLIC_GUIDANCE");
  await seedItem("PRIVATE_SAV", { sav: true });
  await seedItem("PRIVATE_DISABLED", { enabled: false });
  await seedItem("PRIVATE_ARCHIVED", { archived: true });
  await seedItem("PRIVATE_UNPUBLISHED", { published: false });
  await db.insert(schema.knowledgeRevisions).values({ id: revision, actorEmail: actor });
  await db.insert(schema.activeKnowledge).values({ singleton: true, revisionId: revision });
  const definition = { name: "Published journey", openingPrompt: "Choisir le sujet à traiter ensemble.",
    fallbackPrompt: "Adapter le parcours au besoin de la personne.", nodes: itemIds.map((contentItemId, index) => ({
      id: `step-${index}`, contentItemId, depth: 0 as const, trigger: "À la demande du membre", optional: false,
    })) };
  await db.insert(schema.onboardingTemplateVersions).values([
    { id: templateIds[0], version: 1, definition, changeNote: "published", authorEmail: actor },
    { id: templateIds[1], version: 2, definition: { ...definition, openingPrompt: "PRIVATE_TEMPLATE_DRAFT" }, changeNote: "draft", authorEmail: actor },
  ]);
  await db.insert(schema.activeOnboardingTemplate).values({ singleton: true, publishedVersionId: templateIds[0], draftVersionId: templateIds[1] });
  const keyPath = process.env.STUDIO_MCP_TEST_TLS_KEY;
  const certPath = process.env.STUDIO_MCP_TEST_TLS_CERT;
  if (!keyPath || !certPath) throw new Error("Run through npm run test:mcp:postgres for the temporary trusted TLS certificate");
  server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (incoming, outgoing) => {
    const handle = async () => {
      if (incoming.method !== "POST") { outgoing.writeHead(405).end(); return; }
      let body = "";
      for await (const chunk of incoming) body += chunk.toString();
      const headers = new Headers();
      Object.entries(incoming.headers).forEach(([name, value]) => { if (typeof value === "string") headers.set(name, value); });
      const response = await POST(new Request(`${origin}/api/mcp`, { method: "POST", headers, body }));
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.writeHead(response.status).end(await response.text());
    };
    void handle().catch(() => outgoing.writeHead(500).end());
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP port");
  origin = `https://127.0.0.1:${address.port}`;
  client = new Client({ name: "postgres-mcp-qualification", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
});

afterAll(async () => {
  await client?.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  if (itemIds.length) {
    const db = requireDb();
    await db.delete(schema.activeOnboardingTemplate).where(inArray(schema.activeOnboardingTemplate.publishedVersionId, templateIds));
    await db.delete(schema.onboardingTemplateVersions).where(inArray(schema.onboardingTemplateVersions.id, templateIds));
    await db.delete(schema.activeKnowledge).where(eq(schema.activeKnowledge.revisionId, revision));
    await db.delete(schema.knowledgeRevisions).where(eq(schema.knowledgeRevisions.id, revision));
    await db.delete(schema.contentItems).where(inArray(schema.contentItems.id, itemIds));
  }
  await closeDb();
  await sql?.end();
  vi.unstubAllEnvs();
});

describe.sequential("Studio MCP with migrated PostgreSQL and real content services", () => {
  it("returns only published enabled extension content in search and guidance", async () => {
    expect((await client!.listTools()).tools.map(tool => tool.name)).toEqual(["search_knowledge", "get_onboarding_guidance"]);
    for (const [name, args] of [["search_knowledge", { query }], ["get_onboarding_guidance", {}]] as const) {
      const result = await client!.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("PUBLIC_GUIDANCE");
      expect(text).not.toContain("PRIVATE_");
      expect(text).toContain(name === "search_knowledge" ? revision : "onboarding_v1");
    }
  });

  it("rejects browser origins, missing credentials and model-selected private scopes", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await fetch(`${origin}/api/mcp`, { method: "POST", body })).status).toBe(401);
    expect((await fetch(`${origin}/api/mcp`, { method: "POST", body, headers: {
      authorization: `Bearer ${token}`, origin: "https://untrusted.example.test",
    } })).status).toBe(403);
    for (const [name, args] of [["search_knowledge", { query, scope: "sav" }],
      ["get_onboarding_guidance", { draftId: templateIds[1] }]] as const) {
      const result = await client!.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).not.toContain("PRIVATE_");
    }
  });

  it("stops returning a published item as soon as AI access is disabled", async () => {
    await requireDb().update(schema.contentItems).set({ aiEnabled: false }).where(eq(schema.contentItems.id, publishedId));
    for (const [name, args] of [["search_knowledge", { query }], ["get_onboarding_guidance", {}]] as const) {
      const result = await client!.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).not.toMatch(/PUBLIC_GUIDANCE|PRIVATE_/);
    }
  });
});
