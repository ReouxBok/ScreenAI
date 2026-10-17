import { z } from "zod";

export const savValidationDiagnosticSchema = z.object({
  phase: z.enum(["understanding", "repair", "composition", "coherence"]),
  rule: z.string().regex(/^[a-z0-9_]+$/).max(80),
  path: z.string().max(160),
  candidateHash: z.string().nullable(),
  shape: z.object({ requests: z.number().int().nonnegative(), evidence: z.number().int().nonnegative(),
    knownFacts: z.number().int().nonnegative(), attemptedSteps: z.number().int().nonnegative(),
    coverage: z.number().int().nonnegative(), citations: z.number().int().nonnegative() }).strict(),
}).strict();
export type SavValidationDiagnostic = z.infer<typeof savValidationDiagnosticSchema>;

/** Details describe the contract, never copy model/client text into diagnostics. */
export class SavContractValidationError extends Error {
  constructor(code: string, public readonly rule: string, public readonly path: string) { super(code); }
}
