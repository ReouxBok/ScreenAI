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
