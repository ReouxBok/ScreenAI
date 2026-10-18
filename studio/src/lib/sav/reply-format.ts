/** Shared preview/confirmation/send rule. Never persist the footer in an editable draft. */
export const SAV_REPLY_FORMAT_REVISION = "sav-send-footer-2026-10-18.v3";
export type SavReplySendMode = "manual_reviewed" | "manual_authored" | "automated";
export const SAV_REPLY_SIGNATURE = "Charly — Agent IA du support Limova";
export const SAV_REPLY_NOTICE = "Cette réponse a été envoyée automatiquement par une IA et peut contenir des erreurs. Si elle ne résout pas votre demande, répondez à ce message en précisant ce qui bloque afin de poursuivre votre prise en charge.";
const englishNotice = "This reply was sent automatically by an AI and may contain errors. If it does not resolve your request, reply with details of what is still blocking you so we can continue assisting you.";
const previousNotice = "Cette réponse a été préparée avec une IA, qui peut se tromper. Si nécessaire, demandez une vérification à l’équipe Limova.";
const previousEnglish = "This reply was prepared with AI, which can make mistakes. If needed, ask the Limova team to review it.";
const historicalFooters = [previousNotice, previousEnglish].flatMap(notice => [`Charly, assistant IA SAV\n${notice}`, `Charly\n${notice}`]);
export const LEGACY_AI_DISCLOSURE = "Bonjour, je suis Charly, l’assistant IA du SAV Limova.";
export const LEGACY_AI_NOTICE = "Je peux vous aider immédiatement. Vous pouvez à tout moment demander l’intervention d’un humain ; le délai de traitement est alors de 3 jours.";
export const LEGACY_AI_CHOICES = "Continuer avec l’IA — réponse instantanée\nTransférer à un humain — délai de 3 jours";

export function savManualReplyMode(origin?: string): SavReplySendMode {
  return origin === "human" ? "manual_authored" : "manual_reviewed";
}
export function savReplyFooter(language: "fr" | "en" | "unknown" = "fr", mode: SavReplySendMode = "manual_reviewed") {
  if (mode === "automated") return `${language === "en" ? "Charly — Limova support AI agent" : SAV_REPLY_SIGNATURE}\n${language === "en" ? englishNotice : SAV_REPLY_NOTICE}`;
  const team = language === "en" ? "The Limova team" : "L’équipe Limova";
  return mode === "manual_authored" ? team : `${team}\n${language === "en" ? "Reply prepared with AI assistance and approved by our team." : "Réponse préparée avec l’aide d’une IA et validée par notre équipe."}`;
}
function knownFooters() {
  return [...historicalFooters, ...(["fr", "en"] as const).flatMap(language => (["manual_reviewed", "manual_authored", "automated"] as const).map(mode => savReplyFooter(language, mode)))].sort((a,b) => b.length-a.length);
}
export function cleanSavModelDraft(body: string) {
  let text = String(body || "").trim();
  for (const boilerplate of [LEGACY_AI_DISCLOSURE, LEGACY_AI_NOTICE, LEGACY_AI_CHOICES, ...knownFooters().filter(footer => !["L’équipe Limova", "The Limova team"].includes(footer))]) text = text.split(boilerplate).join("").trim();
  return text;
}
export function renderSavOutboundReply(body: string, language: "fr" | "en" | "unknown" = "fr", mode: SavReplySendMode = "manual_reviewed") {
  let text = String(body || "").trim();
  const known = knownFooters();
  let trailing = known.find(value => text.endsWith(value));
  while (trailing) {
    text = text.slice(0, -trailing.length).trimEnd();
    trailing = known.find(value => text.endsWith(value));
  }
  if (!text) throw new Error("SAV_REPLY_EMPTY");
  return `${text}\n\n${savReplyFooter(language, mode)}`;
}
/** Compatibility heuristic for transcript attribution, never authorization. */
export function isSavAiAuthoredReply(body: string) {
  return body.includes(LEGACY_AI_DISCLOSURE) || historicalFooters.some(footer => body.includes(footer))
    || (["fr", "en"] as const).some(language => (["manual_reviewed", "automated"] as const).some(mode => body.includes(savReplyFooter(language, mode))));
}
