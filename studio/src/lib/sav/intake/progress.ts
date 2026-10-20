import {
  savIntakeProgressSchema, savIntakeStepReceiptSchema,
  type SavIntakeProgress, type SavIntakeStepReceipt,
} from "./contract";
import type { IntakePlan } from "./engine-types";

export type IntakeProgressInput = {
  attemptId: string;
  // These must come from the future server verification/journal adapter, never an LLM.
  receipts: SavIntakeStepReceipt[];
  learningObservationId?: string;
  retry?: { retryAt: string; reasonCode: string };
  completion?: {
    ticketId: string; closureEvidenceIds: string[];
    balance: "complete" | "not_applicable_sensitive"; balanceEvidenceIds: string[];
    knowledgeCandidateStatus?: "none" | "awaiting_validation" | "awaiting_publication" | "published" | "discarded" | "unknown";
  };
};

/** Pure projection of SERVER-VERIFIED inputs; neither verification nor authorization.
 * No persisted view/counter or learning process is changed by this function. */
export function projectSavIntakeProgress(plan: IntakePlan, input: IntakeProgressInput): SavIntakeProgress {
  const processing = (phase: "verification" | "reconciliation" = "verification"): SavIntakeProgress => ({ kind: "processing", phase, view: null });
  const disposition = plan.decision.disposition;
  if (disposition.kind === "no_ticket" || disposition.kind === "collect_context") {
    if (input.retry && disposition.kind === "collect_context" && plan.progress.kind !== "human_choice") {
      const parsed = savIntakeProgressSchema.safeParse({ kind: "retry_scheduled", ...input.retry, view: null });
      return parsed.success ? parsed.data : processing();
    }
    return plan.progress;
  }
  if (!input.attemptId.trim() || new Set(input.receipts.map(r => r.stepId)).size !== input.receipts.length) return processing();
  const receipts: SavIntakeStepReceipt[] = [];
  for (const value of input.receipts) {
    const parsed = savIntakeStepReceiptSchema.safeParse(value);
    const step = plan.steps.find(s => s.id === value.stepId);
    if (!parsed.success || !step || step.mutation !== value.mutation || value.attemptId !== input.attemptId
      || value.messageId !== plan.decision.messageId
      || step.ticketId !== null && value.targetTicketId !== step.ticketId) return processing();
    receipts.push(parsed.data);
  }
  if (receipts.some(r => r.outcome.kind === "uncertain" || r.outcome.kind === "dispatched")) return processing("reconciliation");
  if (receipts.length !== plan.steps.length || receipts.some(r => r.outcome.kind !== "confirmed")) return processing();
  if (disposition.kind === "request_identification") {
    const parsed = savIntakeProgressSchema.safeParse({ kind: "identity_wait", templateReceipt: receipts[0], view: "missing_contact" });
    return parsed.success ? parsed.data : processing();
  }
  const ticketId = receipts[0]?.targetTicketId;
  if (!ticketId || receipts.some(r => r.targetTicketId !== ticketId)) return processing();
  if (input.completion && input.completion.ticketId === ticketId) {
    const parsed = savIntakeProgressSchema.safeParse({ kind: "completed", classification: plan.decision.classification,
      closureEvidenceIds: input.completion.closureEvidenceIds, balance: input.completion.balance,
      balanceEvidenceIds: input.completion.balanceEvidenceIds, knowledgeCandidateStatus: input.completion.knowledgeCandidateStatus,
      completionRule: "closed_and_balance_finished", view: "completed" });
    if (parsed.success) return parsed.data;
  }
  const progress = plan.decision.classification === "support"
    ? { kind: "learning_followup", classification: "support", learningObservationId: input.learningObservationId, view: "learning" }
    : { kind: "sensitive_followup", classification: plan.decision.classification, learning: "excluded", view: "sensitive" };
  const parsed = savIntakeProgressSchema.safeParse({ ...progress, messageId: plan.decision.messageId, attemptId: input.attemptId,
    ticketId, requiredStepIds: plan.steps.map(s => s.id), receipts });
  return parsed.success ? parsed.data : processing();
}
