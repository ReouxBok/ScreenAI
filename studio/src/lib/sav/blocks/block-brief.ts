import { z } from "zod";
import type { SavBlockDraft } from "./block-attribution";
import { checkSavBlockLessons, SAV_BLOCK_LESSONS, type SavBlockLessonId } from "./lesson-controls";

export const SAV_BLOCK_BRIEF_QUESTIONS = [
  { id: "objective", label: "Objectif", hint: "Quel besoin précis le bloc doit-il traiter ?" },
  { id: "examples", label: "Exemples", hint: "Un exemple synthétique par ligne." },
  { id: "boundaries", label: "Exclusions et voisins", hint: "Un élément par ligne, dans chaque champ." },
  { id: "humanOnly", label: "Sujets toujours humains", hint: "Ajouter les limites propres au bloc ; les sujets sensibles restent humains." },
  { id: "transferTo", label: "Destinataire des transferts", hint: "Indiquer une équipe ou une file, sans donnée personnelle." },
  { id: "resolutionProof", label: "Preuve de résolution", hint: "Quel résultat vérifiable permet de conclure ?" },
] as const;
const text = z.string().trim().max(3000);
const lines = z.array(text.min(1)).max(30);
const lessonShape = Object.fromEntries(SAV_BLOCK_LESSONS.map(({ id }) => [id, z.object({ confirmed: z.boolean(), plan: text }).strict().optional()])) as Record<SavBlockLessonId, z.ZodOptional<z.ZodObject<{ confirmed: z.ZodBoolean; plan: typeof text }>>>;
/** Incomplete briefs may be saved. Completion is checked separately. */
export const savBlockBriefSchema = z.object({
  blockId: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
  objective: text, examples: lines, exclusions: lines, neighbours: lines,
  humanOnly: lines, transferTo: text, resolutionProof: text,
  lessons: z.object(lessonShape).strict(), mode: z.literal("off").default("off"),
}).strict();
export type SavBlockBrief = z.infer<typeof savBlockBriefSchema>;
export const emptySavBlockBrief = (blockId: string): SavBlockBrief => savBlockBriefSchema.parse({
  blockId, objective: "", examples: [], exclusions: [], neighbours: [], humanOnly: [], transferTo: "", resolutionProof: "", lessons: {},
});
export function validateSavBlockBrief(raw: unknown) {
  const parsed = savBlockBriefSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, reasons: ["Format du brief invalide ou champs trop longs."] };
  const brief = parsed.data;
  const reasons: string[] = [];
  if (brief.examples.length + brief.neighbours.length + brief.exclusions.length > 30) reasons.push("Limiter le squelette à trente phrases au total (exemples, voisins et exclusions).");
  if (brief.objective.length < 10) reasons.push("Préciser l’objectif (au moins dix caractères).");
  for (const [label, values] of [["Exemples", brief.examples], ["Exclusions", brief.exclusions], ["Voisins", brief.neighbours], ["Sujets humains", brief.humanOnly]] as const)
    if (!values.length) reasons.push(`${label} : renseigner au moins une ligne.`);
  if (brief.transferTo.length < 3) reasons.push("Renseigner l’équipe destinataire du transfert.");
  if (brief.resolutionProof.length < 10) reasons.push("Décrire une preuve de résolution vérifiable.");
  reasons.push(...checkSavBlockLessons(brief).filter(row => row.status === "blocked").map(row => `${row.id} : ${row.reason}`));
  return { ok: reasons.length === 0, reasons };
}
/** Skeleton only: no invented card, no registration, no claim of evaluation readiness. */
export function savBlockBriefToDraft(raw: unknown): SavBlockDraft {
  const brief = savBlockBriefSchema.parse(raw), result = validateSavBlockBrief(brief);
  if (!result.ok) throw Error("SAV_BLOCK_BRIEF_INCOMPLETE");
  return {
    blockId: brief.blockId, label: brief.objective, mode: "off", cardIds: [], supportCardIds: [],
    exclusions: brief.exclusions, neighbours: brief.neighbours,
    humanOnly: [...new Set(["Finance", "Résiliation", "Identité et droits", ...brief.humanOnly])],
    askBefore: ["Quel résultat attendez-vous ?", `Quelle preuve vérifier : ${brief.resolutionProof}`],
    testPhrases: [
      ...brief.examples.map(value => ({ text: value, kind: "positive" as const })),
      ...brief.neighbours.map(value => ({ text: `Demande relevant du voisin : ${value}`, kind: "neighbour" as const, expected: "team" })),
      ...brief.exclusions.map(value => ({ text: `Demande hors périmètre : ${value}`, kind: "trap" as const, expected: "team" })),
    ],
  };
}
const md = (value: string) => value.replace(/[\\`*_{}\[\]<>#|!~]/g, "\\$&").replace(/\r?\n/g, "\n\n");
export function exportSavBlockBriefMarkdown(raw: unknown): string {
  const brief = savBlockBriefSchema.parse(raw), validation = validateSavBlockBrief(brief);
  const section = (title: string, values: readonly string[]) => `## ${title}\n\n${values.length ? values.map(v => `- ${md(v)}`).join("\n") : "À renseigner."}`;
  return ["# Brief de bloc", `Bloc : ${md(brief.blockId)} — Mode : off`,
    "Brouillon déclaratif. Aucune publication, inscription ou activation. Fiches, versions exactes, évaluation et revues restent à fournir.",
    section("Objectif", [brief.objective]), section("Exemples", brief.examples), section("Exclusions", brief.exclusions), section("Voisins", brief.neighbours),
    section("Sujets toujours humains", ["Finance", "Résiliation", "Identité et droits", ...brief.humanOnly]),
    section("Destinataire des transferts", [brief.transferTo]), section("Preuve de résolution", [brief.resolutionProof]),
    "## Leçons\n\n" + checkSavBlockLessons(brief).map(result => {
      const lesson = SAV_BLOCK_LESSONS.find(row => row.id === result.id)!;
      return `- [${result.status === "ok" ? "x" : " "}] ${lesson.id} : ${lesson.rule} ${md(brief.lessons[result.id]?.plan ?? "")} (${result.reason})`;
    }).join("\n"),
    ...(validation.ok ? ["## Squelette SavBlockDraft\n\n```json\n" + JSON.stringify(savBlockBriefToDraft(brief), null, 2).replace(/`/g, "\\u0060") + "\n```"] : []),
    section("Validation du brief", validation.ok ? ["Complet pour préparer le lot suivant ; aucune autorisation d’exécution."] : validation.reasons),
  ].join("\n\n") + "\n";
}
export function savBlockBriefFromForm(form: FormData): SavBlockBrief {
  const value = (key: string) => String(form.get(key) ?? "");
  const list = (key: string) => value(key).split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  return savBlockBriefSchema.parse({ blockId: value("blockId"), objective: value("objective"), examples: list("examples"),
    exclusions: list("exclusions"), neighbours: list("neighbours"), humanOnly: list("humanOnly"), transferTo: value("transferTo"), resolutionProof: value("resolutionProof"),
    lessons: Object.fromEntries(SAV_BLOCK_LESSONS.map(({ id }) => [id, { confirmed: form.get(`lesson.${id}`) === "on", plan: value(`plan.${id}`) }])),
  });
}
