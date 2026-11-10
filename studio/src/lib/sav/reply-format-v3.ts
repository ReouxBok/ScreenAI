/** Read compatibility for immutable manual replies approved under the deployed v3 format. Never used for new approvals. */
export const LEGACY_SAV_REPLY_FORMAT_V3 = "sav-send-footer-2026-10-18.v3";
type SavReplySendMode = "manual_reviewed" | "manual_authored" | "automated";
const SAV_REPLY_SIGNATURE = "Charly — Agent IA du support Limova";
const SAV_REPLY_NOTICE = "Cette réponse a été envoyée automatiquement par une IA et peut contenir des erreurs. Si elle ne résout pas votre demande, répondez à ce message en précisant ce qui bloque afin de poursuivre votre prise en charge.";
const englishNotice = "This reply was sent automatically by an AI and may contain errors. If it does not resolve your request, reply with details of what is still blocking you so we can continue assisting you.";
const previousNotice = "Cette réponse a été préparée avec une IA, qui peut se tromper. Si nécessaire, demandez une vérification à l’équipe Limova.";
const previousEnglish = "This reply was prepared with AI, which can make mistakes. If needed, ask the Limova team to review it.";
const historicalFooters = [previousNotice, previousEnglish].flatMap(notice => [`Charly, assistant IA SAV\n${notice}`, `Charly\n${notice}`]);
function savReplyFooter(language: "fr" | "en" | "unknown" = "fr", mode: SavReplySendMode = "manual_reviewed") {
  if (mode === "automated") return `${language === "en" ? "Charly — Limova support AI agent" : SAV_REPLY_SIGNATURE}\n${language === "en" ? englishNotice : SAV_REPLY_NOTICE}`;
  const team = language === "en" ? "The Limova team" : "L’équipe Limova";
  return mode === "manual_authored" ? team : `${team}\n${language === "en" ? "Reply prepared with AI assistance and approved by our team." : "Réponse préparée avec l’aide d’une IA et validée par notre équipe."}`;
}
function knownFooters() {
  return [...historicalFooters, ...(["fr", "en"] as const).flatMap(language => (["manual_reviewed", "manual_authored", "automated"] as const).map(mode => savReplyFooter(language, mode)))].sort((a,b) => b.length-a.length);
}
export function renderSealedSavReplyV3(body: string, language: "fr" | "en" | "unknown" = "fr", mode: SavReplySendMode = "manual_reviewed") {
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
