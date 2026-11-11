// V2 entry (LOCAL, OFF unless SAV_V2_ENTRY=on and SAV_CASE_RECORDING=on). What joins V1's runtime to the V2 case, on the existing stores:
//   customerReturnGate      before any claim, CRM read or model call of a run: a customer's answer on an open V2 case is consumed there and V1's run ends with it, in one transaction
//   v2EntryRelayDeps        after V1's confirmed effect: the return route first, then the relay with its admission sources and the owner read
//   continueCaseAfterCommit the real trigger after a commit; sweepCaseContinuations its durable catch-up. A failure stays visible (log and one durable marker per case), never swallowed
// It writes no HubSpot owner, invents no owner id, policy, rule or right: anything absent from the environment admits nobody.
import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savCaseEvents, savCases, savIntakeEffects, savIntakeExecutions, savIntakeJournal, savIntakeRuns, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { readSavExternalCompletion } from "../external-completion";
import { readSavAgentPause } from "../intake/agent-pause";
import { intakeHasHumanDecision, intakeHumanRefused } from "../intake/human-binding";
import { caseRelayAdmissionDeps, type CaseApprovedRulePort } from "./admission-investigation-ports";
import { readConfirmedV1Context } from "./admission-context-reader";
import { hubspotTicketOwnerReader, type CaseOwnerReadTransport } from "./admission-owner-reader";
import { admissionPolicyPort, qualifyTicketIdentity, type AdmissionPolicyRecord, type V1AdmissionAdapterPolicy } from "./admission-runtime";
import { savCaseRecordingEnabled, v1IntentHash, type CaseTx } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { routeCustomerReturn, type CustomerReturnDeps } from "./customer-return-store";
import { v2OwnerAtCreationPort } from "./owner-attribution";
import { bindSavV2QualificationThread, previewSavV2QualificationThread, savV2QualificationCaseAllowed, savV2QualificationMessageAllowed } from "./qualification-scope";
import { caseBlockCandidates, caseBlockRuleProvenance, selectCaseBlockRule, type CaseBlockDetector, type CaseEntryRule } from "./case-blocks";
import { SAV_CASE_BLOCK_REGISTRY } from "./case-block-registry";
import type { ExecutorAdapters } from "../intake/execution-types";
import { SAV_INTAKE_CONTRACT_REVISION, type SavIntakeDecision } from "../intake/contract";
import { relayPaused, type CaseRelayRequest, type CaseBoundaryDeps, type CaseRelayResult } from "./intake-boundary";
import { loadCaseContinuationPoint, type CaseContinuationPoint, type CaseContinuationTrigger } from "./v2-entry-binding";

type Env = Record<string, string | undefined>;
export const savV2EntryEnabled = (env: Env) => env.SAV_V2_ENTRY === "on" && savCaseRecordingEnabled(env);

/** How long a held run stays out of V1's four slots, so a mail that waits cannot starve the others. */
const HOLD_MS = 5 * 60_000;
const JOURNAL_KIND = "v2_customer_return";
const errorCode = (error: unknown) => error instanceof Error && /^SAV_[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SAV_V2_ENTRY_UNEXPECTED";

function parseEnvJson<T>(env: Env, name: string): T | null {
  const value = env[name];
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { throw Error(`SAV_V2_ENTRY_${name.replace(/^SAV_V2_/, "")}_INVALID`); }
}

/**
 * Approved rules are data, read from the environment; none is the default and proves nothing. `decideCaseAdmission` still checks each against the approved policy.
 * Treatment blocks (11/11): every approved `support` rule is evaluated, each by its block's detector (`case-block-registry.ts`); exactly one match admits, with
 * the rule's block in its provenance. No candidate, no match or several (ambiguous) admit nobody. The mail is read only when a candidate exists.
 */
export async function firstBlockEvidence(env: Env, messageId: string, gmailMessageId: string, requests: CaseRelayRequest[], registry: readonly CaseBlockDetector[] = SAV_CASE_BLOCK_REGISTRY) {
  if (requests.length !== 1 || requests[0].kind !== "support") return [];
  const candidates = caseBlockCandidates(parseEnvJson<CaseEntryRule[]>(env, "SAV_V2_ADMISSION_RULES_JSON") ?? [], registry);
  if (!candidates.length) return [];
  const [message] = await requireDb().select({ body: savMessages.bodyCiphertext, subject: savMessages.subject }).from(savMessages)
    .where(and(eq(savMessages.id, messageId), eq(savMessages.gmailMessageId, gmailMessageId), eq(savMessages.direction, "inbound")));
  if (!message) return [];
  const text = decryptSavPayload<{text?: unknown}>(message.body)?.text;
  if (typeof text !== "string") return [];
  const selected = selectCaseBlockRule(candidates, text, message.subject);
  // Two blocks claiming one mail is a configuration to review: visible, with no customer text, and nobody admitted.
  if (selected.reason === "ambiguous_block") console.error("sav_v2_entry_block_ambiguous", { messageId, blockIds: selected.blockIds });
  if (selected.reason !== "admitted") return [];
  return [{ requestId: requests[0].requestId, family: selected.rule.family, provenance: caseBlockRuleProvenance(selected.rule) }];
}
const rulesPort = (env: Env): CaseApprovedRulePort => ({context, requests}) =>
  firstBlockEvidence(env, context.source.messageId, context.source.gmailMessageId, requests);

/** Only called for the create intent under V1's execution lease, including its final pre-dispatch check.
 * No ticket or confirmed execution exists yet. The post-create relay independently requires both. */
export const creationOwnerForIntake = async (env: Env, input: Parameters<NonNullable<ExecutorAdapters["v2OwnerAtCreation"]>>[0]) => {
  const { decision, signal } = input;
  const disposition = decision.disposition;
  if (!savV2EntryEnabled(env) || signal.aborted || decision.revision !== SAV_INTAKE_CONTRACT_REVISION
    || decision.latestInboundMessageId !== decision.messageId || decision.classification !== "support"
    || decision.requests.length !== 1 || decision.requests[0].kind !== "support"
    || disposition.kind !== "ticket" || disposition.target.operation !== "create"
    || disposition.target.contactId !== disposition.contactScope.primaryContactId)
    return { assign: false as const, reason: "not_admitted" };
  const sources = v2EntryPolicySources(env);
  const decided = await v2OwnerAtCreationPort({ env,
    readAdmissionPolicy: admissionPolicyPort({ read: sources.readPolicyRecord, now: () => new Date() }),
    readQualification: async ({messageId, gmailMessageId, requests}) => {
      if (signal.aborted || await intakeHumanRefused(messageId)) return null;
      const { qualification } = qualifyTicketIdentity(decision, await sources.adapterPolicy(), true);
      return { ...qualification, requests: await firstBlockEvidence(env, messageId, gmailMessageId, requests) };
    },
  })(input);
  if (!decided.assign) return decided;
  // SAV-80: in qualification mode only the first admissible thread of the exact sender, contact, subject and window gets the V2 owner;
  // it is bound here, at this check and at the final pre-dispatch one alike. Anything else: no V2 owner, V1 creates its ticket as today.
  const scoped = await bindSavV2QualificationThread(env, { messageId: decision.messageId, primaryContactId: disposition.contactScope.primaryContactId });
  return scoped.allowed ? decided : { assign: false as const, reason: "not_admitted" as const };
};

/** The ticket V1 created for this execution: its `ticket_create` confirmed, intact, acknowledged with this ticket id. Uncertain, merely sent or another ticket is no proof. */
async function v1CreatedTicket(executionId: string, ticketId: string) {
  const [create] = await requireDb().select().from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, executionId), eq(savIntakeEffects.kind, "ticket_create")));
  if (!create || create.state !== "confirmed" || !create.ackCiphertext) return false;
  const intent = decryptSavPayload<{ kind?: string; key?: string }>(create.intentCiphertext);
  return v1IntentHash(intent) === create.intentHash && intent.kind === "ticket_create" && intent.key === create.businessKey && decryptSavPayload<{ id?: string }>(create.ackCiphertext).id === ticketId;
}

/**
 * SAV-81: the relay's binder for a mail V1 already confirmed, in qualification mode only (the scope checks themselves answer `open` or `closed` otherwise).
 * The real test mail opened its thread and V1 created its ticket, but its subject did not match at the creation, so nothing was bound and the relay could
 * never attribute it. This binds it once an operator put that ticket under the V2 owner, with exactly the creation's conditions and V1's current proofs:
 * the execution confirmed on this ticket and run version, no newer run, no operator refusal, the current contract's decision of ONE support request that
 * CREATED this ticket for the unique primary contact, its `ticket_create` confirmed for this ticket, no other mail on the thread, the thread not paused, no
 * person's decision on the mail, not handled outside, and (before the write) no agent pause; then
 * the exact scope (sender, contact, first message, subject, window, hash, revision, one thread). The owner itself is read by the relay, between the read-only
 * check and the write. It writes no CRM owner. Unreadable is refused, never guessed.
 */
export function qualificationRelayBinder(env: Env): NonNullable<CaseBoundaryDeps["bindQualificationThread"]> {
  return async input => {
    try {
      const context = await readConfirmedV1Context(input.messageId);
      if (!context) return false;
      const { source, freshness } = context, decision = context.decision as SavIntakeDecision, disposition = decision.disposition;
      if (source.executionState !== "confirmed" || source.executionId !== input.executionId || source.ticketId !== input.ticketId || source.runId !== input.runId
        || source.runVersion !== input.runVersion || freshness.latestRunVersion !== input.runVersion || freshness.humanRefused) return false;
      if (decision.revision !== SAV_INTAKE_CONTRACT_REVISION || decision.messageId !== input.messageId || decision.latestInboundMessageId !== input.messageId
        || decision.classification !== "support" || decision.requests.length !== 1 || decision.requests[0]!.kind !== "support"
        || disposition.kind !== "ticket" || disposition.target.operation !== "create" || disposition.target.contactId !== disposition.contactScope.primaryContactId) return false;
      if (!await v1CreatedTicket(input.executionId, input.ticketId)) return false;
      const db = requireDb();
      const [message] = await db.select({ id: savMessages.id, threadId: savMessages.threadId, receivedAt: savMessages.receivedAt, gmailMessageId: savMessages.gmailMessageId })
        .from(savMessages).where(eq(savMessages.id, input.messageId));
      if (!message) return false;
      // A person's hold: the thread paused, a person's decision on the mail, or the case handled outside. Any of them keeps it with the team.
      const [thread] = await db.select({ aiPaused: savThreads.aiPaused }).from(savThreads).where(eq(savThreads.id, message.threadId));
      if (!thread || thread.aiPaused || await intakeHasHumanDecision(input.messageId) || await readSavExternalCompletion(message)) return false;
      // A new customer mail since: it is not the confirmed mail this binding stands on.
      const inbound = await db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, message.threadId), eq(savMessages.direction, "inbound")));
      if (inbound.some(row => row.id !== input.messageId)) return false;
      // A pause set since the owner read: nothing is bound (the store would refuse the attribution under its lock anyway).
      if (input.write && await relayPaused(db)) return false;
      const scope = { messageId: input.messageId, primaryContactId: disposition.contactScope.primaryContactId };
      return (await (input.write ? bindSavV2QualificationThread(env, scope) : previewSavV2QualificationThread(env, scope))).allowed;
    } catch { return false; }
  };
}

/** One authenticated GET on V1's own HubSpot transport. Throws on anything but a 2xx: a failed read is never « no owner ». */
function ownerTransport(env: Env, network?: typeof fetch): CaseOwnerReadTransport {
  return async ({ path }) => {
    const { createSavHubspotTransport } = await import("../hubspot-transport");
    const token = env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw Error("SAV_V2_ENTRY_CRM_TOKEN_MISSING");
    return createSavHubspotTransport(network ?? fetch)(path, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, status => `HUBSPOT_HTTP_${status}`);
  };
}

type EntryDeps = { env: Env; network?: typeof fetch; continuation?: CaseContinuationPoint | null; returnDeps?: Partial<CustomerReturnDeps> };

function returnSources(input: EntryDeps): CustomerReturnDeps {
  const { env } = input, readOwner = hubspotTicketOwnerReader(ownerTransport(env, input.network));
  return { env, readTicketOwner: readOwner, ...admissionSources(env), ...input.returnDeps };
}
export function readV2EntryPolicyRecord(env: Env) {
  return parseEnvJson<AdmissionPolicyRecord>(env, "SAV_V2_ADMISSION_POLICY_JSON");
}

export function v2EntryPolicySources(env: Env) {
  return {
    approvedRules: rulesPort(env),
    adapterPolicy: async () => parseEnvJson<V1AdmissionAdapterPolicy>(env, "SAV_V2_ADAPTER_POLICY_JSON"),
    readPolicyRecord: async () => readV2EntryPolicyRecord(env),
  };
}

function admissionSources(env: Env) {
  return caseRelayAdmissionDeps({
    readConfirmedContext: readConfirmedV1Context, now: () => new Date(), ...v2EntryPolicySources(env),
  });
}

/** The relay's deps once V1 is done with a mail: the return route decides first; only what it leaves to V1 is relayed. */
export function v2EntryRelayDeps(env: Env, input: Omit<EntryDeps, "env"> = {}): CaseBoundaryDeps {
  const sources = returnSources({ env, ...input });
  return {
    env, ...admissionSources(env), readCreatedTicketOwner: sources.readTicketOwner!, bindQualificationThread: qualificationRelayBinder(env),
    routeReturn: async (messageId): Promise<CaseRelayResult | null> => {
      // SAV-80: outside the qualification scope a mail is never routed as a V2 return; the normal relay goes on.
      if (!(await savV2QualificationMessageAllowed(env, messageId)).allowed) return null;
      const outcome = await routeCustomerReturn(messageId, sources);
      if ("skipped" in outcome) return null;
      if (outcome.written) return { caseId: outcome.record.case.caseId, version: outcome.record.case.version, created: false, appended: !outcome.record.replayed, owner: outcome.record.case.owner,
        relay: "v2_customer_return", admission: outcome.record.case.admission && { target: outcome.record.case.admission.target, reasons: outcome.record.case.admission.reasons } };
      if (outcome.route.route === "wait") return { skipped: "customer_return_wait" };
      // An automatic reply must not cancel the J2 through the relay; a late older mail must not become the latest input.
      if (outcome.route.route === "ignore_automated" || outcome.route.route === "keep_latest") return { skipped: "customer_return_not_consumed" };
      return null;
    },
  };
}

/** Thread, then run (V1's claim order), then the case in the caller's transaction. Refuses if V1 engaged this run since the gate read it. */
async function endRunInTransaction(tx: CaseTx, runId: string, threadId: string, messageId: string, route: string) {
  await tx.select({ id: savThreads.id }).from(savThreads).where(eq(savThreads.id, threadId)).for("update");
  const [run] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId)).for("update");
  const [execution] = await tx.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, messageId));
  if (!run?.isCurrent || run.attempts !== 0 || run.leaseToken || !["pending", "waiting"].includes(run.state) || execution) throw Error("SAV_V2_ENTRY_V1_ENGAGED");
  await closeRun(tx, runId, messageId, route);
}
async function closeRun(tx: CaseTx, runId: string, messageId: string, route: string) {
  await tx.update(savIntakeRuns).set({ isCurrent: false, state: "superseded", leaseUntil: null, freshUntil: null, updatedAt: new Date() }).where(eq(savIntakeRuns.id, runId));
  await tx.insert(savIntakeJournal).values({ runId, kind: JOURNAL_KIND, payloadCiphertext: encryptSavPayload({ messageId, route }) });
  await tx.update(savMessages).set({ analysisStatus: "intake_v2_return" }).where(eq(savMessages.id, messageId));
}

/** The run keeps its state and its attempts; it comes back after a delay. */
async function holdRun(runId: string) {
  await requireDb().update(savIntakeRuns).set({ leaseUntil: new Date(Date.now() + HOLD_MS), updatedAt: new Date() }).where(and(eq(savIntakeRuns.id, runId), eq(savIntakeRuns.attempts, 0)));
}

export type CustomerReturnGateStop = { skipped: "v2_customer_return" | "v2_customer_return_hold" };

/** The durable proof that V2 took this mail on the `continue` route, read from the journal without any CRM or model call. A return handed to the team is not one: V1 still owes it to the person. */
async function consumedByReturn(gmailMessageId: string | null) {
  if (!gmailMessageId) return false;
  const rows = await requireDb().select({ payload: savCaseEvents.payloadCiphertext }).from(savCaseEvents).where(eq(savCaseEvents.dedupeKey, caseDedupeKey.inbound(gmailMessageId)));
  return rows.some(row => {
    const relay = decryptSavPayload<{ detail?: { relay?: { kind?: unknown; route?: unknown } } | null }>(row.payload).detail?.relay;
    return relay?.kind === "v2_customer_return" && relay.route === "continue";
  });
}

/** A mail V2 already consumed never reaches a model again, whatever brought a run back to it: a wake replayed, a concurrent pass, a new configuration, V1's retry. Only a V1 that is really engaged keeps its run
 * (an execution with its external effects, a live lease, a result to reconcile, a person's decision); nothing of it is cut short. Null: that V1 goes on. */
async function stopConsumedRun(run: { id: string; threadId: string; messageId: string; isCurrent: boolean }): Promise<CustomerReturnGateStop | null> {
  if (!run.isCurrent) return { skipped: "v2_customer_return" };
  if (await intakeHasHumanDecision(run.messageId)) return null;
  const closed = await requireDb().transaction(async tx => {
    await tx.select({ id: savThreads.id }).from(savThreads).where(eq(savThreads.id, run.threadId)).for("update");
    const [locked] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, run.id)).for("update");
    if (!locked?.isCurrent) return "already" as const;
    const [execution] = await tx.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, run.messageId));
    if (execution || locked.state === "uncertain" || (locked.leaseToken && locked.leaseUntil && locked.leaseUntil.getTime() > Date.now())) return "engaged" as const;
    await closeRun(tx, run.id, run.messageId, "already_consumed");
    return "closed" as const;
  });
  if (closed === "engaged") return null;
  if (closed === "closed") await projectThread(run.threadId);
  return { skipped: "v2_customer_return" };
}

/** Null: V1 goes on as it would have. A mail already consumed stops here first. Otherwise only a first pass of V1 can be stopped: a run already engaged, an execution, a person's decision, a paused thread or an external completion stays V1's. */
export async function customerReturnGate(runId: string, input: EntryDeps): Promise<CustomerReturnGateStop | null> {
  if (!savV2EntryEnabled(input.env)) return null;
  const db = requireDb();
  const [run] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
  if (!run) return null;
  // A full pause (or an unreadable one) allows no claim and no write: V1's own refusal answers, unchanged, and the mail stays for later.
  const pause = await readSavAgentPause(db);
  if (pause.invalid || pause.level === "fully_paused") return null;
  const [source] = await db.select({ gmail: savMessages.gmailMessageId }).from(savMessages).where(eq(savMessages.id, run.messageId));
  if (await consumedByReturn(source?.gmail ?? null)) return stopConsumedRun(run);
  // SAV-80: outside the qualification scope (another thread, another sender, no or an expired scope) V2 takes nothing: V1 goes on.
  if (!(await savV2QualificationMessageAllowed(input.env, run.messageId)).allowed) return null;
  if (!run.isCurrent || run.attempts !== 0 || run.leaseToken || !["pending", "waiting"].includes(run.state)) return null;
  const [execution] = await db.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, run.messageId));
  const [thread] = await db.select({ aiPaused: savThreads.aiPaused }).from(savThreads).where(eq(savThreads.id, run.threadId));
  const [message] = await db.select({ id: savMessages.id, threadId: savMessages.threadId, receivedAt: savMessages.receivedAt, gmailMessageId: savMessages.gmailMessageId }).from(savMessages).where(eq(savMessages.id, run.messageId));
  if (execution || !message || thread?.aiPaused || await intakeHasHumanDecision(run.messageId) || await readSavExternalCompletion(message)) return null;
  try {
    const outcome = await routeCustomerReturn(run.messageId, { ...returnSources(input), fence: tx => endRunInTransaction(tx, run.id, run.threadId, run.messageId, "continue") });
    if ("skipped" in outcome) return null;
    if (outcome.written) {
      if (outcome.route.route !== "continue") return null; // handed to the team: V1 goes on, so the person gets the mail on the ticket as today.
      if (outcome.record.case.owner === "agent") await continueCaseAfterCommit(outcome.record.case.caseId, "customer_return", input);
      await projectThread(run.threadId);
      return { skipped: "v2_customer_return" };
    }
    if (outcome.retry) { await holdRun(run.id); return { skipped: "v2_customer_return_hold" }; }
    if (outcome.route.route === "wait" && outcome.route.reason !== "v1_pending") { await holdRun(run.id); return { skipped: "v2_customer_return_hold" }; }
    // Consumed by a concurrent pass since the check above; the sweep owns its continuation. Recorded by another route: V1 goes on.
    if (outcome.route.route === "already_recorded" && await consumedByReturn(message.gmailMessageId)) return stopConsumedRun(run);
    return null;
  } catch (error) {
    // The fence refused. A concurrent pass consuming this mail is not « V1 engaged »: re-read the proof before handing anything to V1.
    if (errorCode(error) === "SAV_V2_ENTRY_V1_ENGAGED" || errorCode(error) === "SAV_CASE_RETURN_ROUTE_CHANGED") {
      if (!await consumedByReturn(message.gmailMessageId)) return null;
      const [fresh] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, run.id));
      return fresh ? stopConsumedRun(fresh) : { skipped: "v2_customer_return" };
    }
    // Unavailable is not absent: the mail is kept for the next pass, no model is called on a guess.
    console.error("sav_v2_entry_gate", { runId, errorCode: errorCode(error) });
    await holdRun(run.id).catch(() => {});
    return { skipped: "v2_customer_return_hold" };
  }
}

async function projectThread(threadId: string) {
  await (await import("../intake/console-store")).projectIntakeThread(threadId).catch(() => { console.error("sav_v2_entry_projection", { threadId }); });
}

const FAILURE_MARK = { action: "sav_v2_continuation_failed", entityType: "sav_v2_case" } as const;
/** One durable marker per case, updated in place, cleared by the next success: a failure after a commit can be read later and cannot grow without bound. */
async function markContinuation(caseId: string, trigger: CaseContinuationTrigger, code: string | null) {
  const row = and(eq(auditLogs.entityType, FAILURE_MARK.entityType), eq(auditLogs.entityId, caseId), eq(auditLogs.action, FAILURE_MARK.action));
  const [existing] = await requireDb().select().from(auditLogs).where(row);
  if (code === null) { if (existing) await requireDb().delete(auditLogs).where(row); return; }
  const technicalMetadata = { code, trigger, failures: Number((existing?.technicalMetadata as { failures?: unknown } | null)?.failures ?? 0) + 1, lastAt: new Date().toISOString() };
  if (existing) await requireDb().update(auditLogs).set({ technicalMetadata }).where(row);
  else await requireDb().insert(auditLogs).values({ actorEmail: "system", ...FAILURE_MARK, entityId: caseId, technicalMetadata });
}

export type CaseContinuationOutcome = { status: string } | { status: "failed"; code: string };
/** Called after the commit, on every path. It never undoes or fails what was committed; what went wrong is logged and marked, and the sweep tries the case again. */
export async function continueCaseAfterCommit(caseId: string, trigger: CaseContinuationTrigger, input: EntryDeps): Promise<CaseContinuationOutcome> {
  let code: string;
  // SAV-80: no investigation, retrieval or model cost for a case outside the qualification scope or after it expired. Not a failure: nothing is marked.
  const scoped = await savV2QualificationCaseAllowed(input.env, caseId).catch(() => ({ allowed: false as const, reason: "qualification_unreadable" }));
  if (!scoped.allowed) return { status: "qualification_out_of_scope" };
  try {
    const point = input.continuation === undefined ? await loadCaseContinuationPoint() : input.continuation;
    if (point) {
      const report = await point({ caseId, trigger, env: input.env });
      await markContinuation(caseId, trigger, null);
      return report;
    }
    code = "point_not_bound";
  } catch (error) { code = errorCode(error); }
  console.error("sav_v2_entry_continuation", { caseId, trigger, errorCode: code });
  try { await markContinuation(caseId, trigger, code); } catch (error) { console.error("sav_v2_entry_continuation_mark", { caseId, errorCode: errorCode(error) }); }
  return { status: "failed", code };
}

/** Durable catch-up after a crash between a commit and its trigger, or a failed trigger: the cases the agent holds that are still queued, bounded. A pause stops it.
 * Never tried or not failing first, then the failure tried longest ago: a case that keeps failing cannot hold a slot against the others. */
export async function sweepCaseContinuations(input: EntryDeps & { limit?: number }) {
  if (!savV2EntryEnabled(input.env)) return { skipped: "off" as const };
  const db = requireDb();
  if (await relayPaused(db)) return { skipped: "paused" as const };
  const limit = Math.min(Math.max(input.limit ?? 4, 1), 20);
  const candidates = await db.select({ id: savCases.id }).from(savCases).where(and(eq(savCases.owner, "agent"), eq(savCases.phase, "queued"))).orderBy(asc(savCases.updatedAt), asc(savCases.id)).limit(200);
  const marks = candidates.length ? await db.select({ id: auditLogs.entityId, meta: auditLogs.technicalMetadata }).from(auditLogs)
    .where(and(eq(auditLogs.entityType, FAILURE_MARK.entityType), eq(auditLogs.action, FAILURE_MARK.action), inArray(auditLogs.entityId, candidates.map(row => row.id)))) : [];
  const failedAt = new Map(marks.map(mark => [mark.id, Date.parse(String((mark.meta as { lastAt?: unknown } | null)?.lastAt)) || 0]));
  // Stable sort: untouched cases keep their oldest-first order.
  const queued = [...candidates].sort((a, b) => (failedAt.get(a.id) ?? -1) - (failedAt.get(b.id) ?? -1)).slice(0, limit);
  const outcome = { tried: 0, failed: {} as Record<string, number> };
  for (const { id } of queued) {
    outcome.tried++;
    const result = await continueCaseAfterCommit(id, "sweep", input);
    if (result.status === "failed") { const code = (result as { code: string }).code; outcome.failed[code] = (outcome.failed[code] ?? 0) + 1; }
  }
  return outcome;
}
