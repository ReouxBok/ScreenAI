/** Explicit opt-in only. Unknown values keep the legacy prompt. */
export const casePromptCompactOn = (env: Readonly<Record<string, string | undefined>>) => env.SAV_V2_PROMPT_COMPACT?.trim() === "on";

/**
 * Target the operational sections without guessing what an unfamiliar section means.
 * Only exact repetitions already present in structured resolution are omitted from
 * prose. Unknown sections, exceptions and warnings remain in full, even past 6000
 * characters. No keyword-based summarisation can silently erase a qualification.
 * The existing reversible transport codec handles sharing across distinct sources.
 */
export function compactCaseKnowledgeContent(content: string, resolution: unknown): string {
  const fields: Record<string, string> = {
    "étape": "steps", "étapes": "steps", step: "steps", steps: "steps", "procédure": "steps",
    exception: "exceptions", exceptions: "exceptions", avertissement: "warnings", avertissements: "warnings",
    warning: "warnings", warnings: "warnings", source: "sources", sources: "sources", version: "productVersion", versions: "productVersion",
  };
  const metadata = resolution && typeof resolution === "object" ? resolution as Record<string, unknown> : {};
  // Sections are never cut midway. Only recognised sections can be deduplicated;
  // a heading itself may carry a warning, so keep it when any prose remains.
  const sections = content.split(/(?=^#{1,6}\s)/m);
  return sections.map(section => {
    const match = /^(#{1,6}\s+([^\n]+)\n)([\s\S]*)$/.exec(section);
    if (!match) return section;
    const key = fields[match[2].trim().toLowerCase()];
    if (!Object.hasOwn(fields, match[2].trim().toLowerCase()) || !Object.hasOwn(metadata, key)) return section;
    const value = metadata[key];
    const literals = new Set((Array.isArray(value) ? value : [value]).filter((row): row is string => typeof row === "string").map(row => row.trim()));
    const paragraphs = match[3].split(/\n\s*\n/);
    const kept = paragraphs.filter(paragraph => !literals.has(paragraph.trim()));
    return kept.some(paragraph => paragraph.trim()) ? match[1] + kept.join("\n\n") : "";
  }).join("");
}

/** Whole passages, never rewritten. Operational sections and qualifications are mandatory;
 * if those alone exceed the envelope, refuse selection rather than lose a condition.
 * Query terms rank optional prose only, with source order as the stable tie-breaker.
 */
export function selectCaseKnowledgePassages(content: string, resolution: unknown, query: string, maxBytes: number): string | null {
  const compact = compactCaseKnowledgeContent(content, resolution);
  const size = (text: string) => new TextEncoder().encode(text).length;
  if (size(compact) <= maxBytes) return compact;
  const tokens = (text: string) => new Set(text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const terms = tokens(query);
  const operational = /(?:étapes?|steps?|procédure|prérequis|prerequisites?|exceptions?|avertissements?|warnings?|versions?|sources?|résolution|resolution|dépannage|troubleshooting|escalad|conditions?|limitations?|sécurité|security)/iu;
  const optionalHeading = /^(?:présentation|introduction|contexte|historique|description|exemples?|background|overview|examples?)\b/iu;
  const qualification = /(?:exception|attention|avertissement|warning|\bne\b|\bpas\b|\bnot\b|\bnever\b|sauf|except|uniquement|only|prérequis|prerequisite|version|avant|before|interdit|unless|si |if )/iu;
  const passages = compact.split(/(?=^#{1,6}\s)/m).flatMap(section => {
    const match = /^(#{1,6}\s+([^\n]+)\n)([\s\S]*)$/.exec(section);
    // Unfamiliar or unheaded prose may carry a condition we cannot classify.
    // Only explicitly descriptive sections are candidates for omission.
    if (!match || operational.test(match[2]) || !optionalHeading.test(match[2])) return [{ text: section, mandatory: true }];
    const heading = match[1], body = match[3];
    return body.split(/\n\s*\n/).filter(text => text.trim()).map(text => ({ text: heading + text, mandatory: qualification.test(heading + text) }));
  }).map((row, index) => ({ ...row, index, bytes: size(row.text), score: [...tokens(row.text)].filter(term => terms.has(term)).length }));
  const selected = new Set(passages.filter(row => row.mandatory).map(row => row.index));
  const render = () => passages.filter(row => selected.has(row.index)).map(row => row.text).join("\n\n");
  let used = passages.filter(row => row.mandatory).reduce((sum, row) => sum + row.bytes, 0) + Math.max(0, selected.size - 1) * 2;
  if (used > maxBytes) return null;
  for (const row of passages.filter(row => !row.mandatory).sort((a, b) => b.score - a.score || a.index - b.index)) {
    const added = row.bytes + (selected.size ? 2 : 0);
    if (used + added <= maxBytes) { selected.add(row.index); used += added; }
  }
  const result = render();
  // An empty excerpt must never turn unread knowledge into an eligible source.
  return result.trim() ? result : null;
}
