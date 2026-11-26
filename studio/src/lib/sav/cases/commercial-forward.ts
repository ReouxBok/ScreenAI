// Ugo, 26/11 (`SAV_V2_SMART_COMMERCIAL_SPLIT=on` + `SAV_V2_SMART_COMMERCIAL_FORWARD=on`, both OFF by default): a mail with usage questions AND a
// commercial question (which plan, a demo). The smart brain answers the usage part; its reply says nothing of the commercial one. THIS module forwards
// the commercial part alone to sales (sacha@, V1 routing's own recipient), silently: never a word to the customer. The PURE protocol (no database,
// no network: ports injected), on the model of V1 routing's forward (`intake/routing-effect.ts`), one durable receipt per step:
//   queued (by the V2 reply passage, BEFORE the reply is proposed) → source re-read → dispatched (recorded BEFORE the send) → Gmail send → acked (the
//   send response's Gmail id) → read-back in Sent by that id (fallback: our own Message-ID) → confirmed.
//   Final receipts: confirmed | not_applied | uncertain. A dispatched forward is never sent again: only a read-back can confirm it; after bounded attempts
//   it becomes `uncertain` (« vérifier la boîte d'envoi de contact@ »). Before the dispatch nothing is counted: a short Gmail or database outage is retried
//   until the queued forward is `COMMERCIAL_FORWARD_STALE_MS` old, then it is `not_applied`; the same bound ends a forward held by a lost authority.
//   Every final receipt other than `confirmed` is a person's task: logged with its key (`caseId:inputKey`, no personal data) and given to the team
//   through `deps.alertTeam` (review 26/11, M1). The forward itself does not read the switch: the reconcile sweep that resumes it runs while either
//   commercial switch is on (review M2: a forward queued before the forward switch was turned off is still drained).
import { createHash } from "node:crypto";
import { SAV_INTAKE_ROUTING_MAILBOX, SAV_INTAKE_ROUTING_RECIPIENTS } from "../intake/routing-rules";
import type { IntakeRoutingGmail, IntakeRoutingSource } from "../intake/routing-effect";

export const SAV_COMMERCIAL_FORWARD_REVISION = "sav-v2-commercial-forward-2026-11-26.v1";
/** The only recipient: V1 routing's commercial address (one place for team addresses). */
export const SAV_COMMERCIAL_FORWARD_RECIPIENT = SAV_INTAKE_ROUTING_RECIPIENTS.lead_commercial!;
export type CommercialForwardStep = "queued" | "dispatched" | "acked" | "confirmed" | "not_applied" | "uncertain";
export const COMMERCIAL_FORWARD_STEPS: readonly CommercialForwardStep[] = ["queued", "dispatched", "acked", "confirmed", "not_applied", "uncertain"];
export const COMMERCIAL_FORWARD_FINAL_STEPS: readonly CommercialForwardStep[] = ["confirmed", "not_applied", "uncertain"];
/** Failed read-backs of a dispatched forward before it is `uncertain` (only counted once the mail may have left). */
export const COMMERCIAL_FORWARD_MAX_ATTEMPTS = 5;
/** A forward not dispatched this long after it was queued (Gmail down, mail unreadable, authority lost) ends `not_applied` and goes to a person. */
export const COMMERCIAL_FORWARD_STALE_MS = 6 * 60 * 60 * 1000;
/** Largest original attached as message/rfc822 (same bound as V1 routing); a larger one is forwarded as text only, never dropped. */
export const COMMERCIAL_FORWARD_MAX_ORIGINAL_BYTES = 3_500_000;
export type CommercialForwardMetadata = Record<string, string | number | boolean | null>;

/** The key of one forward: one per case and input (a new customer mail is a new input, so a new key; a replay finds the same one). */
export const commercialForwardKey = (caseId: string, inputKey: string) => `${caseId}:${inputKey}`;
const digest = (value: string) => createHash("sha256").update(`${SAV_COMMERCIAL_FORWARD_REVISION}:${value}`).digest("hex");
export const commercialForwardRfcMessageId = (key: string) => `<sav-commercial-${digest(key).slice(0, 40)}@studio.limova.ai>`;

export type CommercialForwardStore = Readonly<{
  steps(key: string): Promise<CommercialForwardStep[]>;
  /** Records the step once: true when this call recorded it, false when it already existed. */
  record(key: string, step: CommercialForwardStep, metadata: CommercialForwardMetadata): Promise<boolean>;
  receipt(key: string, step: CommercialForwardStep): Promise<CommercialForwardMetadata | null>;
  /** One pass owns a forward; null: another pass holds it. */
  lease(key: string): Promise<(() => Promise<void>) | null>;
  /** One more failed attempt; returns how many this forward has had, this one included. */
  attempt(key: string, metadata: CommercialForwardMetadata): Promise<number>;
}>;
/** What the forward carries, re-read from Studio's own records (never from the model's output alone): the stored mail and the queued asks. */
export type CommercialForwardFacts = Readonly<{ source: IntakeRoutingSource; asks: readonly string[] }>;
export type CommercialForwardDeps = Readonly<{
  /** Throws when V1's execution authority is not valid, lacks `route_intake_mail`, or an agent is paused. */
  authority: () => Promise<void>;
  readFacts: (key: string) => Promise<CommercialForwardFacts | null>;
  store: CommercialForwardStore;
  gmail: Pick<IntakeRoutingGmail, "readOriginal" | "send" | "sentMessageId" | "findSent">;
  signal?: AbortSignal;
  /** A final receipt other than `confirmed`: the team must take the commercial question up itself. Its failure is logged, never thrown. */
  alertTeam?: (key: string, step: "not_applied" | "uncertain", reason: string) => Promise<void>;
  now?: () => number;
}>;
export type CommercialForwardResult =
  | Readonly<{ skipped: "authority" | "already_done" | "busy" | "not_queued"; detail?: string }>
  | Readonly<{ retry: string }>
  | Readonly<{ final: "confirmed" | "not_applied" | "uncertain"; reason?: string }>;

const codeOf = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_COMMERCIAL_FORWARD_FAILED";
const oneLine = (text: string) => text.replace(/[\r\n\0]+/g, " ").trim();
const b64 = (text: string) => Buffer.from(text).toString("base64").replace(/.{76}(?=.)/g, "$&\r\n");

/** The forwarded mail for sales: the commercial asks, then the original mail (text, and attached as message/rfc822 when given). Never to the sender. */
export function buildCommercialForward(key: string, facts: CommercialForwardFacts, original: Buffer | null) {
  const { source } = facts, recipient = SAV_COMMERCIAL_FORWARD_RECIPIENT;
  const asks = facts.asks.map(oneLine).filter(Boolean).slice(0, 4);
  if (!asks.length || source.mailboxEmail !== SAV_INTAKE_ROUTING_MAILBOX || recipient === source.fromEmail.trim().toLowerCase()) throw Error("SAV_COMMERCIAL_FORWARD_INVALID");
  const subject = `Question commerciale (Agent SAV) : ${oneLine(source.subject) || "sans objet"}`.slice(0, 200);
  const text = [`Bonjour,`, ``,
    `Ce mail reçu sur ${SAV_INTAKE_ROUTING_MAILBOX} contient une question commerciale. L’Agent SAV a répondu au client sur ses autres questions, sans rien lui dire de celle-ci : à vous de le recontacter.`,
    ``, `Question commerciale :`, ...asks.map(ask => `- ${ask}`), ``, `---------- Message d’origine ----------`,
    `De : ${oneLine(source.fromEmail)}`, `Date : ${oneLine(source.receivedAt)}`, `Objet : ${oneLine(source.subject)}`, ``, source.text.slice(0, 100_000)].join("\n");
  const rfcMessageId = commercialForwardRfcMessageId(key);
  const attach = original && original.length > 0 && original.length <= COMMERCIAL_FORWARD_MAX_ORIGINAL_BYTES ? original : null;
  const common = [`From: ${SAV_INTAKE_ROUTING_MAILBOX}`, `To: ${recipient}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`, `Message-ID: ${rfcMessageId}`, "MIME-Version: 1.0"];
  if (!attach) {
    const raw = Buffer.from([...common, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(text), ""].join("\r\n"), "utf8");
    return { recipient, subject, text, rfcMessageId, raw, attached: false };
  }
  const boundary = `sav-commercial-${digest(`boundary:${key}`).slice(0, 32)}`;
  if (attach.includes(Buffer.from(boundary))) throw Error("SAV_COMMERCIAL_FORWARD_BOUNDARY_COLLISION");
  const head = [...common, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64", "", b64(text), `--${boundary}`, 'Content-Type: message/rfc822; name="message-origine.eml"',
    'Content-Disposition: attachment; filename="message-origine.eml"', "", ""].join("\r\n");
  const raw = Buffer.concat([Buffer.from(head, "utf8"), attach, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
  return { recipient, subject, text, rfcMessageId, raw, attached: true };
}

/** One forward, idempotent. Never throws for a refusal (a named result instead). */
export async function forwardCommercialPart(key: string, deps: CommercialForwardDeps): Promise<CommercialForwardResult> {
  let held: string | null = null;
  try { await deps.authority(); } catch (error) { held = codeOf(error); }
  // Held by the authority (switched off, paused, right removed): it waits, unless it is stale; then it is a person's task (review M2).
  if (held && !await staleQueued(key, deps)) return { skipped: "authority", detail: held };
  const release = await deps.store.lease(key);
  if (!release) return { skipped: "busy" };
  try { return held ? await abandonStale(key, deps, held) : await forwardOwned(key, deps, deps.signal ?? new AbortController().signal); }
  finally { await release().catch(error => console.warn("sav_commercial_forward_release", { code: codeOf(error) })); }
}

/** Queued, with no final receipt, and older than the bound (a queued receipt without a readable date is never stale: it keeps waiting, visibly). */
async function staleQueued(key: string, deps: CommercialForwardDeps) {
  const queued = await deps.store.receipt(key, "queued");
  const at = typeof queued?.queuedAt === "string" ? Date.parse(queued.queuedAt) : NaN;
  return Number.isFinite(at) && (deps.now ?? Date.now)() - at >= COMMERCIAL_FORWARD_STALE_MS;
}

async function abandonStale(key: string, deps: CommercialForwardDeps, held: string): Promise<CommercialForwardResult> {
  const steps = await deps.store.steps(key);
  if (steps.some(step => COMMERCIAL_FORWARD_FINAL_STEPS.includes(step))) return { skipped: "already_done" };
  if (!steps.includes("queued")) return { skipped: "not_queued" };
  return finalStep(key, deps, steps.includes("dispatched") ? "uncertain" : "not_applied", { reason: `authority_lost:${held}` });
}

async function finalStep(key: string, deps: CommercialForwardDeps, step: "confirmed" | "not_applied" | "uncertain", metadata: CommercialForwardMetadata): Promise<CommercialForwardResult> {
  if (!await deps.store.record(key, step, { revision: SAV_COMMERCIAL_FORWARD_REVISION, ...metadata })) return { skipped: "already_done" };
  const reason = typeof metadata.reason === "string" ? metadata.reason : null;
  if (step !== "confirmed") {
    // Codes and the forward's key only (case id and input key: no personal data). The team is told so a person recontacts the customer.
    console.error("sav_commercial_forward_final", { key, step, reason });
    if (deps.alertTeam) await deps.alertTeam(key, step, reason ?? "unknown").catch(error => console.error("sav_commercial_forward_alert_failed", { key, code: codeOf(error) }));
  }
  return { final: step, ...(reason ? { reason } : {}) } as const;
}

type Final = (step: "confirmed" | "not_applied" | "uncertain", metadata: CommercialForwardMetadata) => Promise<CommercialForwardResult>;
type Failed = (reason: string, dispatched: boolean) => Promise<CommercialForwardResult>;

async function forwardOwned(key: string, deps: CommercialForwardDeps, signal: AbortSignal): Promise<CommercialForwardResult> {
  const steps = await deps.store.steps(key);
  if (steps.some(step => COMMERCIAL_FORWARD_FINAL_STEPS.includes(step))) return { skipped: "already_done" };
  if (!steps.includes("queued")) return { skipped: "not_queued" };
  const final: Final = (step, metadata) => finalStep(key, deps, step, metadata);
  const failed: Failed = async (reason, dispatched) => {
    // Before the dispatch nothing can have left: retried (not counted) until the queued forward is stale (review M1: a short outage loses nothing).
    if (!dispatched) return await staleQueued(key, deps) ? final("not_applied", { reason }) : { retry: reason };
    const attempts = await deps.store.attempt(key, { reason });
    if (attempts >= COMMERCIAL_FORWARD_MAX_ATTEMPTS) return final("uncertain", { reason, attempts });
    return { retry: reason };
  };
  // A dispatched forward is only ever read back, never sent again.
  if (steps.includes("dispatched")) return confirmForward(key, deps, signal, final, failed);
  let facts: CommercialForwardFacts | null;
  try { facts = await deps.readFacts(key); } catch (error) { return failed(codeOf(error), false); }
  if (!facts) return failed("SAV_COMMERCIAL_FORWARD_SOURCE_MISSING", false);
  if (facts.source.mailboxEmail !== SAV_INTAKE_ROUTING_MAILBOX) return final("not_applied", { reason: "mailbox_refused" });
  let original: Buffer | null = null;
  try { original = await deps.gmail.readOriginal(facts.source.mailboxEmail, facts.source.gmailMessageId, signal); }
  catch (error) { return failed(codeOf(error), false); }
  let forward: ReturnType<typeof buildCommercialForward>;
  try { forward = buildCommercialForward(key, facts, original); } catch (error) { return final("not_applied", { reason: codeOf(error) }); }
  try { await deps.authority(); } catch (error) { return { retry: codeOf(error) }; }
  // Recorded BEFORE the send: a crash after it can only lead to a read-back, never to a second mail.
  if (!await deps.store.record(key, "dispatched", { revision: SAV_COMMERCIAL_FORWARD_REVISION, recipient: forward.recipient, rfcMessageId: forward.rfcMessageId, attached: forward.attached }))
    return { skipped: "busy" };
  try {
    const ack = await deps.gmail.send(facts.source.mailboxEmail, forward.raw, signal);
    if (ack && typeof ack.id === "string" && /^[a-f0-9]{1,64}$/i.test(ack.id)) await deps.store.record(key, "acked", { revision: SAV_COMMERCIAL_FORWARD_REVISION, gmailMessageId: ack.id });
  } catch (error) { console.warn("sav_commercial_forward_send_unknown", { code: codeOf(error) }); /* unknown outcome: only the read-back decides */ }
  return confirmForward(key, deps, signal, final, failed);
}

async function confirmForward(key: string, deps: CommercialForwardDeps, signal: AbortSignal, final: Final, failed: Failed) {
  const rfcMessageId = commercialForwardRfcMessageId(key);
  const acked = await deps.store.receipt(key, "acked");
  const ackedId = typeof acked?.gmailMessageId === "string" ? acked.gmailMessageId : null;
  let sentId: string | null = null, proof: "send_response_id" | "message_id_header" = "send_response_id";
  try {
    if (ackedId && await deps.gmail.sentMessageId(SAV_INTAKE_ROUTING_MAILBOX, ackedId, signal) === rfcMessageId) sentId = ackedId;
    if (!sentId) { proof = "message_id_header"; sentId = await deps.gmail.findSent(SAV_INTAKE_ROUTING_MAILBOX, rfcMessageId, signal); }
  } catch (error) { return failed(codeOf(error), true); }
  if (!sentId) return failed("SAV_COMMERCIAL_FORWARD_UNCONFIRMED", true);
  return final("confirmed", { gmailMessageId: sentId, proof });
}
