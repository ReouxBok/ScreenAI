// SAV-128 (Ugo 23/11): the per-mail fact the engine needs to put an acknowledgement into the ticket of its Gmail thread (`ack-ticket.ts`). Read only.
import "server-only";
import { sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCases } from "@/db/schema";
import { savAckClosureEnabled } from "./ack-closure-rules";
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

/** SAV-139: a V2 case owns the thread or its ticket (`SAV_INTAKE_THREAD_ACK`). Never throws: an unreadable fact is false (today's path). */
export async function intakeThreadV2CaseFact(input: { threadId: string; threadTicketId: string | null | undefined }, db: Reader = requireDb()): Promise<boolean> {
  try {
    const ticketId = input.threadTicketId && /^\d{1,30}$/.test(input.threadTicketId) ? input.threadTicketId : null;
    const [v2] = await db.select({ id: savCases.id }).from(savCases)
      .where(ticketId ? sql`${savCases.ticketId} = ${ticketId} or ${input.threadId}::uuid = any(${savCases.threadIds})` : sql`${input.threadId}::uuid = any(${savCases.threadIds})`).limit(1);
    return Boolean(v2);
  } catch { return false; }
}
