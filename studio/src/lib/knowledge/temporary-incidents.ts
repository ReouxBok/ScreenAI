import { canReviewKnowledgeCandidate } from "./contracts";
import { fixStatement, temporaryIncidentDocumentSchema, type TemporaryIncident } from "./temporary-incident-schema";

export { TEMPORARY_FIX_LEVELS, TEMPORARY_INCIDENT_MAX_DAYS, fixStatement, temporaryIncidentDocumentSchema, unprovenFixClaim } from "./temporary-incident-schema";
export type { TemporaryFixLevel, TemporaryIncident } from "./temporary-incident-schema";

/** Kept as the public name: the stored contract carries no identity, so structure is the whole schema. */
export const temporaryIncidentSchema = temporaryIncidentDocumentSchema;

/** The review state of the canonical revision that carries the incident, as observed in the database. */
export type TemporaryIncidentReview = { approved: boolean; reviewState: string; reviewedBy: string | null };
export type TemporaryIncidentRecord = { incident: unknown; review: TemporaryIncidentReview };

/** Approval of an incident is the approval of its carrying revision by the delegated SAV reviewer. */
export function isTemporaryIncidentApproved(review: TemporaryIncidentReview) {
  return review.approved && review.reviewState === "approved" && Boolean(review.reviewedBy) && canReviewKnowledgeCandidate(review.reviewedBy ?? "", "sav");
}

export type TemporaryIncidentContext = { family: string; productArea: string; now: Date };
export type TemporaryIncidentDecision =
  | { kind: "none"; reason: "no_match" | "expired" | "not_approved" | "revoked" | "superseded" }
  | { kind: "apply"; incidentId: string; revision: number; reply: string; fixStatement: string; infoToCollect: string[]; validUntil: string; grantsActions: false }
  | { kind: "ambiguous"; incidentIds: string[]; route: "human" }
  | { kind: "invalid"; route: "human"; errors: string[] };

function normalizeArea(area: string) {
  return area.normalize("NFKC").trim().toLowerCase();
}

/**
 * Bounded port composable with the existing retrieval: it only decides whether one approved,
 * in-scope, unexpired incident applies. Base validated knowledge resumes when it returns `none`.
 * Any invalid record or overlapping scope is a prudent human route, never a guess.
 * NOT WIRED to the SAV runtime yet (SAV-79): no caller outside tests.
 */
export function selectTemporaryIncident(records: TemporaryIncidentRecord[], context: TemporaryIncidentContext): TemporaryIncidentDecision {
  const parsed: Array<{ incident: TemporaryIncident; approved: boolean }> = []; const errors: string[] = [];
  for (const record of records) {
    const result = temporaryIncidentSchema.safeParse(record.incident);
    if (result.success) parsed.push({ incident: result.data, approved: isTemporaryIncidentApproved(record.review) });
    else errors.push(...result.error.issues.map((issue) => issue.message));
  }
  // A malformed record could be the one covering this case: never silently ignore it.
  if (errors.length) return { kind: "invalid", route: "human", errors: [...new Set(errors)] };
  const now = context.now.getTime();
  const area = normalizeArea(context.productArea);
  const inScope = parsed.filter(({ incident }) => incident.scope.families.includes(context.family as never) && normalizeArea(incident.scope.productArea) === area);
  if (!inScope.length) return { kind: "none", reason: "no_match" };
  // Only an approved replacement can retire the incident it supersedes.
  const supersededIds = new Set(parsed.filter(({ incident, approved }) => approved && incident.status === "active" && incident.supersedes).map(({ incident }) => incident.supersedes));
  // Approval precedes incident version: an inherited or newer draft cannot retire
  // the currently approved revision. Equal approved versions must agree.
  const latest = new Map<string, { incident: TemporaryIncident; approved: boolean }>();
  for (const entry of inScope) {
    const previous = latest.get(entry.incident.id);
    if (previous?.approved && entry.approved && previous.incident.revision === entry.incident.revision
      && JSON.stringify(previous.incident) !== JSON.stringify(entry.incident))
      return { kind: "invalid", route: "human", errors: ["TEMPORARY_APPROVED_REVISION_CONFLICT"] };
    if (!previous || entry.approved && !previous.approved
      || entry.approved === previous.approved && previous.incident.revision < entry.incident.revision) latest.set(entry.incident.id, entry);
  }
  const candidates = [...latest.values()];
  const live = candidates.filter(({ incident, approved }) => approved && incident.status === "active" && !supersededIds.has(incident.id)
    && Date.parse(incident.knownSince) <= now && now < Date.parse(incident.validUntil));
  if (live.length > 1) return { kind: "ambiguous", incidentIds: live.map(({ incident }) => incident.id).sort(), route: "human" };
  if (live.length === 1) {
    const { incident } = live[0];
    return { kind: "apply", incidentId: incident.id, revision: incident.revision, reply: incident.approvedReply, fixStatement: fixStatement(incident.fix.level), infoToCollect: [...incident.infoToCollect], validUntil: incident.validUntil, grantsActions: false };
  }
  if (candidates.some(({ incident, approved }) => approved && incident.status === "revoked")) return { kind: "none", reason: "revoked" };
  if (candidates.some(({ incident, approved }) => approved && supersededIds.has(incident.id))) return { kind: "none", reason: "superseded" };
  if (candidates.some(({ approved }) => approved)) return { kind: "none", reason: "expired" };
  return { kind: "none", reason: "not_approved" };
}

/**
 * Revocation is a new incident revision; the previous one stays untouched as history.
 * Who may revoke is decided by the review of the canonical revision that carries the result.
 */
export function revokeTemporaryIncident(incident: TemporaryIncident, at: string, reason: string): TemporaryIncident {
  if (incident.status === "revoked") throw new Error("TEMPORARY_ALREADY_REVOKED");
  return temporaryIncidentSchema.parse({ ...incident, revision: incident.revision + 1, status: "revoked", revocation: { at, reason } });
}
