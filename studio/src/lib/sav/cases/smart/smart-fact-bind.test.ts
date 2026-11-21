import { describe, expect, it } from "vitest";
import { savBenchChecks } from "../../bench/bench-checks";
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { accessSkillWireAnswer } from "../access-skill/access-skill-wire";
import { runSmartTurn, type SmartTurnInput } from "./smart-agent";
import { smartBindableSentence, smartFactSentenceInReply } from "./smart-checks";
import { smartBindMeasure } from "./smart-fact-bind.measure";
import { smartReadJson, smartWireResponse } from "./smart-model";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * SAV-122 (bench 21/11 v11, after PR 328): ~14 turns refused twice on `fact_sentence_missing` with `fact_sentence_form:reworded`; 2 turns
 * `output_json_invalid` (decide mdp-03, correct mdp-02); bench failures whose pattern could not be named. Fictional texts only.
 */
const run = (script: SmartScript, input: SmartTurnInput) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(input, { model: scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-21" }).then(result => ({ result, calls: scripted.calls }));
};
const MAIL: SmartTurnInput = { subject: "Connexion impossible", body: "Bonjour, je n'arrive pas à me connecter, le code n'arrive pas.", thread: [] };
// The reply says « Utilisez l'adresse e-mail de votre invitation. »; the fact declares a light rewording of it.
const REWORDED = { sentence: "Utilisez votre adresse e-mail de l'invitation.", needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: "fiche-connexion", version: "v3",
  excerpt: "utilisez l'adresse e-mail de votre invitation" };

describe("rattachement d'un fait reformulé à la vraie phrase de la réponse", () => {
  it("avant : refusé deux fois → équipe ; maintenant le fait prend la phrase réelle, puis passe les contrôles de source et la relecture", async () => {
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision({ facts: [REWORDED] }) }, verify: { output: SMART_CONFORME } }, MAIL);
    expect(result).toMatchObject({ outcome: "reply", corrected: false });
    expect(result.reasons).toContain("facts:bound");
    expect(result.decision!.facts[0]!.sentence).toBe("Utilisez l'adresse e-mail de votre invitation.");
    // The counter-read sees the REAL sentence (its unlisted_claim question reads it).
    expect((calls.find(call => call.kind === "verify")!.payload as { facts: Array<{ sentence: string }> }).facts[0]!.sentence).toBe("Utilisez l'adresse e-mail de votre invitation.");
  });
  it("la phrase réelle doit encore avoir sa source : un extrait absent de la fiche reste refusé après rattachement", async () => {
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision({ facts: [{ ...REWORDED, excerpt: "un extrait inventé" }] }) },
      verify: { output: SMART_CONFORME }, correct: { output: smartGoodDecision({ facts: [{ ...REWORDED, excerpt: "un extrait inventé" }] }) }, reverify: { output: SMART_CONFORME } }, MAIL);
    expect(result.checks.first).toEqual(["excerpt_not_found"]);
    expect(result.outcome).toBe("handoff");
  });
  it("jamais vers une phrase qui dit autre chose : autre chiffre, négation ajoutée ou retirée, ressemblance faible", () => {
    const reply = "Bonjour,\n\nL'invitation envoyée par mail reste valable 7 jours.\nNe partagez jamais votre mot de passe.\nVous pouvez inviter jusqu'à 5 collaborateurs.\n\nBelle journée.";
    expect(smartBindableSentence(reply, "L'invitation reste valable 7 jours, envoyée par mail.")).toBe("L'invitation envoyée par mail reste valable 7 jours.");
    expect(smartBindableSentence(reply, "L'invitation reste valable 30 jours, envoyée par mail.")).toBeNull();
    expect(smartBindableSentence(reply, "Partagez votre mot de passe.")).toBeNull();
    expect(smartBindableSentence(reply, "Vous ne pouvez pas inviter de collaborateurs.")).toBeNull();
    expect(smartBindableSentence(reply, "Le support réinitialise votre accès.")).toBeNull();
    // A declared sentence found right after a negation of the reply is not « in » it.
    expect(smartFactSentenceInReply(reply, "partagez votre mot de passe")).toBe(false);
  });
  it("mesure gratuite sur les 1 334 keyFacts : reformulations légères acceptées, fausses toujours refusées", () => {
    expect(smartBindMeasure()).toEqual({ total: 1334,
      light: { article: { applicable: 731, accepted: 694, refused: 37 }, ordre: { applicable: 165, accepted: 165, refused: 0 }, synonyme: { applicable: 140, accepted: 68, refused: 72 } },
      wrong: { chiffre: { applicable: 114, accepted: 0, refused: 114 }, negation: { applicable: 1330, accepted: 0, refused: 1330 } } });
  });
  it("absent : la correction reçoit la consigne de retirer ce fait, pas de réécrire la réponse", async () => {
    const absent = { sentence: "Le plan Pro vous est offert ce mois-ci.", needId: "n1", type: "conseil", sourceKind: "aucune", cardId: null, version: null, excerpt: null };
    const { calls } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision({ facts: [...smartGoodDecision().facts, absent] }) }, verify: { output: SMART_CONFORME },
      correct: { output: smartGoodDecision() }, reverify: { output: SMART_CONFORME } }, MAIL);
    const correction = calls.find(call => call.kind === "correct")!.payload as { problems: Array<Record<string, string>> };
    expect(correction.problems).toEqual([{ code: "fact_sentence_missing", sentence: absent.sentence, fix: "retire ce fait de facts : il n'est pas dans la réponse" }]);
  });
});

describe("output_json_invalid : pas la réflexion « low » (une sortie coupée finit en MAX_TOKENS, lue avant), mais la forme du texte", () => {
  const answer = (text: string, finishReason = "STOP") => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
  it("une sortie coupée reste finish_not_stop, jamais lue comme du JSON", () => {
    expect(smartWireResponse(answer("{\"action\":\"fin", "MAX_TOKENS"))).toMatchObject({ status: "failed", problem: "finish_not_stop" });
  });
  it("les formes réparables sans deviner sont lues ; les autres sont refusées avec leur forme (code fermé, jamais le texte)", () => {
    const value = { action: "final", calls: [] };
    expect(smartReadJson("```json\n{\"action\":\"final\",\"calls\":[]}\n```")).toEqual({ ok: true, value, form: "fenced" });
    expect(smartReadJson("Voici ma décision : {\"action\":\"final\",\"calls\":[]}")).toEqual({ ok: true, value, form: "leading_text" });
    expect(smartReadJson("{\"action\":\"final\",\"calls\":[]}\n{\"action\":\"final\"}")).toEqual({ ok: true, value, form: "trailing_text" });
    expect(smartReadJson("{\"reply\":\"Bonjour,\nBelle journée.\"}")).toEqual({ ok: true, value: { reply: "Bonjour,\nBelle journée." }, form: "control_char" });
    expect(smartReadJson("{\"action\":\"final\",\"calls\":[")).toEqual({ ok: false, form: "unbalanced" });
    expect(smartReadJson("{\"action\": final}")).toEqual({ ok: false, form: "other" });
    expect(smartWireResponse(answer("{\"action\": final}"))).toMatchObject({ status: "failed", problem: "output_json_invalid:other" });
    expect(smartWireResponse(accessSkillWireAnswer({ ok: true }))).toMatchObject({ status: "ok", output: { ok: true } });
  });
});

describe("banc : le motif qui a déclenché est nommé (index ou étiquette), jamais le texte", () => {
  it("forbidden_pattern:<index> et foreign_link:customer_url|new_url", () => {
    const conversation = SAV_BENCH_CORPUS.find(row => row.id === "plateforme-05")!;
    const expect5 = conversation.turns[0]!.expect;
    const hits = savBenchChecks({ conversation, expect: expect5, customerText: conversation.turns[0]!.text, previousReplies: [], cards: [], expiredCardIds: [],
      turn: { outcome: "repondre", reply: "Inscrivez-vous sur Yonos : https://yonos.exemple.invalid/inscription", citations: [], codes: [] } });
    const labels = hits.flatMap(hit => hit.label ? [hit.label] : []);
    expect(labels).toEqual(expect.arrayContaining(["foreign_link:new_url", "forbidden_pattern:0"]));
    expect(labels.every(label => /^(forbidden_pattern:\d+|foreign_link:(customer_url|new_url))$/.test(label))).toBe(true);
  });
});
