// SAV-139 (Ugo 25/11): fewer « À valider » without ever losing, misfiling or hiding a customer mail. Each rule has its own switch, read from the
// environment; only the exact value "on" enables it, anything else (absent included) keeps today's behaviour strictly.
//   SAV_INTAKE_SAFE_ARCHIVE      : a mail V1 saw WITHOUT any request may be archived in Gmail (never deleted, no HubSpot write) by the existing
//                                  routing (`SAV_INTAKE_ROUTING_MODE`, shadow records only), and only when every server check below passes. Adds the
//                                  phishing class and the customer-signal judgement to the routing field (a new launch configuration).
//   SAV_INTAKE_THREAD_ACK        : a thanks in a known thread (its ticket, or a V2 case) goes to that thread instead of « À valider » when only the
//                                  model's nature said « request » (no written request marker).
//   SAV_INTAKE_SUPPORT_DEFAULT   : « Quelle demande ? » on a real customer mail (routing class support, or a known contact with an unknown class) goes
//                                  to the support path. A thanks never does.
//                                  A finance or cancellation signal (V1 or routing) is never relaxed: it keeps today's path.
//   SAV_INTAKE_THREAD_TICKET_LINK: « Déjà couvert ? lequel ? » is answered by the open ticket of the mail's own Gmail thread, same contact.
// Pure: nothing here reads, writes or sends.
import { savEvidenceContains } from "../evidence-text";
import type { SavIntakeRoutingAnalysis } from "./routing-rules";

type Env = Partial<Record<string, string | undefined>>;
const on = (env: Env, key: string) => env[key] === "on";
export const savIntakeSafeArchiveEnabled = (env: Env = process.env) => on(env, "SAV_INTAKE_SAFE_ARCHIVE");
/** Bumped on every wording change of the safe-archive guideline: it enters the launch hash with the switch on. */
export const SAV_INTAKE_SAFE_ARCHIVE_REVISION = "sav-intake-safe-archive-2026-11-25.v1";

/** Engine switches and the per-mail thread facts they need (runtime facts, never model output). Absent: today's engine. */
export type SavIntakeToValidatePolicy = {
  /** Look the sender up in HubSpot when V1 sees no classifiable request (safe archive and support default need it). */
  senderLookup?: true;
  threadAck?: true;
  supportDefault?: true;
  threadTicketLink?: true;
  /** The HubSpot ticket stored on the mail's Gmail thread (null: none). */
  threadTicketId?: string | null;
  /** A V2 case owns the thread or its ticket. */
  threadV2Case?: true;
  /** SAV_INTAKE_TICKET_DECIDE (phase 3). */
  ticketDecide?: true;
};
export function savIntakeToValidatePolicy(env: Env, facts: { threadTicketId?: string | null; threadV2Case?: boolean } = {}): SavIntakeToValidatePolicy | undefined {
  const safeArchive = savIntakeSafeArchiveEnabled(env), supportDefault = on(env, "SAV_INTAKE_SUPPORT_DEFAULT");
  const threadAck = on(env, "SAV_INTAKE_THREAD_ACK"), threadTicketLink = on(env, "SAV_INTAKE_THREAD_TICKET_LINK");
  // The routing field (class, customer signal) exists only with the routing on: no HubSpot lookup without it.
  const routingOn = env.SAV_INTAKE_ROUTING_MODE === "shadow" || env.SAV_INTAKE_ROUTING_MODE === "live";
  const ticketDecide = on(env, "SAV_INTAKE_TICKET_DECIDE");
  if (!safeArchive && !supportDefault && !threadAck && !threadTicketLink && !ticketDecide) return undefined;
  const ticketId = facts.threadTicketId && /^\d{1,30}$/.test(facts.threadTicketId) ? facts.threadTicketId : null;
  return { ...((safeArchive || supportDefault) && routingOn ? { senderLookup: true as const } : {}), ...(threadAck ? { threadAck: true as const } : {}),
    ...(supportDefault ? { supportDefault: true as const } : {}), ...(threadTicketLink ? { threadTicketLink: true as const } : {}), ...(ticketDecide ? { ticketDecide: true as const } : {}),
    threadTicketId: ticketId, ...(facts.threadV2Case ? { threadV2Case: true as const } : {}) };
}

export type SavIntakeSenderContact = "none" | "known" | "unknown";
/** HubSpot answer for the sender's address: none only for a complete search with no contact; any doubt is unknown. */
export function savIntakeSenderContact(result: { status: string; data: readonly { emails: readonly string[] }[] }, address: string): SavIntakeSenderContact {
  if (result.status !== "complete") return "unknown";
  const wanted = address.trim().toLowerCase();
  if (result.data.some(contact => contact.emails.some(email => email.trim().toLowerCase() === wanted))) return "known";
  return result.data.length ? "unknown" : "none";
}

/** Deterministic veto, in the safe direction only (it can keep a mail, never archive one): the product's name in the text, the subject or the sender's address. */
export function savIntakeMentionsProduct(text: string, fromEmail: string, subject = "") {
  return /limova/iu.test(text) || /limova/iu.test(fromEmail) || /limova/iu.test(subject);
}
/** The model's « no customer signal » is accepted only with a quote that is an exact excerpt of the current authored text. */
export function savIntakeCustomerSignalAbsenceVerified(routing: Pick<SavIntakeRoutingAnalysis, "customerSignal" | "customerSignalQuote"> | null | undefined, currentText: string) {
  const quote = routing?.customerSignalQuote?.trim();
  return routing?.customerSignal === false && Boolean(quote) && quote!.length >= 8 && savEvidenceContains(currentText, quote!);
}

export type SavIntakeSafeArchiveFacts = Readonly<{
  /** V1's plan saw no request at all (zero, or only « other »), and asked only for its classification. */
  noRequest: boolean;
  /** The mail carries an attachment V1 did not read (absent: none). Never archived then. */
  unreadAttachment?: boolean;
  sender: SavIntakeSenderContact;
  productMention: boolean;
  customerSignalAbsenceVerified: boolean;
}>;
const NO_REQUEST_REASONS: readonly string[] = ["classification_incomplete", "other_rule_not_applicable"];
const ARCHIVE_ONLY: readonly string[] = ["demarchage", "notification_auto", "phishing"];
/** The facts of one analysed mail, from its stored plan, message and routing field; null when the plan or message is missing. */
export function savIntakeSafeArchiveFacts(input: {
  plan: { decision: { requests: readonly { kind: string }[]; disposition: { kind: string; reasons?: readonly string[] }; evidence?: readonly { id: string; source: string }[] };
    senderContact?: SavIntakeSenderContact } | null | undefined;
  message: { currentText: string; fromEmail: string; subject?: string | null; unreadAttachments?: readonly unknown[]; attachmentInputs?: readonly { sourceId: string }[] } | null | undefined;
  routing: SavIntakeRoutingAnalysis | null | undefined;
}): SavIntakeSafeArchiveFacts | null {
  const { plan, message } = input;
  if (!plan || !message) return null;
  const disposition = plan.decision.disposition;
  const noRequest = disposition.kind === "collect_context" && (disposition.reasons ?? []).every(reason => NO_REQUEST_REASONS.includes(reason))
    && plan.decision.requests.every(request => request.kind === "other");
  // An attachment counts as read only when V1 kept its analysed observation as evidence.
  const read = new Set((plan.decision.evidence ?? []).filter(e => e.source === "current_attachment").map(e => e.id));
  const unreadAttachment = Boolean(message.unreadAttachments?.length) || (message.attachmentInputs ?? []).some(input => !read.has(input.sourceId));
  return { noRequest, ...(unreadAttachment ? { unreadAttachment } : {}), sender: plan.senderContact ?? "unknown", productMention: savIntakeMentionsProduct(message.currentText, message.fromEmail, message.subject ?? ""),
    customerSignalAbsenceVerified: savIntakeCustomerSignalAbsenceVerified(input.routing, message.currentText) };
}

/**
 * For a plan V1 left collecting context: null when the mail may go on to the routing's thread checks (then only to the archive), otherwise the reason
 * it keeps today's path. Without the switch (facts absent) it is exactly today's `v1_collect_context`.
 */
export function savIntakeSafeArchiveRefusal(facts: { model: SavIntakeRoutingAnalysis | null; safeArchive?: SavIntakeSafeArchiveFacts }): string | null {
  const safe = facts.safeArchive, model = facts.model;
  if (!safe || !safe.noRequest) return "v1_collect_context";
  if (!model) return "model_routing_missing";
  if (!ARCHIVE_ONLY.includes(model.class)) return "v1_collect_context";
  if (model.confidence !== "high") return `confidence_${model.confidence}`;
  if (safe.unreadAttachment) return "safe_archive_unread_attachment";
  if (safe.sender !== "none") return `safe_archive_sender_${safe.sender}`;
  if (safe.productMention) return "safe_archive_product_mention";
  if (!safe.customerSignalAbsenceVerified) return "safe_archive_customer_signal";
  return null;
}

/** Routing classes that let « Quelle demande ? » default to support: the model's own support class, or, for a known contact's first mail of a thread
 * without a ticket only, an unknown class.
 * A thanks never becomes a support ticket (it may close a finance or cancellation exchange): outside a known thread it keeps today's path.
 * Finance, cancellation, mixed and every outside class keep today's path. */
export function savIntakeSupportDefaultApplies(routing: Pick<SavIntakeRoutingAnalysis, "class"> | null | undefined, sender: SavIntakeSenderContact, firstMailWithoutTicket = false) {
  if (!routing) return false;
  if (routing.class === "support") return true;
  return firstMailWithoutTicket && sender === "known" && routing.class === "unknown";
}

/** Safe-archive guideline lines (added to the routing guideline with the switch on). Examples are invented and generic. */
export function savIntakeSafeArchiveGuideline() {
  return [
    "- phishing: a fraudulent message trying to obtain credentials, a payment or a click by imitating a bank, a platform, a lawyer, a court, an authority or Limova itself (fake security alert, fake legal notice with a link or an attachment to open, fake invoice to pay). Ex: « Votre compte sera suspendu, confirmez vos identifiants ici ».",
    "CUSTOMER SIGNAL: also return `customerSignal` (boolean). true when the CURRENT message shows anything a Limova customer could need: it names Limova or its assistant, an account, a subscription, an invoice or a payment with us, a problem, or a question about the product; or when you are unsure. false only for a mail with none of these (an advertisement, a newsletter, a delivery report, a phishing attempt). With false, `customerSignalQuote` must copy verbatim a short passage (at least a few words) of the current message that shows what kind of mail it is (for example an unsubscribe line, the delivery-failure sentence, the offer). Never false for a mail that has a request.",
  ].join("\n");
}

// ---------- SAV-139 phase 3 ----------
//   SAV_INTAKE_CITATION_REPAIR       : a citation the server refuses (request anchored outside the current mail, unproven registration, quote not found)
//                                      gets ONE repair call naming the failed check, instead of the same cached answer refused on every attempt. The
//                                      server checks the new answer exactly as before: a quote absent from the mail is never accepted. New launch hash.
//   SAV_INTAKE_BOUNDED_CONVERSATION  : the simple reader sends the latest messages of a long thread (bounded), never the whole thread. New launch hash.
//   SAV_INTAKE_TICKET_DECIDE         : « quel ticket ? »: exactly one open ticket judged the same is linked; every ticket judged different gives a new
//                                      ticket. Finance and cancellation keep today's path.
export const savIntakeCitationRepairEnabled = (env: Env = process.env) => on(env, "SAV_INTAKE_CITATION_REPAIR");
export const SAV_INTAKE_CITATION_REPAIR_REVISION = "sav-intake-citation-repair-2026-11-25.v1";
export const savIntakeBoundedConversationEnabled = (env: Env = process.env) => on(env, "SAV_INTAKE_BOUNDED_CONVERSATION");
export const SAV_INTAKE_BOUNDED_CONVERSATION_REVISION = "sav-intake-bounded-conversation-2026-11-25.v1";
/** Messages of the thread sent to the simple reader with the bound on (the newest ones, plus any message a continuation must cite). */
export const SAV_INTAKE_CONVERSATION_MAX = 12;

const CITATION_HINTS: Readonly<Record<string, string>> = {
  wrong_anchor_source: "Every request must cite the CURRENT message. A request that only appears in an earlier message or in the quoted part of the thread is not a request of this mail: describe what the current message asks, or return no request.",
  registration_source_invalid: "Return `registration` only for an address the sender states in the CURRENT message as their own Limova account, with a quote copied verbatim from the current message that contains it. Otherwise omit `registration` (never the address of another person).",
  excerpt_not_in_source: "Copy every quote verbatim from its source (same words, accents and punctuation), or omit the optional field.",
  unknown_anchor: "Use only the quote identifiers offered in the citation catalogue.",
  ambiguous_quote_format: "Cite with the offered quote identifier only, never with a free-text quote.",
  unknown_source: "Cite only the sources offered in this request.",
};
/** The repair line naming the refused check; null for a refusal that is not a citation (then today's repair only). */
export function savIntakeCitationRepairText(failure: { reason: string; path: string } | undefined): string | null {
  const hint = failure ? CITATION_HINTS[failure.reason] : undefined;
  if (!failure || !hint) return null;
  const path = failure.path.replace(/[^A-Za-z0-9_.[\]-]/g, "").slice(0, 120);
  return `\nCITATION REPAIR v1: the server refused your previous answer (${failure.reason} at ${path}). ${hint} Every other rule still applies; never invent a fact or a quote.`;
}

/** The newest messages of a thread, oldest first, plus the messages that must stay citable; and how many were left out. */
export function savIntakeBoundConversation<T extends { id: string }>(conversation: readonly T[], keepIds: readonly (string | undefined)[], max = SAV_INTAKE_CONVERSATION_MAX) {
  if (conversation.length <= max) return { messages: [...conversation], omitted: 0 };
  const keep = new Set(keepIds.filter((id): id is string => Boolean(id)));
  const newest = new Set(conversation.slice(-max).map(m => m.id));
  const messages = conversation.filter(m => newest.has(m.id) || keep.has(m.id));
  return { messages, omitted: conversation.length - messages.length };
}

/** « Quel ticket ? » with SAV_INTAKE_TICKET_DECIDE: decides the comparison when the model's own judgement is unambiguous. Mutates the assessment and
 * returns true when it decided: exactly one open or new ticket judged `same` (every other ticket becomes `different`), or every ticket `different`. */
export function savIntakeDecideTicketChoice(assessment: { investigationComplete: boolean; tickets: { ticketId: string; relation: string }[] },
  stageOf: (ticketId: string) => string | undefined): boolean {
  if (!assessment.tickets.length) return false;
  const openSame = assessment.tickets.filter(t => t.relation === "same" && ["open", "new"].includes(stageOf(t.ticketId) ?? ""));
  if (openSame.length === 1) {
    for (const match of assessment.tickets) if (match !== openSame[0]) match.relation = "different";
    assessment.investigationComplete = true;
    return true;
  }
  if (assessment.tickets.every(t => t.relation === "different")) { assessment.investigationComplete = true; return true; }
  return false;
}
