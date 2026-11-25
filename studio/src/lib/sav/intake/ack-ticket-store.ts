// SAV-128 (Ugo 23/11): the per-mail fact the engine needs to put an acknowledgement into the ticket of its Gmail thread (`ack-ticket.ts`). Read only.
import "server-only";
import { sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCases } from "@/db/schema";
import { savAckClosureEnabled } from "./ack-closure-rules";
import { savV2CaseThreadReplyEnabled } from "./case-thread-reply";
import { savCaseLastActivity } from "../cases/case-activity-store";
import { caseReturnPhaseClosed, caseThreadReplyWithinWindow } from "../cases/customer-return";
import type { CasePhase } from "../cases/case-types";
import type { EnginePolicy } from "./engine-types";

type Reader = Pick<ReturnType<typeof requireDb>, "select">;

/**
 * The fact, or undefined for today's acknowledgement_only:
 * - `SAV_ACK_CLOSE=on`: the autonomous closure (its own right, `ack-closure.ts`) keeps owning acknowledgements; reopening what it closes would undo it;
 * - a V2 case on the thread or on its ticket: V2 owns that ticket and receives the acknowledgement through its own relay (`acknowledgement_on_case_thread`).
 * `ticketId` is the HubSpot ticket stored on the thread (null when none). Never throws: an unreadable fact is today's path.
 */
export async function intakeAcknowledgementTicketFact(input: { threadId: string; threadTicketId: string | null | undefined },
  env: Record<string, string | undefined>, db: Reader = requireDb()): Promise<EnginePolicy["acknowledgementTicket"]> {
  try {
    if (savAckClosureEnabled(env)) return undefined;
    const ticketId = input.threadTicketId && /^\d{1,30}$/.test(input.threadTicketId) ? input.threadTicketId : null;
    const [v2] = await db.select({ id: savCases.id }).from(savCases)
      .where(ticketId ? sql`${savCases.ticketId} = ${ticketId} or ${input.threadId}::uuid = any(${savCases.threadIds})` : sql`${input.threadId}::uuid = any(${savCases.threadIds})`).limit(1);
    return v2 ? undefined : { ticketId };
  } catch { return undefined; }
}

/**
 * 25/11 (`SAV_V2_CASE_THREAD_REPLY=on` only): the V2 case of the mail's thread, or undefined. Set only when the thread maps to exactly one case held by the
 * agent and not sensitive (finance and cancellation stay the team's). A case held by the team or on system hold gets no fact: V1 keeps today's path, so the
 * person still gets the mail on the HubSpot ticket (`v2-entry.ts`). A CLOSED agent case only within V1's 15-day window after its last activity (the same rule as
 * V2's reopen, `savCaseLastActivity`); past it, or with no readable date, no fact: V1's today path. Off, no case, two cases, or an unreadable fact: undefined.
 * Never throws.
 */
export async function intakeV2CaseThreadFact(input: { threadId: string; receivedAt: string }, env: Record<string, string | undefined>,
  db: Reader = requireDb()): Promise<EnginePolicy["v2CaseThread"]> {
  try {
    if (!savV2CaseThreadReplyEnabled(env)) return undefined;
    const cases = await db.select({ id: savCases.id, owner: savCases.owner, sensitivity: savCases.sensitivity, phase: savCases.phase }).from(savCases)
      .where(sql`${input.threadId}::uuid = any(${savCases.threadIds})`).limit(2);
    const only = cases.length === 1 ? cases[0] : undefined;
    if (!only || only.sensitivity !== "none" || only.owner !== "agent") return undefined;
    if (!caseReturnPhaseClosed(only.phase as CasePhase)) return { caseId: only.id };
    const receivedAt = new Date(input.receivedAt);
    return caseThreadReplyWithinWindow(receivedAt.getTime() - await savCaseLastActivity(only.id, receivedAt, db)) ? { caseId: only.id } : undefined;
  } catch { return undefined; }
}
