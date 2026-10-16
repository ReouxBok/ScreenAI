import { describe, expect, it } from "vitest";
import corpus from "../../../test/fixtures/sav-evidence-typography-v1.json";
import { savEvidenceContains } from "./evidence-text";
describe("versioned synthetic evidence replay", () => {
  it.each(corpus.cases)("$id preserves the expected proof boundary", row => {
    expect(savEvidenceContains(row.source, row.excerpt)).toBe(row.expected);
  });
});
