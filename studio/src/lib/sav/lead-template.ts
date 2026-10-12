import { articleMetadataSchema, assertSafeMarkdown } from "../content";
import type { KnowledgeSearchResult } from "../search";
import { cleanSavModelDraft } from "./reply-format";

export function assertSavUnsignedTemplate(template: string) {
  const plainLines = template.split(/\r?\n/).map(line => line.replace(/^[\s*_>#-]+|[\s*_]+$/g, "").trim());
  const normalized = template.normalize("NFKD").replace(/\p{M}/gu, "");
  if (cleanSavModelDraft(template) !== template.trim()
    || plainLines.some(line => /^(?:Charly\b|L['’][ée]quipe Limova\b|Limova team\b)/i.test(line))
    || /(?:preparee? avec une IA|prepared with AI|assistant IA SAV)/i.test(normalized)) throw new Error("SAV_TEMPLATE_MUST_BE_UNSIGNED");
}

/** No model rewrites a reviewed template. Conflicts, stale evidence or missing provenance yield no draft. */
export function selectSavLeadTemplate(results: KnowledgeSearchResult[], now = new Date()) {
  const candidates = results.filter(source => source.resolution?.audience === "lead" && source.score >= 0.5);
  if (candidates.length !== 1) return null;
  const source = candidates[0];
  const parsed = articleMetadataSchema.shape.resolution.unwrap().safeParse(source.resolution);
  if (!parsed.success || !source.id || !source.contentVersionId || !parsed.data.responseTemplate || !parsed.data.steps.length || !parsed.data.symptoms.length) return null;
  const resolution = parsed.data;
  if (resolution.conflictsWith.length || (resolution.validUntil && resolution.validUntil < now.toISOString().slice(0, 10))) return null;
  const verified = source.verifiedAt ? new Date(source.verifiedAt) : null;
  if (!verified || !Number.isFinite(verified.getTime()) || verified > now || now.getTime() - verified.getTime() > 90 * 86_400_000) return null;
  try { assertSafeMarkdown(resolution.responseTemplate!); assertSavUnsignedTemplate(resolution.responseTemplate!); }
  catch { return null; }
  return { source, template: resolution.responseTemplate! };
}
