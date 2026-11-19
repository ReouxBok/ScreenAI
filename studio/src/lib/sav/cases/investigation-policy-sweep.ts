import { caseAdmissionRuleStage, caseAdmissionStatus } from "./admission-policy";
import { caseAdmissionPolicySchema, SAV_CASE_CONTRACT_REVISION, type CaseAdmissionPolicy, type CaseAdmissionReason, type CaseSnapshot } from "./case-types";

/*
 * SAV-7 sweep after an approved admission policy change (Q10, decision Ugo 28/10). A new policy stales every agent
 * admission at once (pole A `caseAdmissionStatus`: `policy_changed`); without this pass those cases would stay with the
 * agent and nobody would act on them, J2 included. Each one is decided again, once, by the approved policy on the
 * qualification already recorded for it (pole A `revalidateCaseAdmissionForPolicy` takes it server-side: no new
 * qualification can enter): the agent keeps what the new rules admit, the team gets the rest with its reason. No model, no rights of its own: the sweep reads the policy, never writes or approves
 * one, and only ever touches agent cases staled by that policy alone. One bounded page per pass, from a cursor;
 * replaying a pass or running two at once changes nothing more (the store's version check decides who writes). The
 * cursor never passes a case whose write lost a version race: the pass stops before it, so the next pass reads it
 * again (no retry inside a pass). A case the race made newer, or gave to a person, then no longer holds the others.
 * Off unless the caller enables it: nothing in production calls it.
 *
 * Revision lifecycle (19/11, METHODE §3): a rule's revision N and N-1 may both be listed (`previous: true` on N-1, `caseAdmissionRuleLifecycleProblem`).
 * Because each case is decided again on the qualification it recorded, a case admitted under N-1 is KEPT while the new policy still lists N-1 (it ends
 * under N-1, reported `stage: "previous"`), and goes to the team only when N-1 has left the policy (`detail: "revision_withdrawn"`). The report says, per kept
 * case, under which entry it stands: N-1 may leave the policy once a full pass reports no `previous` case.
 *
 * How to wire it (NOT done: Ugo's go first). Wiring it while the policy lists only N would send every open N-1 case to the team.
 *   - Trigger: the V2 reconcile tick, after an approved policy change only (a durable cursor `nextSweepPage({ name: "policy_sweep" })`), with its deadline.
 *   - Ports: `enabled` = an explicit `SAV_V2_POLICY_SWEEP=on`; `pauseState` = `readSavAgentPause(db, "v2").level`; `admissionPolicyRevision` and
 *     `approvedPolicy` = the provenance readers (`caseProvenanceReaders(...).currentPolicyRevision` and the parsed `SAV_V2_ADMISSION_POLICY_JSON` policy);
 *     `listCases` = `listCaseIdsForPolicyRevalidation`; `readCase` = `readCase`; `revalidate` = `revalidateCaseAdmissionForPolicy({ caseId, expectedVersion:
 *     snapshot.version, policy })` mapping `revalidated:false` to `refused` and `CaseVersionStaleError` to `version_moved`; `now` = the clock.
 *   - Before turning it on: approve a policy that lists N AND N-1 (`previous: true`) for every block whose skill changed, then run one pass and read the report.
 */

export const SAV_CASE_POLICY_SWEEP_MAX_PAGE = 200;

export type CaseAdmissionSweepPorts = {
  /** Explicit switch; false answers `disabled` before any read. */
  enabled: boolean;
  /** SAV agent pause for V2 (levels of `sav-agent-pause.v1:v2`). Anything but `running` stops the pass where it is:
   * the pause contract stops admission writes from `actions_paused` on, and this pass only writes admissions. */
  pauseState(): Promise<"running" | "actions_paused" | "fully_paused">;
  /** Revision of the current approved policy (the same pointer the runner and the claim read). */
  admissionPolicyRevision(): Promise<string | null>;
  /** That approved policy, read only. The sweep never writes, approves or completes a policy. */
  approvedPolicy(): Promise<unknown>;
  /** Pole A `listCaseIdsForPolicyRevalidation`: agent cases admitted under another revision, by id after `after`. */
  listCases(page: { currentPolicyRevision: string; after: string | null; limit: number }): Promise<string[]>;
  readCase(caseId: string): Promise<CaseSnapshot | null>;
  /**
   * Pole A `revalidateCaseAdmissionForPolicy` on `snapshot.version`, with the recorded qualification only. `refused`:
   * pole A's own check under lock found the case no longer eligible; `version_moved`: another writer was first.
   */
  revalidate(snapshot: CaseSnapshot, policy: CaseAdmissionPolicy): Promise<"revalidated" | "refused" | "version_moved">;
  now(): Date;
};

export type CaseAdmissionSweepOutcome =
  /** Admitted again by the new policy: the agent goes on (the runner claims it as usual). */
  | "kept_agent"
  /** Not admitted by the new policy: withdrawn to the team by pole A, with `reason`. */
  | "to_team"
  /** Already decided under the current policy (a replay, or another pass was first). */
  | "current"
  /** A person or a hold owns it: a human stays human, a hold keeps its J2 (Q9). Never re-evaluated here. */
  | "not_agent"
  /** A newer input staled it first: the runner's own Q10 re-evaluation of that input applies, not this sweep. */
  | "input_newer"
  /** No positive agent admission to re-decide. */
  | "not_admitted"
  /** Stored under another contract revision: refused, never guessed. */
  | "contract_conflict"
  /** Another writer moved the version between the read and the write: the pass stops before it (`next`), so the next
   * pass, from that cursor, reads it again. */
  | "version_moved"
  /** Pole A refused it under lock (owner, admission or input changed after the read): left as it is. */
  | "refused_by_store"
  | "missing";

/** Per swept case: `stage: "previous"` for a case kept with the agent under N-1 (a case under a current entry reads exactly as before); `detail: "revision_withdrawn"` for a case sent to the team
 * because the revision it was admitted under left the policy while its rule is still listed. */
export type CaseAdmissionSweepCase = { caseId: string; outcome: CaseAdmissionSweepOutcome; reason?: CaseAdmissionReason; stage?: "previous"; detail?: "revision_withdrawn" };
export type CaseAdmissionSweepReport =
  | { status: "disabled" | "paused" }
  | { status: "refused"; reason: "policy_missing" | "policy_invalid" | "policy_conflict" | "policy_unapproved" | "page_invalid" }
  | {
    /** `partial`: a full page was read, or a case lost a version race (`next` stays before it); run again from `next`.
     * `paused`: the pause stopped the pass, resume from `next` once it is lifted. */
    status: "done" | "partial" | "paused";
    policyRevision: string;
    next: string | null;
    cases: CaseAdmissionSweepCase[];
  };

export async function sweepCaseAdmissionsAfterPolicyChange(
  ports: CaseAdmissionSweepPorts, options: { after?: string | null; limit?: number } = {},
): Promise<CaseAdmissionSweepReport> {
  if (!ports.enabled) return { status: "disabled" };
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > SAV_CASE_POLICY_SWEEP_MAX_PAGE) return { status: "refused", reason: "page_invalid" };
  if (await ports.pauseState() !== "running") return { status: "paused" };

  const revision = await ports.admissionPolicyRevision();
  if (revision === null) return { status: "refused", reason: "policy_missing" };
  const parsed = caseAdmissionPolicySchema.safeParse(await ports.approvedPolicy());
  if (!parsed.success) return { status: "refused", reason: "policy_invalid" };
  // The pointer and the approved document must name the same revision; an approval dated in the future is no approval.
  if (parsed.data.revision !== revision) return { status: "refused", reason: "policy_conflict" };
  if (Date.parse(parsed.data.approvedAt) > ports.now().getTime()) return { status: "refused", reason: "policy_unapproved" };
  const policy = parsed.data;

  const page = await ports.listCases({ currentPolicyRevision: revision, after: options.after ?? null, limit });
  const cases: Extract<CaseAdmissionSweepReport, { cases: unknown }>["cases"] = [];
  for (const caseId of page) {
    // A pause between two cases stops the pass: the cursor resumes at this case.
    if (await ports.pauseState() !== "running") return { status: "paused", policyRevision: revision, next: cases.at(-1)?.caseId ?? options.after ?? null, cases };
    const before = cases.at(-1)?.caseId ?? options.after ?? null;
    cases.push({ caseId, ...await sweepOne(ports, caseId, policy, revision) });
    // Review B (28/10): a lost version race leaves the case under the old policy; the cursor must not pass it.
    if (cases.at(-1)!.outcome === "version_moved") return { status: "partial", policyRevision: revision, next: before, cases };
  }
  return { status: page.length === limit ? "partial" : "done", policyRevision: revision, next: page.length === limit ? page.at(-1)! : null, cases };
}

async function sweepOne(ports: CaseAdmissionSweepPorts, caseId: string, policy: CaseAdmissionPolicy, revision: string): Promise<Omit<CaseAdmissionSweepCase, "caseId">> {
  const snapshot = await ports.readCase(caseId);
  if (!snapshot) return { outcome: "missing" as const };
  if (snapshot.contractRevision !== SAV_CASE_CONTRACT_REVISION) return { outcome: "contract_conflict" as const };
  const status = caseAdmissionStatus(snapshot, revision);
  if (status.admitted) return { outcome: "current" as const };
  if (status.reason === "owner_not_agent") return { outcome: "not_agent" as const };
  if (status.reason === "input_newer") return { outcome: "input_newer" as const };
  if (status.reason !== "policy_changed" || !snapshot.admission || snapshot.admission.target !== "agent") return { outcome: "not_admitted" as const };

  // Same qualification, new approved policy: what changed is the rule, not what is known of the case.
  const result = await ports.revalidate(snapshot, policy);
  if (result === "version_moved") return { outcome: "version_moved" as const };
  if (result === "refused") return { outcome: "refused_by_store" as const };
  const after = await ports.readCase(caseId);
  if (after && caseAdmissionStatus(after, revision).admitted) {
    const stage = caseAdmissionRuleStage(after.admission?.qualification, policy);
    return { outcome: "kept_agent" as const, ...(stage === "previous" ? { stage } : {}) };
  }
  const withdrawn = caseAdmissionRuleStage(snapshot.admission.qualification, policy) === "withdrawn";
  return { outcome: "to_team" as const, ...(after?.admission ? { reason: after.admission.reasons[0] } : {}), ...(withdrawn ? { detail: "revision_withdrawn" as const } : {}) };
}
