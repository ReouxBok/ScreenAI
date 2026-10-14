import { describe, expect, it } from "vitest";
import { parseMarkdownFrontmatter, stringifyMarkdownFrontmatter } from "./markdown-frontmatter";

describe("Markdown knowledge import and export", () => {
  it("preserves article metadata and Markdown through an export/import round trip", () => {
    const data = {
      title: "L’équipe : connecter Gmail", slug: "gmail", keywords: ["oui", "true", "012", "intégration"],
      related_urls: ["https://new.limova.ai/integrations?source=guide#gmail"],
      published: true, rank: 12, empty: null, description: "Première ligne\nDeuxième ligne\n",
      nested: { unknownMetadata: [1, false, "2026-10-14"] }, created: new Date("2026-10-14T12:00:00Z"),
    };
    const content = "# Gmail\n\n```yaml\n---\ntitle: exemple\n---\n```\n\nTexte **riche**.\n";
    expect(parseMarkdownFrontmatter(stringifyMarkdownFrontmatter(content, data))).toEqual({ data, content });
  });
  it("reads BOM, CRLF, comments, aliases and multiline YAML without changing the body", () => {
    const source = '\uFEFF---\r\n# import\r\ntitle: "Titre : spécial"\r\nkeywords: &words [gmail, connexion]\r\nalias: *words\r\nsummary: |\r\n  Ligne un\r\n  Ligne deux\r\n---\r\n# Corps\r\n';
    expect(parseMarkdownFrontmatter(source)).toEqual({ data: { title: "Titre : spécial", keywords: ["gmail", "connexion"], alias: ["gmail", "connexion"], summary: "Ligne un\nLigne deux\n" }, content: "# Corps\r\n" });
  });
  it.each(["", "# Sans métadonnées\n\n---\nCorps\n", "Texte --- inline"])("keeps a document without a header intact", content => {
    expect(parseMarkdownFrontmatter(content)).toEqual({ data: {}, content });
  });
  it("accepts empty YAML and the explicit YAML marker", () => {
    expect(parseMarkdownFrontmatter("---\n---\nBody")).toEqual({ data: {}, content: "Body" });
    expect(parseMarkdownFrontmatter("---yaml\ntitle: Guide\n---\nBody")).toEqual({ data: { title: "Guide" }, content: "Body" });
  });
  it.each([
    "---\ntitle: Missing delimiter", "---\n- array\n---\nBody", "---\n42\n---\nBody", "---\n!!binary SGVsbG8=\n---\nBody",
    "---\ntitle: one\ntitle: two\n---\nBody", "---javascript\n({ title: 'executable' })\n---\nBody",
    "---\ntitle: !!js/function function() {}\n---\nBody",
  ])("rejects malformed or executable metadata before import", source => {
    expect(() => parseMarkdownFrontmatter(source)).toThrow();
  });
});
