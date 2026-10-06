/** Shared display/send rule. Never persist this footer inside an editable draft. */
export const SAV_REPLY_FORMAT_REVISION = "sav-send-footer-2026-10-06.v1";
export const SAV_REPLY_SIGNATURE = "Charly, assistant IA SAV";
export const SAV_REPLY_NOTICE = "Cette réponse a été préparée avec une IA, qui peut se tromper. Si nécessaire, demandez une vérification à l’équipe Limova.";
const englishNotice = "This reply was prepared with AI, which can make mistakes. If needed, ask the Limova team to review it.";

// Kept only to recognize historical replies and strip app-owned boilerplate
// from NEW model output. Stored messages/human drafts are never rewritten.
export const LEGACY_AI_DISCLOSURE = "Bonjour, je suis Charly, l’assistant IA du SAV Limova.";
export const LEGACY_AI_NOTICE = "Je peux vous aider immédiatement. Vous pouvez à tout moment demander l’intervention d’un humain ; le délai de traitement est alors de 3 jours.";
export const LEGACY_AI_CHOICES = "Continuer avec l’IA — réponse instantanée\nTransférer à un humain — délai de 3 jours";

export function savReplyFooter(language: "fr" | "en" | "unknown" = "fr") {
  return `${SAV_REPLY_SIGNATURE}\n${language === "en" ? englishNotice : SAV_REPLY_NOTICE}`;
}

export function cleanSavModelDraft(body: string) {
  let text = String(body || "").trim();
  for (const boilerplate of [LEGACY_AI_DISCLOSURE, LEGACY_AI_NOTICE, LEGACY_AI_CHOICES, savReplyFooter("fr"), savReplyFooter("en")]) {
    text = text.split(boilerplate).join("").trim();
  }
  return text;
}

export function renderSavOutboundReply(body: string, language: "fr" | "en" | "unknown" = "fr") {
  const text = String(body || "").trim();
  if (!text) throw new Error("SAV_REPLY_EMPTY");
  const footer = savReplyFooter(language);
  return text.endsWith(footer) ? text : `${text}\n\n${footer}`;
}

/** Compatibility heuristic for CRM transcript attribution, not authorization. */
export function isSavAiAuthoredReply(body: string) {
  return body.includes(LEGACY_AI_DISCLOSURE)
    || body.includes(savReplyFooter("fr")) || body.includes(savReplyFooter("en"));
}
