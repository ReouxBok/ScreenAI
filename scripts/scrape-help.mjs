#!/usr/bin/env node

/**
 * Scrape le centre d'aide Limova (https://limova.fr/aide) et génère la
 * knowledge base embarquée dans l'extension.
 *
 * Source : sitemap.xml (canonique) — toutes les URLs commençant par /aide/.
 *
 * Usage :
 *   node scripts/scrape-help.mjs
 *
 * Sortie :
 *   src/knowledge-base/kb-data.js          (importé par kb-search.js)
 *   src/knowledge-base/INDEX.md            (index lisible)
 *   src/knowledge-base/articles/<slug>.md  (1 fichier par article)
 */

import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE = 'https://limova.fr';
const SITEMAP = `${BASE}/sitemap.xml`;
const ARTICLE_PATH_PREFIX = '/aide/';
const OUT_DIR = resolve(__dirname, '..', 'src', 'knowledge-base');
const CONCURRENCY = 5;
const DELAY_MS = 200;

// ─── HTTP helper ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml',
          'Accept-Language': 'fr-FR,fr;q=0.9'
        }
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      console.warn(`  ⚠ Tentative ${attempt + 1}/3 échouée pour ${url}: ${err.message}`);
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

// ─── HTML parser (lazy install) ─────────────────────────────────────────────

let parse;
try {
  const mod = await import('node-html-parser');
  parse = mod.parse || mod.default;
} catch {
  console.log('📦 Installation de node-html-parser...');
  const { execSync } = await import('child_process');
  execSync('npm install --no-save node-html-parser', { stdio: 'inherit' });
  const mod = await import('node-html-parser');
  parse = mod.parse || mod.default;
}

// ─── Sitemap discovery ──────────────────────────────────────────────────────

async function discoverArticles() {
  console.log(`🔍 Lecture du sitemap : ${SITEMAP}`);
  const xml = await fetchText(SITEMAP);
  if (!xml) throw new Error('Sitemap inaccessible');

  const urls = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)]
    .map((m) => m[1].trim())
    .filter((u) => {
      const path = u.replace(BASE, '');
      // Garde uniquement /aide/<slug>, exclut la page index /aide
      return path.startsWith(ARTICLE_PATH_PREFIX) && path !== '/aide' && path !== '/aide/';
    })
    .sort();

  console.log(`✅ ${urls.length} articles découverts depuis le sitemap.\n`);
  return urls;
}

// ─── HTML → Markdown ────────────────────────────────────────────────────────

function htmlToMarkdown(node) {
  let md = '';

  function walk(n) {
    if (n.nodeType === 3) {
      md += n.rawText;
      return;
    }
    const tag = (n.tagName || '').toLowerCase();

    if (tag === 'h1') md += '\n# ';
    else if (tag === 'h2') md += '\n\n## ';
    else if (tag === 'h3') md += '\n\n### ';
    else if (tag === 'h4') md += '\n\n#### ';
    else if (tag === 'br') { md += '\n'; return; }
    else if (tag === 'hr') { md += '\n---\n'; return; }
    else if (tag === 'li') md += '\n- ';
    else if (tag === 'p') md += '\n\n';
    else if (tag === 'strong' || tag === 'b') md += '**';
    else if (tag === 'em' || tag === 'i') md += '*';

    for (const child of n.childNodes) walk(child);

    if (tag === 'strong' || tag === 'b') md += '**';
    else if (tag === 'em' || tag === 'i') md += '*';
    else if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') md += '\n';
    else if (tag === 'p') md += '\n';
  }

  walk(node);

  return md
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n /g, '\n')
    .trim();
}

// ─── Article extraction ─────────────────────────────────────────────────────

async function scrapeArticle(url) {
  const html = await fetchText(url);
  if (!html) return null;

  const root = parse(html);

  // Title
  const titleEl = root.querySelector('article h1') || root.querySelector('h1');
  const title = titleEl ? titleEl.textContent.trim() : url.split('/').pop();

  // Body — limova.fr uses <div class="prose ..."> inside <article>
  const article = root.querySelector('article');
  if (!article) {
    console.warn(`  ⚠ Pas d'<article> dans ${url}`);
    return null;
  }

  // Strip non-content elements (related articles aside, breadcrumb nav, etc.)
  for (const sel of ['aside', 'nav', 'header', 'footer', 'script', 'style', 'iframe']) {
    for (const el of article.querySelectorAll(sel)) el.remove();
  }

  const proseEl = article.querySelector('div.prose') ||
                  article.querySelector('[class*="prose"]') ||
                  article;

  const content = htmlToMarkdown(proseEl);

  // Tags (already curated on limova.fr — keep them as keyword hints)
  const tagEls = article.querySelectorAll(
    '.flex.flex-wrap.gap-2 span, [class*="rounded-full"][class*="bg-muted"]'
  );
  const pageTags = [...new Set(tagEls.map((t) => t.textContent.trim().toLowerCase()).filter((t) => t && t.length < 40))];

  // Slug = last URL segment
  const slug = url
    .replace(/\/$/, '')
    .split('/')
    .pop()
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

  return { url, title, slug, content, pageTags };
}

async function scrapeAll(urls) {
  const articles = [];
  let done = 0;

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => {
        await sleep(DELAY_MS);
        return scrapeArticle(url);
      })
    );

    for (const r of results) {
      if (r) articles.push(r);
      done++;
    }
    process.stdout.write(`\r📄 Scrapé ${done}/${urls.length} articles...`);
  }

  console.log(`\n✅ ${articles.length} articles scrapés.\n`);
  return articles;
}

// ─── Keyword extraction ─────────────────────────────────────────────────────

const STOP_WORDS_FR = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'ou', 'en',
  'a', 'au', 'aux', 'ce', 'ces', 'son', 'sa', 'ses', 'mon', 'ma', 'mes',
  'ton', 'ta', 'tes', 'que', 'qui', 'quoi', 'dont', 'sur', 'dans',
  'par', 'pour', 'avec', 'sans', 'sous', 'entre', 'vers', 'chez',
  'est', 'sont', 'etre', 'avoir', 'fait', 'faire', 'peut', 'peux',
  'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'on',
  'ne', 'pas', 'plus', 'tout', 'tous', 'tres', 'bien', 'aussi',
  'comment', 'quand', 'pourquoi', 'cliquez', 'cliquer', 'allez',
  'puis', 'etape', 'votre', 'vos', 'cette', 'page', 'article',
  'the', 'is', 'are', 'was', 'an', 'of', 'to', 'in', 'for', 'and', 'or'
]);

function extractKeywords(title, content, pageTags = [], maxKeywords = 10) {
  // pageTags from limova.fr already filtered — give them priority
  const fromTags = pageTags
    .map((t) => t.replace(/[^a-z0-9]/gi, '').toLowerCase())
    .filter((t) => t.length > 2 && !STOP_WORDS_FR.has(t));

  // Frequency-based fallback to fill up to maxKeywords
  const text = `${title} ${title} ${title} ${content}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');

  const words = text.split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS_FR.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  const fromFreq = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  const out = [];
  const seen = new Set();
  for (const k of [...fromTags, ...fromFreq]) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
    if (out.length >= maxKeywords) break;
  }
  return out;
}

// ─── Limova page URL hints (used by kb-search URL matching) ─────────────────

const LIMOVA_PAGE_PATTERNS = [
  { pattern: /integrations?/i, path: '/integrations' },
  { pattern: /gmail/i, path: '/integrations/gmail' },
  { pattern: /outlook/i, path: '/integrations/outlook' },
  { pattern: /google\s*(calendar|agenda)/i, path: '/integrations/google-calendar' },
  { pattern: /google\s*drive/i, path: '/integrations/google-drive' },
  { pattern: /slack/i, path: '/integrations/slack' },
  { pattern: /whatsapp/i, path: '/integrations/whatsapp' },
  { pattern: /hubspot/i, path: '/integrations/hubspot' },
  { pattern: /shopify/i, path: '/integrations/shopify' },
  { pattern: /wordpress/i, path: '/integrations/wordpress' },
  { pattern: /wix/i, path: '/integrations/wix' },
  { pattern: /notion/i, path: '/integrations/notion' },
  { pattern: /trello/i, path: '/integrations/trello' },
  { pattern: /airtable/i, path: '/integrations/airtable' },
  { pattern: /brevo/i, path: '/integrations/brevo' },
  { pattern: /canva/i, path: '/integrations/canva' },
  { pattern: /youtube/i, path: '/integrations/youtube' },
  { pattern: /calendly/i, path: '/integrations/calendly' },
  { pattern: /dropbox/i, path: '/integrations/dropbox' },
  { pattern: /axonaut/i, path: '/integrations/axonaut' },
  { pattern: /odoo/i, path: '/integrations/odoo' },
  { pattern: /pennylane/i, path: '/integrations/pennylane' },
  { pattern: /facebook/i, path: '/integrations/facebook' },
  { pattern: /linkedin/i, path: '/integrations/linkedin' },
  { pattern: /microsoft\s*(teams|365)/i, path: '/integrations/microsoft' },
  { pattern: /chatgpt|openai/i, path: '/integrations/chatgpt' },
  { pattern: /campagne/i, path: '/campaigns' },
  { pattern: /agent.*(support|standard)/i, path: '/agents' },
  { pattern: /abonnement|facturation|paiement/i, path: '/settings/billing' },
  { pattern: /securite|mot de passe|password/i, path: '/settings/security' },
  { pattern: /param[eè]tres?/i, path: '/settings' },
  { pattern: /tableau de bord|dashboard/i, path: '/dashboard' },
  { pattern: /collaborat|invit|equipe/i, path: '/settings/team' }
];

function extractRelatedUrls(title, content) {
  const text = `${title} ${content}`;
  const urls = new Set();
  for (const { pattern, path } of LIMOVA_PAGE_PATTERNS) {
    if (pattern.test(text)) urls.add(path);
  }
  return [...urls];
}

// ─── Output ─────────────────────────────────────────────────────────────────

function writeKnowledgeBase(articles) {
  mkdirSync(OUT_DIR, { recursive: true });
  const articlesDir = resolve(OUT_DIR, 'articles');
  // Clear stale articles before writing — keeps the folder in sync with kb-data.js
  try { rmSync(articlesDir, { recursive: true, force: true }); } catch (_) {}
  mkdirSync(articlesDir, { recursive: true });

  const enriched = articles.map((a) => ({
    ...a,
    keywords: extractKeywords(a.title, a.content, a.pageTags),
    related_urls: extractRelatedUrls(a.title, a.content)
  }));

  // Per-article markdown
  for (const a of enriched) {
    const frontmatter = [
      '---',
      `title: "${a.title.replace(/"/g, '\\"')}"`,
      `slug: "${a.slug}"`,
      `url: "${a.url}"`,
      `keywords: ${JSON.stringify(a.keywords)}`,
      `related_urls: ${JSON.stringify(a.related_urls)}`,
      '---'
    ].join('\n');

    const fileContent = `${frontmatter}\n\n# ${a.title}\n\n${a.content}\n`;
    writeFileSync(resolve(articlesDir, `${a.slug}.md`), fileContent, 'utf-8');
  }
  console.log(`📝 ${enriched.length} articles individuels écrits dans articles/`);

  // Index
  const indexLines = [
    '# Knowledge Base Limova',
    '',
    `> Source : ${BASE}/aide`,
    `> Dernière mise à jour : ${new Date().toISOString().split('T')[0]}`,
    `> Total : ${enriched.length} articles`,
    '',
    ...enriched.map((a) => `- [${a.title}](articles/${a.slug}.md) — ${a.keywords.slice(0, 5).join(', ')}`),
    ''
  ];
  writeFileSync(resolve(OUT_DIR, 'INDEX.md'), indexLines.join('\n'), 'utf-8');
  console.log('📝 INDEX.md');

  // JS module consumed by the extension
  const jsArticles = enriched.map((a) => ({
    title: a.title,
    slug: a.slug,
    url: a.url,
    keywords: a.keywords,
    related_urls: a.related_urls,
    content: a.content
  }));

  const jsContent = `// Auto-generated by scripts/scrape-help.mjs — ${new Date().toISOString().split('T')[0]}
// ${articles.length} articles from ${BASE}/aide
// DO NOT EDIT MANUALLY — run: node scripts/scrape-help.mjs

export const KB_GENERATED_AT = "${new Date().toISOString()}";
export const KB_ARTICLE_COUNT = ${articles.length};
export const KB_ARTICLES = ${JSON.stringify(jsArticles, null, 2)};
`;

  writeFileSync(resolve(OUT_DIR, 'kb-data.js'), jsContent, 'utf-8');
  console.log(`📝 kb-data.js — ${articles.length} articles`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Scraping du centre d'aide Limova\n");
  console.log(`   Source : ${BASE}/aide`);
  console.log(`   Sortie : ${OUT_DIR}\n`);

  const urls = await discoverArticles();
  if (urls.length === 0) {
    console.error('❌ Aucune URL trouvée dans le sitemap. Vérifie le pattern.');
    process.exit(1);
  }

  const articles = await scrapeAll(urls);
  if (articles.length === 0) {
    console.error('❌ Aucun article scrapé.');
    process.exit(1);
  }

  writeKnowledgeBase(articles);
  console.log(`\n✅ Terminé ! ${articles.length} articles dans ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('❌ Erreur :', err);
  process.exit(1);
});
