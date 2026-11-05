// V2 proven resolution (local, OFF): the ONLY way a V2 case ends `resolved`, and the only way a ticket is closed by V2.
// The trigger is read from the STORED case, never from a caller: the latest investigation record holds an ACCEPTED `confirm_resolution` (the validator proved the customer's
// own words, in a mail after the agent's last step, with no human reply in between) AND the second, independent reading of that closure is `soft_close`. Nothing newer has
// happened to the case (a customer mail, an investigation, a person's command, an owner change), the agent still owns it, it is not sensitive, no pause is on, and every request
// that was open is among the resolved ones. Anything else (a thanks for the transfer, `ask_confirmation`, an unreadable second reading, a handoff, a timeout) closes nothing.
// A person who took the ticket in the CRM stops it here: the owner is read now, before anything is written, and an unreadable owner holds it for the next sweep.
// What it writes: the case cycle ends `resolved` (requests resolved, wait cleared, the cited trials succeeded, the other pending trials of those requests « unknown »), then the « closed » stage of the ticket is queued for the ticket-stage pass. No message is
// sent here. The case write and the queue entry commit together or not at all; a replay finds the same state and the same execution.
import "server-only";
import { requireDb } from "@/db";
import { nextSweepPage } from "./case-sweep-cursor";
import { readSavAgentPause, savAgentPauseCode } from "../intake/agent-pause";
import { caseAdmissionStatus } from "./admission-policy";
import { judgeCurrentTicketOwner, type CaseTicketOwnerPort } from "./case-ticket-owner";
import { caseDecisionAttachmentMail, type CaseDecisionProposal } from "./decision-contract";
import { enqueueCaseTicketStage, type EnqueueTicketStageResult } from "./case-ticket-stage-queue";
import { SAV_CASE_INVESTIGATION_RECORD_KIND, readCaseInvestigationProgress } from "./investigation-record";
import { listCaseEvents, lockCaseForWrite, readCase, updateCaseRecord } from "./case-store";
import type { CaseBody, CaseEvent } from "./case-types";
import { readCaseTicketStageConfig } from "./customer-return";

/** Events after the decision that make it no longer the final word. */
const STALE_EVENT_KINDS = ["inbound_confirmed", "observation_recorded", "human_command", "owner_changed"] as const;

export type ProvenResolutionRefusal =
  | "stages_off" | "case_unknown" | "no_record" | "no_decision" | "not_accepted" | "not_confirm_resolution" | "closure_not_soft" | "stale_input" | "owner_not_agent" | "sensitive"
  | "paused" | "not_admitted" | "requests_still_open" | "decided_while_paused" | "version_moved" | "already_ended_otherwise" | (string & {});
export type ApplyProvenResolutionResult =
  | Readonly<{ ok: true; applied: "resolved" | "already_resolved"; cycle: number; stage: EnqueueTicketStageResult }>
  | Readonly<{ ok: false; code: ProvenResolutionRefusal }>;

const no = (code: ProvenResolutionRefusal): ApplyProvenResolutionResult => ({ ok: false, code });

async function journal(caseId: string) {
  const events = [];
  for (let page = await listCaseEvents(caseId, { limit: 500 }); page.length; page = await listCaseEvents(caseId, { afterVersion: page.at(-1)!.caseVersion, limit: 500 })) {
    events.push(...page);
    if (page.length < 500) break;
  }
  return events;
}

/** What the closing proof says about the trials: each cited one succeeded, on the customer's quoted words and the date of their mail; any other pending trial of a resolved request stays unproven (`unknown`). */
export function trialsAfterResolution(trials: CaseBody["trials"], action: Extract<CaseDecisionProposal["nextAction"], { kind: "confirm_resolution" }>, events: readonly Pick<CaseEvent, "direction" | "sourceRef" | "occurredAt">[], learntAt: string): CaseBody["trials"] {
  const resolved = new Set(action.requestIds);
  const dateOf = (source: (typeof action.evidence)[number]["source"]) => {
    const mail = caseDecisionAttachmentMail(source);
    return events.find(event => event.direction === "customer_inbound" && (mail ? event.sourceRef.type === "email" && event.sourceRef.id === mail : event.sourceRef.type === source.type && event.sourceRef.id === source.id))?.occurredAt ?? learntAt;
  };
  return trials.map(trial => {
    const cited = action.evidence.find(row => row.trialId === trial.id && row.requestId === trial.requestId);
    if (cited) return { ...trial, outcome: "succeeded" as const, resultAt: dateOf(cited.source), result: { text: cited.quote, source: cited.source } };
    return trial.outcome === "pending" && resolved.has(trial.requestId) ? { ...trial, outcome: "unknown" as const } : trial;
  });
}

/**
 * `currentPolicyRevision`: the admission policy revision in force now (the port every V2 actor uses); a case admitted under another one is not closed by V2.
 * `readTicketOwner`: REQUIRED, the CRM owner read now. Absent, failing, or anything but the pilot: nothing is written.
 */
export type ResolutionPorts = Readonly<{ policy: Readonly<{ id: string; hash: string }>; env: () => Record<string, string | undefined>; currentPolicyRevision: () => Promise<string | null>; readTicketOwner: CaseTicketOwnerPort | undefined }>;

export async function applyProvenResolution(input: ResolutionPorts & Readonly<{ caseId: string }>): Promise<ApplyProvenResolutionResult> {
  const config = readCaseTicketStageConfig(input.env());
  if (config.mode !== "on") return no("stages_off");
  const snapshot = await readCase(input.caseId);
  if (!snapshot) return no("case_unknown");
  const events = await journal(snapshot.caseId);
  const latest = events.filter(event => event.kind === "observation_recorded" && (event.detail?.record as { kind?: unknown } | undefined)?.kind === SAV_CASE_INVESTIGATION_RECORD_KIND)
    .sort((a, b) => b.caseVersion - a.caseVersion)[0];
  const inputKey = (latest?.detail?.record as { inputKey?: unknown } | undefined)?.inputKey;
  if (!latest || typeof inputKey !== "string") return no("no_record");
  if (latest.detail?.applied === false) return no("stale_input");
  const read = readCaseInvestigationProgress(events, inputKey);
  if (read.state !== "found" || read.caseVersion !== latest.caseVersion) return no("no_record");
  const decision = read.record.decision;
  if (!decision) return no("no_decision");
  if (decision.validation.outcome !== "accepted") return no("not_accepted");
  const action = decision.validation.decision.nextAction;
  if (action.kind !== "confirm_resolution") return no("not_confirm_resolution");
  if (decision.closure?.plan !== "soft_close" || decision.closure.reason !== "checked") return no("closure_not_soft");
  if (decision.actionsPaused) return no("decided_while_paused");
  // Already ended on this proof: only the ticket stage may still be missing.
  const ended = snapshot.phase === "resolved" && snapshot.body.cycle.endedBy === "resolved";
  if (!ended && events.some(event => event.caseVersion > read.caseVersion && (STALE_EVENT_KINDS as readonly string[]).includes(event.kind))) return no("stale_input");
  if (snapshot.owner !== "agent") return no("owner_not_agent");
  if (snapshot.sensitivity !== "none") return no("sensitive");
  for (const agent of ["intake", "v2"] as const) if (savAgentPauseCode(await readSavAgentPause(requireDb(), agent))) return no("paused");
  const resolvedIds = new Set(action.requestIds);
  if (!ended && snapshot.body.openRequests.some(request => request.status === "open" && !resolvedIds.has(request.id))) return no("requests_still_open");
  if (snapshot.phase === "resolved" && !ended) return no("already_ended_otherwise");

  // Only for a closure still to apply: an ended case has no write left but its queue entry, which the stage pass judges against the owner at every marker.
  if (!ended) {
    const owner = await judgeCurrentTicketOwner(input.readTicketOwner, snapshot.ticketId);
    if (!owner.ok) return no(owner.code);
  }
  const revision = await input.currentPolicyRevision();
  return requireDb().transaction(async (tx): Promise<ApplyProvenResolutionResult> => {
    // Optimistic read, judged under the lock: if anything was written to the case since the journal was read, nothing is applied now (the next sweep decides again).
    const locked = await lockCaseForWrite(tx, snapshot.caseId);
    if (locked.version !== snapshot.version) return no("version_moved");
    let current = locked;
    if (!ended) {
      if (!caseAdmissionStatus(locked, revision).admitted) return no("not_admitted");
      const body = {
        ...locked.body,
        openRequests: locked.body.openRequests.map(request => request.status === "open" && resolvedIds.has(request.id) ? { ...request, status: "resolved" as const } : request),
        trials: trialsAfterResolution(locked.body.trials, action, events, latest.occurredAt),
        waiting: null, cycle: { ...locked.body.cycle, endedBy: "resolved" as const },
      };
      current = await updateCaseRecord({ caseId: locked.caseId, expectedVersion: locked.version, actor: { type: "agent" }, body, phase: "resolved" }, tx);
    }
    const stage = await enqueueCaseTicketStage(tx, { snapshot: current, trigger: { kind: "resolution_recorded", cycle: current.body.cycle.number }, policy: input.policy, env: input.env });
    return { ok: true, applied: ended ? "already_resolved" : "resolved", cycle: current.body.cycle.number, stage };
  });
}

export type ProvenResolutionSweepResult = Readonly<{ examined: number; resolved: number; already: number; refused: Readonly<Record<string, number>>; windowEnded: boolean; stoppedByDeadline: boolean }>;
/** The safety net: the cases touched since `since` are read again, at most `limit` per call from a durable cursor (no case is starved), so a proven resolution is applied (or its ticket stage queued) even if the first call never happened. One unique key per closure: a case read twice closes once. */
export async function applyProvenResolutions(input: ResolutionPorts & Readonly<{ since: Date; limit?: number; deadlineMs?: number; now?: () => number }>): Promise<ProvenResolutionSweepResult> {
  const page = await nextSweepPage({ name: "resolution", since: input.since, limit: input.limit ?? 50 });
  let resolved = 0, already = 0;
  const refused: Record<string, number> = {};
  let handled = 0;
  for (const id of page.ids) {
    if (input.deadlineMs !== undefined && (input.now ?? Date.now)() >= input.deadlineMs) break;
    const result = await applyProvenResolution({ caseId: id, policy: input.policy, env: input.env, currentPolicyRevision: input.currentPolicyRevision, readTicketOwner: input.readTicketOwner });
    if (result.ok) { if (result.applied === "resolved") resolved++; else already++; } else refused[result.code] = (refused[result.code] ?? 0) + 1;
    handled++;
  }
  await page.commit(handled);
  return { examined: handled, resolved, already, refused, windowEnded: page.windowEnded && handled === page.ids.length, stoppedByDeadline: handled < page.ids.length };
}
