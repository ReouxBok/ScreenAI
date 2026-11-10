/** `unread`: the ledgers could not be read now. It never means "no effect": a cost or an external action may still be unsettled. */
export type IntakeUncertainty = "cost" | "effect" | "both" | "unknown" | "unread";
export function classifyIntakeUncertainty(cost: boolean, effect: boolean): IntakeUncertainty {
  return cost && effect ? "both" : effect ? "effect" : cost ? "cost" : "unknown";
}
export function intakeUncertaintyLabel(value?: IntakeUncertainty | null) {
  return ({ cost: "Coût IA à confirmer", effect: "Action HubSpot ou Gmail à vérifier", both: "Coût IA et action externe à vérifier", unknown: "Incertitude à qualifier",
    unread: "Incertitude non lue : coût IA ou action HubSpot ou Gmail possible, à vérifier avant tout renvoi" })[value ?? "unknown"];
}
/** Every id marked `unread`: what a failed ledger read shows instead of failing the page or claiming an absence. */
export function unreadIntakeUncertainties(messageIds: readonly string[]): Record<string, IntakeUncertainty> {
  return Object.fromEntries([...new Set(messageIds)].map(id => [id, "unread" as const]));
}
