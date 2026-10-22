/** Complete source data and the complete serialized provider text are bounded
 * separately: JSON escaping, instructions and the schema also consume space.
 * These limits fit the existing conservative input reservation; monetary,
 * aggregate token, call-count and time budgets remain independently enforced. */
export const SAV_INTAKE_MODEL_LIMITS = {
  dataBytes: 96 * 1024,
  wireTextBytes: 128 * 1024,
} as const;
