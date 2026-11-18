// SAV-95 (18/11, OFF by default): the effect. After V1 classified a customer mail as an acknowledgement and the model judged a confident close
// (`ack-closure-rules.ts`), move the thread's Support ticket to « Fermé » and add ONE short note. No customer email, no owner change, nothing else.
// Protocol (receipts are durable rows, one per step and message; the DB store is `ack-closure-store.ts`):
//   claimed → GET ticket → facts re-read → stage_dispatched → PATCH stage → GET read-back → stage_confirmed → note_dispatched (claimed once) → POST note → GET read-back → confirmed
//   Final receipts: confirmed | already_closed | not_applied | uncertain. A final receipt ends the message for good (no second stage, no second note).
// The stage write is idempotent by value (writing « Fermé » twice changes nothing), so it may be retried until read back. The note is not: once
// `note_dispatched` exists it is never posted again; an unknown outcome becomes `uncertain` for a person. Switch, pause and authority are re-checked
// right before the stage write, and the facts (newer mail on the thread or the ticket, a V2 case on the ticket) are read again just before it.
// Review Astra (8c2891d, finding 3): `stage_dispatched` is recorded BEFORE the PATCH, so a later pass that finds the ticket closed knows the close may be
// ours and continues to the note (exactly once); « already closed » is only a ticket we never wrote.
import { decideAckClosure, savAckClosureEnabled, SAV_ACK_CLOSURE_NOTE, SAV_ACK_CLOSURE_REVISION, type AckClosureBasis, type AckClosureFacts } from "./ack-closure-rules";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";

export type AckClosureStep = "claimed" | "stage_dispatched" | "stage_confirmed" | "note_dispatched" | "confirmed" | "already_closed" | "not_applied" | "uncertain";
export const ACK_CLOSURE_FINAL_STEPS: readonly AckClosureStep[] = ["confirmed", "already_closed", "not_applied", "uncertain"];
export type AckClosureMetadata = Record<string, string | number | boolean | null>;

export type AckClosureStore = Readonly<{
  /** The steps already recorded for this message. */
  steps(messageId: string): Promise<AckClosureStep[]>;
  /** Records the step once: true when this call recorded it, false when it already existed (atomic per message and step). */
  record(messageId: string, step: AckClosureStep, metadata: AckClosureMetadata): Promise<boolean>;
  /** Review Astra (c4316e8, finding 2): ONE pass owns a message from reading its receipts to its note. Null: another pass holds it. The returned
   * function releases it. A lease outlives a crashed pass only for its bounded duration. */
  lease(messageId: string): Promise<(() => Promise<void>) | null>;
  /** The metadata recorded with a step (review Astra, 0ac3311: the ticket a dispatch acted on), or null. */
  receipt(messageId: string, step: AckClosureStep): Promise<AckClosureMetadata | null>;
  /** Records one more failed attempt (a row per attempt) and returns how many this message has had, this one included. */
  attempt(messageId: string, metadata: AckClosureMetadata): Promise<number>;
}>;
export type AckClosureTicket = Readonly<{ pipeline: string | null; stage: string | null }>;
export type AckClosureHubspot = Readonly<{
  /** `gone`: HubSpot answered 404 (deleted, or archived since only live tickets are read). Null: unreadable for any other reason. */
  readTicket(ticketId: string, signal: AbortSignal): Promise<AckClosureTicket | "gone" | null>;
  /** PATCH of the stage only. `rejected`: HubSpot refused it before applying; `unknown`: it may have applied (only a read-back decides). */
  setClosed(ticketId: string, signal: AbortSignal): Promise<"applied" | "rejected" | "unknown">;
  /** POST of the note, associated to the ticket in the same call. Throws when the outcome is unknown. */
  createNote(ticketId: string, body: string, timestamp: string, signal: AbortSignal): Promise<string>;
  readNote(noteId: string, signal: AbortSignal): Promise<{ body: string; ticketIds: string[] } | null>;
}>;
export type AckClosureDeps = Readonly<{
  env: () => Record<string, string | undefined>;
  /** Throws when V1's execution authority is not valid, lacks the closure right, or the agent is paused. */
  authority: () => Promise<void>;
  readFacts: (messageId: string) => Promise<AckClosureFacts | null>;
  store: AckClosureStore;
  hubspot: AckClosureHubspot;
  now?: () => Date;
  signal?: AbortSignal;
}>;
export type AckClosureResult =
  | Readonly<{ skipped: "off" | "authority" | "already_done" | "facts_missing" | "note_in_progress" | "not_acknowledgement" | "busy"; detail?: string }>
  | Readonly<{ retry: "ticket_unreadable" | "stage_unconfirmed" | "authority_changed" }>
  | Readonly<{ final: Exclude<AckClosureStep, "claimed" | "stage_confirmed" | "note_dispatched">; reason?: string; basis?: AckClosureBasis; noteId?: string }>;

const NOTE_BODY = `<p>${SAV_ACK_CLOSURE_NOTE}</p>`;
/** Failed attempts after which a message ends `uncertain` (after a dispatch) or `not_applied` (before), so it can never hold a sweep slot forever. */
export const ACK_CLOSURE_MAX_ATTEMPTS = 5;
const OPEN_STAGES = new Set<string>([SAV_HUBSPOT_SUPPORT.stages.new, SAV_HUBSPOT_SUPPORT.stages.awaitingContact, SAV_HUBSPOT_SUPPORT.stages.awaitingTeam]);
const codeOf = (error: unknown) => error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_ACK_CLOSE_FAILED";
const plainNote = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** One message, idempotent. Never sends an email; never throws for a refusal (a named result instead). */
export async function closeAcknowledgedTicket(messageId: string, deps: AckClosureDeps): Promise<AckClosureResult> {
  const signal = deps.signal ?? new AbortController().signal, now = deps.now ?? (() => new Date());
  if (!savAckClosureEnabled(deps.env())) return { skipped: "off" };
  try { await deps.authority(); } catch (error) { return { skipped: "authority", detail: codeOf(error) }; }
  const release = await deps.store.lease(messageId);
  if (!release) return { skipped: "busy" };
  try { return await closeOwned(messageId, deps, signal, now); } finally { await release().catch(() => undefined); }
}

async function closeOwned(messageId: string, deps: AckClosureDeps, signal: AbortSignal, now: () => Date): Promise<AckClosureResult> {
  // Read under the lease: no other pass can be between its receipts and its note.
  const steps = await deps.store.steps(messageId);
  if (steps.some(step => ACK_CLOSURE_FINAL_STEPS.includes(step))) return { skipped: "already_done" };
  const final = async (step: "confirmed" | "already_closed" | "not_applied" | "uncertain", metadata: AckClosureMetadata) => {
    await deps.store.record(messageId, step, { revision: SAV_ACK_CLOSURE_REVISION, ...metadata });
    return { final: step, ...(typeof metadata.reason === "string" ? { reason: metadata.reason } : {}), ...(typeof metadata.basis === "string" ? { basis: metadata.basis as AckClosureBasis } : {}),
      ...(typeof metadata.noteId === "string" ? { noteId: metadata.noteId } : {}) } as const;
  };
  // A note whose POST may have happened is never posted again: a person checks it.
  if (steps.includes("note_dispatched")) return final("uncertain", { reason: "note_outcome_unknown" });
  const touched = steps.includes("stage_confirmed") || steps.includes("stage_dispatched");
  const read = async (id: string) => { try { return await deps.hubspot.readTicket(id, signal); } catch { return null; } };
  /** An unreadable ticket: one more attempt, bounded; the last one ends the message for a person (after a dispatch) or for good (before). */
  const unreadable = async (ticketId: string, basis: string | null, stage: "ticket_unreadable"): Promise<AckClosureResult> => {
    const count = await deps.store.attempt(messageId, { ticketId, reason: stage });
    if (count < ACK_CLOSURE_MAX_ATTEMPTS) return { retry: stage };
    return touched
      ? final("uncertain", { reason: `${stage}_attempts`, attempts: count, stageMayBeClosed: true, ticketId, basis })
      : final("not_applied", { reason: `${stage}_attempts`, attempts: count, ticketId, basis });
  };
  const facts = await deps.readFacts(messageId);

  if (touched) {
    // RESUME after our own dispatch (review Astra, 0ac3311, finding 1): ONLY the ticket the dispatch acted on, as recorded with it. A thread relinked
    // to another ticket since is never touched; the recorded ticket is finished or handed to a person.
    const dispatch = await deps.store.receipt(messageId, "stage_dispatched") ?? await deps.store.receipt(messageId, "stage_confirmed");
    const ticketId = typeof dispatch?.ticketId === "string" && /^[0-9]{1,30}$/.test(dispatch.ticketId) ? dispatch.ticketId : null;
    const basis = (typeof dispatch?.basis === "string" ? dispatch.basis : null) as AckClosureBasis | null;
    if (!ticketId) return final("uncertain", { reason: "dispatch_ticket_unknown", stageMayBeClosed: true });
    const relinked: AckClosureMetadata = facts?.ticketId && facts.ticketId !== ticketId ? { currentTicketId: facts.ticketId } : {};
    if (!facts) return final("uncertain", { reason: "facts_missing", stageMayBeClosed: true, ticketId });
    // The rule on today's facts, judged for the recorded ticket.
    const decision = decideAckClosure({ ...facts, ticketId });
    if (!decision.close) {
      const seen = await read(ticketId);
      return final("uncertain", { reason: decision.reason, stageMayBeClosed: true, stageObserved: seen && seen !== "gone" ? seen.stage : seen, ticketId, ...relinked });
    }
    if (!steps.includes("stage_confirmed")) {
      const ticket = await read(ticketId);
      // A deleted or archived ticket ends the resume for a person (review Astra, 0ac3311, finding 2); any other failure is retried, bounded.
      if (ticket === "gone") return final("uncertain", { reason: "ticket_gone", stageMayBeClosed: true, ticketId, ...relinked });
      if (!ticket) return unreadable(ticketId, basis, "ticket_unreadable");
      // A resume NEVER writes the stage again (review Astra, 23f8c4e): it only finishes a closure it can see. Not « Fermé » in Support (reopened by
      // someone, or our PATCH never landed): a person decides, no PATCH, no note.
      if (ticket.pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId || ticket.stage !== SAV_HUBSPOT_SUPPORT.stages.closed)
        return final("uncertain", { reason: "dispatched_stage_not_observed", stageMayBeClosed: false, stageObserved: ticket.stage, pipelineObserved: ticket.pipeline, ticketId, ...relinked });
      await deps.store.record(messageId, "stage_confirmed", { revision: SAV_ACK_CLOSURE_REVISION, ticketId, basis, stage: SAV_HUBSPOT_SUPPORT.stages.closed, resumed: true, ...relinked });
    }
    return postNote(messageId, deps, signal, now, final, ticketId, basis);
  }

  // Nothing written yet: missing facts just mean nothing to do (after a dispatch, the resume above ends it for a person instead).
  if (!facts) return { skipped: "facts_missing" };
  const decision = decideAckClosure(facts);
  // The wake runs after every V1 mail: a mail V1 did not classify as an acknowledgement leaves no row at all.
  if (!decision.close && decision.reason === "v1_not_acknowledgement" && !steps.length) return { skipped: "not_acknowledgement" };
  if (!decision.close) return final("not_applied", { reason: decision.reason });
  const { ticketId, basis } = decision;
  await deps.store.record(messageId, "claimed", { revision: SAV_ACK_CLOSURE_REVISION, ticketId, basis });
  const ticket = await read(ticketId);
  // Before any write: a deleted or archived ticket is simply not closed; any other failure is retried, bounded.
  if (ticket === "gone") return final("not_applied", { reason: "ticket_gone", ticketId, basis });
  if (!ticket) return unreadable(ticketId, basis, "ticket_unreadable");
  if (ticket.pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId) return final("not_applied", { reason: "pipeline_not_support", ticketId, basis });
  if (ticket.stage === SAV_HUBSPOT_SUPPORT.stages.closed) {
    // Closed and we never wrote: closed by someone else, nothing to add. Receipts read again first: a dispatch recorded by another pass is ours.
    if (!(await deps.store.steps(messageId)).includes("stage_dispatched")) return final("already_closed", { ticketId, basis });
    return { retry: "stage_unconfirmed" };
  }
  if (!ticket.stage || !OPEN_STAGES.has(ticket.stage)) return final("not_applied", { reason: "stage_unexpected", ticketId, basis });
  // The last look before the only stage write: switch, pause and authority still hold...
  if (!savAckClosureEnabled(deps.env())) return { skipped: "off" };
  try { await deps.authority(); } catch { return { retry: "authority_changed" }; }
  // ...and the facts read again (review Astra, 8c2891d, findings 1 and 2): a mail stored on the thread or on the ticket since the first read, or a V2
  // case attached to the ticket meanwhile, stops the write. HubSpot has no conditional write: the remaining window is this re-read to the PATCH.
  const again = await deps.readFacts(messageId);
  const recheck = again ? decideAckClosure(again) : null;
  if (!recheck?.close || recheck.ticketId !== ticketId)
    return final("not_applied", { reason: `recheck_${recheck && !recheck.close ? recheck.reason : "facts_changed"}`, ticketId, basis });
  // The ticket acted on is recorded WITH the dispatch: a resume only ever finishes this one.
  await deps.store.record(messageId, "stage_dispatched", { revision: SAV_ACK_CLOSURE_REVISION, ticketId, basis, previousStage: ticket.stage });
  const written = await deps.hubspot.setClosed(ticketId, signal).catch(() => "unknown" as const);
  if (written === "rejected") return final("not_applied", { reason: "stage_rejected", ticketId, basis });
  const back = await read(ticketId);
  // Not read back: the next pass resumes on the recorded ticket and, closed, continues to the note.
  if (back === "gone" || back?.pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId || back.stage !== SAV_HUBSPOT_SUPPORT.stages.closed) return { retry: "stage_unconfirmed" };
  await deps.store.record(messageId, "stage_confirmed", { revision: SAV_ACK_CLOSURE_REVISION, ticketId, basis, stage: back.stage });
  return postNote(messageId, deps, signal, now, final, ticketId, basis);
}

type Final = (step: "confirmed" | "already_closed" | "not_applied" | "uncertain", metadata: AckClosureMetadata) => Promise<AckClosureResult>;
async function postNote(messageId: string, deps: AckClosureDeps, signal: AbortSignal, now: () => Date, final: Final, ticketId: string, basis: AckClosureBasis | null): Promise<AckClosureResult> {
  // The note: claimed once, so a concurrent or repeated pass can never post a second one.
  if (!await deps.store.record(messageId, "note_dispatched", { revision: SAV_ACK_CLOSURE_REVISION, ticketId })) return { skipped: "note_in_progress" };
  let noteId: string;
  try { noteId = await deps.hubspot.createNote(ticketId, NOTE_BODY, now().toISOString(), signal); }
  catch (error) { return final("uncertain", { reason: "note_outcome_unknown", ticketId, basis, stageClosed: true, errorCode: codeOf(error) }); }
  const note = await deps.hubspot.readNote(noteId, signal).catch(() => null);
  if (!note || plainNote(note.body) !== SAV_ACK_CLOSURE_NOTE || !note.ticketIds.includes(ticketId))
    return final("uncertain", { reason: "note_unverified", ticketId, basis, stageClosed: true, noteId });
  return final("confirmed", { ticketId, basis, stage: SAV_HUBSPOT_SUPPORT.stages.closed, noteId });
}

const API = "https://api.hubapi.com";
const TICKET = /^[0-9]{1,30}$/;
const REJECTED = new Set([400, 401, 403, 404, 409, 422, 429]);
const NOTE_TO_TICKET = 228;
/** The only requests this effect may make. */
export function isAckClosureRequest(path: string, method: string): boolean {
  return ((method === "GET" || method === "PATCH") && /^\/crm\/v3\/objects\/tickets\/[0-9]{1,30}$/.test(path))
    || (method === "POST" && path === "/crm/v3/objects/notes") || (method === "GET" && /^\/crm\/v3\/objects\/notes\/[0-9]{1,30}$/.test(path));
}

/** HubSpot side: stage of the Support ticket and one note, nothing else. The token comes from the injected environment and appears nowhere else. */
export function createAckClosureHubspot(deps: Readonly<{ network: typeof fetch; env: () => Record<string, string | undefined> }>): AckClosureHubspot {
  async function call(method: "GET" | "PATCH" | "POST", path: string, signal: AbortSignal, body?: unknown, query: Record<string, string> = {}) {
    if (!isAckClosureRequest(path, method)) throw Error("SAV_ACK_CLOSE_REQUEST_FORBIDDEN");
    const token = deps.env().HUBSPOT_ACCESS_TOKEN;
    if (!token) throw Error("SAV_ACK_CLOSE_TOKEN_MISSING");
    const url = new URL(path, API);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return deps.network(url.toString(), { method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  const json = async (response: Response) => {
    try { const value = await response.json() as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
  };
  const text = (value: unknown) => typeof value === "string" && value ? value : null;
  return {
    async readTicket(ticketId, signal) {
      if (!TICKET.test(ticketId)) return null;
      const response = await call("GET", `/crm/v3/objects/tickets/${ticketId}`, signal, undefined, { properties: "hs_pipeline,hs_pipeline_stage", archived: "false" });
      // 404 on a live-only read: deleted, merged away or archived. A definite answer, unlike a 5xx, a 429 or a timeout.
      if (response.status === 404) return "gone";
      const body = response.status === 200 ? await json(response) : null;
      if (body?.archived === true) return "gone";
      const properties = body?.properties as Record<string, unknown> | undefined;
      return body && body.id === ticketId && properties ? { pipeline: text(properties.hs_pipeline), stage: text(properties.hs_pipeline_stage) } : null;
    },
    async setClosed(ticketId, signal) {
      if (!TICKET.test(ticketId)) return "rejected";
      const response = await call("PATCH", `/crm/v3/objects/tickets/${ticketId}`, signal, { properties: { hs_pipeline_stage: SAV_HUBSPOT_SUPPORT.stages.closed } });
      if (REJECTED.has(response.status)) return "rejected";
      const body = response.status === 200 ? await json(response) : null;
      return body?.id === ticketId ? "applied" : "unknown";
    },
    async createNote(ticketId, body, timestamp, signal) {
      const response = await call("POST", "/crm/v3/objects/notes", signal, { properties: { hs_note_body: body, hs_timestamp: timestamp },
        associations: [{ to: { id: ticketId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_TICKET }] }] });
      const created = response.status === 201 || response.status === 200 ? await json(response) : null;
      const id = typeof created?.id === "string" && /^[0-9]{1,30}$/.test(created.id) ? created.id : null;
      if (!id) throw Error("SAV_ACK_CLOSE_NOTE_RESULT_UNKNOWN");
      return id;
    },
    async readNote(noteId, signal) {
      const response = await call("GET", `/crm/v3/objects/notes/${noteId}`, signal, undefined, { properties: "hs_note_body", associations: "tickets" });
      const body = response.status === 200 ? await json(response) : null;
      const noteBody = text((body?.properties as Record<string, unknown> | undefined)?.hs_note_body);
      if (!body || body.id !== noteId || !noteBody) return null;
      const results = ((body.associations as Record<string, { results?: unknown }> | undefined)?.tickets?.results);
      const ticketIds = Array.isArray(results) ? results.map(row => String((row as { id?: unknown; toObjectId?: unknown }).id ?? (row as { toObjectId?: unknown }).toObjectId ?? "")) : [];
      return { body: noteBody, ticketIds };
    },
  };
}
