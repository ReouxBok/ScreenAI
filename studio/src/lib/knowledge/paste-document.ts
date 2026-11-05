import { canonicalKnowledgeSchema, type CanonicalKnowledge, type SemanticStep } from "./contracts";

const headings = ["Objectif", "Symptômes / situations couvertes", "Questions de diagnostic", "Point d’entrée", "Prérequis", "Procédure proposée", "Résultat attendu", "Exceptions", "Escalade", "Exemple de réponse à adapter", "Compléments sourcés à examiner"];

function plain(value: string) {
  return value.trim().replace(/^[-*•]\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => label === url ? url : label + " (" + url + ")");
}

function stepsFromText(lines: string[], base: CanonicalKnowledge, objective: string) {
  const steps: SemanticStep[] = [];
  const retained = new Set<string>();
  let step: SemanticStep | undefined;
  for (const line of lines) {
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (numbered) {
      const instruction = numbered[1];
      const matches = base.steps.filter(source => plain(source.instruction) === instruction && !retained.has(source.id));
      if (matches.length > 1) throw new Error("Plusieurs étapes existantes ont cette instruction. Modifiez-les dans les champs de la procédure.");
      const source = matches[0];
      if (source) retained.add(source.id);
      step = source ? { ...source, instruction } : { id: "step." + crypto.randomUUID(), instruction, userLabel: instruction.slice(0, 500), objective, location: "", prerequisites: [], expectedResult: "", exceptions: [], escalation: "", variants: [] };
      steps.push(step);
      continue;
    }
    if (!step) throw new Error("Commencez chaque étape de la procédure par un numéro suivi d’un point.");
    const attribute = /^(Emplacement|Résultat de l’étape|Prérequis de l’étape|Exception|Escalade de l’étape)\s*:\s*(.+)$/i.exec(line);
    if (!attribute) throw new Error("Ligne de procédure non reconnue : " + line.slice(0, 100));
    const [, name, value] = attribute;
    switch (name.toLowerCase()) {
      case "emplacement": step.location = value; break;
      case "résultat de l’étape": step.expectedResult = value; break;
      case "escalade de l’étape": step.escalation = value; break;
      case "prérequis de l’étape": step.prerequisites = [...new Set([...step.prerequisites, value])]; break;
      case "exception": step.exceptions = [...new Set([...step.exceptions, value])]; break;
    }
  }
  if (!steps.length) throw new Error("Ajoutez au moins une étape numérotée.");
  for (const previous of base.steps) {
    if (retained.has(previous.id)) continue;
    if (previous.variants.length || previous.exceptions.length || previous.prerequisites.length || previous.escalation || base.diagnostic?.checks.some(check => check.evidenceStepId === previous.id)) {
      throw new Error("Une étape liée à des contrôles ou à des conditions a changé. Modifiez cette étape dans l’éditeur détaillé pour conserver ses liens.");
    }
  }
  return steps;
}

export function parsePastedKnowledge(text: string, base: CanonicalKnowledge) {
  if (text.length > 100_000) throw new Error("La fiche dépasse 100 000 caractères.");
  const sections = new Map<string, string[]>();
  let title = "";
  let section: string[] | undefined;
  for (const raw of text.trim().split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { if (section?.length) section.push(""); continue; }
    if (line.startsWith("# ") && !section && !title) {
      title = plain(line.slice(2)).replace(/^Fiche\s+\d+\s*[—–:-]\s*/i, "");
      continue;
    }
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = headings.find(value => value.toLocaleLowerCase("fr") === heading[1].replaceAll("'", "’").toLocaleLowerCase("fr"));
      if (!name) throw new Error("Rubrique non reconnue : " + heading[1] + ". Utilisez l’éditeur détaillé pour ce contenu.");
      if (sections.has(name)) throw new Error("Rubrique en double : " + name);
      section = []; sections.set(name, section); continue;
    }
    if (!section && /^\*Version testée en local\b.*\*$/i.test(line)) continue;
    if (!section || /^#/.test(line)) throw new Error("Utilisez un titre facultatif (#), puis les rubriques de la fiche (## Objectif, ## Procédure proposée…).");
    if (/^(Version produit|Validité)\s*:/i.test(plain(line))) throw new Error("Modifiez la version produit et sa validité dans les champs de contexte, puis retirez ces lignes du texte collé.");
    section.push(plain(line));
  }
  if (!sections.size) throw new Error("Collez une fiche avec ses rubriques.");
  const paragraph = (name: string, fallback: string) => sections.has(name) ? sections.get(name)!.join("\n").trim() : fallback;
  const list = (name: string, fallback: string[]) => sections.get(name)?.filter(Boolean) ?? fallback;
  const objective = paragraph("Objectif", base.objective);
  const steps = sections.has("Procédure proposée") ? stepsFromText(list("Procédure proposée", []), base, objective) : base.steps;
  const document: CanonicalKnowledge = { ...base, objective, steps, prerequisites: list("Prérequis", base.prerequisites), expectedResult: paragraph("Résultat attendu", base.expectedResult), exceptions: list("Exceptions", base.exceptions), escalation: paragraph("Escalade", base.escalation) };
  if (base.supportContext || ["Symptômes / situations couvertes", "Questions de diagnostic", "Exemple de réponse à adapter"].some(name => sections.has(name))) {
    document.supportContext = { symptoms: list("Symptômes / situations couvertes", base.supportContext?.symptoms ?? []), diagnosticQuestions: list("Questions de diagnostic", base.supportContext?.diagnosticQuestions ?? []), responseTemplate: paragraph("Exemple de réponse à adapter", base.supportContext?.responseTemplate ?? "") };
  }
  if (base.onboardingContext || sections.has("Point d’entrée") || sections.has("Compléments sourcés à examiner")) {
    document.onboardingContext = { ...base.onboardingContext, entryPoint: paragraph("Point d’entrée", base.onboardingContext?.entryPoint ?? ""), sourceNotes: list("Compléments sourcés à examiner", base.onboardingContext?.sourceNotes ?? []) };
  }
  if (base.diagnostic) document.diagnostic = { ...base.diagnostic, checks: base.diagnostic.checks.map(check => {
    const step = steps.find(value => value.id === check.evidenceStepId);
    const original = base.steps.find(value => value.id === check.evidenceStepId);
    if (!step || !original || original.instruction === step.instruction && original.expectedResult === step.expectedResult) return check;
    return { ...check, instruction: step.instruction, expectedResult: step.expectedResult };
  }) };
  const result = canonicalKnowledgeSchema.safeParse(document);
  if (!result.success) throw new Error("Vérifiez la rubrique « " + (result.error.issues[0].path[0] === "objective" ? "Objectif" : result.error.issues[0].path.join(" / ")) + " » (champ manquant ou longueur incorrecte).");
  const previous = canonicalKnowledgeSchema.safeParse(base);
  const unchanged = previous.success && JSON.stringify(previous.data) === JSON.stringify(result.data);
  return { title, document: unchanged ? base : result.data };
}
