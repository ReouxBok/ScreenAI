import { savUnderstandingContentSchema, type SavUnderstandingContent } from "./understanding";

/** Change representation only. No request, fact, source or reported result is removed.
 * Callers must still run the original provenance and preservation validators. */
export function repairSavUnderstandingRepresentation(raw: unknown): SavUnderstandingContent | null {
  const parsed = savUnderstandingContentSchema.safeParse(raw);
  if (!parsed.success) return null;
  const candidate = parsed.data;
  let changed = false;
  for (const attempt of candidate.attemptedSteps) {
    if (!attempt.checkId && !attempt.checkCardId && !attempt.checkVersionId
      && (attempt.outcome === "expected" || attempt.outcome === "not_expected")) {
      // The customer-reported result remains verbatim in text. A catalogued
      // outcome requires a catalogued reference, which this attempt does not have.
      attempt.outcome = "unknown";
      changed = true;
    }
  }
  for (const request of candidate.requests) {
    if (["financial_operation", "financial_data"].includes(request.nature) && request.financialScope !== "support_account") {
      request.financialScope = "support_account";
      changed = true;
    }
    // Never remove support_account from a non-financial candidate locally.
    // Re-extraction must resolve that ambiguity under the unchanged guards.
  }
  return changed ? candidate : null;
}

/** A repair has no authority to rewrite protected prose. Copy it from the
 * original by stable, unique ID; all other changes still face assert*Preserves.
 * Missing/duplicate IDs or dropped elements are deliberately not reconstructed. */
export function retainSavUnderstandingProse(before: unknown, recovered: unknown): unknown {
  const original = savUnderstandingContentSchema.safeParse(before);
  const next = savUnderstandingContentSchema.safeParse(recovered);
  if (!original.success || !next.success) return recovered;
  const result = next.data;
  for (const key of ["requests", "knownFacts", "attemptedSteps"] as const) {
    for (const item of result[key]) {
      const matches = original.data[key].filter(prior => prior.id === item.id);
      if (matches.length !== 1 || result[key].filter(other => other.id === item.id).length !== 1) continue;
      const prior = matches[0];
      if ("summary" in item && "summary" in prior) item.summary = prior.summary;
      if ("text" in item && "text" in prior) item.text = prior.text;
    }
  }
  return result;
}
