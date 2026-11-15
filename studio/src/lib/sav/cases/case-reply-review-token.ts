// SAV-92: the pure part of a Studio reply decision, shared by the page (server component) and the decision itself. No database, no clock, no network.
import { SAV_CASE_SENSITIVE_FAMILIES, type CaseSnapshot } from "./case-types";

export const CASE_REPLY_REVIEW_TEXT_MAX = 6000;

// ---------------------------------------------------------------------------------------------------------------------------------
// The version token: what the person's screen showed. Not a secret and not a right (the route's administrator check is): every value is re-read and compared.
// ---------------------------------------------------------------------------------------------------------------------------------

export type CaseReplyReviewToken = Readonly<{ validationId: string; payloadHash: string; caseVersion: number }>;
export const encodeCaseReplyReviewToken = (token: CaseReplyReviewToken) => `v1.${token.validationId.toLowerCase()}.${token.payloadHash}.${token.caseVersion}`;
export function parseCaseReplyReviewToken(value: unknown): CaseReplyReviewToken | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const match = /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-f0-9]{64})\.([1-9][0-9]{0,9})$/.exec(value);
  if (!match) return null;
  const caseVersion = Number(match[3]);
  return Number.isSafeInteger(caseVersion) ? { validationId: match[1]!, payloadHash: match[2]!, caseVersion } : null;
}

/** Finance, cancellation and every other sensitive family stay human: nothing is sent from the Studio button for such a case (a decline stays possible). */
export function caseReplyReviewSensitive(snapshot: Pick<CaseSnapshot, "sensitivity" | "body" | "admission">) {
  const families = SAV_CASE_SENSITIVE_FAMILIES as readonly string[];
  return snapshot.sensitivity !== "none" || (snapshot.admission?.sensitivity ?? "none") !== "none"
    || snapshot.body.openRequests.some(request => families.includes(request.family)) || (snapshot.admission?.families ?? []).some(family => families.includes(family));
}

