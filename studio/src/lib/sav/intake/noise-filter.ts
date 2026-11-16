import { createHash } from "node:crypto";

/**
 * SAV-92 (audit item 6, V1-NOISE-FILTER). Deterministic filter for automatic mails (newsletters,
 * delivery-status reports, absence autoreplies, system alerts) decided BEFORE the V1 model.
 *
 * Product rule: a real customer mail must never be filtered. Missing a customer is far worse than
 * letting noise through, so every exclusion guard wins over every signal and any missing evidence
 * keeps the mail on the normal SAV path. No model, no network, no free text is ever a signal:
 * only stored Gmail headers and the sender address. Pure: safe for tests and offline replay.
 */
export const SAV_INTAKE_NOISE_FILTER_REVISION = "sav-intake-noise-filter.v2";

export const SAV_INTAKE_NOISE_FILTER_MODES = ["off", "observe", "on"] as const;
export type SavIntakeNoiseFilterMode = typeof SAV_INTAKE_NOISE_FILTER_MODES[number];
/** Absent means off. Any value other than off|observe|on is a configuration error, never a silent default. */
export function savIntakeNoiseFilterMode(env: Record<string, string | undefined>): SavIntakeNoiseFilterMode {
  const value = env.SAV_INTAKE_NOISE_FILTER ?? "off";
  if (!(SAV_INTAKE_NOISE_FILTER_MODES as readonly string[]).includes(value)) throw Error("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  return value as SavIntakeNoiseFilterMode;
}

/** Closed list of rules, in priority order (the first one present is the verdict's reason).
 * STRONG rules: the only ones that can route a mail to "Autre" (mode on).
 * - DELIVERY_STATUS: Content-Type multipart/report; report-type=delivery-status (RFC 3464 DSN).
 * - MAILER_DAEMON: sender mailer-daemon@ AND a machine header (delivery-status report, or Auto-Submitted
 *   other than "no") AND a non-delivery wording in the subject or body. postmaster@ is always weak: a person
 *   may write from it.
 * - AUTO_REPLIED: Auto-Submitted is exactly "auto-replied" (RFC 3834) AND an absence/autoreply wording
 *   in the subject or body.
 * WEAK rules: recorded for measurement only (observe and on), they NEVER route a mail. A group alias, a
 * helpdesk or a redirection may add them to a mail written by a person.
 * - WEAK_LIST_HEADERS: List-Id or List-Unsubscribe.
 * - WEAK_PRECEDENCE: Precedence bulk | junk | list.
 * - WEAK_AUTO_GENERATED: Auto-Submitted: auto-generated.
 * - WEAK_AUTO_SUBMITTED_OTHER: another Auto-Submitted keyword (other than "no"), or auto-replied without wording.
 * - WEAK_X_AUTOREPLY: X-Autoreply or X-Autorespond.
 * - WEAK_DAEMON_SENDER: postmaster@ (always), or mailer-daemon@ without a machine header or without wording. */
export const SAV_INTAKE_NOISE_STRONG_REASONS = ["SAV_NOISE_DELIVERY_STATUS", "SAV_NOISE_MAILER_DAEMON", "SAV_NOISE_AUTO_REPLIED"] as const;
export const SAV_INTAKE_NOISE_WEAK_REASONS = ["SAV_NOISE_WEAK_LIST_HEADERS", "SAV_NOISE_WEAK_PRECEDENCE", "SAV_NOISE_WEAK_AUTO_GENERATED",
  "SAV_NOISE_WEAK_AUTO_SUBMITTED_OTHER", "SAV_NOISE_WEAK_X_AUTOREPLY", "SAV_NOISE_WEAK_DAEMON_SENDER"] as const;
export const SAV_INTAKE_NOISE_REASONS = [...SAV_INTAKE_NOISE_STRONG_REASONS, ...SAV_INTAKE_NOISE_WEAK_REASONS] as const;
export type SavIntakeNoiseReason = typeof SAV_INTAKE_NOISE_REASONS[number];
const strongReasons = new Set<SavIntakeNoiseReason>(SAV_INTAKE_NOISE_STRONG_REASONS);

/** Closed list of reasons to keep a mail on the normal path, in evaluation order. */
export const SAV_INTAKE_NOISE_GUARDS = [
  "SAV_NOISE_KEEP_NO_SIGNAL", // no rule at all
  "SAV_NOISE_GUARD_NOT_INBOUND", // only an inbound mail can be filtered
  "SAV_NOISE_GUARD_HUMAN_CONTEXT", // operator information, human choice, pause, human request, prior open request
  "SAV_NOISE_GUARD_THREAD_TICKET", // the SAV thread is already linked to a ticket
  "SAV_NOISE_GUARD_THREAD_HISTORY", // the SAV thread already holds another message
  "SAV_NOISE_GUARD_SUPPORT_REPLY", // reply to the mailbox (quote header), or reply prefix / In-Reply-To / References without a strong rule
  "SAV_NOISE_GUARD_FORWARD", // forward prefix: a person may be asking about it
  "SAV_NOISE_GUARD_REPLY_TO", // Reply-To differs from From: someone expects an answer (forms, helpdesks)
  "SAV_NOISE_GUARD_ATTACHMENTS", // attachments outside a delivery-status report
  "SAV_NOISE_GUARD_SENSITIVE", // finance / cancellation vocabulary: always a person
  "SAV_NOISE_GUARD_FORM_OR_QUOTE", // contact form notification or quoted human conversation
  "SAV_NOISE_GUARD_SENDER_UNKNOWN", // sender history unreadable: never filter blind
  "SAV_NOISE_GUARD_EVIDENCE_UNAVAILABLE", // a local read (thread, mailbox) failed: never filter blind
  "SAV_NOISE_GUARD_KNOWN_SENDER", // support mail to that address, ticketed thread, or a prior inbound not itself classified automatic
  "SAV_NOISE_KEEP_WEAK_ONLY", // only weak rules: measured, never routed
] as const;
export type SavIntakeNoiseGuard = typeof SAV_INTAKE_NOISE_GUARDS[number];

export type SavIntakeNoiseSenderHistory = {
  /** Other inbound mails stored from this address (any thread of the mailbox). */
  priorInbound: number;
  /** Among them, those NOT proven automatic: not projected in "Autre" (qualified_other), or with a human
   * event, or in a ticketed thread. Only a strong rule may ignore the proven-automatic ones. */
  priorInboundNotAutomatic: number;
  /** Outbound mails of the mailbox sent to this address. */
  outboundTo: number;
  /** SAV threads of this address linked to a HubSpot ticket (local proxy for a known contact). */
  ticketThreads: number;
};
export type SavIntakeNoiseInput = {
  messageId: string; direction: string; fromEmail: string; subject: string; bodyText: string;
  headers: Record<string, string> | null | undefined; attachmentCount: number;
  context: { conversationLength: number; threadTicketId: string | null; humanContext: boolean; quotedMailboxReply: boolean };
  /** undefined: not read yet (the verdict asks for it); null: unreadable (keeps the mail). */
  senderHistory?: SavIntakeNoiseSenderHistory | null;
};
export type SavIntakeNoiseVerdict = {
  revision: typeof SAV_INTAKE_NOISE_FILTER_REVISION;
  /** Only "noise" can route, and only from a strong rule. */
  verdict: "noise" | "keep";
  /** Highest-priority rule present (strong first), also kept when a guard keeps the mail (for observation). */
  reason: SavIntakeNoiseReason | null;
  strength: "strong" | "weak" | null;
  /** Every rule present: codes only, never a header value, address or text. */
  signals: SavIntakeNoiseReason[];
  guard: SavIntakeNoiseGuard | null;
  /** True when only the sender history is missing for a decision. */
  needsSenderHistory?: true;
};

const deliveryReport = /^multipart\/report\s*;(?:[^;]*;)*\s*report-type\s*=\s*"?delivery-status"?\s*(?:;|$)/i;
const mailerDaemonLocal = /^mailer[-_.]?daemon$/;
const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
// Wordings checked on folded text (no accents, lower case).
const nonDelivery = /delivery status notification|undeliverable|undelivered|delivery (?:has )?failed|mail delivery (?:failed|subsystem)|could ?n[o']t be delivered|could not be delivered|address not found|returned mail|message not delivered|non remis|n'a pas pu etre (?:remis|distribue|livre|delivre)|echec de (?:la )?(?:remise|livraison|distribution)|adresse introuvable|user unknown|mailbox unavailable/;
const autoReplyWording = /\b(?:absente?s?|absence|out of (?:the )?office|reponse automatique|automatic reply|auto[- ]?reply|autoreply|en conges?|en vacances|on vacation|on leave|away from (?:the )?office)\b/;
// Finance and cancellation always go to a person, wherever they appear (subject or any part of the body).
const sensitive = /rembours|factur|paiement|prelevement|impaye|carte bancaire|virement|avoir sur|echeanc|recouvrement|mise en demeure|huissier|litige|resili|annul\w*\s+(?:de\s+|d'|mon\s+|ma\s+|l'|votre\s+|notre\s+)?(?:abonnement|commande|contrat|compte)|(?:arret|fin|suspension|stop)\w*\s+(?:de\s+|d'|mon\s+|l'|votre\s+)?(?:abonnement|contrat)|\b(?:invoice|refund|chargeback|billing|payment|cancel(?:lation|led)?|terminate|termination)\b/;
const formOrQuote = /formulaire|form submission|new submission|nouvelle soumission|demande de contact|contact request|nouveau message de|new message from|\ba ecrit\s*:|\bwrote\s*:|-----\s*(?:original message|message d'origine)/;
const replyPrefix = /^\s*(?:re|rep|reponse|aw|sv|antw)\s*:/;
const forwardPrefix = /^\s*(?:tr|fw|fwd|wg|rv)\s*:/;

const localPart = (address: string) => address.trim().toLowerCase().split("@")[0] ?? "";

/** Rule codes present in the stored headers, the sender and (for strong rules only) a fixed wording. */
export function savIntakeNoiseSignals(input: Pick<SavIntakeNoiseInput, "fromEmail" | "headers"> & { subject?: string; bodyText?: string }): SavIntakeNoiseReason[] {
  const headers = input.headers && typeof input.headers === "object" && !Array.isArray(input.headers) ? input.headers : {};
  const header = (name: string) => { const value = headers[name]; return typeof value === "string" ? value.trim() : ""; };
  // Auto-Submitted and Content-Type count only when the Gmail parser stored them unambiguously (one header each).
  const parsed = header("x-studio-automation-headers") === "singleton-v1";
  // The newer list/precedence/autoreply headers count only when the parser captured them (marker v1).
  const captured = header("x-studio-noise-headers") === "v1";
  const text = `${fold(input.subject ?? "")}\n${fold(input.bodyText ?? "")}`;
  const signals = new Set<SavIntakeNoiseReason>();
  const report = parsed && deliveryReport.test(header("content-type"));
  if (report) signals.add("SAV_NOISE_DELIVERY_STATUS");
  const autoSubmitted = parsed ? header("auto-submitted") : "";
  // RFC 3834: one keyword, optional parameters. Anything else (lists, unknown keywords) is weak.
  const keyword = /^([a-z-]+)\s*(?:;[^,]*)?$/i.exec(autoSubmitted)?.[1].toLowerCase();
  const local = localPart(input.fromEmail);
  // A sender address alone is never proof: mailer-daemon needs a machine header and the wording; postmaster stays weak.
  if (mailerDaemonLocal.test(local)) signals.add((report || autoSubmitted && keyword !== "no") && nonDelivery.test(text) ? "SAV_NOISE_MAILER_DAEMON" : "SAV_NOISE_WEAK_DAEMON_SENDER");
  else if (local === "postmaster") signals.add("SAV_NOISE_WEAK_DAEMON_SENDER");
  if (autoSubmitted && keyword !== "no") {
    if (keyword === "auto-replied" && autoReplyWording.test(text)) signals.add("SAV_NOISE_AUTO_REPLIED");
    else if (keyword === "auto-generated") signals.add("SAV_NOISE_WEAK_AUTO_GENERATED");
    else signals.add("SAV_NOISE_WEAK_AUTO_SUBMITTED_OTHER");
  }
  if (captured) {
    if (header("list-id") || header("list-unsubscribe") === "present") signals.add("SAV_NOISE_WEAK_LIST_HEADERS");
    if (/^(?:bulk|junk|list)\s*$/i.test(header("precedence"))) signals.add("SAV_NOISE_WEAK_PRECEDENCE");
    if (header("x-autoreply") || header("x-autorespond")) signals.add("SAV_NOISE_WEAK_X_AUTOREPLY");
  }
  return SAV_INTAKE_NOISE_REASONS.filter(code => signals.has(code));
}

/** The whole decision. Guards always win; "when in doubt, keep"; a weak rule never routes. */
export function savIntakeNoiseVerdict(input: SavIntakeNoiseInput): SavIntakeNoiseVerdict {
  const signals = savIntakeNoiseSignals(input);
  const reason = signals[0] ?? null;
  const strong = reason !== null && strongReasons.has(reason);
  const strength = reason === null ? null : strong ? "strong" as const : "weak" as const;
  const keep = (guard: SavIntakeNoiseGuard, extra: { needsSenderHistory?: true } = {}): SavIntakeNoiseVerdict =>
    ({ revision: SAV_INTAKE_NOISE_FILTER_REVISION, verdict: "keep", reason, strength, signals, guard, ...extra });
  if (!reason) return keep("SAV_NOISE_KEEP_NO_SIGNAL");
  if (input.direction !== "inbound") return keep("SAV_NOISE_GUARD_NOT_INBOUND");
  const { context } = input;
  if (context.humanContext) return keep("SAV_NOISE_GUARD_HUMAN_CONTEXT");
  if (context.threadTicketId) return keep("SAV_NOISE_GUARD_THREAD_TICKET");
  if (context.conversationLength !== 1) return keep("SAV_NOISE_GUARD_THREAD_HISTORY");
  const headers = input.headers ?? {};
  const header = (name: string) => typeof headers[name] === "string" ? headers[name].trim() : "";
  const subject = fold(input.subject ?? ""), body = fold(input.bodyText ?? "");
  // A proven bounce or absence reply is by nature a reply; nothing else may carry reply markers.
  if (context.quotedMailboxReply || !strong && (replyPrefix.test(subject) || header("in-reply-to") || header("references"))) return keep("SAV_NOISE_GUARD_SUPPORT_REPLY");
  if (forwardPrefix.test(subject)) return keep("SAV_NOISE_GUARD_FORWARD");
  if (header("x-studio-noise-headers") === "v1" && header("x-studio-reply-to") === "differs") return keep("SAV_NOISE_GUARD_REPLY_TO");
  // Only a delivery-status report legitimately carries the original message as a part.
  if (input.attachmentCount > 0 && reason !== "SAV_NOISE_DELIVERY_STATUS") return keep("SAV_NOISE_GUARD_ATTACHMENTS");
  if (sensitive.test(subject) || sensitive.test(body)) return keep("SAV_NOISE_GUARD_SENSITIVE");
  if (formOrQuote.test(subject) || formOrQuote.test(body)) return keep("SAV_NOISE_GUARD_FORM_OR_QUOTE");
  if (input.senderHistory === undefined) return keep("SAV_NOISE_GUARD_SENDER_UNKNOWN", { needsSenderHistory: true });
  const history = input.senderHistory;
  if (!history || ![history.priorInbound, history.priorInboundNotAutomatic, history.outboundTo, history.ticketThreads].every(n => Number.isSafeInteger(n) && n >= 0)
    || history.priorInboundNotAutomatic > history.priorInbound) return keep("SAV_NOISE_GUARD_SENDER_UNKNOWN");
  // Prior mails proven automatic (all in "Autre", no ticket, no human event) are ignored for a strong rule only.
  if (history.outboundTo > 0 || history.ticketThreads > 0 || (strong ? history.priorInboundNotAutomatic : history.priorInbound) > 0) return keep("SAV_NOISE_GUARD_KNOWN_SENDER");
  if (!strong) return keep("SAV_NOISE_KEEP_WEAK_ONLY");
  return { revision: SAV_INTAKE_NOISE_FILTER_REVISION, verdict: "noise", reason, strength, signals, guard: null };
}

/** The code-defined rule set, as the classification rule of a filtered dossier (not a private catalogue). */
export const SAV_INTAKE_NOISE_RESOURCE = Object.freeze({
  resourceId: "sav-intake-noise-filter",
  revisionId: SAV_INTAKE_NOISE_FILTER_REVISION,
  sha256: createHash("sha256").update(JSON.stringify({ revision: SAV_INTAKE_NOISE_FILTER_REVISION, reasons: SAV_INTAKE_NOISE_REASONS, guards: SAV_INTAKE_NOISE_GUARDS })).digest("hex"),
});

/** Log line for observation: message id and codes only, never an address, subject, header value or text. */
export function savIntakeNoiseLogLine(mode: Exclude<SavIntakeNoiseFilterMode, "off">, messageId: string, verdict: SavIntakeNoiseVerdict,
  routed = mode === "on" && verdict.verdict === "noise") {
  return JSON.stringify({ event: "sav_intake_noise_filter", revision: verdict.revision, mode, messageId, verdict: verdict.verdict,
    reason: verdict.reason, strength: verdict.strength, guard: verdict.guard, signals: verdict.signals, routed });
}

/** Offline replay: counts per stored view, verdict, reason and guard. Input carries no text back out. */
export type SavIntakeNoiseReplayRecord = { messageId: string; view: string | null; verdict: SavIntakeNoiseVerdict };
export function summarizeSavIntakeNoiseReplay(records: readonly SavIntakeNoiseReplayRecord[]) {
  // undefined: not counted; null: counted as "none".
  const count = (pick: (r: SavIntakeNoiseReplayRecord) => string | null | undefined) => {
    const out: Record<string, number> = {};
    for (const r of records) { const picked = pick(r); if (picked === undefined) continue; const key = picked ?? "none"; out[key] = (out[key] ?? 0) + 1; }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const noise = records.filter(r => r.verdict.verdict === "noise");
  return {
    revision: SAV_INTAKE_NOISE_FILTER_REVISION, total: records.length,
    byView: count(r => r.view),
    byVerdict: count(r => r.verdict.verdict),
    noiseByReason: count(r => r.verdict.verdict === "noise" ? r.verdict.reason : undefined),
    noiseByView: count(r => r.verdict.verdict === "noise" ? r.view : undefined),
    // Weak rules alone, cleared by every guard: what a looser policy would route. Never routed.
    weakOnlyByReason: count(r => r.verdict.guard === "SAV_NOISE_KEEP_WEAK_ONLY" ? r.verdict.reason : undefined),
    // Signals present but kept by a guard: what a looser rule would add, never filtered.
    keptWithSignalByGuard: count(r => r.verdict.verdict === "keep" && r.verdict.reason && r.verdict.guard !== "SAV_NOISE_KEEP_WEAK_ONLY" ? r.verdict.guard : undefined),
    signalCounts: Object.fromEntries(SAV_INTAKE_NOISE_REASONS.map(code => [code, records.filter(r => r.verdict.signals.includes(code)).length])),
    // To review by hand before any "on": every mail the filter would route out of "to_validate".
    noiseFromToValidate: noise.filter(r => r.view === "to_validate").map(r => r.messageId),
  };
}
