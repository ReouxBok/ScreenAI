/*
 * K2 (12/11): the publication check of a SAV card, on the version that would be published (its Markdown body and its `resolution`, the very
 * fields the V2 agent reads). It only WARNS: it never blocks a publication, never shortens nor rewrites a card. Budget per block means
 * splitting a card that is too long, never raising a limit nor cutting the text silently. Pure: no database, network or clock.
 */

export const SAV_CARD_PUBLICATION_LIMITS = Object.freeze({ characters: 5500, steps: 8 });
export type SavCardPublicationWarningCode = "card_too_long" | "card_too_many_steps" | "card_symptoms_missing" | "card_escalation_missing";
export type SavCardPublicationWarning = { code: SavCardPublicationWarningCode; label: string; value?: number; limit?: number };

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const filled = (value: unknown) => typeof value === "string" && value.trim().length > 0;

export function savCardPublicationWarnings(version: Readonly<{ bodyMarkdown: string; metadata: unknown }>): SavCardPublicationWarning[] {
  const resolution = record(record(version.metadata)?.resolution);
  const warnings: SavCardPublicationWarning[] = [];
  // Characters as a reader counts them (code points), not UTF-16 units nor bytes.
  const characters = [...version.bodyMarkdown].length, { characters: maxCharacters, steps: maxSteps } = SAV_CARD_PUBLICATION_LIMITS;
  if (characters > maxCharacters) warnings.push({ code: "card_too_long", value: characters, limit: maxCharacters,
    label: `Fiche longue : ${characters} caractères (repère ${maxCharacters}). La découper en fiches plus courtes plutôt que relever la limite.` });
  const steps = Array.isArray(resolution?.steps) ? resolution.steps.length : 0;
  if (steps > maxSteps) warnings.push({ code: "card_too_many_steps", value: steps, limit: maxSteps,
    label: `Procédure longue : ${steps} étapes (repère ${maxSteps}). La découper par cas.` });
  if (!(Array.isArray(resolution?.symptoms) && resolution.symptoms.some(filled))) warnings.push({ code: "card_symptoms_missing",
    label: "Aucun symptôme renseigné : l'agent reconnaît moins bien quand utiliser cette fiche." });
  if (!filled(resolution?.escalation)) warnings.push({ code: "card_escalation_missing",
    label: "Aucune escalade renseignée : l'agent ne sait pas à qui transférer si la procédure échoue." });
  return warnings;
}
