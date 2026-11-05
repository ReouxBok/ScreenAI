// V2 human handoff notice (local, OFF): the PURE part. When V2 has taken a case, investigated it and its accepted decision is to hand the case to the team,
// the team gets ONE Slack notice per handoff, in one template for every kind of ticket. Nothing here reads, sends or writes: it decides WHETHER a stored case
// holds such a final decision (the only trigger), WHAT the notice says (from the stored decision and the CRM facts a caller verified, never from a mail),
// and the key, the marker and the intent the existing executor protocol dispatches and verifies.
//   trigger   the latest investigation record of the case holds an ACCEPTED decision whose next action is `handoff`, no newer input or person since
//   content   need, what was tried and how it ended, reason, next human action; contact and ticket links only when verified against the CRM
//   no alert  a resolved case, a question to the customer, a draft to validate, a refused or reviewed decision, an out-of-scope or withdrawn case, a retry in
//             progress: none of these is a handoff decision, so none has a trigger
// Free text is cut, stripped of e-mail addresses, links, long codes and Slack control characters, so a notice can neither copy a mail nor carry a secret.
import { createHash } from "node:crypto";
import { crmRecordUrl } from "../intake/crm-display";
import type { EffectIntent } from "../intake/execution-types";
import type { CaseSnapshot, CaseTrial } from "./case-types";
import { SAV_CASE_EFFECT_PERMISSIONS } from "./case-effects";
import { investigationHandoffCommand, readCaseInvestigationProgress, SAV_CASE_INVESTIGATION_RECORD_KIND, type CaseInvestigationJournalEvent } from "./investigation-record";

export const HANDOFF_NOTICE_CONTRACT = "sav-v2-handoff-notice.v1";
export const HANDOFF_NOTICE_TITLE = "Nouveau ticket à transmettre à l'équipe";
/** The reply key of the case execution that hosts a notice, and the business key of its one effect. */
export const HANDOFF_NOTICE_KEY_PREFIX = "handoff-notice:";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_KEY = /^(in|back):[A-Za-z0-9._@<>=+-]{1,200}$/;
/** One notice per final handoff decision: the case and the input the decision answers. A new customer mail is a new input, hence a new decision and a new key. */
export function handoffNoticeKey(caseId: string, inputKey: string): string {
  if (!UUID.test(caseId) || !INPUT_KEY.test(inputKey)) throw new Error("SAV_HANDOFF_NOTICE_KEY_INVALID");
  return `${HANDOFF_NOTICE_KEY_PREFIX}${caseId.toLowerCase()}:${inputKey}`;
}
/** What the notice carries so a reader of the channel (and the verification) can tie the message to its key without the key itself. */
export const handoffNoticeMarker = (key: string) => `HO-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
// Not `\b`: the rendered marker sits between underscores (Slack italics), which are word characters.
const MARKER = /(?<![A-Za-z0-9])HO-[0-9a-f]{12}(?![A-Za-z0-9])/;
export const handoffNoticeMarkerIn = (text: string): string | null => MARKER.exec(text)?.[0] ?? null;

// ---------------------------------------------------------------------------------------------------------------------------------
// Configuration: injected, fail closed
// ---------------------------------------------------------------------------------------------------------------------------------

export type HandoffNoticeConfig =
  | Readonly<{ mode: "off"; why: "disabled" | "token_missing" | "channel_invalid" | "owner_invalid" | "portal_invalid" }>
  | Readonly<{ mode: "on"; channel: string; teamOwnerId: string | null; portalId: string | null }>;
const SLACK_CHANNEL = /^C[A-Z0-9]{8,14}$/, NUMERIC = /^[0-9]{1,30}$/, SLACK_BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,200}$/;

/**
 * Only the exact string `on` enables the notice. The channel, the bot token, the team owner and the HubSpot portal are all injected (nothing is read from a file or
 * committed): a value that is present and malformed is a refusal (`off`), never a guess; the token itself is not returned, the Slack adapter reads it from the same env.
 */
export function readHandoffNoticeConfig(env: Readonly<Record<string, string | undefined>>): HandoffNoticeConfig {
  if (env.SAV_HANDOFF_NOTICE !== "on") return { mode: "off", why: "disabled" };
  if (!SLACK_BOT_TOKEN.test(env.SAV_HANDOFF_SLACK_BOT_TOKEN ?? "")) return { mode: "off", why: "token_missing" };
  if (!SLACK_CHANNEL.test(env.SAV_HANDOFF_SLACK_CHANNEL_ID ?? "")) return { mode: "off", why: "channel_invalid" };
  const owner = env.SAV_HANDOFF_TEAM_OWNER_ID, portal = env.HUBSPOT_PORTAL_ID;
  if (owner !== undefined && owner !== "" && !NUMERIC.test(owner)) return { mode: "off", why: "owner_invalid" };
  if (portal !== undefined && portal !== "" && !NUMERIC.test(portal)) return { mode: "off", why: "portal_invalid" };
  return { mode: "on", channel: env.SAV_HANDOFF_SLACK_CHANNEL_ID!, teamOwnerId: owner ? owner : null, portalId: portal ? portal : null };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------------------------------------------------------------

export const HANDOFF_REASONS = ["explicit_human_request", "sensitive_request", "knowledge_missing", "knowledge_conflict", "evidence_inaccessible", "diagnosis_out_of_tools", "repeated_failure"] as const;
export type HandoffReason = typeof HANDOFF_REASONS[number];
export const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  explicit_human_request: "le client demande à parler à une personne",
  sensitive_request: "demande sensible, réservée à l'équipe",
  knowledge_missing: "aucune fiche de connaissance ne couvre la demande",
  knowledge_conflict: "des fiches de connaissance se contredisent",
  evidence_inaccessible: "un élément nécessaire au diagnostic n'est pas accessible à l'agent",
  diagnosis_out_of_tools: "le diagnostic dépasse les outils de l'agent",
  repeated_failure: "les essais de l'agent ont échoué à répétition",
};

export type HandoffTriggerRefusal = "no_record" | "no_decision" | "not_handoff" | "not_accepted" | "stale_input" | "taken_by_person";
export type HandoffNoticeTrigger = Readonly<{
  ok: true; caseId: string; ticketId: string; inputKey: string;
  /** Case version of the event that persisted the decision: whatever happens to the case after it makes the decision stale. */
  recordedAtVersion: number; reason: HandoffReason;
  report: Readonly<{ need: string; expected: string | null; observed: string | null; trialIds: readonly string[]; hypotheses: readonly string[]; missingInformation: readonly string[]; expectedIntervention: string }>;
}> | Readonly<{ ok: false; why: HandoffTriggerRefusal }>;

/** Events after the decision that make it no longer the final word: a newer customer mail, a newer investigation, a person's command, an owner change. */
export function staleHandoffEventKinds(transferred: boolean) {
  const kinds = ["observation_recorded", "human_command", "owner_changed"];
  // A customer follow-up belongs to the pending human case after durable transfer.
  if (!transferred) kinds.push("inbound_confirmed");
  return kinds;
}

export function awaitingHandoff(snapshot: Pick<CaseSnapshot, "owner" | "phase" | "body">, reason: HandoffReason) {
  return snapshot.owner === "human" && snapshot.phase === "handoff_pending" && snapshot.body.handoff?.reason === reason && !snapshot.body.handoff.humanSince;
}

/**
 * The ONE trigger. The latest investigation record of the case must hold a decision that passed the validator (`accepted`: not one sent to review, not a refusal) whose
 * next action is a handoff, persisted by the claim that took the case; and nothing may have happened to the case since (a newer mail or investigation re-opens the
 * question, a person already took it). A case a person had from the start, one never taken by V2 and one out of scope have no investigation record, hence no trigger.
 */
export function handoffNoticeTrigger(snapshot: Pick<CaseSnapshot, "caseId" | "ticketId" | "body" | "owner" | "phase">, events: readonly CaseInvestigationJournalEvent[]): HandoffNoticeTrigger {
  const latest = events.filter(event => event.kind === "observation_recorded" && (event.detail?.record as { kind?: unknown } | undefined)?.kind === SAV_CASE_INVESTIGATION_RECORD_KIND)
    .sort((a, b) => b.caseVersion - a.caseVersion)[0];
  const inputKey = (latest?.detail?.record as { inputKey?: unknown } | undefined)?.inputKey;
  if (!latest || typeof inputKey !== "string") return { ok: false, why: "no_record" };
  const read = readCaseInvestigationProgress(events, inputKey);
  if (read.state !== "found" || read.caseVersion !== latest.caseVersion) return { ok: false, why: "no_record" };
  const decision = read.record.decision;
  if (!decision) return { ok: false, why: "no_decision" };
  if (decision.validation.outcome !== "accepted") return { ok: false, why: "not_accepted" };
  const action = decision.validation.decision.nextAction;
  if (action.kind !== "handoff") return { ok: false, why: "not_handoff" };
  if (snapshot.body.handoff?.humanSince) return { ok: false, why: "taken_by_person" };
  if (latest.detail?.applied === false) return { ok: false, why: "stale_input" };
  // Only a matching, committed transfer lets new mail wait for the human team.
  const transferred = events.find(event => event.caseVersion === read.caseVersion + 1 && event.kind === "owner_changed"
    && event.dedupeKey === "cmd:" + investigationHandoffCommand(read.caseVersion)
    && event.detail?.transition === "handoff" && event.detail.reason === action.reason);
  const recordedAtVersion = transferred?.caseVersion ?? read.caseVersion;
  const staleKinds = staleHandoffEventKinds(Boolean(transferred) && awaitingHandoff(snapshot, action.reason));
  if (events.some(event => event.caseVersion > recordedAtVersion && staleKinds.includes(event.kind))) return { ok: false, why: "stale_input" };
  if (!INPUT_KEY.test(inputKey)) return { ok: false, why: "no_record" };
  const { report } = action;
  return { ok: true, caseId: snapshot.caseId, ticketId: snapshot.ticketId, inputKey, recordedAtVersion, reason: action.reason,
    report: { need: report.need, expected: report.expected, observed: report.observed, trialIds: report.trialIds, hypotheses: report.hypotheses,
      missingInformation: report.missingInformation, expectedIntervention: report.expectedIntervention } };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The content
// ---------------------------------------------------------------------------------------------------------------------------------

const NOTICE_LIMITS = { need: 400, line: 240, intervention: 400, hypotheses: 3, trials: 5, missing: 5, text: 3500 } as const;
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi;
// A long run of letters and digits mixing both is a code, a token or an identifier of a person's account, never a sentence.
const CODE = /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
const LONG_NUMBER = /\b(?:[0-9][ .]?){9,}[0-9]\b/g;
// A secret by its SHAPE (tokens of the providers we use or know, bearer headers, long hexadecimal, IBAN) or by its WORD (« le code est 718236 », « mot de passe : x », « token=abc »).
const SECRET_SHAPE = /\b(?:xox[abprs]-|xapp-|sk-|ghp_|gho_|github_pat_|AKIA|eyJ)[A-Za-z0-9._-]{6,}/g;
const BEARER = /\bBearer\s+\S+/gi;
const HEX = /\b(?=[0-9a-f]*[0-9])[0-9a-f]{24,}\b/gi;
const IBAN = /\b[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g;
const SECRET_WORD = "code|otp|pin|passcode|mot de passe|mots de passe|password|mdp|token|jeton|secret|cl[ée]";
const SECRET_GIVEN = new RegExp(`\\b(?:${SECRET_WORD})\\b(?:\\s+(?:de|d['’]|du|des)\\s*\\p{L}+)*\\s*(?:est|is|:|=)\\s*\\S+`, "giu");
const SECRET_NAMED = new RegExp(`\\b(?:${SECRET_WORD})\\b(?:\\s+(?:de|d['’]|du|des)\\s*\\p{L}+)*\\s+(?=\\S*[0-9])(?=\\S*\\p{L})[\\p{L}0-9-]{4,}`, "giu");
// Three digits or more in a row (a code, a phone number, a card, an account): never kept in free text. One or two digits (« 3 essais ») are.
const NUMBER = /(?<![\p{L}0-9])(?:[0-9][ .\-]?){2,}[0-9](?![\p{L}0-9])/gu;

/**
 * Free text of the decision (written by the model from the case) or of the CRM (a name), made safe for the channel: one line, no address, link, token, code, secret named
 * by its word, or number of three digits or more (a one-time code, a phone number, a card), nothing Slack would interpret (mentions, links, formatting), cut at `max`.
 * Whatever is removed is replaced by a neutral word, so a reader knows something was. Idempotent: a text already made safe comes out unchanged.
 */
export function sanitizeNoticeText(value: string, max: number = NOTICE_LIMITS.line): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(EMAIL, "[adresse masquée]").replace(LINK, "[lien masqué]").replace(SECRET_SHAPE, "[code masqué]").replace(BEARER, "[code masqué]")
    .replace(SECRET_GIVEN, "[code masqué]").replace(SECRET_NAMED, "[code masqué]").replace(HEX, "[code masqué]").replace(CODE, "[code masqué]")
    .replace(IBAN, "[numéro masqué]").replace(LONG_NUMBER, "[numéro masqué]").replace(NUMBER, "[numéro masqué]")
    .replace(/<[!@#][^>]*>/g, " ").replace(/&/g, "et").replace(/[<>]/g, " ").replace(/[*_~`|@#]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * The same cleaning applied to facts that were sealed BEFORE a rule existed (a historical execution): every free field is made safe again when the notice is rendered.
 * Structured fields (reason, trials by identifier and outcome, counts) are not free text and are untouched.
 */
export function resanitizeNoticeFacts(facts: HandoffNoticeFacts): HandoffNoticeFacts {
  const one = (value: string | null, max: number) => value === null ? null : sanitizeNoticeText(value, max) || null;
  return { ...facts, need: sanitizeNoticeText(facts.need, NOTICE_LIMITS.need), expected: one(facts.expected, NOTICE_LIMITS.line), observed: one(facts.observed, NOTICE_LIMITS.line),
    hypotheses: facts.hypotheses.map(item => sanitizeNoticeText(item)).filter(Boolean), missingInformation: facts.missingInformation.map(item => sanitizeNoticeText(item, 160)).filter(Boolean),
    expectedIntervention: sanitizeNoticeText(facts.expectedIntervention, NOTICE_LIMITS.intervention) };
}

const OUTCOME_LABELS: Record<CaseTrial["outcome"], string> = { pending: "en attente de retour du client", failed: "échec", succeeded: "réussie", unknown: "résultat inconnu" };
export type HandoffNoticeFacts = Readonly<{
  contract: typeof HANDOFF_NOTICE_CONTRACT; caseId: string; ticketId: string; inputKey: string; recordedAtVersion: number; reason: HandoffReason;
  need: string; expected: string | null; observed: string | null; hypotheses: readonly string[]; missingInformation: readonly string[]; expectedIntervention: string;
  trials: ReadonlyArray<Readonly<{ knowledgeId: string; outcome: CaseTrial["outcome"] }>>; questionsAsked: number;
}>;

/** The sealed facts of a notice: the decision's report, the trials it cites and the questions already asked, all taken from the stored case and already made safe. */
export function handoffNoticeFacts(trigger: Extract<HandoffNoticeTrigger, { ok: true }>, body: Pick<CaseSnapshot["body"], "trials" | "questions">): HandoffNoticeFacts {
  const cited = new Set(trigger.report.trialIds);
  // A knowledge id is our own structured identifier, not free text: it is kept as is when it has the shape of one, and masked otherwise.
  const knowledgeId = (id: string) => /^[A-Za-z0-9._-]{1,80}$/.test(id) ? id : "[identifiant masqué]";
  const trials = body.trials.filter(trial => cited.has(trial.id)).map(trial => ({ knowledgeId: knowledgeId(trial.procedure.knowledgeId), outcome: trial.outcome }));
  const one = (value: string | null, max: number) => value === null ? null : sanitizeNoticeText(value, max) || null;
  return {
    contract: HANDOFF_NOTICE_CONTRACT, caseId: trigger.caseId, ticketId: trigger.ticketId, inputKey: trigger.inputKey, recordedAtVersion: trigger.recordedAtVersion, reason: trigger.reason,
    need: sanitizeNoticeText(trigger.report.need, NOTICE_LIMITS.need), expected: one(trigger.report.expected, NOTICE_LIMITS.line), observed: one(trigger.report.observed, NOTICE_LIMITS.line),
    hypotheses: trigger.report.hypotheses.slice(0, NOTICE_LIMITS.hypotheses).map(item => sanitizeNoticeText(item)).filter(Boolean),
    missingInformation: trigger.report.missingInformation.slice(0, NOTICE_LIMITS.missing).map(item => sanitizeNoticeText(item, 160)).filter(Boolean),
    expectedIntervention: sanitizeNoticeText(trigger.report.expectedIntervention, NOTICE_LIMITS.intervention),
    trials, questionsAsked: body.questions.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// CRM verification (the reading is the caller's; the judgement is here)
// ---------------------------------------------------------------------------------------------------------------------------------

/** What a read-only CRM reading of the case's ticket gave back: the ticket, and the contacts associated to it with the addresses they carry. */
export type HandoffCrmReading = Readonly<{
  ticket: Readonly<{ id: string; archived: boolean }> | null;
  contacts: ReadonlyArray<Readonly<{ id: string; firstname: string | null; lastname: string | null; emails: readonly string[]; archived: boolean }>>;
}>;
export type HandoffContactVerdict = Readonly<{ status: "verified"; id: string; name: string | null }> | Readonly<{ status: "unverified"; why: "ticket_not_found" | "no_matching_contact" | "several_matching_contacts" | "customer_address_unknown" }>;
export type HandoffTicketVerdict = Readonly<{ status: "verified"; id: string }> | Readonly<{ status: "unverified"; why: "ticket_not_found" }>;
export type HandoffCrmVerdict = Readonly<{ contact: HandoffContactVerdict; ticket: HandoffTicketVerdict }>;

const lower = (value: string) => value.trim().toLowerCase();
/**
 * A link is only shown for what the CRM confirmed: the ticket exists (not archived) under the case's own ticket id, and EXACTLY ONE contact associated to that ticket
 * carries the customer's address of the thread. A name or a company never creates the relation; several matches, none, or an unknown address leave the contact unverified.
 */
export function judgeHandoffCrm(reading: HandoffCrmReading, input: Readonly<{ ticketId: string; customerEmail: string | null }>): HandoffCrmVerdict {
  const ticketFound = reading.ticket !== null && reading.ticket.id === input.ticketId && !reading.ticket.archived;
  const ticket: HandoffTicketVerdict = ticketFound ? { status: "verified", id: input.ticketId } : { status: "unverified", why: "ticket_not_found" };
  if (!ticketFound) return { ticket, contact: { status: "unverified", why: "ticket_not_found" } };
  const address = input.customerEmail ? lower(input.customerEmail) : "";
  if (!address) return { ticket, contact: { status: "unverified", why: "customer_address_unknown" } };
  const matching = reading.contacts.filter(contact => !contact.archived && /^[0-9]{1,30}$/.test(contact.id) && contact.emails.some(email => lower(email) === address));
  if (matching.length === 0) return { ticket, contact: { status: "unverified", why: "no_matching_contact" } };
  if (matching.length > 1) return { ticket, contact: { status: "unverified", why: "several_matching_contacts" } };
  const [found] = matching;
  const name = sanitizeNoticeText([found!.firstname, found!.lastname].filter(Boolean).join(" "), 120);
  return { ticket, contact: { status: "verified", id: found!.id, name: name || null } };
}

const UNVERIFIED_LABELS: Record<Extract<HandoffContactVerdict, { status: "unverified" }>["why"], string> = {
  ticket_not_found: "ticket introuvable dans le CRM",
  no_matching_contact: "aucun contact du ticket ne porte l'adresse du client",
  several_matching_contacts: "plusieurs contacts du ticket portent l'adresse du client",
  customer_address_unknown: "adresse du client inconnue",
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------------------------------------------------------------

export type HandoffNoticeRender = Readonly<{ text: string; marker: string; key: string }>;

/** The notice, deterministic for its inputs: the same sealed facts and the same CRM verdict give the same bytes (a verification compares the marker, never the text). */
export function renderHandoffNotice(sealed: HandoffNoticeFacts, crm: HandoffCrmVerdict, portalId: string | null): HandoffNoticeRender {
  // Facts sealed under an older rule are cleaned again here: the text that leaves is never older than the rule.
  const facts = resanitizeNoticeFacts(sealed);
  const key = handoffNoticeKey(facts.caseId, facts.inputKey), marker = handoffNoticeMarker(key);
  const contactUrl = crm.contact.status === "verified" ? crmRecordUrl(portalId ?? undefined, "contact", crm.contact.id) : null;
  const ticketUrl = crm.ticket.status === "verified" ? crmRecordUrl(portalId ?? undefined, "ticket", crm.ticket.id) : null;
  const client = crm.contact.status === "verified"
    ? `${crm.contact.name ?? "Nom indisponible"} — ${contactUrl ? `<${contactUrl}|fiche contact HubSpot>` : "fiche contact vérifiée, lien indisponible (portail HubSpot non configuré)"}`
    : `contact non vérifié (${UNVERIFIED_LABELS[crm.contact.why]}), aucun lien proposé`;
  const ticket = crm.ticket.status === "verified"
    ? (ticketUrl ? `<${ticketUrl}|ticket ${crm.ticket.id}>` : `ticket ${crm.ticket.id} vérifié, lien indisponible (portail HubSpot non configuré)`)
    : `ticket non vérifié (${UNVERIFIED_LABELS.ticket_not_found}), aucun lien proposé`;
  const tried: string[] = [];
  facts.trials.slice(0, NOTICE_LIMITS.trials).forEach(trial => tried.push(`• Procédure ${trial.knowledgeId} : ${OUTCOME_LABELS[trial.outcome]}`));
  if (facts.trials.length > NOTICE_LIMITS.trials) tried.push(`• et ${facts.trials.length - NOTICE_LIMITS.trials} autre(s) procédure(s)`);
  if (facts.questionsAsked > 0) tried.push(`• ${facts.questionsAsked} question(s) posée(s) au client`);
  if (facts.expected) tried.push(`• Attendu : ${facts.expected}`);
  if (facts.observed) tried.push(`• Constaté : ${facts.observed}`);
  facts.hypotheses.forEach(item => tried.push(`• Hypothèse : ${item}`));
  if (!tried.length) tried.push("• Aucun essai enregistré avant le relais");
  const next = [facts.expectedIntervention || "à définir par l'équipe", ...(facts.missingInformation.length ? [`Informations manquantes : ${facts.missingInformation.join(" ; ")}`] : [])];
  const text = [
    `*${HANDOFF_NOTICE_TITLE}*`,
    `*Client :* ${client}`,
    `*Problème :* ${facts.need || "non précisé"}`,
    `*Ce que l'agent a tenté et le résultat :*\n${tried.join("\n")}`,
    `*Motif du relais :* ${HANDOFF_REASON_LABELS[facts.reason]}`,
    `*Ticket HubSpot :* ${ticket}`,
    `*Prochaine action proposée :* ${next.join(". ")}`,
    `_Réf. ${marker}_`,
  ].join("\n").slice(0, NOTICE_LIMITS.text);
  return { text, marker, key };
}

// The lines of the notice that carry free text, and the only links that may stay in it (the ones `renderHandoffNotice` builds from a CRM-verified id and the portal id).
const FREE_TEXT_LINE = /^(\*Problème :\* |• (?:Attendu|Constaté|Hypothèse) : |\*Prochaine action proposée :\* )(.*)$/;
const INTERNAL_LINK = /<https:\/\/app\.hubspot\.com\/contacts\/[0-9]{1,20}\/record\/0-[15]\/[0-9]{1,30}\|[^<>|\n]{1,80}>/g;
/**
 * The last look before Slack, on the text exactly as it is about to leave (including an intent sealed in the ledger BEFORE a rule existed): the free-text lines are made
 * safe again, and any `<...>` that is not one of our own CRM links is removed (mentions, other links). The marker, the structured lines and the internal links are kept.
 */
export function scrubHandoffNoticeText(text: string): string {
  const lines = text.split("\n").map(line => {
    const free = FREE_TEXT_LINE.exec(line);
    return free ? `${free[1]}${sanitizeNoticeText(free[2]!, 1000)}` : line;
  });
  const kept: string[] = [];
  const protectedText = lines.join("\n").replace(INTERNAL_LINK, link => `\u0000${kept.push(link) - 1}\u0000`);
  return protectedText.replace(/<[^>\n]*>/g, " ").replace(/\u0000(\d+)\u0000/g, (_, n: string) => kept[Number(n)]!);
}

export type HandoffNoticeIntent = EffectIntent & Readonly<{ kind: "handoff_notify"; permission: typeof SAV_CASE_EFFECT_PERMISSIONS.handoff; text: string; marker: string; channel: string }>;
/** The effect the existing executor dispatches: the rendered text, its marker and the configured channel are sealed in the ledger row, so a later pass never rebuilds them. */
export function buildHandoffNoticeIntent(input: Readonly<{ render: HandoffNoticeRender; caseId: string; ticketId: string; channel: string }>): HandoffNoticeIntent {
  if (!SLACK_CHANNEL.test(input.channel) || !/^[0-9]{1,30}$/.test(input.ticketId) || !input.render.text.trim()) throw new Error("SAV_HANDOFF_NOTICE_INTENT_INVALID");
  return { kind: "handoff_notify", permission: SAV_CASE_EFFECT_PERMISSIONS.handoff, key: input.render.key, ticketId: input.ticketId, sourceMessageId: input.caseId,
    text: input.render.text, marker: input.render.marker, channel: input.channel };
}
