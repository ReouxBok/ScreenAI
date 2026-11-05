// SAV-10 (pole C): the CURRENT owner of the ticket, asked before any NEW reply work. LOCAL / OFF: this file reads nothing itself — the reader is a server-side port the
// caller injects (A's `ticketOwnerPort` fits it as it is), and there is no default: without a port, or when the port answers anything but "v2", new work is refused.
// Why it exists: the local case says "agent" until the CRM owner change has been observed here; a person who took the ticket in the CRM must stop a NEW proposal, a NEW
// queue entry, a NEW plan, a NEW marker and the last look before the SDK. It does NOT apply to a send that already left (dispatched / acked / uncertain): that is only
// verified, whoever owns the ticket now, and a confirmed ledger row is always settled.
import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCases } from "@/db/schema";
import type { TicketOwnerReading } from "./admission-runtime";
import type { CaseSnapshot } from "./case-types";
import type { ExecutionTx } from "../intake/execution-store";

export type { TicketOwnerReading };
/** B's `readTicketOwner` / A's `ticketOwnerPort(...)`: given the case (only its ticket id is read), the discriminated current owner. A failed read throws. */
export type CaseTicketOwnerPort = (snapshot: Pick<CaseSnapshot, "ticketId">) => Promise<TicketOwnerReading>;

export type CaseOwnerRefusal = "owner_human" | "owner_none" | "owner_unknown" | "owner_read_failed" | "owner_port_absent" | "owner_ticket_invalid";
export type CaseOwnerVerdict = Readonly<{ ok: true }> | Readonly<{ ok: false; code: CaseOwnerRefusal }>;

const TICKET_ID = /^[0-9]{1,30}$/;

/**
 * Asks the port about EXACTLY this ticket and closes on everything that is not an explicit "v2": no port, a bad ticket id, a failed read, an answer outside the contract,
 * "none" (a ticket nobody owns is acquired by a separate, product-level step, not by a reply) and "unknown" (an unread property is never read as "none").
 * The read is made outside any database transaction; the caller judges the local fences (lease, pauses, case, version) again AFTER it returns.
 */
export async function judgeCurrentTicketOwner(port: CaseTicketOwnerPort | null | undefined, ticketId: string | null | undefined): Promise<CaseOwnerVerdict> {
  if (typeof port !== "function") return { ok: false, code: "owner_port_absent" };
  if (typeof ticketId !== "string" || !TICKET_ID.test(ticketId)) return { ok: false, code: "owner_ticket_invalid" };
  let reading: unknown;
  try { reading = await port({ ticketId }); } catch { return { ok: false, code: "owner_read_failed" }; }
  if (reading === "v2") return { ok: true };
  if (reading === "human") return { ok: false, code: "owner_human" };
  if (reading === "none") return { ok: false, code: "owner_none" };
  return { ok: false, code: "owner_unknown" };
}

/** The ticket id of a case, read from the case row itself (never from a payload or a caller): the minimal identifier, read before anything is decrypted. */
export async function readCaseTicketId(caseId: string, tx?: ExecutionTx): Promise<string | null> {
  const [row] = await (tx ?? requireDb()).select({ ticketId: savCases.ticketId }).from(savCases).where(eq(savCases.id, caseId));
  return row?.ticketId ?? null;
}
