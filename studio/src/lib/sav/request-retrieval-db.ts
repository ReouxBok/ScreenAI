import "server-only";
import { sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { embedTexts } from "@/lib/embeddings";
import { retrieveSavKnowledgeByRequest, savRetrievalTokens, SAV_RETRIEVAL_LIMITS, type SavRetrievalBackend, type SavRetrievalCandidate } from "./request-retrieval";

function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows;
}

/** SAV-only adapter. The installed extension's search API and ranking stay separate. */
export function createSavRequestRetrievalBackend(options: { locale?: string; audience?: "support" | "lead"; now?: Date } = {}): SavRetrievalBackend {
  const locale = options.locale ?? "fr-FR", audience = options.audience ?? "support", now = options.now ?? new Date();
  const db = requireDb();
  return {
    async readRevision() {
      const rows = rowsOf(await db.execute(sql`SELECT revision_id FROM active_knowledge WHERE singleton = true LIMIT 1`));
      return String(rows[0]?.revision_id ?? "kb_empty");
    },
    async search(queries, limit) {
      if (queries.length > SAV_RETRIEVAL_LIMITS.queriesPerAttempt || !Number.isInteger(limit) || limit < 1 || limit > SAV_RETRIEVAL_LIMITS.candidatesPerQuery) throw new Error("SAV_RETRIEVAL_DB_BUDGET");
      if (!queries.length) return [];
      const availability = rowsOf(await db.execute(sql`SELECT EXISTS (
        SELECT 1 FROM content_items item
        JOIN sav_knowledge_activations activation ON activation.item_id = item.id
        JOIN content_chunks chunk ON chunk.item_id = item.id AND chunk.version_id = activation.version_id
        WHERE item.agent_key = 'sav' AND item.slug <> 'sav-master-playbook' AND item.type = 'article' AND item.status <> 'archived'
          AND item.ai_enabled = true AND item.published_version_id IS NOT NULL AND item.locale = ${locale}
      ) AS available`));
      if (availability[0]?.available !== true) return queries.map(() => []);
      // One embedding batch for at most three independent requests.
      const embeddings = await embedTexts([...queries], "RETRIEVAL_QUERY", { scope: "sav" });
      if (embeddings.length !== queries.length || embeddings.some(vector => vector.length !== 768 || vector.some(value => !Number.isFinite(value)))) throw new Error("SAV_RETRIEVAL_EMBEDDING_INVALID");
      return Promise.all(queries.map(async (query, index) => {
        const vector = `[${embeddings[index].join(",")}]`;
        const terms = savRetrievalTokens(query).slice(0, 40);
        const fullTextQuery = terms.map(term => `"${term}"`).join(" OR ");
        const half = Math.ceil(limit / 2);
        const resolution = sql`((version.metadata -> 'resolution') || jsonb_build_object(
          'prerequisites', COALESCE(version.metadata -> 'prerequisites', '[]'::jsonb),
          'expectedResult', COALESCE(version.metadata ->> 'expectedResult', ''),
          'troubleshooting', COALESCE(version.metadata ->> 'troubleshooting', '')
        ))`;
        // Publishing another version must not renew the active version's proof.
        const verification = sql`CASE WHEN item.verified_at IS NULL THEN NULL ELSE
          COALESCE(version_review.verified_at, CASE
            WHEN item.published_version_id = activation.version_id THEN LEAST(item.verified_at, activation.activated_at)
            ELSE LEAST(item.verified_at, activation.activated_at, version.created_at)
          END) END`;
        const response = await db.execute(sql`
          WITH scored AS (
            SELECT item.id, version.id AS "contentVersionId", activation.title AS title, item.slug AS source,
              CASE WHEN octet_length(version.body_markdown) <= ${SAV_RETRIEVAL_LIMITS.sourceBytes} THEN version.body_markdown ELSE '' END AS content,
              ${verification} AS "verifiedAt", item.locale,
              CASE WHEN octet_length(${resolution}::text) <= ${SAV_RETRIEVAL_LIMITS.sourceBytes} THEN ${resolution} ELSE NULL END AS resolution,
              (octet_length(version.body_markdown) > ${SAV_RETRIEVAL_LIMITS.sourceBytes} OR octet_length(COALESCE(${resolution}::text, '')) > ${SAV_RETRIEVAL_LIMITS.sourceBytes}) AS "sourceTooLarge",
              COALESCE(version.metadata -> 'resolution' ->> 'audience', 'support') AS audience,
              (1 - (chunk.embedding <=> ${vector}::vector))::float AS "semanticScore",
              ts_rank_cd(to_tsvector('french', activation.title || ' ' || chunk.heading || ' ' || chunk.content), websearch_to_tsquery('french', ${fullTextQuery}))::float AS lexical
            FROM content_items item
            JOIN sav_knowledge_activations activation ON activation.item_id = item.id
            JOIN content_versions version ON version.id = activation.version_id AND version.item_id = item.id
            LEFT JOIN LATERAL (
              SELECT max(event.created_at) AS verified_at FROM review_events event
              WHERE event.version_id = version.id AND event.item_id = item.id
                AND event.action IN ('approved', 'emergency_published')
            ) version_review ON TRUE
            JOIN content_chunks chunk ON chunk.item_id = item.id AND chunk.version_id = activation.version_id
            WHERE item.agent_key = 'sav' AND item.slug <> 'sav-master-playbook' AND item.type = 'article' AND item.status <> 'archived'
              AND item.ai_enabled = true AND item.published_version_id IS NOT NULL AND item.locale = ${locale}
              AND COALESCE(version.metadata -> 'resolution' ->> 'audience', 'support') = ${audience}
              AND ${verification} >= ${new Date(now.getTime() - 90 * 86_400_000).toISOString()}::timestamptz
              AND ${verification} <= ${now.toISOString()}::timestamptz
              AND item.verified_at <= ${now.toISOString()}::timestamptz
          ), cards AS (
            SELECT DISTINCT ON (id) * FROM scored ORDER BY id, "semanticScore" DESC NULLS LAST, lexical DESC
          ), semantic AS (
            SELECT * FROM cards ORDER BY "semanticScore" DESC NULLS LAST, id LIMIT ${half}
          ), lexical AS (
            SELECT * FROM cards WHERE lexical > 0 ORDER BY lexical DESC, id LIMIT ${half}
          )
          SELECT * FROM semantic UNION SELECT * FROM lexical LIMIT ${limit}
        `);
        return rowsOf(response).map((row): SavRetrievalCandidate => ({
          id: String(row.id), contentVersionId: String(row.contentVersionId), title: String(row.title), source: String(row.source), content: String(row.content),
          verifiedAt: row.verifiedAt ? new Date(String(row.verifiedAt)).toISOString() : null,
          semanticScore: row.semanticScore !== null && row.semanticScore !== undefined && Number.isFinite(Number(row.semanticScore)) ? Number(row.semanticScore) : null,
          resolution: row.resolution && typeof row.resolution === "object" ? row.resolution as SavRetrievalCandidate["resolution"] : null,
          sourceTooLarge: row.sourceTooLarge === true,
          availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: String(row.locale), audience: String(row.audience) },
        }));
      }));
    },
  };
}

export async function searchSavKnowledgeByRequest(input: Parameters<typeof retrieveSavKnowledgeByRequest>[0]) {
  return retrieveSavKnowledgeByRequest(input, createSavRequestRetrievalBackend(input));
}
