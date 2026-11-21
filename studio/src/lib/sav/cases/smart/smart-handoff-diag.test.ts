import { describe, expect, it } from "vitest";
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { SAV_BENCH_KNOWLEDGE } from "../../bench/bench-knowledge.fixture";
import { smartServerChecks, type SmartSource } from "./smart-checks";
import { smartDecisionSchema, smartReadingSchema } from "./smart-contract";
import { smartVerifyPrompt } from "./smart-prompt";
import { smartReading } from "./smart-test-doubles";

/*
 * SAV-122 diagnostic (bench 21/11, v6): 9 turns handed over at 4-5 calls instead of answering. This replays, WITHOUT a model, the server half of
 * the review on the EXPECTED answer of each turn: a reply made of its cards, each sentence a fact citing its card word for word. The server
 * refuses none of them, so the refusal that sent them to the team came from the counter-read (or from a model's sloppy facts): the bench's
 * `failedTurns[].codes` now say which.
 */
const FAILED: readonly (readonly [string, number])[] = [
  ["mdp-01", 1], ["mdp-02", 1], ["mdp-03", 2], ["plateforme-02", 1], ["plateforme-03", 1], ["autreoutil-06", 1], ["sujet-03", 1], ["sujet-05", 1], ["ps-04", 1],
];
const source = (id: string): SmartSource => {
  const card = SAV_BENCH_KNOWLEDGE.find(row => row.id === id)!;
  return { cardId: card.id, version: "v1", title: card.title, content: [card.content, ...(card.links ?? [])].join("\n"), steps: [...card.steps], needIds: ["n1"], validUntil: null };
};
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map(row => row.trim()).filter(Boolean);

describe("SAV-122 diagnostic : le contrôle serveur ne refuse pas la réponse attendue des 9 tours transférés", () => {
  for (const [id, turnNumber] of FAILED) it(`${id} tour ${turnNumber} : réponse tirée de ses fiches, faits cités mot pour mot → aucun code serveur`, () => {
    const conversation = SAV_BENCH_CORPUS.find(row => row.id === id)!;
    const sources = conversation.knowledge.map(source);
    const facts = sources.flatMap(card => sentences(card.content.split("\n")[0]!).map(sentence => ({ sentence, needId: "n1", type: "fait_limova", sourceKind: "fiche",
      cardId: card.cardId, version: card.version, toolCallId: null, excerpt: sentence })));
    const reply = `Bonjour,\n\n${facts.map(fact => fact.sentence).join("\n\n")}\n\nBelle journée.`;
    const decision = smartDecisionSchema.parse({ outcome: "reply", reply, teamNote: null, handoffReason: null, coverage: [{ needId: "n1", status: "answered" }], facts });
    const customerText = conversation.turns.slice(0, turnNumber).map(turn => turn.text).join("\n");
    expect(smartServerChecks({ decision, reading: smartReadingSchema.parse(smartReading()), customerText, sources }).codes).toEqual([]);
  });

  it("la relecture (v7) ne compte pas comme faute ce qui protège ou guide le client ni un prérequis donné par une fiche", () => {
    const verify = smartVerifyPrompt();
    expect(verify).toContain("ou un prérequis donné par une fiche (Google Chrome), n'en est pas un.");
    expect(verify).toContain("Limova n'a pas de mot de passe ; lui dire de se connecter lui-même avec le code à usage unique reçu par e-mail");
    expect(verify).toContain("ou de ne jamais envoyer un code ou un mot de passe n'est ni secret_requested ni sensitive_commitment");
    expect(verify).not.toContain("Mot de passe oublié");
    expect(verify).toContain("Une étape qui reprend une fiche citée dans facts n'est pas unlisted_claim.");
  });
});
