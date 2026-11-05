import type { SavRetrievalCandidate } from "../request-retrieval";
import { SAV_CASE_HOLDS_KEEPING_TIMERS, type CaseEvent, type CaseSnapshot, type SourceRef } from "./case-types";
import { buildCaseDecisionContext, type CaseDecisionContextProblem } from "./decision-context";
import { caseAccessScopeStamp, readCaseAccessScope, type CaseAccessScope, type CaseAccessScopeStamp } from "./investigation-access-scope";
import { caseAdmissionStatus } from "./admission-policy";
import type { CaseDecisionRejection, CaseDecisionValidation } from "./decision-contract";
import { caseDecisionRefusalKinds, classifyCaseDecisionRefusal, type CaseDecisionRefusal, type CaseDecisionRefusalKind } from "./decision-recovery";
import { caseModelLoginHistory, validateCaseDecision } from "./decision-validator";
import { caseClosureItems, caseClosurePlan, type CaseClosureCheck, type CaseClosureItem, type CaseClosurePlan } from "./investigation-closure";
import { caseCallSignal, type CaseCallSignal, type CaseCallSignalConfig } from "./investigation-call-signal";
import { caseInvestigationGate, type CaseInvestigationGateReason } from "./investigation-gate";
import { caseReplyTriggerOf } from "./investigation-intent";
import type { CaseKnowledgeCoverage } from "./decision-contract";
import type { CaseKnowledgeRead, CaseKnowledgeRequestProblem } from "./investigation-knowledge";
import type { CaseQualificationUnavailable } from "./qualification-diagnostic";

/*
 * SAV-7 investigation in observation (local sub-lot 1). The flow only: every read, lease, model
 * call and write goes through ports whose real adapters do not exist yet (see the SAV-7 report).
 * There is deliberately no effect port: an observed decision can never send, write CRM or post.
 * No retry engine and no budget of its own: deferral, transient retry and uncertain usage belong to
 * the existing intake ledger and dispatcher, reached through the `callModel` adapter.
 * Calls are counted per input (Ugo, 27/10/2026): only a new customer message, or the case given back to the
 * agent, opens a new budget; a CRM note or a timer bumps the case version but not the count.
 * Resumption is bounded, never a reset: the calls already made for this input (read from the `progress`
 * port) count against the same ceiling, and an uncertain call blocks any new one until verified.
 * Every wait is stored with its reason and start time, so that no case can wait unseen (see investigation-waits).
 * The V2 pause is read again before every model call. The same refusal twice in a row stops the corrections.
 * A closure gets a second, independent reading before it is planned (investigation-closure).
 */

/** At most three calls per input, the ceiling given by SAV-7. The closure reading uses one of them. */
export const SAV_CASE_INVESTIGATION_MAX_CALLS = 3;

export type CaseInvestigationMode = "off" | "observe";
export type CaseInvestigationCallPurpose = "decision" | "resolution_check";

/** What the model adapter receives: the case read, the knowledge, and the rejections of the previous call. */
export type CaseInvestigationModelRequest = {
  purpose: CaseInvestigationCallPurpose;
  caseId: string; caseVersion: number; inputKey: string; call: number;
  /** Ledger subject of this input (`sav-case:<case>:<input>`): the shared ledger caps its calls, so a run that
   * crashed after a call and lost its progress still cannot exceed the ceiling. */
  subjectKey: string;
  /** This call within the subject (`<subject>:call<n>`). */
  callKey: string;
  /** Whole case (`sav-case:<case>`): the shared ledger also caps the calls of one case over a sliding window, so a
   * customer who writes many messages cannot multiply the per-input ceiling without bound (Ugo, 28/10). */
  caseBudgetKey: string;
  snapshot: CaseSnapshot; events: readonly CaseEvent[]; knowledge: SavRetrievalCandidate[];
  customerReportedLogin?: ReturnType<typeof caseModelLoginHistory>;
  /** Per open request: the cards retrieved for it, or why there are none (`selectCaseKnowledge`). Null when the
   * knowledge port gives a plain list. A request `no_applicable_knowledge` calls for a targeted question or a handoff. */
  coverage: CaseKnowledgeCoverage[] | null;
  /** Codes, paths and our own fixed labels of the previous rejections; never free text from the model. */
  feedback: Array<Pick<CaseDecisionRejection, "code" | "label" | "path" | "detail"> & { kind: CaseDecisionRefusalKind }>;
  /** `resolution_check` only: the requests the decision closes, with the quoted customer words. */
  closure: CaseClosureItem[];
};

export type CaseInvestigationModelResult =
  /** Budget unavailable before dispatch: nothing was consumed. */
  | { status: "deferred" }
  | { status: "ok"; output: unknown }
  /** `uncertain`: the provider may have run it; it is verified, never repeated. */
  | { status: "failed"; uncertain: boolean }
  /** The shared ledger already holds every call allowed for this subject (calls whose results were lost in a
   * crash): nothing was dispatched, and no further call is possible for this input. */
  | { status: "subject_exhausted" }
  /** The case reached its ceiling for the window: nothing was dispatched, the input keeps its calls until `retryAt`. */
  | { status: "case_budget_exhausted"; retryAt: string };

export type CaseInvestigationRevisions = { rules: string; playbookId: string; model: string; prompt: string };

/** One line per model call, kept so that a refusal recovered by a correction stays measurable. */
export type CaseInvestigationAttempt =
  | { call: number; result: "validated"; outcome: CaseDecisionValidation["outcome"]; kinds: CaseDecisionRefusalKind[]; codes: string[] }
  | { call: number; result: "checked"; plan: CaseClosurePlan }
  | { call: number; result: "failed"; purpose: CaseInvestigationCallPurpose; uncertain: boolean };

/**
 * Why an investigation is not progressing. `usage_uncertain`: the last call may have run at the provider,
 * nothing new until the ledger has verified it. `technical_exhausted`: every allowed call failed, only a person
 * can unblock it. `paused`: the V2 pause stopped it between two calls. `decision_refused`: the decision stayed
 * refused after the allowed corrections; it goes to the team with its report, never left with the agent.
 * `context_invalid`: the decision context could not be built from the case; no generation call is made and a person
 * looks at it. `problem` is the closed reason code (never a raw message); `embeddingCalls` the embedding calls the
 * knowledge search of that run already sent, when known. `knowledge_changed` (B5): the knowledge revision moved, or
 * could not be read, after the search; nothing was called or recorded on it, and the next run searches again. Its
 * `problem` is `revision_moved` or `revision_unreadable`, never a revision id.
 */
export type CaseInvestigationWaitReason = "deferred_budget" | "case_budget" | "technical_wait" | "usage_uncertain" | "technical_exhausted" | "paused" | "decision_refused" | "context_invalid" | "knowledge_request_invalid" | "knowledge_changed";
export type CaseKnowledgeChangedProblem = "revision_moved" | "revision_unreadable";
export type CaseInvestigationWait = { reason: CaseInvestigationWaitReason; since: string; caseVersion: number; problem?: CaseDecisionContextProblem | CaseKnowledgeChangedProblem; embeddingCalls?: number };

/** Calls already made for one input, as stored between runs. No customer text beyond the last proposal. */
export type CaseInvestigationProgress = {
  modelCalls: number; attempts: CaseInvestigationAttempt[];
  /** Null while progressing; otherwise the current wait, kept with its first start time. */
  waiting: CaseInvestigationWait | null;
  /** Last model proposal and the version it was made on: re-validated on every run, never trusted as is. */
  proposal: { output: unknown; proposedOn: number } | null;
  last: CaseDecisionValidation | null;
  /** Second reading of the accepted closure, so that it is not paid twice. */
  closure: CaseClosureCheck | null;
  /** Case version the decision of this input was recorded at; after that, a run for the same input never calls. */
  recordedOn: number | null;
};

export type CaseInvestigationFlags = {
  /** The model found a finance/cancellation/sensitive request the intake classification missed: a V1 miss to count. */
  sensitiveFoundByModel: boolean;
  /** Never used for any future learning. */
  learningExcluded: boolean;
  /** Corrections stopped because the same refusal came back twice in a row. */
  sameRefusalRepeated: boolean;
};

export type CaseInvestigationRecord = {
  caseId: string; caseVersion: number; inputKey: string; leaseToken: string; mode: "observe";
  validation: CaseDecisionValidation; refusal: CaseDecisionRefusal | null; closure: CaseClosureCheck | null;
  flags: CaseInvestigationFlags; attempts: CaseInvestigationAttempt[];
  modelCalls: number; revisions: CaseInvestigationRevisions;
  knowledge: Array<{ knowledgeId: string; contentVersionId: string }>;
  /** Provenance of the knowledge: the revision searched and, per request, what was found (null: plain list given). */
  knowledgeRevision: string | null;
  /** `limitations`: fixed codes only (why a request was `not_searched`, e.g. `subject_unavailable`), for the console. */
  coverage: Array<Pick<CaseKnowledgeCoverage, "requestId" | "status" | "knowledge" | "limitations">> | null;
  /** Pilot ACCÈS: the scope this decision was validated under. Absent: no pilot scope (a pilot consumer then refuses it). */
  accessScope?: CaseAccessScopeStamp;
  /**
   * Decided while V2 actions were paused (the claim's reading under lock, or any reading during the run): this decision
   * may not become an effect while the pause lasts. It is a trace for the console and the executor, not a permission:
   * whoever acts re-reads the pause live (`assertSavAgentActionsAllowed`), since it may be set after the decision.
   */
  actionsPaused: boolean;
  /** P1 (Ugo 28/10, option c): calls of this case over the window, flagged above the threshold, never blocking. Null when not configured. */
  callSignal: CaseCallSignal | null;
};

export type CaseInvestigationPauseLevel = "running" | "actions_paused" | "fully_paused";
/** Fail closed: only these two levels let an analysis run. */
export const caseInvestigationAnalysisAllowed = (level: string) => level === "running" || level === "actions_paused";
const analysisAllowed = caseInvestigationAnalysisAllowed;

export type CaseInvestigationPorts = {
  /** Knowledge scope used for validity, as for intake retrieval. */
  scope: { locale: string; audience: string };
  /**
   * SAV agent pause for V2, with the levels of `sav-agent-pause.v1:v2` (`intake/agent-pause.ts`); an unreadable setting
   * must answer `fully_paused`, as that reader does. `actions_paused`: the analysis goes on, but no admission write and
   * no external effect; `fully_paused`: no claim, no call. Any other value is read as `fully_paused`.
   */
  pauseState(): Promise<CaseInvestigationPauseLevel>;
  readCase(caseId: string): Promise<{ snapshot: CaseSnapshot; events: CaseEvent[] } | null>;
  /** Revision of the approved admission policy, null when none is approved (then nobody is admitted). The freshness
   * rule itself is pole A's `caseAdmissionStatus`, applied here to the snapshot and again under lock by the claim. */
  admissionPolicyRevision(): Promise<string | null>;
  /**
   * Q10 (Ugo, 28/10): after a new input, the admission is re-evaluated automatically by the approved rules, with no
   * repeated human validation (pole A `reevaluateCaseAdmission` on `snapshot.version`). The qualification comes from
   * approved rules only, never from a model output: this port receives no proposal. A case they do not admit (sensitive,
   * out of scope, unproven) is withdrawn to the team by pole A with its reason. Called only for an agent-owned case
   * staled by a newer input: a human owner stays human, a policy change is the sweep's (`investigation-policy-sweep.ts`).
   * `handed_off`: no approved rule qualifies this input, so it is out of the agent's scope: the port handed the case to
   * the team (`out_of_scope`) instead of leaving it with the agent, stale and unseen. `version_moved`: re-queue.
   * `qualification_unavailable` (B5, OBS1): the approved rules could not run (the qualification threw): a technical
   * gap, never « unqualified »; nothing was written, no handoff, and the case is retried on a later run. `unavailable`
   * (B7): the same, with pole A6's closed fields when A6 typed the refusal (null otherwise).
   */
  reevaluateAdmission(snapshot: CaseSnapshot): Promise<"reevaluated" | "handed_off" | "version_moved" | "qualification_unavailable" | { unavailable: CaseQualificationUnavailable | null }>;
  /** Exclusive lease on this case version (pole A `claimCaseForDecision`), or why it was refused. */
  /** `actionsPaused`: pole A's own pause reading, under the case lock, when it granted the claim. */
  claim(caseId: string, caseVersion: number): Promise<{ token: string; actionsPaused: boolean } | { refused: CaseInvestigationClaimRefusal; retryAt?: string }>;
  release(caseId: string, token: string): Promise<void>;
  /**
   * Published, applicable knowledge for the case: a plain list, or the per-request selection (`selectCaseKnowledge`).
   * `unavailable` (search down, revision moving): a technical wait, no model call; a failed search is never an absence.
   * `stopped` (budgeted search): the pause, the owner, a newer version, the budget or an uncertain paid call stopped it
   * before or instead of an embedding call. `context.inputKey` is the input the search is paid for.
   */
  knowledge(snapshot: CaseSnapshot, context?: { inputKey: string }): Promise<SavRetrievalCandidate[] | CaseKnowledgeRead>;
  /** Texts of these customer messages keyed `type:id`, for resolution quote checks; an unreadable one is simply absent. */
  customerTexts(caseId: string, refs: SourceRef[]): Promise<Record<string, string>>;
  revisions(): Promise<CaseInvestigationRevisions>;
  callModel(request: CaseInvestigationModelRequest): Promise<CaseInvestigationModelResult>;
  /** Calls already made for this input; a new input starts empty. Saved after every call and every wait. */
  progress: {
    load(caseId: string, inputKey: string): Promise<CaseInvestigationProgress | null>;
    save(caseId: string, inputKey: string, progress: CaseInvestigationProgress): Promise<void>;
  };
  /** Stores the observed decision, idempotent per case version. Never moves the case to `acting`, never plans an effect. */
  record(record: CaseInvestigationRecord): Promise<void>;
  now(): Date;
  /** P1 (option c): window and threshold of the per-case call signal; absent, nothing is measured. Never stops a call. */
  callSignal?: CaseCallSignalConfig;
  /**
   * Ugo (31/10): a ticket a person owns is not handled by V2, and a new mail does not free it. The HubSpot owner of the
   * case's ticket, read just now, outside any database lock: `v2` (the configured V2 owner), `human`, `none`, or
   * `unknown`. Read before any write or lease on an agent case, again once the lease is held (before any search), before
   * every model call and before the decision is recorded. Only `v2` lets the run go on: an absent port, a failed read and any other answer stop it.
   * A change made in HubSpot just after a read is not seen by that read; the effect executor keeps its own fence.
   */
  readTicketOwner?(snapshot: CaseSnapshot): Promise<CaseInvestigationTicketOwner>;
  /**
   * Pilot ACCÈS (3/11): the approved scope of sources that may support what is shown to the customer
   * (`investigation-access-scope.ts`), read once per run and bound to the admission policy in force. When wired, this is
   * the pilot: `access` is the only admissible family, so a case with any other open request, or with no valid scope, is
   * refused before any lease, search or call, and every source shown to the customer is checked against the scope.
   * Not wired: unchanged (the runtime wires it closed by default).
   */
  accessScope?(): Promise<unknown>;
};

/**
 * `busy`: another worker holds the case or its version moved. `settling`: a customer message was recorded less than
 * 5 minutes ago (pole A quiet period), retried at `retryAt`. `paused`: the V2 pause. `admission`: the store refused the
 * admission it re-checks under lock (input newer, policy changed...): the case stays with the team until re-evaluated.
 * None of them is stored as a wait: each is read live from the case or the pause.
 */
export type CaseInvestigationClaimRefusal = "busy" | "settling" | "paused" | "admission";

export type CaseInvestigationTicketOwner = "v2" | "human" | "none" | "unknown";

export type CaseInvestigationOwnerStop = { reason: "ticket_owner_human" | "ticket_owner_unverified"; detail: string };

export type CaseInvestigationSkipReason = CaseInvestigationGateReason | "no_customer_input" | CaseInvestigationOwnerStop["reason"] | "pilot_family_not_access" | "access_scope_missing"
  | "admission_not_current_input";

/** Fail closed: only a read that answers the V2 owner lets the run go on. */
export async function ticketOwnerStop(ports: Pick<CaseInvestigationPorts, "readTicketOwner">, snapshot: CaseSnapshot): Promise<CaseInvestigationOwnerStop | null> {
  if (!ports.readTicketOwner) return { reason: "ticket_owner_unverified", detail: "owner_read_unavailable" };
  let owner: unknown;
  try { owner = await ports.readTicketOwner(snapshot); } catch { return { reason: "ticket_owner_unverified", detail: "owner_read_failed" }; }
  if (owner === "v2") return null;
  if (owner === "human") return { reason: "ticket_owner_human", detail: "human" };
  return { reason: "ticket_owner_unverified", detail: owner === "none" || owner === "unknown" ? owner : "owner_read_invalid" };
}

export type CaseInvestigationReport =
  | { status: "off" | "case_missing"; caseId: string; modelCalls: 0 }
  | { status: "claim_refused"; caseId: string; reason: Exclude<CaseInvestigationClaimRefusal, "paused">; retryAt?: string; modelCalls: 0 }
  /** Before the first read, or between two calls of a running investigation. */
  | { status: "paused"; caseId: string; modelCalls: number }
  | { status: "skipped"; caseId: string; caseVersion: number; reason: CaseInvestigationSkipReason; detail?: string; modelCalls: 0 }
  /** The ticket left the V2 owner (or could not be read) during the run: no further call, nothing recorded, calls already made kept. */
  | { status: "ticket_owner_stop"; caseId: string; caseVersion: number; reason: CaseInvestigationOwnerStop["reason"]; detail: string; modelCalls: number }
  | { status: "context_invalid"; caseId: string; caseVersion: number; problem: CaseDecisionContextProblem; detail?: string; modelCalls: 0; embeddingCalls?: number }
  | { status: "knowledge_request_invalid"; caseId: string; caseVersion: number; problem: CaseKnowledgeRequestProblem; modelCalls: number }
  /** No attempt consumed when the first call was deferred. */
  | { status: "deferred_budget"; caseId: string; caseVersion: number; modelCalls: number }
  /** The case-wide ceiling of the window is reached: no call consumed, automatic retry from `retryAt`. */
  | { status: "case_budget_exhausted"; caseId: string; caseVersion: number; retryAt: string; modelCalls: number }
  | { status: "technical_wait" | "usage_uncertain" | "technical_exhausted"; caseId: string; caseVersion: number; modelCalls: number }
  /** A newer case version appeared during the investigation: nothing recorded, to be re-queued. */
  | { status: "stale_requeue"; caseId: string; caseVersion: number; currentVersion: number | null; modelCalls: number }
  /** OBS1: the qualification threw before any claim; nothing written (`persisted: false`), retried later. */
  | { status: "qualification_unavailable"; caseId: string; caseVersion: number; admissionInputVersion: number; inputKey: string | null; persisted: false; modelCalls: 0;
      /** B7: pole A6's closed refusal, when A6 typed it and it names this read; null otherwise (generic gap). */
      qualification: CaseQualificationUnavailable | null }
  /** The knowledge moved since the search (null: unreadable): no call on it, nothing recorded on it; the next pass searches again. */
  | { status: "knowledge_requeue"; caseId: string; caseVersion: number; searchedRevision: string; currentRevision: string | null; modelCalls: number }
  | { status: "recorded"; caseId: string; caseVersion: number; outcome: CaseDecisionValidation["outcome"]; refusal: CaseDecisionRefusal | null; closure: CaseClosurePlan | null; modelCalls: number; actionsPaused: boolean; callSignal: CaseCallSignal | null }
  /** The decision of this input was already recorded: re-checked on today's read, no call, nothing written. A timer or a
   * CRM note can run the investigation again, never pay for it. `outcome` is today's re-check, for information only:
   * the effect executor re-checks again before any effect (SAV-10), discounting changes the decision itself caused. */
  | { status: "already_recorded"; caseId: string; caseVersion: number; recordedOn: number; outcome: CaseDecisionValidation["outcome"]; modelCalls: number };

type Dispatched = { output: unknown } | { stop: CaseInvestigationReport } | { lastCallFailed: true };

export async function runCaseInvestigation(caseId: string, mode: CaseInvestigationMode, ports: CaseInvestigationPorts): Promise<CaseInvestigationReport> {
  // Off means off: not even a read.
  if (mode !== "observe") return { status: "off", caseId, modelCalls: 0 };
  const pauseAtStart = await ports.pauseState();
  if (!analysisAllowed(pauseAtStart)) return { status: "paused", caseId, modelCalls: 0 };
  let actionsPaused = pauseAtStart === "actions_paused";
  let read = await ports.readCase(caseId);
  if (!read) return { status: "case_missing", caseId, modelCalls: 0 };
  const policyRevision = await ports.admissionPolicyRevision();
  // Exclusions and admission before any lease, retrieval or model call.
  let admission = caseAdmissionStatus(read.snapshot, policyRevision);
  let gate = caseInvestigationGate(read.snapshot, admission);
  // Q10: one automatic re-evaluation per run, only when a newer input is the sole reason the gate is closed (the
  // sensitive and owner reasons come first in the gate), then a fresh read. Not while actions are paused: the pause
  // contract stops admission writes too, so the case stays visibly stale until the pause ends.
  // Pilot (review d70a, contract A-B): an open gate on an admission decided for an older mail (a customer return that copied the
  // former qualification) is stale too; the latest mail is qualified again, its own words deciding, before anything answers it.
  const pilotStale = Boolean(ports.accessScope) && gate.open && !caseAdmissionNamesLatestInput(read.snapshot, read.events);
  const reevaluate = ((!gate.open && gate.reason === "admission_stale" && gate.detail === "input_newer") || pilotStale) && !actionsPaused;
  // Ugo (31/10): the ticket's owner is read before anything is done on an agent case, the re-evaluation write included.
  // Nothing is written on a stop: taking the case from the agent is the CRM observation's.
  if (gate.open || reevaluate) {
    const stop = await ticketOwnerStop(ports, read.snapshot);
    if (stop) return { status: "skipped", caseId, caseVersion: read.snapshot.version, ...stop, modelCalls: 0 };
  }
  if (reevaluate) {
    const reevaluated = await ports.reevaluateAdmission(read.snapshot);
    if (reevaluated === "version_moved") return { status: "claim_refused", caseId, reason: "busy", modelCalls: 0 };
    // Before any claim there is no fenced write for B: the gap is reported, typed and closed, and not persisted (INTERFACE_OBS1).
    if (reevaluated === "qualification_unavailable" || typeof reevaluated === "object") {
      const inputKey = latestInvestigationInput(read.events), view = typeof reevaluated === "object" ? reevaluated.unavailable : null;
      // A6's fields are kept only when they name this very read (same admission input version and input key): never two inputs mixed.
      const qualification = view && view.inputVersion === read.snapshot.admissionInputVersion && view.inputKey === inputKey
        ? { code: view.code, nature: view.nature, inputKey: view.inputKey, inputVersion: view.inputVersion, causeCode: view.causeCode } : null;
      return { status: "qualification_unavailable", caseId, caseVersion: read.snapshot.version, admissionInputVersion: read.snapshot.admissionInputVersion,
        inputKey, persisted: false, modelCalls: 0, qualification };
    }
    // Re-admitted, withdrawn by pole A or handed to the team: the fresh read says which.
    read = await ports.readCase(caseId);
    if (!read) return { status: "case_missing", caseId, modelCalls: 0 };
    admission = caseAdmissionStatus(read.snapshot, policyRevision);
    gate = caseInvestigationGate(read.snapshot, admission);
  }
  const { snapshot, events } = read, caseVersion = snapshot.version;
  if (!gate.open) return { status: "skipped", caseId, caseVersion, reason: gate.reason, ...(gate.detail === undefined ? {} : { detail: gate.detail }), modelCalls: 0 };
  const inputKey = latestInvestigationInput(events);
  if (!inputKey) return { status: "skipped", caseId, caseVersion, reason: "no_customer_input", modelCalls: 0 };
  // Pilot ACCÈS (ROOT 3/11): `access` is the only admissible family, whatever the policy admits, and its sources are never
  // widened; then no approved scope for the policy in force, no search (the scope is the proof its answers stay low risk).
  let accessScope: CaseAccessScope | undefined;
  if (ports.accessScope) {
    if (!caseAdmissionNamesLatestInput(snapshot, events)) return { status: "skipped", caseId, caseVersion, reason: "admission_not_current_input", modelCalls: 0 };
    const others = [...new Set(snapshot.body.openRequests.filter(row => row.status === "open" && row.family !== "access").map(row => row.family))].sort();
    if (others.length) return { status: "skipped", caseId, caseVersion, reason: "pilot_family_not_access", detail: others.join(","), modelCalls: 0 };
    const scope = await readCaseAccessScope(() => ports.accessScope!(), policyRevision);
    if (!scope.ok) return { status: "skipped", caseId, caseVersion, reason: "access_scope_missing", detail: scope.problem, modelCalls: 0 };
    accessScope = scope.scope;
  }

  const lease = await ports.claim(caseId, caseVersion);
  if ("refused" in lease) {
    if (lease.refused === "paused") return { status: "paused", caseId, modelCalls: 0 };
    return { status: "claim_refused", caseId, reason: lease.refused, ...(lease.retryAt === undefined ? {} : { retryAt: lease.retryAt }), modelCalls: 0 };
  }
  // Pole A read the pause under the case lock: its answer wins over the earlier unlocked reading.
  if (lease.actionsPaused) actionsPaused = true;
  try {
    // The owner may have changed while the lease was taken: no search, text read or progress either, the lease is released.
    const leaseOwnerStop = await ticketOwnerStop(ports, snapshot);
    if (leaseOwnerStop) return { status: "ticket_owner_stop", caseId, caseVersion, ...leaseOwnerStop, modelCalls: 0 };
    // The stored progress is read before the search: an uncertain call is verify-only and pays no embedding either.
    const prior = await ports.progress.load(caseId, inputKey);
    let modelCalls = prior?.modelCalls ?? 0;
    const attempts = [...(prior?.attempts ?? [])];
    if (prior?.waiting?.reason === "usage_uncertain") return { status: "usage_uncertain", caseId, caseVersion, modelCalls };
    // A wait keeps the time it started, so a case retried every hour still shows how long it has been stuck.
    const wait = (reason: CaseInvestigationWaitReason, extra: Pick<CaseInvestigationWait, "problem" | "embeddingCalls"> = {}): CaseInvestigationWait =>
      ({ reason, since: prior?.waiting?.since ?? ports.now().toISOString(), caseVersion, ...extra });
    // The stored progress is kept as is (proposal, calls); after a recorded decision nothing is written over it.
    const keep = async (waiting: CaseInvestigationWait) => {
      if (prior?.recordedOn == null) await ports.progress.save(caseId, inputKey, { modelCalls, attempts, waiting,
        proposal: prior?.proposal ?? null, last: prior?.last ?? null, closure: prior?.closure ?? null, recordedOn: null });
    };
    const fetched = await ports.knowledge(snapshot, { inputKey });
    if (!Array.isArray(fetched) && fetched.status === "stopped") {
      const stop = fetched.stop;
      switch (stop.reason) {
        case "knowledge_owner_stop": return { status: "ticket_owner_stop", caseId, caseVersion, ...stop.owner, modelCalls };
        case "knowledge_stale": return { status: "stale_requeue", caseId, caseVersion, currentVersion: stop.currentVersion, modelCalls };
        case "knowledge_paused": await keep(wait("paused")); return { status: "paused", caseId, modelCalls };
        case "knowledge_budget_deferred": await keep(wait("deferred_budget")); return { status: "deferred_budget", caseId, caseVersion, modelCalls };
        case "knowledge_usage_uncertain": await keep(wait("usage_uncertain")); return { status: "usage_uncertain", caseId, caseVersion, modelCalls };
        case "knowledge_calls_exhausted": await keep(wait("technical_exhausted")); return { status: "technical_exhausted", caseId, caseVersion, modelCalls };
        // Another run holds the embedding key under a live lease: nothing was sent by this one, which tries again later.
        case "knowledge_busy": await keep(wait("technical_wait")); return { status: "technical_wait", caseId, caseVersion, modelCalls };
        // A search asked outside its bounds: refused before any cost; a defect of the caller, so a person looks at it.
        case "knowledge_request_invalid": await keep(wait("knowledge_request_invalid")); return { status: "knowledge_request_invalid", caseId, caseVersion, problem: stop.problem, modelCalls };
      }
    }
    const selection = Array.isArray(fetched) ? { revision: null, cards: fetched, coverage: null } : fetched.status === "ready" ? fetched.selection : null;
    if (!selection) {
      // A search outage is a technical wait, never a gap of knowledge nor a call.
      await keep(wait("technical_wait"));
      return { status: "technical_wait", caseId, caseVersion, modelCalls };
    }
    const knowledge = selection.cards, coverage = selection.coverage;
    // B4 (night 01/11): the cards were read at one knowledge revision; a model call or a record on them is only made while
    // that revision is still the current one. Unreadable is not unchanged. A plain list has no revision to compare.
    const currentRevision = !Array.isArray(fetched) && fetched.status === "ready" ? fetched.currentRevision : undefined;
    const knowledgeMoved = async (): Promise<CaseInvestigationReport | null> => {
      const searchedRevision = selection.revision;
      if (searchedRevision === null) return null;
      let now: string | null = null;
      try { now = currentRevision ? await currentRevision() : null; } catch { now = null; }
      return now === searchedRevision ? null : { status: "knowledge_requeue", caseId, caseVersion, searchedRevision, currentRevision: now, modelCalls };
    };
    // B5: the same stop as a stored wait, saved through the progress of this claim (written at its fenced release), with
    // the run's own calls and proposal; a closed code, never the revision ids.
    const knowledgeChanged = (moved: CaseInvestigationReport) =>
      wait("knowledge_changed", { problem: moved.status === "knowledge_requeue" && moved.currentRevision === null ? "revision_unreadable" : "revision_moved" });
    const customerTexts = await ports.customerTexts(caseId, events.filter(event => event.direction === "customer_inbound").map(event => event.sourceRef));
    const built = buildCaseDecisionContext({ snapshot, events, knowledge, coverage, locale: ports.scope.locale, audience: ports.scope.audience, admission, customerTexts });
    if (!built.ok) {
      // Never a silent return: the case waits for a person with the closed reason code, and no generation call is made.
      // Embedding calls the search already sent are counted, never hidden behind « no call ».
      const embeddingCalls = !Array.isArray(fetched) && fetched.status === "ready" ? fetched.embeddingCalls : undefined;
      await keep(wait("context_invalid", { problem: built.problem, ...(embeddingCalls === undefined ? {} : { embeddingCalls }) }));
      return { status: "context_invalid", caseId, caseVersion, problem: built.problem, ...(built.detail === undefined ? {} : { detail: built.detail }), modelCalls: 0,
        ...(embeddingCalls === undefined ? {} : { embeddingCalls }) };
    }
    // The stored proposal is re-checked against today's read (knowledge, owner, trials, readable texts may have changed);
    // it is never trusted as is. Same input, so a proposal that echoed its own version is checked on the current one;
    // one that echoed a wrong version keeps that error.
    const customerReportedLogin = caseModelLoginHistory(built.context);
    let proposal = prior?.proposal ?? null;
    const validate = (stored: { output: unknown; proposedOn: number }) => {
      const output = stored.output, echoed = typeof output === "object" && output !== null && (output as { caseVersion?: unknown }).caseVersion === stored.proposedOn;
      return validateCaseDecision(echoed ? { ...output, caseVersion } : output, accessScope ? { ...built.context, accessScope } : built.context, ports.now());
    };
    let validation = proposal ? validate(proposal) : undefined;
    let closure = validation?.outcome === "accepted" ? prior?.closure ?? null : null;
    // Decided once per input: what follows a recorded decision (a timer, a note, our own question now pending) is
    // never a reason to call again. Only a new customer message or a hand-back opens a new input.
    if (prior?.recordedOn != null && validation)
      return { status: "already_recorded", caseId, caseVersion, recordedOn: prior.recordedOn, outcome: validation.outcome, modelCalls };
    const refusal = () => validation?.outcome === "needs_review" ? classifyCaseDecisionRefusal(validation.rejections) : null;
    let recordedOn: number | null = null;
    const save = (waiting: CaseInvestigationWait | null) => ports.progress.save(caseId, inputKey, { modelCalls, attempts, waiting, proposal, last: validation ?? null, closure, recordedOn });

    // One call through the single model port: pause read first, a deferral consumes nothing, a failure is stored as a wait.
    const dispatch = async (purpose: CaseInvestigationCallPurpose, feedback: CaseInvestigationModelRequest["feedback"], items: CaseClosureItem[]): Promise<Dispatched> => {
      // The pause is read before every call, not only at the start: a full pause set mid-investigation stops the next
      // call; an actions pause lets it run and marks the decision.
      const level = await ports.pauseState();
      if (level === "actions_paused") actionsPaused = true;
      if (!analysisAllowed(level)) {
        await save(wait("paused"));
        return { stop: { status: "paused", caseId, modelCalls } };
      }
      // The owner may have changed while searching or waiting: no further call. What is already saved stays as it is.
      const ownerStop = await ticketOwnerStop(ports, snapshot);
      if (ownerStop) return { stop: { status: "ticket_owner_stop", caseId, caseVersion, ...ownerStop, modelCalls } };
      const moved = await knowledgeMoved();
      if (moved) { await save(knowledgeChanged(moved)); return { stop: moved }; }
      const call = modelCalls + 1, subjectKey = `sav-case:${caseId}:${inputKey}`;
      const result = await ports.callModel({ purpose, caseId, caseVersion, inputKey, call, subjectKey, callKey: `${subjectKey}:call${call}`, caseBudgetKey: `sav-case:${caseId}`, snapshot, events, knowledge, coverage, customerReportedLogin, feedback, closure: items });
      if (result.status === "deferred") {
        await save(wait("deferred_budget"));
        return { stop: { status: "deferred_budget", caseId, caseVersion, modelCalls } };
      }
      if (result.status === "case_budget_exhausted") {
        await save(wait("case_budget"));
        return { stop: { status: "case_budget_exhausted", caseId, caseVersion, retryAt: result.retryAt, modelCalls } };
      }
      // The ledger is the authority on calls spent: the local count catches up, nothing is paid again.
      if (result.status === "subject_exhausted") {
        modelCalls = SAV_CASE_INVESTIGATION_MAX_CALLS;
        if (validation) { await save(null); return { lastCallFailed: true }; }
        await save(wait("technical_exhausted"));
        return { stop: { status: "technical_exhausted", caseId, caseVersion, modelCalls } };
      }
      modelCalls = call;
      if (result.status === "ok") return { output: result.output };
      attempts.push({ call, result: "failed", purpose, uncertain: result.uncertain });
      // The last allowed call failed after a proposal: that proposal is the result, recorded below.
      if (!result.uncertain && call >= SAV_CASE_INVESTIGATION_MAX_CALLS && validation) { await save(null); return { lastCallFailed: true }; }
      const status = result.uncertain ? "usage_uncertain" : call < SAV_CASE_INVESTIGATION_MAX_CALLS ? "technical_wait" : "technical_exhausted";
      await save(wait(status));
      return { stop: { status, caseId, caseVersion, modelCalls } };
    };

    // A correctable refusal gets a bounded correction call with its exact codes; a case-level stop gets none.
    while (modelCalls < SAV_CASE_INVESTIGATION_MAX_CALLS && validation?.outcome !== "accepted" && (validation === undefined || refusal()?.correctable) && !sameRefusalTwice(attempts)) {
      const current = validation?.outcome === "needs_review" ? validation.rejections : [];
      const feedback = current.map(({ code, label, path, detail }) => ({ code, label, path, ...(detail === undefined ? {} : { detail }), kind: caseDecisionRefusalKinds[code] }));
      const sent = await dispatch("decision", feedback, []);
      if ("stop" in sent) return sent.stop;
      if ("lastCallFailed" in sent) break;
      proposal = { output: sent.output, proposedOn: caseVersion };
      validation = validate(proposal);
      closure = null;
      const latest = refusal();
      attempts.push({ call: modelCalls, result: "validated", outcome: validation.outcome, kinds: latest?.kinds ?? [], codes: latest?.codes ?? [] });
      await save(null);
    }
    // Every allowed call failed technically: visible as such, never retried in silence nor turned into a team need.
    if (!validation) {
      await save(wait("technical_exhausted"));
      return { status: "technical_exhausted", caseId, caseVersion, modelCalls };
    }

    // A closure is planned only after a second, independent reading of the customer's words.
    if (validation.outcome === "accepted" && !closure) {
      const items = caseClosureItems(validation.decision, built.context);
      if (items.length) {
        if (modelCalls >= SAV_CASE_INVESTIGATION_MAX_CALLS) closure = { plan: "ask_confirmation", verdicts: [], reason: "no_call_left" };
        else {
          const sent = await dispatch("resolution_check", [], items);
          if ("stop" in sent) return sent.stop;
          closure = "lastCallFailed" in sent ? { plan: "ask_confirmation", verdicts: [], reason: "no_call_left" } : caseClosurePlan(items, sent.output);
          if ("output" in sent) attempts.push({ call: modelCalls, result: "checked", plan: closure.plan });
        }
        await save(null);
      }
    }

    // Freshness: a decision on an outdated version is dropped, not recorded.
    const current = await ports.readCase(caseId);
    if (!current || current.snapshot.version !== caseVersion)
      return { status: "stale_requeue", caseId, caseVersion, currentVersion: current?.snapshot.version ?? null, modelCalls };

    const decided = validation, refused = refusal();
    // Our own read failed (a message text could not be read): a technical wait, retried on the stored proposal at no
    // call cost, never a team need. Nothing is recorded as a decision.
    if (refused?.kind === "technical") {
      await save(wait("technical_wait"));
      return { status: "technical_wait", caseId, caseVersion, modelCalls };
    }
    // Last check before the decision becomes a proposal: the calls and the proposal stay in the progress, nothing is recorded.
    const ownerStop = await ticketOwnerStop(ports, current.snapshot);
    if (ownerStop) return { status: "ticket_owner_stop", caseId, caseVersion, ...ownerStop, modelCalls };
    // The proposal and its calls stay in the progress; the next pass re-validates it on a fresh search.
    const moved = await knowledgeMoved();
    if (moved) { await save(knowledgeChanged(moved)); return moved; }
    const sameRefusalRepeated = sameRefusalTwice(attempts);
    const sensitiveFoundByModel = refused?.codes.includes("sensitive_requires_human") ?? false;
    // Measured on the journal read at the start plus this run's own calls: a flag for the team, decided after the fact.
    const callSignal = caseCallSignal(events, ports.now(), ports.callSignal, modelCalls - (prior?.modelCalls ?? 0));
    await ports.record({
      caseId, caseVersion, inputKey, leaseToken: lease.token, mode: "observe", validation: decided, refusal: refused, closure,
      flags: { sensitiveFoundByModel, learningExcluded: sensitiveFoundByModel, sameRefusalRepeated }, attempts, modelCalls,
      revisions: await ports.revisions(), knowledge: knowledge.map(card => ({ knowledgeId: card.id, contentVersionId: card.contentVersionId })),
      knowledgeRevision: selection.revision, coverage: coverage?.map(({ requestId, status, knowledge: refs, limitations }) => ({ requestId, status, knowledge: refs, limitations: [...limitations] })) ?? null, actionsPaused, callSignal,
      ...(accessScope ? { accessScope: caseAccessScopeStamp(accessScope) } : {}),
    });
    // A refused decision is never left with the agent: it stays listed until the team takes it.
    recordedOn = caseVersion;
    await save(refused ? wait("decision_refused") : null);
    return { status: "recorded", caseId, caseVersion, outcome: decided.outcome, refusal: refused, closure: closure?.plan ?? null, modelCalls, actionsPaused, callSignal };
  } finally {
    await ports.release(caseId, lease.token);
  }
}

/** The same refusal on the last two validated proposals: a third call would most likely repeat it, so it is not paid. Read from the stored attempts, so a resumed run respects it too. */
function sameRefusalTwice(attempts: readonly CaseInvestigationAttempt[]) {
  const [before, last] = attempts.filter(row => row.result === "validated").slice(-2);
  const key = (row: typeof last) => row?.result === "validated" && row.codes.length ? [...row.codes].sort().join("|") : null;
  return Boolean(before && last && key(before) !== null && key(before) === key(last));
}

/**
 * Key of the input that opens an investigation budget: the latest customer message, or the case given back to the
 * agent after it by a person. CRM notes, timers, holds, the release of a hold that kept the J2 and the V2 attribution
 * never count.
 */
export function latestInvestigationInput(events: readonly CaseEvent[]): string | null {
  const inputs: CaseEvent[] = [];
  let hold: unknown;
  for (const event of [...events].sort((a, b) => a.caseVersion - b.caseVersion)) {
    if (event.direction === "customer_inbound") inputs.push(event);
    if (event.kind !== "owner_changed") continue;
    const transition = event.detail?.transition;
    // A hold is not an input. Q9 (Ugo 28/10, pole A cfa2c37): the end of a technical or organisational hold is not new
    // information either: the case resumes the same input, with its J2 and its calls, and pays nothing again.
    if (event.detail?.to === "system_hold") { hold = transition; continue; }
    // v9 (pole A f16d477, D4): the relay giving a waiting case to the agent on V1's verified owner effect is not new
    // information either: the input stays the customer's mail, with its budget.
    if (transition === "v2_attribution") continue;
    const keptThrough = transition === "hold_release" && (SAV_CASE_HOLDS_KEEPING_TIMERS as readonly unknown[]).includes(hold);
    hold = undefined;
    if (!keptThrough) inputs.push(event);
  }
  if (!inputs.some(event => event.direction === "customer_inbound")) return null;
  const last = inputs.at(-1)!;
  return `${last.direction === "customer_inbound" ? "in" : "back"}:${last.id}`;
}

type Event = Pick<CaseEvent, "id" | "kind" | "direction" | "caseVersion" | "occurredAt" | "sourceRef" | "detail">;

/** The latest customer mail the investigation would answer, and whether V2 consumed it before V1 (a customer return). */
export function caseLatestCustomerMail(events: readonly Event[]) {
  const inputKey = latestInvestigationInput(events as readonly CaseEvent[]);
  if (!inputKey) return null;
  const trigger = caseReplyTriggerOf(events, inputKey);
  if (!trigger) return null;
  const gmail = trigger.slice("inbound:".length);
  const event = events.find(row => row.direction === "customer_inbound" && row.sourceRef.type === "email" && row.sourceRef.id === gmail);
  if (!event) return null;
  const relay = event.detail?.relay as { kind?: unknown; messageId?: unknown } | undefined;
  return { inputKey, gmail, event, customerReturn: relay?.kind === "v2_customer_return" };
}

/**
 * Whether the admission in force was decided on the latest customer mail (review d70a, contract A-B): a mail V1 relayed is ordered by the
 * admission input version; a customer return V2 consumed before V1 needs rules that read it (dated on or after it). The qualification an older
 * mail had, copied onto the return, never lets the agent answer the new one, even when that older mail was an access request.
 */
export function caseAdmissionNamesLatestInput(snapshot: Pick<CaseSnapshot, "admission">, events: readonly Event[]): boolean {
  const latest = caseLatestCustomerMail(events), requests = snapshot.admission?.qualification.requests ?? [];
  if (!latest || !requests.length) return false;
  // A mail V1 relayed: its admission input version already orders the admission after it (the gate's `input_newer`).
  if (!latest.customerReturn) return true;
  const ruled = requests.flatMap(request => request.provenance.kind === "qualified_rule" ? [Date.parse(request.provenance.at)] : []);
  const mailAt = Date.parse(latest.event.occurredAt);
  return ruled.length > 0 && Number.isFinite(mailAt) && ruled.every(at => Number.isFinite(at) && at >= mailAt);
}
