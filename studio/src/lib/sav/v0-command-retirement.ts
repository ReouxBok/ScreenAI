// SAV-9 x SAV-60 (decision Ugo 28/10): the old V0 circuit leaves the active interface and its archives are strictly read-only. Hiding a
// button is not enough: an old tab, a cached form or a delayed trigger can still POST the server action. The commands below are refused
// where the work would start (the lib function behind the action), BEFORE any database read, provider call, queue or log, so a refusal has
// no effect. The role guard of each action (`requireApiStaff`) still runs first and is unchanged.
// There is deliberately no switch that turns a refused command back on (same rule as `isSavV0RetiredActor`).
// Kept out of this module on purpose: the recovery of effects already engaged (A17 reconcileTicket, A33 reconcileTicketReturn, A20
// retryWebhook) stays available until an operator tool replaces it, and it only VERIFIES: it never dispatches a confirmed effect again.

// The code has no digit on purpose: the catch blocks of actions.ts only pass codes matching /^SAV_[A-Z_]+$/ (or /^[A-Z][A-Z_]+$/) to the
// notice, and anything else becomes a generic "invalid" message (SAV_V0_ANALYSIS_RETIRED, with its "0", is flattened that way today).
export const SAV_LEGACY_COMMAND_RETIRED = "SAV_LEGACY_COMMAND_RETIRED";
/**
 * Signature of the refusal, stable for the interface: a plain `Error` whose `message` is exactly `SAV_LEGACY_COMMAND_RETIRED` (no subclass, no
 * `cause`, no extra text). A server action that catches it can pass `error.message` on as it does for every `SAV_*` code, or test it with this guard.
 * Pure and dependency-free: usable from a server action and from client code.
 */
export const isSavLegacyCommandRetired = (error: unknown): boolean => error instanceof Error && error.message === SAV_LEGACY_COMMAND_RETIRED;

export type SavV0CommandDecision = "keep" | "move" | "retire";
/** `refused`: the server refuses it with a code and no effect. `read_only`: it only redirects with a read-only notice. `open`: still runs for staff. */
export type SavV0ServerState = "refused" | "read_only" | "open";
export type SavV0CommandEntry = Readonly<{ id: string; decision: SavV0CommandDecision; server: SavV0ServerState; note: string }>;

// The 33 exports of `app/studio/sav/actions.ts`, ids V0-A01..A33 of reports/sav60-v0-interface-retirement-20261028/INVENTORY.md.
// `server` is what the SERVER does today; it is checked against the source by v0-command-retirement.test.ts, so a new export or a guard that
// disappears fails a test. `move` entries stay open until their replacement exists (SAV-58/59 or a separate backend lot).
export const SAV_V0_COMMANDS = {
  recordDeploymentDecisionAction: { id: "V0-A01", decision: "keep", server: "open", note: "evaluation: documentary decision" },
  approveReplayAction: { id: "V0-A02", decision: "keep", server: "open", note: "evaluation: anonymised scenarios" },
  runReviewedReplayAction: { id: "V0-A03", decision: "keep", server: "open", note: "evaluation: controlled replay, not real dossiers" },
  saveReplyDraftAction: { id: "V0-A04", decision: "retire", server: "read_only", note: "redirects with SAV_DRAFT_READ_ONLY" },
  qualifyObservationAction: { id: "V0-A05", decision: "move", server: "open", note: "to Resolutions/Quality" },
  reviewDraftAction: { id: "V0-A06", decision: "move", server: "open", note: "to Quality/Evaluation" },
  saveHumanDraftAction: { id: "V0-A07", decision: "move", server: "open", note: "human editing to be ported outside the archive" },
  sendStudioReplyAction: { id: "V0-A08", decision: "retire", server: "refused", note: "queueSavManualReply" },
  sendSuggestedReplyAction: { id: "V0-A09", decision: "retire", server: "refused", note: "confirmSavSuggestedReply" },
  requestHumanAction: { id: "V0-A10", decision: "retire", server: "refused", note: "requestHumanIntervention" },
  correctDecisionAction: { id: "V0-A11", decision: "retire", server: "refused", note: "correctSavDecision" },
  createTicketAction: { id: "V0-A12", decision: "retire", server: "refused", note: "queueSavManualTicket without a preview token" },
  linkTicketAction: { id: "V0-A13", decision: "retire", server: "refused", note: "queueSavManualTicket without a preview token" },
  retryAnalysisAction: { id: "V0-A14", decision: "retire", server: "refused", note: "SAV_V0_ANALYSIS_RETIRED (SAV-9 analysis lot)" },
  refreshSavContextAction: { id: "V0-A15", decision: "retire", server: "refused", note: "enqueueSavContextRefresh" },
  repairSavProposalAction: { id: "V0-A16", decision: "retire", server: "refused", note: "SAV_V0_ANALYSIS_RETIRED (SAV-9 analysis lot)" },
  reconcileTicketAction: { id: "V0-A17", decision: "move", server: "open", note: "verify-only recovery of an engaged ticket effect: KEEP until an operator tool exists" },
  approveDraftAction: { id: "V0-A18", decision: "retire", server: "refused", note: "approveSavDraft" },
  retryAction: { id: "V0-A19", decision: "retire", server: "refused", note: "retrySavAction" },
  retryWebhookAction: { id: "V0-A20", decision: "move", server: "open", note: "webhook receipt recovery: KEEP until it moves to Health" },
  startPilotBatchAction: { id: "V0-A21", decision: "retire", server: "refused", note: "SAV_V0_ANALYSIS_RETIRED (SAV-9 analysis lot)" },
  startSelectedPilotBatchAction: { id: "V0-A22", decision: "retire", server: "refused", note: "SAV_V0_ANALYSIS_RETIRED (SAV-9 analysis lot)" },
  cancelPilotBatchAction: { id: "V0-A23", decision: "retire", server: "refused", note: "cancelSavPilotBatch" },
  cancelPilotBatchLabAction: { id: "V0-A24", decision: "retire", server: "refused", note: "cancelSavPilotBatch" },
  reviewPilotItemAction: { id: "V0-A25", decision: "retire", server: "refused", note: "reviewSavPilotItem" },
  continueBackfillAction: { id: "V0-A26", decision: "move", server: "open", note: "knowledge import administration, no backfill launched here" },
  reviewLearningAction: { id: "V0-A27", decision: "keep", server: "open", note: "knowledge" },
  previewHubspotReviewAction: { id: "V0-A28", decision: "keep", server: "open", note: "knowledge" },
  reviewKnowledgeAction: { id: "V0-A29", decision: "keep", server: "open", note: "knowledge" },
  importOnboardingKnowledgeAction: { id: "V0-A30", decision: "keep", server: "open", note: "knowledge" },
  reviewProposalAction: { id: "V0-A31", decision: "move", server: "open", note: "feedback port; its context refresh is refused by A15's guard (it already tolerates the refusal)" },
  importHubspotKnowledgeAction: { id: "V0-A32", decision: "keep", server: "open", note: "knowledge" },
  reconcileTicketReturnAction: { id: "V0-A33", decision: "move", server: "open", note: "verify-only recovery of a CRM return receipt: KEEP until an operator tool exists" },
} as const satisfies Record<string, SavV0CommandEntry>;
export type SavV0CommandName = keyof typeof SAV_V0_COMMANDS;
export type SavV0RefusedCommandName = { [K in SavV0CommandName]: typeof SAV_V0_COMMANDS[K]["server"] extends "refused" ? K : never }[SavV0CommandName];

/** First statement of the lib function behind a retired command. Always throws; typed `void` so the archived body below it stays valid code. */
export function refuseRetiredSavV0Command(command: SavV0RefusedCommandName): void {
  void command;
  throw new Error(SAV_LEGACY_COMMAND_RETIRED);
}
