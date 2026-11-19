import { describe, expect, it } from "vitest";
import { SAV_REPLY_NOTICE, SAV_REPLY_SIGNATURE } from "../../reply-format";
import { runSmartTurn, type SmartTurnInput } from "./smart-agent";
import { smartDecidePrompt, smartUnderstandPrompt, smartVerifyPrompt } from "./smart-prompt";
import {
  SMART_CONFORME, SMART_GOOD_REPLY, SMART_TEST_CARD, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript,
} from "./smart-test-doubles";

/*
 * Agent SAV intelligent, lots D1-D3 (20/11): one turn with a SCRIPTED model (no network, no money). Fictional mails only.
 */
const MAIL: SmartTurnInput = { subject: "Connexion impossible", body: "Bonjour,\nJe n'arrive pas à me connecter, j'ai demandé un nouveau code mais rien.\nMerci", thread: [] };
const run = (script: SmartScript, input: SmartTurnInput = MAIL, knowledge = smartStaticKnowledge(), maxInputBytes = 100_000) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(input, { model: scripted.model, knowledge, maxInputBytes, today: "2026-11-20" }).then(result => ({ result, calls: scripted.calls, knowledge }));
};
const YONOS = "Bonjour,\n\nYonos fait des agents téléphoniques. Inscrivez-vous chez eux pour cela.\n\nBelle journée.";

describe("parcours nominal", () => {
  it("comprendre, chercher, décider, vérifier : 3 appels, la réponse porte la mention IA ajoutée par le serveur", async () => {
    const { result, calls, knowledge } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } });
    expect(result.outcome).toBe("reply");
    expect(calls.map(call => call.kind)).toEqual(["understand", "decide", "verify"]);
    expect(knowledge.calls).toBe(1);
    expect(result.replyWithFooter).toContain(SMART_GOOD_REPLY);
    expect(result.replyWithFooter).toContain(SAV_REPLY_SIGNATURE);
    expect(result.replyWithFooter).toContain(SAV_REPLY_NOTICE);
    expect(result.checks.first).toEqual([]);
    expect(calls[0]!.system).toBe(smartUnderstandPrompt());
    expect(calls[1]!.system).toBe(smartDecidePrompt());
    expect(calls[2]!.system).toBe(smartVerifyPrompt());
  });
  it("la relecture est indépendante : elle ne reçoit ni le raisonnement, ni la note d'équipe, ni les fiches", async () => {
    const { calls } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision({ teamNote: "note interne" }) }, verify: { output: SMART_CONFORME } });
    const verify = calls.find(call => call.kind === "verify")!.payload as Record<string, unknown>;
    expect(Object.keys(verify).sort()).toEqual(["customer", "facts", "needs", "reply"]);
    expect(JSON.stringify(verify)).not.toContain("note interne");
  });
  it("adresses mail et secrets sont masqués avant l'appel au modèle", async () => {
    const input = { ...MAIL, body: "Bonjour, mon adresse est client.fictif@exemple.invalid et mon mot de passe est Soleil2024! Je n'arrive pas à me connecter." };
    const { calls } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } }, input);
    const sent = JSON.stringify(calls.map(call => call.payload));
    expect(sent).not.toContain("client.fictif@exemple.invalid");
    expect(sent).not.toContain("Soleil2024!");
    expect(sent).toContain("[adresse masquée]");
  });
});

describe("sensible : tout le mail à l'équipe", () => {
  it("PS de résiliation APRÈS la signature : le filet lit le texte intégral, 0 appel payé", async () => {
    const body = "Bonjour,\nJe n'arrive pas à me connecter à mon espace.\nCordialement,\nJean Fictif\nGérant\n\nPS : je veux résilier mon abonnement.";
    const { result, calls, knowledge } = await run({}, { ...MAIL, body });
    expect(result).toMatchObject({ outcome: "team_sensitive", sensitiveStop: "net" });
    expect(result.reasons).toContain("kernel:resilier");
    expect(calls).toEqual([]);
    expect(knowledge.calls).toBe(0);
  });
  it("« problème de connexion » puis, après la signature, « je conteste cette facture » : équipe, 0 appel (cas d'Astra)", async () => {
    const body = "Bonjour,\nproblème de connexion depuis ce matin.\n--\nJean Fictif\nSociété Fictive\nje conteste cette facture";
    const { result, calls } = await run({}, { ...MAIL, body });
    expect(result.outcome).toBe("team_sensitive");
    expect(result.reasons).toContain("sensitive:finance");
    expect(calls).toEqual([]);
  });
  it("la lecture dit sensible ou doute : équipe, aucune recherche ni décision", async () => {
    for (const sensitive of ["yes", "doubt"]) {
      const { result, calls, knowledge } = await run({ understand: { output: smartReading({ sensitive, sensitiveFamilies: ["identity"] }) } });
      expect(result).toMatchObject({ outcome: "team_sensitive", sensitiveStop: "understand" });
      expect(calls.map(call => call.kind)).toEqual(["understand"]);
      expect(knowledge.calls).toBe(0);
    }
  });
  it("le client demande une personne : passage de main sans décision", async () => {
    const { result, calls } = await run({ understand: { output: smartReading({ wantsHuman: true }) } });
    expect(result.outcome).toBe("handoff");
    expect(calls.map(call => call.kind)).toEqual(["understand"]);
  });
});

describe("contrôles serveur, relecture et une correction", () => {
  it("Yonos recommandé SANS lien, même nommé par le client, relecture menteuse : refusé deux fois, puis équipe", async () => {
    const input = { ...MAIL, body: "Bonjour, je voudrais connecter mon agent téléphonique à mon site Yonos. Comment faire ?" };
    const yonos = smartGoodDecision({ reply: YONOS, facts: [] });
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: yonos }, verify: { output: SMART_CONFORME }, correct: { output: yonos }, reverify: { output: SMART_CONFORME } }, input);
    expect(result.checks.first).toContain("other_platform_recommended");
    expect(result.verdicts.first?.verdict).toBe("conforme");
    expect(result.outcome).toBe("handoff");
    expect(result.reasons).toEqual(expect.arrayContaining(["refused_after_correction", "check:other_platform_recommended"]));
    expect(result.replyWithFooter).toBeNull();
    expect(calls.map(call => call.kind)).toEqual(["understand", "decide", "verify", "correct", "reverify"]);
  });
  it("une demande de mot de passe est refusée", async () => {
    const reply = `${SMART_GOOD_REPLY}\n\nPouvez-vous nous envoyer votre mot de passe ?`;
    const bad = smartGoodDecision({ reply });
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: bad }, verify: { output: SMART_CONFORME }, correct: { output: bad }, reverify: { output: SMART_CONFORME } });
    expect(result.checks.first).toContain("credential_request");
    expect(result.outcome).toBe("handoff");
  });
  it("relecture menteuse sur un extrait inventé : le serveur refuse, la correction est acceptée", async () => {
    const invented = smartGoodDecision({ facts: [{ ...smartGoodDecision().facts[0], excerpt: "la connexion se fait par SMS uniquement" }] });
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: invented }, verify: { output: SMART_CONFORME },
      correct: { output: smartGoodDecision() }, reverify: { output: SMART_CONFORME } });
    expect(result.checks.first).toEqual(["excerpt_not_found"]);
    expect(result.verdicts.first?.verdict).toBe("conforme");
    expect(result).toMatchObject({ outcome: "reply", corrected: true });
    expect(result.checks.second).toEqual([]);
    const correction = calls.find(call => call.kind === "correct")!.payload as { problems: Array<{ code: string }> };
    expect(correction.problems.map(problem => problem.code)).toContain("excerpt_not_found");
  });
  it("la relecture refuse (capacité déguisée en conseil) : une correction, puis équipe si elle refuse encore", async () => {
    const refuse = { verdict: "non_conforme", problems: [{ code: "unlisted_claim", sentence: "Limova le fait automatiquement." }] };
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: refuse }, correct: { output: smartGoodDecision() }, reverify: { output: refuse } });
    expect(result.outcome).toBe("handoff");
    expect(result.reasons).toEqual(expect.arrayContaining(["refused_after_correction", "verify:unlisted_claim"]));
  });
  it("promesse de délai, lien hors liste, fiche d'un autre besoin : refusés", async () => {
    const reply = `${SMART_GOOD_REPLY}\n\nNous allons corriger cela sous 48 heures. Voir https://exemple-tiers.invalid/guide ou yonos.com.`;
    const other = smartGoodDecision({ reply, facts: [{ ...smartGoodDecision().facts[0], needId: "n2" }] });
    const reading = smartReading({ needs: [...smartReading().needs, { id: "n2", ask: "autre chose", alreadyDone: [], theme: null, search: "autre" }] });
    const { result } = await run({ understand: { output: reading }, decide: { output: { ...other, coverage: [{ needId: "n1", status: "answered" }, { needId: "n2", status: "answered" }] } },
      verify: { output: SMART_CONFORME }, correct: { fail: "http_500" } });
    expect(result.checks.first).toEqual(expect.arrayContaining(["promise_unsourced", "link_not_allowed", "card_not_retrieved_for_need", "third_party_named"]));
    expect(result.outcome).toBe("handoff");
  });
  it("une fiche temporaire expirée n'est jamais donnée au modèle", async () => {
    const expired = { ...SMART_TEST_CARD, cardId: "bug-en-cours", validUntil: "2026-11-19" };
    const { calls, result } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } }, MAIL, smartStaticKnowledge([SMART_TEST_CARD, expired]));
    const cards = (calls.find(call => call.kind === "decide")!.payload as { cards: Array<{ cardId: string }> }).cards.map(card => card.cardId);
    expect(cards).toEqual(["fiche-connexion"]);
    expect(result.sources.map(source => source.cardId)).toEqual(["fiche-connexion"]);
  });
  it("au-dessus du plafond d'octets : le fil puis les fiches les moins pertinentes sont retirés ; trop gros même vide : équipe sans appel de décision", async () => {
    const big = { ...SMART_TEST_CARD, cardId: "grosse", content: "x".repeat(30_000) };
    const small = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } }, MAIL, smartStaticKnowledge([SMART_TEST_CARD, big]), 24_000);
    expect(small.result.reasons).toContain("cut:cards");
    expect(small.result.sources.map(source => source.cardId)).toEqual(["fiche-connexion"]);
    const tiny = await run({ understand: { output: smartReading() } }, MAIL, smartStaticKnowledge(), 6_000);
    expect(tiny.result.reasons).toContain("decide:input_too_large");
    expect(tiny.calls.map(call => call.kind)).toEqual(["understand"]);
  });
});

describe("pannes et temps", () => {
  it("à court de temps pendant la décision : le tour s'arrête proprement (interrupted), sans autre appel", async () => {
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { deadline: true } });
    expect(result.outcome).toBe("interrupted");
    expect(result.reasons).toEqual(["decide:deadline"]);
    expect(calls.map(call => call.kind)).toEqual(["understand", "decide"]);
  });
  it("sortie hors contrat ou modèle en panne : échec codé, jamais une réponse", async () => {
    expect((await run({ understand: { output: { needs: "?" } } })).result).toMatchObject({ outcome: "failed", reasons: ["understand:output_invalid"], replyWithFooter: null });
    expect((await run({ understand: { fail: "http_503", uncertain: true } })).result).toMatchObject({ outcome: "failed", reasons: ["understand:http_503"] });
    const down = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { fail: "network_failed" } });
    expect(down.result.outcome).toBe("handoff");
    expect(down.result.replyWithFooter).toBeNull();
  });
});
