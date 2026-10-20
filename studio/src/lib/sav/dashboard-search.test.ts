import { afterEach, describe, expect, it, vi } from "vitest";
import { indexSavDashboardSearch, querySavDashboardSearch } from "./dashboard-search";

afterEach(() => vi.unstubAllEnvs());
describe("private substring index for the SAV dashboard", () => {
  it("matches the existing UTF-16 includes predicate, including contiguous order", () => {
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-key-with-at-least-32-characters");
    const examples = ["abcxbcd", "abcd", "bbbbbb", "école Téléphonie facture", "A🙂B", "from@example.invalid titre ticket 123", "%_ \\ , ' \"", "ab ba ab", "𝒜z𝒜"];
    for (const raw of examples) {
      const text = raw.toLocaleLowerCase("fr"), index = indexSavDashboardSearch(text);
      const queries = ["", "abcd", "bca", "bb", "télé", "ecole", "🙂", "not-present", "%_", ...Array.from({ length: text.length }, (_, i) => text.slice(i, i + 5))];
      for (const q of queries) {
        const search = querySavDashboardSearch(q), actual = search.grams.every(gram => index.grams.includes(gram)) && (!search.stream || index.stream.includes(search.stream));
        expect(actual, JSON.stringify({ text, q })).toBe(text.includes(q));
      }
    }
  });
  it("does not persist plaintext or permit dictionary hashing without the key", () => {
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-key-with-at-least-32-characters");
    const first = indexSavDashboardSearch("private customer@example.invalid");
    expect(JSON.stringify(first)).not.toMatch(/private|customer|example/);
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "another-synthetic-key-with-at-least-32-characters");
    expect(indexSavDashboardSearch("private customer@example.invalid")).not.toEqual(first);
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "");
    expect(() => querySavDashboardSearch("private")).toThrow("SAV_ENCRYPTION_KEY");
  });
});
