// V1 routing (23/11): measurement of the routing on a labelled sample (a private JSONL given at run time, never committed). Pure: labels in, counts out.
// The decision that matters is the ACTION (forward to whom / archive / keep), so the report counts actions first, then classes. A finance, cancellation or
// support mail routed away is the one error that must stay at zero.
import { SAV_INTAKE_ROUTING_ARCHIVED, SAV_INTAKE_ROUTING_CLASSES, SAV_INTAKE_ROUTING_RECIPIENTS, type SavIntakeRoutingClass } from "./routing-rules";

/** Label spellings of the private sample → routing classes. `autre` has no routed class: it must keep the current path. */
const ALIASES: Record<string, SavIntakeRoutingClass> = {
  demarchage_newsletter_pub: "demarchage", newsletter: "demarchage", resiliation: "cancellation", facturation: "finance", autre: "unknown", other: "unknown",
  commercial: "lead_commercial", investor: "investisseur", partnership: "partenariat",
};
export function normalizeIntakeRoutingLabel(raw: unknown): SavIntakeRoutingClass | null {
  const value = String(raw ?? "").trim().toLowerCase().split("/")[0]!;
  if ((SAV_INTAKE_ROUTING_CLASSES as readonly string[]).includes(value)) return value as SavIntakeRoutingClass;
  return ALIASES[value] ?? null;
}
/** Today's V1 class (`currentClass` of the sample, e.g. `partnership/supervised_action`) read as a routing class: the baseline before this change. */
export function baselineIntakeRoutingClass(currentClass: unknown): SavIntakeRoutingClass {
  return normalizeIntakeRoutingLabel(currentClass) ?? "unknown";
}

export type IntakeRoutingAction = "forward:sacha" | "forward:nathan" | "archive" | "keep";
export function intakeRoutingExpectedAction(cls: SavIntakeRoutingClass | null, confidence: string = "high"): IntakeRoutingAction {
  if (!cls || confidence !== "high") return "keep";
  const recipient = SAV_INTAKE_ROUTING_RECIPIENTS[cls];
  if (recipient) return recipient.startsWith("nathan@") ? "forward:nathan" : "forward:sacha";
  return SAV_INTAKE_ROUTING_ARCHIVED.includes(cls) ? "archive" : "keep";
}

export type IntakeRoutingEvalRow = { id: string; expected: SavIntakeRoutingClass | null; predicted: SavIntakeRoutingClass | null; predictedConfidence: string | null };
export function summarizeIntakeRoutingEval(rows: readonly IntakeRoutingEvalRow[]) {
  const labelled = rows.filter(r => r.expected);
  const confusion: Record<string, Record<string, number>> = {};
  const actions = { correctRoutes: 0, correctKeeps: 0, wrongRoutes: 0, missedRoutes: 0, sensitiveOrSupportRouted: 0, unpredicted: 0 };
  const wrongIds: string[] = [], sensitiveIds: string[] = [];
  let classCorrect = 0;
  for (const row of labelled) {
    const expected = row.expected!, predicted = row.predicted ?? "none";
    (confusion[expected] ??= {})[predicted] = (confusion[expected]![predicted] ?? 0) + 1;
    if (row.predicted === expected) classCorrect++;
    if (!row.predicted) actions.unpredicted++;
    const want = intakeRoutingExpectedAction(expected), got = intakeRoutingExpectedAction(row.predicted, row.predictedConfidence ?? "low");
    if (got !== "keep" && ["finance", "cancellation", "support"].includes(expected)) { actions.sensitiveOrSupportRouted++; sensitiveIds.push(row.id); }
    if (want === got) { if (got === "keep") actions.correctKeeps++; else actions.correctRoutes++; }
    else if (got === "keep") actions.missedRoutes++;
    else { actions.wrongRoutes++; wrongIds.push(row.id); }
  }
  const perClass = Object.fromEntries(SAV_INTAKE_ROUTING_CLASSES.map(cls => {
    const tp = labelled.filter(r => r.expected === cls && r.predicted === cls).length;
    const support = labelled.filter(r => r.expected === cls).length, predictedCount = labelled.filter(r => r.predicted === cls).length;
    return [cls, { support, predicted: predictedCount, precision: predictedCount ? tp / predictedCount : null, recall: support ? tp / support : null }];
  }).filter(([, v]) => (v as { support: number; predicted: number }).support || (v as { predicted: number }).predicted));
  return { rows: rows.length, labelled: labelled.length, unlabelled: rows.length - labelled.length, classAccuracy: labelled.length ? classCorrect / labelled.length : null,
    actions, perClass, confusion, wrongRouteIds: wrongIds, sensitiveRoutedIds: sensitiveIds };
}
