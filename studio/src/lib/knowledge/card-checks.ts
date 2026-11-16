/*
 * SAV-92 (harness phase 1): the card rules shared by the screen and the server, so both say the same thing. Pure and client-safe: no
 * database, network, Node module or clock of its own (the day is given).
 *
 * Version and validity (fix of the screen/server mismatch): the paste assistant said « Version produit et date de validité : à compléter
 * avant soumission » while the server never required them (`contracts.ts`: optional) and the paste flow had no field to fill them. One rule
 * now, here: the product version is RECOMMENDED (a warning, never blocking); the validity date is OPTIONAL, but when given it must be a real
 * date and not already past (a past date makes the card unusable by the agent: `supportProcedure` and the retrieval reject it), which blocks.
 */
export type SavCardCheckSeverity = "error" | "warning";
export type SavCardCheck = Readonly<{ field: string; severity: SavCardCheckSeverity; code: string; message: string }>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
export const isoDay = (now: Date) => now.toISOString().slice(0, 10);

export function savCardVersionValidityChecks(document: Readonly<{ productVersion?: string; validUntil?: string }>, now: Date): SavCardCheck[] {
  const checks: SavCardCheck[] = [];
  if (!document.productVersion?.trim()) checks.push({ field: "productVersion", severity: "warning", code: "product_version_missing",
    message: "Version produit recommandée (ex. V3) : sans elle, l’agent ne sait pas si la procédure vaut pour la version du client. Non bloquant." });
  const until = document.validUntil;
  if (until !== undefined && until !== "") {
    const date = new Date(`${until}T00:00:00Z`);
    if (!ISO_DAY.test(until) || !Number.isFinite(date.getTime()) || isoDay(date) !== until) checks.push({ field: "validUntil", severity: "error", code: "valid_until_invalid",
      message: "Fin de validité : saisissez une date réelle au format AAAA-MM-JJ, ou laissez le champ vide." });
    else if (until < isoDay(now)) checks.push({ field: "validUntil", severity: "error", code: "valid_until_past",
      message: `Fin de validité dépassée (${until}) : l’agent n’utiliserait plus cette fiche. Prolongez la date ou retirez-la.` });
    else if (until <= isoDay(new Date(now.getTime() + 15 * DAY_MS))) checks.push({ field: "validUntil", severity: "warning", code: "valid_until_soon",
      message: `Fin de validité proche (${until}) : prévoyez la revalidation.` });
  }
  return checks;
}

type CompletenessStep = Readonly<{ instruction?: string; expectedResult?: string }>;
type CompletenessDocument = Readonly<{ steps: readonly CompletenessStep[]; expectedResult: string; prerequisites: readonly string[]; escalation: string }>;
/**
 * The completeness rules of a proposal (formerly inline in `proposals.ts`), with the field each one is about. `proposals.ts` keeps the same
 * messages in its preview; the per-step rule also names each step here. `schemaValid` is the canonical schema's verdict, computed by the caller.
 */
export function savCardCompletenessChecks(document: CompletenessDocument, sources: readonly unknown[], reason: string, schemaValid: boolean): SavCardCheck[] {
  const error = (field: string, code: string, message: string): SavCardCheck => ({ field, severity: "error", code, message });
  const checks: SavCardCheck[] = [];
  if (!schemaValid) checks.push(error("document", "schema_incomplete", "Compléter l’objectif, les intitulés et les instructions des étapes."));
  if (!sources.length) checks.push(error("sources", "sources_missing", "Ajouter au moins une source de preuve."));
  if (reason.trim().length < 10) checks.push(error("reason", "reason_short", "Expliquer le motif de la proposition."));
  if (!document.steps.length) checks.push(error("steps", "steps_missing", "Décrire la procédure."));
  if (!document.expectedResult) checks.push(error("expectedResult", "expected_result_missing", "Préciser le résultat attendu."));
  if (!document.prerequisites.length) checks.push(error("prerequisites", "prerequisites_missing", "Préciser les conditions d’utilisation."));
  if (!document.escalation) checks.push(error("escalation", "escalation_missing", "Préciser les limites et le passage à un humain."));
  document.steps.forEach((step, index) => { if (!step.expectedResult) checks.push(error(`steps.${index}.expectedResult`, "step_expected_result_missing", "Préciser le résultat observable de chaque étape.")); });
  return checks;
}

/** The server preview's list: one line per rule (the per-step rule once), the exact former wording. */
export const savCardCompletenessMessages = (checks: readonly SavCardCheck[]) => [...new Set(checks.map(check => check.message))];

const STEP_PARTS: Record<string, string> = { instruction: "instruction", expectedResult: "résultat attendu", userLabel: "nom", objective: "but", location: "emplacement",
  prerequisites: "prérequis", exceptions: "exception", escalation: "escalade", variants: "variante" };
const TOP: Record<string, string> = { title: "Titre", objective: "Objectif", prerequisites: "Prérequis", expectedResult: "Résultat attendu", exceptions: "Exceptions",
  escalation: "Escalade", steps: "Procédure", productVersion: "Version produit", validUntil: "Fin de validité", delivery: "Restitution", sources: "Sources",
  reason: "Motif", document: "Fiche", card: "Fiche entière", diagnostic: "Diagnostic structuré", temporaryIncident: "Incident temporaire", onboardingContext: "Contexte source", locale: "Langue", applicability: "Périmètre" };
const SUPPORT: Record<string, string> = { symptoms: "Symptôme", diagnosticQuestions: "Question de diagnostic", responseTemplate: "Exemple de réponse" };

/** A French label for a field path (`steps.0.instruction` → « Étape 1 · instruction »). */
export function savCardFieldLabel(path: string) {
  const parts = path.split(".");
  const n = (value: string | undefined) => value !== undefined && /^\d+$/.test(value) ? ` ${Number(value) + 1}` : "";
  if (parts[0] === "steps" && parts[1] !== undefined && /^\d+$/.test(parts[1])) return `Étape${n(parts[1])}${parts[2] ? ` · ${STEP_PARTS[parts[2]] ?? parts[2]}${n(parts[3])}` : ""}`;
  if (parts[0] === "supportContext" && parts[1]) return `${SUPPORT[parts[1]] ?? parts[1]}${n(parts[2])}`;
  if (parts[0] === "sources" && parts[1] !== undefined) return `Source${n(parts[1])}${parts[2] === "ref" ? " · référence" : parts[2] === "label" ? " · nom" : ""}`;
  return `${TOP[parts[0] ?? ""] ?? path}${["prerequisites", "exceptions"].includes(parts[0] ?? "") ? n(parts[1]) : ""}`;
}
