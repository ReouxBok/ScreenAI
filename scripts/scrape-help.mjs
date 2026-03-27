#!/usr/bin/env node

/**
 * Scrape le portail d'aide Limova (ProductFruits) et génère la knowledge base.
 *
 * Usage :
 *   node scripts/scrape-help.mjs
 *
 * Dépendances (installées automatiquement si absentes) :
 *   npm i node-html-parser
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = "https://7dz0vo1hbc1iawf.productfruits.help";
const LANG = "fr";
const OUT_DIR = resolve(__dirname, "..", "knowledge-base");
const CONCURRENCY = 5;
const DELAY_MS = 300; // politesse entre les requêtes

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHTML(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "fr-FR,fr;q=0.9",
        },
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

// ─── Parsing HTML → texte ───────────────────────────────────────────────────

let parse;
try {
  const mod = await import("node-html-parser");
  parse = mod.parse || mod.default;
} catch {
  console.log("📦 Installation de node-html-parser...");
  const { execSync } = await import("child_process");
  execSync("npm install --no-save node-html-parser", { stdio: "inherit" });
  const mod = await import("node-html-parser");
  parse = mod.parse || mod.default;
}

function htmlToMarkdown(html) {
  const root = parse(html);

  // Cherche le contenu principal de l'article
  const article =
    root.querySelector("article") ||
    root.querySelector('[class*="article"]') ||
    root.querySelector('[class*="content"]') ||
    root.querySelector("main") ||
    root;

  // Supprime les éléments non pertinents
  for (const sel of ["nav", "header", "footer", '[class*="sidebar"]', '[class*="nav"]', "script", "style", "iframe"]) {
    for (const el of article.querySelectorAll(sel)) el.remove();
  }

  let md = "";

  function walk(node) {
    if (node.nodeType === 3) {
      // text node
      md += node.rawText;
      return;
    }
    const tag = (node.tagName || "").toLowerCase();

    if (tag === "h1") md += "\n# ";
    else if (tag === "h2") md += "\n## ";
    else if (tag === "h3") md += "\n### ";
    else if (tag === "h4") md += "\n#### ";
    else if (tag === "br") {
      md += "\n";
      return;
    } else if (tag === "hr") {
      md += "\n---\n";
      return;
    } else if (tag === "li") md += "\n- ";
    else if (tag === "p") md += "\n\n";
    else if (tag === "strong" || tag === "b") md += "**";
    else if (tag === "em" || tag === "i") md += "*";

    for (const child of node.childNodes) walk(child);

    if (tag === "strong" || tag === "b") md += "**";
    else if (tag === "em" || tag === "i") md += "*";
    else if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") md += "\n";
    else if (tag === "p") md += "\n";
  }

  walk(article);

  // Nettoyage
  return md
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .trim();
}

// ─── Découverte de tous les articles ────────────────────────────────────────

async function discoverArticles() {
  console.log("🔍 Découverte des articles depuis la page d'accueil...");
  const html = await fetchHTML(`${BASE}/${LANG}`);
  if (!html) throw new Error("Impossible de charger la page d'accueil");

  const root = parse(html);
  const links = new Set();

  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href") || "";
    if (href.includes("/article/")) {
      const full = href.startsWith("http") ? href : `${BASE}${href}`;
      links.add(full);
    }
  }

  console.log(`   Trouvé ${links.size} articles sur la page d'accueil.`);

  // Scrape aussi chaque article pour trouver des liens croisés
  const toExplore = [...links];
  const explored = new Set();
  let wave = 0;

  while (toExplore.length > 0) {
    wave++;
    const batch = toExplore.splice(0, CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => {
        if (explored.has(url)) return [];
        explored.add(url);
        await sleep(DELAY_MS);
        const h = await fetchHTML(url);
        if (!h) return [];
        const r = parse(h);
        const found = [];
        for (const a of r.querySelectorAll("a")) {
          const href = a.getAttribute("href") || "";
          if (href.includes("/article/")) {
            const full = href.startsWith("http") ? href : `${BASE}${href}`;
            if (!links.has(full)) {
              links.add(full);
              found.push(full);
            }
          }
        }
        return found;
      })
    );

    const newLinks = results.flat();
    toExplore.push(...newLinks);

    if (wave % 5 === 0 || newLinks.length > 0) {
      console.log(`   Vague ${wave} : ${links.size} articles trouvés au total (+${newLinks.length} nouveaux)`);
    }
  }

  console.log(`✅ ${links.size} articles découverts au total.\n`);
  return [...links].sort();
}

// ─── Scraping de chaque article ─────────────────────────────────────────────

async function scrapeArticle(url) {
  const html = await fetchHTML(url);
  if (!html) return null;

  const root = parse(html);

  // Titre
  const titleEl = root.querySelector("h1") || root.querySelector("title");
  const title = titleEl ? titleEl.textContent.trim() : url.split("/").pop();

  // Contenu markdown
  const content = htmlToMarkdown(html);

  // Slug pour le nom de fichier
  const slug = url
    .split("/article/")[1]
    ?.replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return { url, title, slug, content };
}

async function scrapeAll(urls) {
  const articles = [];
  let done = 0;

  // Traitement par lots
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

  console.log(`\n✅ ${articles.length} articles scrapés avec succès.\n`);
  return articles;
}

// ─── Extraction de mots-clés ────────────────────────────────────────────────

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
  'the', 'is', 'are', 'was', 'an', 'of', 'to', 'in', 'for', 'and', 'or',
]);

function extractKeywords(title, content, maxKeywords = 10) {
  const text = (title + ' ' + title + ' ' + title + ' ' + content) // titre 3x pour plus de poids
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');

  const words = text.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS_FR.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

// ─── Extraction de chemins URL Limova liés ──────────────────────────────────

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
  { pattern: /collaborat|invit|equipe/i, path: '/settings/team' },
];

function extractRelatedUrls(title, content) {
  const text = title + ' ' + content;
  const urls = new Set();
  for (const { pattern, path } of LIMOVA_PAGE_PATTERNS) {
    if (pattern.test(text)) urls.add(path);
  }
  return [...urls];
}

// ─── Écriture des fichiers ──────────────────────────────────────────────────

function writeKnowledgeBase(articles) {
  mkdirSync(OUT_DIR, { recursive: true });
  const articlesDir = resolve(OUT_DIR, 'articles');
  mkdirSync(articlesDir, { recursive: true });

  // Enrichir chaque article avec keywords et related_urls
  const enriched = articles.map(a => ({
    ...a,
    keywords: extractKeywords(a.title, a.content),
    related_urls: extractRelatedUrls(a.title, a.content),
  }));

  // Écrire chaque article individuellement
  for (const a of enriched) {
    const frontmatter = [
      '---',
      `title: "${a.title.replace(/"/g, '\\"')}"`,
      `slug: "${a.slug}"`,
      `url: "${a.url}"`,
      `keywords: ${JSON.stringify(a.keywords)}`,
      `related_urls: ${JSON.stringify(a.related_urls)}`,
      '---',
    ].join('\n');

    const fileContent = `${frontmatter}\n\n# ${a.title}\n\n${a.content}\n`;
    const filePath = resolve(articlesDir, `${a.slug}.md`);
    writeFileSync(filePath, fileContent, 'utf-8');
  }

  console.log(`📝 ${enriched.length} articles individuels écrits dans articles/`);

  // Index
  const indexContent = [
    `# Knowledge Base Limova`,
    ``,
    `> Dernière mise à jour : ${new Date().toISOString().split("T")[0]}`,
    `> Total : ${enriched.length} articles`,
    ``,
    ...enriched.map(a => `- [${a.title}](articles/${a.slug}.md) — ${a.keywords.slice(0, 5).join(', ')}`),
    ``,
  ].join("\n");

  writeFileSync(resolve(OUT_DIR, "INDEX.md"), indexContent, "utf-8");
  console.log(`📝 INDEX.md`);

  // ── Générer le fichier JS importable par l'extension Chrome ──
  const jsArticles = enriched.map(a => ({
    title: a.title,
    slug: a.slug,
    url: a.url,
    keywords: a.keywords,
    related_urls: a.related_urls,
    content: a.content,
  }));

  const jsContent = `// Auto-generated by scrape-help.mjs — ${new Date().toISOString().split("T")[0]}
// ${articles.length} articles from ${BASE}/${LANG}
// DO NOT EDIT MANUALLY — run: node scripts/scrape-help.mjs

export const KB_GENERATED_AT = "${new Date().toISOString()}";
export const KB_ARTICLE_COUNT = ${articles.length};
export const KB_ARTICLES = ${JSON.stringify(jsArticles, null, 2)};
`;

  const jsPath = resolve(__dirname, "..", "knowledge-base", "kb-data.js");
  writeFileSync(jsPath, jsContent, "utf-8");
  console.log(`📝 kb-data.js — ${articles.length} articles (module JS pour l'extension)`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Scraping du portail d'aide Limova\n");
  console.log(`   Base URL : ${BASE}/${LANG}`);
  console.log(`   Sortie   : ${OUT_DIR}\n`);

  const urls = await discoverArticles();
  const articles = await scrapeAll(urls);
  writeKnowledgeBase(articles);

  console.log(`\n✅ Terminé ! ${articles.length} articles sauvegardés dans ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("❌ Erreur :", err);
  process.exit(1);
});
