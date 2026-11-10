// Lot C (4/11, LOCAL, SYN): the proof of WHERE a pilot reply comes from, recomputed from the recorded decision, never from what a caller or a proposal claims.
// `CaseReplyProposal` carries no sources, so a page or a validation that read them from the proposal would show nothing, or anything. Here: the latest recorded decision of the
// case's latest input, under the approved scope still in force (B's stamp), with the reply text equal to what that decision wrote, and every source shown to the customer listed
// as `answer` at that exact version AND read as active at that version now. No proof, no validation: anything unread or unknown is a reason, never a default. Nothing is written.
// No production reader of the active versions and no real scope exist yet: both are injected ports; without them nothing is proven.
import "server-only";
import { savKnowledgeFreshness } from "../request-retrieval";
import { prepareCaseReplyText } from "./case-reply-outbound";
import type { CaseReplyProposal } from "./case-effects";
import { listCaseEvents } from "./case-store";
import type { KnowledgeRef } from "./case-types";
import { caseAccessScopeStamp, caseAccessSourceProblem, readCaseAccessScope, type CaseAccessScopeStamp } from "./investigation-access-scope";
import { caseDecisionDraft } from "./investigation-intent";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput } from "./investigation-runner";

export const SAV_PILOT_PROVENANCE_REVISION = "sav-pilot-provenance-2026-11-04.v1";
export const SAV_PILOT_PROVENANCE_REASONS = [
  "scope_missing", "scope_invalid", "scope_unreadable", "scope_policy_mismatch", "decision_missing", "decision_unreadable", "decision_not_accepted", "decision_not_latest", "access_scope_unknown", "access_scope_changed",
  "reply_not_from_decision", "sources_missing", "access_source_out_of_scope", "access_source_version_out_of_scope", "access_source_orient_only", "access_scope_missing", "source_version_unknown", "source_retired", "source_unverified", "source_stale",
] as const;
export type PilotProvenanceReason = typeof SAV_PILOT_PROVENANCE_REASONS[number];

/** The version a source has NOW: `active` is decided by the reader (published, indexed, language, audience, check date), never here. Null: this version is not known. */
export type PilotActiveSource = Readonly<{ active: boolean; title: string; content: string; verifiedAt: string | null }>;
export type PilotProvenanceDeps = Readonly<{
  /** The approved scope datum (B `investigation-access-scope.ts`). */
  accessScope: () => Promise<unknown>;
  currentPolicyRevision: () => Promise<string | null>;
  readActiveSource: (ref: KnowledgeRef) => Promise<PilotActiveSource | null>;
  now: () => Date;
}>;
export type PilotProvenanceSource = KnowledgeRef & Readonly<{ use: "answer"; title: string; content: string; verifiedAt: string; verification: "fresh" | "revalidation_due"; evaluatedAt: string }>;
export type PilotProvenance =
  | Readonly<{ status: "proven"; revision: typeof SAV_PILOT_PROVENANCE_REVISION; scope: CaseAccessScopeStamp; decision: Readonly<{ inputKey: string; decidedOn: number; contract: string }>; sources: readonly PilotProvenanceSource[] }>
  | Readonly<{ status: "unproven"; revision: typeof SAV_PILOT_PROVENANCE_REVISION; reasons: readonly PilotProvenanceReason[] }>;

const unproven = (...reasons: PilotProvenanceReason[]): PilotProvenance => ({ status: "unproven", revision: SAV_PILOT_PROVENANCE_REVISION, reasons });
/** The text the decision wrote, final: both languages are tried because a proposal does not name its own, and only an exact match counts. */
/** Only a full ISO date with its time zone is a date here: `Date.parse` alone would read "2010", or a local date, as one. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
// The substance is what is compared: the decided text under either mention. WHICH mention may be sent is the persisted authorization basis' business (`case-reply-mode.ts`).
const sameFinalText = (decided: string, proposed: string) => (["fr", "en"] as const).some(language => (["manual_reviewed", "automated"] as const).some(mode => prepareCaseReplyText(decided, language, mode) === proposed));

export async function readPilotReplyProvenance(proposal: Pick<CaseReplyProposal, "caseId" | "triggerEventId" | "purpose" | "text">, deps: PilotProvenanceDeps): Promise<PilotProvenance> {
  const scope = await readCaseAccessScope(deps.accessScope, await deps.currentPolicyRevision());
  if (!scope.ok) return unproven(scope.problem);
  const events = await listCaseEvents(proposal.caseId), inputKey = latestInvestigationInput(events);
  if (!inputKey) return unproven("decision_missing");
  const read = readCaseInvestigationProgress(events, inputKey);
  if (read.state === "none") return unproven("decision_missing");
  if (read.state !== "found") return unproven("decision_unreadable");
  const stamp = caseAccessScopeStamp(scope.scope);
  const draft = caseDecisionDraft(proposal.caseId, read.record, events, { accessScope: stamp });
  if (!draft) return unproven("decision_not_accepted");
  if (draft.replyLimit === "access_scope_unknown" || draft.replyLimit === "access_scope_changed") return unproven(draft.replyLimit);
  if (!draft.reply) return unproven("reply_not_from_decision");
  // A decision about an older input does not answer the latest one; another text or purpose is not this decision's reply.
  if (draft.triggerEventId !== proposal.triggerEventId) return unproven("decision_not_latest");
  if (draft.reply.purpose !== proposal.purpose || !sameFinalText(draft.reply.text, proposal.text)) return unproven("reply_not_from_decision");
  // The type decides, never an empty list: only a real question may rest on no source; an answer must show what supports it.
  if (!draft.shownSources.length && proposal.purpose !== "question") return unproven("sources_missing");
  const reasons = new Set<PilotProvenanceReason>(), sources: PilotProvenanceSource[] = [];
  for (const ref of draft.shownSources) {
    const problem = caseAccessSourceProblem(scope.scope, ref);
    if (problem) { reasons.add(problem); continue; }
    let active: PilotActiveSource | null;
    try { active = await deps.readActiveSource(ref); } catch { active = null; }
    if (!active) { reasons.add("source_version_unknown"); continue; }
    if (!active.active) { reasons.add("source_retired"); continue; }
    // The existing policy (`savKnowledgeFreshness`) judges the date actually read; no other delay exists here. Anything else than a full ISO date is unverified.
    const now = deps.now(), freshness = active.verifiedAt !== null && ISO_INSTANT.test(active.verifiedAt) ? savKnowledgeFreshness(active.verifiedAt, now) : "unverified";
    if (freshness === "unverified") { reasons.add("source_unverified"); continue; }
    if (freshness === "stale") { reasons.add("source_stale"); continue; }
    sources.push({ ...ref, use: "answer", title: active.title, content: active.content, verifiedAt: active.verifiedAt!, verification: freshness, evaluatedAt: now.toISOString() });
  }
  if (reasons.size) return unproven(...reasons);
  return { status: "proven", revision: SAV_PILOT_PROVENANCE_REVISION, scope: stamp, decision: { inputKey: draft.inputKey, decidedOn: draft.decidedOn, contract: draft.decisionContract }, sources };
}

/** The port of C's store and driver: a refusal code with its reasons, or null when the provenance is proven. A reader that throws is no proof. */
export function pilotProvenanceGate(deps: PilotProvenanceDeps) {
  return async (proposal: CaseReplyProposal): Promise<string | null> => {
    try {
      const read = await readPilotReplyProvenance(proposal, deps);
      return read.status === "proven" ? null : [...read.reasons].sort().join(",");
    } catch { return "decision_unreadable"; }
  };
}
