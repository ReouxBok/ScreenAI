import type { SavRetrievalCandidate } from "../request-retrieval";
import { normalizeSensitiveText } from "../cases/sensitive-words";
import { attributeSavBlockByCards, rankSavCandidates, type SavBlockDraft } from "./block-attribution";
import { SAV_INTEGRATIONS_BLOCK } from "./integrations-block";
import { SAV_INTEGRATIONS_TEST_PHRASES } from "./integrations-phrases";
import { SAV_INTEGRATIONS_EVAL_CASES, SAV_INTEGRATIONS_MISSING_KNOWLEDGE, type IntegrationsEvalCase } from "./integrations-eval-cases";
import { measureSavBlockRouting } from "./routing-measure";

const tools = ["Gmail", "Outlook", "Shopify", "WordPress", "Odoo", "Pennylane"] as const;
const normalize = normalizeSensitiveText;
const indexPhrases = SAV_INTEGRATIONS_TEST_PHRASES.filter(row => row.split === "index");
const candidate = (id: string, content: string): SavRetrievalCandidate => ({
  id, contentVersionId: `${id}-v1`, title: `SYN ${id}`, content, source: "studio", semanticScore: null,
  verifiedAt: "2026-11-16T08:00:00Z", resolution: { symptoms: [], steps: ["Exemple synthétique sans procédure fournisseur."] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
/** Fixed fake index uses phase-1 INDEX phrases only, never evaluation text or expected labels.
 * The availability flags are test doubles, NOT evidence of published knowledge.
 */
const toolIndex = tools.map(tool => ({ tool, card: candidate(`syn-eval-${normalize(tool)}`,
  indexPhrases.filter(row => normalize(row.text).includes(normalize(tool))).map(row => row.text).join("\n")) }));
const accessCard = candidate("syn-eval-access", indexPhrases.filter(row => row.expected === "access").map(row => row.text).join("\n"));
const integrations: SavBlockDraft = { ...SAV_INTEGRATIONS_BLOCK, cardIds: toolIndex.map(row => row.card.id) };
const blocks: readonly SavBlockDraft[] = [integrations, { blockId: "access", family: "access", mode: "off", cardIds: [accessCard.id] }];

const rate = (hits: number, total: number) => ({ hits, total, rate: total ? hits / total : null });
/** Local lexical baseline ONLY. No ports, model, embedding, clock, config, DB or effects.
 * Card ids remain local to this module; the real unbound manifest is never modified.
 * Decisions/facts are review annotations, NOT predictions: only attribution is measured.
 * No default setting is introduced; both local fixture blocks are explicitly off.
 */
export function evaluateIntegrations(cases: readonly IntegrationsEvalCase[] = SAV_INTEGRATIONS_EVAL_CASES) {
  const rows = cases.map(testCase => {
    const text = normalize(testCase.text);
    const candidates = toolIndex.filter(row => text.includes(normalize(row.tool))).map(row => row.card);
    if (/code de connexion|lien de connexion/.test(text)) candidates.push(accessCard);
    const { cards } = rankSavCandidates(testCase.text, candidates, blocks, { locale: "fr-FR", now: new Date("2026-11-16T09:00:00Z") });
    const attribution = attributeSavBlockByCards(testCase.text, cards, blocks);
    const predictedBlock = attribution.outcome === "block" ? attribution.blockId : attribution.outcome;
    return { testCase, cards, attribution, predictedBlock, correct: predictedBlock === testCase.expectedBlock };
  });
  const truePositives = rows.filter(row => row.testCase.expectedBlock === "integrations" && row.predictedBlock === "integrations").length;
  const falsePositives = rows.filter(row => row.testCase.expectedBlock !== "integrations" && row.predictedBlock === "integrations").length;
  const falseNegatives = rows.filter(row => row.testCase.expectedBlock === "integrations" && row.predictedBlock !== "integrations").length;
  const confusionMatrix: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const expected = confusionMatrix[row.testCase.expectedBlock] ??= {};
    expected[row.predictedBlock] = (expected[row.predictedBlock] ?? 0) + 1;
  }
  return {
    baseline: "synthetic_lexical_only" as const, releaseQualified: false as const,
    actionEvaluation: "not_measured_annotations_only" as const, modelCalls: 0, effects: "none" as const,
    total: rows.length, truePositives, falsePositives, falseNegatives,
    precision: rate(truePositives, truePositives + falsePositives), recall: rate(truePositives, truePositives + falseNegatives),
    accuracy: rate(rows.filter(row => row.correct).length, rows.length), confusionMatrix,
    confusions: rows.filter(row => !row.correct).map(row => ({ id: row.testCase.id, expected: row.testCase.expectedBlock, predicted: row.predictedBlock, attribution: row.attribution })),
    routing: measureSavBlockRouting(integrations, rows.map(row => ({
      phrase: { text: row.testCase.text, kind: row.testCase.kind, expected: row.testCase.expectedBlock },
      cards: row.cards, attribution: row.attribution,
    }))),
    rows,
  };
}

export function integrationsEvalMarkdown(report = evaluateIntegrations()): string {
  const metric = (value: ReturnType<typeof rate>) => `${value.hits}/${value.total} (${value.rate === null ? "non mesuré" : `${(100 * value.rate).toFixed(2)} %`})`;
  return [
    "# Évaluation synthétique Intégrations — hors ligne",
    "Index lexical factice fixe ; aucune mesure sémantique, activation ou décision modèle. Attendus métier à valider.",
    `Cas : ${report.total} ; précision : ${metric(report.precision)} ; rappel : ${metric(report.recall)} ; exactitude : ${metric(report.accuracy)}.`,
    `Rappel@3 lexical : ${metric(report.routing.top3)} ; voisins rejetés : ${metric(report.routing.neighbourRejection)} ; pièges : ${metric(report.routing.traps)}.`,
    `Portes existantes : ${report.routing.gate.reasons.join(", ") || "aucun refus synthétique"}. Aucune qualification de livraison.`,
    "Les décisions et faits à demander restent des annotations non évaluées ; aucun texte client produit.",
    "## Confusions (attendu → observé)",
    ...report.confusions.map(row => `- ${row.id} : ${row.expected} → ${row.predicted} (${row.attribution.outcome})`),
    "## Fiches manquantes — propositions à valider",
    "Absentes du manifeste local ; existence et publication dans Studio non vérifiées. Aucun id/version inventé.",
    ...SAV_INTEGRATIONS_MISSING_KNOWLEDGE.map(card => `- **${card.title}** : ${card.expectedContent}`),
  ].join("\n");
}
