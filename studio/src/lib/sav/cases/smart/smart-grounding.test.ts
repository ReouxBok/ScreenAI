import { describe, expect, it } from "vitest";
import { runSmartTurn, SAV_SMART_MAX_MODEL_CALLS, type SmartKnowledgePort, type SmartKnowledgeResult, type SmartTurnInput } from "./smart-agent";
import { smartServerChecks, type SmartSource } from "./smart-checks";
import { smartDecisionSchema, smartReadingSchema } from "./smart-contract";
import { SAV_SMART_CORRECTION_INSTRUCTION, smartCorrectionPrompt, smartDecidePrompt, smartUnderstandPrompt, smartVerifyPrompt } from "./smart-prompt";
import { createSmartToolRunner, smartSearchWithRetry } from "./smart-tools";
import { SMART_CONFORME, SMART_GOOD_REPLY, SMART_TEST_CARD, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * v17 (22/11): strict grounding of the replies in the cards. A production bench on the real cards found 23 % of replies with a claim no returned card
 * carries (an invented menu path or button, a generic cause stated as fact, a status, an invented how-to). Model-led: the counter-read names the exact
 * phrase, the correction removes it or asks ONE precise question; no word list on the server. Fictional mails, cards and tools only (public repository).
 */
const MAIL: SmartTurnInput = { subject: "Connexion", body: "Bonjour, je n'arrive pas à me connecter.", thread: [] };
const run = (script: SmartScript, knowledge: SmartKnowledgePort = smartStaticKnowledge()) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(MAIL, { model: scripted.model, knowledge, maxInputBytes: 100_000, today: "2026-11-22", recordOwn: true })
    .then(result => ({ result, calls: scripted.calls, kinds: scripted.calls.map(call => call.kind) }));
};
const INVENTED_CAUSE = "Cela survient souvent quand l'autorisation a expiré.";
const withCause = smartGoodDecision({ reply: `Bonjour,\n\nVous n'arrivez pas à vous connecter. ${INVENTED_CAUSE} Utilisez l'adresse e-mail de votre invitation.\n\nBelle journée.` });
const unlisted = { verdict: "non_conforme", problems: [{ code: "unlisted_claim", sentence: INVENTED_CAUSE }] };
const QUESTION = "Bonjour,\n\nVous n'arrivez pas à vous connecter. Utilisez l'adresse e-mail de votre invitation. Si cela bloque encore, quel message exact s'affiche à l'écran ?\n\nBelle journée.";
const asks = smartGoodDecision({ outcome: "ask", reply: QUESTION, coverage: [{ needId: "n1", status: "asked" }] });

describe("1. relecture : tout chemin, bouton, cause, état, délai ou limite doit être dans un extrait cité", () => {
  it("la règle d'ancrage, l'atténuation qui ne sauve rien, le passage exact et 4 exemples du bench sont dans le prompt de relecture", () => {
    const verify = smartVerifyPrompt();
    expect(verify).toContain("Tout chemin, menu, bouton, libellé, cause, état du service, délai, durée de validité ou limite écrit dans la réponse doit figurer dans un extrait cité ; sinon unlisted_claim, et sentence copie le passage exact.");
    expect(verify).toContain("« souvent », « généralement », « il arrive que » ne rendent pas acceptable une affirmation sans extrait.");
    for (const example of ["« depuis Intégrations > Comptes connectés »", "« relancez-la depuis la liste des utilisateurs »", "« cela survient souvent quand l'autorisation a expiré »", "« Il n'y a pas de maintenance générale signalée »"])
      expect(verify, example).toContain(example);
    // The safeguards that protect good replies stay.
    expect(verify).toContain("Une étape qui reprend une fiche citée dans facts n'est pas unlisted_claim.");
    expect(verify).toContain("Nommer l'Academy de Limova n'en est pas un.");
  });
  it("décision : décrire seulement ce que disent les fiches ; cause absente : demander ce que le client voit", () => {
    expect(smartDecidePrompt()).toContain("Décris seulement ce que disent les fiches (chemin, bouton, cause, délai, limite). Cause absente de la fiche : ne la devine pas, même avec « souvent » ; demande ce que le client voit (message exact, écran).");
  });
  it("7. fait produit : Limova n'a pas de mot de passe (compréhension et décision)", () => {
    expect(smartUnderstandPrompt()).toContain("Limova n'a pas de mot de passe : on s'y connecte toujours avec un code à usage unique reçu par e-mail");
    expect(smartDecidePrompt()).toContain("Limova n'a pas de mot de passe : connexion toujours par un code à usage unique reçu par e-mail (note comprise).");
  });
});

describe("2. correction : retirer le passage sans source, garder les étapes portées, sinon UNE question", () => {
  it("la consigne de correction le dit, y compris en resserrement (narrow)", () => {
    // v18: keep everything useful; drop only the named passage; a handoff only when nothing useful is left.
    expect(SAV_SMART_CORRECTION_INSTRUCTION).toContain("garde tout le reste. unlisted_claim ou source_mismatch : retire seulement le passage nommé, sans le reformuler ; garde les étapes que les extraits portent.");
    expect(SAV_SMART_CORRECTION_INSTRUCTION).toContain("Besoin resté sans réponse : UNE question précise hors askedBefore. Handoff si rien d'utile ne reste.");
    expect(SAV_SMART_CORRECTION_INSTRUCTION).toContain("narrow à true : seulement ce que les extraits portent mot pour mot.");
    expect(smartCorrectionPrompt().endsWith(SAV_SMART_CORRECTION_INSTRUCTION)).toBe(true);
  });
  // v18: when the reply keeps its card step without the passage, the server drops the passage and sends the rest (smart-v18.test.ts). Here the cause
  // stands next to a step no card carries: nothing grounded would remain, so the model's correction runs as before.
  const causeOnly = smartGoodDecision({ reply: `Bonjour,\n\nVous n'arrivez pas à vous connecter. ${INVENTED_CAUSE}\n\nBelle journée.` });
  it("v18 : la phrase nommée retirée, l'étape de la fiche reste → envoyée sans correction (3 appels)", async () => {
    const { result, kinds } = await run({ understand: { output: smartReading() }, decide: { output: withCause }, verify: { output: unlisted } });
    expect(kinds).toEqual(["understand", "decide", "verify"]);
    expect(result).toMatchObject({ outcome: "reply", corrected: false });
    expect(result.replyWithFooter).toContain("Utilisez l'adresse e-mail de votre invitation.");
    expect(result.replyWithFooter).not.toContain("autorisation a expiré");
  });
  it("cause inventée nommée par la relecture : la correction reçoit la phrase exacte, retire la cause et pose une question ; envoyée telle quelle (ask)", async () => {
    const { result, calls, kinds } = await run({ understand: { output: smartReading() }, decide: { output: causeOnly }, verify: { output: unlisted },
      correct: { output: asks }, reverify: { output: SMART_CONFORME } });
    expect(kinds).toEqual(["understand", "decide", "verify", "correct", "reverify"]);
    expect(calls[3]!.system).toBe(smartCorrectionPrompt());
    expect(calls[3]!.payload).toMatchObject({ lastStep: true, tools: [], problems: [{ code: "unlisted_claim", sentence: INVENTED_CAUSE }] });
    expect(result).toMatchObject({ outcome: "ask", corrected: true });
    expect(result.replyWithFooter).toContain("quel message exact s'affiche");
    expect(result.replyWithFooter).not.toContain("autorisation a expiré");
  });
  it("la cause revient après la 1re correction : le resserrement (narrow) reçoit la phrase et finit par une question, dans le budget d'appels", async () => {
    const { result, calls, kinds } = await run({ understand: { output: smartReading() }, decide: { output: causeOnly }, verify: { output: unlisted },
      correct: [{ output: causeOnly }, { output: asks }], reverify: [{ output: unlisted }, { output: SMART_CONFORME }] });
    expect(kinds).toEqual(["understand", "decide", "verify", "correct", "reverify", "correct", "reverify"]);
    expect(kinds.length).toBeLessThanOrEqual(SAV_SMART_MAX_MODEL_CALLS);
    expect(calls[5]!.payload).toMatchObject({ narrow: true, lastStep: true, tools: [], problems: [{ code: "unlisted_claim", sentence: INVENTED_CAUSE }] });
    expect(result.reasons).toContain("correction:narrowed");
    expect(result).toMatchObject({ outcome: "ask" });
    expect(result.replyWithFooter).not.toContain("autorisation a expiré");
  });
});

describe("6. recherche de fiches indisponible (transitoire) : une nouvelle tentative avant d'abandonner", () => {
  const unavailable: SmartKnowledgeResult = { status: "unavailable", sources: [], codes: ["n1:search_unavailable", "knowledge_search_unavailable"] };
  const ok: SmartKnowledgeResult = { status: "ok", sources: [SMART_TEST_CARD], codes: ["n1:candidates"] };
  const scripted = (answers: SmartKnowledgeResult[]) => {
    const port = Object.assign(async () => answers[Math.min(port.calls++, answers.length - 1)]!, { calls: 0 });
    return port;
  };
  it("1re recherche en échec transitoire puis réussie : la fiche est donnée au modèle et la réponse part", async () => {
    const knowledge = scripted([unavailable, ok]);
    const { result, calls } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } }, knowledge);
    expect(knowledge.calls).toBe(2);
    expect(result.outcome).toBe("reply");
    expect(result.reasons).toContain("knowledge:search_retried");
    expect(result.reasons).not.toContain("knowledge:unavailable");
    expect((calls[1]!.payload as { cards: Array<{ cardId: string }> }).cards.map(row => row.cardId)).toEqual(["fiche-connexion"]);
  });
  it("une seule nouvelle tentative ; un échec non transitoire (révision instable) n'est pas retenté", async () => {
    const down = scripted([unavailable]);
    expect(await smartSearchWithRetry(down, smartReading().needs)).toMatchObject({ status: "unavailable", codes: expect.arrayContaining(["search_retried"]) });
    expect(down.calls).toBe(2);
    const unstable = scripted([{ status: "unavailable", sources: [], codes: ["n1:revision_unstable", "knowledge_revision_unstable"] }]);
    expect((await smartSearchWithRetry(unstable, smartReading().needs)).codes).not.toContain("search_retried");
    expect(unstable.calls).toBe(1);
    const fine = scripted([ok]);
    expect(await smartSearchWithRetry(fine, smartReading().needs)).toEqual(ok);
    expect(fine.calls).toBe(1);
  });
  it("l'outil chercher_fiches retente aussi une fois (« search_failed » du port)", async () => {
    const knowledge = scripted([{ status: "unavailable", sources: [], codes: ["search_failed"] }, ok]);
    const tools = createSmartToolRunner({ knowledge, academy: [], customerText: "connexion", needIds: ["n1"], today: "2026-11-22", given: [] });
    const [outcome] = await tools.run([{ id: "t1", tool: "chercher_fiches", needId: "n1", args: { recherche: "connexion code" } }]);
    expect(outcome).toMatchObject({ status: "ok", code: null });
    expect(knowledge.calls).toBe(2);
    expect(tools.used()).toBe(1);
  });
});

describe("5. liens : la même règle que le prompt (fiche, résultat Academy, ressources), écrits avec ou sans https", () => {
  const check = (reply: string, extra: { cards?: SmartSource[]; academy?: Array<{ callId: string; needId: string; text: string }> } = {}) => smartServerChecks({
    decision: smartDecisionSchema.parse(smartGoodDecision({ reply })), reading: smartReadingSchema.parse(smartReading()), customerText: "Je n'arrive pas à me connecter.",
    sources: extra.cards ?? [SMART_TEST_CARD], academy: extra.academy ?? [],
  }).codes;
  it("les ressources officielles (webinaires, Academy) passent avec ou sans https", () => {
    for (const link of ["https://bienvenue.limova.ai/webinaires", "bienvenue.limova.ai/webinaires", "https://academy.limova.ai", "academy.limova.ai"])
      expect(check(`${SMART_GOOD_REPLY} Voir : ${link}.`), link).toEqual([]);
  });
  it("une page inventée sur un hôte admis est refusée avec ou sans https (avant : sans https, seul l'hôte était lu)", () => {
    for (const link of ["https://bienvenue.limova.ai/inscription", "bienvenue.limova.ai/inscription"])
      expect(check(`${SMART_GOOD_REPLY} Voir : ${link}.`), link).toContain("link_not_allowed");
  });
  it("un lien Limova officiel donné par un résultat Academy de ce tour passe (règle 6 du prompt) ; le même lien sans résultat Academy est refusé", () => {
    const academy = [{ callId: "t1", needId: "n1", text: "Guide de connexion : https://bienvenue.limova.ai/guides/connexion-gmail ; vidéo : https://videos.exemple-tiers.invalid/gmail" }];
    const reply = `${SMART_GOOD_REPLY} Le guide : https://bienvenue.limova.ai/guides/connexion-gmail`;
    expect(check(reply, { academy })).toEqual([]);
    expect(check(reply)).toContain("link_not_allowed");
    expect(check(`${SMART_GOOD_REPLY} Le guide : https://bienvenue.limova.ai/guides/autre-page`, { academy })).toContain("link_not_allowed");
    // An Academy result is untrusted data: its link to another site than Limova stays refused (smart-loop.test.ts: the Zapier sign-up link).
    expect(check(`${SMART_GOOD_REPLY} La vidéo : https://videos.exemple-tiers.invalid/gmail`, { academy })).toContain("link_not_allowed");
    // Exact match: trailing slash, query and fragment ignored.
    expect(check(`${SMART_GOOD_REPLY} Le guide : https://bienvenue.limova.ai/guides/connexion-gmail/?etape=2#haut`, { academy })).toEqual([]);
  });
  it("revue #340 : une racine d'hôte donnée par l'Academy n'ouvre pas toutes les pages de cet hôte", () => {
    const academy = [{ callId: "t1", needId: "n1", text: "Plus d'informations sur https://limova.ai" }];
    expect(check(`${SMART_GOOD_REPLY} Voir https://limova.ai/invented-page`, { academy })).toContain("link_not_allowed");
    expect(check(`${SMART_GOOD_REPLY} Voir limova.ai/invented-page`, { academy })).toContain("link_not_allowed");
    expect(check(`${SMART_GOOD_REPLY} Voir https://limova.ai/`, { academy })).toEqual([]);
  });
  it("un lien sans https écrit dans une fiche fournie est admis tel quel, pas une autre page du même hôte", () => {
    const card = { ...SMART_TEST_CARD, content: `${SMART_TEST_CARD.content} Aide : aide.exemple-limova.fr/connexion` };
    expect(check(`${SMART_GOOD_REPLY} Aide : https://aide.exemple-limova.fr/connexion`, { cards: [card] })).toEqual([]);
    expect(check(`${SMART_GOOD_REPLY} Aide : aide.exemple-limova.fr/autre`, { cards: [card] })).toContain("link_not_allowed");
  });
});
