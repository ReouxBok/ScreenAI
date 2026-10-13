import type { CanonicalKnowledge, OnboardingSourceSection } from "./contracts";

export const ONBOARDING_KNOWLEDGE_CONVERTER = "onboarding-sav-51-v2";
export const onboardingSectionLabels: Record<OnboardingSourceSection["classification"], string> = {
  pending: "À qualifier", prerequisite: "Prérequis", exception: "Exception ou limite",
  escalation: "Reprise ou passage à un humain", context: "Contexte d’utilisation", not_applicable: "Non pertinent pour le SAV",
};

export function onboardingSectionsQualified(document: CanonicalKnowledge) {
  return (document.onboardingContext?.sourceSections ?? []).every((section) => section.classification !== "pending" && section.rationale.trim().length >= 20);
}

/** Compare the complete ordered source set, not just the editable fields submitted by the browser. */
export function assertOnboardingSectionEvidence(document: CanonicalKnowledge, original: CanonicalKnowledge) {
  const evidence = (value: CanonicalKnowledge) => (value.onboardingContext?.sourceSections ?? []).map(({ id, order, heading, content }) => ({ id, order, heading, content }));
  if (JSON.stringify(evidence(document)) !== JSON.stringify(evidence(original))) throw new Error("ONBOARDING_SOURCE_SECTIONS_CHANGED");
}

export function onboardingSectionsBody(document: CanonicalKnowledge) {
  const sections = (document.onboardingContext?.sourceSections ?? []).filter((section) => section.classification !== "not_applicable");
  return sections.flatMap((section) => [`### ${section.heading}`, `Classement : ${onboardingSectionLabels[section.classification]}`, section.content]);
}
