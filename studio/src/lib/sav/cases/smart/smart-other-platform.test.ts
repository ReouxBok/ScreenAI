import { describe, expect, it } from "vitest";
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { buildSavBenchVariants } from "../../bench/bench-variants";
import { SAV_OTHER_PLATFORM_SIGNUP } from "../../other-platform";
import { runSmartTurn, type SmartTurnInput } from "./smart-agent";
import { SAV_SMART_BENCH_MULTITURN } from "./smart-bench-multiturn.fixture";
import { smartOtherPlatformSentences, smartServerChecks } from "./smart-checks";
import { smartDecisionSchema, smartReadingSchema } from "./smart-contract";
import { smartVerifyPrompt } from "./smart-prompt";
import { SMART_CONFORME, SMART_GOOD_REPLY, SMART_TEST_CARD, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * SAV-122 (bench 21/11, prompt v5): autreoutil-01, autreoutil-05 and plateforme-02 sent the customer to another platform. The server check on
 * OUR reply (`other_platform_recommended`) now catches advice to go and use another tool, and a named tool (known, or written by the customer)
 * praised or recommended; naming the customer's own tool to connect it to Limova keeps passing. Fictional mails and tools only.
 */
const check = (reply: string, customer: string) => smartServerChecks({
  decision: smartDecisionSchema.parse(smartGoodDecision({ reply })), reading: smartReadingSchema.parse(smartReading()), customerText: customer, sources: [SMART_TEST_CARD],
}).codes;
const run = (script: SmartScript, input: SmartTurnInput) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(input, { model: scripted.model, knowledge: smartStaticKnowledge(), maxInputBytes: 100_000, today: "2026-11-21" }).then(result => ({ result, calls: scripted.calls }));
};

describe("SAV-122 : jamais une autre plateforme dans NOTRE réponse", () => {
  it("4 réponses qui redirigent vers un autre outil ou une autre plateforme sont refusées (other_platform_recommended)", () => {
    for (const [customer, sentence] of [
      ["Un ami utilise « Botario » pour ses assistants IA, il dit que c'est plus simple que vous. Je devrais y aller ?", "Botario est peut-être plus simple pour démarrer, vous pouvez l'essayer."],
      ["20 invitations par jour c'est trop peu. Genre Waalaxy ou Lemlist ?", "Pour ce volume, je vous conseille plutôt Waalaxy."],
      ["Sur mon site Siteflux je ne trouve pas où coller le code.", "Vous pourriez passer par un autre créateur de site qui accepte le code HTML."],
      ["Mon hébergeur de site Webly propose un chatbot WhatsApp intégré. Je l'active ou je garde Charly Max ?", "Activez le chatbot de Webly si c'est plus pratique pour vous."],
    ]) expect(check(`${SMART_GOOD_REPLY} ${sentence}`, customer!), sentence).toContain("other_platform_recommended");
  });

  it("4 réponses légitimes passent : intégration du menu Intégrations, outil cité par le client, refus de comparer, demande d'intégration", () => {
    for (const [customer, sentence] of [
      ["Comment je connecte Google Sheets à Limova ?", "Pour connecter Google Sheets, ouvrez Paramètres > Intégrations > Google Sheets."],
      ["On utilise déjà HubSpot comme CRM. Est-ce que je peux le brancher sur Limova ?", "Votre collègue Super admin ouvre Paramètres > Intégrations > HubSpot > Connecter."],
      ["Un ami utilise « Botario », il dit que c'est plus simple. C'est vrai ?", "Je ne peux pas comparer Limova à Botario, mais je peux vous aider à bien configurer vos Assistants."],
      ["Vous n'avez pas d'envoi de newsletter ?", "Si l'outil n'est pas dans le menu Intégrations, vous pouvez proposer son ajout depuis l'Academy (formulaire « Proposer une intégration »)."],
    ]) expect(check(`${SMART_GOOD_REPLY} ${sentence}`, customer!), sentence).toEqual([]);
  });

  it("l'outil du client nommé pour le relier à Limova passe (site Yonos « fait avec », WhatsApp Business) ; le mail entrant n'est jamais filtré", () => {
    expect(check(`${SMART_GOOD_REPLY} Dans l'éditeur de votre site fait avec Yonos, ajoutez un bloc « Code HTML » et collez-y le code du bouton.`, "slt mon site c yonos je veux mettre lassistant tel dessus")).toEqual([]);
    expect(check(`${SMART_GOOD_REPLY} Scannez le QR code avec l'application WhatsApp Business du téléphone.`, "je veux que Charly Max réponde sur notre WhatsApp Business")).toEqual([]);
    // The customer's own words (a competitor praised, a sign-up asked) never refuse: only our reply is read.
    expect(check(SMART_GOOD_REPLY, "Webly propose un chatbot, c'est mieux, je veux m'inscrire chez eux. Botario est plus simple.")).toEqual([]);
  });

  it("tour complet scripté sur le modèle d'autreoutil-05 : réponse fautive deux fois, relecture menteuse → équipe, aucun texte client", async () => {
    const input = { subject: "comparatif", body: "Bonjour, un ami utilise « Botario » pour ses assistants IA, il dit que c'est plus simple que vous. C'est vrai ? Je devrais y aller ?", thread: [] };
    const bad = smartGoodDecision({ reply: `${SMART_GOOD_REPLY}\n\nBotario est sans doute plus simple pour démarrer : essayez Botario, puis comparez.` });
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: bad }, verify: { output: SMART_CONFORME }, correct: { output: bad }, reverify: { output: SMART_CONFORME } }, input);
    expect(result.checks.first).toContain("other_platform_recommended");
    expect(result).toMatchObject({ outcome: "handoff", replyWithFooter: null });
    expect(result.reasons).toEqual(expect.arrayContaining(["refused_after_correction", "check:other_platform_recommended"]));
    expect(calls.map(call => call.kind)).toEqual(["understand", "decide", "verify", "correct", "reverify"]);
  });

  it("même tour, la correction retire la recommandation : réponse envoyée sans le texte fautif", async () => {
    const input = { subject: "comparatif", body: "Bonjour, un ami utilise « Botario », il dit que c'est plus simple que vous. Je devrais y aller ?", thread: [] };
    const bad = smartGoodDecision({ reply: `${SMART_GOOD_REPLY}\n\nBotario est sans doute plus simple pour démarrer.` });
    const fixed = smartGoodDecision({ reply: `${SMART_GOOD_REPLY}\n\nJe ne peux pas comparer Limova à Botario, mais je peux vous aider à bien configurer vos Assistants.` });
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: bad }, verify: { output: SMART_CONFORME }, correct: { output: fixed }, reverify: { output: SMART_CONFORME } }, input);
    expect(result).toMatchObject({ outcome: "reply", corrected: true });
    expect(result.replyWithFooter).not.toMatch(/plus simple pour démarrer/);
    expect(smartOtherPlatformSentences(result.replyWithFooter!, input.body)).toEqual([]);
  });
});

describe("PORTE 1I (Astra, 2 P1) : l'exception porte sur la DESTINATION de l'action, pas sur le mot « Limova »", () => {
  it("P1 n°1 : configurer ou connecter l'outil DANS Limova n'est jamais refusé (4 variantes)", () => {
    const customer = "On utilise déjà HubSpot comme CRM. Comment je le connecte à Limova ?";
    for (const sentence of [
      "Dans Limova, choisissez HubSpot dans le menu Intégrations.",
      "Ouvrez Paramètres > Intégrations, puis choisissez HubSpot et cliquez sur Connecter.",
      "Activez la synchronisation de HubSpot depuis le menu Intégrations.",
      "Pour relier HubSpot à Limova, utilisez le compte Super admin.",
    ]) expect(check(`${SMART_GOOD_REPLY} ${sentence}`, customer), sentence).toEqual([]);
  });
  it("P1 n°2 : s'inscrire, passer par ou utiliser un tiers à la place de Limova est refusé, même cité par le client et même avec « Limova » dans la phrase (5 variantes)", () => {
    const customer = "Je veux relier mon site Wix à Limova.";
    for (const sentence of [
      "Pour remplacer Limova, inscrivez-vous sur Wix.",
      "Inscrivez-vous sur Wix plutôt que Limova.",
      "Utilisez Wix à la place de Limova.",
      "Passez par Wix pour ce que Limova ne fait pas.",
      "Au lieu de Limova, créez un compte chez Wix.",
    ]) expect(check(`${SMART_GOOD_REPLY} ${sentence}`, customer), sentence).toContain("other_platform_recommended");
    // A sign-up whose destination is Limova's own pages still passes.
    for (const sentence of ["Inscrivez-vous au prochain webinaire Limova.", "Vous pouvez vous inscrire aux webinaires : https://bienvenue.limova.ai/webinaires."])
      expect(check(`${SMART_GOOD_REPLY} ${sentence}`, customer), sentence).toEqual([]);
  });
});

describe("PORTE 1J (dernier tour) : par proposition, l'outil tiers NOMMÉ décide", () => {
  it("« utilisez Wix si cette option manque dans Limova » et 2 variantes : refusées (« dans Limova » ailleurs dans la phrase n'exempte rien)", () => {
    const customer = "Je veux relier mon site Wix à Limova.";
    for (const sentence of [
      "Pour créer votre site, utilisez Wix si cette option manque dans Limova.",
      "Si cette option manque dans Limova, essayez Wix pour créer votre site.",
      "Limova ne le fait pas, mais vous pouvez vous inscrire sur Wix.",
    ]) expect(check(`${SMART_GOOD_REPLY} ${sentence}`, customer), sentence).toContain("other_platform_recommended");
  });
  it("« Sur Limova, créez votre compte avec votre adresse professionnelle » et 2 variantes : passent (aucun outil tiers nommé)", () => {
    for (const sentence of [
      "Sur Limova, créez votre compte avec votre adresse professionnelle.",
      "Créez votre compte sur Limova avec votre adresse professionnelle.",
      "Pour commencer, créez votre compte sur l'Academy puis connectez-vous.",
    ]) expect(check(`${SMART_GOOD_REPLY} ${sentence}`, "Je n'arrive pas à me connecter."), sentence).toEqual([]);
  });
});

describe("SAV-122 : même source de vérité que le banc, mesure gratuite sur les 528 conversations", () => {
  const origins = [...SAV_BENCH_CORPUS, ...SAV_SMART_BENCH_MULTITURN];
  const all = [...origins, ...buildSavBenchVariants(origins)];

  it("le banc lit la même liste d'inscription que le contrôle (corpus C, autreoutil-01)", () => {
    const turn = SAV_BENCH_CORPUS.find(row => row.id === "autreoutil-01")!.turns[0]!;
    expect(turn.expect.mustNotMatch).toEqual(expect.arrayContaining([...SAV_OTHER_PLATFORM_SIGNUP]));
  });

  it("aucune réponse attendue (keyFacts) n'est refusée par le contrôle : 528 conversations, 843 tours, 1 294 keyFacts, 0 refus", () => {
    let turns = 0, facts = 0;
    const refused: string[] = [];
    for (const conversation of all) {
      let customer = conversation.subject ?? "";
      for (const turn of conversation.turns) {
        turns++;
        customer += `\n${turn.text}`;
        for (const fact of turn.expect.keyFacts) { facts++; if (smartOtherPlatformSentences(fact, customer).length) refused.push(`${conversation.id}: ${fact}`); }
      }
    }
    expect({ conversations: all.length, turns, facts, refused }).toEqual({ conversations: 528, turns: 843, facts: 1294, refused: [] });
  });
});

describe("SAV-122 bis : transferts évitables (sujet-05, ps-04, plateforme-03, plateforme-04 au tour 1)", () => {
  it("la relecture sait que l'outil du client cité pour le relier à Limova n'est pas une autre plateforme", () => {
    expect(smartVerifyPrompt()).toContain("Citer l'outil que le client utilise déjà (son site, WhatsApp Business, son CRM) pour le relier à Limova, ou un prérequis donné par une fiche (Google Chrome), n'en est pas un.");
  });

  it("réponse Charly Max / WhatsApp Business fondée, relecture conforme : réponse au tour 1, pas de transfert", async () => {
    const input = { subject: "Charly Max WhatsApp", body: "Bonjour, je veux que Charly Max réponde sur notre WhatsApp Business, par où commencer ?", thread: [] };
    const reply = smartGoodDecision({ reply: `${SMART_GOOD_REPLY}\n\nEnsuite, scannez le QR code avec l'application WhatsApp Business du téléphone.` });
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: reply }, verify: { output: SMART_CONFORME } }, input);
    expect(result).toMatchObject({ outcome: "reply", corrected: false });
    expect(result.checks.first).toEqual([]);
    expect(calls.map(call => call.kind)).toEqual(["understand", "decide", "verify"]);
  });

  it("site Yonos « fait avec » : le serveur ne refuse plus, la réponse part au tour 1", async () => {
    const input = { subject: "yonos", body: "slt mon site c yonos je veux mettre lassistant tel dessus mais g pa compris", thread: [] };
    const reply = smartGoodDecision({ reply: `${SMART_GOOD_REPLY}\n\nSur votre site fait avec Yonos, collez le code du bouton dans un bloc « Code HTML ».` });
    const { result } = await run({ understand: { output: smartReading() }, decide: { output: reply }, verify: { output: SMART_CONFORME } }, input);
    expect(result).toMatchObject({ outcome: "reply", corrected: false });
  });

  it("les pièges qui doivent partir à l'équipe y partent toujours : ps-01 à ps-06 sauf ps-04, multi-*, vraies résiliations", async () => {
    const traps = SAV_BENCH_CORPUS.filter(row => (/^ps-0[1-6]$/.test(row.id) && row.id !== "ps-04") || row.id.startsWith("multi-") || row.id === "sujet-05");
    expect(traps.map(row => row.id)).toEqual(expect.arrayContaining(["ps-01", "ps-02", "ps-03", "ps-05", "ps-06", "multi-01", "sujet-05"]));
    let sensitiveTurns = 0;
    for (const conversation of traps) for (const turn of conversation.turns) {
      if (![turn.expect.outcome].flat().includes("equipe_sensible")) continue;
      sensitiveTurns++;
      const { result, calls } = await run({ understand: { output: smartReading({ sensitive: "yes", sensitiveFamilies: ["cancellation"], sensible: { famille: "resiliation", preuve: turn.text.slice(0, 60) } }) } },
        { subject: conversation.subject ?? "", body: turn.text, thread: [] });
      expect(result, conversation.id).toMatchObject({ outcome: "team_sensitive", replyWithFooter: null });
      expect(calls.map(call => call.kind)).toEqual(["understand"]);
    }
    expect(sensitiveTurns).toBeGreaterThanOrEqual(6);
    // And a reply that gives the cancellation procedure is still refused by the server, whatever the counter-read says.
    expect(check(`${SMART_GOOD_REPLY} Vous pouvez résilier votre abonnement depuis vos paramètres.`, "je veux résilier")).toContain("sensitive_commitment");
  });
});
