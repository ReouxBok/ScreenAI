import type { SavUnderstandingV1 } from "./understanding";

/** A display label, never an authority to classify, link or execute a ticket. */
export function validSavTicketTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length <= 120
    && !/[\r\n<>@]/u.test(value) && !/https?:|^(?:bonjour|hello|merci|salut|je\s|i\s|re\s*:|fw\s*:|fwd\s*:)/iu.test(value)
    && value.split(/\s+/u).length >= 4 && value.split(/\s+/u).length <= 6;
}

export function savTicketTitle(u?: Pick<SavUnderstandingV1, "requests" | "primaryRequestId" | "ticketTitle" | "language">) {
  if (u && u.requests.length && validSavTicketTitle(u.ticketTitle)) return u.ticketTitle;
  const nature = u?.requests.find(r => r.id === u.primaryRequestId)?.nature;
  const english = u?.language === "en";
  const titles: Record<string, [string, string]> = {
    technical: ["Dysfonctionnement du produit à examiner", "Product issue requiring further investigation"],
    integration: ["Configuration de l’intégration à vérifier", "Integration setup requiring further review"],
    account: ["Difficulté d’accès au compte client", "Customer account access requires assistance"],
    how_to: ["Accompagnement pour utiliser le produit", "Guidance on using the product"],
    financial_data: ["Demande de documents de facturation", "Request for account billing documents"],
    financial_operation: ["Demande relative à la facturation", "Request concerning customer account billing"],
    cancellation: ["Demande de résiliation du contrat", "Request to cancel the subscription"],
  };
  return titles[nature ?? ""]?.[english ? 1 : 0] ?? (english ? "Support request requiring further clarification" : "Demande de support à préciser");
}
