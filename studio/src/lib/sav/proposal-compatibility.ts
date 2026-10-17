import type { SavStructuredProposal } from "./proposal";

/** Diagnostics live in agent_runs.tool_trace. Keep the encrypted business snapshot
 * readable by the previous strict contract so code rollback needs no data rewrite. */
export function savRollbackCompatibleProposal(proposal: SavStructuredProposal): SavStructuredProposal {
  const copy = structuredClone(proposal);
  if (copy.understanding) {
    delete copy.understanding.trace.validationDiagnostics;
    delete copy.understanding.trace.validationRecovery;
  }
  if (copy.replyAssessment) {
    delete copy.replyAssessment.validationDiagnostics;
    delete copy.replyAssessment.recovery;
    delete copy.replyAssessment.coherenceAttempts;
  }
  return copy;
}
