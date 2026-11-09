export type IntakeUncertainty = "cost" | "effect" | "both" | "unknown";
export function classifyIntakeUncertainty(cost: boolean, effect: boolean): IntakeUncertainty {
  return cost && effect ? "both" : effect ? "effect" : cost ? "cost" : "unknown";
}
export function intakeUncertaintyLabel(value?: IntakeUncertainty | null) {
  return ({ cost: "Coût IA à confirmer", effect: "Action HubSpot ou Gmail à vérifier", both: "Coût IA et action externe à vérifier", unknown: "Incertitude à qualifier" })[value ?? "unknown"];
}
