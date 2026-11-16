// SAV-92: the production ports of a Studio reply decision, the SAME as the V2 effects run's (`v2-effects-binding.ts`): the CRM owner read, the admission policy
// revision, the pilot provenance gate, and the immediate send of the ONE executor. No transport, context or authorizer can be injected here.
import "server-only";
import { admissionPolicyRevisionPort } from "./admission-runtime";
import type { CaseReplyReviewDeps } from "./case-reply-review";
import { createCaseTicketOwnerPort } from "./case-v2-wake-ports";
import { caseProvenanceReaders } from "./investigation-pilot-readers";
import { pilotProvenanceGate } from "./pilot-passage-provenance";
import { readV2EntryPolicyRecord } from "./v2-entry";
import { sendQueuedCaseReplyNow } from "./v2-effects-binding";

export function caseReplyReviewDeps(input: Readonly<{ env: Record<string, string | undefined>; callerDeadlineMs: number }>): CaseReplyReviewDeps {
  const env = () => input.env, readPolicyRecord = async () => readV2EntryPolicyRecord(input.env);
  return {
    env, callerDeadlineMs: input.callerDeadlineMs, sendNow: sendQueuedCaseReplyNow,
    store: {
      env, readTicketOwner: createCaseTicketOwnerPort({ env }),
      currentPolicyRevision: admissionPolicyRevisionPort({ read: readPolicyRecord, now: () => new Date() }),
      pilotProvenance: pilotProvenanceGate(caseProvenanceReaders({ env, readPolicyRecord })),
    },
  };
}
