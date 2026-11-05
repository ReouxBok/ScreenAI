import { z } from "zod";
import {
  admissionPolicyPort, admissionPolicyRevisionPort, qualificationFromConfirmedV1, v1QualificationPort,
  type AdmissionPolicyRecord, type ConfirmedV1Context, type V1AdmissionAdapterPolicy,
} from "./admission-runtime";
import type { CaseAdmissionQualification, CaseEvent, CaseQualificationBlock, CaseSnapshot } from "./case-types";
import {
  admissionQualificationFromIntake, caseRequestsOpenedByIntake, relayQualification,
  type CaseBoundaryDeps, type CaseQualificationTarget, type CaseRelayRequest,
} from "./intake-boundary";
import type { CaseInvestigationStoreDeps } from "./investigation-store-ports";
import {
  CaseQualificationUnavailableError, caseQualificationBlockedError, caseQualificationCauseCode, caseQualificationPrecheck, isCaseQualificationUnavailable,
} from "./qualification-diagnostic";

/*
 * Pole A lot 4 (SAV-44/SAV-7): the qualification consumer A → B of B's composition contract §2, local and OFF.
 * One source for the relay and for B's re-evaluation: V1's confirmed context read once (A's reader), compared with
 * the relay's own target by A's port before anything is qualified, then V1's hints, then the approved rules, then
 * the approved policy. Closed by default: no rule port proves no family, no adapter policy confirms nobody (D-a),
 * no policy record admits nobody. Nothing here is wired in production, writes, or calls outside the database.
 */

/** Requests an approved rule proves, from V1's confirmed context. Not injected in production: none is approved, so
 * no family is ever proven and nobody is admitted. Only `qualified_rule` provenance is accepted from it. */
export type CaseApprovedRulePort = (input: { context: ConfirmedV1Context; requests: CaseRelayRequest[] }) => Promise<CaseAdmissionQualification["requests"]>;

export type AdmissionInvestigationDeps = {
  /** A's `readConfirmedV1Context`, or a double of it in tests. */
  readConfirmedContext(messageId: string): Promise<ConfirmedV1Context | null>;
  /** D-a: null keeps V1's identity out of V2 admission. */
  adapterPolicy(): Promise<V1AdmissionAdapterPolicy | null>;
  /** The approved admission policy record; null admits nobody. Read again for every decision, never cached. */
  readPolicyRecord(): Promise<AdmissionPolicyRecord | null>;
  now(): Date;
  approvedRules?: CaseApprovedRulePort;
};

const fault = (code: string): never => { throw Error(code); };

/** Which source a read failed on; the relay rethrows as is, B's `qualify` turns it into a typed refusal (A6). */
type QualifySource = "v1_context" | "adapter" | "rules" | "policy";
type SourceFailure = (source: QualifySource, error: unknown) => never;
const rethrow: SourceFailure = (_source, error) => { throw error; };
async function guarded<T>(failed: SourceFailure, source: QualifySource, read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) { return failed(source, error); }
}

/** V1's context, qualified on the relay's target: A's port throws on a missing target or any difference (an
 * acknowledgement target included), and null means no V1 execution. The requests must be exactly those V1's decision
 * opens for this mail. Rules are asked only on a current V1 ticket decision with the adapter policy in force;
 * anything else keeps the hints, which never admit. */
async function qualifyFromV1(deps: AdmissionInvestigationDeps, input: { messageId: string; gmailMessageId: string; requests: CaseRelayRequest[]; target?: CaseQualificationTarget },
  failed: SourceFailure = rethrow) {
  let context: ConfirmedV1Context | null = null, adapter: V1AdmissionAdapterPolicy | null = null;
  const base = await v1QualificationPort({
    readConfirmedContext: async messageId => (context = await guarded(failed, "v1_context", () => deps.readConfirmedContext(messageId))),
    adapterPolicy: async () => (adapter = await guarded(failed, "adapter", () => deps.adapterPolicy())),
  })(input);
  if (!base || !context) return null;
  const read: ConfirmedV1Context = context;
  const requests = caseRequestsOpenedByIntake(read.decision, input.gmailMessageId, true), given = new Set(input.requests.map(request => request.requestId));
  if (requests.length !== given.size || requests.some(request => !given.has(request.requestId))) fault("SAV_CASE_QUALIFY_REQUESTS_MISMATCH");
  const closed = ["adapter_policy_absent", "context_not_current", "not_ticket_disposition"].includes(qualificationFromConfirmedV1(read, adapter).trace.identity);
  if (closed || !deps.approvedRules) return { context: read, requests, qualification: base };
  const rules = deps.approvedRules;
  const ruled = await guarded(failed, "rules", () => rules({ context: read, requests }));
  if (ruled.some(request => request.provenance.kind !== "qualified_rule")) fault("SAV_CASE_RULE_PROVENANCE_INVALID");
  if (ruled.some(request => !given.has(request.requestId))) fault("SAV_CASE_QUALIFICATION_REQUEST_UNKNOWN");
  return { context: read, requests, qualification: { ...base, requests: ruled } };
}

/** The relay's `readQualification` and `readAdmissionPolicy` on the same sources as B's re-evaluation. */
export function caseRelayAdmissionDeps(deps: AdmissionInvestigationDeps): Pick<CaseBoundaryDeps, "readQualification" | "readAdmissionPolicy"> {
  return {
    readQualification: async input => (await qualifyFromV1(deps, input))?.qualification ?? null,
    readAdmissionPolicy: admissionPolicyPort({ read: deps.readPolicyRecord, now: deps.now }),
  };
}

const SOURCE_BLOCKS: Record<QualifySource, CaseQualificationBlock> = {
  v1_context: "v1_context_unavailable", adapter: "policy_unavailable", rules: "rule_unavailable", policy: "policy_unavailable",
};
/** The refusals of A's own checks after the V1 read, by their exact code. */
function checkBlock(error: unknown): CaseQualificationBlock | null {
  switch (caseQualificationCauseCode(error)) {
    case "SAV_V1_QUALIFICATION_SOURCE_MISMATCH": case "SAV_V1_QUALIFICATION_TARGET_MISSING": return "v1_source_mismatch";
    case "SAV_CASE_QUALIFY_REQUESTS_MISMATCH": return "v1_requests_mismatch";
    case "SAV_CASE_RULE_PROVENANCE_INVALID": case "SAV_CASE_QUALIFICATION_REQUEST_UNKNOWN": return "rule_invalid";
    // A malformed D-a adapter policy (A's schema refuses it): the configuration cannot be read.
    default: return error instanceof z.ZodError ? "policy_unavailable" : null;
  }
}

/** B's `qualify` (composition contract §2). The journal check is `caseQualificationPrecheck`, shared with the read-only
 * diagnostic: no canonical input is null (hints only, never admitted); a hand-back, an unreadable relay proof or an
 * acknowledgement is refused before any read. A6: every refusal is a `CaseQualificationUnavailableError` with closed
 * codes (journal, V1 source, requests, rule, or a source that could not be read), never a raw error; anything else
 * (a defect) still throws as is. The runner stops, writes nothing and pays nothing. */
export function caseInvestigationQualify(deps: AdmissionInvestigationDeps): CaseInvestigationStoreDeps["qualify"] {
  const policy = admissionPolicyPort({ read: deps.readPolicyRecord, now: deps.now });
  return async (snapshot: CaseSnapshot, events: readonly CaseEvent[]) => {
    const precheck = caseQualificationPrecheck(snapshot, events);
    if (precheck.outcome === "null") return null;
    if (precheck.outcome === "blocked") throw caseQualificationBlockedError(precheck);
    const { inputKey, inputVersion, relay, gmailMessageId, event } = precheck;
    const refuse = (code: CaseQualificationBlock, error: unknown) => new CaseQualificationUnavailableError({ code, inputKey, inputVersion, causeCode: caseQualificationCauseCode(error) });
    const failed: SourceFailure = (source, error) => { throw refuse(SOURCE_BLOCKS[source], error); };
    try {
      const target: CaseQualificationTarget = { ticketId: snapshot.ticketId, executionId: relay.executionId, runId: relay.intakeRunId, runVersion: relay.intakeRunVersion };
      // The case's requests opened by this mail, as the relay recorded them (whatever their status since); the V1
      // decision read must open exactly these.
      const prefix = `${gmailMessageId}/`;
      const opened = snapshot.body.openRequests.filter(row => row.id.startsWith(prefix)).map(row => ({ requestId: row.id, kind: row.family as string }));
      const qualified = await qualifyFromV1(deps, { messageId: relay.messageId, gmailMessageId, target, requests: opened }, failed);
      if (!qualified) return null;
      // Same composition as the relay: a proven request replaces its hint, a sensitive hint always stays.
      const qualification = relayQualification(admissionQualificationFromIntake(qualified.context.decision, gmailMessageId), qualified.qualification, qualified.requests);
      return { admission: { policy: await guarded(failed, "policy", policy), qualification }, sourceRef: event.sourceRef };
    } catch (error) {
      if (isCaseQualificationUnavailable(error)) throw error;
      const block = checkBlock(error);
      if (block === null) throw error;
      throw refuse(block, error);
    }
  };
}

/** The two admission ports of B's runtime on one set of sources. */
export function caseInvestigationAdmissionPorts(deps: AdmissionInvestigationDeps): Pick<CaseInvestigationStoreDeps, "qualify" | "admissionPolicyRevision"> {
  return { qualify: caseInvestigationQualify(deps), admissionPolicyRevision: admissionPolicyRevisionPort({ read: deps.readPolicyRecord, now: deps.now }) };
}
