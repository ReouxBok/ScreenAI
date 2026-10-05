import { createHash } from "node:crypto";
import type { OnboardingMetadata, ArticleMetadata } from "@/db/schema";
import type { CanonicalKnowledge, SemanticStep } from "./contracts";
import { canonicalKnowledgeSchema, semanticStepSchema } from "./contracts";
import { redactSavLearningText } from "@/lib/sav/learning-extraction";

export function publicKnowledgeText(value: string) {
  return redactSavLearningText(value.replace(/<[^>]*>/g, " ").replace(/\]\s*\(/g, "] (").replace(/\r/g, "").trim());
}
function semanticId(familyKey: string, identity: string) {
  return `step.${createHash("sha256").update(`${familyKey}:${identity}`).digest("hex").slice(0, 24)}`;
}
function publicSemanticStep(raw: SemanticStep) {
  const step = semanticStepSchema.parse(raw);
  return semanticStepSchema.parse({ ...step, userLabel: publicKnowledgeText(step.userLabel), objective: publicKnowledgeText(step.objective),
    instruction: publicKnowledgeText(step.instruction), location: publicKnowledgeText(step.location), prerequisites: step.prerequisites.map(publicKnowledgeText),
    expectedResult: publicKnowledgeText(step.expectedResult), exceptions: step.exceptions.map(publicKnowledgeText), escalation: publicKnowledgeText(step.escalation),
    variants: step.variants.map((variant) => ({ ...variant, instruction: publicKnowledgeText(variant.instruction), expectedResult: publicKnowledgeText(variant.expectedResult) })) });
}
const locationLabels: Record<string, string> = { "bottom-left": "en bas à gauche", "bottom_left": "en bas à gauche", "top-left": "en haut à gauche", "top-right": "en haut à droite", sidebar: "dans le menu latéral" };
const noBusinessMeaning = /^(?:contrôle observé|control|button|div|span|click|clic|scroll|défilement|autorisation externe)$/i;
const technicalLabel = /(?:^#[\w-]+$|^\.[\w-]+$|querySelector|data-testid|nth-child|<[^>]+>|\[[\w-]+=)/i;

export function canonicalFromOnboarding(familyKey: string, metadata: OnboardingMetadata, locale: string) {
  const bindings: Array<{ semanticStepId: string; actionOrder: number }> = [];
  const steps: SemanticStep[] = metadata.semanticSteps?.map(publicSemanticStep) ?? [];
  if (!steps.length) {
    for (const action of metadata.actionSteps ?? []) {
      const userLabel = publicKnowledgeText(action.label).slice(0, 500);
      if (!userLabel || noBusinessMeaning.test(userLabel) || technicalLabel.test(action.label) || action.action === "external_popup") continue;
      const location = locationLabels[String(action.target?.zone ?? "")] ?? "";
      // Only an observed UI label and a user-facing location cross the boundary.
      const instruction = `${action.action === "input" ? "Renseignez" : "Sélectionnez"} « ${userLabel} »${location ? ` (${location})` : ""}.`;
      // Labels are versioned data, not identity. Reordering/inserting a source
      // action still requires human review of the semantic mapping.
      const id = semanticId(familyKey, `recorded-action:${action.order}`);
      steps.push(semanticStepSchema.parse({ id, userLabel, objective: instruction, instruction, location,
        prerequisites: [], expectedResult: "Résultat de cette étape à confirmer pendant la revue.", exceptions: [], escalation: "Demander une vérification humaine si le contrôle ou le résultat diffère.", variants: [] }));
      bindings.push({ semanticStepId: id, actionOrder: action.order });
    }
  }
  const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: publicKnowledgeText(metadata.objective), locale,
    applicability: steps.length ? "shared" : "onboarding_only", productVersion: "", prerequisites: [],
    expectedResult: metadata.successCriteria.map(publicKnowledgeText).join("\n"), exceptions: metadata.fallbacks.map(publicKnowledgeText),
    escalation: "Transférer à un humain si la procédure ne correspond pas à l’interface ou si son résultat n’est pas confirmé.", steps });
  return { document, bindings, applicable: Boolean(steps.length), explanation: steps.length
    ? "La démonstration contient des contrôles nommés qui peuvent être expliqués par écrit. Les résultats et prérequis restent à confirmer par Ugo."
    : "La démonstration n’apporte pas de parcours métier écrit suffisamment précis ; aucune fiche SAV artificielle n’est générée." };
}

export function canonicalFromSav(familyKey: string, metadata: ArticleMetadata, locale: string, objective: string) {
  const resolution = metadata.resolution;
  const rawSteps = (resolution?.steps ?? []).map(publicKnowledgeText);
  const contractOnly = /rembours|contestation|prélèvement|mise en demeure|suppression de données|back[- ]?end|contacter (?:la finance|l['’]équipe)/i.test(rawSteps.join(" "));
  const uiIntent = !contractOnly && (Boolean(metadata.semanticSteps?.length) || rawSteps.some((step) => /cliquez|sélectionnez|ouvrez|rendez-vous|→|paramètres|facturation.*factures/i.test(step)));
  const steps = metadata.semanticSteps?.length ? metadata.semanticSteps.map(publicSemanticStep) : rawSteps.map((instruction, index) => publicSemanticStep(semanticStepSchema.parse({
    id: semanticId(familyKey, `resolution-step:${index + 1}`), userLabel: `Étape ${index + 1}`, objective: instruction.slice(0, 500), instruction: instruction.slice(0, 2_000),
    prerequisites: metadata.prerequisites, expectedResult: metadata.expectedResult, exceptions: resolution?.exceptions ?? [], escalation: resolution?.escalation ?? metadata.troubleshooting, variants: [],
  })));
  const document: CanonicalKnowledge = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: publicKnowledgeText(objective).slice(0, 500), locale,
    applicability: uiIntent ? "shared" : "sav_only", productVersion: resolution?.productVersion ?? "", ...(resolution?.validUntil ? { validUntil: resolution.validUntil } : {}),
    prerequisites: metadata.prerequisites.map(publicKnowledgeText), expectedResult: publicKnowledgeText(metadata.expectedResult), exceptions: (resolution?.exceptions ?? []).map(publicKnowledgeText),
    escalation: publicKnowledgeText(resolution?.escalation ?? metadata.troubleshooting), steps });
  return { document, applicable: uiIntent, explanation: uiIntent
    ? "La résolution humaine décrit un parcours UI réutilisable. Un tutoriel doit compléter les cibles et résultats observés avant toute exécution Chrome."
    : "La résolution relève du support écrit, d’une opération contractuelle ou du backend ; elle reste SAV-only." };
}

export function savProjectionBody(document: CanonicalKnowledge) {
  return ["## Objectif", document.objective, ...(document.productVersion ? ["Version produit : " + document.productVersion] : []), ...(document.validUntil ? ["Validité : " + document.validUntil] : []), "## Prérequis", ...document.prerequisites, "## Procédure proposée", ...document.steps.flatMap((step, index) => [
    `${index + 1}. ${step.instruction}`, ...(step.location ? ["Emplacement : " + step.location] : []), ...step.prerequisites.map((value) => "Prérequis de l’étape : " + value), "Résultat de l’étape : " + (step.expectedResult || "À confirmer par Ugo."), ...step.exceptions.map((value) => "Exception : " + value), ...(step.escalation ? ["Escalade de l’étape : " + step.escalation] : []),
    ...step.variants.map((variant) => `Variante à qualifier (${variant.roles.join(", ") || "rôle non précisé"} ; ${variant.productVersion || "version non précisée"}) : ${variant.instruction}`),
  ]), "## Résultat attendu", document.expectedResult || "À confirmer par Ugo.", "## Exceptions", ...document.exceptions, "## Escalade", document.escalation].join("\n\n");
}
