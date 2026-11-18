// SAV-95 (18/11, OFF by default): the effect. After V1 classified a customer mail as an acknowledgement and the model judged a confident close
// (`ack-closure-rules.ts`), move the thread's Support ticket to « Fermé » and add ONE short note. No customer email, no owner change, nothing else.
// Protocol (receipts are durable rows, one per step and message; the DB store is `ack-closure-store.ts`):
//   claimed → (GET ticket, PATCH stage, GET read-back) → stage_confirmed → note_dispatched (claimed once, atomically) → POST note → GET read-back → confirmed
//   Final receipts: confirmed | already_closed | not_applied | uncertain. A final receipt ends the message for good (no second stage, no second note).
// The stage write is idempotent by value (writing « Fermé » twice changes nothing), so it may be retried until read back. The note is not: once
// `note_dispatched` exists it is never posted again; an unknown outcome becomes `uncertain` for a person. Switch, pause and authority are re-checked
// right before the stage write.
import { decideAckClosure, savAckClosureEnabled, SAV_ACK_CLOSURE_NOTE, SAV_ACK_CLOSURE_REVISION, type AckClosureBasis, type AckClosureFacts } from "./ack-closure-rules";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";

export type AckClosureStep = "claimed" | "stage_confirmed" | "note_dispatched" | "confirmed" | "already_closed" | "not_applied" | "uncertain";
export const ACK_CLOSURE_FINAL_STEPS: readonly AckClosureStep[] = ["confirmed", "already_closed", "not_applied", "uncertain"];
export type AckClosureMetadata = Record<string, string | number | boolean | null>;

export type AckClosureStore = Readonly<{
  /** The steps already recorded for this message. */
  steps(messageId: string): Promise<AckClosureStep[]>;
  /** Records the step once: true when this call recorded it, false when it already existed (atomic per message and step). */
  record(messageId: string, step: AckClosureStep, metadata: AckClosureMetadata): Promise<boolean>;
}>;
export type AckClosureTicket = Readonly<{ pipeline: string | null; stage: string | null }>;
export type AckClosureHubspot = Readonly<{
  readTicket(ticketId: string, signal: AbortSignal): Promise<AckClosureTicket | null>;
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
  | Readonly<{ skipped: "off" | "authority" | "already_done" | "facts_missing" | "note_in_progress"; detail?: string }>
  | Readonly<{ retry: "ticket_unreadable" | "stage_unconfirmed" | "authority_changed" }>
  | Readonly<{ final: Exclude<AckClosureStep, "claimed" | "stage_confirmed" | "note_dispatched">; reason?: string; basis?: AckClosureBasis; noteId?: string }>;

const NOTE_BODY = `<p>${SAV_ACK_CLOSURE_NOTE}</p>`;
const OPEN_STAGES = new Set<string>([SAV_HUBSPOT_SUPPORT.stages.new, SAV_HUBSPOT_SUPPORT.stages.awaitingContact, SAV_HUBSPOT_SUPPORT.stages.awaitingTeam]);
const codeOf = (error: unknown) => error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_ACK_CLOSE_FAILED";
const plainNote = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** One message, idempotent. Never sends an email; never throws for a refusal (a named result instead). */
export async function closeAcknowledgedTicket(messageId: string, deps: AckClosureDeps): Promise<AckClosureResult> {
  const signal = deps.signal ?? new AbortController().signal, now = deps.now ?? (() => new Date());
  if (!savAckClosureEnabled(deps.env())) return { skipped: "off" };
  try { await deps.authority(); } catch (error) { return { skipped: "authority", detail: codeOf(error) }; }
  const steps = await deps.store.steps(messageId);
  if (steps.some(step => ACK_CLOSURE_FINAL_STEPS.includes(step))) return { skipped: "already_done" };
  const final = async (step: "confirmed" | "already_closed" | "not_applied" | "uncertain", metadata: AckClosureMetadata) => {
    await deps.store.record(messageId, step, { revision: SAV_ACK_CLOSURE_REVISION, ...metadata });
    return { final: step, ...(typeof metadata.reason === "string" ? { reason: metadata.reason } : {}), ...(typeof metadata.basis === "string" ? { basis: metadata.basis as AckClosureBasis } : {}),
      ...(typeof metadata.noteId === "string" ? { noteId: metadata.noteId } : {}) } as const;
  };
  // A note whose POST may have happened is never posted again: a person checks it.
  if (steps.includes("note_dispatched")) return final("uncertain", { reason: "note_outcome_unknown" });
  const facts = await deps.readFacts(messageId);
  if (!facts) return { skipped: "facts_missing" };
  const decision = decideAckClosure(facts);
  // A refusal is final for this mail only when nothing was written yet; after a claim the stage may already be « Fermé » and stays for a person to see.
  if (!decision.close) return final(steps.includes("stage_confirmed") ? "uncertain" : "not_applied", { reason: decision.reason, ...(steps.includes("stage_confirmed") ? { stageClosed: true } : {}) });
  const { ticketId, basis } = decision;
  await deps.store.record(messageId, "claimed", { revision: SAV_ACK_CLOSURE_REVISION, ticketId, basis });

  if (!steps.includes("stage_confirmed")) {
    const ticket = await deps.hubspot.readTicket(ticketId, signal).catch(() => null);
    if (!ticket) return { retry: "ticket_unreadable" };
    if (ticket.pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId) return final("not_applied", { reason: "pipeline_not_support", ticketId, basis });
    // Closed by someone else: nothing to add, no note.
    if (ticket.stage === SAV_HUBSPOT_SUPPORT.stages.closed) return final("already_closed", { ticketId, basis });
    if (!ticket.stage || !OPEN_STAGES.has(ticket.stage)) return final("not_applied", { reason: "stage_unexpected", ticketId, basis });
    // The last look before the only stage write: switch, pause and authority still hold.
    if (!savAckClosureEnabled(deps.env())) return { skipped: "off" };
    try { await deps.authority(); } catch { return { retry: "authority_changed" }; }
    const written = await deps.hubspot.setClosed(ticketId, signal).catch(() => "unknown" as const);
    if (written === "rejected") return final("not_applied", { reason: "stage_rejected", ticketId, basis });
    const back = await deps.hubspot.readTicket(ticketId, signal).catch(() => null);
    if (back?.pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId || back.stage !== SAV_HUBSPOT_SUPPORT.stages.closed) return { retry: "stage_unconfirmed" };
    await deps.store.record(messageId, "stage_confirmed", { revision: SAV_ACK_CLOSURE_REVISION, ticketId, basis, stage: back.stage });
  }

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
      const body = response.status === 200 ? await json(response) : null;
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
