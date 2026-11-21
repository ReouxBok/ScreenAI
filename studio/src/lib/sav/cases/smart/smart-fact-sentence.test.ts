import { describe, expect, it } from "vitest";
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { buildSavBenchVariants } from "../../bench/bench-variants";
import { savReplyFooter } from "../../reply-format";
import { runSmartTurn, type SmartTurnInput } from "./smart-agent";
import { SAV_SMART_BENCH_MULTITURN } from "./smart-bench-multiturn.fixture";
import { smartServerChecks, type SmartSource } from "./smart-checks";
import { smartDecisionSchema, smartReadingSchema } from "./smart-contract";
import { smartUnderstandPrompt } from "./smart-prompt";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * SAV-122 (prod bench 21/11, 98 conversations: 29 handoffs with a relevant card found, refused on `fact_sentence_missing` then
 * `refused_after_correction`): the refusal is GONE. It only checked that a DECLARED fact's sentence was copied into the reply, never an
 * undeclared invention, and it refused good replies the model had reworded. A fact's `sentence` is now an optional hint for the counter-read.
 * The anti-invention checks stay: excerpt in the cited source, card retrieved for the need, and the counter-read (`unlisted_claim`,
 * `source_mismatch`). Fictional texts only.
 */
const run = (script: SmartScript, input: SmartTurnInput) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(input, { model: scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-21" }).then(result => ({ result, calls: scripted.calls }));
};
const MAIL: SmartTurnInput = { subject: "Connexion impossible", body: "Bonjour, je n'arrive pas à me connecter, le code n'arrive pas.", thread: [] };
// The reply rewords the card; the facts' sentences reword the reply again (the prod failure), the excerpts are word for word in the card.
const REWORDED = "Bonjour,\n\nPour entrer dans votre espace, prenez l'e-mail auquel l'invitation a été envoyée. Le code tarde ? Jetez un œil aux indésirables.\n\nSi cela bloque encore, dites-nous quel message s'affiche.\n\nBelle journée.";
const REWORDED_FACTS = [
  { sentence: "Il faut se connecter avec l'e-mail de l'invitation.", needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: "fiche-connexion", version: "v3", excerpt: "utilisez l'adresse e-mail de votre invitation" },
  { needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: "fiche-connexion", version: "v3", excerpt: "Si le code n'arrive pas, vérifiez le dossier des indésirables" },
];

describe("SAV-122 : plus de refus fact_sentence_missing ; les vrais contrôles anti-invention restent", () => {
  it("réponse reformulée, phrases des faits reformulées ou absentes, extraits valides → acceptée en 3 appels, sans correction", async () => {
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision({ reply: REWORDED, facts: REWORDED_FACTS }) }, verify: { output: SMART_CONFORME } }, MAIL);
    expect(result).toMatchObject({ outcome: "reply", corrected: false, checks: { first: [], second: null } });
    expect(calls.map(call => call.kind)).toEqual(["understand", "decide", "verify"]);
    // The counter-read gets each fact with its source and excerpt; the sentence only as a hint, when given.
    const verify = calls.find(call => call.kind === "verify")!.payload as { reply: string; facts: unknown[] };
    expect(verify.reply).toBe(REWORDED);
    expect(verify.facts).toEqual([
      { type: "fait_limova", source: "fiche-connexion", excerpt: "utilisez l'adresse e-mail de votre invitation", sentence: "Il faut se connecter avec l'e-mail de l'invitation." },
      { type: "fait_limova", source: "fiche-connexion", excerpt: "Si le code n'arrive pas, vérifiez le dossier des indésirables" },
    ]);
  });
  it("le texte envoyé est EXACTEMENT la réponse du modèle, plus la seule mention IA du serveur : rien d'ajouté, rien de retiré", async () => {
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision({ reply: REWORDED, facts: REWORDED_FACTS }) }, verify: { output: SMART_CONFORME } }, MAIL);
    expect(result.decision!.reply).toBe(REWORDED);
    expect(result.replyWithFooter).toBe(`${REWORDED}\n\n${savReplyFooter("fr", "automated")}`);
  });
  it("un extrait qui n'est PAS dans la fiche est toujours refusé (excerpt_not_found), corrigé une fois, sinon l'équipe", async () => {
    const invented = smartGoodDecision({ reply: REWORDED, facts: [{ ...REWORDED_FACTS[0], excerpt: "le plan Pro vous est offert" }] });
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: invented }, verify: { output: SMART_CONFORME }, correct: { output: invented }, reverify: { output: SMART_CONFORME } }, MAIL);
    expect(result.checks.first).toEqual(["excerpt_not_found"]);
    expect(result).toMatchObject({ outcome: "handoff" });
    expect(result.reasons).toContain("refused_after_correction");
    const correction = calls.find(call => call.kind === "correct")!.payload as { problems: Array<{ code: string; sentence: string }> };
    expect(correction.problems).toEqual([{ code: "excerpt_not_found", sentence: "Il faut se connecter avec l'e-mail de l'invitation." }]);
  });
  it("une fiche non retrouvée pour ce besoin est toujours refusée ; une affirmation sans fait reste le travail de la relecture (unlisted_claim)", async () => {
    const reading = smartReadingSchema.parse(smartReading());
    const decision = (facts: unknown[]) => smartDecisionSchema.parse(smartGoodDecision({ reply: REWORDED, facts }));
    expect(smartServerChecks({ decision: decision([{ ...REWORDED_FACTS[1], cardId: "fiche-inconnue" }]), reading, customerText: MAIL.body, sources: [] }).codes).toEqual(["card_not_retrieved_for_need"]);
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision({ reply: `${REWORDED} Limova traduit aussi vos mails.`, facts: REWORDED_FACTS }) },
      verify: { output: { verdict: "non_conforme", problems: [{ code: "unlisted_claim", sentence: "Limova traduit aussi vos mails." }] } },
      correct: { output: smartGoodDecision({ reply: REWORDED, facts: REWORDED_FACTS }) }, reverify: { output: SMART_CONFORME } }, MAIL);
    expect(result).toMatchObject({ outcome: "reply", corrected: true, verdicts: { first: { verdict: "non_conforme" } } });
  });
  it("une référence de fiche manquante est complétée seulement sans ambiguïté (une seule fiche du besoin contient l'extrait)", async () => {
    const facts = [{ ...REWORDED_FACTS[1], cardId: null, version: null, sourceKind: "aucune" }];
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision({ reply: REWORDED, facts }) }, verify: { output: SMART_CONFORME } }, MAIL);
    expect(result).toMatchObject({ outcome: "reply", checks: { first: [] } });
    expect(result.reasons).toContain("facts:source_repaired");
    expect(result.decision!.facts[0]).toMatchObject({ sourceKind: "fiche", cardId: "fiche-connexion", version: "v3" });
    const two: SmartSource[] = [{ cardId: "a", version: "v1", title: "A", content: "Si le code n'arrive pas, vérifiez le dossier des indésirables.", steps: [], needIds: ["n1"] },
      { cardId: "b", version: "v1", title: "B", content: "Si le code n'arrive pas, vérifiez le dossier des indésirables.", steps: [], needIds: ["n1"] }];
    const ambiguous = smartServerChecks({ decision: smartDecisionSchema.parse(smartGoodDecision({ reply: REWORDED, facts })), reading: smartReadingSchema.parse(smartReading()), customerText: "", sources: two });
    expect(ambiguous.codes).toEqual(["fact_source_invalid"]);
  });
  it("mesure gratuite sur les 1 302 keyFacts : réponse reformulée, phrase du fait reformulée ou absente → 0 refus pour une raison de phrase", () => {
    const origins = [...SAV_BENCH_CORPUS, ...SAV_SMART_BENCH_MULTITURN], all = [...origins, ...buildSavBenchVariants(origins)];
    const reading = smartReadingSchema.parse(smartReading());
    const low = (value: string) => value.charAt(0).toLocaleLowerCase("fr") + value.slice(1);
    let total = 0, refused = 0;
    for (const conversation of all) for (const turn of conversation.turns) for (const fact of turn.expect.keyFacts) {
      total++;
      const card: SmartSource = { cardId: "fiche-mesure", version: "v1", title: "Fiche", content: fact, steps: [], needIds: ["n1"] };
      for (const sentence of [`Pour avancer, il faut ${low(fact)} sans attendre.`, undefined]) {
        const decision = smartDecisionSchema.parse({ outcome: "reply", reply: `Bonjour,\n\nEn bref : ${low(fact)}, puis dites-nous si cela bloque.\n\nBelle journée.`, teamNote: null,
          coverage: [{ needId: "n1", status: "answered" }], facts: [{ ...(sentence ? { sentence } : {}), needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: "fiche-mesure", version: "v1", excerpt: fact }] });
        if (smartServerChecks({ decision, reading, customerText: "", sources: [card] }).factProblems.length) refused++;
      }
    }
    expect({ total, refused }).toEqual({ total: 1302, refused: 0 });
  });
});

describe("linkedin-02 tour 2 et autreoutil-05", () => {
  it("la lecture a un exemple : une question d'option payante sur son compte est une question d'offre (abonnement), sans liste de mots", () => {
    expect(smartUnderstandPrompt()).toContain("« Et si je paie une option en plus, c'est possible ? » : il demande si payer lève la limite, une question sur une limite, {\"famille\":\"aucune\"");
  });
  it("autreoutil-05 : le motif du banc n'échoue plus « inscrivez-vous aux webinaires Limova », il refuse toujours une inscription chez Botario", () => {
    const patterns = SAV_BENCH_CORPUS.find(row => row.id === "autreoutil-05")!.turns[0]!.expect.mustNotMatch;
    const hits = (reply: string) => patterns.filter(source => new RegExp(source, "iu").test(reply));
    expect(hits("vous pouvez vous inscrire aux webinaires limova : https://bienvenue.limova.ai/webinaires")).toEqual([]);
    expect(hits("s'inscrire sur https://bienvenue.limova.ai/webinaires")).toEqual([]);
    expect(hits("inscrivez-vous sur botario, c'est gratuit")).not.toEqual([]);
    expect(hits("inscrivez-vous sur botario plutot que limova")).not.toEqual([]);
    expect(hits("botario est plus simple, essayez-le")).not.toEqual([]);
  });
});
