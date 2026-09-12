import { buildOperationalJourney } from "./operational-journey";
import { curriculumSlug, LIMOVA_CURRICULUM } from "./limova-curriculum";

const STOP_WORDS = new Set([
  "a", "ai", "au", "aux", "avec", "ce", "ces", "comment", "dans", "de", "des", "du", "en",
  "et", "faire", "je", "la", "le", "les", "limova", "ma", "mes", "mon", "pour", "que", "qui",
  "son", "sur", "un", "une",
]);

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr")
    .replace(/[’']/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

function meaningfulTokens(value: string) {
  return [...new Set(normalize(value).split(/\s+/).filter((token) => token.length >= 2 && !STOP_WORDS.has(token)))];
}

function pathsOverlap(knownPath: string, currentPath: string) {
  if (!currentPath) return false;
  const current = currentPath.replace(/\/+$/, "");
  const routePattern = knownPath.replace(/\/\([^/]+\)/g, "").split("/").map((segment) => {
    if (/^\[[^\]]+\]$/.test(segment)) return "[^/]+";
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return new RegExp(`^${routePattern}(?:/|$)`).test(current);
}

export type OperationalCurriculumResult = {
  id: string;
  title: string;
  content: string;
  score: number;
  source: string;
  verifiedAt: null;
};

export function searchOperationalCurriculum(query: string, path = "", limit = 5): OperationalCurriculumResult[] {
  const normalizedQuery = normalize(query);
  const queryTokens = meaningfulTokens(query);
  if (!normalizedQuery || !queryTokens.length) return [];

  return LIMOVA_CURRICULUM.map((entry) => {
    const generated = buildOperationalJourney(entry);
    const normalizedTitle = normalize(entry.title);
    const titleTokens = meaningfulTokens(entry.title);
    const matchedTitleTokens = titleTokens.filter((token) => queryTokens.includes(token)).length;
    const titleCoverage = matchedTitleTokens / Math.max(1, Math.min(queryTokens.length, titleTokens.length));
    const exactPhrase = normalizedQuery.includes(normalizedTitle) || normalizedTitle.includes(normalizedQuery);
    const routeMatch = entry.paths.some((knownPath) => pathsOverlap(knownPath, path));
    const signalTokens = meaningfulTokens(`${entry.group} ${generated.metadata.proposalSignals.join(" ")}`);
    const signalMatches = signalTokens.filter((token) => queryTokens.includes(token)).length;
    const signalCoverage = signalMatches / Math.max(1, queryTokens.length);
    const score = exactPhrase
      ? 0.99
      : Math.min(0.96, 0.24 + titleCoverage * 0.58 + signalCoverage * 0.08 + (routeMatch ? 0.1 : 0));
    return { entry, generated, score, matchedTitleTokens, routeMatch };
  }).filter(({ score, matchedTitleTokens, routeMatch }) => score >= 0.49 && (matchedTitleTokens > 0 || routeMatch))
    .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title, "fr"))
    .slice(0, limit)
    .map(({ entry, generated, score }) => ({
      id: `curriculum:${curriculumSlug(entry.title)}`,
      title: entry.title,
      content: generated.bodyMarkdown,
      score: Number(score.toFixed(4)),
      source: `curriculum/${curriculumSlug(entry.title)}`,
      verifiedAt: null,
    }));
}
