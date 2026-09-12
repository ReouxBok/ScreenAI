import "server-only";

import { sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { embedTexts } from "./embeddings";
import { knowledgeSearchSchema, learnedActionStepSchema } from "./content";
import type { LearnedActionStep } from "./action-trace";
import { searchOperationalCurriculum } from "./operational-curriculum-search";

export type KnowledgeSearchResult = {
  id: string;
  title: string;
  content: string;
  score: number;
  source: string;
  verifiedAt: string | null;
  actionHints?: LearnedActionStep[];
  resolution?: Record<string, unknown>;
};

// Historical articles predate the structured resolution schema. Keep their
// metadata from turning one malformed date into a failed support search.
const savResolutionIsCurrent = sql`
  version.metadata ? 'resolution'
  AND CASE
    WHEN NULLIF(version.metadata -> 'resolution' ->> 'validUntil', '') IS NULL THEN TRUE
    WHEN version.metadata -> 'resolution' ->> 'validUntil' ~ '^[0-9]{4}-((01|03|05|07|08|10|12)-(0[1-9]|[12][0-9]|3[01])|(04|06|09|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-9]))$'
      THEN version.metadata -> 'resolution' ->> 'validUntil' >= to_char(CURRENT_DATE, 'YYYY-MM-DD')
    ELSE FALSE
  END
`;

export async function searchKnowledge(rawInput: unknown) {
  const input = knowledgeSearchSchema.parse(rawInput);
  const curriculumResults: KnowledgeSearchResult[] = input.scope === "extension"
    && input.locale === "fr-FR"
    && input.contentTypes.includes("onboarding")
    ? searchOperationalCurriculum(input.query, input.path, input.limit)
    : [];
  const db = requireDb();
  const typeFilter = input.contentTypes.length === 2
    ? sql`item.type IN ('article', 'onboarding')`
    : sql`item.type = ${input.contentTypes[0]}::content_type`;
  const availability = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM content_items item
      JOIN content_chunks chunk ON chunk.item_id = item.id AND chunk.version_id = item.published_version_id
      JOIN content_versions version ON version.id = item.published_version_id
      WHERE item.published_version_id IS NOT NULL
        AND item.status <> 'archived'
        AND item.ai_enabled = true
        AND ${input.scope === "sav" ? sql`item.agent_key = 'sav'` : sql`item.agent_key <> 'sav'`}
        AND ${input.scope === "sav" ? savResolutionIsCurrent : sql`TRUE`}
        AND item.locale = ${input.locale}
        AND ${typeFilter}
    ) AS "hasCandidates"
  `);
  const availabilityRows = Array.isArray(availability)
    ? availability
    : (availability as unknown as { rows: Record<string, unknown>[] }).rows;
  if (availabilityRows[0]?.hasCandidates !== true) {
    return {
      revision: curriculumResults.length ? "curriculum_operational_v2" : "kb_empty",
      results: curriculumResults,
    };
  }
  const [embedding] = await embedTexts([input.query], "RETRIEVAL_QUERY", { scope: input.scope });
  const vectorLiteral = `[${embedding.join(",")}]`;

  const response = await db.execute(sql`
    WITH candidates AS (
    SELECT
      item.id,
      item.title,
      chunk.content,
      item.slug AS source,
      item.verified_at AS "verifiedAt",
      version.metadata -> 'actionSteps' AS "actionSteps",
      version.metadata -> 'resolution' AS "resolution",
      (
        (1 - (chunk.embedding <=> ${vectorLiteral}::vector)) * 0.58
        + ts_rank_cd(to_tsvector('french', item.title || ' ' || chunk.heading || ' ' || chunk.content), plainto_tsquery('french', ${input.query})) * 0.30
        + CASE WHEN ${input.path} <> '' AND EXISTS (
            SELECT 1 FROM unnest(chunk.limova_paths) known_path
            WHERE known_path = ${input.path}
              OR known_path LIKE ${input.path} || '/%'
              OR ${input.path} LIKE known_path || '/%'
          ) THEN 0.12 ELSE 0 END
        + CASE WHEN EXISTS (
            SELECT 1 FROM unnest(chunk.intents) intent
            WHERE lower(${input.query}) LIKE '%' || lower(intent) || '%'
          ) THEN 0.04 ELSE 0 END
        + LEAST(0.48, COALESCE((
            SELECT count(DISTINCT title_term)::float * 0.12
            FROM regexp_split_to_table(lower(item.title), '[^[:alnum:]]+') title_term
            WHERE (length(title_term) >= 3 OR title_term = 'ia')
              AND title_term NOT IN ('comment', 'avec', 'pour', 'dans', 'mes', 'mon', 'une', 'des', 'les', 'que', 'quoi', 'sont', 'faire', 'peut', 'peuvent', 'limova')
              AND lower(${input.query}) LIKE '%' || title_term || '%'
          ), 0))
        + LEAST(0.48, COALESCE((
            SELECT count(DISTINCT intent)::float * 0.12
            FROM unnest(chunk.intents) intent
            WHERE length(intent) >= 3
              AND lower(${input.query}) LIKE '%' || lower(intent) || '%'
          ), 0))
      )::float AS score
    FROM content_chunks chunk
    JOIN content_items item ON item.id = chunk.item_id
    JOIN content_versions version ON version.id = item.published_version_id
    WHERE chunk.version_id = item.published_version_id
      AND item.published_version_id IS NOT NULL
      AND item.status <> 'archived'
      AND item.ai_enabled = true
      AND item.locale = ${input.locale}
      AND ${input.scope === "sav" ? sql`item.agent_key = 'sav'` : sql`item.agent_key <> 'sav'`}
      AND ${input.scope === "sav" ? savResolutionIsCurrent : sql`TRUE`}
      AND ${typeFilter}
    ), best_per_content AS (
      SELECT DISTINCT ON (id) id, title, content, source, "verifiedAt", "actionSteps", "resolution", score
      FROM candidates
      ORDER BY id, score DESC
    )
    SELECT id, title, content, source, "verifiedAt", "actionSteps", "resolution", score
    FROM best_per_content
    ORDER BY score DESC
    LIMIT ${input.limit}
  `);

  const responseRows = Array.isArray(response) ? response : (response as unknown as { rows: Record<string, unknown>[] }).rows;
  const results: KnowledgeSearchResult[] = responseRows.map((row: Record<string, unknown>) => {
    const parsedHints = learnedActionStepSchema.array().max(50).safeParse(row.actionSteps);
    return {
      id: String(row.id),
      title: String(row.title),
      content: String(row.content),
      score: Number(Number(row.score).toFixed(4)),
      source: String(row.source),
      verifiedAt: row.verifiedAt ? new Date(String(row.verifiedAt)).toISOString().slice(0, 10) : null,
      ...(parsedHints.success && parsedHints.data.length ? { actionHints: parsedHints.data as LearnedActionStep[] } : {}),
      ...(row.resolution && typeof row.resolution === "object" ? { resolution: row.resolution as Record<string, unknown> } : {}),
    };
  });

  const revisionResponse = await db.execute(sql`SELECT revision_id FROM active_knowledge WHERE singleton = true LIMIT 1`);
  const revisionRows = Array.isArray(revisionResponse) ? revisionResponse : (revisionResponse as unknown as { rows: Record<string, unknown>[] }).rows;
  const revision = String(revisionRows[0]?.revision_id ?? "kb_empty");
  const byTitle = new Map<string, KnowledgeSearchResult>();
  for (const result of [...results, ...curriculumResults]) {
    const key = result.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, result);
      continue;
    }
    // The published Studio version wins because it can contain staff-recorded
    // action hints; keep the strongest retrieval score across both sources.
    if (existing.source.startsWith("curriculum/") && !result.source.startsWith("curriculum/")) {
      byTitle.set(key, {
        ...result,
        content: `${result.content.trim()}\n\n---\n\n${existing.content}`,
        score: Math.max(existing.score, result.score),
      });
    } else if (!existing.source.startsWith("curriculum/") && result.source.startsWith("curriculum/")) {
      byTitle.set(key, {
        ...existing,
        content: `${existing.content.trim()}\n\n---\n\n${result.content}`,
        score: Math.max(existing.score, result.score),
      });
    } else {
      existing.score = Math.max(existing.score, result.score);
    }
  }
  const mergedResults = [...byTitle.values()].sort((left, right) => right.score - left.score).slice(0, input.limit);
  return {
    revision: curriculumResults.length ? `${revision}:curriculum_operational_v2` : revision,
    results: mergedResults,
  };
}
