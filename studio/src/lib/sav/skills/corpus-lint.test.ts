import { describe, expect, it } from "vitest";
import { CORPUS_GROUPS, type CorpusCase, type CorpusGroup } from "./corpus-contract";
import { lintCorpus } from "./corpus-lint";
import type { SkillExample } from "./skill-contract";

const minimums = { positive: 1, neighbour: 1, sensitive: 1, mixed: 1, trap: 1 } satisfies Record<CorpusGroup, number>;
const team = { kind: "team" } as const;
const cases: readonly CorpusCase[] = [
  { id: "p", group: "positive", text: "The export takes forever to finish.", requests: [{ requestId: "r1", expected: { kind: "block", blockId: "exports" } }] },
  { id: "n", group: "neighbour", text: "Please show me where calendar settings are.", requests: [{ requestId: "r1", expected: { kind: "block", blockId: "calendar" } }] },
  { id: "s", group: "sensitive", text: "Please refund the upgrade.", requests: [{ requestId: "r1", expected: { kind: "sensitive" } }] },
  { id: "m", group: "mixed", text: "The archive failed. I have a separate calendar question.", requests: [{ requestId: "r1", expected: team }, { requestId: "r2", expected: team }] },
  { id: "t", group: "trap", text: "C’est la pièce jointe qui manque.", requests: [{ requestId: "r1", expected: team }] },
];

const example: SkillExample = {
  id: "e1", subject: "Archive", text: "Impossible d’ouvrir l’archive ici.", verdict: "team", comment: "Keep this request with the team.",
};

describe("corpus lint", () => {
  it("accepts synthetic fixtures and request IDs reused across different cases", () => {
    expect(lintCorpus({ cases, examples: [example], minimums })).toEqual([]);
  });

  it("reports duplicate fixture and request IDs and requires two distinct requests in mixed cases", () => {
    const mixed = cases[3];
    expect(lintCorpus({ cases: [...cases, { ...mixed, requests: [mixed.requests[0], mixed.requests[0]] }], examples: [example, example], minimums }))
      .toEqual([
        { code: "duplicate_id", fixture: "example", id: "e1" },
        { code: "duplicate_id", fixture: "case", id: "m" },
        { code: "duplicate_request_id", id: "m", requestId: "r1" },
        { code: "mixed_requires_two_requests", id: "m" },
      ]);
  });

  it("rejects empty case text and blank case and request IDs", () => {
    expect(lintCorpus({ cases: [...cases, { id: " ", group: "positive", text: " — ", requests: [{ requestId: "", expected: team }] }], examples: [], minimums }))
      .toEqual([
        { code: "invalid_id", fixture: "case", id: " " },
        { code: "empty_text", fixture: "case", id: " " },
        { code: "invalid_request_id", id: " ", requestId: "" },
        { code: "missing_requests", id: " " },
      ]);
  });

  it.each([
    "IMPOSSIBLE  D'OUVRIR L'ARCHIVE ICI!",
    "Bonjour. Impossible d’ouvrir l’archive ici… Merci !",
    "Impossible d’ouvrir l’archive",
  ])("rejects normalized example overlap in either direction (%s)", text => {
    expect(lintCorpus({ cases: [...cases, { ...cases[0], id: "overlap", subject: "Different subject", text }], examples: [example], minimums }))
      .toEqual([{ code: "example_overlap", id: "overlap", exampleId: "e1" }]);
  });

  it("normalizes accented and decomposed fixtures and compares whole words", () => {
    const examples = [{ ...example, text: "C’EST LA PIE\u0300CE JOINTE QUI MANQUE !" }, { ...example, id: "short-word", text: "join" }];
    expect(lintCorpus({ cases, examples, minimums })).toEqual([{ code: "example_overlap", id: "t", exampleId: "e1" }]);
  });

  it.each(CORPUS_GROUPS)("enforces the configured minimum for %s", group => {
    expect(lintCorpus({ cases, examples: [], minimums: { ...minimums, [group]: 2 } }))
      .toEqual([{ code: "below_quota", group, count: 1, minimum: 2 }]);
  });

  it.each([0, -1, 1.5, NaN])("rejects an invalid group quota of %s", minimum => {
    expect(lintCorpus({ cases, examples: [], minimums: { ...minimums, trap: minimum } }))
      .toEqual([{ code: "invalid_quota", group: "trap", minimum }]);
  });

  it("allows reserved fictional addresses and links, including subdomains", () => {
    const text = "Use test+mail@sub.example.net, me@sample.invalid or https://docs.example.com/start and www.sample.test.";
    expect(lintCorpus({ cases: [...cases, { ...cases[0], id: "fixture-addresses", text }], examples: [], minimums })).toEqual([]);
  });

  it.each(["01.99.00.00.01", "+33 (0)1 99 00 00 01", "0033 1-99-00-00-01", "0199000001", "01\u202f99\u202f00\u202f00\u202f01"])("flags a French phone in format %s", phone => {
    expect(lintCorpus({ cases: [...cases, { ...cases[0], id: "phone", subject: `Téléphone ${phone}` }], examples: [], minimums }))
      .toEqual([{ code: "french_phone", fixture: "case", id: "phone", field: "subject" }]);
  });

  it.each(["https://192.0.2.1/path", "//host.invalidish/path", "www.host.invalidish", "https://example.invalid@host.invalidish"]) (
    "flags a non-fictional URL form (%s)", text => {
      expect(lintCorpus({ cases: [...cases, { ...cases[0], id: "url", text }], examples: [], minimums }))
        .toContainEqual({ code: "non_fictional_url", fixture: "case", id: "url", field: "text" });
    },
  );

  it("only permits exact Limova hostnames on the allowlist and still flags Limova email addresses", () => {
    const text = "Open https://STUDIO.LIMOVA.AI./help or studio.limova.ai. Then write to sample@studio.limova.ai.";
    const row: CorpusCase = { ...cases[0], id: "first-party", text };
    const lint = (allowedLimovaDomains: string[], fixture = row) => lintCorpus({ cases: [...cases, fixture], examples: [], minimums, allowedLimovaDomains });
    expect(lint(["STUDIO.LIMOVA.AI."])).toEqual([{ code: "non_fictional_email", fixture: "case", id: "first-party", field: "text" }]);
    expect(lint(["limova.ai"])).toContainEqual({ code: "non_fictional_url", fixture: "case", id: "first-party", field: "text" });
    expect(lint(["host.invalidish"], { ...row, text: "Open host.invalidish/path." }))
      .toEqual([{ code: "non_fictional_url", fixture: "case", id: "first-party", field: "text" }]);
    expect(lint(["studio.limova.ai"], { ...row, text: "Open https://studio.limova.ai.host.invalidish/help." }))
      .toEqual([{ code: "non_fictional_url", fixture: "case", id: "first-party", field: "text" }]);
  });

  it("scans all example fields and leaves matched values out of diagnostics", () => {
    const examples = [{ ...example, subject: "Visit HTTPS://host.invalidish/", comment: "Email user@host.invalidish" }];
    expect(lintCorpus({ cases, examples, minimums })).toEqual([
      { code: "non_fictional_url", fixture: "example", id: "e1", field: "subject" },
      { code: "non_fictional_email", fixture: "example", id: "e1", field: "comment" },
    ]);
  });
});
