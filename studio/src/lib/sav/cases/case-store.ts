import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, like, lte, max, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savCaseEvents, savCaseReplyValidations, savCaseTimers, savCases, savIntakeEffects, savIntakeExecutions, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { readCaseBlockHold } from "./case-block-hold";
import { caseAdmissionStatus, caseRequestFamilyProven, decideCaseAdmission, type CaseAdmissionInput } from "./admission-policy";
import {
  SAV_CASE_ADMISSION_TEAM_REASONS, SAV_CASE_CONTRACT_REVISION, SAV_CASE_DEDUPE_PATTERNS, SAV_CASE_EVENT_DIRECTIONS, SAV_CASE_EVENT_KIND_DIRECTIONS, SAV_CASE_OWNER_TRANSITIONS, SAV_CASE_OWNERS,
  SAV_CASE_CONTRACT_UPGRADES, SAV_CASE_INBOUND_SETTLE_SECONDS, SAV_CASE_PHASES, SAV_CASE_SENSITIVITIES, SAV_CASE_TIMER_CANCEL_REASONS, SAV_CASE_TIMER_STATES, caseAdmissionQualificationSchema, caseBodySchema, caseDedupeKey,
  SAV_CASE_ATTACHMENT_REF, SAV_CASE_AWAITING_V2_ATTRIBUTION, SAV_CASE_CRM_CHANGES, caseAttributionProofSchema, caseAwaitsV2Attribution, SAV_CASE_HOLDS_KEEPING_TIMERS, SAV_CASE_OPEN_REQUESTS_MAX, SAV_CASE_RETIRED_TRANSITIONS, SAV_CASE_SENSITIVE_FAMILIES, caseEventIsAdmissionInput, caseObservationSchema, caseOwnerAllowsPhase, caseSensitivityForFamily, caseTimerKey, emptyCaseBody, sourceRefSchema,
  type CaseActor, type CaseAdmissionDecision, type CaseAdmissionQualification, type CaseAdmissionRecord, type CaseBody, type CaseClaim, type CaseClaimRefusal, type CaseEvent,
  type CaseCrmChange, type CaseEventDirection, type CaseEventKind, type CaseObservation, type CaseOwner, type CaseOwnerTransition, type CasePhase, type CaseSnapshot, type CaseTimer,
  type CaseAttributionProof, type CaseRequestFamily, type CaseRequestSubject, type CaseSensitivity, type CaseTimerCancelReason, type SourceRef,
  SAV_CASE_QUALIFICATION_DIAGNOSTIC_REVISION, type CaseQualificationDiagnostic,
} from "./case-types";
import { trialsOnCustomerReturn } from "./case-trial-return";
import { caseQualificationPrecheck } from "./qualification-diagnostic";

type Db = ReturnType<typeof requireDb>;
export type CaseTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseRow = typeof savCases.$inferSelect;
type TimerRow = typeof savCaseTimers.$inferSelect;
type Env = Record<string, string | undefined>;

/** Off unless explicitly "on": with it off nothing is written and V1 is unchanged. */
export function savCaseRecordingEnabled(env: Env = process.env) { return env.SAV_CASE_RECORDING === "on"; }

const fault = (code: string): never => { throw Error(`SAV_CASE_${code}`); };
/** The loser of a concurrent write re-reads at `currentVersion` and decides again. */
export class CaseVersionStaleError extends Error {
  constructor(readonly currentVersion: number) { super("SAV_CASE_VERSION_STALE"); }
}

const CRM_ID = /^\d{1,30}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, CODE = /^[a-z0-9_.:-]{1,200}$/i;

async function assertWritable(db: Db | CaseTx) {
  if (!savCaseRecordingEnabled()) fault("RECORDING_OFF");
  const [row] = await db.select({ key: savSyncState.key }).from(savSyncState).where(eq(savSyncState.key, "sav-case-schema-v4"));
  if (!row) fault("SCHEMA_MISSING");
}
/** Lot 3 (contract for C's single transaction): with the caller's `tx`, no nested transaction and no
 * retry in another one; the schema marker and every read and write use it, so a refusal that throws
 * rolls the caller's whole transaction back. Without it, the historical transaction of each writer. */
const withCaseTx = <T>(tx: CaseTx | undefined, run: (tx: CaseTx) => Promise<T>): Promise<T> => tx ? run(tx) : requireDb().transaction(run);
// One lock namespace per ticket: creation has no row to lock yet, updates reuse it.
const lockTicket = (tx: CaseTx, ticketId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sav-case-ticket:${ticketId}`}))`);

async function lockedCase(tx: CaseTx, caseId: string) {
  if (!UUID.test(caseId)) fault("NOT_FOUND");
  const [head] = await tx.select({ ticketId: savCases.ticketId }).from(savCases).where(eq(savCases.id, caseId));
  if (!head) return fault("NOT_FOUND");
  await lockTicket(tx, head.ticketId);
  const [row] = await tx.select().from(savCases).where(eq(savCases.id, caseId)).for("update");
  return upgradeLocked(tx, row!);
}

/** Body of a stored row in the current contract: through a declared upgrade, or refused. */
function currentBody(row: CaseRow): CaseBody {
  const upgrade = row.contractRevision === SAV_CASE_CONTRACT_REVISION ? (body: unknown) => body : SAV_CASE_CONTRACT_UPGRADES[row.contractRevision];
  if (!upgrade) return fault("CONTRACT_UNSUPPORTED");
  const body = caseBodySchema.safeParse(upgrade(decryptSavPayload(row.payloadCiphertext)));
  return body.success ? body.data : fault("PAYLOAD_INVALID");
}
/** Under the lock, an older row is rewritten once in the current contract. It is a format
 * change, not a content change: the version stays, so no prepared decision is invalidated. */
async function upgradeLocked(tx: CaseTx, row: CaseRow) {
  if (row.contractRevision === SAV_CASE_CONTRACT_REVISION) return row;
  const body = currentBody(row);
  const [next] = await tx.update(savCases).set({ contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(body) })
    .where(and(eq(savCases.id, row.id), eq(savCases.version, row.version))).returning();
  if (!next) throw new CaseVersionStaleError(row.version);
  return next;
}

const member = <T extends string>(values: readonly T[], value: string) => (values as readonly string[]).includes(value) ? value as T : fault("ROW_INVALID");
function toSnapshot(row: CaseRow): CaseSnapshot {
  const body = currentBody(row);
  return {
    contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: row.id, ticketId: row.ticketId, threadIds: [...row.threadIds], version: row.version,
    owner: member(SAV_CASE_OWNERS, row.owner), phase: member(SAV_CASE_PHASES, row.phase), sensitivity: member(SAV_CASE_SENSITIVITIES, row.sensitivity),
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), body,
    admission: row.admissionCiphertext ? decryptSavPayload<CaseAdmissionRecord>(row.admissionCiphertext) : null,
    admissionInputVersion: row.admissionInputVersion,
  };
}
/** A full list is its own error: the caller must hand the case over, not retry forever. */
function parseBody(body: CaseBody) {
  const parsed = caseBodySchema.safeParse(body);
  if (parsed.success) return parsed.data;
  return fault(parsed.error.issues.some(issue => issue.code === "too_big" && issue.path.length === 1) ? "BODY_LIMIT_REACHED" : "BODY_INVALID");
}

/** `direction` defaults when the kind allows only one; `occurredAt` (message received or
 * sent) is required for messages and defaults to now for internal events. */
type EventInput = { kind: CaseEventKind; dedupeKey: string; sourceRef: SourceRef; detail?: Record<string, unknown>; direction?: CaseEventDirection; occurredAt?: string };
type ValidEvent = EventInput & { direction: CaseEventDirection; occurredAt: string; crmChange: CaseCrmChange };
const occurredAtSchema = z.iso.datetime({ offset: true });
function validEvent(input: EventInput): ValidEvent {
  if (!SAV_CASE_DEDUPE_PATTERNS[input.kind]?.test(input.dedupeKey)) fault("DEDUPE_KEY_INVALID");
  const allowed = SAV_CASE_EVENT_KIND_DIRECTIONS[input.kind];
  const direction = input.direction ?? (allowed.length === 1 ? allowed[0]! : fault("DIRECTION_INVALID"));
  if (!allowed.includes(direction)) fault("DIRECTION_INVALID");
  if (input.occurredAt === undefined && direction !== "internal") fault("OCCURRED_AT_REQUIRED");
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (!occurredAtSchema.safeParse(occurredAt).success) fault("OCCURRED_AT_INVALID");
  const sourceRef = sourceRefSchema.safeParse(input.sourceRef);
  if (!sourceRef.success) return fault("SOURCE_REF_INVALID");
  // Stored typed on every CRM observation; anything else carries none.
  const crmChange = input.kind === "crm_observed" ? input.detail?.crmChange ?? "unknown" : "unknown";
  if (!(SAV_CASE_CRM_CHANGES as readonly unknown[]).includes(crmChange)) fault("CRM_CHANGE_INVALID");
  const detail = input.kind === "crm_observed" ? { ...input.detail, crmChange } : input.detail;
  return { ...input, detail, direction, occurredAt, sourceRef: sourceRef.data, crmChange: crmChange as CaseCrmChange };
}

/** Cleared with any owner change away from the agent (see sav_cases_claim_agent_only). */
const NO_CLAIM = { claimToken: null, claimVersion: null, claimHolder: null, claimUntil: null } as const;

/** The signals that end a scheduled J2 timer. A technical pause is not one of them, nor a
 * technical or organisational hold of the case (Q9); a personal human takeover is. */
function timerCancelReason(input: ValidEvent, next: CaseRow): CaseTimerCancelReason | null {
  if (input.kind === "inbound_confirmed") return "customer_inbound";
  if (input.kind === "outbound_observed" && input.direction === "human_outbound") return "human_outbound";
  if (input.kind !== "owner_changed" || next.owner === "agent") return null;
  const transition = input.detail?.transition as CaseOwnerTransition | "admission_withdrawn" | undefined;
  if (SAV_CASE_HOLDS_KEEPING_TIMERS.includes(transition as CaseOwnerTransition)) return null;
  return transition === "admission_withdrawn" ? "admission_withdrawn" : "owner_changed";
}
async function cancelScheduledTimers(tx: CaseTx, caseId: string, reason: CaseTimerCancelReason, except?: string) {
  await tx.update(savCaseTimers).set({ state: "cancelled", cancelReason: reason, cancelledAt: new Date() })
    .where(and(eq(savCaseTimers.caseId, caseId), eq(savCaseTimers.state, "scheduled"), ...(except ? [ne(savCaseTimers.id, except)] : [])));
}

/** Insert first: (caseId, dedupeKey) is unique, so a replay inserts nothing and bumps nothing.
 * Timers the event ends are cancelled in the same transaction, so a due timer and a crossing
 * signal are serialised by the case lock. */
async function appendLocked(tx: CaseTx, row: CaseRow, input: ValidEvent, threadId?: string) {
  const version = row.version + 1;
  const [inserted] = await tx.insert(savCaseEvents).values({
    caseId: row.id, kind: input.kind, dedupeKey: input.dedupeKey, caseVersion: version, direction: input.direction, occurredAt: new Date(input.occurredAt),
    payloadCiphertext: encryptSavPayload({ sourceRef: input.sourceRef, detail: input.detail ?? null }),
  }).onConflictDoNothing().returning({ id: savCaseEvents.id });
  if (!inserted) return { appended: false, row };
  const threadIds = threadId && !row.threadIds.includes(threadId) ? [...row.threadIds, threadId] : row.threadIds;
  // An input makes the recorded admission stale until it is re-evaluated.
  const admissionInputVersion = caseEventIsAdmissionInput(input.kind, input.direction, input.crmChange) ? version : row.admissionInputVersion;
  const [next] = await tx.update(savCases).set({ version, threadIds, admissionInputVersion, updatedAt: new Date() })
    .where(and(eq(savCases.id, row.id), eq(savCases.version, row.version))).returning();
  if (!next) throw new CaseVersionStaleError(row.version);
  const cancel = timerCancelReason(input, next);
  if (cancel) await cancelScheduledTimers(tx, row.id, cancel);
  return { appended: true, row: next };
}

function parseQualification(qualification: CaseAdmissionQualification) {
  const parsed = caseAdmissionQualificationSchema.safeParse(qualification);
  return parsed.success ? parsed.data : fault("ADMISSION_INPUT_INVALID");
}
type CaseUpdate = Partial<typeof savCases.$inferInsert>;

/** Appends `admission_decided`, then stores the admission next to any owner change it
 * carries, in one CAS update so the database checks see both together. */
async function recordAdmission(tx: CaseTx, row: CaseRow, decision: CaseAdmissionDecision, qualification: CaseAdmissionQualification, sourceRef: SourceRef, extra: CaseUpdate = {}) {
  const appended = await appendLocked(tx, row, validEvent({
    kind: "admission_decided", dedupeKey: caseDedupeKey.admission(row.version + 1, decision.policyRevision), sourceRef,
    detail: { target: decision.target, reasons: decision.reasons, policyRevision: decision.policyRevision },
  }));
  if (!appended.appended) throw new CaseVersionStaleError(row.version);
  const recordedAt = new Date();
  const record: CaseAdmissionRecord = { ...decision, decidedAt: recordedAt.toISOString(), version: appended.row.version, inputVersion: row.admissionInputVersion, qualification };
  const [next] = await tx.update(savCases).set({
    ...extra, admissionTarget: decision.target, admissionReason: decision.reasons[0]!, admissionPolicyRevision: decision.policyRevision,
    admissionVersion: record.version, admissionDecidedAt: recordedAt, admissionCiphertext: encryptSavPayload(record), updatedAt: recordedAt,
  }).where(and(eq(savCases.id, row.id), eq(savCases.version, appended.row.version))).returning();
  if (!next) throw new CaseVersionStaleError(appended.row.version);
  return next;
}

/** Re-evaluated admission applied to the case: sensitivity only rises; an agent case that
 * is no longer admitted goes to the team ("to take", not "taken"); a human or held case
 * keeps its owner whatever the result. */
async function applyAdmission(tx: CaseTx, row: CaseRow, admission: CaseAdmissionInput, sourceRef: SourceRef) {
  const current = toSnapshot(row);
  const qualification = parseQualification(admission.qualification);
  const decision = decideCaseAdmission({ policy: admission.policy, qualification, caseSensitivity: current.sensitivity });
  const withdraw = current.owner === "agent" && decision.target !== "agent";
  const extra: CaseUpdate = { sensitivity: decision.sensitivity };
  // v9: a case waiting for its V2 owner that is no longer admitted shows the team's real reason.
  if (caseAwaitsV2Attribution(current) && decision.target !== "agent") extra.payloadCiphertext = encryptSavPayload(parseBody({ ...current.body, handoff: { reason: decision.reasons[0]! } }));
  if (withdraw) Object.assign(extra, { ...NO_CLAIM, owner: "human", phase: "handoff_pending", payloadCiphertext: encryptSavPayload(parseBody({ ...current.body, handoff: { reason: decision.reasons[0]! } })) });
  const recorded = await recordAdmission(tx, row, decision, qualification, sourceRef, extra);
  if (!withdraw) return recorded;
  return (await appendLocked(tx, recorded, validEvent({
    kind: "owner_changed", dedupeKey: caseDedupeKey.admissionRule(recorded.version), sourceRef,
    detail: { transition: "admission_withdrawn", from: "agent", to: "human", fromPhase: current.phase, toPhase: "handoff_pending", reasons: decision.reasons },
  }))).row;
}

/** Family of a request a message opens (v8): a sensitive family from any source (a model hint may
 * always exclude), else the one family a human or a rule the policy lists proves, else `other`.
 * It describes the request; the admission still decides from the qualification alone. */
function openedFamily(requestId: string, qualification: CaseAdmissionQualification, policy: unknown): CaseRequestFamily {
  const entries = qualification.requests.filter(request => request.requestId === requestId);
  const sensitive = entries.find(request => request.family === "cancellation") ?? entries.find(request => (SAV_CASE_SENSITIVE_FAMILIES as readonly string[]).includes(request.family));
  if (sensitive) return sensitive.family as CaseRequestFamily;
  const proven = new Set(entries.filter(request => caseRequestFamilyProven(request, policy)).map(request => request.family as CaseRequestFamily));
  return proven.size === 1 ? [...proven][0]! : "other";
}

/** Q5: the memory cannot take what a relayed mail opens. The mail stays in the journal; an agent
 * case goes to the team by a system takeover the measure counts as a technical block; a human or
 * held case keeps its owner and is never given back to the agent while full (transitionCaseOwner).
 * Never retried. */
async function memoryFullLocked(tx: CaseTx, row: CaseRow, sourceRef: SourceRef) {
  const current = toSnapshot(row);
  if (current.owner !== "agent") return row;
  const [moved] = await tx.update(savCases).set({ ...NO_CLAIM, owner: "human", phase: "handoff_pending", updatedAt: new Date(),
    payloadCiphertext: encryptSavPayload(parseBody({ ...current.body, handoff: { reason: "body_limit_reached" } })) })
    .where(and(eq(savCases.id, row.id), eq(savCases.version, row.version))).returning();
  if (!moved) throw new CaseVersionStaleError(row.version);
  return (await appendLocked(tx, moved, validEvent({ kind: "owner_changed", dedupeKey: caseDedupeKey.memoryFull(row.version), sourceRef, detail: {
    transition: "human_takeover", from: "agent", to: "human", fromPhase: current.phase, toPhase: "handoff_pending", actor: { type: "system" }, reason: "body_limit_reached",
  } }))).row;
}

/** Writes the requests a new event opens, under the same lock and at the event's version. */
async function openRequestsLocked(tx: CaseTx, row: CaseRow, opens: CaseOpenedRequest[], admission: CaseAdmissionInput & { qualification: CaseAdmissionQualification }, event: ValidEvent) {
  const current = toSnapshot(row);
  const known = new Set(current.body.openRequests.map(request => request.id));
  const added = opens.filter(request => !known.has(request.id)).map(request => ({
    id: request.id, summary: request.summary, family: openedFamily(request.id, admission.qualification, admission.policy), status: "open" as const, openedAt: event.occurredAt,
    ...(request.subject ? { subject: request.subject } : {}),
  }));
  if (!added.length) return row;
  if (current.body.openRequests.length + added.length > SAV_CASE_OPEN_REQUESTS_MAX) return memoryFullLocked(tx, row, event.sourceRef);
  const body = parseBody({ ...current.body, openRequests: [...current.body.openRequests, ...added] });
  checkSensitiveRequests(body, current.sensitivity);
  const [next] = await tx.update(savCases).set({ payloadCiphertext: encryptSavPayload(body), updatedAt: new Date() })
    .where(and(eq(savCases.id, row.id), eq(savCases.version, row.version))).returning();
  if (!next) throw new CaseVersionStaleError(row.version);
  return next;
}

/** V1's intent hash (`intakeRuntimeHash`), restated here: the case store never imports the intake
 * runtime, which pulls the HubSpot readers. The V1 chain test proves both agree on a real effect. */
export const v1IntentHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The proof must be the V1 ledger's own row: a confirmed `owner_assign` of that execution whose
 * stored intent (hash checked) names this ticket and this owner, or (3/11) the confirmed `ticket_create`
 * of that execution that created this very ticket (its acknowledged id, and the execution's ticket) with
 * this owner in the creation's own properties. Nothing a caller says is trusted. */
async function attributionProven(tx: CaseTx, proof: CaseAttributionProof, ticketId: string) {
  if (proof.ticketId !== ticketId) return false;
  // The owner read now (4/11): the reading is the relay's, one CRM GET just before this lock. What is checked here is that V1 really confirmed this mail on this very ticket:
  // a creation that stayed uncertain, or that acknowledged another ticket, is no confirmation, whoever the owner is.
  if (proof.kind === "hubspot_owner_read") {
    const [execution] = await tx.select({ id: savIntakeExecutions.id, ticketId: savIntakeExecutions.ticketId, state: savIntakeExecutions.state }).from(savIntakeExecutions)
      .where(eq(savIntakeExecutions.messageId, proof.messageId)).for("share");
    if (execution?.state !== "confirmed" || execution.ticketId !== ticketId) return false;
    const creations = await tx.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, execution.id), eq(savIntakeEffects.kind, "ticket_create"))).for("share");
    return creations.every(create => create.state === "confirmed" && create.ackCiphertext && decryptSavPayload<{ id?: string }>(create.ackCiphertext).id === ticketId);
  }
  const kind = proof.kind === "hubspot_owner_at_creation" ? "ticket_create" : "owner_assign";
  const [effect] = await tx.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.id, proof.effectId), eq(savIntakeEffects.executionId, proof.executionId))).for("share");
  if (!effect || effect.kind !== kind || effect.state !== "confirmed") return false;
  const intent = decryptSavPayload<{ kind?: string; key?: string; ticketId?: string; properties?: { hubspot_owner_id?: string } }>(effect.intentCiphertext);
  if (v1IntentHash(intent) !== effect.intentHash || intent.kind !== kind || intent.key !== effect.businessKey || intent.properties?.hubspot_owner_id !== proof.ownerId) return false;
  if (proof.kind === "hubspot_owner_verified") return intent.ticketId === ticketId;
  if (proof.intentHash !== effect.intentHash || !effect.ackCiphertext || decryptSavPayload<{ id?: string }>(effect.ackCiphertext).id !== ticketId) return false;
  const [execution] = await tx.select({ ticketId: savIntakeExecutions.ticketId, state: savIntakeExecutions.state }).from(savIntakeExecutions)
    .where(eq(savIntakeExecutions.id, proof.executionId)).for("share");
  return execution?.state === "confirmed" && execution.ticketId === ticketId;
}

/** v9 `v2_attribution`, under the ticket lock: the case still waits, is not sensitive, has room,
 * and the admission decided again on this version targets the agent. Otherwise nothing is written
 * and the case stays with the team; never a fault, so the relayed mail is kept. */
async function attributeLocked(tx: CaseTx, row: CaseRow, proof: CaseAttributionProof, admission: CaseAdmissionInput & { qualification: CaseAdmissionQualification }, sourceRef: SourceRef) {
  const event = validEvent({ kind: "owner_changed", dedupeKey: caseDedupeKey.command(proof.kind === "hubspot_owner_read" ? `v2-attribution.owner-read.${proof.messageId}` : `v2-attribution.${proof.effectId}`), sourceRef });
  const [done] = await tx.select({ id: savCaseEvents.id }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, row.id), eq(savCaseEvents.dedupeKey, event.dedupeKey)));
  const current = toSnapshot(row);
  if (done || !caseAwaitsV2Attribution(current) || current.sensitivity !== "none" || current.body.openRequests.length >= SAV_CASE_OPEN_REQUESTS_MAX) return row;
  const decision = decideCaseAdmission({ policy: admission.policy, qualification: admission.qualification, caseSensitivity: current.sensitivity });
  if (decision.target !== "agent" || !await attributionProven(tx, proof, current.ticketId)) return row;
  const moved = await recordAdmission(tx, row, decision, admission.qualification, sourceRef, {
    owner: "agent", phase: "queued", payloadCiphertext: encryptSavPayload(parseBody({ ...current.body, handoff: null })),
  });
  return (await appendLocked(tx, moved, { ...event, detail: {
    transition: "v2_attribution", from: "human", to: "agent", fromPhase: current.phase, toPhase: "queued", actor: { type: "system" }, reason: proof.kind, proof,
  } })).row;
}

/** A request a relayed message opens: an id and a neutral summary, never the customer's text, and
 * (v10) its searchable subject from V1's accepted analysis or the reason it has none. */
export type CaseOpenedRequest = { id: string; summary: string; subject?: CaseRequestSubject };
export type OpenCaseEventInput = EventInput & {
  ticketId: string; threadId: string;
  /** Requests this event opens (v8), recorded once with the event; a replay opens nothing. */
  opens?: CaseOpenedRequest[];
  /** Qualification of this input plus the current policy (null: nobody is admitted). */
  admission: CaseAdmissionInput;
  /** On an existing case: `full` (default) records the re-evaluation whatever it says;
   * `exclusions_only` (the V1 relay, which only has intake hints) records it only when it
   * sends the case to the team. Otherwise the event leaves the admission stale, so nobody
   * acts on it until someone re-evaluates with a real qualification. A new case always
   * gets the full decision. */
  admissionMode?: "full" | "exclusions_only";
  /** Runs under the ticket lock, before any write: re-check the source is still valid. */
  assertFresh?: (tx: CaseTx) => Promise<void>;
  /** v9, the V1 relay: a case admitted for the agent is created for the team, waiting for its V2
   * owner (`pending`), and goes to the agent only on V1's verified owner effect, re-checked here.
   * Absent: v8 creation (tests only; the relay is the one creator in production). */
  attribution?: "pending" | CaseAttributionProof;
};
/** Get-or-create the ticket's case, append one event and re-evaluate the admission in the
 * same transaction. A new case belongs to the agent only when admitted; otherwise it waits
 * for the team. Replaying the event changes nothing. */
export async function openCaseEvent(input: OpenCaseEventInput) {
  const db = requireDb();
  await assertWritable(db);
  if (!CRM_ID.test(input.ticketId)) fault("TICKET_INVALID");
  if (!UUID.test(input.threadId)) fault("THREAD_INVALID");
  const qualification = parseQualification(input.admission.qualification);
  const event = validEvent(input);
  const proof = input.attribution && input.attribution !== "pending" ? caseAttributionProofSchema.safeParse(input.attribution).data ?? fault("ATTRIBUTION_PROOF_INVALID") : undefined;
  return db.transaction(async tx => {
    await lockTicket(tx, input.ticketId);
    await input.assertFresh?.(tx);
    let [row] = await tx.select().from(savCases).where(eq(savCases.ticketId, input.ticketId)).for("update");
    if (row) row = await upgradeLocked(tx, row);
    const created = !row;
    if (!row) {
      // Sensitivity starts at none and is raised by the admission recorded just below.
      const decision = decideCaseAdmission({ policy: input.admission.policy, qualification, caseSensitivity: "none" });
      const waits = decision.target === "agent" && input.attribution !== undefined;
      const owner: CaseOwner = decision.target === "agent" && !waits ? "agent" : "human";
      const body = owner === "agent" ? emptyCaseBody() : { ...emptyCaseBody(), handoff: { reason: waits ? SAV_CASE_AWAITING_V2_ATTRIBUTION : decision.reasons[0]! } };
      [row] = await tx.insert(savCases).values({
        ticketId: input.ticketId, threadIds: [input.threadId], owner, phase: owner === "agent" ? "queued" : "handoff_pending",
        contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(body), admissionTarget: decision.target,
      }).returning();
    }
    const appended = await appendLocked(tx, row!, event, input.threadId);
    let reevaluate = appended.appended;
    if (reevaluate && !created && input.admissionMode === "exclusions_only") {
      const decision = decideCaseAdmission({ policy: input.admission.policy, qualification, caseSensitivity: toSnapshot(appended.row).sensitivity });
      reevaluate = SAV_CASE_ADMISSION_TEAM_REASONS.includes(decision.reasons[0]!);
    }
    row = reevaluate ? await applyAdmission(tx, appended.row, { ...input.admission, qualification }, event.sourceRef) : appended.row;
    if (appended.appended && input.opens?.length) row = await openRequestsLocked(tx, row, input.opens, { ...input.admission, qualification }, event);
    if (input.attribution && input.attribution !== "pending") row = await attributeLocked(tx, row, proof!, { ...input.admission, qualification }, event.sourceRef);
    return { case: toSnapshot(row), created, appended: appended.appended };
  });
}

/** After a policy change or a non-inbound input (CRM, command, human reply): re-evaluate
 * on the version the caller read. */
export async function reevaluateCaseAdmission(input: { caseId: string; expectedVersion: number; admission: CaseAdmissionInput; sourceRef: SourceRef }) {
  const db = requireDb();
  await assertWritable(db);
  const qualification = parseQualification(input.admission.qualification);
  const sourceRef = sourceRefSchema.safeParse(input.sourceRef);
  if (!sourceRef.success) fault("SOURCE_REF_INVALID");
  return db.transaction(async tx => {
    const row = await lockedCase(tx, input.caseId);
    if (row.version !== input.expectedVersion) throw new CaseVersionStaleError(row.version);
    return toSnapshot(await applyAdmission(tx, row, { ...input.admission, qualification }, sourceRef.data!));
  });
}

export type CasePolicyRevalidation =
  | { revalidated: true; case: CaseSnapshot }
  | { revalidated: false; reason: "owner_not_agent" | "no_admission" | "not_admitted" | "input_newer"; case: CaseSnapshot };
/** A new revision of the approved policy (B): an agent case is decided again with the
 * qualification its admission recorded, never a new one, so the revision can keep or withdraw
 * what was proven, never prove more. Past a newer input the caller re-evaluates instead. */
export async function revalidateCaseAdmissionForPolicy(input: { caseId: string; expectedVersion: number; policy: unknown }): Promise<CasePolicyRevalidation> {
  const db = requireDb();
  await assertWritable(db);
  const revision = z.object({ revision: z.string().trim().min(1).max(200) }).safeParse(input.policy);
  const sourceRef: SourceRef = { type: "studio_command", id: "admission-policy", ...(revision.success ? { revision: revision.data.revision } : {}) };
  return db.transaction(async tx => {
    const row = await lockedCase(tx, input.caseId);
    if (row.version !== input.expectedVersion) throw new CaseVersionStaleError(row.version);
    const current = toSnapshot(row);
    const refused = current.owner !== "agent" ? "owner_not_agent" as const : !current.admission ? "no_admission" as const
      : current.admission.target !== "agent" ? "not_admitted" as const : current.admissionInputVersion > current.admission.inputVersion ? "input_newer" as const : null;
    if (refused) return { revalidated: false, reason: refused, case: current };
    return { revalidated: true, case: toSnapshot(await applyAdmission(tx, row, { policy: input.policy, qualification: current.admission!.qualification }, sourceRef)) };
  });
}

/** Pages of agent cases admitted under another policy revision than `currentPolicyRevision`, for
 * B's policy sweep: ids only, by id after `after`, at most `limit` (1 to 500). A case listed may
 * have moved by the time it is revalidated; revalidateCaseAdmissionForPolicy checks again. */
export async function listCaseIdsForPolicyRevalidation(input: { currentPolicyRevision: string; after: string | null; limit: number }): Promise<string[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) fault("PAGE_INVALID");
  if (input.after !== null && !UUID.test(input.after)) fault("PAGE_INVALID");
  if (!/^.{1,200}$/.test(input.currentPolicyRevision)) fault("PAGE_INVALID");
  const rows = await requireDb().select({ id: savCases.id }).from(savCases)
    .where(and(eq(savCases.owner, "agent"), eq(savCases.admissionTarget, "agent"), sql`${savCases.admissionPolicyRevision} is distinct from ${input.currentPolicyRevision}`,
      ...(input.after ? [gt(savCases.id, input.after)] : [])))
    .orderBy(asc(savCases.id)).limit(input.limit);
  return rows.map(row => row.id);
}

export async function appendCaseEvent(input: EventInput & { caseId: string; threadId?: string }, tx?: CaseTx) {
  await assertWritable(tx ?? requireDb());
  if (input.threadId !== undefined && !UUID.test(input.threadId)) fault("THREAD_INVALID");
  const event = validEvent(input);
  return withCaseTx(tx, async tx => {
    const result = await appendLocked(tx, await lockedCase(tx, input.caseId), event, input.threadId);
    return { appended: result.appended, version: result.row.version };
  });
}

/** Lot 3, for C's single transaction: the ticket's advisory lock, then the case row FOR UPDATE, in the
 * caller's transaction, as every A writer takes them (ticket → case; no A writer locks an execution
 * after). An older row may be rewritten to the current contract there (format only, version kept).
 * With `expectedVersion`, a moved case throws CaseVersionStaleError: the caller lets it roll its whole
 * transaction back, rewrite included, and never commits on a stale read. */
export async function lockCaseForWrite(tx: CaseTx, caseId: string, options: { expectedVersion?: number } = {}): Promise<CaseSnapshot> {
  await assertWritable(tx);
  const row = await lockedCase(tx, caseId);
  if (options.expectedVersion !== undefined && row.version !== options.expectedVersion) throw new CaseVersionStaleError(row.version);
  return toSnapshot(row);
}

/** A finance or cancellation request is never recorded on a case that is not already that sensitive. */
function checkSensitiveRequests(body: CaseBody, sensitivity: CaseSensitivity) {
  for (const request of body.openRequests) {
    const needed = caseSensitivityForFamily(request.family);
    if (needed && sensitivity !== needed && !(needed === "finance" && sensitivity === "cancellation")) fault("SENSITIVE_FAMILY_UNRECORDED");
  }
}
const OBSERVABLE: ReadonlySet<keyof CaseBody> = new Set(["facts", "hypotheses"]);
function nextRecord(current: CaseSnapshot, actor: CaseActor, inputBody?: CaseBody, inputPhase?: CasePhase) {
  const body = inputBody ? parseBody(inputBody) : current.body;
  // Facts are append-only for every actor: a correction is a new fact that replaces the old one.
  const facts = new Map(body.facts.map(fact => [fact.id, JSON.stringify(fact)]));
  if (current.body.facts.some(fact => facts.get(fact.id) !== JSON.stringify(fact))) fault("FACT_IMMUTABLE");
  // The requests a mail opened stay as recorded for the agent (night review 29/10): it may move
  // their status, never drop, rename or re-family one. A person may still edit them.
  if (actor.type === "agent") {
    const kept = new Map(body.openRequests.map(request => [request.id, JSON.stringify({ ...request, status: null })]));
    if (current.body.openRequests.some(request => kept.get(request.id) !== JSON.stringify({ ...request, status: null }))) fault("REQUEST_IMMUTABLE");
  }
  const phase = inputPhase === undefined ? current.phase : member(SAV_CASE_PHASES, inputPhase);
  if (!caseOwnerAllowsPhase(current.owner, phase)) fault("PHASE_OWNER_MISMATCH");
  checkSensitiveRequests(body, current.sensitivity);
  if (actor.type === "agent" && current.owner !== "agent") {
    const changed = (Object.keys(body) as (keyof CaseBody)[]).filter(key => JSON.stringify(body[key]) !== JSON.stringify(current.body[key]));
    if (phase !== current.phase || changed.some(key => !OBSERVABLE.has(key))) fault("OBSERVE_ONLY");
  }
  return { body, phase };
}
/** New facts only (Q6, Q8). An attachment must belong to one of the case's customer mails, and
 * an observed fact may not cite a customer mail or its attachment: what the customer says or
 * shows can change the current state, never become a technical finding or a proof of rights. */
async function checkNewFactSources(tx: CaseTx, caseId: string, before: CaseBody, after: CaseBody) {
  const known = new Set(before.facts.map(fact => fact.id));
  const added = after.facts.filter(fact => !known.has(fact.id) && (fact.source.type === "attachment" || (fact.kind === "observed" && fact.source.type === "email")));
  if (!added.length) return;
  const inbound = new Set((await tx.select({ key: savCaseEvents.dedupeKey }).from(savCaseEvents)
    .where(and(eq(savCaseEvents.caseId, caseId), eq(savCaseEvents.kind, "inbound_confirmed")))).map(row => row.key));
  for (const fact of added) {
    const gmailId = fact.source.type === "attachment" ? SAV_CASE_ATTACHMENT_REF.exec(fact.source.id)![1]! : fact.source.id;
    const fromCustomer = inbound.has(caseDedupeKey.inbound(gmailId));
    if (fact.source.type === "attachment" && !fromCustomer) fault("ATTACHMENT_SOURCE_UNKNOWN");
    if (fact.kind === "observed" && fromCustomer) fault("FACT_OBSERVED_FROM_CUSTOMER");
  }
}
/** CAS write of the body and/or phase. Owner never changes here (see transitionCaseOwner).
 * While the agent does not own the case it may only record observations. */
export async function updateCaseRecord(input: { caseId: string; expectedVersion: number; actor: CaseActor; body?: CaseBody; phase?: CasePhase }, tx?: CaseTx) {
  await assertWritable(tx ?? requireDb());
  return withCaseTx(tx, async tx => {
    const row = await lockedCase(tx, input.caseId);
    if (row.version !== input.expectedVersion) throw new CaseVersionStaleError(row.version);
    const current = toSnapshot(row);
    const { body, phase } = nextRecord(current, input.actor, input.body, input.phase);
    await checkNewFactSources(tx, row.id, current.body, body);
    const [next] = await tx.update(savCases).set({ version: row.version + 1, phase, payloadCiphertext: encryptSavPayload(body), updatedAt: new Date() })
      .where(and(eq(savCases.id, row.id), eq(savCases.version, row.version))).returning();
    if (!next) throw new CaseVersionStaleError(row.version);
    return toSnapshot(next);
  });
}

function transitionTarget(transition: CaseOwnerTransition, current: CaseSnapshot, to?: "agent" | "human"): { owner: CaseOwner; phase: CasePhase } {
  if (transition === "handoff") return { owner: "human", phase: "handoff_pending" };
  if (transition === "human_takeover") return { owner: "human", phase: "human_owned" };
  if (transition === "hand_back") return { owner: "agent", phase: "queued" };
  if (transition === "admin_hold" || transition === "technical_hold" || transition === "organisational_hold") return { owner: "system_hold", phase: current.phase };
  if (to === "agent") return { owner: "agent", phase: "queued" };
  if (to === "human") return { owner: "human", phase: "human_owned" };
  return fault("TRANSITION_TARGET_REQUIRED");
}

/** Q9 (C's finding of 28/10): released to the agent, a case held while waiting for the customer
 * goes back to that wait when the J2 it waits on is still scheduled or already fired. Only a
 * technical or organisational hold keeps a J2 (the retired admin_hold, a customer reply and a
 * personal takeover cancel it), so the case otherwise restarts from `queued`; nothing is revived. */
async function waitKeptThroughHold(tx: CaseTx, current: CaseSnapshot) {
  const timerId = current.body.waiting?.kind === "customer" ? current.body.waiting.timerId : undefined;
  if (current.phase !== "awaiting_customer" || !timerId || !UUID.test(timerId)) return false;
  const [timer] = await tx.select({ state: savCaseTimers.state }).from(savCaseTimers).where(and(eq(savCaseTimers.id, timerId), eq(savCaseTimers.caseId, current.caseId)));
  return timer?.state === "scheduled" || timer?.state === "fired";
}

/** The only way an owner changes. A replayed commandKey is a no-op, even after the
 * version moved on; otherwise expectedVersion must still be current. */
export async function transitionCaseOwner(input: {
  caseId: string; expectedVersion: number; transition: CaseOwnerTransition; actor: CaseActor; commandKey: string; reason: string;
  to?: "agent" | "human"; sourceRef?: SourceRef;
  /** Required to give the case to the agent: re-evaluated under the same lock and CAS. */
  admission?: CaseAdmissionInput;
}, tx?: CaseTx) {
  await assertWritable(tx ?? requireDb());
  const rule = SAV_CASE_OWNER_TRANSITIONS[input.transition] ?? fault("TRANSITION_FORBIDDEN");
  if (SAV_CASE_RETIRED_TRANSITIONS.includes(input.transition)) fault("TRANSITION_RETIRED");
  // v9: only the relay attributes, on V1's verified owner effect (openCaseEvent), never a command.
  if (input.transition === "v2_attribution") fault("TRANSITION_FORBIDDEN");
  if (!CODE.test(input.reason)) fault("REASON_INVALID");
  if (input.actor.type === "human" && !UUID.test(input.actor.staffUserId)) fault("ACTOR_INVALID");
  const event = validEvent({ kind: "owner_changed", dedupeKey: caseDedupeKey.command(input.commandKey), sourceRef: input.sourceRef ?? { type: "studio_command", id: input.commandKey } });
  return withCaseTx(tx, async tx => {
    const row = await lockedCase(tx, input.caseId);
    const [replayed] = await tx.select({ id: savCaseEvents.id }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, row.id), eq(savCaseEvents.dedupeKey, event.dedupeKey)));
    if (replayed) return { replayed: true, case: toSnapshot(row) };
    if (row.version !== input.expectedVersion) throw new CaseVersionStaleError(row.version);
    const current = toSnapshot(row);
    if (!(rule.from as readonly CaseOwner[]).includes(current.owner) || !(rule.actors as readonly CaseActor["type"][]).includes(input.actor.type)) fault("TRANSITION_FORBIDDEN");
    let target = transitionTarget(input.transition, current, input.to);
    if (input.transition === "hold_release" && target.owner === "agent" && await waitKeptThroughHold(tx, current)) target = { owner: "agent", phase: current.phase };
    const body = { ...current.body };
    if (input.transition === "handoff") body.handoff = { reason: input.reason };
    if (input.transition === "human_takeover") body.handoff = { ...(body.handoff ?? { reason: input.reason }), humanSince: new Date().toISOString() };
    if (target.owner === "agent") body.handoff = null;
    const moves: CaseUpdate = { owner: target.owner, phase: target.phase, payloadCiphertext: encryptSavPayload(parseBody(body)), updatedAt: new Date(), ...(target.owner === "agent" ? {} : NO_CLAIM) };
    let moved: CaseRow;
    if (target.owner === "agent") {
      // No override: sensitivity first, then a fresh admission on this very version.
      if (current.sensitivity !== "none") fault("SENSITIVE_HUMAN_ONLY");
      // Q5 at the way back: a full memory may already have left a relayed mail's requests out
      // (a held or human case keeps its owner), so the case stays with the team.
      if (current.body.openRequests.length >= SAV_CASE_OPEN_REQUESTS_MAX) fault("BODY_LIMIT_REACHED");
      if (!input.admission) return fault("ADMISSION_REQUIRED");
      const qualification = parseQualification(input.admission.qualification);
      const decision = decideCaseAdmission({ policy: input.admission.policy, qualification, caseSensitivity: current.sensitivity });
      if (decision.target !== "agent") fault("ADMISSION_REFUSED");
      moved = await recordAdmission(tx, row, decision, qualification, event.sourceRef, moves);
    } else {
      [moved] = await tx.update(savCases).set(moves).where(and(eq(savCases.id, row.id), eq(savCases.version, row.version))).returning() as [CaseRow];
    }
    const result = await appendLocked(tx, moved, { ...event, detail: {
      transition: input.transition, from: current.owner, to: target.owner, fromPhase: current.phase, toPhase: target.phase, actor: input.actor, reason: input.reason,
    } });
    return { replayed: false, case: toSnapshot(result.row) };
  });
}

export type ClaimCaseResult =
  | { claimed: true; claim: CaseClaim; case: CaseSnapshot; /** Intake or V2 agent pause at `actions_paused`: observe, no external effect. */ actionsPaused: boolean }
  | { claimed: false; reason: CaseClaimRefusal; case: CaseSnapshot; /** Set for `inbound_settling`. */ retryAt?: string };
/** Before any model call: the case must belong to the agent with a positive admission that
 * is fresh for this exact version and the current policy, neither the intake nor the V2 agent may be fully
 * paused, and nobody else may hold a live claim. Taking it changes no version. */
export async function claimCaseForDecision(input: {
  caseId: string; expectedVersion: number; holder: string; currentPolicyRevision: string | null; ttlSeconds: number; now?: Date;
  /** Quiet period after the last customer message was recorded, so a burst of mails is
   * analysed once. Defaults to SAV_CASE_INBOUND_SETTLE_SECONDS; 0 waits for nothing. */
  settleSeconds?: number;
}): Promise<ClaimCaseResult> {
  const db = requireDb();
  await assertWritable(db);
  if (!CODE.test(input.holder)) fault("HOLDER_INVALID");
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 30 || input.ttlSeconds > 900) fault("CLAIM_TTL_INVALID");
  const settleSeconds = input.settleSeconds ?? SAV_CASE_INBOUND_SETTLE_SECONDS;
  if (!Number.isInteger(settleSeconds) || settleSeconds < 0 || settleSeconds > 3600) fault("CLAIM_SETTLE_INVALID");
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    const row = await lockedCase(tx, input.caseId);
    if (row.version !== input.expectedVersion) throw new CaseVersionStaleError(row.version);
    const current = toSnapshot(row);
    const admission = caseAdmissionStatus(current, input.currentPolicyRevision);
    if (!admission.admitted) return { claimed: false, reason: admission.reason, case: current };
    // Pilot access (3/11): the console pauses the intake agent, which no V2 row mirrors. The stricter of the two
    // pauses applies, so pausing SAV from the console also stops V2 claims (and their model calls).
    const pauses = [await readSavAgentPause(tx, "intake"), await readSavAgentPause(tx, "v2")];
    if (pauses.some(pause => pause.invalid || pause.level === "fully_paused")) return { claimed: false, reason: "agent_paused", case: current };
    if (settleSeconds) {
      // Recording time, not the mail's date: a mail relayed late after a crash still counts as new.
      const [last] = await tx.select({ at: max(savCaseEvents.createdAt) }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, row.id), eq(savCaseEvents.kind, "inbound_confirmed")));
      const retryAt = last?.at ? new Date(new Date(last.at).getTime() + settleSeconds * 1000) : null;
      if (retryAt && retryAt > now) return { claimed: false, reason: "inbound_settling", case: current, retryAt: retryAt.toISOString() };
    }
    if (row.claimToken && row.claimUntil && row.claimUntil > now) return { claimed: false, reason: "claimed_elsewhere", case: current };
    const claim: CaseClaim = { caseId: row.id, token: randomUUID(), version: row.version, holder: input.holder, until: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString() };
    const [next] = await tx.update(savCases).set({ claimToken: claim.token, claimVersion: claim.version, claimHolder: claim.holder, claimUntil: new Date(claim.until) })
      .where(and(eq(savCases.id, row.id), eq(savCases.version, row.version))).returning();
    if (!next) throw new CaseVersionStaleError(row.version);
    return { claimed: true, claim, case: toSnapshot(next), actionsPaused: pauses.some(pause => pause.level === "actions_paused") };
  });
}

/** Gives a claim back without writing anything else. */
export async function releaseCaseClaim(input: { caseId: string; claimToken: string }) {
  const db = requireDb();
  await assertWritable(db);
  return db.transaction(async tx => {
    const row = await lockedCase(tx, input.caseId);
    if (row.claimToken !== input.claimToken) return false;
    await tx.update(savCases).set(NO_CLAIM).where(eq(savCases.id, row.id));
    return true;
  });
}

const OBSERVATION_MAX_BYTES = 64 * 1024;
export type CaseObservationResult = { replayed: boolean; applied: boolean; reason: "version_moved" | "admission_lost" | null; case: CaseSnapshot };
/** The claim holder's result. Always kept as an `observation_recorded` event (its readings
 * stay reusable); applied to the body and phase only if the case has not moved since the
 * claim and is still admitted. A new inbound during analysis therefore keeps both the
 * message and the work, and applies neither stale decision. The claim ends here. */
export async function recordCaseObservation(input: { caseId: string; claimToken: string; currentPolicyRevision: string | null; observation: CaseObservation; requireLiveClaimAt?: () => Date }, tx?: CaseTx): Promise<CaseObservationResult> {
  await assertWritable(tx ?? requireDb());
  const parsed = caseObservationSchema.safeParse(input.observation);
  if (!parsed.success) fault("OBSERVATION_INVALID");
  const observation = parsed.data!;
  if (Buffer.byteLength(JSON.stringify(observation.record)) > OBSERVATION_MAX_BYTES) fault("OBSERVATION_TOO_LARGE");
  if (!UUID.test(input.claimToken)) fault("CLAIM_LOST");
  const event = validEvent({ kind: "observation_recorded", dedupeKey: caseDedupeKey.observation(input.claimToken), sourceRef: { type: "studio_command", id: input.claimToken } });
  return withCaseTx(tx, async tx => {
    const row = await lockedCase(tx, input.caseId);
    const [replayed] = await tx.select({ payload: savCaseEvents.payloadCiphertext }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, row.id), eq(savCaseEvents.dedupeKey, event.dedupeKey)));
    if (replayed) {
      const detail = decryptSavPayload<{ detail: { applied: boolean; reason: CaseObservationResult["reason"] } }>(replayed.payload).detail;
      return { replayed: true, applied: detail.applied, reason: detail.reason, case: toSnapshot(row) };
    }
    if (row.claimToken !== input.claimToken || row.claimVersion === null) return fault("CLAIM_LOST");
    if (input.requireLiveClaimAt && (!row.claimUntil || row.claimUntil <= input.requireLiveClaimAt())) return fault("CLAIM_LOST");
    const current = toSnapshot(row);
    const reason = row.version !== row.claimVersion ? "version_moved" as const : !caseAdmissionStatus(current, input.currentPolicyRevision).admitted ? "admission_lost" as const : null;
    const next = reason ? null : nextRecord(current, { type: "agent" }, observation.body, observation.phase);
    if (next) await checkNewFactSources(tx, row.id, current.body, next.body);
    const appended = await appendLocked(tx, row, { ...event, detail: { applied: !reason, reason, claimVersion: row.claimVersion, holder: row.claimHolder, record: observation.record } });
    const [done] = await tx.update(savCases).set({ ...NO_CLAIM, ...(next ? { phase: next.phase, payloadCiphertext: encryptSavPayload(next.body) } : {}) })
      .where(and(eq(savCases.id, row.id), eq(savCases.version, appended.row.version))).returning();
    if (!done) throw new CaseVersionStaleError(appended.row.version);
    return { replayed: false, applied: !reason, reason, case: toSnapshot(done) };
  });
}

const optionalMember = <T extends string>(values: readonly T[], value: string | null) => value === null ? null : member(values, value);
function toTimer(row: TimerRow): CaseTimer {
  return { id: row.id, key: row.key, caseId: row.caseId, questionEffectId: row.questionEffectId, sentAt: row.sentAt.toISOString(), dueAt: row.dueAt.toISOString(),
    state: member(SAV_CASE_TIMER_STATES, row.state), scheduledAtCaseVersion: row.scheduledAtCaseVersion, firedAt: row.firedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null, cancelReason: optionalMember(SAV_CASE_TIMER_CANCEL_REASONS, row.cancelReason) };
}
export type ScheduleTimerRefusal = "owner_not_agent" | "no_admission" | "not_admitted" | "input_newer" | "policy_missing" | "policy_changed" | "question_unknown" | "inbound_after_question";
/** J2 for one question the agent really sent (SAV-8 computes `dueAt`, never recomputed
 * here). The timer, the case's `waiting.timerId` and the phase are written together, and a
 * customer message received since the question means no timer. An existing key is returned
 * as it is: a cancelled timer is never revived. A newer question cancels the older timers. */
export async function scheduleCaseTimer(input: {
  caseId: string; expectedVersion: number; currentPolicyRevision: string | null; reasonCode: string;
  timer: { id: string; questionEffectId: string; sentAt: string; dueAt: string };
  /** The case version the question was prepared on. A customer message recorded after it has crossed the question even when Gmail dated it before the mail left. */
  answeredVersion?: number;
}, tx?: CaseTx): Promise<{ scheduled: true; timer: CaseTimer; case: CaseSnapshot } | { scheduled: false; existing: CaseTimer | null; reason: ScheduleTimerRefusal | "already_exists" }> {
  await assertWritable(tx ?? requireDb());
  const { timer } = input;
  if (!UUID.test(timer.id)) fault("TIMER_INVALID");
  if (!/^.{1,200}$/.test(timer.questionEffectId) || !CODE.test(input.reasonCode)) fault("TIMER_INVALID");
  if (!occurredAtSchema.safeParse(timer.sentAt).success || !occurredAtSchema.safeParse(timer.dueAt).success || Date.parse(timer.dueAt) <= Date.parse(timer.sentAt)) fault("TIMER_INVALID");
  return withCaseTx(tx, async tx => {
    const row = await lockedCase(tx, input.caseId);
    const key = caseTimerKey(row.id, timer.questionEffectId);
    const [existing] = await tx.select().from(savCaseTimers).where(eq(savCaseTimers.key, key));
    if (existing) return { scheduled: false, existing: toTimer(existing), reason: "already_exists" };
    if (row.version !== input.expectedVersion) throw new CaseVersionStaleError(row.version);
    const current = toSnapshot(row);
    const admission = caseAdmissionStatus(current, input.currentPolicyRevision);
    if (!admission.admitted) return { scheduled: false, existing: null, reason: admission.reason };
    if (!current.body.questions.some(question => question.askedInEffect === timer.questionEffectId)) return { scheduled: false, existing: null, reason: "question_unknown" };
    const [crossing] = await tx.select({ id: savCaseEvents.id }).from(savCaseEvents)
      .where(and(eq(savCaseEvents.caseId, row.id), eq(savCaseEvents.kind, "inbound_confirmed"),
        or(gte(savCaseEvents.occurredAt, new Date(timer.sentAt)), input.answeredVersion === undefined ? undefined : gt(savCaseEvents.caseVersion, input.answeredVersion)))).limit(1);
    if (crossing) return { scheduled: false, existing: null, reason: "inbound_after_question" };
    await cancelScheduledTimers(tx, row.id, "new_question");
    const version = row.version + 1;
    const [inserted] = await tx.insert(savCaseTimers).values({ id: timer.id, key, caseId: row.id, questionEffectId: timer.questionEffectId, sentAt: new Date(timer.sentAt), dueAt: new Date(timer.dueAt), scheduledAtCaseVersion: version }).returning();
    const body = parseBody({ ...current.body, waiting: { kind: "customer", since: timer.sentAt, dueAt: timer.dueAt, reasonCode: input.reasonCode, timerId: timer.id } });
    const [next] = await tx.update(savCases).set({ version, phase: "awaiting_customer", payloadCiphertext: encryptSavPayload(body), updatedAt: new Date() })
      .where(and(eq(savCases.id, row.id), eq(savCases.version, row.version))).returning();
    if (!next) throw new CaseVersionStaleError(row.version);
    return { scheduled: true, timer: toTimer(inserted!), case: toSnapshot(next) };
  });
}

/** Marks a due timer fired and appends `timer_fired` in one transaction under the case lock;
 * a timer already cancelled by a crossing signal fires nothing, and a held case fires nothing
 * until it is released (Q9: the J2 waits; SAV-8 fires it again in a Paris working slot). Firing
 * is an event, never a permission to send: the pause, the admission and the decision are
 * checked by whoever acts. */
export async function fireCaseTimer(input: { timerId: string; now?: Date }) {
  const db = requireDb();
  await assertWritable(db);
  if (!UUID.test(input.timerId)) fault("TIMER_INVALID");
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    const [head] = await tx.select({ caseId: savCaseTimers.caseId }).from(savCaseTimers).where(eq(savCaseTimers.id, input.timerId));
    if (!head) return fault("TIMER_NOT_FOUND");
    const row = await lockedCase(tx, head.caseId);
    const [timer] = await tx.select().from(savCaseTimers).where(eq(savCaseTimers.id, input.timerId)).for("update");
    if (timer!.state !== "scheduled" || timer!.dueAt > now) return { fired: false, timer: toTimer(timer!), version: row.version };
    if (row.owner === "system_hold") return { fired: false, reason: "case_on_hold" as const, timer: toTimer(timer!), version: row.version };
    const [fired] = await tx.update(savCaseTimers).set({ state: "fired", firedAt: now }).where(and(eq(savCaseTimers.id, timer!.id), eq(savCaseTimers.state, "scheduled"))).returning();
    const appended = await appendLocked(tx, row, validEvent({ kind: "timer_fired", dedupeKey: caseDedupeKey.timer(timer!.id), sourceRef: { type: "timer", id: timer!.id },
      occurredAt: now.toISOString(), detail: { questionEffectId: timer!.questionEffectId, dueAt: timer!.dueAt.toISOString() } }));
    return { fired: true, timer: toTimer(fired!), version: appended.row.version };
  });
}

/** Due J2 timers for SAV-8's pass: scheduled, due at `now`, oldest due first then by id, at most
 * `limit` (1 to 500), served by the partial index on scheduled due dates. A held case's timers
 * are left out so they never fill the page ahead of the others (Q9); released, they are due
 * again with their date. Reading changes nothing: fireCaseTimer fires each timer once. */
export async function listDueCaseTimers(input: { now: Date; limit: number }): Promise<CaseTimer[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) fault("PAGE_INVALID");
  const rows = await requireDb().select({ timer: savCaseTimers }).from(savCaseTimers).innerJoin(savCases, eq(savCases.id, savCaseTimers.caseId))
    .where(and(eq(savCaseTimers.state, "scheduled"), lte(savCaseTimers.dueAt, input.now), ne(savCases.owner, "system_hold")))
    .orderBy(asc(savCaseTimers.dueAt), asc(savCaseTimers.id)).limit(input.limit);
  return rows.map(row => toTimer(row.timer));
}

export async function listCaseTimers(caseId: string): Promise<CaseTimer[]> {
  if (!UUID.test(caseId)) return [];
  return (await requireDb().select().from(savCaseTimers).where(eq(savCaseTimers.caseId, caseId)).orderBy(asc(savCaseTimers.createdAt), asc(savCaseTimers.id))).map(toTimer);
}

/** With `tx` (lot 3) the read is part of the caller's transaction and sees its own writes; it takes no lock. */
export async function readCase(caseId: string, tx?: CaseTx) {
  if (!UUID.test(caseId)) return null;
  const [row] = await (tx ?? requireDb()).select().from(savCases).where(eq(savCases.id, caseId));
  return row ? toSnapshot(row) : null;
}
export async function readCaseByTicket(ticketId: string) {
  if (!CRM_ID.test(ticketId)) return null;
  const [row] = await requireDb().select().from(savCases).where(eq(savCases.ticketId, ticketId));
  return row ? toSnapshot(row) : null;
}
/** Without options the whole journal (short cases); a long case is read by pages of at most
 * 500 events after a known version, so no reader has to decrypt everything each time. */
export async function listCaseEvents(caseId: string, page?: { afterVersion?: number; limit?: number }): Promise<CaseEvent[]> {
  if (!UUID.test(caseId)) return [];
  const limit = page?.limit ?? (page ? 500 : undefined);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) fault("PAGE_INVALID");
  const afterVersion = page?.afterVersion ?? 0;
  if (!Number.isInteger(afterVersion) || afterVersion < 0) fault("PAGE_INVALID");
  const query = requireDb().select().from(savCaseEvents).where(and(eq(savCaseEvents.caseId, caseId), gt(savCaseEvents.caseVersion, afterVersion))).orderBy(asc(savCaseEvents.caseVersion));
  const rows = limit === undefined ? await query : await query.limit(limit);
  return rows.map(row => {
    const payload = decryptSavPayload<{ sourceRef: SourceRef; detail: Record<string, unknown> | null }>(row.payloadCiphertext);
    return { id: row.id, caseId: row.caseId, kind: member(Object.keys(SAV_CASE_DEDUPE_PATTERNS) as CaseEventKind[], row.kind), dedupeKey: row.dedupeKey,
      caseVersion: row.caseVersion, direction: member(SAV_CASE_EVENT_DIRECTIONS, row.direction), occurredAt: row.occurredAt.toISOString(),
      sourceRef: payload.sourceRef, detail: payload.detail, createdAt: row.createdAt.toISOString() };
  });
}

/** Read-only diagnostics field: no customer content, nothing decrypted. */
export async function readCaseDiagnostics(ticketId: string) {
  if (!CRM_ID.test(ticketId)) return null;
  const db = requireDb();
  const [row] = await db.select().from(savCases).where(eq(savCases.ticketId, ticketId));
  if (!row) return null;
  const [events] = await db.select({ total: count() }).from(savCaseEvents).where(eq(savCaseEvents.caseId, row.id));
  const [last] = await db.select({ kind: savCaseEvents.kind }).from(savCaseEvents).where(eq(savCaseEvents.caseId, row.id)).orderBy(desc(savCaseEvents.caseVersion)).limit(1);
  const [timer] = await db.select().from(savCaseTimers).where(eq(savCaseTimers.caseId, row.id)).orderBy(desc(savCaseTimers.createdAt), desc(savCaseTimers.id)).limit(1);
  const pause = timer?.state === "scheduled" ? await readSavAgentPause(db, "v2") : null;
  const hold = await readCaseBlockHold(row.id, db);
  return { caseId: row.id, version: row.version, owner: row.owner, phase: row.phase, sensitivity: row.sensitivity, threadCount: row.threadIds.length,
    // Visible instead of a silent failure: a row no declared upgrade can read.
    contractRevision: row.contractRevision, contractSupported: row.contractRevision === SAV_CASE_CONTRACT_REVISION || row.contractRevision in SAV_CASE_CONTRACT_UPGRADES,
    eventCount: events?.total ?? 0, lastEventKind: last?.kind ?? null, updatedAt: row.updatedAt.toISOString(),
    // SAV-18: held by its block's switch (off, paused, unreadable): a visible wait, never a silent skip.
    blockHold: hold ? { blockId: hold.blockId, reason: hold.reason, since: hold.since } : null,
    admission: row.admissionTarget === null ? null : {
      target: row.admissionTarget, reason: row.admissionReason, policyRevision: row.admissionPolicyRevision,
      since: row.admissionDecidedAt?.toISOString() ?? null, inputNewer: row.admissionVersion === null || row.admissionInputVersion > row.admissionVersion,
    },
    claim: row.claimToken === null ? null : { holder: row.claimHolder, version: row.claimVersion, until: row.claimUntil?.toISOString() ?? null },
    // "Suspended" is a scheduled timer while the V2 agent is paused: kept, not cancelled.
    followUp: timer ? { state: timer.state, dueAt: timer.dueAt.toISOString(), cancelReason: timer.cancelReason,
      suspendedByPause: Boolean(pause && (pause.invalid || pause.level !== "running")), suspendedByHold: timer.state === "scheduled" && row.owner === "system_hold" } : null,
  };
}

/** Lot A6 (OBS1 phase 1): who reads a qualification diagnostic. The store sees no session: the caller (a route) must
 * have authenticated and authorised the staff user before calling, and states it here; nothing is read otherwise. */
export type CaseDiagnosticCaller = { kind: "staff_session_verified"; staffUserId: string };

/**
 * Lot A6 (OBS1 phase 1), read only: whether the case's admission is current, and if not, what its own journal says of
 * the input to re-qualify (`caseQualificationPrecheck`, the very check `qualify` makes). One repeatable-read,
 * read-only transaction; no write, no lock, no contract upgrade, no V1, CRM or provider read. Only the columns and
 * events the check needs are read: never the case body; only the payload of owner changes and of the input event is
 * decrypted, server side, and nothing of it leaves but closed codes (no text, no Gmail or CRM id, no raw error).
 * `since` is when the input to re-qualify occurred. Causes a V1 lookup or a run would see are not recorded in this
 * phase (`runtimeCause: "not_recorded"`). Unlike `readCaseDiagnostics`, this read decrypts internal details.
 * An unsupported contract revision or an unreadable payload refuses.
 */
export async function readCaseQualificationDiagnostic(caseId: string, caller: CaseDiagnosticCaller): Promise<CaseQualificationDiagnostic | null> {
  if (caller?.kind !== "staff_session_verified" || typeof caller.staffUserId !== "string" || !UUID.test(caller.staffUserId)) fault("DIAGNOSTIC_CALLER_INVALID");
  if (typeof caseId !== "string" || !UUID.test(caseId)) return null;
  return requireDb().transaction(async tx => {
    const [row] = await tx.select({ id: savCases.id, version: savCases.version, contractRevision: savCases.contractRevision,
      admissionVersion: savCases.admissionVersion, admissionInputVersion: savCases.admissionInputVersion }).from(savCases).where(eq(savCases.id, caseId));
    if (!row) return null;
    if (row.contractRevision !== SAV_CASE_CONTRACT_REVISION && !(row.contractRevision in SAV_CASE_CONTRACT_UPGRADES)) fault("DIAGNOSTIC_UNREADABLE");
    const base = { revision: SAV_CASE_QUALIFICATION_DIAGNOSTIC_REVISION, caseId: row.id, caseVersion: row.version, inputVersion: row.admissionInputVersion, runtimeCause: "not_recorded" as const };
    if (row.admissionVersion !== null && row.admissionInputVersion <= row.admissionVersion)
      return { ...base, state: "current" as const, inputKey: null, since: null, block: null, nature: null };
    const rows = await tx.select({ id: savCaseEvents.id, kind: savCaseEvents.kind, direction: savCaseEvents.direction, caseVersion: savCaseEvents.caseVersion,
      occurredAt: savCaseEvents.occurredAt, payloadCiphertext: savCaseEvents.payloadCiphertext }).from(savCaseEvents)
      .where(and(eq(savCaseEvents.caseId, row.id), or(eq(savCaseEvents.direction, "customer_inbound"), eq(savCaseEvents.kind, "owner_changed"), eq(savCaseEvents.caseVersion, row.admissionInputVersion))))
      .orderBy(asc(savCaseEvents.caseVersion));
    const input = rows.find(event => event.caseVersion === row.admissionInputVersion);
    if (!input && row.admissionInputVersion > 0) fault("DIAGNOSTIC_UNREADABLE");
    const events = rows.map(event => {
      const needed = event.kind === "owner_changed" || (event.direction === "customer_inbound" && event.caseVersion === row.admissionInputVersion);
      let payload: { sourceRef?: SourceRef; detail: Record<string, unknown> | null } = { detail: null };
      if (needed) {
        let read: unknown;
        try { read = decryptSavPayload<unknown>(event.payloadCiphertext); } catch { return fault("DIAGNOSTIC_UNREADABLE"); }
        const parsed = z.object({ sourceRef: sourceRefSchema, detail: z.record(z.string(), z.unknown()).nullable() }).safeParse(read);
        if (!parsed.success) fault("DIAGNOSTIC_UNREADABLE");
        payload = parsed.data!;
      }
      // A projection with only what the check reads: the other events carry neither source nor detail.
      return { id: event.id, kind: event.kind, direction: event.direction, caseVersion: event.caseVersion, detail: payload.detail, sourceRef: payload.sourceRef } as unknown as CaseEvent;
    });
    const precheck = caseQualificationPrecheck({ admissionInputVersion: row.admissionInputVersion }, events);
    const since = input?.occurredAt.toISOString() ?? null;
    if (precheck.outcome === "eligible") return { ...base, state: "stale_ready" as const, inputKey: precheck.inputKey, since, block: null, nature: null };
    if (precheck.outcome === "blocked") return { ...base, state: "stale_blocked" as const, inputKey: precheck.inputKey, since, block: precheck.block, nature: "contract_blocked" as const };
    return { ...base, state: precheck.state === "no_customer_input" ? "no_customer_input" as const : "stale_unknown" as const, inputKey: precheck.inputKey, since, block: null, nature: null };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** UX console (V2 list): one page of cases, latest change first, optionally by phase and owner.
 * Columns only: nothing is decrypted and no customer content leaves the store. The cursor is opaque,
 * carries the exact database timestamp and is bound to the filters it was made for. Pages are a
 * view, not a snapshot: a case changed while paging moves to the top and may be seen twice. */
export const SAV_CASE_LIST_PAGE_MAX = 100;
export type CaseListItem = {
  caseId: string; ticketId: string; owner: string; phase: string; sensitivity: string; version: number; threadCount: number;
  contractRevision: string; contractSupported: boolean; admission: { target: string; reason: string | null; inputNewer: boolean } | null;
  claimUntil: string | null; createdAt: string; updatedAt: string;
};
export async function listCasesPage(input: { phase?: CasePhase; owner?: CaseOwner; limit?: number; cursor?: string | null } = {}): Promise<{ items: CaseListItem[]; nextCursor: string | null }> {
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > SAV_CASE_LIST_PAGE_MAX) fault("PAGE_INVALID");
  if (input.phase !== undefined && !(SAV_CASE_PHASES as readonly string[]).includes(input.phase)) fault("PAGE_INVALID");
  if (input.owner !== undefined && !(SAV_CASE_OWNERS as readonly string[]).includes(input.owner)) fault("PAGE_INVALID");
  const filters = `${input.phase ?? "*"}|${input.owner ?? "*"}`;
  let after: { at: string; id: string } | null = null;
  if (input.cursor) {
    const decoded = /^[A-Za-z0-9_-]{1,400}$/.test(input.cursor) ? (() => { try { return JSON.parse(Buffer.from(input.cursor!, "base64url").toString("utf8")) as unknown; } catch { return null; } })() : null;
    const cursor = z.object({ at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.string().regex(UUID), filters: z.literal(filters) }).strict().safeParse(decoded);
    if (!cursor.success) fault("PAGE_INVALID");
    after = { at: cursor.data!.at, id: cursor.data!.id };
  }
  // Microseconds, so the next page starts exactly after the last row and never skips a same-millisecond change.
  const exactAt = sql<string>`to_char(${savCases.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const rows = await requireDb().select({
    id: savCases.id, ticketId: savCases.ticketId, owner: savCases.owner, phase: savCases.phase, sensitivity: savCases.sensitivity, version: savCases.version,
    threadIds: savCases.threadIds, contractRevision: savCases.contractRevision, admissionTarget: savCases.admissionTarget, admissionReason: savCases.admissionReason,
    admissionVersion: savCases.admissionVersion, admissionInputVersion: savCases.admissionInputVersion, claimUntil: savCases.claimUntil, createdAt: savCases.createdAt, updatedAt: savCases.updatedAt, exactAt,
  }).from(savCases).where(and(...(input.phase ? [eq(savCases.phase, input.phase)] : []), ...(input.owner ? [eq(savCases.owner, input.owner)] : []),
    ...(after ? [sql`(${savCases.updatedAt}, ${savCases.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`] : [])))
    .orderBy(desc(savCases.updatedAt), desc(savCases.id)).limit(limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  return {
    items: page.map(row => ({ caseId: row.id, ticketId: row.ticketId, owner: row.owner, phase: row.phase, sensitivity: row.sensitivity, version: row.version, threadCount: row.threadIds.length,
      contractRevision: row.contractRevision, contractSupported: row.contractRevision === SAV_CASE_CONTRACT_REVISION || row.contractRevision in SAV_CASE_CONTRACT_UPGRADES,
      admission: row.admissionTarget === null ? null : { target: row.admissionTarget, reason: row.admissionReason, inputNewer: row.admissionVersion === null || row.admissionInputVersion > row.admissionVersion },
      claimUntil: row.claimUntil?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.exactAt, id: last.id, filters })).toString("base64url") : null,
  };
}

/** A customer mail that `decideCustomerReturn` routed to the case of its thread (V2 customer return, LOCAL, OFF: called by nothing in production). */
export type CustomerReturnWrite = {
  route: "continue" | "reopen" | "hand_to_team"; reason: string; caseId: string; expectedVersion: number;
  ticketId: string; threadId: string; messageId: string; gmailMessageId: string; receivedAt: string;
  /** The admission decided on THIS mail (V1's confirmed decision of it). Absent: it stays stale (`input_newer`), whatever the case proved before. */
  admission?: CaseAdmissionInput;
  /** First statement of the transaction, before the case lock (thread, then case, as V1's claim): V1's run of this mail ends with the record or not at all. Throws to refuse. */
  fence?: (tx: CaseTx) => Promise<void>;
};
export type CustomerReturnRecord = {
  replayed: boolean; case: CaseSnapshot;
  /** `readmitted`/`withdrawn`: decided on this mail's own qualification. `stale_requalification_required`: no qualification of this mail yet, nothing inherited. */
  admission: "readmitted" | "withdrawn" | "stale_requalification_required" | "stale_reminder_approved" | "unchanged";
  reopenedRequests: string[]; supersededReminders: number;
};

/** One transaction under the ticket lock: the mail joins the SAME case (one event per Gmail id, so a replay or V1's relay racing it records it once), the J2
 * timers it ends are cancelled with it, a J2 reminder nobody approved yet is superseded, and then
 *   continue  the wait ends (`queued`), requests as they are
 *   reopen    a new cycle; the requests that cycle resolved are open again (same incident still present); handed-off ones stay with the team
 *   hand_to_team  the ticket left the V2 owner: the case goes to the team as a system takeover; the HubSpot ticket is never written
 * A new mail may ask something else (finance after an access request): the qualification recorded for an earlier mail never admits it. The admission is decided
 * only on this mail's own qualification (a return consumed before V1 is requalified by B through `reevaluateCaseAdmission`), and without one it stays stale, so nothing is claimed or sent. It also stays stale when an approved J2 reminder is
 * still unsent, so the effect gate cancels that reminder (`new_input`) instead of sending it after the customer answered. */
export async function recordCustomerReturn(input: CustomerReturnWrite): Promise<CustomerReturnRecord> {
  const db = requireDb();
  await assertWritable(db);
  if (!CRM_ID.test(input.ticketId)) fault("TICKET_INVALID");
  if (!UUID.test(input.threadId) || !UUID.test(input.caseId)) fault("THREAD_INVALID");
  if (!CODE.test(input.reason)) fault("REASON_INVALID");
  const sourceRef: SourceRef = { type: "email", id: input.gmailMessageId };
  const event = validEvent({ kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(input.gmailMessageId), direction: "customer_inbound", occurredAt: input.receivedAt, sourceRef,
    detail: { messageId: input.messageId, relay: { kind: "v2_customer_return", messageId: input.messageId, route: input.route, reason: input.reason } } });
  return db.transaction(async tx => {
    await input.fence?.(tx);
    const row = await lockedCase(tx, input.caseId);
    const [replayed] = await tx.select({ id: savCaseEvents.id, payload: savCaseEvents.payloadCiphertext }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, row.id), eq(savCaseEvents.dedupeKey, event.dedupeKey)));
    // A fence ends V1's run on the promise that this route holds the mail. Recorded by another route meanwhile (handed to the team, relayed by V1): the whole transaction, the run's end included, is undone.
    if (replayed && input.fence) {
      const relay = decryptSavPayload<{ detail?: { relay?: { kind?: unknown; route?: unknown } } | null }>(replayed.payload).detail?.relay;
      if (relay?.kind !== "v2_customer_return" || relay.route !== input.route) fault("RETURN_ROUTE_CHANGED");
    }
    const result = (next: CaseRow, admission: CustomerReturnRecord["admission"], extra: Partial<CustomerReturnRecord> = {}): CustomerReturnRecord =>
      ({ replayed: false, case: toSnapshot(next), admission, reopenedRequests: [], supersededReminders: 0, ...extra });
    if (replayed) return { ...result(row, "unchanged"), replayed: true };
    if (row.version !== input.expectedVersion) throw new CaseVersionStaleError(row.version);
    if (row.ticketId !== input.ticketId || !row.threadIds.includes(input.threadId)) fault("RETURN_LINK_CHANGED");
    const before = toSnapshot(row);
    if (before.owner !== "agent") fault("RETURN_OWNER_CHANGED");
    const appended = await appendLocked(tx, row, event);
    if (!appended.appended) throw new CaseVersionStaleError(row.version);
    if (input.route === "hand_to_team") {
      const body = parseBody({ ...before.body, waiting: null, handoff: { reason: input.reason, humanSince: new Date().toISOString() } });
      const [moved] = await tx.update(savCases).set({ ...NO_CLAIM, owner: "human", phase: "human_owned", payloadCiphertext: encryptSavPayload(body), updatedAt: new Date() })
        .where(and(eq(savCases.id, row.id), eq(savCases.version, appended.row.version))).returning();
      if (!moved) throw new CaseVersionStaleError(appended.row.version);
      return result((await appendLocked(tx, moved, validEvent({ kind: "owner_changed", dedupeKey: caseDedupeKey.command(`customer-return.${input.gmailMessageId}`), sourceRef, detail: {
        transition: "human_takeover", from: "agent", to: "human", fromPhase: before.phase, toPhase: "human_owned", actor: { type: "system" }, reason: input.reason,
      } }))).row, "unchanged");
    }
    // A J2 reminder still `proposed` answers a silence that is over: superseded, as a newer proposal would.
    const reminders = like(savCaseReplyValidations.replyKey, `reply:${row.id}:timer:%`);
    const superseded = await tx.update(savCaseReplyValidations).set({ state: "superseded", decidedAt: new Date() })
      .where(and(eq(savCaseReplyValidations.caseId, row.id), reminders, eq(savCaseReplyValidations.state, "proposed"))).returning({ id: savCaseReplyValidations.id });
    const approvedReminders = await tx.select({ replyKey: savCaseReplyValidations.replyKey }).from(savCaseReplyValidations)
      .where(and(eq(savCaseReplyValidations.caseId, row.id), reminders, eq(savCaseReplyValidations.state, "approved")));
    let unsent = false;
    for (const reminder of approvedReminders) {
      const [engaged] = await tx.select({ id: savIntakeEffects.id }).from(savIntakeEffects).where(and(eq(savIntakeEffects.businessKey, reminder.replyKey), ne(savIntakeEffects.state, "planned")));
      if (!engaged) unsent = true;
    }
    const reopened = input.route === "reopen"
      ? before.body.openRequests.filter(request => request.status === "resolved" && !caseSensitivityForFamily(request.family)).map(request => request.id) : [];
    const body = parseBody({
      ...before.body, waiting: null, trials: await trialsOnCustomerReturn(tx, before, input),
      ...(input.route === "reopen" ? { cycle: { number: before.body.cycle.number + 1 },
        openRequests: before.body.openRequests.map(request => reopened.includes(request.id) ? { ...request, status: "open" as const } : request) } : {}),
    });
    // The wait (or the closed cycle) ends; a case being analysed keeps its phase and its claim: the observation will see the version moved and apply nothing stale.
    const phase: CasePhase = input.route === "reopen" || before.phase === "awaiting_customer" ? "queued" : before.phase;
    const [next] = await tx.update(savCases).set({ phase, payloadCiphertext: encryptSavPayload(body), updatedAt: new Date() })
      .where(and(eq(savCases.id, row.id), eq(savCases.version, appended.row.version))).returning();
    if (!next) throw new CaseVersionStaleError(appended.row.version);
    const extra = { reopenedRequests: reopened, supersededReminders: superseded.length };
    if (unsent) return result(next, "stale_reminder_approved", extra);
    if (!input.admission) return result(next, "stale_requalification_required", extra);
    const decided = await applyAdmission(tx, next, { ...input.admission, qualification: parseQualification(input.admission.qualification) }, sourceRef);
    return result(decided, decided.owner === "agent" ? "readmitted" : "withdrawn", extra);
  });
}
