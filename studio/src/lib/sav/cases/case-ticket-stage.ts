// V2 ticket states (local, OFF): the PURE part that turns A's rules (`customer-return.ts`: plan, gate, verification) into an effect of the EXISTING executor.
//   « waiting for the customer »  after a CONFIRMED V2 reply        key `case-stage:<case>:waiting_customer:<reply key>`
//   « closed »                    after a PROVEN resolution          key `case-stage:<case>:closed:cycle-<n>`
// Nothing here reads, writes or sends. The write is the ticket's pipeline stage and nothing else (never the owner, never a property of the customer's data).
import type { EffectIntent } from "../intake/execution-types";
import { SAV_CASE_EFFECT_PERMISSIONS } from "./case-effects";
import type { CaseTicketStageIntent, CaseTicketStageTarget } from "./customer-return";

export const TICKET_STAGE_KEY_PREFIX = "case-stage:";
export const TICKET_STAGE_CONTRACT = "sav-v2-ticket-stage.v1";

/** What an execution of this kind seals: the plan A's rule produced and what triggered it. The owner id is NOT in it (it is read from the injected configuration when acting). */
export type TicketStagePayload = Readonly<{
  contract: typeof TICKET_STAGE_CONTRACT;
  intent: CaseTicketStageIntent;
  trigger: Readonly<{ kind: "reply_confirmed"; replyKey: string; sentAt: string }> | Readonly<{ kind: "resolution_recorded"; cycle: number }>;
}>;

const fault = (code: string): never => { throw new Error(`SAV_TICKET_STAGE_${code}`); };
const TICKET = /^[0-9]{1,30}$/;
const OWNER = /^[0-9]{1,20}$/;

/**
 * The executor intent: the stage to reach and the V2 owner to keep. `expectedOwnerId` is the ticket's owner the verification must still find (the pole A rule: only the V2
 * owner's ticket is moved, and a person who took it in the meantime makes the write « not applied », never confirmed).
 */
export function buildTicketStageIntent(plan: CaseTicketStageIntent, v2OwnerId: string): EffectIntent {
  if (!TICKET.test(plan.ticketId) || !OWNER.test(v2OwnerId) || !plan.key.startsWith(TICKET_STAGE_KEY_PREFIX) || !/^[A-Za-z0-9_-]{1,40}$/.test(plan.stageId)) return fault("INTENT_INVALID");
  return {
    kind: "ticket_stage", permission: SAV_CASE_EFFECT_PERMISSIONS.stage, key: plan.key, ticketId: plan.ticketId, sourceMessageId: plan.caseId,
    properties: { hs_pipeline_stage: plan.stageId }, expectedOwnerId: v2OwnerId,
  };
}

export const ticketStageTarget = (intent: Pick<EffectIntent, "key">): CaseTicketStageTarget | null =>
  /^case-stage:[^:]+:waiting_customer:/.test(intent.key) ? "waiting_customer" : /^case-stage:[^:]+:closed:/.test(intent.key) ? "closed" : null;
