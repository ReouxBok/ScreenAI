/** Public, generic design checks. These attestations are not runtime evidence. */
const LESSON_DEFINITIONS = [
  { id: "qualification", rule: "Préparer un contact de test sans ticket existant.", requirement: "Décrire la vérification préalable de l’absence de ticket." },
  { id: "subject", rule: "Fournir un objet de test exact à copier.", requirement: "Prévoir la copie de l’objet sans ressaisie." },
  { id: "wake", rule: "Toute attente volontaire programme un réveil unique.", requirement: "Décrire le réveil et sa vérification sans doublon." },
  { id: "send", rule: "Une réponse validée est envoyée sans attendre le rattrapage.", requirement: "Prévoir la mesure du délai entre validation et envoi." },
  { id: "trace", rule: "Chaque réponse laisse une trace et un statut cohérent.", requirement: "Prévoir la relecture de la trace et du statut." },
  { id: "queue", rule: "Un dossier en file ne doit pas être réinvesti.", requirement: "Prévoir un contrôle des appels répétés sans nouvelle entrée." },
  { id: "size", rule: "Mesurer la taille du texte réellement lu.", requirement: "Prévoir un cas de texte nettoyé issu d’un document volumineux." },
  { id: "wait", rule: "Toute attente est plafonnée puis transférée avec un motif.", requirement: "Décrire le plafond et le destinataire du transfert." },
  { id: "parity", rule: "Les interfaces appliquent les mêmes règles.", requirement: "Prévoir un test de parité entre les portes d’entrée." },
  { id: "receipt", rule: "Un effet incertain se rapproche par reçu, sans recréation.", requirement: "Prévoir une vérification en lecture et un cas concurrent." },
  { id: "off", rule: "Un réglage absent reste désactivé.", requirement: "Conserver le brouillon à off et prévoir un test du défaut." },
] as const;
export type SavBlockLessonId = typeof LESSON_DEFINITIONS[number]["id"];
export type SavLessonReview = Readonly<{ confirmed: boolean; plan: string }>;
export type SavLessonDraft = Readonly<{
  mode?: string;
  lessons?: Partial<Record<SavBlockLessonId, SavLessonReview>>;
}>;
export type SavLessonResult = Readonly<{ id: SavBlockLessonId; status: "ok" | "blocked"; reason: string }>;

/** Every lesson applies to the preparation plan. No checkbox can waive a lesson. */
export const SAV_BLOCK_LESSONS = LESSON_DEFINITIONS.map(lesson => ({
  ...lesson,
  control(draft: SavLessonDraft): SavLessonResult {
    const review = draft.lessons?.[lesson.id];
    const ok = review?.confirmed === true && typeof review.plan === "string" && review.plan.trim().length >= 10
      && (lesson.id !== "off" || (draft.mode ?? "off") === "off");
    return { id: lesson.id, status: ok ? "ok" : "blocked", reason: ok ? "Engagement du brief renseigné ; preuve d’exécution encore requise." : lesson.requirement };
  },
}));
export function checkSavBlockLesson(id: SavBlockLessonId, draft: SavLessonDraft): SavLessonResult {
  return SAV_BLOCK_LESSONS.find(row => row.id === id)!.control(draft);
}
export const checkSavBlockLessons = (draft: SavLessonDraft) => SAV_BLOCK_LESSONS.map(row => row.control(draft));
