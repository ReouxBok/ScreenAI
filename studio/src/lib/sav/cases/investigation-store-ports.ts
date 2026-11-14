import { requireDb } from "@/db";
import type { CaseAdmissionInput } from "./admission-policy";
import {
  CaseVersionStaleError, claimCaseForDecision, listCaseEvents, listCaseIdsForPolicyRevalidation, readCase, recordCaseObservation, reevaluateCaseAdmission,
  releaseCaseClaim, revalidateCaseAdmissionForPolicy, transitionCaseOwner,
} from "./case-store";
import type { CaseEvent, CaseSnapshot, SourceRef } from "./case-types";
import { caseInvestigationObservationRecord, investigationHandoffCommand, readCaseInvestigationProgress } from "./investigation-record";
import { isCaseQualificationUnavailable, serializeCaseQualificationUnavailable, type CaseQualificationUnavailable } from "./qualification-diagnostic";
import type { CaseAdmissionSweepPorts } from "./investigation-policy-sweep";
import type { CaseInvestigationClaimRefusal, CaseInvestigationPorts, CaseInvestigationProgress, CaseInvestigationRecord } from "./investigation-runner";

/*
 * SAV-7 ports on the pole A case store (contract v6): case read, admission re-evaluation, claim, and the single
 * observation that ends a claim. No table, no ledger and no copy of the case of its own. Everything outside the
 * store (pause, knowledge, customer texts, revisions, the model dispatcher, the clock) is passed in as is.
 * One ports object per run: it keeps the claim's pending progress and decision until `release` writes them.
 */

export type CaseInvestigationStoreDeps = Pick<CaseInvestigationPorts, "scope" | "pauseState" | "knowledge" | "customerTexts" | "revisions" | "callModel" | "now" | "callSignal" | "readTicketOwner"> & {
  /** Claim holder code, e.g. `sav-v2-investigation`. */
  holder: string;
  ttlSeconds?: number;
  admissionPolicyRevision(): Promise<string | null>;
  /**
   * Q10: the qualification of the latest input by the approved rules (`qualified_rule` provenance), with the policy
   * and the source it is decided on; null when no approved rule qualifies it, which hands the case to the team. A rule
   * that cannot run (CRM unreadable...) must throw, never answer null. It reads the case only: it is never given a
   * model output, so no model can admit a case.
   */
  qualify(snapshot: CaseSnapshot, events: readonly CaseEvent[]): Promise<{ admission: CaseAdmissionInput; sourceRef: SourceRef } | null>;
  /**
   * Optional, after the claim's one observation that carried a DECISION is persisted: the only trigger of the human handoff notice (`case-handoff-notice-store.ts`
   * `enqueueHandoffNotice`, which re-reads the stored case and decides for itself whether this decision is a final handoff). It runs after the write, outside it, and a failure
   * is swallowed: the decision is already durable, and the notice sweep (`enqueueHandoffNotices`) admits whatever this hook missed. Absent: nothing changes.
   */
  afterDecisionRecorded?(caseId: string): Promise<void>;
};

/** Pole A refusals, as the runner reads them. Everything about admission keeps the case with the team. */
const CLAIM_REFUSALS: Record<string, CaseInvestigationClaimRefusal> = {
  claimed_elsewhere: "busy", inbound_settling: "settling", agent_paused: "paused",
  owner_not_agent: "admission", no_admission: "admission", not_admitted: "admission", input_newer: "admission", policy_missing: "admission", policy_changed: "admission",
};

async function readJournal(caseId: string) {
  const events: CaseEvent[] = [];
  for (let page = await listCaseEvents(caseId, { limit: 500 }); page.length; page = await listCaseEvents(caseId, { afterVersion: page.at(-1)!.caseVersion, limit: 500 })) {
    events.push(...page);
    if (page.length < 500) break;
  }
  return events;
}

/** A6's closed fields of a refusal A6 itself made, or null: an unclassified error, or a branded one A6's serializer refuses. */
function typedQualificationRefusal(error: unknown): CaseQualificationUnavailable | null {
  if (!isCaseQualificationUnavailable(error)) return null;
  try { return serializeCaseQualificationUnavailable(error); } catch { return null; }
}

export function caseInvestigationStorePorts(deps: CaseInvestigationStoreDeps): CaseInvestigationPorts {
  let policyRevision: string | null = null;
  let pending: { inputKey: string; progress: CaseInvestigationProgress } | null = null, decision: CaseInvestigationRecord | null = null;
  return {
    scope: deps.scope, pauseState: deps.pauseState, knowledge: deps.knowledge, customerTexts: deps.customerTexts, revisions: deps.revisions, callModel: deps.callModel, now: deps.now,
    ...(deps.callSignal === undefined ? {} : { callSignal: deps.callSignal }),
    ...(deps.readTicketOwner === undefined ? {} : { readTicketOwner: deps.readTicketOwner }),
    readCase: async caseId => {
      const snapshot = await readCase(caseId);
      return snapshot ? { snapshot, events: await readJournal(caseId) } : null;
    },
    admissionPolicyRevision: async () => (policyRevision = await deps.admissionPolicyRevision()),
    reevaluateAdmission: async snapshot => {
      const events = await readJournal(snapshot.caseId);
      // OBS1: a rule that cannot run is a technical gap, never « unqualified »: no handoff, no admission write, nothing kept.
      // B7: pole A6's typed refusal is passed on through A6's own guard and serializer; the error itself never is.
      let qualified: Awaited<ReturnType<CaseInvestigationStoreDeps["qualify"]>>;
      try { qualified = await deps.qualify(snapshot, events); } catch (error) { return { unavailable: typedQualificationRefusal(error) }; }
      try {
        if (qualified) {
          await reevaluateCaseAdmission({ caseId: snapshot.caseId, expectedVersion: snapshot.version, ...qualified });
          return "reevaluated";
        }
        // Q10: what no approved rule qualifies is out of scope and goes to the team, once per version (the command key
        // dedupes a replay). A pole A exit reason, counted as a business transfer in the Q11 measure.
        await transitionCaseOwner({ caseId: snapshot.caseId, expectedVersion: snapshot.version, transition: "handoff", actor: { type: "agent" },
          commandKey: `q10-unqualified-${snapshot.caseId}-v${snapshot.version}`, reason: "out_of_scope" });
        return "handed_off";
      } catch (error) {
        if (error instanceof CaseVersionStaleError) return "version_moved";
        throw error;
      }
    },
    claim: async (caseId, caseVersion) => {
      try {
        const claimed = await claimCaseForDecision({ caseId, expectedVersion: caseVersion, holder: deps.holder, currentPolicyRevision: policyRevision, ttlSeconds: deps.ttlSeconds ?? 300, now: deps.now() });
        if (claimed.claimed) return { token: claimed.claim.token, actionsPaused: claimed.actionsPaused };
        return { refused: CLAIM_REFUSALS[claimed.reason] ?? "admission", ...(claimed.retryAt === undefined ? {} : { retryAt: claimed.retryAt }) };
      } catch (error) {
        if (error instanceof CaseVersionStaleError) return { refused: "busy" };
        throw error;
      }
    },
    progress: {
      load: async (caseId, inputKey) => {
        const read = readCaseInvestigationProgress(await readJournal(caseId), inputKey);
        // Never a fresh start over an unreadable record: the run fails and stays visible.
        if (read.state === "unreadable") throw Error("SAV_CASE_INVESTIGATION_PROGRESS_UNREADABLE");
        return read.state === "found" ? read.record.progress : null;
      },
      save: async (_caseId, inputKey, progress) => { pending = { inputKey, progress: structuredClone(progress) }; },
    },
    record: async record => { decision = structuredClone(record); },
    // The claim ends with exactly one observation carrying progress and decision; with nothing to keep, a plain release.
    release: async (caseId, token) => {
      const kept = pending;
      pending = null;
      if (!kept) { await releaseCaseClaim({ caseId, claimToken: token }); return; }
      const record = caseInvestigationObservationRecord(kept.inputKey, kept.progress, decision);
      const decided = decision !== null;
      const action = decision?.validation.outcome === "accepted" ? decision.validation.decision.nextAction : null;
      // An accepted handoff, or (Ugo 14/11) a decision the validator refused twice: the same durable transfer to the team, then the same notice.
      const handoffReason = action?.kind === "handoff" ? action.reason : decision?.validation.outcome === "needs_review" ? decision.refusalHandoff?.reason ?? null : null;
      decision = null;
      try {
        const observation = { caseId, claimToken: token, currentPolicyRevision: policyRevision, observation: { record } };
        if (handoffReason) {
          // The team owns the case even when Slack is off or unavailable. A stale or replayed
          // observation must never take the case away from its current owner.
          await requireDb().transaction(async tx => {
            const saved = await recordCaseObservation({ ...observation, requireLiveClaimAt: deps.now }, tx);
            if (saved.applied && !saved.replayed) {
              await transitionCaseOwner({ caseId, expectedVersion: saved.case.version, transition: "handoff",
                actor: { type: "agent" }, commandKey: investigationHandoffCommand(saved.case.version), reason: handoffReason }, tx);
            }
          });
        } else {
          await recordCaseObservation(observation);
        }
      } catch (error) {
        // Pole A clears the claim when the case leaves the agent (a person takes it, a hold, a withdrawal, a full memory):
        // nothing may be written then, and the runner has already seen the version move. The calls stay in the ledger.
        // Any other lost claim (an expired TTL) stays a visible failure.
        if (error instanceof Error && error.message === "SAV_CASE_CLAIM_LOST" && (await readCase(caseId))?.owner !== "agent") return;
        throw error;
      }
      if (decided && deps.afterDecisionRecorded) {
        try { await deps.afterDecisionRecorded(caseId); } catch { /* the decision is durable; the notice sweep admits it later */ }
      }
    },
  };
}

/**
 * Ports of the policy-change sweep on the pole A store (contract v8): its list of agent cases admitted under another
 * revision, its case read, and its revalidation, which re-decides with the recorded qualification under lock. The
 * pause, the policy pointer, the approved policy and the switch are passed in.
 */
export function caseAdmissionSweepStorePorts(deps: Omit<CaseAdmissionSweepPorts, "listCases" | "readCase" | "revalidate">): CaseAdmissionSweepPorts {
  return {
    ...deps,
    listCases: listCaseIdsForPolicyRevalidation,
    readCase,
    revalidate: async (snapshot, policy) => {
      try {
        return (await revalidateCaseAdmissionForPolicy({ caseId: snapshot.caseId, expectedVersion: snapshot.version, policy })).revalidated ? "revalidated" : "refused";
      } catch (error) {
        if (error instanceof CaseVersionStaleError) return "version_moved";
        throw error;
      }
    },
  };
}
