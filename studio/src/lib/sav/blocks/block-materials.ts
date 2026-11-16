import { z } from "zod";
import { canonicalKnowledgeSchema } from "@/lib/knowledge/contracts";
import type { SaveSavKnowledgeProposalInput } from "@/lib/knowledge/proposals";
import { savBlockBriefSchema, savBlockBriefToDraft, type SavBlockBrief } from "./block-brief";
import { attributeSavBlockByCards, type SavRankedCard } from "./block-attribution";
import { measureSavBlockRouting } from "./routing-measure";

const phraseSchema = z.object({ text: z.string().trim().min(3).max(600), kind: z.enum(["positive", "neighbour", "trap"]) }).strict();
export const blockMaterialsSchema = z.object({
  document: canonicalKnowledgeSchema,
  phrases: z.array(phraseSchema).length(24),
}).strict().superRefine((value, ctx) => {
  if (JSON.stringify(value.document).length > 5500 || value.document.steps.length > 8)
    ctx.addIssue({ code: "custom", message: "Fiche trop longue : 5500 caractères et huit étapes maximum" });
  if (new Set(value.phrases.map(row => row.text.toLocaleLowerCase("fr"))).size !== 24)
    ctx.addIssue({ code: "custom", message: "Phrases dupliquées" });
  for (const [kind, count] of [["positive", 12], ["neighbour", 6], ["trap", 6]] as const)
    if (value.phrases.filter(row => row.kind === kind).length !== count) ctx.addIssue({ code: "custom", message: `Répartition invalide : ${kind}` });
});
export type BlockMaterials = z.infer<typeof blockMaterialsSchema>;
/** Split is assigned by code, never by the model. Each category has exactly one third held out. */
export function splitBlockPhrases(materials: BlockMaterials) {
  const counts = { positive: 0, neighbour: 0, trap: 0 };
  return materials.phrases.map(phrase => ({ ...phrase, expected: phrase.kind === "positive" ? undefined : "team", reserved: ++counts[phrase.kind] % 3 === 0 }));
}
export function prepareBlockMaterials(raw: unknown): BlockMaterials {
  const brief = savBlockBriefSchema.parse(raw);
  savBlockBriefToDraft(brief); // Validated brief required, including every lesson.
  const requests = ["Je souhaite", "Comment puis-je", "Pouvez-vous expliquer", "J’ai besoin de", "Où commencer pour", "Quelle démarche pour", "Je cherche à", "Aidez-moi à", "Quelle vérification pour", "Je voudrais comprendre", "Quelles étapes pour", "Quel contrôle pour"];
  const phrases = requests.map((prefix, i) => ({ text: `${prefix} : ${brief.examples[i % brief.examples.length].slice(0, 450)} ?`, kind: "positive" as const }));
  return blockMaterialsSchema.parse({ document: {
    schemaVersion: 1, objective: brief.objective.slice(0, 500), applicability: "sav_only", locale: "fr-FR", productVersion: "",
    prerequisites: ["À compléter : source et version produit vérifiées par un humain."], expectedResult: brief.resolutionProof.slice(0, 500),
    exceptions: brief.exclusions.slice(0, 8).map(v => v.slice(0, 200)), escalation: `Transfert humain vers ${brief.transferTo.slice(0, 400)}. Procédure à vérifier.`, steps: [],
    supportContext: { symptoms: brief.examples.slice(0, 8).map(v => v.slice(0, 200)), diagnosticQuestions: ["Quelle situation observez-vous ?"], responseTemplate: "À compléter après vérification des sources et de la procédure." },
  }, phrases: [...phrases,
    ...Array.from({ length: 6 }, (_, i) => ({ text: `${requests[i]} : ${brief.neighbours[i % brief.neighbours.length].slice(0, 450)} (demande voisine) ?`, kind: "neighbour" })),
    ...Array.from({ length: 6 }, (_, i) => ({ text: `${requests[i]} : ${brief.examples[i % brief.examples.length].slice(0, 200)} et ${brief.humanOnly[i % brief.humanOnly.length].slice(0, 200)} (cas mixte à transférer).`, kind: "trap" })),
  ] });
}
export function blockKnowledgeProposal(brief: SavBlockBrief, materials: BlockMaterials): SaveSavKnowledgeProposalInput {
  return { mode: "new", title: brief.objective.slice(0, 500), document: materials.document, sources: [],
    reason: "Brouillon issu du brief. Sources, procédure et restitution à compléter et à valider humainement." };
}
/** Ephemeral lexical index only. Reserved phrases never enter it, nor any published knowledge index. */
export function blockMaterialsIndex(materials: BlockMaterials) {
  return splitBlockPhrases(materials).filter(row => !row.reserved && row.kind === "positive").map(row => row.text);
}
/** Baseline, not a semantic qualification: run ALL 24 phrases, including the eight unseen ones. */
export function measureBlockMaterials(brief: SavBlockBrief, materials: BlockMaterials) {
  const block = { ...savBlockBriefToDraft(brief), cardIds: ["draft-card"] };
  const words = (s: string) => new Set(s.toLocaleLowerCase("fr").normalize("NFD").replace(/\p{M}/gu, "").match(/[a-z]{4,}/g) ?? []);
  const index = words(blockMaterialsIndex(materials).join(" ") + " " + materials.document.objective);
  return measureSavBlockRouting(block, splitBlockPhrases(materials).map(phrase => {
    const query = words(phrase.text), overlap = [...query].filter(word => index.has(word)).length;
    const score = query.size ? overlap / query.size : 0;
    const cards: SavRankedCard[] = score >= 0.5 ? [{ cardId: "draft-card", contentVersionId: "draft", title: materials.document.objective,
      blockId: brief.blockId, semanticScore: null, lexicalScore: score, rankingScore: score }] : [];
    return { phrase, cards, attribution: attributeSavBlockByCards(phrase.text, cards, [block]) };
  }));
}
