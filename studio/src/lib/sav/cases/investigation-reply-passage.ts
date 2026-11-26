import "server-only";
import { closingHandoffReplyEnabled, isTerminalReply, pendingHandoffReply, terminalReplyInput } from "./case-terminal-reply";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseReplyValidations } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { caseAdmissionStatus } from "./admission-policy";
import { readSavBlockSwitch, savBlockReplyGate } from "./block-switch";
import { SAV_CASE_ACCESS_BLOCK_ID } from "./case-types";
import { SAV_CASE_TEAM_PART_MENTION } from "./decision-contract";
import { enqueueHandoffNotice } from "./case-handoff-notice-store";
import type { CaseReplyProposal } from "./case-effects";
import { prepareCaseReplyText, readCaseReplyDisclosure } from "./case-reply-outbound";
import { decideCaseReply, type CaseReplyStoreDeps } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { proposeCaseReplyFromDraft, queueValidatedCaseReply, resolveCaseReplyLanguage, type CaseReplyDraftInput, type CaseReplyLanguageInput } from "./case-runtime-effects";
import { judgeCurrentTicketOwner } from "./case-ticket-owner";
import { listCaseEvents, readCase } from "./case-store";
import { accessAutoReplyAuthorizer } from "./customer-return-store";
import { readAccessAutoApprovalConfig, type AccessAutoApprovalFacts } from "./customer-return";
import { caseAccessScopeStamp, caseStampBlockId, readCaseDecisionScopes } from "./investigation-access-scope";
import { caseDecisionDraft, type CaseDecisionDraft } from "./investigation-intent";
import { readCaseInvestigationProgress } from "./investigation-record";
import { caseAdmissionNamesLatestInput, latestInvestigationInput } from "./investigation-runner";
import { runCaseInvestigationRuntime, type CaseInvestigationRuntimeDeps, type CaseInvestigationRuntimeReport } from "./investigation-runtime";
import { readPilotReplyProvenance, type PilotProvenanceDeps } from "./pilot-passage-provenance";
import { caseSmartSupportOpen, isSmartSupportStamp, smartSupportStampInForce } from "./smart-support-scope";
import { savV2EntrySmartOn } from "./smart-entry-switch";
import { smartSendProblem } from "./smart/smart-send-fence";
import { smartCommercialForwardOn } from "./smart/smart-switch";
import { commercialForwardAuthority, commercialForwardDeps, enqueueCommercialForward, readCommercialForwardFacts, syncCommercialForward } from "./commercial-forward-store";
import { SAV_CASE_TEAM_PART_WAIT_CODE } from "./case-team-part-wait";

/** The targeted forward right after it is queued is bounded; past it, the reconcile sweep finishes it. */
const COMMERCIAL_FORWARD_INLINE_MS = 15_000;

/*
 * B (4/11, LOCAL and OFF): from the investigation of an admitted case to the NORMAL send plan, and nothing else. B proposes the recorded
 * decision's reply through C, approves it only through A's access rule (`auto_access.v1`) on facts read again from the database, and queues
 * it through C's `queueValidatedCaseReply`: one execution on the single ledger, run by C's executor. Anything short of every proof leaves a
 * proposal for a person. The text is formatted `automated` only after those proofs; C stores it and reads the mode from its persisted
 * authority (CONTRAT-B-C-UX). Idempotent: a replay or a concurrent pass finds the same proposal, approval and execution, and calls no model.
 */

export type CaseReplyPassageDeps = Readonly<{
  /** C's store ports, `readTicketOwner` and `pilotProvenance` included (the store re-proves the provenance before approving and queueing). */
  store: CaseReplyStoreDeps;
  /** The provenance B proves before asking for an automated text and again in its authorizer. */
  provenance: PilotProvenanceDeps;
  /** The approved execution policy of the plan; null: nothing is queued, the proposal waits. */
  policy: Readonly<{ id: string; hash: string }> | null;
  /** The language C formats the mention in; absent, C's own fallback. */
  language?: (caseId: string) => Promise<CaseReplyLanguageInput>;
}>;

export type CaseReplyPassageReport =
  | Readonly<{ status: "no_reply"; caseId: string; reason: string }>
  | Readonly<{ status: "human_task_required"; caseId: string; reason: "access_scope_changed" | "access_scope_unknown" }>
  /** Per-block switch (12/11): the decision's block is off, paused or its switch unreadable. Nothing proposed, approved or queued; a visible wait with its code. */
  | Readonly<{ status: "block_held"; caseId: string; blockId: string; reason: "block_off" | "block_paused" | "block_setting_invalid"; detail: string }>
  | Readonly<{ status: "proposal_refused"; caseId: string; code: string; detail?: string }>
  | Readonly<{ status: "awaiting_person"; caseId: string; validationId: string; reasons: readonly string[] }>
  | Readonly<{ status: "queued"; caseId: string; validationId: string; executionId: string; created: boolean }>
  | Readonly<{ status: "queue_refused"; caseId: string; validationId: string; code: string; detail?: string }>;

type AutoFacts = Readonly<{ facts: AccessAutoApprovalFacts | null; reasons: string[] }>;

/** The recorded decision of the latest input as C's draft, under the access scope in force. Null: no decision, none accepted, or no reply. */
async function latestDraft(caseId: string, provenance: PilotProvenanceDeps, env: Record<string, string | undefined>) {
  const events = await listCaseEvents(caseId), inputKey = terminalReplyInput(events, latestInvestigationInput(events), env);
  if (!inputKey) return { draft: null, reason: "no_input" } as const;
  const read = readCaseInvestigationProgress(events, inputKey);
  if (read.state !== "found") return { draft: null, reason: `decision_${read.state}` } as const;
  // Treatment blocks (11/11): the scope in force of the block the decision was taken under (Access when its stamp names none).
  // SAV-92 (multi-block): every block the decision was taken under.
  const blockId = caseStampBlockId(read.record.decision?.accessScope);
  const blockIds = read.record.decision?.blockScopes ? read.record.decision.blockScopes.map(caseStampBlockId) : [blockId];
  // SAV-123 (N8): a smart decision has no block scope to read; its stamp is in force only while the smart entry is on.
  const smart = isSmartSupportStamp(read.record.decision?.accessScope);
  const scope = smart ? null : await readCaseDecisionScopes(provenance.accessScope, await provenance.currentPolicyRevision(), read.record.decision);
  const draft = caseDecisionDraft(caseId, read.record, events, { accessScope: !scope ? smartSupportStampInForce(env) : scope.ok ? caseAccessScopeStamp(scope.scope) : null,
    ...(read.record.decision?.blockScopes ? { blockScopes: scope?.ok && scope.blocks ? scope.blocks.map(caseAccessScopeStamp) : null } : {}) }, env);
  if (!draft) return { draft: null, reason: "decision_not_accepted" } as const;
  const nextAction = read.record.decision?.validation.outcome === "accepted" ? read.record.decision.validation.decision.nextAction.kind : "none";
  return { draft, nextAction, events, blockId, blockIds, reason: draft.reply ? null : (draft.replyLimit ?? "no_reply") } as const;
}

/**
 * Per-block switch (12/11) of the block(s) the decision was taken under, read now from the database; it can only restrict A's rule.
 * SAV-92 (multi-block): ONE reply, ONE mode, the strictest of its blocks: one block that never sends holds the whole reply (never half of it sent),
 * one block in draft leaves the whole reply to a person. The entry already moved a stricter block's requests to the team, so this only bites when a
 * switch changed between the entry and the reply.
 */
async function blockReplyGate(blockIds: readonly string[], env: Record<string, string | undefined>): Promise<{ blockId: string; gate: ReturnType<typeof savBlockReplyGate> }> {
  const gates = await Promise.all(blockIds.map(async blockId => ({ blockId, gate: savBlockReplyGate(await readSavBlockSwitch(requireDb(), blockId, env)) })));
  return gates.find(row => row.gate.send === "never") ?? gates.find(row => row.gate.send === "person") ?? gates[0]!;
}

/** A's facts, every one read now from the database and the CRM port, never from the caller. */
async function autoFacts(caseId: string, deps: CaseReplyPassageDeps, decision: { draft: CaseDecisionDraft; nextAction: string } | null, proven: boolean): Promise<AutoFacts> {
  const reasons: string[] = [];
  const read = await readCase(caseId);
  if (!read) return { facts: null, reasons: ["case_missing"] };
  const snapshot = read, events = await listCaseEvents(caseId);
  const pending = decision?.draft.reply?.purpose === "handoff" && closingHandoffReplyEnabled(deps.store.env()) && pendingHandoffReply(snapshot, events, decision.draft.triggerEventId!);
  const admitted = caseAdmissionStatus(pending ? { ...snapshot, owner: "agent" } : snapshot, await deps.store.currentPolicyRevision()).admitted;
  // An admission copied from an older mail never admits a reply to the new one (contract A-B).
  const current = caseAdmissionNamesLatestInput(snapshot, events);
  if (!current) reasons.push("admission_not_current_input");
  const owner = await judgeCurrentTicketOwner(deps.store.readTicketOwner, snapshot.ticketId);
  const ownerNow: AccessAutoApprovalFacts["ownerNow"] = owner.ok ? "v2" : owner.code === "owner_human" ? "human" : owner.code === "owner_none" ? "none" : "unknown";
  const facts: AccessAutoApprovalFacts = {
    case: { owner: pending ? "agent" : snapshot.owner, sensitivity: snapshot.sensitivity, admitted: admitted && current },
    openFamilies: [...new Set(snapshot.body.openRequests.filter(row => row.status === "open" || (decision?.draft.reply && isTerminalReply(decision.draft.reply.purpose))).map(row => row.family))],
    decision: decision ? { accepted: true, scopeCurrent: decision.draft.replyLimit !== "access_scope_unknown" && decision.draft.replyLimit !== "access_scope_changed",
      shownSourcesVerified: proven, nextAction: decision.nextAction } : null,
    ownerNow,
    ...(decision && isSmartSupportStamp(decision.draft.accessScope) && caseSmartSupportOpen(snapshot) && savV2EntrySmartOn(deps.store.env()) ? { smartSupport: true } : {}),
  };
  // SAV-123 (N8): the smart send fence on the text the rule would approve (the effect driver looks again before sending).
  if (decision?.draft.reply) {
    const net = smartSendProblem({ admission: snapshot.admission, body: decision.draft.reply.text, purpose: decision.draft.reply.purpose });
    if (net) reasons.push(net.toLowerCase());
  }
  return { facts, reasons };
}

/**
 * B's authorizer, the only one that may approve without a person: the stored text must read `automated` (a `manual_reviewed` text was
 * shown to nobody and stays a person's), the provenance must be proven on that stored proposal, then A's rule decides on facts read now.
 * Anything missing or unreadable refuses; it never approves a payload other than the stored one (C's store passes its own row).
 */
export function caseAccessAutoReplyAuthorizer(deps: Pick<CaseReplyPassageDeps, "store" | "provenance">): CaseReplyAuthorizer {
  const passageDeps = { ...deps, policy: null } satisfies CaseReplyPassageDeps;
  return async request => {
    // The block's switch first: off, paused or draft, the rule never approves (a person still may, through C's own path).
    const current = await latestDraft(request.caseId, deps.provenance, deps.store.env());
    const { gate } = await blockReplyGate(current.draft ? current.blockIds : [SAV_CASE_ACCESS_BLOCK_ID], deps.store.env());
    if (gate.send !== "rule") return { allowed: false, reason: gate.code };
    const [row] = await requireDb().select().from(savCaseReplyValidations).where(and(eq(savCaseReplyValidations.caseId, request.caseId),
      eq(savCaseReplyValidations.replyKey, request.replyKey), eq(savCaseReplyValidations.payloadHash, request.payloadHash)));
    if (!row) return { allowed: false, reason: "proposal_unknown" };
    const proposal = decryptSavPayload<CaseReplyProposal>(row.proposalCiphertext);
    if (readCaseReplyDisclosure(proposal.text)?.mode !== "automated") return { allowed: false, reason: "auto_text_mode_not_automated" };
    let proven = false;
    try { proven = (await readPilotReplyProvenance(proposal, deps.provenance)).status === "proven"; } catch { proven = false; }
    if (!proven) return { allowed: false, reason: "provenance_unproven" };
    return accessAutoReplyAuthorizer({ env: deps.store.env(), readFacts: async () => {
      const latest = await latestDraft(request.caseId, deps.provenance, deps.store.env());
      if (!latest.draft || latest.draft.triggerEventId !== proposal.triggerEventId) return null;
      const { facts, reasons } = await autoFacts(request.caseId, passageDeps, { draft: latest.draft, nextAction: latest.nextAction }, proven);
      return reasons.length ? null : facts;
    } })(request);
  };
}

/** Proposes, and only on every proof approves and queues, the reply of the latest recorded decision of a case. Callable alone and idempotent. */
export async function passCaseInvestigationToReplyPlan(caseId: string, deps: CaseReplyPassageDeps): Promise<CaseReplyPassageReport> {
  const latest = await latestDraft(caseId, deps.provenance, deps.store.env());
  if (!latest.draft) return { status: "no_reply", caseId, reason: latest.reason };
  const { draft } = latest;
  // Keep the recorded decision and all call history. The entry persists this explicit operator task;
  // restoration of the original scope allows the ordinary idempotent passage to resume.
  if (draft.replyLimit === "access_scope_changed" || draft.replyLimit === "access_scope_unknown")
    return { status: "human_task_required", caseId, reason: draft.replyLimit };
  if (!draft.reply) return { status: "no_reply", caseId, reason: latest.reason ?? "no_reply" };
  // Ugo 26/11 (`SAV_V2_SMART_COMMERCIAL_FORWARD`): a reply that leaves out the mail's commercial question is proposed only once that question's forward to
  // sales is durably queued. Switch off since the decision, no authority to forward, or no stored mail: nothing is proposed and the case waits with the
  // team-part code, so after its bound the WHOLE mail goes to the team (never a reply that silently drops the commercial question).
  if (draft.commercialPart) {
    const refuse = (detail: string): CaseReplyPassageReport => ({ status: "proposal_refused", caseId, code: SAV_CASE_TEAM_PART_WAIT_CODE, detail });
    if (!smartCommercialForwardOn(deps.store.env())) return refuse("commercial_forward_unavailable");
    try { await commercialForwardAuthority(deps.store.env()); } catch { return refuse("commercial_forward_unavailable"); }
    const queued = await enqueueCommercialForward({ caseId, inputKey: draft.inputKey, triggerEventId: draft.triggerEventId, asks: draft.commercialPart.asks }).catch(() => null);
    if (!queued?.ok) return refuse("commercial_forward_unavailable");
    // The original mail must be readable in contact@ (what the forward sends): otherwise no reply leaves without it.
    if (!await readCommercialForwardFacts(queued.key).catch(() => null)) return refuse("commercial_forward_unavailable");
    if (queued.created) await syncCommercialForward(queued.key, commercialForwardDeps(deps.store.env, AbortSignal.timeout(COMMERCIAL_FORWARD_INLINE_MS)));
  }
  // SAV-92 (review of batch 2, finding 1): a reply telling the customer part of the mail went to the team is proposed only once that part's notice is durably
  // queued (same execution ledger, never cancelled by a later mail). Otherwise nothing is proposed: the case waits visibly, no promise without the handoff.
  if (draft.reply.text.trimEnd().endsWith(SAV_CASE_TEAM_PART_MENTION)) {
    const queued = deps.policy ? await enqueueHandoffNotice({ caseId, policy: deps.policy, env: deps.store.env, inputKey: draft.inputKey }).catch(() => null) : null;
    if (!queued?.ok) return { status: "proposal_refused", caseId, code: "team_part_handoff_unavailable", detail: queued ? (queued.why ?? queued.code) : deps.policy ? "notice_unreadable" : "execution_policy_absent" };
  }
  // Per-block switch (12/11): off or paused, nothing is proposed for this block; the case waits visibly with the block's code (never a silent skip).
  const { blockId: gateBlock, gate } = await blockReplyGate(latest.blockIds, deps.store.env());
  if (gate.send === "never") return { status: "block_held", caseId, blockId: gateBlock, reason: gate.code, detail: gateBlock };
  // Pre-checks before any write: the configured rule, the facts, the provenance of the reply B is about to propose.
  // The language is resolved ONCE, as C will (same input, same function); the provenance is proven on the text prepared once, in that
  // language and in the `automated` mode B is about to ask for: what is checked is what would be stored, never the raw draft.
  const languageInput: CaseReplyLanguageInput = deps.language ? await deps.language(caseId) : { code: "unknown", proven: false };
  const language = resolveCaseReplyLanguage(languageInput);
  const config = readAccessAutoApprovalConfig(deps.store.env());
  const reasons: string[] = [];
  // The stricter of the global switch and the block's: either one short of `auto` leaves the proposal to a person.
  if (config.mode !== "on") reasons.push(`auto_${config.why}`);
  else if (gate.send === "person") reasons.push(gate.code);
  else if (!language) reasons.push("language_human_required");
  else {
    const text = prepareCaseReplyText(draft.reply.text, language.language, "automated", draft.reply.purpose);
    let proven = false;
    try {
      proven = (await readPilotReplyProvenance({ caseId, triggerEventId: draft.triggerEventId!, purpose: draft.reply.purpose, text }, deps.provenance)).status === "proven";
    } catch { proven = false; }
    if (!proven) reasons.push("provenance_unproven");
    const { facts, reasons: factReasons } = await autoFacts(caseId, deps, { draft, nextAction: latest.nextAction }, proven);
    reasons.push(...factReasons);
    if (!facts) reasons.push("facts_unread");
    else {
      if (facts.case.owner !== "agent" || !facts.case.admitted) reasons.push("case_not_admitted");
      if (facts.case.sensitivity !== "none") reasons.push("sensitive");
      const family = facts.smartSupport ? "other" : "access";
      if (!facts.openFamilies.length || facts.openFamilies.some(open => open !== family)) reasons.push("not_access_only");
      if (!["answer", "ask"].includes(latest.nextAction) && !(closingHandoffReplyEnabled(deps.store.env()) && isTerminalReply(draft.reply.purpose))) reasons.push("decision_not_reply");
      if (!facts.decision?.scopeCurrent) reasons.push("scope_not_current");
      if (facts.ownerNow !== "v2") reasons.push(facts.ownerNow === "unknown" ? "owner_unread" : "owner_not_v2");
    }
  }
  const auto = reasons.length === 0;
  // `automated` is formatting only (CONTRAT-B-C-UX): asked for here after the proofs, never a right; C decides what it stores.
  const input: CaseReplyDraftInput & Readonly<{ validation?: "automated" }> = {
    caseId, triggerEventId: draft.triggerEventId, decidedOn: draft.decidedOn, reply: draft.reply,
    language: languageInput, ...(auto ? { validation: "automated" as const } : {}),
  };
  const proposed = await proposeCaseReplyFromDraft(input, deps.store);
  if (!proposed.ok) return { status: "proposal_refused", caseId, code: proposed.code, ...(proposed.detail ? { detail: proposed.detail } : {}) };
  const validationId = proposed.validationId;
  if (proposed.state === "proposed") {
    if (!auto || config.mode !== "on") return { status: "awaiting_person", caseId, validationId, reasons };
    const decided = await decideCaseReply({ action: "approve", validationId, approverId: config.approverId, authorizer: caseAccessAutoReplyAuthorizer(deps), deps: deps.store,
      seen: { payloadHash: proposed.payloadHash, caseVersion: proposed.caseVersion, recipient: proposed.recipient } });
    if (!decided.ok) return { status: "awaiting_person", caseId, validationId, reasons: [decided.code, ...(decided.detail ? [decided.detail] : [])] };
  } else if (proposed.state !== "approved") return { status: "awaiting_person", caseId, validationId, reasons: [`validation_${proposed.state}`] };
  if (!deps.policy) return { status: "awaiting_person", caseId, validationId, reasons: ["execution_policy_absent"] };
  const queued = await queueValidatedCaseReply({ validationId, policy: deps.policy, deps: deps.store });
  if (!queued.ok) return { status: "queue_refused", caseId, validationId, code: queued.code, ...("detail" in queued && queued.detail ? { detail: queued.detail } : {}) };
  return { status: "queued", caseId, validationId, executionId: queued.executionId, created: queued.created };
}

/**
 * The end-to-end point for A (contract A-B): run the canonical investigation of the case, then, when the latest input has an accepted
 * recorded decision, the passage above. A calls it after a committed return (`continue` / `reopen`) and from its durable resumption.
 */
export async function runCaseInvestigationToReplyPlan(caseId: string, deps: Readonly<{ investigation: CaseInvestigationRuntimeDeps; reply: CaseReplyPassageDeps }>):
  Promise<Readonly<{ investigation: CaseInvestigationRuntimeReport; reply: CaseReplyPassageReport | null }>> {
  const investigation = await runCaseInvestigationRuntime(caseId, deps.investigation);
  // A run that recorded nothing new may still find an accepted decision already recorded (a replay after a crash): the passage is idempotent.
  const recorded = investigation.status === "recorded" || investigation.status === "already_recorded";
  return { investigation, reply: recorded ? await passCaseInvestigationToReplyPlan(caseId, deps.reply) : null };
}

/** The ports the passage needs, by name, for the integrator. None has a default: a missing one closes everything (fail-closed), the V2
 * budget ports (`knowledge.spend`, `model.money`) included: they are V2's own, never V1's, and nothing is paid without them. */
export const CASE_REPLY_PLAN_PORTS = [
  "investigation.readTicketOwner", "investigation.admissionPolicyRevision", "investigation.qualify", "investigation.customerTexts", "investigation.revisions",
  "investigation.ledger", "investigation.accessScope", "investigation.knowledge.vectors", "investigation.knowledge.embed", "investigation.knowledge.spend",
  "investigation.model.provider", "investigation.model.money",
  "provenance.accessScope", "provenance.currentPolicyRevision", "provenance.readActiveSource", "provenance.now",
  "store.env", "store.currentPolicyRevision", "store.readTicketOwner", "store.pilotProvenance",
] as const;

export type CaseReplyPlanBinding =
  | Readonly<{ ok: true; run(caseId: string): ReturnType<typeof runCaseInvestigationToReplyPlan> }>
  | Readonly<{ ok: false; missing: readonly (typeof CASE_REPLY_PLAN_PORTS)[number][] }>;

/** The callable binding for A's trigger and durable resumption: every port given or nothing runs (the missing ones are named). */
export function bindCaseInvestigationToReplyPlan(input: Readonly<{
  investigation: CaseInvestigationRuntimeDeps; provenance: Partial<PilotProvenanceDeps>; store: Partial<CaseReplyStoreDeps>;
  policy: CaseReplyPassageDeps["policy"]; language?: CaseReplyPassageDeps["language"];
}>): CaseReplyPlanBinding {
  const read = (path: string): unknown => path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], input);
  // A port is a function or an object of functions (the ledger, the vector index); absent or null is missing.
  const missing = CASE_REPLY_PLAN_PORTS.filter(path => { const port = read(path); return port === undefined || port === null || (typeof port !== "function" && typeof port !== "object"); });
  if (missing.length || input.investigation.mode !== "observe") return { ok: false, missing };
  const reply: CaseReplyPassageDeps = { store: input.store as CaseReplyStoreDeps, provenance: input.provenance as PilotProvenanceDeps, policy: input.policy,
    ...(input.language ? { language: input.language } : {}) };
  return { ok: true, run: caseId => runCaseInvestigationToReplyPlan(caseId, { investigation: input.investigation, reply }) };
}
