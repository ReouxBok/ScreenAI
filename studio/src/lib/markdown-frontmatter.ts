import { dump, load } from "js-yaml";

export function parseMarkdownFrontmatter(source: string): { data: Record<string, unknown>; content: string } {
  const text = source.replace(/^\uFEFF/, "");
  const opening = /^(---[^\r\n]*)(?:\r?\n|$)/.exec(text);
  if (!opening) return { data: {}, content: text };
  if (!/^---[ \t]*(?:yaml[ \t]*)?$/.test(opening[1])) {
    throw new Error("Only YAML Markdown front matter is supported");
  }
  const rest = text.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error("Markdown front matter is not closed");
  const data: unknown = load(rest.slice(0, closing.index));
  if (data !== undefined && data !== null && (typeof data !== "object" || Object.getPrototypeOf(data) !== Object.prototype)) {
    throw new Error("Markdown front matter must be a mapping");
  }
  return {
    data: (data ?? {}) as Record<string, unknown>,
    content: rest.slice(closing.index + closing[0].length),
  };
}

export function stringifyMarkdownFrontmatter(content: string, data: Record<string, unknown>): string {
  return `---\n${dump(data, { lineWidth: -1, noRefs: true })}---\n${content}`;
}
