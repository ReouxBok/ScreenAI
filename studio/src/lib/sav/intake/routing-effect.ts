// V1 routing (Ugo, 23/11, OFF unless `SAV_INTAKE_ROUTING_MODE=live`): the effect. Protocol per message (receipts are durable rows, one per step; the DB
// store is `routing-store.ts`):
//   forward: claimed → facts re-read, decision recomputed → forward_dispatched (recorded BEFORE the send) → Gmail send → read-back in Sent by its own
//            Message-ID → forward_confirmed → confirmed
//   archive: claimed → facts re-read, decision recomputed → INBOX label removed from the Gmail thread (idempotent by value) → read-back → confirmed
//   Final receipts: confirmed | not_applied | uncertain. A final receipt ends the message for good.
// The forward is never sent twice: once `forward_dispatched` exists, only a read-back of Sent can confirm it; after bounded attempts it becomes `uncertain`
// for a person (« vérifier la boîte d'envoi »). Never a reply to the sender, never a finance/cancellation/support mail (the rule refuses them first).
import { createHash } from "node:crypto";
import { decideIntakeRouting, savIntakeRoutingClassLabels, savIntakeRoutingMode, SAV_INTAKE_ROUTING_MAILBOX, SAV_INTAKE_ROUTING_RECIPIENTS, SAV_INTAKE_ROUTING_REVISION,
  type SavIntakeRoutingDecision, type SavIntakeRoutingFacts } from "./routing-rules";

export type IntakeRoutingStep = "claimed" | "forward_dispatched" | "forward_confirmed" | "confirmed" | "not_applied" | "uncertain";
export const INTAKE_ROUTING_FINAL_STEPS: readonly IntakeRoutingStep[] = ["confirmed", "not_applied", "uncertain"];
export const INTAKE_ROUTING_MAX_ATTEMPTS = 5;
export type IntakeRoutingMetadata = Record<string, string | number | boolean | null>;

export type IntakeRoutingStore = Readonly<{
  steps(messageId: string): Promise<IntakeRoutingStep[]>;
  /** Records the step once: true when this call recorded it, false when it already existed. */
  record(messageId: string, step: IntakeRoutingStep, metadata: IntakeRoutingMetadata): Promise<boolean>;
  /** One pass owns a message from its receipts to its effect; null: another pass holds it. */
  lease(messageId: string): Promise<(() => Promise<void>) | null>;
  /** Records one more failed attempt and returns how many this message has had, this one included. */
  attempt(messageId: string, metadata: IntakeRoutingMetadata): Promise<number>;
}>;
/** The source mail as stored by Studio (never re-read from the sender). */
export type IntakeRoutingSource = Readonly<{ mailboxEmail: string; gmailMessageId: string; gmailThreadId: string; fromEmail: string; subject: string; receivedAt: string; text: string }>;
export type IntakeRoutingLiveFacts = Readonly<{
  /** The decision stored on the current run of this mail by the live analysis (null: none, or not live). */
  stored: (SavIntakeRoutingDecision & { mode: string }) | null;
  /** The same rule's facts, re-read now (thread, newer mail, V2 case, external completion, human context). */
  facts: SavIntakeRoutingFacts;
  source: IntakeRoutingSource;
}>;
export type IntakeRoutingGmail = Readonly<{
  send(mailboxEmail: string, raw: string, signal: AbortSignal): Promise<{ id: string; threadId: string }>;
  /** The sent copy carrying this Message-ID: its Gmail id, null when none is found. Throws when Sent is unreadable. */
  findSent(mailboxEmail: string, rfcMessageId: string, signal: AbortSignal): Promise<string | null>;
  /** Removes INBOX from the thread (idempotent), then reads it back: true when no message of the thread is still in INBOX. */
  archive(mailboxEmail: string, gmailThreadId: string, signal: AbortSignal): Promise<boolean>;
}>;
export type IntakeRoutingDeps = Readonly<{
  env: () => Record<string, string | undefined>;
  /** Throws when V1's execution authority is not valid, lacks `route_intake_mail`, or the agent is paused. */
  authority: () => Promise<void>;
  readFacts: (messageId: string) => Promise<IntakeRoutingLiveFacts | null>;
  store: IntakeRoutingStore;
  gmail: IntakeRoutingGmail;
  signal?: AbortSignal;
}>;
export type IntakeRoutingResult =
  | Readonly<{ skipped: "off" | "authority" | "already_done" | "busy"; detail?: string }>
  | Readonly<{ retry: string }>
  | Readonly<{ final: "confirmed" | "not_applied" | "uncertain"; reason?: string }>;

const codeOf = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_ROUTING_FAILED";
const oneLine = (text: string) => text.replace(/[\r\n\0]+/g, " ").trim();
export const intakeRoutingRfcMessageId = (messageId: string) => `<sav-routing-${createHash("sha256").update(`${SAV_INTAKE_ROUTING_REVISION}:${messageId}`).digest("hex").slice(0, 40)}@studio.limova.ai>`;

/** The forwarded mail: the original text, unchanged, under a short note; no attachment, never sent to the original sender. */
export function buildIntakeRoutingForward(decision: SavIntakeRoutingDecision, source: IntakeRoutingSource) {
  const recipient = decision.recipient;
  if (decision.action !== "forward" || !decision.class || !recipient || !Object.values(SAV_INTAKE_ROUTING_RECIPIENTS).includes(recipient)
    || source.mailboxEmail !== SAV_INTAKE_ROUTING_MAILBOX || recipient === source.fromEmail.toLowerCase()) throw Error("SAV_INTAKE_ROUTING_FORWARD_INVALID");
  if (source.text.length > 100_000) throw Error("SAV_INTAKE_ROUTING_MESSAGE_TOO_LARGE");
  const label = savIntakeRoutingClassLabels[decision.class];
  const subject = `Transfert automatique (${label}) : ${oneLine(source.subject) || "sans objet"}`.slice(0, 200);
  const text = `Bonjour,\n\nCe mail reçu sur ${SAV_INTAKE_ROUTING_MAILBOX} a été classé « ${label} » par l’Agent de tri et vous est transféré automatiquement.\nAucune réponse n’a été envoyée à l’expéditeur. Les pièces jointes ne sont pas incluses.\n\n---------- Message transféré ----------\nDe : ${oneLine(source.fromEmail)}\nDate : ${oneLine(source.receivedAt)}\nObjet : ${oneLine(source.subject)}\n\n${source.text}`;
  const rfcMessageId = intakeRoutingRfcMessageId(decision.messageId);
  const raw = [`From: ${SAV_INTAKE_ROUTING_MAILBOX}`, `To: ${recipient}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`, `Message-ID: ${rfcMessageId}`,
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    Buffer.from(text).toString("base64").replace(/.{76}(?=.)/g, "$&\r\n")].join("\r\n");
  return { recipient, subject, text, rfcMessageId, raw };
}

/** One message, idempotent. Never throws for a refusal (a named result instead). */
export async function routeIntakeMessage(messageId: string, deps: IntakeRoutingDeps): Promise<IntakeRoutingResult> {
  if (savIntakeRoutingMode(deps.env()) !== "live") return { skipped: "off" };
  try { await deps.authority(); } catch (error) { return { skipped: "authority", detail: codeOf(error) }; }
  const release = await deps.store.lease(messageId);
  if (!release) return { skipped: "busy" };
  try { return await routeOwned(messageId, deps, deps.signal ?? new AbortController().signal); } finally { await release().catch(() => undefined); }
}

async function routeOwned(messageId: string, deps: IntakeRoutingDeps, signal: AbortSignal): Promise<IntakeRoutingResult> {
  const steps = await deps.store.steps(messageId);
  if (steps.some(step => INTAKE_ROUTING_FINAL_STEPS.includes(step))) return { skipped: "already_done" };
  const final = async (step: "confirmed" | "not_applied" | "uncertain", metadata: IntakeRoutingMetadata) => {
    await deps.store.record(messageId, step, { revision: SAV_INTAKE_ROUTING_REVISION, ...metadata });
    return { final: step, ...(typeof metadata.reason === "string" ? { reason: metadata.reason } : {}) } as const;
  };
  const failed = async (reason: string, dispatched: boolean): Promise<IntakeRoutingResult> => {
    const attempts = await deps.store.attempt(messageId, { reason });
    if (attempts >= INTAKE_ROUTING_MAX_ATTEMPTS) return final(dispatched ? "uncertain" : "not_applied", { reason, attempts });
    return { retry: reason };
  };
  let live: IntakeRoutingLiveFacts | null;
  try { live = await deps.readFacts(messageId); } catch (error) { return failed(codeOf(error), steps.includes("forward_dispatched")); }
  const dispatched = steps.includes("forward_dispatched");
  // A dispatched forward is always resumed to a read-back, whatever changed since (never a second send).
  if (dispatched) return confirmForward(messageId, live, deps, signal, final, failed);
  if (!live) return final("not_applied", { reason: "facts_missing" });
  const stored = live.stored;
  if (!stored || stored.mode !== "live" || stored.action === "keep") return final("not_applied", { reason: stored ? stored.reason ?? "not_routed" : "decision_missing" });
  // Facts re-read now: a newer mail, a ticket, a person, a V2 case or an external completion since the analysis cancels the routing.
  const fresh = decideIntakeRouting(live.facts);
  if (fresh.action !== stored.action || fresh.recipient !== stored.recipient || fresh.class !== stored.class) return final("not_applied", { reason: fresh.reason ?? "decision_changed" });
  if (live.source.mailboxEmail !== SAV_INTAKE_ROUTING_MAILBOX) return final("not_applied", { reason: "mailbox_refused" });
  await deps.store.record(messageId, "claimed", { revision: SAV_INTAKE_ROUTING_REVISION, action: fresh.action, class: fresh.class });
  if (fresh.action === "archive") {
    try { await deps.authority(); } catch (error) { return { retry: codeOf(error) }; }
    let archived: boolean;
    try { archived = await deps.gmail.archive(live.source.mailboxEmail, live.source.gmailThreadId, signal); }
    catch (error) { return failed(codeOf(error), false); }
    return archived ? final("confirmed", { action: "archive", class: fresh.class }) : failed("SAV_INTAKE_ROUTING_ARCHIVE_UNCONFIRMED", false);
  }
  let forward: ReturnType<typeof buildIntakeRoutingForward>;
  try { forward = buildIntakeRoutingForward(fresh, live.source); } catch (error) { return final("not_applied", { reason: codeOf(error) }); }
  try { await deps.authority(); } catch (error) { return { retry: codeOf(error) }; }
  // Recorded BEFORE the send: a crash after it can only lead to a read-back, never to a second mail.
  if (!await deps.store.record(messageId, "forward_dispatched", { revision: SAV_INTAKE_ROUTING_REVISION, class: fresh.class, recipient: forward.recipient, rfcMessageId: forward.rfcMessageId }))
    return { skipped: "busy" };
  try { await deps.gmail.send(live.source.mailboxEmail, forward.raw, signal); } catch { /* unknown outcome: only the read-back decides */ }
  return confirmForward(messageId, live, deps, signal, final, failed);
}

async function confirmForward(messageId: string, live: IntakeRoutingLiveFacts | null, deps: IntakeRoutingDeps, signal: AbortSignal,
  final: (step: "confirmed" | "uncertain", metadata: IntakeRoutingMetadata) => Promise<IntakeRoutingResult>, failed: (reason: string, dispatched: boolean) => Promise<IntakeRoutingResult>) {
  let sentId: string | null;
  try { sentId = await deps.gmail.findSent(live?.source.mailboxEmail ?? SAV_INTAKE_ROUTING_MAILBOX, intakeRoutingRfcMessageId(messageId), signal); }
  catch (error) { return failed(codeOf(error), true); }
  if (!sentId) return failed("SAV_INTAKE_ROUTING_FORWARD_UNCONFIRMED", true);
  await deps.store.record(messageId, "forward_confirmed", { revision: SAV_INTAKE_ROUTING_REVISION, gmailMessageId: sentId });
  return final("confirmed", { action: "forward", gmailMessageId: sentId });
}
