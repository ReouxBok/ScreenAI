import { createHash } from "node:crypto";

// Pole B's reference check of the COMMON simulated-run report (B owns the bench and its format; UX keeps its own reader). Pure, synthetic only.
// Fails closed on the gates of the independent review: every expectation frozen before the run starts, every compared field bound field by field
// to the hashed expectation, a real send distribution per reply key (never an average), every action simulated, unknowns never compared.

export const SAV_V2_SIMULATION_REPORT_ENVELOPE = "sav-v2-simulation-report.proposal-1";
export const SAV_V2_SIMULATION_COMMON_CONTRACT = "sav-v2-simulation-report.common-1";
// Compared field -> key of the frozen expectation it must equal.
export const SAV_V2_SIMULATION_COMPARED_FIELDS = { "reply.purpose": "purpose", "effect.final": "final", "effect.reason": "reason", "sends.total": "sends", refusals: "refusals" } as const;
type ComparedField = keyof typeof SAV_V2_SIMULATION_COMPARED_FIELDS;
const LIMITS = { bytes: 256 * 1024, cases: 500, string: 20_000, fields: 50, depth: 16 } as const;
const PROVENANCE = { executor: "simulated", provider: "synthetic-gmail-no-socket", model: "synthetic-double" } as const;

// Defined only on strings, safe integers, booleans, null, arrays and plain objects (where it equals RFC 8785); anything else throws, never guesses.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw Error("SAV_CANONICAL_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw Error("SAV_CANONICAL_VALUE");
}
export const frozenExpectationHash = (frozen: unknown) => createHash("sha256").update(canonicalJson(frozen), "utf8").digest("hex");

export type CommonReportCheck = Readonly<{ errors: string[]; verdicts: Record<string, string>; doubleSendKeys: Record<string, string[]> }>;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const instant = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const same = (left: unknown, right: unknown) => { try { return canonicalJson(left) === canonicalJson(right); } catch { return false; } };
const tooDeep = (value: unknown, depth = 0): boolean => depth > LIMITS.depth
  || (Array.isArray(value) ? value.some(entry => tooDeep(entry, depth + 1)) : isObject(value) ? Object.values(value).some(entry => tooDeep(entry, depth + 1)) : false);
const longString = (value: unknown): boolean => typeof value === "string" ? value.length > LIMITS.string
  : Array.isArray(value) ? value.some(longString) : isObject(value) ? Object.entries(value).some(([key, entry]) => longString(key) || longString(entry)) : false;

export function checkCommonSimulationReport(input: unknown): CommonReportCheck {
  const errors: string[] = [], verdicts: Record<string, string> = {}, doubleSendKeys: Record<string, string[]> = {};
  const fail = (code: string) => { errors.push(code); return { errors, verdicts, doubleSendKeys }; };
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8"); } catch { return fail("report_not_json"); }
  if (bytes > LIMITS.bytes) return fail("report_too_large");
  if (!isObject(input) || input.kind !== SAV_V2_SIMULATION_REPORT_ENVELOPE) return fail("report_kind");
  // Every bound applies to the whole JSON, compared values included (strings at any depth, nesting), before anything is read.
  if (tooDeep(input)) return fail("too_deep");
  if (longString(input)) errors.push("string_too_long");
  const run = isObject(input.run) ? input.run : {}, provenance = isObject(run.provenance) ? run.provenance : {};
  if (run.synthetic !== true) errors.push("run_not_synthetic");
  if (provenance.contract !== SAV_V2_SIMULATION_COMMON_CONTRACT) errors.push("provenance_contract");
  for (const [key, allowed] of Object.entries(PROVENANCE)) if (provenance[key] !== allowed) errors.push(`provenance_${key}`);
  const startedAt = instant(run.startedAt);
  if (startedAt === null) errors.push("run_started_at");
  if (!Array.isArray(input.cases)) return fail("cases_missing");
  if (input.cases.length > LIMITS.cases) return fail("too_many_cases");
  const cohort = isObject(provenance.cohort) ? provenance.cohort : {};
  if (cohort.kind !== "synthetic" || cohort.cases !== input.cases.length) errors.push("provenance_cohort");

  const seenRefs = new Set<string>();
  for (const raw of input.cases) {
    const row = isObject(raw) ? raw : {}, ref = typeof row.caseRef === "string" && /^SYN-[A-Z0-9-]{1,40}$/.test(row.caseRef) ? row.caseRef : null;
    if (!ref) { errors.push("case_ref"); continue; }
    if (seenRefs.has(ref)) errors.push(`${ref}:case_ref_duplicate`);
    seenRefs.add(ref);
    const bad = (code: string) => errors.push(`${ref}:${code}`);
    const actions = Array.isArray(row.actions) ? row.actions : null, proofs = Array.isArray(row.proofs) ? row.proofs : [];
    if (!actions || actions.some(action => !isObject(action) || action.simulated !== true)) bad("action_not_simulated");
    const executor = isObject(row.executor) ? row.executor : {};
    if (executor.simulated !== true) bad("executor_not_simulated");
    if (!proofs.some(proof => isObject(proof) && proof.kind === "networkCalls" && proof.ref === "0")) bad("network_calls");
    if (!isObject(row.cost) || row.cost.paidCalls !== 0) bad("paid_calls");
    const fields = Array.isArray(row.fields) ? row.fields.filter(isObject) : [], unknown = Array.isArray(row.notComparable) ? row.notComparable.filter(isObject) : [];
    if (!Array.isArray(row.fields) || fields.length !== row.fields.length || !Array.isArray(row.notComparable) || unknown.length !== row.notComparable.length) { bad("fields_shape"); continue; }
    if (fields.length > LIMITS.fields) bad("too_many_fields");
    if (unknown.some(entry => typeof entry.reason !== "string" || !entry.reason)) bad("not_comparable_reason");

    // Sends: a real distribution {replyKey, count}, or null when the sends are explicitly not comparable. An average cannot tell [2,0] from [1,1],
    // and an unknown is never reported as a measured zero.
    const sendsUnknown = unknown.some(entry => entry.field === "sends.total"), byKey = executor.sendsByReplyKey;
    if (byKey === null && executor.syntheticSends === null && executor.replyKeys === null) {
      if (!sendsUnknown) bad("sends_unknown_but_compared");
    } else if (sendsUnknown) bad("sends_unknown_but_measured");
    else if (!Array.isArray(byKey) || byKey.some(entry => !isObject(entry) || typeof entry.replyKey !== "string" || !entry.replyKey)) bad("sends_by_key_not_distribution");
    else {
      if (byKey.some(entry => !Number.isSafeInteger(entry.count) || (entry.count as number) < 0)) bad("sends_by_key_count");
      if (new Set(byKey.map(entry => entry.replyKey)).size !== byKey.length) bad("sends_by_key_duplicate");
      if (byKey.reduce((sum, entry) => sum + (Number.isSafeInteger(entry.count) ? entry.count as number : 0), 0) !== executor.syntheticSends) bad("sends_by_key_sum");
      if (executor.replyKeys !== byKey.length) bad("sends_by_key_keys");
      doubleSendKeys[ref] = byKey.filter(entry => (entry.count as number) > 1).map(entry => entry.replyKey as string);
    }

    if (row.expected === null) {
      if (fields.length || unknown.length || row.expectedMeta !== null) bad("expected_null_with_fields");
      verdicts[ref] = "not_comparable";
      if (row.declaredVerdict !== "not_comparable") bad("verdict_inconsistent");
      continue;
    }
    const expected = isObject(row.expected) ? row.expected : {}, meta = isObject(row.expectedMeta) ? row.expectedMeta : {}, frozen = isObject(meta.frozen) ? meta.frozen : null;
    if (!frozen || !isObject(frozen.expected)) { bad("frozen_missing"); continue; }
    try { if (frozenExpectationHash(frozen) !== expected.hash) bad("hash_mismatch"); } catch { bad("frozen_not_canonical"); }
    if (frozen.caseRef !== ref) bad("frozen_case_ref");
    if (frozen.scenario !== row.scenario) bad("frozen_scenario");
    if (!same(frozen.timeline, row.timeline)) bad("frozen_timeline");
    // Phases: every expectation frozen strictly before the run starts, and the run starts before the case's first proposal.
    const frozenAt = instant(expected.frozenAt), proposedAt = instant(row.proposedAt);
    if (frozenAt === null || startedAt === null || frozenAt >= startedAt) bad("frozen_not_before_run");
    if (proposedAt === null || startedAt === null || proposedAt < startedAt) bad("proposal_before_run");

    // Binding: the compared fields plus the explicit unknowns are exactly the five fields, once each, and each expected value IS the frozen one.
    const names = [...fields.map(field => field.field), ...unknown.map(entry => entry.field)];
    if (names.some(name => typeof name !== "string" || !(name in SAV_V2_SIMULATION_COMPARED_FIELDS))) bad("field_unknown_name");
    if (new Set(names).size !== names.length) bad("field_duplicate");
    if (Object.keys(SAV_V2_SIMULATION_COMPARED_FIELDS).some(name => !names.includes(name))) bad("field_missing");
    for (const field of fields) {
      const key = SAV_V2_SIMULATION_COMPARED_FIELDS[field.field as ComparedField];
      if (key && !same(field.expected, frozen.expected[key])) bad("field_not_bound");
    }
    const observedRefusals = fields.find(field => field.field === "refusals");
    if (observedRefusals && !same(observedRefusals.proposed, row.refusals)) bad("refusals_not_bound");
    const observedSends = fields.find(field => field.field === "sends.total");
    if (observedSends && observedSends.proposed !== executor.syntheticSends) bad("sends_total_not_bound");

    // Verdict recomputed, never trusted: refusals count as expected only when the frozen expectation itself lists them.
    const verdict = unknown.length ? "not_comparable" : fields.some(field => !same(field.expected, field.proposed)) ? "mismatch"
      : Array.isArray(frozen.expected.refusals) && frozen.expected.refusals.length ? "refused_as_expected" : "match";
    verdicts[ref] = verdict;
    if (row.declaredVerdict !== verdict) bad("verdict_inconsistent");
  }
  return { errors, verdicts, doubleSendKeys };
}
