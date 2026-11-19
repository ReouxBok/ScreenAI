import { normalizeSavEvidenceText } from "../evidence-text";
import { CORPUS_GROUPS, type CorpusCase, type CorpusGroup } from "./corpus-contract";
import type { SkillExample } from "./skill-contract";

type DataFinding = "non_fictional_email" | "french_phone" | "non_fictional_url";
type FixtureKind = "case" | "example";

export type CorpusLintIssue =
  | Readonly<{ code: "invalid_id" | "duplicate_id"; fixture: FixtureKind; id: string }>
  | Readonly<{ code: "invalid_request_id" | "duplicate_request_id"; id: string; requestId: string }>
  | Readonly<{ code: "empty_text"; fixture: FixtureKind; id: string }>
  | Readonly<{ code: "missing_requests" | "mixed_requires_two_requests"; id: string }>
  | Readonly<{ code: "example_overlap"; id: string; exampleId: string }>
  | Readonly<{ code: "invalid_quota"; group: CorpusGroup; minimum: number }>
  | Readonly<{ code: "below_quota"; group: CorpusGroup; count: number; minimum: number }>
  | Readonly<{ code: DataFinding; fixture: FixtureKind; id: string; field: "text" | "subject" | "comment" }>;

const EMAIL = /[\p{L}\p{N}_.!#$%&'*+/=?^`{|}~-]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/gu;
const URL_WITH_SCHEME = /(?:(?:\b[a-z][a-z\d+.-]*:)|(?<![:/]))\/\/[^\s<>"'`]+/giu;
const BARE_DOMAIN = /(?<![\p{L}\p{N}_@-])(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+(?:xn--[a-z\d-]+|\p{L}{2,})(?![\p{L}\p{N}_-])/giu;
const FRENCH_PHONE = /(?<!\d)(?:0[ .\t\u00a0\u202f-]*|(?:\+33|0033)[ .\t\u00a0\u202f-]*(?:\(0\)[ .\t\u00a0\u202f-]*)?)[1-9](?:[ .\t\u00a0\u202f-]*\d){8}(?!\d)/u;

const normalizeDomain = (host: string) => host.toLowerCase().replace(/\.$/, "");
const isLimovaDomain = (host: string) => host === "limova.ai" || host.endsWith(".limova.ai");

function isFictionalDomain(host: string): boolean {
  const domain = normalizeDomain(host);
  return /(?:^|\.)example\.(?:com|net|org)$|\.(?:example|invalid|test)$/.test(domain);
}

function dataFindings(text: string, allowedDomains: ReadonlySet<string>): DataFinding[] {
  // Scan normalized characters as well as the usual written forms of host names and phone numbers.
  const value = text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/[。｡]/gu, ".");
  const findings = new Set<DataFinding>();
  if (FRENCH_PHONE.test(value)) findings.add("french_phone");
  for (const [, domain] of value.matchAll(EMAIL)) {
    if (!isFictionalDomain(domain)) findings.add("non_fictional_email");
  }

  const allowedHost = (host: string) => isFictionalDomain(host) || allowedDomains.has(normalizeDomain(host));
  const bareText = value.replace(URL_WITH_SCHEME, raw => {
    // URL parsing keeps the authority distinct from credentials, ports and paths.
    try {
      const url = new URL(raw.replace(/[.,;!?)}]+$/, ""), "https://example.invalid");
      if (url.username || url.password || !allowedHost(url.hostname)) findings.add("non_fictional_url");
    } catch {
      findings.add("non_fictional_url");
    }
    return " ";
  }).replace(EMAIL, " ");
  for (const [domain] of bareText.matchAll(BARE_DOMAIN)) {
    if (!allowedHost(domain)) findings.add("non_fictional_url");
  }
  return [...findings];
}

function normalizeFixtureText(text: string): string {
  return normalizeSavEvidenceText(text).normalize("NFKD").toLowerCase()
    .replace(/[\p{M}\p{Cf}]/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Lint fixtures before replay. Diagnostics carry fixture IDs and field names only. */
export function lintCorpus(input: Readonly<{
  cases: readonly CorpusCase[];
  examples: readonly SkillExample[];
  minimums: Readonly<Record<CorpusGroup, number>>;
  allowedLimovaDomains?: readonly string[];
}>): readonly CorpusLintIssue[] {
  const issues: CorpusLintIssue[] = [];
  const allowedDomains = new Set(input.allowedLimovaDomains?.map(normalizeDomain).filter(isLimovaDomain));
  const counts: Record<CorpusGroup, number> = { positive: 0, neighbour: 0, sensitive: 0, mixed: 0, trap: 0 };

  const checkFixture = (fixture: FixtureKind, row: CorpusCase | SkillExample, ids: Set<string>) => {
    if (!row.id || row.id.trim() !== row.id) issues.push({ code: "invalid_id", fixture, id: row.id });
    if (ids.has(row.id)) issues.push({ code: "duplicate_id", fixture, id: row.id });
    ids.add(row.id);
    const text = normalizeFixtureText(row.text);
    if (!text) issues.push({ code: "empty_text", fixture, id: row.id });
    const fields = { text: row.text, subject: row.subject, comment: "comment" in row ? row.comment : undefined };
    for (const field of ["text", "subject", "comment"] as const) {
      for (const code of dataFindings(fields[field] ?? "", allowedDomains)) issues.push({ code, fixture, id: row.id, field });
    }
    return text;
  };

  const exampleIds = new Set<string>();
  const examples = input.examples.map(example => ({ id: example.id, text: checkFixture("example", example, exampleIds) }));
  const caseIds = new Set<string>();
  for (const row of input.cases) {
    const text = checkFixture("case", row, caseIds);
    counts[row.group]++;
    for (const example of examples) {
      if (text && example.text && (` ${text} `.includes(` ${example.text} `) || ` ${example.text} `.includes(` ${text} `))) {
        issues.push({ code: "example_overlap", id: row.id, exampleId: example.id });
      }
    }

    const requestIds = new Set<string>();
    for (const { requestId } of row.requests) {
      if (!requestId || requestId.trim() !== requestId) {
        issues.push({ code: "invalid_request_id", id: row.id, requestId });
        continue;
      }
      if (requestIds.has(requestId)) issues.push({ code: "duplicate_request_id", id: row.id, requestId });
      requestIds.add(requestId);
    }
    if (requestIds.size === 0) issues.push({ code: "missing_requests", id: row.id });
    if (row.group === "mixed" && requestIds.size < 2) issues.push({ code: "mixed_requires_two_requests", id: row.id });
  }

  for (const group of CORPUS_GROUPS) {
    const minimum = input.minimums[group];
    if (!Number.isSafeInteger(minimum) || minimum < 1) issues.push({ code: "invalid_quota", group, minimum });
    else if (counts[group] < minimum) issues.push({ code: "below_quota", group, count: counts[group], minimum });
  }
  return issues;
}
