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
