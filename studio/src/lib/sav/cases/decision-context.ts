import type { SavRetrievalCandidate } from "../request-retrieval";
import {
  caseBodySchema, currentCaseFacts, SAV_CASE_CONTRACT_REVISION, SAV_CASE_EVENT_KIND_DIRECTIONS,
  type CaseEvent, type CaseSnapshot, type SourceRef,
} from "./case-types";
import type { CaseAdmissionStatus } from "./admission-policy";
import type { CaseDecisionValidationContext } from "./decision-contract";

/*
 * Pure projection of one SAV-5 case read (snapshot + its events) into the validator's context.
 * No read, no write, no clock. Anything inconsistent is refused rather than repaired: a context
 * that cannot be trusted would make the validator's answers meaningless.
 */

export type CaseDecisionContextInput = {
  snapshot: CaseSnapshot;
  events: readonly CaseEvent[];
  knowledge: SavRetrievalCandidate[];
  /** Per-request retrieval of these cards, when they came from `selectCaseKnowledge`. */
  coverage?: CaseDecisionValidationContext["coverage"];
  locale: string;
  audience: string;
  /** Pole A `caseAdmissionStatus` of this snapshot, or null when it could not be computed. Never defaulted. */
  admission: CaseAdmissionStatus | null;
  /** Customer message texts keyed `type:id`, for resolution quote checks only. Absent = closure unverifiable. */
  customerTexts?: Readonly<Record<string, string>>;
};

export type CaseDecisionContextProblem =
  | "contract_revision" | "body_invalid" | "event_other_case" | "event_after_snapshot"
  | "event_duplicate" | "event_direction_invalid" | "source_duplicate";

export type CaseDecisionContextResult =
  | { ok: true; context: CaseDecisionValidationContext }
  | { ok: false; problem: CaseDecisionContextProblem; detail?: string };

const sourceKey = (ref: SourceRef) => `${ref.type}:${ref.id}`;

export function buildCaseDecisionContext(input: CaseDecisionContextInput): CaseDecisionContextResult {
  const { snapshot, events } = input;
  const fail = (problem: CaseDecisionContextProblem, detail?: string): CaseDecisionContextResult =>
    ({ ok: false, problem, ...(detail === undefined ? {} : { detail }) });
  if (snapshot.contractRevision !== SAV_CASE_CONTRACT_REVISION) return fail("contract_revision", String(snapshot.contractRevision));
  const body = caseBodySchema.safeParse(snapshot.body);
  if (!body.success) return fail("body_invalid", body.error.issues[0]?.message);

  const eventIds = new Set<string>();
  for (const event of events) {
    if (event.caseId !== snapshot.caseId) return fail("event_other_case", event.id);
    // An event newer than the snapshot means the two were not read together.
    if (event.caseVersion > snapshot.version) return fail("event_after_snapshot", event.id);
    if (eventIds.has(event.id)) return fail("event_duplicate", event.id);
    eventIds.add(event.id);
    if (!SAV_CASE_EVENT_KIND_DIRECTIONS[event.kind]?.includes(event.direction)) return fail("event_direction_invalid", event.id);
  }

  // One source per message. An internal event may reuse a message's reference (a sensitive-rule owner
  // change cites the inbound mail): the message keeps its direction and date. Two messages sharing a
  // reference cannot be told apart and are refused; between internal events only, the latest is kept.
  const sources = new Map<string, CaseDecisionValidationContext["sources"][number]>();
  const ordered = [...events].sort((a, b) => a.caseVersion - b.caseVersion);
  for (const event of ordered) {
    const key = sourceKey(event.sourceRef), previous = sources.get(key);
    const row = { ref: event.sourceRef, direction: event.direction, at: event.occurredAt, order: event.caseVersion };
    if (!previous) sources.set(key, row);
    else if (event.direction === "internal") { if (previous.direction === "internal") sources.set(key, row); }
    else if (previous.direction === "internal") sources.set(key, row);
    else return fail("source_duplicate", key);
  }

  // Every owner change counts as a human intervention, whatever its direction: a conservative reading,
  // since the event detail is not part of the contract.
  const handoffs: CaseDecisionValidationContext["handoffs"] = ordered.filter(event => event.kind === "owner_changed").map(event => ({ at: event.occurredAt, order: event.caseVersion }));
  const humanSince = body.data.handoff?.humanSince;
  if (humanSince && !handoffs.some(row => row.at === humanSince)) handoffs.push({ at: humanSince, order: null });

  return { ok: true, context: {
    caseId: snapshot.caseId, caseVersion: snapshot.version, owner: snapshot.owner, admission: input.admission,
    locale: input.locale, audience: input.audience,
    sensitiveCategories: snapshot.sensitivity === "none" ? [] : [snapshot.sensitivity],
    requests: body.data.openRequests.map(row => ({ id: row.id, family: row.family, status: row.status })),
    sources: [...sources.values()], customerTexts: { ...input.customerTexts },
    // Facts still in force only (pole A v5 §7.1): a corrected fact is replaced, its history kept for audit.
    facts: currentCaseFacts(body.data).map(row => ({ id: row.id, key: row.key, kind: row.kind, source: row.source, at: row.at })),
    questions: body.data.questions.map(row => ({ id: row.id, factKeys: row.factKeys, askedAt: row.askedAt, answeredBy: row.answeredBy ?? null })),
    trials: body.data.trials.map(row => ({ id: row.id, requestId: row.requestId, knowledge: row.procedure, askedAt: row.askedAt, outcome: row.outcome, resultAt: row.resultAt })),
    handoffs,
    knowledge: input.knowledge,
    coverage: input.coverage ?? null,
  } };
}
