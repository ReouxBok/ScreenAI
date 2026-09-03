import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("knowledge reset integrity", () => {
  it("keeps the import source directory empty until new reviewed content is authored", async () => {
    const directory = path.resolve(process.cwd(), "../src/knowledge-base/articles");
    const files = await readdir(directory).catch(() => []);
    expect(files.filter((file) => file.endsWith(".md"))).toEqual([]);
  });
});
