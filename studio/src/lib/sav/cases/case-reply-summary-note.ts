// SAV-92 (decision of Ugo, 16/11): after each CONFIRMED V2 reply, ONE short internal HubSpot note saying what V2 did, in French, 2-3 sentences.
// Deterministic, from closed facts only: the families of the case's requests, the reply's purpose and the ticket stage confirmed for this reply.
// Never the reply's text, a card or model name, an id or a technical detail. No model call. Pure: nothing is read or written here.
import type { CaseReplyPurpose } from "./case-effects";

/** The note's `interactionId` (C's `caseNoteKey`: `note:<case>:reply-summary.<trigger>`): one note per reply key, whatever replays or passes. */
export const CASE_REPLY_SUMMARY_PREFIX = "reply-summary.";
export const caseReplySummaryInteractionId = (triggerEventId: string) => `${CASE_REPLY_SUMMARY_PREFIX}${triggerEventId}`;
export const isCaseReplySummary = (interactionId: string) => interactionId.startsWith(CASE_REPLY_SUMMARY_PREFIX);
/** The reply's summary note switch (OFF unless exactly `on`), read at queue time AND by the driver before any NEW write of a summary note. */
export const caseReplyNoteEnabled = (env: Readonly<Record<string, string | undefined>>) => env.SAV_V2_REPLY_NOTE === "on";

const PROBLEM: Readonly<Record<string, string>> = {
  access: "un problème d'accès", usage: "une question d'utilisation", technical: "un problème technique",
  integration: "un problème d'intégration", telephony: "un problème de téléphonie",
};
/** Sensitive, `other` or unknown families: a safe generic label, never the family's name. */
const GENERIC = "une demande";

function problemOf(families: readonly string[]) {
  const labels = [...new Set(families.map(family => PROBLEM[family] ?? GENERIC))];
  if (!labels.length) return GENERIC;
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2 && !labels.includes(GENERIC)) return `${labels[0]} et ${labels[1]}`;
  return "plusieurs demandes";
}

function actionOf(families: readonly string[], purpose: CaseReplyPurpose) {
  if (purpose === "question") return "J'ai demandé au client les informations manquantes.";
  if (purpose === "reminder") return "J'ai relancé le client.";
  const only = [...new Set(families)];
  return only.length === 1 && only[0] === "access" ? "J'ai répondu avec la procédure de connexion." : "J'ai répondu avec les explications adaptées.";
}

/** The two sentences known when the reply is queued. */
export function caseReplySummaryText(input: Readonly<{ families: readonly string[]; purpose: CaseReplyPurpose }>) {
  return `Le client signale ${problemOf(input.families)}. ${actionOf(input.families, input.purpose)}`;
}

/** The ticket sentence, only for what is confirmed for this reply; nothing otherwise (no neutral claim about a state nobody moves). */
export type CaseReplySummaryStage = "waiting_customer" | "closed" | null;
export function caseReplySummaryWithStage(text: string, stage: CaseReplySummaryStage) {
  if (stage === "waiting_customer") return `${text} Ticket passé en attente du client.`;
  if (stage === "closed") return `${text} Ticket fermé.`;
  return text;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// SAV-92 (decision of Ugo, 16/11): the closure note. When V2 CLOSES a ticket (stage « Fermé », only after a PROVEN resolution: an accepted `confirm_resolution`
// on the customer's own words and a second reading `soft_close`), ONE short note says so. Written by the ticket stage execution itself, only once its « closed »
// stage is CONFIRMED in the ledger. Deterministic, from the families of the requests the proof resolved; never a quote, a card, a model or an id.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The note's `interactionId` (`caseNoteKey`: `note:<case>:closed-summary.cycle-<n>`): one note per closed cycle, whatever replays or passes. */
export const CASE_CLOSURE_NOTE_PREFIX = "closed-summary.";
export const caseClosureNoteInteractionId = (cycle: number) => `${CASE_CLOSURE_NOTE_PREFIX}cycle-${cycle}`;
export const isCaseClosureNote = (interactionId: string) => interactionId.startsWith(CASE_CLOSURE_NOTE_PREFIX);

const RESOLVED: Readonly<Record<string, string>> = {
  access: "son problème d'accès est résolu", usage: "sa question d'utilisation est résolue", technical: "son problème technique est résolu",
  integration: "son problème d'intégration est résolu", telephony: "son problème de téléphonie est résolu",
};
/** Sensitive, `other`, unknown or unrecorded families: the generic label, never the family's name. */
const RESOLVED_GENERIC = "sa demande est résolue";

/** The closure note: the customer's confirmation (what the proof is) and the ticket closed (what the confirmed stage did). Nothing else. */
export function caseClosureNoteText(families: readonly string[]) {
  const labels = [...new Set(families.map(family => RESOLVED[family] ?? RESOLVED_GENERIC))];
  const what = !labels.length ? RESOLVED_GENERIC : labels.length === 1 ? labels[0]! : "ses demandes sont résolues";
  return `Le client a confirmé que ${what}. Ticket fermé.`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// SAV-99 (decision of Ugo, 19/11): a ticket a person gave the agent WITHOUT any mail, that the agent did not take, goes back to the team (stage « Nouveau », no owner).
// Before that write, the same stage execution leaves ONE short note on the ticket saying why, through the existing case note effect (`append_case_note`, under
// `SAV_V2_REPLY_NOTE=on`). Deterministic, from the stored reason code only: never the ticket's text, a model output or an id.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The note's `interactionId` (`note:<case>:handoff-summary.v<n>`, n = the hand-over's case version): one note per hand-over, whatever replays or passes. */
export const CASE_HANDOFF_NOTE_PREFIX = "handoff-summary.";
export const caseHandoffNoteInteractionId = (handoffVersion: number) => `${CASE_HANDOFF_NOTE_PREFIX}v${handoffVersion}`;

const IDENTITY = new Set(["no_contact", "multiple_contacts", "missing_email", "invalid_email", "recipient_not_allowed", "identity_unconfirmed"]);
const NOT_ACCESS = "d'après son contenu, la demande ne relève d'aucun sujet que l'agent traite aujourd'hui";
const NOT_TAKEN: Readonly<Record<string, string>> = {
  sensitive_request: "demande sensible (facturation, résiliation ou autre sujet réservé à l'équipe)",
  not_access: NOT_ACCESS, no_block_match: NOT_ACCESS, ambiguous_block: "d'après son contenu, la demande mêle plusieurs sujets ; l'agent ne la prend pas seul",
  untrusted_source: "le contenu du ticket contient des instructions suspectes",
  access_block_closed: "le traitement automatique des demandes d'accès est fermé",
  thread_ambiguous: "le ticket est lié à plusieurs fils de mails, ou son fil à un autre ticket ; l'agent ne choisit pas seul",
  identity_mismatch: "l'expéditeur du mail ne correspond pas au contact du ticket dans HubSpot",
};
/** Unknown, absent or technical reasons: the generic label, never the code itself. */
const NOT_TAKEN_GENERIC = "la demande sort du périmètre actuel de l'agent";

/** Why the agent did not take the ticket, in plain words, from the stored reason code only (also the Slack notice's « Problème », `agentNotTakenNoticeTrigger`). */
export function caseNotTakenWhy(reason: string | null | undefined) {
  return !reason ? NOT_TAKEN_GENERIC : IDENTITY.has(reason) ? "contact client introuvable, ambigu ou sans adresse mail utilisable dans HubSpot"
    : reason.startsWith("access_skill_") ? "l'agent n'a pas pu lire la demande de façon fiable" : NOT_TAKEN[reason] ?? NOT_TAKEN_GENERIC;
}

export function caseThreadlessHandoffNoteText(reason: string | null | undefined) {
  return `Ticket attribué à l'Agent SAV mais non pris en charge : ${caseNotTakenWhy(reason)}. Aucun mail envoyé au client. Ticket remis en « Nouveau », sans propriétaire, pour l'équipe.`;
}
