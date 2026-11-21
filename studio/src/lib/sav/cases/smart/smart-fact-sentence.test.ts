import { describe, expect, it } from "vitest";
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { buildSavBenchVariants } from "../../bench/bench-variants";
import { normalizeSavEvidenceText, savEvidenceContains } from "../../evidence-text";
import { runSmartTurn, type SmartTurnInput } from "./smart-agent";
import { SAV_SMART_BENCH_MULTITURN } from "./smart-bench-multiturn.fixture";
import { smartFactSentenceInReply } from "./smart-checks";
import { smartUnderstandPrompt } from "./smart-prompt";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * SAV-122 (bench 21/11 v7, diagnostic codes): sujet-03 and sujet-05 handed over on `fact_sentence_missing` twice while the counter-read said
 * « conforme »; linkedin-02 turn 2 answered an offer question; autreoutil-05 was failed by the bench's bare « inscri ». Fictional texts only.
 */
const run = (script: SmartScript, input: SmartTurnInput) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(input, { model: scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-21" }).then(result => ({ result, calls: scripted.calls }));
};
const MAIL: SmartTurnInput = { subject: "Connexion impossible", body: "Bonjour, je n'arrive pas à me connecter, le code n'arrive pas.", thread: [] };
// A numbered step without a final period, the fact written as a sentence (capital, period): the form the model produced on sujet-03 / sujet-05.
const STEPS = "Bonjour,\n\nVoici quoi faire :\n1. Utilisez l'adresse e-mail de votre invitation\n2. Regardez dans le dossier des indésirables\n\nSi cela bloque encore, dites-nous quel message s'affiche.\n\nBelle journée.";
const before = (reply: string, sentence: string) => savEvidenceContains(reply, sentence) || normalizeSavEvidenceText(reply).includes(normalizeSavEvidenceText(sentence));

describe("fact_sentence_missing : la phrase du fait est dans la réponse, quelle que soit sa forme de liste", () => {
  it("cause prouvée : avant, une étape numérotée sans point final ou une casse différente ratait le contrôle ; maintenant elle passe", () => {
    expect(before(STEPS, "Utilisez l'adresse e-mail de votre invitation.")).toBe(false);
    expect(before(STEPS, "utilisez l'adresse e-mail de votre invitation")).toBe(false);
    expect(smartFactSentenceInReply(STEPS, "Utilisez l'adresse e-mail de votre invitation.")).toBe(true);
    expect(smartFactSentenceInReply(STEPS, "utilisez l'adresse e-mail de votre invitation")).toBe(true);
    expect(smartFactSentenceInReply(STEPS, "1. Utilisez l'adresse e-mail de votre invitation")).toBe(true);
  });
  it("le principe reste : une phrase absente de la réponse est toujours refusée", () => {
    expect(smartFactSentenceInReply(STEPS, "Le plan Pro vous est offert.")).toBe(false);
    expect(smartFactSentenceInReply(STEPS, "Utilisez l'adresse de votre collègue.")).toBe(false);
  });
  it("tour scripté type sujet-03 : étapes numérotées, faits écrits en phrases, relecture conforme → réponse en 3 appels (avant : refusé deux fois → équipe)", async () => {
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision({ reply: STEPS }) }, verify: { output: SMART_CONFORME } }, MAIL);
    expect(result.checks.first).toEqual([]);
    expect(result).toMatchObject({ outcome: "reply", corrected: false });
    expect(calls.map(call => call.kind)).toEqual(["understand", "decide", "verify"]);
  });
  it("cause prouvée n°2 : la correction reçoit maintenant LA phrase manquante (avant : sentence vide, impossible à réparer)", async () => {
    const absent = "Le support réinitialise votre accès sous une heure.";
    const bad = smartGoodDecision({ facts: [...smartGoodDecision().facts, { sentence: absent, needId: "n1", type: "conseil", sourceKind: "aucune", cardId: null, version: null, excerpt: null }] });
    const { calls } = await run({ understand: { output: smartReading() }, decide: { output: bad }, verify: { output: SMART_CONFORME }, correct: { output: smartGoodDecision() }, reverify: { output: SMART_CONFORME } }, MAIL);
    const correction = calls.find(call => call.kind === "correct")!.payload as { problems: Array<{ code: string; sentence: string }> };
    expect(correction.problems).toEqual(expect.arrayContaining([{ code: "fact_sentence_missing", sentence: absent }]));
  });
  it("mesure gratuite sur les 1 334 keyFacts (528 conversations) : refus avant → après, par forme", () => {
    const origins = [...SAV_BENCH_CORPUS, ...SAV_SMART_BENCH_MULTITURN], all = [...origins, ...buildSavBenchVariants(origins)];
    const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
    const forms: Record<string, (fact: string) => [string, string]> = {
      exact: fact => [`Bonjour,\n\n${cap(fact)}.\n\nBelle journée.`, `${cap(fact)}.`],
      liste_sans_point: fact => [`Bonjour,\n\n1. ${cap(fact)}\n2. Dites-nous si cela bloque.\n\nBelle journée.`, `${cap(fact)}.`],
      casse: fact => [`Bonjour,\n\n${cap(fact)}.\n\nBelle journée.`, fact],
    };
    let total = 0;
    const counts: Record<string, { before: number; after: number }> = {};
    for (const conversation of all) for (const turn of conversation.turns) for (const fact of turn.expect.keyFacts) {
      total++;
      for (const [name, form] of Object.entries(forms)) {
        const [reply, sentence] = form(fact), row = counts[name] ??= { before: 0, after: 0 };
        if (!before(reply, sentence)) row.before++;
        if (!smartFactSentenceInReply(reply, sentence)) row.after++;
      }
    }
    expect({ total, counts }).toEqual({ total: 1334, counts: { exact: { before: 0, after: 0 }, liste_sans_point: { before: 1334, after: 0 }, casse: { before: 745, after: 0 } } });
  });
});

describe("linkedin-02 tour 2 et autreoutil-05", () => {
  it("la lecture a un exemple : une question d'option payante sur son compte est une question d'offre (abonnement), sans liste de mots", () => {
    expect(smartUnderstandPrompt()).toContain("« Et si je paie une option en plus, c'est possible ? » : il veut payer une offre, {\"famille\":\"abonnement\"");
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
