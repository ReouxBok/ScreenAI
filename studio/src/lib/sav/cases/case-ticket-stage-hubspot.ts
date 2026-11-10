// V2 ticket states (local, OFF): the HubSpot side of the `ticket_stage` effect on the existing executor protocol. `dispatch` is the ONE write (PATCH of the ticket's
// pipeline stage, nothing else); `verify` is read-only (GET of the same ticket). The protocol around them (marker before the call, no second call from dispatched / acked /
// uncertain, verification only, five reads then a person) is `intake/executor.ts` + `intake/execution-store.ts`, not reimplemented here.
// Before writing, the ticket is read once: a ticket that left the V2 owner, or that is closed (for a « waiting » target), is NOT written (a named refusal that left nothing
// behind). HubSpot offers no conditional write, so the read-then-write gap is the residual limit, declared in the report. Anything unclear AFTER the PATCH may have applied:
// it stays uncertain and is only verified. The token comes from the injected environment and appears nowhere else.
import type { EffectAck, EffectIntent, ExecutorAdapters } from "../intake/execution-types";
import { readCaseTicketStageConfig, verifyCaseTicketStage, type CaseTicketStageIntent } from "./customer-return";
import { ticketStageTarget } from "./case-ticket-stage";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";

const API = "https://api.hubapi.com";
const TIMEOUT_MS = 10_000;
const TICKET = /^[0-9]{1,30}$/;
/** Prefix of the typed refusal the driver recognises to take the effect back to `planned` (the proven no-send transition). */
export const TICKET_STAGE_NOT_APPLIED_PREFIX = "SAV_TICKET_STAGE_NOT_APPLIED_";
/** HTTP answers of HubSpot that mean the stage was not written (rejected before applying). Anything else after the PATCH may have applied. */
const REJECTED = new Set([400, 401, 403, 404, 409, 422, 429]);

export type CaseTicketStageDeps = Readonly<{ network: typeof fetch; env: () => Record<string, string | undefined> }>;
const fault = (code: string): never => { throw new Error(code); };

/** The only requests this module may make. */
export function isTicketStageRequest(path: string, method: string): boolean {
  return (method === "GET" || method === "PATCH") && /^\/crm\/v3\/objects\/tickets\/[0-9]{1,30}$/.test(path);
}

export function createCaseTicketStageAdapters(deps: CaseTicketStageDeps): Pick<ExecutorAdapters, "dispatch" | "verify"> {
  async function call(method: "GET" | "PATCH", ticketId: string, signal: AbortSignal, body?: unknown, query: Record<string, string> = {}): Promise<Response> {
    const path = `/crm/v3/objects/tickets/${ticketId}`;
    if (!TICKET.test(ticketId) || !isTicketStageRequest(path, method)) return fault("SAV_TICKET_STAGE_REQUEST_FORBIDDEN");
    const token = deps.env().HUBSPOT_ACCESS_TOKEN;
    if (!token) return fault("SAV_TICKET_STAGE_TOKEN_MISSING");
    const url = new URL(path, API);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return deps.network(url.toString(), {
      method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function json(response: Response): Promise<Record<string, unknown> | null> {
    try { const value = await response.json() as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
  }
  const PROPERTIES = { properties: "hs_pipeline,hs_pipeline_stage,hubspot_owner_id", archived: "false" };
  async function readTicket(ticketId: string, signal: AbortSignal) {
    const response = await call("GET", ticketId, signal, undefined, PROPERTIES);
    const body = response.status === 200 ? await json(response) : null;
    const properties = body?.properties as Record<string, unknown> | undefined;
    if (!body || body.id !== ticketId || !properties) return null;
    const text = (value: unknown) => typeof value === "string" && value ? value : null;
    return { pipeline: text(properties.hs_pipeline), stage: text(properties.hs_pipeline_stage), ownerId: text(properties.hubspot_owner_id) };
  }
  const plan = (intent: EffectIntent): CaseTicketStageIntent | null => {
    const target = ticketStageTarget(intent), stageId = intent.properties?.hs_pipeline_stage;
    return target && typeof intent.ticketId === "string" && typeof stageId === "string" && typeof intent.sourceMessageId === "string"
      ? { key: intent.key, target, stageId, ticketId: intent.ticketId, caseId: intent.sourceMessageId } : null;
  };

  return {
    async dispatch(intent: EffectIntent, signal: AbortSignal): Promise<EffectAck> {
      const stage = intent.kind === "ticket_stage" ? plan(intent) : null;
      if (!stage || typeof intent.expectedOwnerId !== "string") return fault("SAV_TICKET_STAGE_INTENT_INVALID");
      const config = readCaseTicketStageConfig(deps.env());
      if (config.mode !== "on") return fault(`${TICKET_STAGE_NOT_APPLIED_PREFIX}STAGES_OFF`);
      // The stage sealed in the intent must still be the one the configuration names for this target: a configuration changed since the plan writes nothing.
      if (stage.stageId !== (stage.target === "waiting_customer" ? config.waitingCustomer : config.closed)) return fault(`${TICKET_STAGE_NOT_APPLIED_PREFIX}STAGE_CONFIG_CHANGED`);
      // The last look at the ticket itself, before the only write.
      let current: Awaited<ReturnType<typeof readTicket>>;
      try { current = await readTicket(stage.ticketId, signal); } catch (error) { if (error instanceof Error && error.message === "SAV_TICKET_STAGE_TOKEN_MISSING") throw error; current = null; }
      if (!current) return fault(`${TICKET_STAGE_NOT_APPLIED_PREFIX}TICKET_UNREADABLE`);
      // Only a ticket of the Support pipeline is ever moved: a ticket of another pipeline (commercial...) owned by the same V2 owner gets no write.
      if (current.pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId) return fault(`${TICKET_STAGE_NOT_APPLIED_PREFIX}PIPELINE_NOT_SUPPORT`);
      if (current.ownerId !== intent.expectedOwnerId) return fault(`${TICKET_STAGE_NOT_APPLIED_PREFIX}OWNER_CHANGED`);
      if (stage.target === "waiting_customer" && current.stage === config.closed) return fault(`${TICKET_STAGE_NOT_APPLIED_PREFIX}TICKET_CLOSED`);
      let response: Response;
      try {
        response = await call("PATCH", stage.ticketId, signal, { properties: { hs_pipeline_stage: stage.stageId } });
      } catch (error) {
        if (error instanceof Error && error.message === "SAV_TICKET_STAGE_TOKEN_MISSING") throw error;
        return fault("SAV_TICKET_STAGE_RESULT_UNKNOWN");
      }
      if (REJECTED.has(response.status)) return fault(`${TICKET_STAGE_NOT_APPLIED_PREFIX}HTTP_${response.status}`);
      const body = response.status === 200 ? await json(response) : null;
      if (!body || body.id !== stage.ticketId) return fault("SAV_TICKET_STAGE_RESULT_UNKNOWN");
      return { id: stage.ticketId };
    },

    async verify(intent: EffectIntent, _ack: EffectAck | null, _dispatchedAt: Date, signal: AbortSignal) {
      const stage = intent.kind === "ticket_stage" ? plan(intent) : null;
      if (!stage || typeof intent.expectedOwnerId !== "string") return fault("SAV_TICKET_STAGE_INTENT_INVALID");
      const row = await readTicket(stage.ticketId, signal);
      if (!row) return fault("SAV_TICKET_STAGE_VERIFY_UNAVAILABLE");
      // The stage asked AND the V2 owner kept: the rule of pole A. The state itself is the proof (a stage is not a unique mark), so « attributed » follows « confirmed ».
      const verdict = verifyCaseTicketStage(stage, { stage: row.stage, ownerId: row.ownerId }, intent.expectedOwnerId);
      if (verdict === "unreadable") return fault("SAV_TICKET_STAGE_VERIFY_UNAVAILABLE");
      const confirmed = verdict === "confirmed" && row.pipeline === SAV_HUBSPOT_SUPPORT.pipelineId;
      return { confirmed, attributed: confirmed, ...(confirmed ? { ack: { id: stage.ticketId } } : {}) };
    },
  };
}
