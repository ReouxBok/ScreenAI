export type KnowledgeChunk = { ordinal: number; heading: string; content: string };

export function chunkMarkdown(markdown: string, maxChars = 1800): KnowledgeChunk[] {
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current = { heading: "", lines: [] as string[] };

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading && current.lines.some((value) => value.trim())) {
      sections.push(current);
      current = { heading: heading[1].trim(), lines: [line] };
    } else {
      if (heading) current.heading = heading[1].trim();
      current.lines.push(line);
    }
  }
  if (current.lines.some((value) => value.trim())) sections.push(current);

  const chunks: KnowledgeChunk[] = [];
  for (const section of sections) {
    const paragraphs = section.lines.join("\n").split(/\n{2,}/);
    let buffer = "";
    for (const paragraph of paragraphs) {
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (candidate.length <= maxChars) {
        buffer = candidate;
        continue;
      }
      if (buffer.trim()) chunks.push({ ordinal: chunks.length, heading: section.heading, content: buffer.trim() });
      buffer = paragraph;
      while (buffer.length > maxChars) {
        const cut = Math.max(buffer.lastIndexOf(" ", maxChars), Math.floor(maxChars * 0.7));
        chunks.push({ ordinal: chunks.length, heading: section.heading, content: buffer.slice(0, cut).trim() });
        buffer = buffer.slice(cut).trim();
      }
    }
    if (buffer.trim()) chunks.push({ ordinal: chunks.length, heading: section.heading, content: buffer.trim() });
  }
  return chunks;
}
