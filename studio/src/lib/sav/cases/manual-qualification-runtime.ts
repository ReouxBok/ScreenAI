import "server-only";
import { requireDb } from "@/db";
import { readConfirmedV1Context } from "./admission-context-reader";
import { readCaseByTicket } from "./case-store";
import { readIntakeExecutionProgress } from "../intake/executor";
import { recordCaseAfterConfirmedIntake, relayPaused, v2HubspotOwnerId } from "./intake-boundary";
import { continueCaseAfterCommit, qualificationRelayBinder, v2EntryRelayDeps } from "./v2-entry";
import { savV2QualificationCaseAllowed } from "./qualification-scope";
import type { ManualQualificationPorts } from "./manual-qualification";

/** `immediateDeadlineMs` (11/11): when the request must be done; a reply queued by the continuation may then be sent at once within it. */
export function manualQualificationPorts(env: Record<string, string | undefined>, options: { immediateDeadlineMs?: number } = {}): ManualQualificationPorts {
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
      const deps = v2EntryRelayDeps(env);
      const result = await recordCaseAfterConfirmedIntake(messageId, deps);
      if (!("caseId" in result) || result.owner !== "agent") return {};
      const scoped = await savV2QualificationCaseAllowed(env, result.caseId);
      if (!scoped.allowed) {
        // A new qualification revision has no binding yet. The ordinary relay intentionally
        // does not re-attribute a case already owned by the agent. This operator-only path
        // may bind that SAME case, after fresh source/owner/pause checks, without moving it.
        if (scoped.reason !== "qualification_thread_unbound") return {};
        const context = await readConfirmedV1Context(messageId);
        const ownerId = v2HubspotOwnerId(env);
        if (!context || !ownerId || await relayPaused(requireDb())) return {};
        const { source } = context;
        const before = await readCaseByTicket(source.ticketId);
        if (!before || before.caseId !== result.caseId || before.owner !== "agent") return {};
        let owner: string | null | undefined;
        try { owner = await deps.readCreatedTicketOwner?.(source.ticketId); } catch { return {}; }
        if (owner !== ownerId) return {};
        const current = await readCaseByTicket(source.ticketId);
        if (!current || current.caseId !== before.caseId || current.owner !== "agent" || await relayPaused(requireDb())) return {};
        if (!await qualificationRelayBinder(env)({ messageId, ticketId: source.ticketId, executionId: source.executionId,
          runId: source.runId, runVersion: source.runVersion, write: true })) return {};
        if (!(await savV2QualificationCaseAllowed(env, result.caseId)).allowed) return {};
      }
      return { caseId: result.caseId, owner: result.owner };
    },
    continue: caseId => continueCaseAfterCommit(caseId, "relay", { env, ...(options.immediateDeadlineMs === undefined ? {} : { immediateDeadlineMs: options.immediateDeadlineMs }) }),
  };
}
