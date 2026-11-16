// SAV-92 (decision of Ugo, 16/11): after each CONFIRMED V2 reply, ONE short internal HubSpot note saying what V2 did, in French, 2-3 sentences.
// Deterministic, from closed facts only: the families of the case's requests, the reply's purpose and the ticket stage really planned for this reply.
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

/** The ticket sentence, only for what is really planned with this reply; nothing otherwise (no neutral claim about a state nobody moves). */
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
