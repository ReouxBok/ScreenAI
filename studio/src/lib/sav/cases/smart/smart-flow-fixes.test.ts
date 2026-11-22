import { describe, expect, it } from "vitest";
import { savBenchAsksPassword, savBenchChecks, savBenchOutcomeMatches, savBenchPatternHits } from "../../bench/bench-checks";
import { savBenchJudgePrompt } from "../../bench/bench-judge";
import { savBenchNormalize, type SavBenchConversation, type SavBenchExpect } from "../../bench/bench-types";
import { runSmartTurn, SAV_SMART_MAX_MODEL_CALLS, type SmartTurnInput } from "./smart-agent";
import { SMART_BENCH_REAL_GRID } from "./smart-bench-real-judge";
import { smartOtherPlatformInvite, smartOtherPlatformSentences, smartServerChecks, type SmartSource } from "./smart-checks";
import { smartSendProblem } from "./smart-send-fence";
import { smartSupportProvenance } from "../case-types";
import { smartDecisionSchema, smartReadingSchema } from "./smart-contract";
import { smartFallbackNote } from "./smart-handoff-note";
import { smartEmptyMemory, type SmartCaseMemory } from "./smart-memory";
import { smartCorrectionPrompt, smartDecidePrompt, smartVerifyPrompt } from "./smart-prompt";
import { SMART_CONFORME, SMART_GOOD_REPLY, SMART_TEST_CARD, smartGoodDecision, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * Bench 22/11 (production bench on fictional mails, two days before the live start): the fixes of buckets 1 (checks misfiring), 2 (flow) and 3 (bench
 * measurement). Every scenario runs on a scripted model double; fictional mails, cards and tools only (public repository).
 */
const MAIL: SmartTurnInput = { subject: "Connexion", body: "Bonjour, je n'arrive pas à me connecter.", thread: [] };
const run = (script: SmartScript, input: SmartTurnInput = MAIL, knowledge = smartStaticKnowledge()) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(input, { model: scripted.model, knowledge, maxInputBytes: 100_000, today: "2026-11-22", recordOwn: true })
    .then(result => ({ result, calls: scripted.calls, kinds: scripted.calls.map(call => call.kind) }));
};
const card = (cardId: string, content: string, needIds = ["n1"]): SmartSource => ({ cardId, version: "v1", title: `Fiche ${cardId}`, content, steps: [], needIds, validUntil: null });
const factOf = (source: SmartSource, excerpt: string) => ({ sentence: "", needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: source.cardId, version: source.version, excerpt });
const checks = (reply: string, customer: string, sources: SmartSource[], facts: unknown[]) => smartServerChecks({
  decision: smartDecisionSchema.parse(smartGoodDecision({ reply, facts })), reading: smartReadingSchema.parse(smartReading()), customerText: customer, sources,
}).codes;

describe("a. other_platform_recommended : seulement un concurrent de Limova", () => {
  const OVH = card("mail-imap-parametres", "Pour une boîte OVH, le serveur IMAP est imap.ovh.net, port 993 avec SSL.");
  const CALENDLY = card("integrations-calendly", "Pour connecter Calendly, rendez-vous sur Calendly, copiez votre lien de réservation puis collez-le dans Paramètres > Intégrations > Calendly.");

  it("l'hébergeur mail du client (OVH, fiche citée) et une intégration (Calendly, fiche citée) passent", () => {
    const ovh = "Bonjour,\n\nDans votre espace OVH, utilisez le serveur imap.ovh.net, port 993 avec SSL.\n\nBelle journée.";
    expect(checks(ovh, "Mes mails chez OVH ne remontent plus dans Limova.", [OVH], [factOf(OVH, "le serveur IMAP est imap.ovh.net")])).toEqual([]);
    const calendly = "Bonjour,\n\nRendez-vous sur Calendly, copiez votre lien de réservation puis collez-le dans Paramètres > Intégrations > Calendly. Calendly permet ensuite à votre Assistant de proposer vos créneaux.\n\nBelle journée.";
    expect(checks(calendly, "Comment je branche mon agenda ?", [CALENDLY], [factOf(CALENDLY, "copiez votre lien de réservation")])).toEqual([]);
    // Without any card: a mail host or a connected integration is still no redirection.
    expect(smartOtherPlatformSentences("Rendez-vous sur Gmail puis activez l'accès IMAP.", "Ma boîte Gmail ne se connecte pas.")).toEqual([]);
    expect(smartOtherPlatformSentences("Utilisez plutôt le serveur imap.ovh.net.", "Ma boîte est chez OVH.")).toEqual([]);
  });

  it("la redirection vers un concurrent reste refusée, même nommé par le client, même avec une fiche citée sur un autre sujet", () => {
    const customer = "Un collègue me dit que ChatGPT fait pareil, et Waalaxy pour LinkedIn.";
    for (const sentence of [
      "Je vous recommande plutôt ChatGPT pour cela.",
      "Pour LinkedIn, essayez Waalaxy.",
      "ChatGPT est plus simple pour démarrer.",
      "Inscrivez-vous sur Vapi pour vos appels.",
      "Vous pourriez passer par un autre outil pour ce besoin.",
      "Utilisez Calendly à la place de Limova.",
    ]) expect(checks(`${SMART_GOOD_REPLY} ${sentence}`, customer, [SMART_TEST_CARD, CALENDLY], [factOf(CALENDLY, "copiez votre lien de réservation")]), sentence).toContain("other_platform_recommended");
  });
});

describe("PR #339 revue 1 : la barrière d'envoi suit la même règle (concurrent seulement)", () => {
  const admitted = (body: string) => smartSendProblem({ admission: { qualification: { requests: [{ provenance: smartSupportProvenance("2026-11-22T08:00:00Z") }] } }, body, purpose: "answer" });
  it("Calendly recommandé ou connecté dans Intégrations passe la barrière d'envoi", () => {
    for (const body of ["Je vous recommande d'utiliser Calendly pour vos rendez-vous.", "Connectez Calendly dans Intégrations, puis copiez votre lien.", "Rendez-vous sur Calendly et copiez votre lien de réservation."])
      expect(smartOtherPlatformInvite(body), body).toBe(false);
  });
  it("ChatGPT à la place de Limova, un concurrent recommandé, ou « à la place de Limova » sans nom : bloqués à l'envoi", () => {
    for (const body of ["Utilisez ChatGPT à la place de Limova.", "Je vous recommande d'utiliser ChatGPT.", "Prenez Calendly à la place de Limova.", "À la place de Limova, passez par un autre outil."])
      expect(smartOtherPlatformInvite(body), body).toBe(true);
    expect(smartOtherPlatformInvite("Limova ne propose pas Pipedrive aujourd'hui : dites-nous ce que vous voulez faire.")).toBe(false);
  });
  it("au niveau de smartSendProblem (cas admis par l'entrée smart) : Calendly part, ChatGPT-à-la-place-de-Limova est annulé", () => {
    expect(admitted("Je vous recommande d'utiliser Calendly.")).toBeNull();
    expect(admitted("Connectez Calendly dans Intégrations, puis copiez votre lien.")).toBeNull();
    expect(admitted("Utilisez ChatGPT à la place de Limova.")).toBe("CANCELLED_REPLY_OTHER_PLATFORM");
  });
});

describe("b. promise_unsourced : une fiche fournie qui porte l'énoncé suffit", () => {
  const PLAN = card("integrations-calendly", "L'intégration Calendly est gratuite et se synchronise en 15 minutes environ.");
  it("une phrase portée par une fiche fournie mais non citée par un fait, ou écrite avec un autre espacement, passe ; une promesse sans fiche reste refusée", () => {
    const reply = `${SMART_GOOD_REPLY} L'intégration Calendly est gratuite et se synchronise en 15 minutes environ.`;
    expect(checks(reply, "Calendly ?", [SMART_TEST_CARD, PLAN], smartGoodDecision().facts)).not.toContain("promise_unsourced");
    const priced = card("prix-option", "L'option coûte 15€ par mois.");
    expect(checks(`${SMART_GOOD_REPLY} L'option coûte 15 € par mois.`, "prix ?", [SMART_TEST_CARD, priced], smartGoodDecision().facts)).not.toContain("promise_unsourced");
    expect(checks(`${SMART_GOOD_REPLY} Ce sera corrigé d'ici demain.`, "bug", [SMART_TEST_CARD, PLAN], smartGoodDecision().facts)).toContain("promise_unsourced");
  });
});

describe("c. decide:output_json_invalid : une nouvelle tentative, dans le budget d'appels", () => {
  it("« ça marche pas » : première réponse illisible, la seconde est lue ; 4 appels, jamais au-delà de 7", async () => {
    const { result, kinds } = await run({ understand: { output: smartReading() }, decide: [{ fail: "output_json_invalid:unbalanced" }, { output: smartGoodDecision() }], verify: { output: SMART_CONFORME } },
      { subject: "", body: "ça marche pas", thread: [] });
    expect(result.outcome).toBe("reply");
    expect(result.reasons).toEqual(expect.arrayContaining(["decide:output_json_invalid:unbalanced", "decide:json_retry"]));
    expect(kinds).toEqual(["understand", "decide", "decide", "verify"]);
    expect(kinds.length).toBeLessThanOrEqual(SAV_SMART_MAX_MODEL_CALLS);
  });
  it("une seule nouvelle tentative : deux réponses illisibles → arrêt technique comme avant (failed, rejoué plus tard), pas de réponse", async () => {
    const { result, kinds } = await run({ understand: { output: smartReading() }, decide: { fail: "output_json_invalid:unbalanced" } });
    expect(result.outcome).toBe("failed");
    expect(result.replyWithFooter).toBeNull();
    expect(kinds).toEqual(["understand", "decide", "decide"]);
  });
});

describe("d. un mail de remerciement ou de confirmation finit par une courtoisie, jamais un passage de main", () => {
  const COURTESY = { outcome: "reply", reply: "Bonjour,\n\nMerci pour votre retour, ravi que ce soit réglé.\n\nBelle journée.", teamNote: null, handoffReason: null, coverage: [], facts: [] };
  it("« C'est fait… Merci ! » : aucune recherche, aucun outil, decide avec noNeed, réponse courte relue", async () => {
    const knowledge = smartStaticKnowledge();
    const { result, calls, kinds } = await run({ understand: { output: smartReading({ needs: [] }) }, decide: { output: COURTESY }, verify: { output: SMART_CONFORME } },
      { subject: "Re: invitation", body: "C'est fait, je l'ai invité. Merci ! Bonne journée !", thread: [] }, knowledge);
    expect(result.outcome).toBe("reply");
    expect(result.replyWithFooter).toContain("Merci pour votre retour");
    expect(result.reasons).toContain("understand:no_need");
    expect(knowledge.calls).toBe(0);
    expect(kinds).toEqual(["understand", "decide", "verify"]);
    expect(calls[1]!.payload).toMatchObject({ noNeed: true, tools: [], lastStep: true, mustHandOff: false });
  });
  it("même à la 5e réponse d'un dossier sans progrès, la courtoisie n'est pas forcée en passage de main", async () => {
    const memory: SmartCaseMemory = { ...smartEmptyMemory(4), progress: [true, false, false, false] };
    const { result } = await run({ understand: { output: smartReading({ needs: [] }) }, decide: { output: COURTESY }, verify: { output: SMART_CONFORME } },
      { subject: "Re", body: "Merci beaucoup !", thread: [], memory });
    expect(result.outcome).toBe("reply");
  });
});

describe("e. refus après correction alors que la fiche était bonne : une correction de resserrement", () => {
  const unlisted = { verdict: "non_conforme", problems: [{ code: "unlisted_claim", sentence: "Si le code n'arrive pas, regardez dans le dossier des indésirables." }] };
  it("relecture qui refuse encore sur le fondement (unlisted_claim), une fiche existe : 2e correction (narrow) puis réponse, 7 appels au plus", async () => {
    const narrowed = smartGoodDecision({ reply: "Bonjour,\n\nUtilisez l'adresse e-mail de votre invitation pour vous connecter.\n\nBelle journée." });
    // v18: a passage the server cannot find in the reply (here, not written in it) is not dropped by the server: the model's narrowing correction runs.
    const unlistedElsewhere = { verdict: "non_conforme", problems: [{ code: "unlisted_claim", sentence: "Le service est en panne." }] };
    const { result, calls, kinds } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: unlistedElsewhere },
      correct: [{ output: smartGoodDecision() }, { output: narrowed }], reverify: [{ output: unlistedElsewhere }, { output: SMART_CONFORME }] });
    expect(kinds).toEqual(["understand", "decide", "verify", "correct", "reverify", "correct", "reverify"]);
    expect(result).toMatchObject({ outcome: "reply", corrected: true });
    expect(result.reasons).toContain("correction:narrowed");
    expect(calls[5]!.payload).toMatchObject({ narrow: true, lastStep: true, tools: [] });
    expect(smartCorrectionPrompt()).toContain("narrow à true");
  });
  it("un problème de sécurité (lien non autorisé) après correction : équipe tout de suite, pas de 2e correction", async () => {
    const linked = smartGoodDecision({ reply: `${SMART_GOOD_REPLY} Voir https://exemple.invalid/aide.` });
    const { result, kinds } = await run({ understand: { output: smartReading() }, decide: { output: linked }, verify: { output: SMART_CONFORME },
      correct: { output: linked }, reverify: { output: SMART_CONFORME } });
    expect(result.outcome).toBe("handoff");
    expect(result.reasons).toEqual(expect.arrayContaining(["refused_after_correction", "check:link_not_allowed"]));
    expect(kinds).toEqual(["understand", "decide", "verify", "correct", "reverify"]);
  });
  it("PR #339 revue 2 : un code de relecture inconnu (lu comme unlisted_claim par le contrat) n'ouvre PAS la correction de resserrement", async () => {
    const unknown = { verdict: "non_conforme", problems: [{ code: "tone", sentence: "Belle journée." }] };
    const { result, kinds } = await run({ understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: unknown },
      correct: { output: smartGoodDecision() }, reverify: { output: unknown } });
    expect(kinds).toEqual(["understand", "decide", "verify", "correct", "reverify"]);
    expect(result.outcome).toBe("handoff");
    expect(result.reasons).not.toContain("correction:narrowed");
    // The same refusal with a KNOWN grounding code does open it (the case above, « unlisted_claim »).
  });
  it("le budget d'appels décide : après 2 passes de décision, pas de 2e correction (7 appels au plus)", async () => {
    const tools = { thinking: "", action: "tools", calls: [{ id: "t1", tool: "chercher_fiches", needId: "n1", args: { query: "connexion" } }], decision: null };
    // v18: a passage the server can find is dropped instead (smart-v18.test.ts); here it is not in the reply, so the handoff stays.
    const elsewhere = { verdict: "non_conforme", problems: [{ code: "unlisted_claim", sentence: "Le service est en panne." }] };
    const { result, kinds } = await run({ understand: { output: smartReading() }, decide: [{ output: tools }, { output: smartGoodDecision() }], verify: { output: elsewhere },
      correct: { output: smartGoodDecision() }, reverify: { output: elsewhere } });
    expect(kinds).toEqual(["understand", "decide", "decide", "verify", "correct", "reverify"]);
    expect(result.outcome).toBe("handoff");
    expect(result.reasons).not.toContain("correction:narrowed");
  });
});

describe("f, g, h. consignes du modèle (sans règle de formulation) et note d'équipe sur le besoin actuel", () => {
  it("f/h : la consigne de décision demande UNE question sur une demande vague, et interdit feuille de route, ressource ou contournement sans fiche", () => {
    expect(smartDecidePrompt()).toContain("Demande trop vague pour chercher (« un outil interne ») : UNE question précise, pas l'équipe.");
    expect(smartDecidePrompt()).toContain("Sans fiche, ni disponibilité, ni ressource (tutoriel, vidéo), ni contournement (webhook, API : Limova n'en a pas).");
    expect(smartDecidePrompt()).toContain("Intégration absente des fiches : pas disponible aujourd'hui, demande le besoin.");
    expect(smartVerifyPrompt()).toContain("une disponibilité ou une feuille de route (« en cours d'ajout », « bientôt sur l'Academy »)");
  });
  it("g : la note de secours ne reprend pas les faits OVH d'un sujet précédent pour une question de formation ; elle garde ceux du même sujet", () => {
    const memory: SmartCaseMemory = { ...smartEmptyMemory(1), needs: [{ id: "n1", ask: "configurer la boîte mail OVH en IMAP", status: "answered" }],
      facts: [{ needId: "n1", text: "Le serveur IMAP OVH est imap.ovh.net", from: "fiche", ref: "fiche mail-imap-parametres v1", turn: 1 }],
      trials: [{ id: "e1", needId: "n1", what: "ressaisir le serveur imap.ovh.net", cardId: null, turn: 1, result: "failed" }] };
    const training = smartReadingSchema.parse(smartReading({ needs: [{ id: "n1", ask: "suivre une formation sur les Assistants", alreadyDone: [], theme: "formation", search: "formation webinaire" }] }));
    const note = smartFallbackNote({ reason: "unsure", reading: training, memory });
    expect(JSON.stringify(note)).not.toMatch(/ovh/i);
    const sameTopic = smartReadingSchema.parse(smartReading({ needs: [{ id: "n1", ask: "la boîte OVH ne remonte toujours pas", alreadyDone: [], theme: "mail", search: "imap ovh" }] }));
    expect(smartFallbackNote({ reason: "unsure", reading: sameTopic, memory }).verifie.map(row => row.fait)).toEqual(["Le serveur IMAP OVH est imap.ovh.net"]);
  });
});

describe("i, j, k. mesures du banc", () => {
  const ASKED = "(envoy|transmet|communiqu|donne|indiqu|partag)\\w*.{0,40}(votre|vos|ton|tes).{0,20}(mot de passe|mdp|identifiants)";
  const ASKED_1 = "(mot de passe|mdp|identifiants?).{0,60}(envoy|transmet|communiqu|donne|indiqu|partag)";
  it("i : négation, citation du client et « ressaisie » ne comptent pas comme une demande de mot de passe ; une vraie demande, si", () => {
    for (const reply of [
      "Indiquez-nous si l'erreur revient après la ressaisie de votre mot de passe dans Limova.",
      "Vous m'indiquez que la connexion échoue malgré un mot de passe valide.",
      "Ne nous transmettez jamais votre code ni votre mot de passe.",
    ]) {
      expect(savBenchAsksPassword(reply), reply).toBeNull();
      for (const source of [ASKED, ASKED_1]) expect(savBenchPatternHits(source, savBenchNormalize(reply)), `${source} / ${reply}`).toBe(false);
    }
    for (const reply of ["Pouvez-vous nous envoyer votre mot de passe ?", "Merci de nous communiquer le code reçu par SMS.", "Transmettez-nous vos identifiants pour vérifier."]) {
      expect(savBenchAsksPassword(reply), reply).not.toBeNull();
    }
    expect(savBenchPatternHits(ASKED, savBenchNormalize("Pouvez-vous nous envoyer votre mot de passe ?"))).toBe(true);
    expect(savBenchPatternHits(ASKED_1, savBenchNormalize("Votre mot de passe, pouvez-vous nous l'envoyer ?"))).toBe(true);
    // A pattern that is not about asking for a password keeps reading the whole reply.
    expect(savBenchPatternHits("rembours", savBenchNormalize("Ne parlez pas de remboursement."))).toBe(true);
  });
  it("j : equipe_sensible contre un passer_la_main attendu est un passage de main (pas l'inverse)", () => {
    expect(savBenchOutcomeMatches(["passer_la_main"], "equipe_sensible")).toBe(true);
    expect(savBenchOutcomeMatches(["equipe_sensible"], "passer_la_main")).toBe(false);
    expect(savBenchOutcomeMatches(["repondre"], "equipe_sensible")).toBe(false);
    const conversation = { id: "x", family: "f", subject: "s", turns: [], allowedDomains: [] } as unknown as SavBenchConversation;
    const expect_ = { outcome: "passer_la_main", keyFacts: [], forbidden: [], mustNotMatch: [] } as unknown as SavBenchExpect;
    const hits = savBenchChecks({ conversation, expect: expect_, turn: { outcome: "equipe_sensible", reply: null, citations: [], codes: [] }, customerText: "", previousReplies: [], cards: [], expiredCardIds: [] });
    expect(hits.map(hit => hit.code)).not.toContain("outcome_mismatch");
  });
  it("k : les deux juges savent que l'Academy de Limova est réelle et que nommer une autre application est permis hors concurrent", () => {
    const { instruction } = savBenchJudgePrompt({ conversationId: "x", turn: 1, messages: [], agent: { outcome: "repondre", reply: "ok", citations: [], codes: [] },
      expect: { outcomes: ["repondre"], keyFacts: [], forbidden: [] }, cards: [], previousReplies: [], now: "2026-11-22T08:00:00Z" });
    expect(instruction).toContain("La Limova Academy est une vraie surface de Limova");
    expect(instruction).toContain("nommer une autre application (outil connecté, intégration, CRM, hébergeur mail) est permis");
    expect(instruction).toContain("equipe_sensible vaut passer_la_main");
    expect(SMART_BENCH_REAL_GRID.grounded).toContain("La Limova Academy est une vraie surface de Limova");
    expect(SMART_BENCH_REAL_GRID.decision).toContain("equipe_sensible vaut passer_la_main");
  });
});
