import {
  savIntakeProgressSchema, savIntakeStepReceiptSchema,
  type SavIntakeProgress, type SavIntakeStepReceipt,
} from "./contract";
import { z } from "zod";
import { savIntakePlanFingerprint } from "./engine";
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
  if (!input || typeof input.attemptId !== "string" || !input.attemptId.trim()) return processing();
  if (plan.fingerprint !== savIntakePlanFingerprint(plan)) return processing();
  const disposition = plan.decision.disposition;
  if (disposition.kind === "no_ticket" || disposition.kind === "collect_context") {
    if (input.retry && disposition.kind === "collect_context" && plan.progress.kind !== "human_choice") {
      const parsed = savIntakeProgressSchema.safeParse({ kind: "retry_scheduled", ...input.retry, view: null });
      return parsed.success ? parsed.data : processing();
    }
    return plan.progress;
  }
  const parsedReceipts = z.array(savIntakeStepReceiptSchema).max(20).safeParse(input.receipts);
  if (!parsedReceipts.success) return processing();
  const expectedMutations = disposition.kind === "ticket" ? disposition.requiredPermissions : [disposition.permissionRequired];
  const expectedTicket = disposition.kind === "ticket" && disposition.target.operation !== "create" ? disposition.target.ticketId : null;
  if (plan.steps.length !== expectedMutations.length || plan.steps.some((step, i) => step.mutation !== expectedMutations[i]
    || step.requiresPermission !== expectedMutations[i] || step.ticketId !== expectedTicket
    || step.id !== `${plan.decision.messageId}:${expectedMutations[i]}:${plan.fingerprint}`)) return processing();
  if (new Set(parsedReceipts.data.map(r => r.stepId)).size !== parsedReceipts.data.length) return processing();
  const receipts: SavIntakeStepReceipt[] = [];
  for (const value of parsedReceipts.data) {
    const step = plan.steps.find(s => s.id === value.stepId);
    if (!step || step.mutation !== value.mutation || value.attemptId !== input.attemptId
      || value.messageId !== plan.decision.messageId
      || step.ticketId !== null && value.targetTicketId !== step.ticketId) return processing();
    receipts.push(value);
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
