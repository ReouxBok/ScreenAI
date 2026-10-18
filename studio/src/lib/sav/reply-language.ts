import { splitSavMessageText } from "./message-context";
import type { SavStructuredProposal } from "./proposal";

/** New decisions use the reviewed understanding. Historical drafts retain their
 * send-only language behavior; this compatibility path never classifies a case. */
export function savReplyLanguage(proposal: SavStructuredProposal, body: string) {
  if (proposal.understanding) return proposal.understanding.language;
  if (proposal.messageContext?.language && proposal.messageContext.language !== "unknown") return proposal.messageContext.language;
  const current = splitSavMessageText(body).currentText;
  const english = (current.match(/\b(?:hello|please|thanks|thank|my|need|would|could|cannot|invoice|subscription|account|available)\b/gi) ?? []).length;
  const french = (current.match(/\b(?:bonjour|merci|mon|mes|je|vous|pour|souhaite|facture|abonnement|compte|disponible)\b/gi) ?? []).length;
  return english > french ? "en" : french > 0 ? "fr" : "unknown";
}
