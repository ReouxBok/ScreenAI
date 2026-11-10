import "server-only";
import { savV2QualificationMessageAllowed } from "./qualification-scope";
import { and, asc, desc, eq, isNotNull, min, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEvents, savCases, savIntakeEffects, savIntakeExecutions, savIntakeRuns, savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { redactSavLearningText } from "../learning-extraction";
import type { SavIntakeDecision } from "../intake/contract";
import type { ExecutionPayload } from "../intake/execution-types";
import type { IntakeRuntimePayload } from "../intake/runtime-contract";
import { readSavAgentPause } from "../intake/agent-pause";
import { decideCaseAdmission } from "./admission-policy";
import { listCaseEvents, openCaseEvent, readCaseByTicket, savCaseRecordingEnabled, transitionCaseOwner, v1IntentHash, type CaseTx } from "./case-store";
import {
  SAV_CASE_SENSITIVE_FAMILIES, SAV_CASE_SUBJECT_LENGTH, caseDedupeKey, caseRequestId, caseRequestSubjectSchema,
  type CaseAdmissionQualification, type CaseAttributionProof, type CaseOwnerAtCreationProof, type CaseRelayProof, caseAwaitsV2Attribution, type CaseRequestSubject, type CaseSensitivity, type CaseSnapshot,
  type CaseSubjectAbsence,
} from "./case-types";

/** Subset of readIntakeExecutionProgress: `confirmed` already requires every required
 * intake effect to be confirmed, not merely a plan or a succeeded run. */
type IntakeProgress = { state: string; ticketId: string | null; confirmed: boolean; effects?: unknown[] } | null;
/** A current V1 analysis that classified the message as an acknowledgement needing no CRM effect. */
export type IntakeAcknowledgement = { runId: string; runVersion: number; sourceHash: string; decision: Pick<SavIntakeDecision, "classification" | "requests"> };
export type CaseBoundaryDeps = {
  env?: Record<string, string | undefined>; readProgress?: (messageId: string) => Promise<IntakeProgress>;
  /** Current approved admission policy. None is stored yet, so the default admits nobody. */
  readAdmissionPolicy?: () => Promise<unknown>;
  readAcknowledgement?: (messageId: string) => Promise<IntakeAcknowledgement | null>;
  /** Qualification of the message's requests proven by a human or an approved rule (v8). Not
   * injected in production: without it the relay has intake hints only, which never admit. */
  readQualification?: (input: { messageId: string; gmailMessageId: string; requests: CaseRelayRequest[]; target?: CaseQualificationTarget }) => Promise<CaseAdmissionQualification | null>;
  /** Pilot access (3/11, 4/11): the HubSpot owner of a ticket, read just now (A10's `hubspotTicketOwnerReader` on an injected
   * transport): a ticket V1 created with the V2 owner, or any ticket of an admitted mail still waiting for its owner. Asked only for
   * an admitted case; not injected in production, so no case is attributed there. Throws when it cannot read; `undefined` is unknown, never none. */
  readCreatedTicketOwner?: (ticketId: string) => Promise<string | null | undefined>;
  /** The V2 entry (`SAV_V2_ENTRY=on` only): the customer-return route of a mail V1 finished with, before any relay. A result ends it; null lets the normal relay go on. */
  routeReturn?: (messageId: string) => Promise<CaseRelayResult | null>;
  /** SAV-81 (V2 entry only): in qualification mode, while no thread is bound yet, a mail V1 confirmed on the ticket it created may bind its thread here.
   * `write: false` checks V1's proofs and the exact scope without writing anything (before any owner read); `write: true` binds atomically, asked only
   * after the fresh reading of the V2 owner. False refuses: the mail is recorded, never attributed. Not injected: no other way to bind than at creation. */
  bindQualificationThread?: (input: { messageId: string; ticketId: string; executionId: string; runId: string | null; runVersion: number; write: boolean }) => Promise<boolean>;
};
export type CaseRelayRequest = { requestId: string; kind: string };
/** What the relay is about to record, from its own V1 proof: a qualification port compares its
 * source with it before answering. `executionId` is null for an acknowledgement (no execution). */
export type CaseQualificationTarget = { ticketId: string; executionId: string | null; runId: string | null; runVersion: number };

/** The HubSpot owner id dedicated to the V2 agent. A parameter only: absent, malformed or equal to
 * the V1 team owner (HUBSPOT_SAV_OWNER_ID) means no attribution at all, and no owner or user is ever
 * created for it. */
export function v2HubspotOwnerId(env: Record<string, string | undefined> = process.env) {
  const value = env.SAV_V2_HUBSPOT_OWNER_ID;
  return value && /^[0-9]{1,20}$/.test(value) && value !== env.HUBSPOT_SAV_OWNER_ID ? value : null;
}

/** v9: V1's confirmed `owner_assign` of this execution, for the configured V2 owner only; or (pilot access,
 * 3/11) V1's confirmed `ticket_create` of this execution that created this ticket with that owner in the
 * creation itself. Ledger only, no CRM read: the relay still reads the current owner before using the
 * creation route. The store checks the same row again under its lock; uncertain or merely sent is no proof. */
export async function readAttributionProof(input: { executionId: string; messageId: string; ticketId: string; env?: Record<string, string | undefined> }): Promise<CaseAttributionProof | null> {
  const ownerId = v2HubspotOwnerId(input.env);
  if (!ownerId) return null;
  const key = `owner-v2:${input.messageId}:${input.ticketId}`;
  const [effect] = await requireDb().select().from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, input.executionId), eq(savIntakeEffects.businessKey, key)));
  if (effect?.kind === "owner_assign" && effect.state === "confirmed") {
    const intent = decryptSavPayload<{ key?: string; ticketId?: string; properties?: { hubspot_owner_id?: string } }>(effect.intentCiphertext);
    if (v1IntentHash(intent) !== effect.intentHash || intent.key !== key || intent.ticketId !== input.ticketId || intent.properties?.hubspot_owner_id !== ownerId) return null;
    return { kind: "hubspot_owner_verified", executionId: input.executionId, effectId: effect.id, ticketId: input.ticketId, ownerId };
  }
  const [create] = await requireDb().select().from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, input.executionId), eq(savIntakeEffects.kind, "ticket_create")));
  if (!create || create.state !== "confirmed" || !create.ackCiphertext) return null;
  const intent = decryptSavPayload<{ kind?: string; key?: string; properties?: { hubspot_owner_id?: string } }>(create.intentCiphertext);
  if (v1IntentHash(intent) !== create.intentHash || intent.kind !== "ticket_create" || intent.key !== create.businessKey || intent.properties?.hubspot_owner_id !== ownerId) return null;
  if (decryptSavPayload<{ id?: string }>(create.ackCiphertext).id !== input.ticketId) return null;
  return { kind: "hubspot_owner_at_creation", executionId: input.executionId, effectId: create.id, ticketId: input.ticketId, ownerId, intentHash: create.intentHash };
}

/** The ticket's owner now, for the creation route: still the V2 owner, or the case waits with the team. A
 * person who took it, or who removed the V2 owner, keeps it. A reading that is not one (throw, unknown,
 * malformed) stops the relay: the mail is not recorded, and the catch-up tries again. */
async function confirmCreatedOwner(proof: CaseOwnerAtCreationProof, deps: CaseBoundaryDeps): Promise<CaseAttributionProof | "pending"> {
  if (!deps.readCreatedTicketOwner) return "pending";
  const current = await deps.readCreatedTicketOwner(proof.ticketId);
  if (current === undefined || (current !== null && !/^[0-9]{1,20}$/.test(current))) throw Error("SAV_CASE_CREATED_OWNER_UNREAD");
  return current === proof.ownerId ? proof : "pending";
}

/** Ugo (4/11): the ordinary case. The ticket's owner is ALREADY the V2 owner and the mail is admitted: V2 processes it, whoever set that owner, with one read and no write. Nobody is
 * overwritten, so no compare-and-set is needed. An empty owner is still not taken, a person keeps the ticket, and a case that does not wait (the agent's, the team's, a person's) is not
 * even read. A reading that is not one leaves the case waiting and never loses the mail: the sweep reads again. */
async function ownerReadProof(input: { ticketId: string; messageId: string; admission: Awaited<ReturnType<typeof relayAdmissionInput>>["admission"]; deps: CaseBoundaryDeps }): Promise<CaseAttributionProof | "pending"> {
  const { deps, ticketId } = input, ownerId = v2HubspotOwnerId(deps.env);
  if (!deps.readCreatedTicketOwner || !ownerId || await relayPaused(requireDb())) return "pending";
  const current = await readCaseByTicket(ticketId);
  if (current && !caseAwaitsV2Attribution(current)) return "pending";
  if (decideCaseAdmission({ policy: input.admission.policy, qualification: input.admission.qualification, caseSensitivity: current?.sensitivity ?? "none" }).target !== "agent") return "pending";
  let reading: string | null | undefined;
  try { reading = await deps.readCreatedTicketOwner(ticketId); } catch { return "pending"; }
  return reading === ownerId ? { kind: "hubspot_owner_read", messageId: input.messageId, ticketId, ownerId } : "pending";
}

/** Lot C (4/11): HubSpot has no conditional write, so the read that gave the case to the agent is not atomic with the commit. The owner is read once more AFTER the commit: a person
 * (or nobody) now means the team has it, at once, with nothing written on the ticket. This narrows the window, it does not close it: C reads the owner again before every new step.
 * A reading that is not one changes nothing here and proves nothing: the case stays unconfirmed for every later step. A failed move is no failure of the relay: the mail is recorded. */
async function handBackIfOwnerMovedAfterCommit(current: CaseSnapshot, proof: Pick<CaseOwnerAtCreationProof, "ticketId" | "ownerId">, deps: CaseBoundaryDeps): Promise<CaseSnapshot> {
  let reading: string | null | undefined;
  try { reading = await deps.readCreatedTicketOwner!(proof.ticketId); } catch { return current; }
  if (reading === undefined || reading === proof.ownerId || (reading !== null && !/^[0-9]{1,20}$/.test(reading))) return current;
  try {
    const moved = await transitionCaseOwner({ caseId: current.caseId, expectedVersion: current.version, transition: "human_takeover", actor: { type: "system" }, commandKey: `relay-owner-recheck.${proof.ticketId}.${current.version}`,
      reason: reading === null ? "hubspot_owner_removed" : "hubspot_owner_human", sourceRef: { type: "hubspot_object", id: proof.ticketId } });
    return moved.case;
  } catch { return current; }
}

/** The console pauses the intake agent; V2 has its own row. Any level but running on either, or an unreadable
 * one, stops giving a case to the agent (the pause contract stops admissions from `actions_paused` on). The
 * mail itself is still recorded: it is a durable fact with no external effect, and it must cancel what it
 * cancels (a J2 reminder, a prepared reply) during the pause. A ticket relayed during a pause waits, with no owner read; after the pause the sweep reads its owner (4/11). */
export async function relayPaused(db: Pick<CaseTx, "select">) {
  const pauses = [await readSavAgentPause(db, "intake"), await readSavAgentPause(db, "v2")];
  return pauses.some(pause => pause.invalid || pause.level !== "running");
}

/** Finance/cancellation take precedence over the whole message, as in the intake contract. */
export function caseSensitivityOf(decision: Pick<SavIntakeDecision, "classification" | "requests">): CaseSensitivity {
  const kinds = new Set<string>([decision.classification, ...decision.requests.map(request => request.kind)]);
  return kinds.has("cancellation") ? "cancellation" : kinds.has("finance") ? "finance" : "none";
}

/** What intake can tell admission today: model categories only, as hints. Finance and
 * cancellation exclude; nothing here can admit (identity and CRM completeness are not
 * mapped from V1 yet, and every other request stays an unknown family). */
export function admissionQualificationFromIntake(decision: Pick<SavIntakeDecision, "classification" | "requests">, gmailMessageId: string): CaseAdmissionQualification {
  const provenance = { kind: "intake_hint" as const, source: { type: "email" as const, id: gmailMessageId } };
  const family = (kind: string): "finance" | "cancellation" | "unknown" => kind === "finance" || kind === "cancellation" ? kind : "unknown";
  const requests: CaseAdmissionQualification["requests"] = decision.requests.map(request => ({ requestId: caseRequestId(gmailMessageId, request.id), family: family(request.kind), provenance }));
  if (family(decision.classification) !== "unknown" && !requests.some(request => request.family === decision.classification))
    requests.push({ requestId: caseRequestId(gmailMessageId, "classification"), family: family(decision.classification), provenance });
  return { requests, identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] };
}

/** What a relayed mail opens in its case (v8): one request per V1 request, by id and kind only,
 * never the customer's text, so an empty mail whose subject carried the request is handled like
 * any other. A confirmed ticket whose analysis listed none still opens one for the mail; an
 * acknowledgement opens nothing. */
export function caseRequestsOpenedByIntake(decision: Pick<SavIntakeDecision, "classification" | "requests">, gmailMessageId: string, confirmedTicket: boolean): CaseRelayRequest[] {
  const requests = decision.requests.filter(request => request.kind !== "acknowledgement").map(request => ({ requestId: caseRequestId(gmailMessageId, request.id), kind: request.kind as string }));
  if (!requests.length && confirmedTicket) requests.push({ requestId: caseRequestId(gmailMessageId, "message"), kind: decision.classification });
  return requests;
}
const openedSummary = (request: CaseRelayRequest, gmailMessageId: string) => `Demande « ${request.kind} » relevée par l'analyse V1 du mail ${gmailMessageId}.`;

// Masks on top of the learning redaction: international phones, long tokens and any long number
// (orders, accounts, tickets). A search needs the problem, not who has it or which record.
const SUBJECT_MASKS: Array<[RegExp, string]> = [
  [/(?<!\w)\+\d(?:[ .()-]?\d){7,14}\b/g, "[téléphone masqué]"], [/\b[A-Za-z0-9_-]{24,}\b/g, "[valeur masquée]"], [/\b\d{5,}\b/g, "[numéro masqué]"],
];
const searchableSubject = (summary: { title: string; description: string }) => SUBJECT_MASKS
  .reduce((text, [pattern, mask]) => text.replace(pattern, mask), redactSavLearningText(`${summary.title}. ${summary.description}`))
  .replace(/\s+/g, " ").trim().slice(0, SAV_CASE_SUBJECT_LENGTH.max).trim();

/** v10: the searchable subject of each request a V1 run lists, keyed by case request id. The only
 * source is that run's `ticketSummary`, as V1 accepted and stored it (`semantic-records.ts`), checked
 * against its own hashes; never the mail. A summary covering several requests is none of their
 * subjects, and two accepted analyses that disagree give none either: absent, with the reason. */
export async function readRequestSubjects(input: { runId: string | null; runVersion: number; messageId: string; gmailMessageId: string; requestIds: string[] }): Promise<Map<string, CaseRequestSubject>> {
  const subjects = new Map<string, CaseRequestSubject>();
  const all = (reason: CaseSubjectAbsence) => {
    for (const id of input.requestIds) subjects.set(caseRequestId(input.gmailMessageId, id), { status: "absent", reason });
    return subjects;
  };
  if (!input.requestIds.length) return subjects;
  if (!input.runId) return all("source_missing");
  const [run] = await requireDb().select({ version: savIntakeRuns.version, messageId: savIntakeRuns.messageId, payloadCiphertext: savIntakeRuns.payloadCiphertext })
    .from(savIntakeRuns).where(eq(savIntakeRuns.id, input.runId));
  if (!run || run.version !== input.runVersion || run.messageId !== input.messageId) return all("source_missing");
  const semantics = decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext).semantics;
  if (!semantics?.records.some(row => row.method === "analyseMessage")) return all("source_missing");
  const [records, { savIntakeEvidenceContentHash }, { messageAnalysisSchema }, { SAV_INTAKE_MODEL_REVISION }, { SAV_INTAKE_SIMPLE_REVISION }] = await Promise.all([
    import("../intake/semantic-records"), import("../intake/engine"), import("../intake/engine-types"), import("../intake/model-readers"), import("../intake/simple-revision")]);
  if (semantics.revision !== records.SAV_INTAKE_SEMANTIC_RECORD_REVISION || ![SAV_INTAKE_MODEL_REVISION, SAV_INTAKE_SIMPLE_REVISION].includes(semantics.validatorRevision)) return all("source_invalid");
  const accepted = semantics.records.filter(row => row.method === "analyseMessage").flatMap(row => {
    const parsed = messageAnalysisSchema.safeParse(row.result);
    const intact = row.inputHash === records.intakeSemanticInputHash(row.input) && row.resultHash === savIntakeEvidenceContentHash(row.result);
    return intact && parsed.success && parsed.data.messageId === input.messageId ? [{ row, analysis: parsed.data }] : [];
  });
  if (!accepted.length) return all("source_invalid");
  for (const id of input.requestIds) {
    const key = caseRequestId(input.gmailMessageId, id), absent = (reason: CaseSubjectAbsence) => subjects.set(key, { status: "absent", reason });
    const listing = accepted.filter(entry => entry.analysis.requests.some(request => request.id === id));
    if (!listing.length) { absent("source_missing"); continue; }
    const covering = (entry: typeof listing[number]) => entry.analysis.ticketSummary?.requestIds.includes(id) ? entry.analysis.ticketSummary : null;
    if (new Set(listing.map(entry => JSON.stringify(covering(entry)))).size > 1) { absent("source_ambiguous"); continue; }
    const entry = listing.at(-1)!, summary = covering(entry);
    if (!summary) { absent("not_in_summary"); continue; }
    if (entry.analysis.requests.filter(request => request.kind !== "acknowledgement" && summary.requestIds.includes(request.id)).length > 1) { absent("summary_shared"); continue; }
    const text = searchableSubject(summary);
    // Masks alone are nothing to search for.
    if (text.replace(/\[[^\]]*masqu[^\]]*\]/g, "").replace(/[^\p{L}\p{N}]+/gu, "").length < SAV_CASE_SUBJECT_LENGTH.min) { absent("redacted_empty"); continue; }
    const subject = caseRequestSubjectSchema.safeParse({ status: "available", text, provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
      runId: input.runId, runVersion: input.runVersion, resultHash: entry.row.resultHash, validatorRevision: semantics.validatorRevision, acceptedAt: entry.row.acceptedAt } });
    if (subject.success) subjects.set(key, subject.data); else absent("source_invalid");
  }
  return subjects;
}

/** A proven qualification replaces the hints of the requests it covers. A sensitive hint is kept
 * whatever the proof says (a hint may always exclude) and an uncovered request keeps its hint. */
export function relayQualification(hints: CaseAdmissionQualification, proven: CaseAdmissionQualification | null, requests: CaseRelayRequest[]): CaseAdmissionQualification {
  if (!proven) return hints;
  const ids = new Set(requests.map(request => request.requestId));
  if (proven.requests.some(request => !ids.has(request.requestId))) throw Error("SAV_CASE_QUALIFICATION_REQUEST_UNKNOWN");
  const covered = new Set(proven.requests.map(request => request.requestId));
  const kept = hints.requests.filter(hint => !covered.has(hint.requestId) || (SAV_CASE_SENSITIVE_FAMILIES as readonly string[]).includes(hint.family));
  return { ...proven, requests: [...proven.requests, ...kept], teamSignals: [...hints.teamSignals, ...proven.teamSignals] };
}

/** The acknowledgement read from V1's own records: the latest analysis of this message is
 * accepted, says acknowledgement only, was not refused by an operator, and its sources still
 * match the thread up to this message. */
export async function readIntakeAcknowledgement(messageId: string): Promise<IntakeAcknowledgement | null> {
  const db = requireDb();
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, messageId));
  if (!message || message.direction !== "inbound" || !message.gmailMessageId) return null;
  const [run] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, messageId)).orderBy(desc(savIntakeRuns.version)).limit(1);
  if (!run || run.state !== "observed" || !run.sourceHash) return null;
  const plan = decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext).plan;
  const disposition = plan?.decision.disposition;
  if (!plan || disposition?.kind !== "no_ticket" || disposition.reason !== "acknowledgement_only") return null;
  const { intakeHumanRefused } = await import("../intake/human-binding");
  if (await intakeHumanRefused(messageId, db)) return null;
  const { savIntakeSourceSnapshot, intakeSourceMatches } = await import("../intake/runtime-store");
  const local = await db.transaction(async tx => savIntakeSourceSnapshot(tx, message, new Date()));
  if (!intakeSourceMatches(local, run.sourceHash)) return null;
  return { runId: run.id, runVersion: run.version, sourceHash: run.sourceHash, decision: plan.decision };
}

export type CaseRelayResult =
  | { skipped: "recording_off" | "intake_not_confirmed" | "source_missing" | "no_case_for_thread" | "thread_case_ambiguous" | "before_case" | "customer_return_wait" | "customer_return_not_consumed" }
  | { caseId: string; version: number; created: boolean; appended: boolean; owner: string; relay: CaseRelayProof["kind"] | "v2_customer_return";
      admission: { target: string; reasons: string[] } | null };

/** V1 → V2 relay (SAV-11): a case event exists only with a durable V1 proof, one per
 * (case, message). Either every required intake effect is confirmed, or V1 classified the
 * message as an acknowledgement needing no CRM effect and its thread already belongs to one
 * case; nothing else, and no CRM receipt is ever made up. On an existing case the relay only
 * applies exclusions: the event leaves the admission stale until re-evaluated. Not wired into
 * the executor yet; `sweepCaseRelays` replays it from durable records after a crash. Never
 * throws for an unconfirmed intake: it returns `skipped` and writes nothing. */
export async function recordCaseAfterConfirmedIntake(messageId: string, deps: CaseBoundaryDeps = {}): Promise<CaseRelayResult> {
  if (!savCaseRecordingEnabled(deps.env)) return { skipped: "recording_off" };
  const readProgress = deps.readProgress ?? (await import("../intake/executor")).readIntakeExecutionProgress;
  const progress = await readProgress(messageId);
  // An execution with effects is the only proof for this message: confirmed or nothing.
  const engaged = progress && (progress.ticketId || progress.effects === undefined || progress.effects.length > 0);
  if (deps.routeReturn && (!engaged || (progress.confirmed && progress.state === "confirmed" && progress.ticketId))) {
    const routed = await deps.routeReturn(messageId);
    if (routed) return routed;
  }
  if (engaged) return relayConfirmedEffects(messageId, progress, deps);
  return relayAcknowledgement(messageId, deps);
}

async function relayConfirmedEffects(messageId: string, progress: NonNullable<IntakeProgress>, deps: CaseBoundaryDeps): Promise<CaseRelayResult> {
  if (!progress.confirmed || progress.state !== "confirmed" || !progress.ticketId) return { skipped: "intake_not_confirmed" };
  const [source] = await requireDb().select({ execution: savIntakeExecutions, gmailMessageId: savMessages.gmailMessageId, direction: savMessages.direction, threadId: savMessages.threadId, receivedAt: savMessages.receivedAt })
    .from(savIntakeExecutions).innerJoin(savMessages, eq(savMessages.id, savIntakeExecutions.messageId)).where(eq(savIntakeExecutions.messageId, messageId));
  if (!source || source.execution.state !== "confirmed" || source.execution.ticketId !== progress.ticketId) return { skipped: "intake_not_confirmed" };
  if (source.direction !== "inbound" || !source.gmailMessageId) return { skipped: "source_missing" };
  const ticketId = progress.ticketId, executionId = source.execution.id;
  const decision = decryptSavPayload<ExecutionPayload>(source.execution.payloadCiphertext).plan.decision;
  const relay: CaseRelayProof = { kind: "intake_effects_confirmed", messageId, executionId, intakeRunId: source.execution.runId, intakeRunVersion: source.execution.runVersion };
  const attribution = await readAttributionProof({ executionId, messageId, ticketId, env: deps.env }) ?? "pending";
  return relayToCase({ ticketId, threadId: source.threadId, gmailMessageId: source.gmailMessageId, receivedAt: source.receivedAt, decision, relay, deps, confirmedTicket: true, attribution,
    assertFresh: async tx => {
      const [row] = await tx.select({ state: savIntakeExecutions.state, ticketId: savIntakeExecutions.ticketId }).from(savIntakeExecutions)
        .where(eq(savIntakeExecutions.id, executionId)).for("share");
      if (row?.state !== "confirmed" || row.ticketId !== ticketId) throw Error("SAV_CASE_INTAKE_NOT_CONFIRMED");
    } });
}

async function relayAcknowledgement(messageId: string, deps: CaseBoundaryDeps): Promise<CaseRelayResult> {
  const db = requireDb();
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, messageId));
  if (!message || message.direction !== "inbound" || !message.gmailMessageId) return { skipped: "source_missing" };
  const acknowledgement = await (deps.readAcknowledgement ?? readIntakeAcknowledgement)(messageId);
  if (!acknowledgement) return { skipped: "intake_not_confirmed" };
  // The thread is the only link V1 gives an acknowledgement: it must lead to exactly one case.
  const cases = await db.select({ id: savCases.id, ticketId: savCases.ticketId }).from(savCases).where(sql`${message.threadId} = any(${savCases.threadIds})`).limit(2);
  if (!cases.length) return { skipped: "no_case_for_thread" };
  if (cases.length > 1) return { skipped: "thread_case_ambiguous" };
  // A thank-you older than the case's first message belongs to an earlier exchange.
  const [first] = await db.select({ at: min(savCaseEvents.occurredAt) }).from(savCaseEvents)
    .where(and(eq(savCaseEvents.caseId, cases[0]!.id), eq(savCaseEvents.kind, "inbound_confirmed")));
  if (!first?.at || message.receivedAt < new Date(first.at)) return { skipped: "before_case" };
  const relay: CaseRelayProof = { kind: "acknowledgement_on_case_thread", messageId, intakeRunId: acknowledgement.runId, intakeRunVersion: acknowledgement.runVersion, sourceHash: acknowledgement.sourceHash };
  return relayToCase({ ticketId: cases[0]!.ticketId, threadId: message.threadId, gmailMessageId: message.gmailMessageId, receivedAt: message.receivedAt, decision: acknowledgement.decision, relay, deps, confirmedTicket: false, attribution: "pending",
    assertFresh: async tx => {
      const [run] = await tx.select({ state: savIntakeRuns.state, version: savIntakeRuns.version }).from(savIntakeRuns)
        .where(eq(savIntakeRuns.id, acknowledgement.runId)).for("share");
      if (run?.state !== "observed" || run.version !== acknowledgement.runVersion) throw Error("SAV_CASE_INTAKE_NOT_CONFIRMED");
    } });
}

async function relayToCase(input: {
  ticketId: string; threadId: string; gmailMessageId: string; receivedAt: Date; decision: Pick<SavIntakeDecision, "classification" | "requests">;
  relay: CaseRelayProof; deps: CaseBoundaryDeps; confirmedTicket: boolean; assertFresh: (tx: CaseTx) => Promise<void>; attribution: "pending" | CaseAttributionProof;
}): Promise<CaseRelayResult> {
  const target: CaseQualificationTarget = { ticketId: input.ticketId, executionId: input.relay.kind === "intake_effects_confirmed" ? input.relay.executionId : null,
    runId: input.relay.intakeRunId, runVersion: input.relay.intakeRunVersion };
  const { admission, requests } = await relayAdmissionInput({ messageId: input.relay.messageId, gmailMessageId: input.gmailMessageId, decision: input.decision, confirmedTicket: input.confirmedTicket, deps: input.deps, target });
  // No attribution while paused (and no CRM read for it). The creation route reads the CRM owner only for a
  // mail admitted for the agent: a sensitive, mixed or unqualified one is never read. The store decides the
  // admission again under its lock.
  // SAV-80: outside the qualification scope the mail is recorded, never attributed to the agent (no owner read for it either).
  const scope = await savV2QualificationMessageAllowed(input.deps.env ?? process.env, input.relay.messageId), inScope = scope.allowed;
  let attribution = !inScope || (input.attribution !== "pending" && await relayPaused(requireDb())) ? "pending" as const : input.attribution;
  if (attribution !== "pending" && attribution.kind === "hubspot_owner_at_creation")
    attribution = decideCaseAdmission({ policy: admission.policy, qualification: admission.qualification, caseSensitivity: "none" }).target === "agent"
      ? await confirmCreatedOwner(attribution, input.deps) : "pending";
  // No V1 owner effect for this mail: the owner as it reads now is enough. An acknowledgement opens nothing and proves no ticket: it never takes this route.
  else if (input.attribution === "pending" && input.relay.kind === "intake_effects_confirmed") {
    // SAV-81: a mail V1 confirmed while no thread was bound (its subject did not match at the creation) is otherwise never attributed. Only through the
    // entry's binder, and in this order: V1's proofs and the exact scope read only, then the owner read now, then the atomic binding. Anything else: out of scope.
    const relay = input.relay, bind = !inScope && !scope.allowed && scope.reason === "qualification_thread_unbound" ? input.deps.bindQualificationThread : undefined;
    const proofs = bind && { messageId: relay.messageId, ticketId: input.ticketId, executionId: relay.executionId, runId: relay.intakeRunId, runVersion: relay.intakeRunVersion };
    if (inScope || (bind && proofs && await bind({ ...proofs, write: false }))) {
      attribution = await ownerReadProof({ ticketId: input.ticketId, messageId: relay.messageId, admission, deps: input.deps });
      // Bound, then read back: the attribution stands only on a thread the scope now covers.
      if (attribution !== "pending" && bind && proofs && (!await bind({ ...proofs, write: true })
        || !(await savV2QualificationMessageAllowed(input.deps.env ?? process.env, relay.messageId)).allowed)) attribution = "pending";
    }
  }
  const subjects = requests.length ? await readRequestSubjects({ runId: input.relay.intakeRunId, runVersion: input.relay.intakeRunVersion, messageId: input.relay.messageId,
    gmailMessageId: input.gmailMessageId, requestIds: input.decision.requests.filter(request => request.kind !== "acknowledgement").map(request => request.id) }) : new Map<string, CaseRequestSubject>();
  const result = await openCaseEvent({
    ticketId: input.ticketId, threadId: input.threadId, admissionMode: "exclusions_only", attribution, admission,
    opens: requests.map(request => ({ id: request.requestId, summary: openedSummary(request, input.gmailMessageId),
      // The `message` stand-in of a mail whose analysis listed no request has no V1 summary of its own.
      subject: subjects.get(request.requestId) ?? { status: "absent" as const, reason: "not_in_summary" as const } })),
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(input.gmailMessageId),
    direction: "customer_inbound", occurredAt: input.receivedAt.toISOString(),
    sourceRef: { type: "email", id: input.gmailMessageId }, detail: { messageId: input.relay.messageId, relay: input.relay },
    // A pause set since the first look stops an attribution under the ticket lock; the catch-up relays the
    // mail again, without attribution while the pause lasts.
    assertFresh: async tx => {
      if (attribution !== "pending" && await relayPaused(tx)) throw Error("SAV_CASE_RELAY_PAUSED");
      await input.assertFresh(tx);
    },
  });
  // A proof above means the case could still wait when it was read: on a first relay or on a replay of a waiting mail, what comes back as the agent's was just moved.
  const settled = attribution !== "pending" && attribution.kind !== "hubspot_owner_verified" && (result.appended || attribution.kind === "hubspot_owner_read") && result.case.owner === "agent"
    ? await handBackIfOwnerMovedAfterCommit(result.case, attribution, input.deps) : result.case;
  return { caseId: settled.caseId, version: settled.version, created: result.created, appended: result.appended, owner: settled.owner, relay: input.relay.kind,
    admission: settled.admission && { target: settled.admission.target, reasons: settled.admission.reasons } };
}

/** What the relay decides admission from, for one mail: the current approved policy and V1's
 * requests, with the qualification port's proof where it covers them. The V2 owner port computes
 * the same thing before the case exists, so both decide alike. */
export async function relayAdmissionInput(input: { messageId: string; gmailMessageId: string; decision: Pick<SavIntakeDecision, "classification" | "requests">; confirmedTicket: boolean; deps: CaseBoundaryDeps; target?: CaseQualificationTarget }) {
  const policy = input.deps.readAdmissionPolicy ? await input.deps.readAdmissionPolicy() : null;
  const requests = caseRequestsOpenedByIntake(input.decision, input.gmailMessageId, input.confirmedTicket);
  const proven = requests.length && input.deps.readQualification
    ? await input.deps.readQualification({ messageId: input.messageId, gmailMessageId: input.gmailMessageId, requests, ...(input.target ? { target: input.target } : {}) }) : null;
  return { admission: { policy, qualification: relayQualification(admissionQualificationFromIntake(input.decision, input.gmailMessageId), proven, requests) }, requests };
}

/** Durable catch-up after a crash between V1 confirmation and the wake: the V1 records are
 * the source of truth, the wake is only a hint. Finds confirmed executions, and accepted
 * acknowledgements on a case's thread, whose case has no event for that message yet, and
 * relays them. Reads the database only: no CRM, Gmail or model call, and each relay is
 * idempotent per (case, message). */
export async function sweepCaseRelays(options: { limit?: number; deps?: CaseBoundaryDeps } = {}) {
  const deps = options.deps ?? {};
  if (!savCaseRecordingEnabled(deps.env)) return { skipped: "recording_off" as const };
  const db = requireDb();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const noEvent = (caseId: unknown) => sql`not exists (select 1 from sav.case_events ev where ev.case_id = ${caseId} and ev.dedupe_key = 'inbound:' || ${savMessages.gmailMessageId})`;
  const confirmed = await db.select({ id: savIntakeExecutions.messageId }).from(savIntakeExecutions)
    .innerJoin(savMessages, eq(savMessages.id, savIntakeExecutions.messageId)).leftJoin(savCases, eq(savCases.ticketId, savIntakeExecutions.ticketId))
    .where(and(eq(savIntakeExecutions.state, "confirmed"), isNotNull(savIntakeExecutions.ticketId), eq(savMessages.direction, "inbound"), isNotNull(savMessages.gmailMessageId),
      sql`(${savCases.id} is null or ${noEvent(savCases.id)})`))
    .orderBy(asc(savIntakeExecutions.updatedAt), asc(savIntakeExecutions.id)).limit(limit);
  const acknowledgements = await db.select({ id: savMessages.id }).from(savMessages).innerJoin(savCases, sql`${savMessages.threadId} = any(${savCases.threadIds})`)
    .where(and(eq(savMessages.direction, "inbound"), isNotNull(savMessages.gmailMessageId), noEvent(savCases.id),
      sql`not exists (select 1 from sav.intake_executions e where e.message_id = ${savMessages.id} and e.ticket_id is not null)`,
      sql`exists (select 1 from sav.intake_runs r where r.message_id = ${savMessages.id} and r.state = 'observed')`,
      sql`${savMessages.receivedAt} >= (select min(ev.occurred_at) from sav.case_events ev where ev.case_id = ${savCases.id} and ev.kind = 'inbound_confirmed')`))
    .orderBy(asc(savMessages.receivedAt), asc(savMessages.id)).limit(limit);
  const outcome = { relayed: 0, unchanged: 0, recovered: 0, skipped: {} as Record<string, number>, failed: {} as Record<string, number> };
  for (const id of [...new Set([...confirmed, ...acknowledgements].map(row => row.id))]) {
    // One mail that cannot be relayed now (owner unread, qualification down, a pause set during it) must not
    // stop the others: it is counted by code and tried again on the next pass.
    let result: CaseRelayResult;
    try { result = await recordCaseAfterConfirmedIntake(id, deps); } catch (error) {
      const code = error instanceof Error && /^SAV_[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "unexpected";
      outcome.failed[code] = (outcome.failed[code] ?? 0) + 1;
      continue;
    }
    if ("skipped" in result) outcome.skipped[result.skipped] = (outcome.skipped[result.skipped] ?? 0) + 1;
    else if (result.appended) outcome.relayed++;
    else outcome.unchanged++;
  }
  // Ugo (4/11): a case already relayed that still waits for its owner (a read that failed, a pause, the owner set since). Its last V1-confirmed mail is relayed again: the store
  // appends no event and opens no request, the mail is not sent anywhere, and only the V2 owner read now moves the case. Without the reader, nothing is read and nothing moves.
  if (deps.readCreatedTicketOwner && v2HubspotOwnerId(deps.env) && !await relayPaused(db)) {
    // Random: a queue of cases a person holds must not starve the others behind a fixed order.
    const waiting = await db.select({ ticketId: savCases.ticketId }).from(savCases)
      .where(and(eq(savCases.owner, "human"), eq(savCases.phase, "handoff_pending"), eq(savCases.admissionTarget, "agent"))).orderBy(sql`random()`).limit(limit);
    for (const { ticketId } of waiting) {
      const current = await readCaseByTicket(ticketId);
      if (!current || !caseAwaitsV2Attribution(current)) continue;
      const messageId = (await listCaseEvents(current.caseId)).flatMap(event => {
        const relay = event.kind === "inbound_confirmed" ? (event.detail as { relay?: CaseRelayProof } | undefined)?.relay : undefined;
        return relay?.kind === "intake_effects_confirmed" ? [relay.messageId] : [];
      }).at(-1);
      if (!messageId) continue;
      try {
        const result = await recordCaseAfterConfirmedIntake(messageId, deps);
        if ("owner" in result && result.owner === "agent") outcome.recovered++;
      } catch (error) {
        const code = error instanceof Error && /^SAV_[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "unexpected";
        outcome.failed[code] = (outcome.failed[code] ?? 0) + 1;
      }
    }
  }
  return outcome;
}
