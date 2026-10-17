import "server-only";
import { z } from "zod";
import { savContentHash } from "./crypto";
import { SavContractValidationError, type SavValidationDiagnostic } from "./validation-diagnostics";

/** Minimal structural evidence is persisted inside the existing encrypted proposal.
 * Raw rejected text is deliberately excluded: logs and retention need no PII copy. */
export function savValidationDiagnostic(error: unknown, phase: SavValidationDiagnostic["phase"], candidate?: unknown): SavValidationDiagnostic {
  const value = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const count = (key: string) => Array.isArray(value[key]) ? value[key].length : 0;
  let candidateHash: string | null = null;
  try { if (candidate !== undefined) candidateHash = savContentHash(candidate); } catch { /* Diagnostic only. */ }
  return { phase, rule: error instanceof SavContractValidationError ? error.rule : error instanceof z.ZodError ? "invalid_schema" : "validation_failed",
    path: error instanceof SavContractValidationError ? error.path : error instanceof z.ZodError ? error.issues[0]?.path.filter(k => typeof k === "number" || /^(?:version|status|language|requests|evidence|knownFacts|attemptedSteps|missingInformation|uncertainties|coverage|citations|id|sourceId|requestId|text|kind)$/.test(String(k))).join(".").slice(0, 160) ?? "contract" : "contract",
    candidateHash, shape: { requests: count("requests"), evidence: count("evidence"), knownFacts: count("knownFacts"), attemptedSteps: count("attemptedSteps"), coverage: count("coverage"), citations: count("citations") } };
}
