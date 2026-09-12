import { describe, expect, it } from "vitest";
import { curriculumSlug, LIMOVA_CURRICULUM } from "./limova-curriculum";

describe("Limova curriculum", () => {
  it("uses unique stable slugs", () => {
    const slugs = LIMOVA_CURRICULUM.map((entry) => curriculumSlug(entry.title));
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))).toBe(true);
  });
});
