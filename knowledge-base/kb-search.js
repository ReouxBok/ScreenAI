/**
 * Knowledge Base search module for the Chrome extension.
 * Multi-signal scoring: TF-IDF keywords + URL matching + title matching + context.
 * No external dependencies.
 *
 * Usage:
 *   import { searchKB } from './knowledge-base/kb-search.js';
 *   const results = searchKB("comment connecter gmail", {
 *     url: "https://new.limova.ai/integrations/gmail",
 *     consoleLogs: ""
 *   });
 */

import { KB_ARTICLES } from './kb-data.js';

// ─── Text normalization ─────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'ou', 'en',
  'a', 'au', 'aux', 'ce', 'ces', 'son', 'sa', 'ses', 'mon', 'ma', 'mes',
  'ton', 'ta', 'tes', 'que', 'qui', 'quoi', 'dont', 'ou', 'sur', 'dans',
  'par', 'pour', 'avec', 'sans', 'sous', 'entre', 'vers', 'chez',
  'est', 'sont', 'etre', 'avoir', 'fait', 'faire', 'peut', 'peux',
  'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'on',
  'ne', 'pas', 'plus', 'tout', 'tous', 'tres', 'bien', 'aussi',
  'comment', 'quand', 'pourquoi', 'this', 'the', 'is', 'are', 'was',
  'an', 'of', 'to', 'in', 'for', 'and', 'or', 'not', 'it',
]);

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ─── Index (built once on first search) ─────────────────────────────────────

let _index = null;

function buildIndex() {
  if (_index) return _index;

  _index = KB_ARTICLES.map((article, i) => {
    const titleWords = normalize(article.title);
    const contentWords = normalize(article.content);

    // Word frequency map (title words count 3x)
    const freq = {};
    for (const w of titleWords) freq[w] = (freq[w] || 0) + 3;
    for (const w of contentWords) freq[w] = (freq[w] || 0) + 1;

    return {
      idx: i,
      title: article.title,
      slug: article.slug,
      url: article.url,
      keywords: article.keywords || [],
      related_urls: article.related_urls || [],
      content: article.content,
      freq,
      titleNorm: titleWords,
      wordCount: contentWords.length,
    };
  });

  return _index;
}

// ─── Scoring signals ────────────────────────────────────────────────────────

const WEIGHTS = {
  tfidf: 0.30,
  urlMatch: 0.35,
  titleMatch: 0.20,
  contextMatch: 0.15,
};

/** TF-IDF keyword score (similar to previous approach) */
function scoreTFIDF(entry, queryWords) {
  let score = 0;
  for (const qw of queryWords) {
    if (entry.freq[qw]) {
      score += entry.freq[qw];
    }
    // Partial/prefix match — lower weight
    for (const [word, count] of Object.entries(entry.freq)) {
      if (word !== qw && (word.startsWith(qw) || qw.startsWith(word))) {
        score += count * 0.3;
      }
    }
  }
  // Normalize by article length
  if (entry.wordCount > 0) {
    score = score / Math.log2(entry.wordCount + 1);
  }
  return score;
}

/** URL-based score: how well the article matches the current page URL */
function scoreURL(entry, currentUrl) {
  if (!currentUrl) return 0;

  // Extract path segments from the current Limova URL
  let path = '';
  try {
    const u = new URL(currentUrl);
    path = u.pathname.toLowerCase();
  } catch {
    // If not a valid URL, try to extract path-like segments
    path = currentUrl.toLowerCase();
  }

  const pathSegments = path.split('/').filter(s => s.length > 1);
  if (pathSegments.length === 0) return 0;

  let score = 0;

  // Check article's related_urls against current URL path
  for (const relUrl of entry.related_urls) {
    const relSegments = relUrl.toLowerCase().split('/').filter(s => s.length > 1);
    for (const seg of relSegments) {
      if (path.includes(seg)) {
        score += 10;
      }
    }
    // Exact path match = big bonus
    if (path.includes(relUrl.toLowerCase())) {
      score += 20;
    }
  }

  // Check slug and keywords against URL path segments
  for (const seg of pathSegments) {
    if (entry.slug && entry.slug.includes(seg)) score += 5;
    for (const kw of entry.keywords) {
      if (kw.includes(seg) || seg.includes(kw)) score += 3;
    }
  }

  return score;
}

/** Title match score: direct word overlap between query and article title */
function scoreTitle(entry, queryWords) {
  let score = 0;
  for (const qw of queryWords) {
    for (const tw of entry.titleNorm) {
      if (tw === qw) {
        score += 10;
      } else if (tw.startsWith(qw) || qw.startsWith(tw)) {
        score += 4;
      }
    }
  }
  return score;
}

/** Context score: boost troubleshooting articles when console errors are present */
function scoreContext(entry, consoleLogs) {
  if (!consoleLogs) return 0;

  const logs = consoleLogs.toLowerCase();
  const hasErrors = logs.includes('error') || logs.includes('erreur') ||
    logs.includes('failed') || logs.includes('exception') ||
    logs.includes('uncaught') || logs.includes('refused');

  if (!hasErrors) return 0;

  // Boost articles that deal with problems/errors
  const troubleshootingSignals = [
    'probleme', 'erreur', 'echec', 'impossible', 'acces', 'refuse',
    'charge', 'affiche', 'genere', 'notification', 'bug', 'fix',
  ];

  let score = 0;
  const text = (entry.slug + ' ' + entry.title + ' ' + entry.keywords.join(' ')).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  for (const signal of troubleshootingSignals) {
    if (text.includes(signal)) score += 3;
  }

  return score;
}

// ─── Search ─────────────────────────────────────────────────────────────────

/**
 * Search the knowledge base using multi-signal scoring.
 * @param {string} query - User query (natural language)
 * @param {object} options
 * @param {string} options.url - Current page URL (for URL-based matching)
 * @param {string} options.consoleLogs - Console logs from the page (for context matching)
 * @param {number} options.maxResults - Max articles to return (default: 5)
 * @param {number} options.maxChars - Max total characters to return (default: 8000)
 * @returns {string} Formatted KB context for the system prompt (full articles + candidate summaries)
 */
export function searchKB(query, { url = '', consoleLogs = '', maxResults = 5, maxChars = 8000 } = {}) {
  if ((!query || query.trim().length < 2) && !url) return '';

  const index = buildIndex();
  const queryWords = normalize(query || '');

  // Score each article with all signals
  const scored = index.map(entry => {
    const tfidf = queryWords.length > 0 ? scoreTFIDF(entry, queryWords) : 0;
    const urlScore = scoreURL(entry, url);
    const titleScore = queryWords.length > 0 ? scoreTitle(entry, queryWords) : 0;
    const contextScore = scoreContext(entry, consoleLogs);

    // Normalize each signal to 0-1 range before weighting
    // (we'll normalize after computing all scores)
    const rawScore = tfidf + urlScore + titleScore + contextScore;

    return { ...entry, rawScore, scores: { tfidf, urlScore, titleScore, contextScore } };
  });

  // Normalize and apply weights
  const maxScores = {
    tfidf: Math.max(1, ...scored.map(s => s.scores.tfidf)),
    urlScore: Math.max(1, ...scored.map(s => s.scores.urlScore)),
    titleScore: Math.max(1, ...scored.map(s => s.scores.titleScore)),
    contextScore: Math.max(1, ...scored.map(s => s.scores.contextScore)),
  };

  for (const entry of scored) {
    entry.score =
      WEIGHTS.tfidf * (entry.scores.tfidf / maxScores.tfidf) +
      WEIGHTS.urlMatch * (entry.scores.urlScore / maxScores.urlScore) +
      WEIGHTS.titleMatch * (entry.scores.titleScore / maxScores.titleScore) +
      WEIGHTS.contextMatch * (entry.scores.contextScore / maxScores.contextScore);
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.filter(a => a.score > 0).slice(0, maxResults);

  if (candidates.length === 0) return '';

  // ── Two-stage output: full articles (top 2-3) + candidate summaries ──

  const FULL_ARTICLE_COUNT = Math.min(3, candidates.length);
  let output = '';

  // Full articles for the top results
  for (let i = 0; i < FULL_ARTICLE_COUNT; i++) {
    const article = candidates[i];
    const section = `### ${article.title}\n${article.content}\n\n---\n\n`;

    if (output.length + section.length > maxChars) {
      const remaining = maxChars - output.length - 100;
      if (remaining > 200) {
        output += `### ${article.title}\n${article.content.slice(0, remaining)}...\n\n---\n\n`;
      }
      break;
    }
    output += section;
  }

  // Candidate summaries for remaining articles (title + first 150 chars)
  if (candidates.length > FULL_ARTICLE_COUNT) {
    output += `### Autres articles potentiellement pertinents\n\n`;
    for (let i = FULL_ARTICLE_COUNT; i < candidates.length; i++) {
      const a = candidates[i];
      const preview = a.content.replace(/\n/g, ' ').slice(0, 150).trim();
      output += `- **${a.title}** : ${preview}...\n`;
    }
    output += '\n---\n\n';
  }

  return output;
}

/**
 * Get a quick summary of what's in the KB (for debugging/info).
 */
export function getKBInfo() {
  const index = buildIndex();
  return {
    totalArticles: index.length,
    sampleKeywords: index.slice(0, 5).map(e => ({ title: e.title, keywords: e.keywords })),
  };
}
