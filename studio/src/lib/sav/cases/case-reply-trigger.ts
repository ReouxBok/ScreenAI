// SAV-10 (pole C): ONE canonical identity for "the event a reply answers", derived from the STORED fact, never from a free string.
// The reply key (`reply:<case>:<trigger>`) is the business key of the whole chain: one validation per payload, one approval, one execution, one ledger row,
// one send. Two producers that name the same customer mail differently (pole B: `in:<case event id>`; the case store and the Gmail side: `inbound:<gmail id>`)
// would otherwise hold two keys for one mail and could be approved and sent twice. The store therefore resolves whatever alias it is given to the canonical form,
// refuses an alias that does not match the stored message the reply answers, and keys everything on the canonical form.
//   inbound:<gmail message id>   canonical form of a customer mail (the dedupe key of the case's `inbound_confirmed` event)
//   in:<case event id>           alias (pole B's input key) -> the canonical `inbound:` form of that event
//   back:<case event id>         a hand-back of the case to the agent (`owner_changed` event): its own trigger, a new situation for the same mail
//   timer:<case timer id>        a J2 reminder (`j2TriggerEventId`)
// Anything else (a suffix, a retry tag, a made-up id) is not a trigger. Pure reads: no lock is taken here (the caller holds the case lock).
import "server-only";
import { and, eq } from "drizzle-orm";
import { savCaseEvents, savCaseTimers, savMessages } from "@/db/schema";
import type { ExecutionTx } from "../intake/execution-store";
import type { CaseReplyProposal } from "./case-effects";

export type CaseReplyTriggerRefusal = "trigger_invalid" | "trigger_unknown" | "trigger_inconsistent";
export type CaseReplyTriggerResolution = Readonly<{ ok: true; triggerEventId: string }> | Readonly<{ ok: false; code: CaseReplyTriggerRefusal; detail: string }>;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = "[A-Za-z0-9._@<>=+-]{1,200}";
const CLASSES = {
  inbound: new RegExp(`^inbound:(${KEY})$`), in: new RegExp(`^in:(${UUID})$`, "i"), back: new RegExp(`^back:(${UUID})$`, "i"), timer: new RegExp(`^timer:(${UUID})$`, "i"),
} as const;
const no = (code: CaseReplyTriggerRefusal, detail: string): CaseReplyTriggerResolution => ({ ok: false, code, detail });

export async function resolveCaseReplyTrigger(tx: ExecutionTx, proposal: Pick<CaseReplyProposal, "caseId" | "triggerEventId" | "inboundMessageId">): Promise<CaseReplyTriggerResolution> {
  const raw = proposal.triggerEventId;
  if (typeof raw !== "string") return no("trigger_invalid", "type");
  const events = savCaseEvents;
  // A customer mail: whichever name it came under, it must be an `inbound_confirmed` event of THIS case, and the stored message the reply answers must be that mail.
  const customerMail = async (dedupeKey: string) => {
    const gmailMessageId = dedupeKey.slice("inbound:".length);
    const [message] = await tx.select({ gmail: savMessages.gmailMessageId }).from(savMessages).where(eq(savMessages.id, proposal.inboundMessageId));
    if (!message) return no("trigger_unknown", "message");
    if (message.gmail !== gmailMessageId) return no("trigger_inconsistent", "message");
    return { ok: true, triggerEventId: dedupeKey } as const;
  };
  const inbound = CLASSES.inbound.exec(raw);
  if (inbound) {
    const [event] = await tx.select({ id: events.id }).from(events).where(and(eq(events.caseId, proposal.caseId), eq(events.kind, "inbound_confirmed"), eq(events.dedupeKey, raw)));
    return event ? customerMail(raw) : no("trigger_unknown", "event");
  }
  const alias = CLASSES.in.exec(raw);
  if (alias) {
    const [event] = await tx.select({ dedupeKey: events.dedupeKey }).from(events).where(and(eq(events.caseId, proposal.caseId), eq(events.id, alias[1]!.toLowerCase()), eq(events.kind, "inbound_confirmed")));
    return event && CLASSES.inbound.test(event.dedupeKey) ? customerMail(event.dedupeKey) : no("trigger_unknown", "event");
  }
  const back = CLASSES.back.exec(raw);
  if (back) {
    const [event] = await tx.select({ id: events.id }).from(events).where(and(eq(events.caseId, proposal.caseId), eq(events.id, back[1]!.toLowerCase()), eq(events.kind, "owner_changed")));
    return event ? { ok: true, triggerEventId: `back:${back[1]!.toLowerCase()}` } : no("trigger_unknown", "event");
  }
  const timer = CLASSES.timer.exec(raw);
  if (timer) {
    const [row] = await tx.select({ id: savCaseTimers.id }).from(savCaseTimers).where(and(eq(savCaseTimers.caseId, proposal.caseId), eq(savCaseTimers.id, timer[1]!.toLowerCase())));
    return row ? { ok: true, triggerEventId: `timer:${timer[1]!.toLowerCase()}` } : no("trigger_unknown", "timer");
  }
  return no("trigger_invalid", "shape");
}
