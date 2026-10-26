/** Complete source data and the complete serialized provider text are bounded
 * separately: JSON escaping, instructions and the schema also consume space.
 * A dossier the model can read must not fail on size: these caps stay far below
 * the provider input window that every call already reserves in money
 * (derived-budget INPUT_LIMIT), and SAV_AI_BUDGET.tokenAllowance admits three
 * calls at this size. Beyond them the failure is explicit
 * (SAV_INTAKE_MODEL_CONTEXT_LIMIT), never a silent truncation; monetary,
 * call-count and time budgets remain independently enforced. */
export const SAV_INTAKE_MODEL_LIMITS = {
  dataBytes: 640 * 1024,
  wireTextBytes: 768 * 1024,
} as const;
