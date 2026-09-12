type ContentKind = "article" | "onboarding";

export type ReadinessCheck = {
  key: string;
  label: string;
  guidance: string;
  status: "complete" | "staff" | "demonstration";
};

export type ContentReadiness = {
  completed: number;
  total: number;
  percent: number;
  checks: ReadinessCheck[];
  sourcePaths: string[];
};

const strings = (value: unknown) => Array.isArray(value)
  ? value.map(String).map((item) => item.trim()).filter(Boolean)
  : [];

const genericSuccess = /^(le parcours démontré est terminé|le résultat demandé est visible dans limova)$/i;
const genericFallback = /^demander une précision au membre limova$/i;

function sourcePaths(metadata: Record<string, unknown>, itemSourcePath?: string | null) {
  const source = metadata.sourceMetadata && typeof metadata.sourceMetadata === "object"
    ? metadata.sourceMetadata as Record<string, unknown>
    : {};
  return [...new Set([
    itemSourcePath ?? "",
    ...strings(source.sourcePaths),
    typeof source.sourcePath === "string" ? source.sourcePath : "",
  ].filter(Boolean))];
}

export function assessContentReadiness(input: {
  type: ContentKind;
  metadata: Record<string, unknown>;
  itemSourcePath?: string | null;
  hasTraining?: boolean;
  evaluationPassed?: boolean;
}): ContentReadiness {
  const { metadata } = input;
  const checks: ReadinessCheck[] = [];
  const add = (check: ReadinessCheck) => checks.push(check);

  if (input.type === "article") {
    add({ key: "intents", label: "Questions couvertes", guidance: "Ajoutez les formulations que les membres utilisent réellement.", status: strings(metadata.intents).length >= 2 ? "complete" : "staff" });
    add({ key: "paths", label: "Pages concernées", guidance: "Confirmez les pages Limova auxquelles cette connaissance s’applique.", status: strings(metadata.limovaPaths).length ? "complete" : "staff" });
    add({ key: "prerequisites", label: "Prérequis", guidance: "Indiquez le rôle, le plan ou les connexions nécessaires, ou confirmez qu’il n’y en a aucun.", status: strings(metadata.prerequisites).length ? "complete" : "staff" });
    add({ key: "result", label: "Résultat attendu", guidance: "Décrivez ce que le membre doit constater à la fin.", status: String(metadata.expectedResult ?? "").trim() ? "complete" : "staff" });
    add({ key: "troubleshooting", label: "Cas de blocage", guidance: "Ajoutez les erreurs connues et la conduite à tenir.", status: String(metadata.troubleshooting ?? "").trim() ? "complete" : "staff" });
  } else {
    const actions = Array.isArray(metadata.actionSteps) ? metadata.actionSteps as Array<Record<string, unknown>> : [];
    const criteria = strings(metadata.successCriteria);
    const fallbacks = strings(metadata.fallbacks);
    const weakActions = actions.filter((step) => step.confidence === "weak").length;
    add({ key: "signals", label: "Intentions utilisateur", guidance: "Ajoutez au moins deux formulations naturelles qui doivent déclencher ce parcours.", status: strings(metadata.proposalSignals).length >= 2 ? "complete" : "staff" });
    add({ key: "questions", label: "Questions de qualification", guidance: "Ajoutez les informations nécessaires avant d’agir, ou confirmez explicitement qu’aucune question n’est requise.", status: strings(metadata.qualificationQuestions).length ? "complete" : "staff" });
    add({ key: "pages", label: "Pages du parcours", guidance: "Confirmez les pages de départ, intermédiaires et finales.", status: strings(metadata.expectedPages).length ? "complete" : "staff" });
    add({ key: "success", label: "Réussite observable", guidance: "Remplacez le critère générique par un état visible et vérifiable dans Limova.", status: criteria.length > 0 && criteria.some((criterion) => !genericSuccess.test(criterion)) ? "complete" : "staff" });
    add({ key: "branches", label: "Variantes du parcours", guidance: "Décrivez les cas déjà connecté, droits insuffisants, brouillon existant et autres chemins alternatifs.", status: Array.isArray(metadata.branches) && metadata.branches.length > 0 ? "complete" : "staff" });
    add({ key: "fallbacks", label: "Solutions de repli", guidance: "Précisez quoi faire si une cible manque, si une autorisation échoue ou si le résultat n’apparaît pas.", status: fallbacks.some((fallback) => !genericFallback.test(fallback)) ? "complete" : "staff" });
    add({ key: "actions", label: "Démonstration des actions", guidance: "Enregistrez le parcours réel afin d’obtenir des cibles DOM et des résultats observés.", status: actions.length ? "complete" : "demonstration" });
    add({ key: "targets", label: "Repères d’action fiables", guidance: weakActions ? `${weakActions} étape(s) ont une cible faible et doivent être redémontrées.` : "Les cibles démontrées possèdent des repères suffisants.", status: actions.length && weakActions === 0 ? "complete" : "demonstration" });
    add({ key: "evaluation", label: "Test réel de bout en bout", guidance: "Lancez le parcours avec Charly et confirmez le résultat final.", status: input.evaluationPassed ? "complete" : "demonstration" });
  }

  const completed = checks.filter((check) => check.status === "complete").length;
  return {
    completed,
    total: checks.length,
    percent: checks.length ? Math.round((completed / checks.length) * 100) : 0,
    checks,
    sourcePaths: sourcePaths(metadata, input.itemSourcePath),
  };
}
