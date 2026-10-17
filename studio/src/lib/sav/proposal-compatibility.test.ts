import { describe, expect, it } from "vitest";
import { savRollbackCompatibleProposal } from "./proposal-compatibility";
import { savStructuredProposalSchema, savReplyAssessmentSchema } from "./proposal";
import { savUnderstandingSchema } from "./understanding";
import { savSemanticE2eProposal } from "../../../test/sav-semantic-e2e-fixture";

// These strict shapes represent the previous contract's lack of the new fields.
const oldUnderstanding = savUnderstandingSchema.extend({ trace: savUnderstandingSchema.shape.trace.omit({ validationDiagnostics: true, validationRecovery: true }).strict() });
const oldReply = savReplyAssessmentSchema.omit({ validationDiagnostics: true, recovery: true, coherenceAttempts: true }).strict();
const oldProposal = savStructuredProposalSchema.extend({ understanding: oldUnderstanding.optional(), replyAssessment: oldReply.optional() });
describe("business snapshot rollback compatibility", () => {
  it("keeps the full draft/understanding/history readable by the previous strict contract", () => {
    const proposal = savSemanticE2eProposal();
    proposal.understanding!.trace.validationDiagnostics = [];
    proposal.understanding!.trace.validationRecovery = { attempted: true, succeeded: true, errorCode: null };
    proposal.replyAssessment!.recovery = { strategy: "investigation", originalErrorCode: "SAV_REPLY_COHERENCE_REJECTED", validated: true };
    proposal.replyAssessment!.coherenceAttempts = [];
    expect(oldProposal.safeParse(proposal).success).toBe(false);
    const persisted = savRollbackCompatibleProposal(proposal);
    expect(oldProposal.safeParse(persisted).success).toBe(true);
    expect(persisted.replyDraft).toBe(proposal.replyDraft);
    expect(persisted.understanding?.requests).toEqual(proposal.understanding?.requests);
    expect(proposal.understanding!.trace.validationRecovery?.succeeded).toBe(true);
  });
});
