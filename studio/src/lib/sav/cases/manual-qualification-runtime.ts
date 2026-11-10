import "server-only";
import { requireDb } from "@/db";
import { readConfirmedV1Context } from "./admission-context-reader";
import { readCaseByTicket } from "./case-store";
import { readIntakeExecutionProgress } from "../intake/executor";
import { recordCaseAfterConfirmedIntake, relayPaused } from "./intake-boundary";
import { continueCaseAfterCommit, qualificationRelayBinder, v2EntryRelayDeps } from "./v2-entry";
import type { ManualQualificationPorts } from "./manual-qualification";

export function manualQualificationPorts(env: Record<string, string | undefined>): ManualQualificationPorts {
  return {
    now: () => new Date(), paused: () => relayPaused(requireDb()),
    async target(messageId) {
      const context = await readConfirmedV1Context(messageId);
      const progress = await readIntakeExecutionProgress(messageId);
      if (!context || !progress?.confirmed || progress.state !== "confirmed" || progress.executionId !== context.source.executionId || progress.ticketId !== context.source.ticketId) return null;
      const kase = await readCaseByTicket(context.source.ticketId);
      return kase ? { ...context.source, caseId: kase.caseId } : null;
    },
    eligible: (messageId, target) => qualificationRelayBinder(env)({ messageId, ...target, write: false }),
    async relay(messageId) {
      const result = await recordCaseAfterConfirmedIntake(messageId, v2EntryRelayDeps(env));
      return "caseId" in result ? { caseId: result.caseId, owner: result.owner } : {};
    },
    continue: caseId => continueCaseAfterCommit(caseId, "relay", { env }),
  };
}
